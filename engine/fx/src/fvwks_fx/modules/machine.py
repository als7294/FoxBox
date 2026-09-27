"""MACHINE: channel vocoder (numpy STFT filterbank) or LPC talkbox, ring modulator, Hilbert frequency shifter."""

from __future__ import annotations

import threading
from collections import OrderedDict

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from scipy import fft as sfft
from scipy import signal

from ..dsp import EPS, active_rms, as2d, istft, one_pole_lowpass, saw, square, stft, to_mono
from ..music import Key, parse_key, root_hz_octave

VOC_NFFT = 1024
VOC_HOP = 256
TB_FRAME_S = 0.020  # talkbox LPC frame (hop = half), crossfaded
TB_PREEMPH = 0.97
SUPERSAW = ((-0.22, 0.7), (-0.126, 0.7), (-0.039, 0.8), (0.0, 1.0), (0.04, 0.8), (0.124, 0.7), (0.215, 0.7))  # (st, amp)


def band_filterbank(n_bands: int, n_fft: int, sr: int, f_lo: float = 80.0, f_hi: float = 12000.0) -> np.ndarray:
    """Triangular log-spaced bands forming a partition of unity over the bins. -> [B, K]."""
    k = n_fft // 2 + 1
    f = np.arange(k) * sr / n_fft
    f_hi = min(f_hi, sr * 0.45)
    centers = np.geomspace(f_lo, f_hi, n_bands)
    lf = np.log(np.maximum(f, 1.0))
    lc = np.log(centers)
    w = np.zeros((n_bands, k))
    for b in range(n_bands):
        if b > 0:
            rise = (lf - lc[b - 1]) / (lc[b] - lc[b - 1])
            m = (lf >= lc[b - 1]) & (lf <= lc[b])
            w[b, m] = rise[m]
        else:
            w[b, (f >= f_lo * 0.5) & (lf <= lc[0])] = 1.0
        if b < n_bands - 1:
            fall = (lc[b + 1] - lf) / (lc[b + 1] - lc[b])
            m = (lf > lc[b]) & (lf < lc[b + 1])
            w[b, m] = fall[m]
        else:
            w[b, lf > lc[-1]] = 1.0
    return w


CHORDS = {
    "root": (0,),
    "fifth": (0, 7),
    "minor": (0, 3, 7),
    "major": (0, 4, 7),
    "octaves": (-12, 0, 12),
}


def chord_notes(chord: str | bool | None, key: Key) -> tuple[int, ...]:
    """Semitone offsets from the key root for a rack chord option ('key' = the key's own triad)."""
    if chord is True or chord == "key":
        return key.triad()
    return CHORDS.get(str(chord or "root"), (0,))


_CARRIERS: OrderedDict[tuple, np.ndarray] = OrderedDict()
_CARRIERS_LOCK = threading.Lock()
_CARRIERS_MAX = 6


def make_carrier(n: int, sr: int, kind: str = "saw", key: Key | str | None = "Am", octave: int = 2,
                 chord: str | bool | None = "root", noise: float = 0.08, seed: int = 0) -> np.ndarray:
    """Carrier on the key root (or a chord on it): saw / square / supersaw / noise, plus a little noise for
    consonants. A supersaw is 7 detuned saws per note. Cached (read-only): a tweak re-renders the same carrier."""
    k = key if isinstance(key, Key) else parse_key(key)
    ck = (int(n), int(sr), str(kind), k, int(octave), str(chord), float(noise), int(seed))
    with _CARRIERS_LOCK:
        hit = _CARRIERS.get(ck)
        if hit is not None:
            _CARRIERS.move_to_end(ck)
            return hit
    c = _make_carrier(int(n), int(sr), str(kind), k, int(octave), chord, float(noise), int(seed))
    c.setflags(write=False)
    with _CARRIERS_LOCK:
        _CARRIERS[ck] = c
        while len(_CARRIERS) > _CARRIERS_MAX:
            _CARRIERS.popitem(last=False)
    return c


