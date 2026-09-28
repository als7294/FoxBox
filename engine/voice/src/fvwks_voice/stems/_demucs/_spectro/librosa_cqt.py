# Vendored from mlx-spectro 0.9.7 (MIT; Copyright (c) 2026 ssmall256). See LICENSE.
"""librosa-compatible constant/variable-Q transform (VQT/CQT), MLX-native.

Reproduces ``librosa.vqt`` (and thus ``librosa.cqt`` == ``vqt(gamma=0)``) without a
librosa runtime dependency. The deterministic filter-bank construction is ported to
numpy and computed once; the per-octave forward (framed rFFT x sparse filter basis,
multirate 2:1 downsampling, trim, length-scaling) runs in MLX.

The only piece librosa does that is not pure DSP math is high-quality resampling
(libsoxr). That is injected via ``resample_fn`` so this module keeps mlx-spectro's
mlx+numpy-only dependency footprint; callers that need exact librosa parity pass a
libsoxr resampler (e.g. ``mlx_audio_io.resample``). A built-in FFT fallback is used
when no resampler is given (lower fidelity for non-power-of-two rate changes).

Validated against librosa 0.11 for sr=16000, fmin=midi_to_hz(21), n_bins=352,
bins_per_octave=48, hop=320, gamma=0 (the MT-FiLM frontend).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

import mlx.core as mx
import numpy as np

ResampleFn = Callable[[mx.array, int, int], mx.array]

# Equivalent noise bandwidth of a periodic Hann window (matches librosa.filters.window_bandwidth('hann')).
_HANN_ENBW = 1.50018310546875


# --------------------------------------------------------------------------- #
# Deterministic filter-bank construction (numpy, ported from librosa)          #
# --------------------------------------------------------------------------- #

def _interval_frequencies(n_bins: int, fmin: float, bins_per_octave: int) -> np.ndarray:
    """Equal-temperament bin frequencies (librosa.interval_frequencies, intervals='equal')."""
    ratios = 2.0 ** (np.arange(0, bins_per_octave, dtype=float) / bins_per_octave)
    n_octaves = int(np.ceil(n_bins / bins_per_octave))
    all_ratios = np.multiply.outer(2.0 ** np.arange(n_octaves), ratios).flatten()[:n_bins]
    return np.sort(all_ratios) * fmin


def _relative_bandwidth(freqs: np.ndarray) -> np.ndarray:
    """librosa.filters._relative_bandwidth."""
    bpo = np.empty_like(freqs)
    logf = np.log2(freqs)
    bpo[0] = 1 / (logf[1] - logf[0])
    bpo[-1] = 1 / (logf[-1] - logf[-2])
    bpo[1:-1] = 2 / (logf[2:] - logf[:-2])
    return (2.0 ** (2 / bpo) - 1) / (2.0 ** (2 / bpo) + 1)


def _wavelet_lengths(freqs, sr, filter_scale, gamma, alpha):
    """librosa.filters.wavelet_lengths (gamma is a scalar; gamma=0 for CQT)."""
    Q = float(filter_scale) / alpha
    gamma_ = gamma
    f_cutoff = np.max(freqs * (1 + 0.5 * _HANN_ENBW / Q) + 0.5 * gamma_)
    lengths = Q * sr / (freqs + gamma_ / alpha)
    return lengths, f_cutoff


def _hann_periodic(n: int) -> np.ndarray:
    """Periodic Hann (== scipy.signal.get_window('hann', n, fftbins=True))."""
    if n == 1:
        return np.ones(1)
    k = np.arange(n)
    return 0.5 - 0.5 * np.cos(2.0 * np.pi * k / n)


def _wavelet(freqs, sr, filter_scale, gamma, alpha, norm=1):
    """librosa.filters.wavelet -> (basis [n, max_len] complex64, lengths)."""
    lengths, _ = _wavelet_lengths(freqs, sr, filter_scale, gamma, alpha)
    filters = []
    for ilen, freq in zip(lengths, freqs):
        # Match librosa exactly: np.arange(-ilen // 2, ilen // 2) with float floor-division.
        t = np.arange(-ilen // 2, ilen // 2, dtype=float)
        sig = np.exp(1j * t * 2 * np.pi * freq / sr)
        sig = sig * _hann_periodic(len(sig))
        # L1 normalize (librosa.util.normalize, norm=1)
        l1 = np.sum(np.abs(sig))
        if l1 > np.finfo(np.float64).tiny:
            sig = sig / l1
        filters.append(sig)

    max_len = max(lengths)
    max_len = int(2.0 ** (np.ceil(np.log2(max_len))))  # pad_fft=True
    basis = np.zeros((len(filters), max_len), dtype=np.complex64)
    for i, filt in enumerate(filters):
        n = len(filt)
        lpad = (max_len - n) // 2
        basis[i, lpad:lpad + n] = filt
    return basis, lengths


def _sparsify_rows(x: np.ndarray, quantile: float = 0.01) -> np.ndarray:
    """librosa.util.sparsify_rows, returned dense (zeros where discarded)."""
    out = np.zeros_like(x)
    mags = np.abs(x)
    norms = np.sum(mags, axis=1, keepdims=True)
    mag_sort = np.sort(mags, axis=1)
    cumulative = np.cumsum(mag_sort / norms, axis=1)
    threshold_idx = np.argmin(cumulative < quantile, axis=1)
    for i, j in enumerate(threshold_idx):
        idx = np.where(mags[i] >= mag_sort[i, j])
        out[i, idx] = x[i, idx]
    return out


def _vqt_filter_fft(sr, freqs, filter_scale, norm, sparsity, gamma, alpha):
    """librosa.core.constantq.__vqt_filter_fft -> (fft_basis [n, n_fft//2+1], n_fft, lengths)."""
    basis, lengths = _wavelet(freqs, sr, filter_scale, gamma, alpha, norm=norm)
    n_fft = basis.shape[1]
    basis = basis * (lengths[:, np.newaxis] / float(n_fft))
    fft_basis = np.fft.fft(basis, n=n_fft, axis=1)[:, : (n_fft // 2) + 1]
    fft_basis = _sparsify_rows(fft_basis, quantile=sparsity).astype(np.complex64)
    return fft_basis, n_fft, lengths


def _num_two_factors(x: int) -> int:
    if x <= 0:
        return 0
    n = 0
    while x % 2 == 0:
        n += 1
        x //= 2
    return n


@dataclass
class VQTPlan:
    """Precomputed, data-independent VQT filter bank + per-octave schedule."""
    sr: int
    hop_length: int
    n_bins: int
    bins_per_octave: int
    n_octaves: int
    n_filters: int
    fft_bases: list          # per octave: mx.array [n_oct_bins, n_fft//2+1] complex64
    n_ffts: list             # per octave: int
    hops: list               # per octave: int (my_hop)
    downsamples: list        # per octave: bool (downsample signal AFTER this octave)
    lengths: np.ndarray      # [n_bins] full-rate filter lengths (final 1/sqrt scaling)


def _resolve_sample_rate(sr, sample_rate, *, default):
    """Accept either spelling of the sample-rate keyword.

    The CQT/VQT entry points mirror librosa, which spells it `sr`, while every
    transform class in this package spells it `sample_rate`. Callers should not
    have to remember which side of that line a given function sits on.
    """
    if sample_rate is not None and sr is not None and int(sample_rate) != int(sr):
        raise TypeError(
            f"got conflicting sample rates: sr={sr}, sample_rate={sample_rate}"
        )
    if sample_rate is not None:
        return int(sample_rate)
    if sr is not None:
        return int(sr)
    return default


def build_vqt_plan(sr=None, hop_length=320, fmin=None, n_bins=352, bins_per_octave=48,
                   gamma=0.0, filter_scale=1, norm=1, sparsity=0.01, *,
                   sample_rate=None) -> VQTPlan:
    """Build the librosa-compatible VQT plan. fmin defaults to midi_to_hz(21)=27.5.

    `sr` and `sample_rate` are accepted interchangeably.
    """
    sr = _resolve_sample_rate(sr, sample_rate, default=16000)
    if fmin is None:
        fmin = 440.0 * 2.0 ** ((21 - 69) / 12.0)  # midi_to_hz(21)

    n_octaves = int(np.ceil(n_bins / bins_per_octave))
    n_filters = min(bins_per_octave, n_bins)
    freqs = _interval_frequencies(n_bins, fmin, bins_per_octave)
    alpha = _relative_bandwidth(freqs)

    _, filter_cutoff = _wavelet_lengths(freqs, sr, filter_scale, gamma, alpha)
    if filter_cutoff > sr / 2.0:
        raise ValueError(f"filter_cutoff={filter_cutoff} exceeds Nyquist={sr/2}")
    # Early downsampling is assumed off (true for the MT-FiLM config); guard it.
    nyq = sr / 2.0
    dc1 = max(0, int(np.ceil(np.log2(nyq / filter_cutoff)) - 1) - 1)
    dc2 = max(0, _num_two_factors(hop_length) - n_octaves + 1)
    if min(dc1, dc2) != 0:
        raise NotImplementedError(
            f"vqt does not support these parameters: sr={sr}, "
            f"hop_length={hop_length}, n_bins={n_bins}, "
            f"bins_per_octave={bins_per_octave} would need librosa's early "
            "downsampling, which is not implemented here. Use hybrid_cqt for "
            "this configuration, or lower the sample rate."
        )

    fft_bases, n_ffts, hops, downsamples = [], [], [], []
    my_sr, my_hop = float(sr), hop_length
    for i in range(n_octaves):
        sl = slice(-n_filters, None) if i == 0 else slice(-n_filters * (i + 1), -n_filters * i)
        freqs_oct, alpha_oct = freqs[sl], alpha[sl]
        fft_basis, n_fft, _ = _vqt_filter_fft(
            my_sr, freqs_oct, filter_scale, norm, sparsity, gamma, alpha_oct)
        fft_basis = fft_basis * np.sqrt(sr / my_sr)  # downsampling compensation
        fft_bases.append(mx.array(fft_basis))
        n_ffts.append(n_fft)
        hops.append(my_hop)
        ds = my_hop % 2 == 0
        downsamples.append(ds)
        if ds:
            my_hop //= 2
            my_sr /= 2.0

    lengths, _ = _wavelet_lengths(freqs, sr, filter_scale, gamma, alpha)
    return VQTPlan(sr, hop_length, n_bins, bins_per_octave, n_octaves, n_filters,
                   fft_bases, n_ffts, hops, downsamples, lengths)


# --------------------------------------------------------------------------- #
# MLX forward                                                                  #
# --------------------------------------------------------------------------- #

def _fft_resample_half(y: mx.array) -> mx.array:
    """FFT-based 2:1 downsample fallback (librosa scale=True convention)."""
    n = y.shape[-1]
    Y = mx.fft.rfft(y)
    keep = n // 4 + 1
    Yd = Y[..., :keep]
    yd = mx.fft.irfft(Yd, n=n // 2)
    return yd * np.sqrt(0.5)  # energy scale (librosa scale=True)


def _stft_ones(y: mx.array, n_fft: int, hop: int) -> mx.array:
    """librosa.stft(y, n_fft, hop, window='ones', center=True, pad_mode='constant').

    Returns [n_fft//2+1, n_frames] complex.
    """
    pad = n_fft // 2
    yp = mx.pad(y, [(pad, pad)])
    n_frames = 1 + (yp.shape[-1] - n_fft) // hop
    idx = mx.arange(n_fft)[None, :] + hop * mx.arange(n_frames)[:, None]
    frames = yp[idx]                          # [n_frames, n_fft]
    spec = mx.fft.rfft(frames, n=n_fft, axis=-1)  # [n_frames, n_fft//2+1]
    return spec.T                              # [n_fft//2+1, n_frames]


def vqt(y: mx.array, plan: VQTPlan, resample_fn: Optional[ResampleFn] = None) -> mx.array:
    """Compute the librosa-compatible VQT magnitude-or-complex matrix [n_bins, n_frames].

    y: 1-D mlx waveform at plan.sr. resample_fn(signal, orig_sr, target_sr)->signal for
    the per-octave 2:1 downsample; if None, an FFT fallback is used.

    Mono only -- there is no batch dimension. Loop over channels, or use
    :func:`~mlx_spectro.hybrid_cqt`, which takes batched input.
    """
    if y.ndim != 1:
        raise ValueError(
            f"vqt expects a 1-D waveform, got shape {tuple(y.shape)}. It is mono "
            "only: loop over channels, or use hybrid_cqt for batched input."
        )
    my_y = y
    resp = []
    for i in range(plan.n_octaves):
        D = _stft_ones(my_y, plan.n_ffts[i], plan.hops[i])    # [n_fft//2+1, frames]
        resp.append(plan.fft_bases[i] @ D)                    # [n_oct_bins, frames]
        if plan.downsamples[i]:
            if resample_fn is None:
                my_y = _fft_resample_half(my_y)
            else:
                # librosa audio.resample(orig_sr=2, target_sr=1, scale=True) multiplies
                # the unscaled (libsoxr) output by sqrt(orig/target) = sqrt(2).
                cur = my_y.shape[-1]
                my_y = resample_fn(my_y, 2, 1).reshape(-1)[: cur // 2] * np.sqrt(2.0)

    # __trim_stack + 1/sqrt(lengths) scaling
    max_col = min(r.shape[-1] for r in resp)
    out = mx.zeros((plan.n_bins, max_col), dtype=resp[0].dtype)
    end = plan.n_bins
    for r in resp:
        n_oct = r.shape[-2]
        if end < n_oct:
            out[:end, :] = r[-end:, :max_col]
        else:
            out[end - n_oct:end, :] = r[:, :max_col]
        end -= n_oct
    scale = mx.array((1.0 / np.sqrt(plan.lengths)).astype(np.float32))[:, None]
    return out * scale