def _make_carrier(n: int, sr: int, kind: str, k: Key, octave: int, chord: str | bool | None, noise: float,
                  seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    if kind == "noise":
        return rng.standard_normal(n).astype(np.float32)
    root = root_hz_octave(k, int(octave))
    osc = square if kind == "square" else saw
    voices = SUPERSAW if kind == "supersaw" else ((0.0, 1.0),)
    notes = chord_notes(chord, k)
    c = np.zeros(n, np.float64)
    for i, st in enumerate(notes):
        # slight detune + random phase so stacked notes do not phase-lock into one buzz
        f = root * 2.0 ** (st / 12.0) * (1.0 + 0.0015 * i)
        for det, amp in voices:
            c += amp * osc(f * 2.0 ** (det / 12.0), n, sr, phase0=float(rng.random()))
    c /= np.sqrt(len(notes) * sum(amp * amp for _, amp in voices))
    if noise > 0:
        c += noise * rng.standard_normal(n)
    return c.astype(np.float32)


def vocoder(
    x: np.ndarray,
    sr: int,
    *,
    bands: int = 32,
    carrier: str = "saw",
    key: Key | str | None = "Am",
    octave: int = 2,
    chord: str | bool | None = "root",
    mix: float = 1.0,
    f_lo: float = 80.0,
    f_hi: float = 12000.0,
    smooth_ms: float = 8.0,
    carrier_noise: float = 0.08,
    seed: int = 0,
) -> np.ndarray:
    """Channel vocoder: the voice's band envelopes imposed on a whitened carrier. ``[ch, n]`` in/out."""
    a = as2d(x)
    if mix <= 0:
        return a
    mod = to_mono(a)[0]
    n = mod.size
    nb = int(np.clip(bands, 4, 64))
    c = make_carrier(n, sr, carrier, key, octave, chord, carrier_noise, seed)
    m_spec = stft(mod, VOC_NFFT, VOC_HOP)
    c_spec = stft(c, VOC_NFFT, VOC_HOP)
    w = band_filterbank(nb, VOC_NFFT, sr, f_lo, f_hi)
    em = (np.abs(m_spec) ** 2) @ w.T
    ec = (np.abs(c_spec) ** 2) @ w.T
    g = np.sqrt(em / (ec + EPS))
    if smooth_ms > 0:
        frame_rate = sr / VOC_HOP
        g = one_pole_lowpass(g.T, smooth_ms / 1000.0, frame_rate).T
    gains = g @ w
    wet = istft(c_spec * gains, n, VOC_NFFT, VOC_HOP)
    ref, cur = active_rms(mod[None, :], sr), active_rms(wet[None, :], sr)
    if cur > EPS:
        wet *= ref / cur
    m = float(np.clip(mix, 0.0, 1.0))
    return ((1.0 - m) * a + m * wet[None, :].astype(np.float32)).astype(np.float32)


def lpc_frames(frames: np.ndarray, order: int, sr: int, lag_hz: float = 60.0,
               floor: float = 1e-6) -> tuple[np.ndarray, np.ndarray]:
    """Autocorrelation-method LPC of windowed frames ``[F, N]``, Levinson-Durbin batched across frames.
    A Gaussian lag window (``lag_hz`` bandwidth) and a white-noise floor (``floor`` of the frame power, -60 dB)
    keep every filter well conditioned and its formants from turning into whistles.
    -> (a ``[F, order+1]`` with a[:, 0] = 1, prediction error ``[F]``)."""
    nfft = sfft.next_fast_len(2 * frames.shape[1], real=True)
    spec = np.fft.rfft(frames, nfft, axis=1)
    r = np.fft.irfft(spec.real**2 + spec.imag**2, nfft, axis=1)[:, : order + 1]
    r = r * np.exp(-0.5 * (2.0 * np.pi * lag_hz / sr * np.arange(order + 1)) ** 2)
    r[:, 0] *= 1.0 + floor
    a = np.zeros((frames.shape[0], order + 1))
    a[:, 0] = 1.0
    err = r[:, 0].copy()
    for i in range(1, order + 1):
        acc = r[:, i] + np.sum(a[:, 1:i] * r[:, i - 1 : 0 : -1], axis=1)
        k = np.clip(-acc / np.maximum(err, 1e-30), -1.0 + 1e-9, 1.0 - 1e-9)  # |k| < 1 already; rounding guard
        a[:, 1:i] = a[:, 1:i] + k[:, None] * a[:, i - 1 : 0 : -1]
        a[:, i] = k
        err = err * (1.0 - k * k)
    return a, err


def talkbox(
    x: np.ndarray,
    sr: int,
    *,
    carrier: str = "saw",
    key: Key | str | None = "Am",
    octave: int = 2,
    chord: str | bool | None = "root",
    mix: float = 1.0,
    order: int | None = None,
    carrier_noise: float = 0.05,
    seed: int = 0,
) -> np.ndarray:
    """LPC talkbox: the voice's vocal tract played by an in-key carrier chord. ``[ch, n]`` in/out.

    Every 10 ms, an all-pole LPC filter (order ~sr/1500, 20 ms Hann frames) of the pre-emphasized voice filters
    the raw carrier, whose own -6 dB/oct tilt stands in for the glottis. Each frame is filtered with a pre-roll
    so its formants ring in, matched to the voice frame's energy and crossfaded with its neighbours. Unvoiced
    frames (s, f, t) swap the carrier for noise so consonants stay readable."""
    a = as2d(x)
    if mix <= 0:
        return a
    v = to_mono(a)[0].astype(np.float64)
    n = v.size
    p = int(order or max(12, round(sr / 1500)))
    hop = max(16, int(round(TB_FRAME_S * sr / 2)))
    size = 2 * hop
    n_frames = int(np.ceil(n / hop)) + 1
    vp = np.zeros((n_frames + 1) * hop)
    vp[hop : hop + n] = v  # frame f covers vp[f*hop : f*hop + size]
    win = signal.windows.hann(size, sym=False)  # sums to 1 at 50 % overlap
    raw = sliding_window_view(vp, size)[::hop][:n_frames] * win
    emph = sliding_window_view(signal.lfilter([1.0, -TB_PREEMPH], [1.0], vp), size)[::hop][:n_frames] * win
    lpc, _ = lpc_frames(emph, p, sr)
    energy = np.sum(raw * raw, axis=1)
    rho = np.sum(raw[:, 1:] * raw[:, :-1], axis=1) / np.maximum(energy, 1e-30)  # ~0.9 voiced, <0.3 hiss
    unvoiced = np.clip((0.55 - rho) / 0.45, 0.0, 1.0)
    live = energy > max(float(energy.max()), 1e-20) * 1e-7  # -70 dB of the loudest frame

    pre = hop  # filter pre-roll; carrier index = vp index + pre
    exc = make_carrier(vp.size + pre, sr, carrier, key, octave, chord, carrier_noise, seed).astype(np.float64)
    exc /= max(float(np.sqrt(np.mean(exc * exc))), EPS)
    hiss = np.random.default_rng(seed + 1).standard_normal(vp.size + pre)
    out = np.zeros(vp.size)
    for f in np.flatnonzero(live):
        s = f * hop
        u = unvoiced[f]
        e = exc[s : s + pre + size] if u <= 0 else (1.0 - u) * exc[s : s + pre + size] + u * hiss[s : s + pre + size]
        y = signal.lfilter([1.0], lpc[f], e)[pre:]
        ey = float(np.sum((y * win) ** 2))
        if ey > 1e-30:
            out[s : s + size] += win * y * np.sqrt(energy[f] / ey)
    wet = out[hop : hop + n]
    ref, cur = active_rms(v[None, :], sr), active_rms(wet[None, :], sr)
    if cur > EPS:
        wet *= ref / cur
    m = float(np.clip(mix, 0.0, 1.0))
    return ((1.0 - m) * a + m * wet[None, :].astype(np.float32)).astype(np.float32)


def ring_mod(x: np.ndarray, sr: int, *, freq_hz: float = 60.0, mix: float = 0.3) -> np.ndarray:
    """Classic ring modulator (sine carrier), level-compensated for the 3 dB loss."""
    a = as2d(x)
    if mix <= 0:
        return a
    t = np.arange(a.shape[1]) / sr
    car = (np.sqrt(2.0) * np.sin(2 * np.pi * float(freq_hz) * t)).astype(np.float32)
    m = float(np.clip(mix, 0.0, 1.0))
    return ((1.0 - m) * a + m * a * car[None, :]).astype(np.float32)


def freq_shift(x: np.ndarray, sr: int, *, shift_hz: float = 100.0, mix: float = 1.0) -> np.ndarray:
    """Single-sideband frequency shifter via the analytic (Hilbert) signal. Inharmonic by design."""
    a = as2d(x)
    if mix <= 0 or shift_hz == 0:
        return a
    n = a.shape[1]
    nf = sfft.next_fast_len(n, real=False)
    spec = sfft.fft(a.astype(np.float64), n=nf, axis=-1)
    h = np.zeros(nf)
    h[0] = 1.0
    if nf % 2 == 0:
        h[nf // 2] = 1.0
        h[1 : nf // 2] = 2.0
    else:
        h[1 : (nf + 1) // 2] = 2.0
    analytic = sfft.ifft(spec * h, axis=-1)[:, :n]
    t = np.arange(n) / sr
    shifted = np.real(analytic * np.exp(2j * np.pi * float(shift_hz) * t)[None, :])
    m = float(np.clip(mix, 0.0, 1.0))
    return ((1.0 - m) * a + m * shifted).astype(np.float32)
