"""MASK: WORLD-based pitch / formant / McAdams / breath / growl, plus an stftpitchshift preview path.

Everything operates on a cached WORLD analysis of the source (f0, spectral envelope, aperiodicity),
so re-rendering with new knob values only pays for parameter maths plus one WORLD synthesis.

McAdams: re-implemented from Patino et al., "Speaker anonymisation using the McAdams coefficient"
(Interspeech 2021, arXiv:2011.01130). Per frame we fit an all-pole (LPC) model, move the angle of every
complex pole from phi to phi**alpha (radius unchanged, real poles untouched) and re-impose the modified
all-pole envelope. The paper works at 16 kHz with order 20; we keep that reference rate for the warp so
alpha means the same thing it does in the paper, and apply the result to WORLD's 48 kHz envelope.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from dataclasses import dataclass, field

import numpy as np
import pyworld as pw
from scipy import signal

from ..dsp import EPS, SR, active_rms, as2d, audio_hash, finite, to_mono
from ..music import Key, hz_to_midi, midi_to_hz, parse_key, quantize_to_scale, root_hz_near

FRAME_PERIOD_MS = 5.0
F0_FLOOR = 60.0
F0_CEIL = 700.0
WORLD_DEFAULT_F0 = 500.0  # WORLD's kDefaultF0, used for unvoiced time base
MCADAMS_REF_SR = 16000
MCADAMS_ORDER = 20


# --------------------------------------------------------------------------- analysis + cache


@dataclass(frozen=True)
class WorldAnalysis:
    """Cached WORLD features of one mono source at ``sr``."""

    sr: int
    frame_period_ms: float
    f0: np.ndarray  # [T] Hz, 0 = unvoiced
    sp: np.ndarray  # [T, F] power spectral envelope
    ap: np.ndarray  # [T, F] aperiodicity (0 periodic .. 1 noise)
    n_samples: int
    content_hash: str
    method: str = "harvest"
    rms: float = 0.0
    fft_n: int = 0  # FFT size of the analysis (set when sp/ap are band-sliced)

    @property
    def n_frames(self) -> int:
        return int(self.f0.shape[0])

    @property
    def fft_size(self) -> int:
        return self.fft_n or (self.sp.shape[1] - 1) * 2

    @property
    def voiced(self) -> np.ndarray:
        return self.f0 > 0

    def median_f0(self) -> float:
        v = self.f0[self.f0 > 0]
        return float(np.median(v)) if v.size else 0.0

    @property
    def nbytes(self) -> int:
        return int(self.f0.nbytes + self.sp.nbytes + self.ap.nbytes)


class _LRU:
    def __init__(self, max_bytes: int):
        self.max_bytes = max_bytes
        self._d: OrderedDict[str, WorldAnalysis] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, k: str) -> WorldAnalysis | None:
        with self._lock:
            v = self._d.get(k)
            if v is not None:
                self._d.move_to_end(k)
            return v

    def put(self, k: str, v: WorldAnalysis) -> None:
        with self._lock:
            self._d[k] = v
            self._d.move_to_end(k)
            total = sum(a.nbytes for a in self._d.values())
            while total > self.max_bytes and len(self._d) > 1:
                _, old = self._d.popitem(last=False)
                total -= old.nbytes

    def clear(self) -> None:
        with self._lock:
            self._d.clear()

    def __contains__(self, k: str) -> bool:
        with self._lock:
            return k in self._d


ANALYSIS_CACHE = _LRU(max_bytes=768 * 1024 * 1024)


def analysis_key(x: np.ndarray, sr: int, method: str) -> str:
    return f"{audio_hash(to_mono(x), sr)}:{method}:{FRAME_PERIOD_MS}:{F0_FLOOR}:{F0_CEIL}"


def analyze_world(x: np.ndarray, sr: int = SR, method: str = "harvest", use_cache: bool = True) -> WorldAnalysis:
    """WORLD analysis (f0 + CheapTrick envelope + D4C aperiodicity), cached by audio content.

    ``method``: "harvest" (robust, best for recorded voice) or "dio" (fast, fine for clean TTS).
    """
    mono = to_mono(x)[0].astype(np.float64)
    key = analysis_key(mono, sr, method)
    if use_cache:
        hit = ANALYSIS_CACHE.get(key)
        if hit is not None:
            return hit
    n = mono.size
    if n < int(0.05 * sr):
        mono = np.pad(mono, (0, int(0.05 * sr) - n))
    fft_size = pw.get_cheaptrick_fft_size(sr, 71.0)
    # f0 on a 16 kHz copy: same time axis, ~3x cheaper, pitch information is all below 8 kHz.
    lo_sr = 16000 if sr % 16000 == 0 else sr
    lo = signal.resample_poly(mono, 1, sr // lo_sr) if lo_sr != sr else mono
    lo = np.ascontiguousarray(lo, dtype=np.float64)
    if method == "dio":
        f0, t = pw.dio(lo, lo_sr, f0_floor=F0_FLOOR, f0_ceil=F0_CEIL, frame_period=FRAME_PERIOD_MS)
        f0 = pw.stonemask(lo, f0, t, lo_sr)
    else:
        f0, t = pw.harvest(lo, lo_sr, f0_floor=F0_FLOOR, f0_ceil=F0_CEIL, frame_period=FRAME_PERIOD_MS)
    n_frames = int(len(mono) / sr * 1000.0 / FRAME_PERIOD_MS) + 1
    f0 = _fit_frames(np.ascontiguousarray(f0, dtype=np.float64), n_frames)
    t = np.arange(n_frames, dtype=np.float64) * FRAME_PERIOD_MS / 1000.0
    sp = pw.cheaptrick(mono, f0, t, sr, fft_size=fft_size)
    if sr == 48000:
        # D4C at 24 kHz is ~2.4x cheaper and matches the 48 kHz result below 12 kHz; above that the
        # aperiodicity is noise-dominated anyway, so the top band is held flat.
        half = np.ascontiguousarray(signal.resample_poly(mono, 1, 2))
        ap_lo = pw.d4c(half, f0, t, sr // 2, fft_size=fft_size // 2)
        ap = np.empty_like(sp)
        ap[:, : ap_lo.shape[1]] = ap_lo
        ap[:, ap_lo.shape[1] :] = ap_lo[:, -1:]
    else:
        ap = pw.d4c(mono, f0, t, sr, fft_size=fft_size)
    sp = np.nan_to_num(sp, nan=EPS, posinf=EPS, neginf=EPS)
    sp = np.maximum(sp, 1e-16)
    ap = np.clip(np.nan_to_num(ap, nan=1.0), 0.001, 1.0)
    a = WorldAnalysis(
        sr=sr, frame_period_ms=FRAME_PERIOD_MS, f0=f0, sp=sp, ap=ap, n_samples=n,
        content_hash=key, method=method, rms=active_rms(mono[None, :], sr),
    )
    if use_cache:
        ANALYSIS_CACHE.put(key, a)
    return a


def cached_analysis(x: np.ndarray, sr: int, method: str = "harvest") -> WorldAnalysis | None:
    return ANALYSIS_CACHE.get(analysis_key(to_mono(x)[0].astype(np.float64), sr, method))


def _fit_frames(a: np.ndarray, n: int) -> np.ndarray:
    if a.shape[0] == n:
        return a
    if a.shape[0] > n:
        return np.ascontiguousarray(a[:n])
    pad = [(0, n - a.shape[0])] + [(0, 0)] * (a.ndim - 1)
    return np.ascontiguousarray(np.pad(a, pad, mode="edge" if a.ndim > 1 else "constant"))


# --------------------------------------------------------------------------- feature transforms


@dataclass
class WorldFeatures:
    """A (possibly modified) WORLD parameter set ready for synthesis."""

    f0: np.ndarray
    sp: np.ndarray
    ap: np.ndarray
    sr: int
    frame_period_ms: float
    n_samples: int
    meta: dict = field(default_factory=dict)
    fft_n: int = 0

    @property
    def fft_size(self) -> int:
        return self.fft_n or (self.sp.shape[1] - 1) * 2

    def copy(self) -> "WorldFeatures":
        return WorldFeatures(self.f0.copy(), self.sp.copy(), self.ap.copy(), self.sr, self.frame_period_ms,
                             self.n_samples, dict(self.meta), self.fft_n)


def bins_for(fft_n: int, analysis_sr: int, out_sr: int, warp_min: float = 1.0) -> int:
    """Envelope bins needed to synthesize at ``out_sr`` (plus room for a downward warp by ``warp_min``)."""
    need = int(fft_n * out_sr / analysis_sr) // 2 + 1
    if warp_min < 1.0:
        need = int(np.ceil(need / warp_min)) + 2
    return min(need, fft_n // 2 + 1)


def band_slice(a: "WorldAnalysis", bins: int) -> "WorldAnalysis":
    if bins >= a.sp.shape[1]:
        return a
    return WorldAnalysis(a.sr, a.frame_period_ms, a.f0, a.sp[:, :bins], a.ap[:, :bins], a.n_samples, a.content_hash,
                         a.method, a.rms, a.fft_size)


def features_of(a: WorldAnalysis) -> WorldFeatures:
    return WorldFeatures(a.f0.copy(), a.sp, a.ap, a.sr, a.frame_period_ms, a.n_samples)


def shift_f0(f0: np.ndarray, semitones: float) -> np.ndarray:
    out = f0.copy()
    v = out > 0
    out[v] *= 2.0 ** (semitones / 12.0)
    return out


def _smooth_voiced(values: np.ndarray, voiced: np.ndarray, frames: int) -> np.ndarray:
    """Moving-average inside voiced runs only (never smears across unvoiced gaps)."""
    if frames <= 1 or not voiced.any():
        return values
    out = values.copy()
    edges = np.flatnonzero(np.diff(np.concatenate([[0], voiced.astype(np.int8), [0]])))
    k = np.ones(frames) / frames
    for s, e in zip(edges[::2], edges[1::2]):
        seg = values[s:e]
        if seg.size >= frames:
            pad = frames // 2
            padded = np.pad(seg, (pad, frames - 1 - pad), mode="edge")
            out[s:e] = np.convolve(padded, k, mode="valid")
    return out


def pitch_contour(
    f0: np.ndarray,
    pitch_st: float = 0.0,
    mode: str = "natural",
    amount: float = 0.0,
    key: Key | str | None = None,
    target_hz: float | None = None,
) -> np.ndarray:
    """Apply the MASK pitch stage to an f0 contour. ``amount`` (the FLAT knob) flattens intonation in
    every mode; the mode picks what it flattens onto:

    - natural: shift by ``pitch_st``; FLAT pulls toward the voice's own (shifted) median pitch.
    - monotone: FLAT pulls toward the key root nearest the shifted median (1.0 = dead flat on the root).
    - scale: every frame snaps to the nearest note of the key's scale; FLAT then pulls toward the root.
    """
    k = key if isinstance(key, Key) else parse_key(key)
    out = shift_f0(f0, pitch_st)
    v = out > 0
    if not v.any():
        return out
    a = float(np.clip(amount, 0.0, 1.0))
    median = float(np.exp(np.median(np.log(out[v]))))
    if mode in ("scale", "scale_lock", "scalelock"):
        midi = np.zeros_like(out)
        midi[v] = hz_to_midi(out[v])
        smooth = _smooth_voiced(midi, v, 5)
        out[v] = midi_to_hz(quantize_to_scale(smooth[v], k))
    if a <= 0:
        return out
    if mode == "natural":
        tgt = target_hz or median
    else:
        tgt = target_hz or root_hz_near(k, median)
    lf = np.log2(out[v])
    out[v] = 2.0 ** ((1.0 - a) * lf + a * np.log2(tgt))
    return out


def warp_envelope(sp: np.ndarray, ratio: float) -> np.ndarray:
    """Formant warp: stretch the envelope along frequency. ``sp_out(f) = sp(f / ratio)``."""
    if abs(ratio - 1.0) < 1e-6:
        return sp
    n_bins = sp.shape[1]
    src = np.clip(np.arange(n_bins) / ratio, 0, n_bins - 1)
    i0 = np.floor(src).astype(np.int64)
    i1 = np.minimum(i0 + 1, n_bins - 1)
    w = (src - i0)[None, :]
    lsp = np.log(np.maximum(sp, 1e-16))
    return np.exp(lsp[:, i0] * (1.0 - w) + lsp[:, i1] * w)


def _levinson(r: np.ndarray, order: int) -> tuple[np.ndarray, np.ndarray]:
    """Batched Levinson-Durbin. ``r``: [T, order+1] autocorrelation -> (a [T, order+1], err [T])."""
    n = r.shape[0]
    a = np.zeros((n, order + 1))
    a[:, 0] = 1.0
    err = r[:, 0].copy()
    for i in range(1, order + 1):
        acc = r[:, i] + np.sum(a[:, 1:i] * r[:, i - 1 : 0 : -1], axis=1)
        k = -acc / np.maximum(err, 1e-30)
        k = np.clip(k, -0.9999, 0.9999)
        prev = a[:, 1:i].copy()
        a[:, 1:i] = prev + k[:, None] * prev[:, ::-1]
        a[:, i] = k
        err = err * (1.0 - k * k)
    return a, err


def _poly_from_roots(roots: np.ndarray) -> np.ndarray:
    """Batched np.poly: roots [T, p] -> monic coefficients [T, p+1]."""
    n, p = roots.shape
    c = np.zeros((n, p + 1), dtype=np.complex128)
    c[:, 0] = 1.0
    for k in range(p):
        c[:, 1 : k + 2] = c[:, 1 : k + 2] - roots[:, k : k + 1] * c[:, 0 : k + 1]
    return c.real


def mcadams_envelope(sp: np.ndarray, sr: int, alpha: float, order: int = MCADAMS_ORDER,
                     ref_sr: int = MCADAMS_REF_SR, fft_size: int | None = None) -> np.ndarray:
    """McAdams pole-angle warp (phi -> phi**alpha) applied to a WORLD power envelope.

    ``fft_size`` is the analysis FFT size when ``sp`` holds only the low bins."""
    if abs(alpha - 1.0) < 1e-4:
        return sp
    n_frames, n_bins = sp.shape
    fft_size = fft_size or (n_bins - 1) * 2
    f_bins = np.arange(n_bins) * sr / fft_size
    nyq_ref = ref_sr / 2.0
    # 1) resample the envelope onto a ref_sr FFT grid (0..nyq_ref) and get the autocorrelation
    n_ref = 512
    f_ref = np.arange(n_ref // 2 + 1) * ref_sr / n_ref
    pos = np.minimum(f_ref / (sr / fft_size), n_bins - 1.0)
    i0 = np.minimum(np.floor(pos).astype(np.int64), n_bins - 2)
    w = pos - i0
    p_ref = sp[:, i0] * (1.0 - w) + sp[:, i0 + 1] * w
    r = np.fft.irfft(p_ref, n=n_ref, axis=1)[:, : order + 1]
    r[:, 0] *= 1.0 + 1e-6  # white-noise correction for stability
    lag = np.exp(-0.5 * (2 * np.pi * 40.0 * np.arange(order + 1) / ref_sr) ** 2)  # 40 Hz lag window
    r = r * lag[None, :]
    a, _ = _levinson(r, order)
    # 2) poles, warp the angle of complex poles
    comp = np.zeros((n_frames, order, order))
    comp[:, 0, :] = -a[:, 1:]
    comp[:, np.arange(1, order), np.arange(order - 1)] = 1.0
    poles = np.linalg.eigvals(comp)
    ang = np.angle(poles)
    rad = np.minimum(np.abs(poles), 0.999)
    cplx = np.abs(poles.imag) > 1e-9
    new_ang = np.where(cplx, np.sign(ang) * np.abs(ang) ** alpha, ang)
    a_new = _poly_from_roots(rad * np.exp(1j * new_ang))
    a_old = _poly_from_roots(rad * np.exp(1j * ang))  # same clipping as a_new, for a fair ratio
    # 3) ratio of all-pole envelopes on the analysis bins below nyq_ref
    band = f_bins <= nyq_ref
    omega = 2 * np.pi * f_bins[band] / ref_sr
    e = np.exp(-1j * np.outer(np.arange(order + 1), omega))  # [p+1, F']
    h_old = np.abs(a_old @ e) ** 2
    h_new = np.abs(a_new @ e) ** 2
    ratio_db = 10.0 * np.log10(np.maximum(h_old, 1e-12) / np.maximum(h_new, 1e-12))
    ratio_db = np.clip(ratio_db, -30.0, 30.0)
    full = np.zeros((n_frames, n_bins))
    full[:, band] = ratio_db
    # fade the correction back to 0 dB over one reference-band octave above nyq_ref
    above = ~band
    if above.any():
        edge = ratio_db[:, -1:]
        fade = np.clip(1.0 - (f_bins[above] - nyq_ref) / nyq_ref, 0.0, 1.0)[None, :]
        full[:, above] = edge * fade
    # keep overall frame energy: the paper keeps the LPC gain, which preserves the residual level
    return sp * 10.0 ** (full / 10.0)


def breathe(f0: np.ndarray, ap: np.ndarray, amount: float) -> tuple[np.ndarray, np.ndarray]:
    """Raise aperiodicity (noise power fraction) by ``amount``; at ~1.0 the voice becomes a full whisper."""
    b = float(np.clip(amount, 0.0, 1.0))
    if b <= 0:
        return f0, ap
    ap2 = ap * ap
    ap_new = np.sqrt(ap2 + b * (1.0 - ap2))
    if b >= 0.98:
        return np.zeros_like(f0), np.ones_like(ap)
    return f0, np.clip(ap_new, 0.001, 1.0)


def jitter(f0: np.ndarray, amount: float, seed: int = 0, frame_period_ms: float = FRAME_PERIOD_MS) -> np.ndarray:
    """Random pitch roughness (up to ~0.6 st at amount 1), smoothed to ~40 Hz."""
    if amount <= 0:
        return f0
    rng = np.random.default_rng(seed)
    noise = rng.standard_normal(f0.shape[0])
    noise = signal.lfilter([0.5], [1.0, -0.5], noise)
    st = amount * 0.6 * noise / max(np.std(noise), EPS)
    out = f0.copy()
    v = out > 0
    out[v] *= 2.0 ** (st[v] / 12.0)
    return out


def pulse_parity(f0: np.ndarray, n: int, sr: int, frame_period_ms: float, lead_s: float = 0.0005) -> np.ndarray:
    """+1/-1 flipping at every WORLD glottal pulse (replicates WORLD's synthesis time base)."""
    t_frames = np.arange(f0.shape[0]) * frame_period_ms / 1000.0
    f0d = np.where(f0 > 0, f0, WORLD_DEFAULT_F0)
    t = np.arange(n) / sr + lead_s
    f0s = np.interp(t, t_frames, f0d)
    phase = np.cumsum(f0s / sr)
    return np.where(np.floor(phase).astype(np.int64) % 2 == 0, 1.0, -1.0)


def growl_modulation(f0: np.ndarray, n: int, sr: int, frame_period_ms: float, amount: float) -> np.ndarray:
    """Period-doubling AM (alternate pulses loud/quiet) -> subharmonics at f0/2, voiced frames only."""
    if amount <= 0:
        return np.ones(n)
    d = 0.85 * float(np.clip(amount, 0.0, 1.0))
    parity = pulse_parity(f0, n, sr, frame_period_ms)
    t_frames = np.arange(f0.shape[0]) * frame_period_ms / 1000.0
    voiced = np.interp(np.arange(n) / sr, t_frames, (f0 > 0).astype(np.float64))
    m = 1.0 + d * parity * voiced
    b, a = signal.butter(2, min(4000.0, sr * 0.45) / (sr / 2))
    return signal.filtfilt(b, a, m)


def world_synth(feat: WorldFeatures, out_sr: int | None = None) -> np.ndarray:
    """WORLD synthesis -> float32 mono of exactly ``n_samples`` at ``out_sr`` (default: the analysis rate).

    Lower rates reuse the low bins of the 48 kHz envelope: at 24 kHz / fft 1024 and 12 kHz / fft 512 the bin
    spacing is identical, so synthesis is exact up to the new Nyquist and 2-4x cheaper."""
    sr = feat.sr if out_sr is None else int(out_sr)
    n = int(round(feat.n_samples * sr / feat.sr))
    sp, ap = feat.sp, feat.ap
    if sr != feat.sr:
        ratio = feat.sr // sr
        if ratio * sr != feat.sr or ratio not in (2, 4):
            raise ValueError(f"unsupported synthesis rate {sr} for analysis at {feat.sr}")
    bins = feat.fft_size * sr // feat.sr // 2 + 1
    if sp.shape[1] < bins:
        raise ValueError(f"envelope has {sp.shape[1]} bins, synthesis at {sr} Hz needs {bins}")
    sp, ap = sp[:, :bins], ap[:, :bins]
    f0 = np.asarray(feat.f0, dtype=np.float64)
    fp = feat.frame_period_ms
    if not np.any(f0 > 0):
        # fully unvoiced (whisper): WORLD would spend one FFT per 2 ms noise pulse; filter noise in the STFT
        # domain instead (same envelope, ~10x faster)
        return noise_synth(sp, sr, fp, n)
    # skip runs of near-silent frames (pauses, padding, gaps between aligned STACK segments): WORLD
    # synthesizes silence with 500 Hz noise pulses, which dominates the cost of sparse timelines
    energy = sp.sum(axis=1)
    active = energy > energy.max() * 1e-6
    k = 4
    active = np.convolve(active.astype(np.float64), np.ones(2 * k + 1), mode="same") > 0
    runs = _runs(active, merge_gap=12)
    y = np.zeros(n, dtype=np.float64)
    fade = int(0.002 * sr)
    for a, b in runs:
        seg = pw.synthesize(np.ascontiguousarray(f0[a:b]), np.ascontiguousarray(sp[a:b], dtype=np.float64),
                            np.ascontiguousarray(ap[a:b], dtype=np.float64), sr, fp)
        seg = finite(seg).astype(np.float64)
        off = int(round(a * fp * sr / 1000.0))
        if len(runs) > 1 or a > 0:
            if a > 0:
                seg[:fade] *= np.linspace(0.0, 1.0, min(fade, seg.size))
            if b < f0.size:
                seg[-fade:] *= np.linspace(1.0, 0.0, min(fade, seg.size))
        end = min(n, off + seg.size)
        if end > off:
            y[off:end] += seg[: end - off]
    return y.astype(np.float32)


def _runs(mask: np.ndarray, merge_gap: int = 0) -> list[tuple[int, int]]:
    """[start, end) index runs where ``mask`` is True, merging gaps shorter than ``merge_gap``."""
    edges = np.flatnonzero(np.diff(np.concatenate([[0], mask.astype(np.int8), [0]])))
    runs = [(int(s), int(e)) for s, e in zip(edges[::2], edges[1::2])]
    merged: list[tuple[int, int]] = []
    for s, e in runs:
        if merged and s - merged[-1][1] < merge_gap:
            merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))
    return merged


def noise_synth(sp: np.ndarray, sr: int, frame_period_ms: float, n: int, seed: int = 0) -> np.ndarray:
    """Unvoiced synthesis: white noise shaped by the (time-interpolated) power envelope, STFT overlap-add."""
    from ..dsp import istft

    n_fft = (sp.shape[1] - 1) * 2
    hop = n_fft // 8
    n_frames = int(np.ceil(n / hop)) + 1
    t_frames = np.arange(n_frames) * hop / sr
    pos = np.clip(t_frames * 1000.0 / frame_period_ms, 0, sp.shape[0] - 1)
    i0 = np.floor(pos).astype(np.int64)
    i1 = np.minimum(i0 + 1, sp.shape[0] - 1)
    w = (pos - i0)[:, None]
    env = np.sqrt(np.maximum(sp[i0] * (1.0 - w) + sp[i1] * w, 0.0))
    rng = np.random.default_rng(seed)
    spec = (rng.standard_normal(env.shape) + 1j * rng.standard_normal(env.shape)) * env
    return finite(istft(spec, n, n_fft, hop)).astype(np.float32)


# --------------------------------------------------------------------------- MASK (WORLD path)


def mask_features(
    a: WorldAnalysis,
    *,
    pitch_st: float = 0.0,
    pitch_mode: str = "natural",
    monotone: float = 0.0,
    key: str | Key | None = "Am",
    formant_st: float = 0.0,
    mcadams: float = 1.0,
    breath: float = 0.0,
    growl: float = 0.0,
    seed: int = 0,
    out_sr: int | None = None,
) -> WorldFeatures:
    """Transform the analysis into the masked WORLD parameter set (no synthesis yet).

    With ``out_sr`` below the analysis rate only the envelope bins that synthesis will use are processed."""
    k = key if isinstance(key, Key) else parse_key(key)
    fft_n = a.fft_size
    ratio = 2.0 ** (formant_st / 12.0) if formant_st else 1.0
    if out_sr and out_sr < a.sr:
        a = band_slice(a, bins_for(fft_n, a.sr, out_sr, min(ratio, 1.0)))
    f0 = pitch_contour(a.f0, pitch_st, pitch_mode, monotone, k)
    sp = a.sp
    if formant_st:
        sp = warp_envelope(sp, ratio)
    if mcadams and abs(mcadams - 1.0) > 1e-4:
        sp = mcadams_envelope(sp, a.sr, float(np.clip(mcadams, 0.3, 1.5)), fft_size=fft_n)
    ap = a.ap
    if growl > 0:
        f0 = jitter(f0, growl, seed)
        ap2 = ap * ap
        ap = np.sqrt(ap2 + 0.15 * growl * (1.0 - ap2))
    f0, ap = breathe(f0, ap, breath)
    feat = WorldFeatures(f0, sp, ap, a.sr, a.frame_period_ms, a.n_samples, fft_n=fft_n)
    feat.meta = {"growl": float(growl), "key": k.name, "source_rms": a.rms}
    return feat


def render_features(feat: WorldFeatures, growl: float | None = None, out_sr: int | None = None) -> np.ndarray:
    """Synthesize masked features (applying growl AM if requested), mono float32 at ``out_sr``."""
    sr = feat.sr if out_sr is None else int(out_sr)
    y = world_synth(feat, sr)
    g = feat.meta.get("growl", 0.0) if growl is None else growl
    if g > 0 and np.any(feat.f0 > 0):
        y = (y * growl_modulation(feat.f0, y.shape[0], sr, feat.frame_period_ms, g)).astype(np.float32)
    return y


def mask_world(a: WorldAnalysis, level_ref: float | None = None, out_sr: int | None = None,
               **params) -> tuple[np.ndarray, WorldFeatures]:
    """Full WORLD MASK: returns (``[1, n]`` float32 at ``out_sr``, the features used, for LAYERS)."""
    feat = mask_features(a, out_sr=out_sr, **params)
    sr = a.sr if out_sr is None else int(out_sr)
    y = render_features(feat, out_sr=sr)
    ref = a.rms if level_ref is None else level_ref
    cur = active_rms(y[None, :], sr)
    if cur > EPS and ref > EPS:
        y = y * float(np.clip(ref / cur, 0.05, 20.0))
    return as2d(y), feat


# --------------------------------------------------------------------------- MASK (fast preview path)


_STFT_SHIFTERS: dict[tuple[int, int, int], object] = {}


def _shifter(framesize: int, hop: int, sr: int):
    from stftpitchshift import StftPitchShift

    k = (framesize, hop, sr)
    if k not in _STFT_SHIFTERS:
        _STFT_SHIFTERS[k] = StftPitchShift(framesize, hop, sr)
    return _STFT_SHIFTERS[k]


def stft_shift(x: np.ndarray, sr: int, factors: float | list[float], formant_st: float = 0.0,
               quefrency_s: float = 0.0015) -> np.ndarray:
    """stftpitchshift wrapper: one pass, several pitch factors, timbre (formant) factor."""
    mono = to_mono(x)[0].astype(np.float64)
    if mono.size < 4096:
        mono = np.pad(mono, (0, 4096 - mono.size))
    sh = _shifter(1024, 256, sr)
    with np.errstate(all="ignore"):
        y = sh.shiftpitch(mono, factors=factors, quefrency=quefrency_s, distortion=2.0 ** (formant_st / 12.0))
    return finite(np.asarray(y)[: to_mono(x).shape[1]]).astype(np.float32)


def mask_preview(x: np.ndarray, sr: int, *, pitch_st: float = 0.0, formant_st: float = 0.0,
                 breath: float = 0.0, **_ignored) -> np.ndarray:
    """Approximate MASK without WORLD analysis (pitch + formant only); used until analysis is cached."""
    mono = to_mono(x)
    y = stft_shift(mono, sr, 2.0 ** (pitch_st / 12.0), formant_st)[None, :]
    if breath > 0:
        rng = np.random.default_rng(0)
        from ..dsp import envelope

        env = envelope(y[0], sr, 0.003, 0.03)
        noise = rng.standard_normal(y.shape[1]).astype(np.float32) * env.astype(np.float32)
        noise = signal.sosfilt(signal.butter(2, [1500 / (sr / 2), 9000 / (sr / 2)], "band", output="sos"), noise)
        y = (1.0 - 0.8 * breath) * y + breath * noise[None, :].astype(np.float32) * 1.5
    ref = active_rms(mono, sr)
    cur = active_rms(y, sr)
    if cur > EPS and ref > EPS:
        y = y * float(np.clip(ref / cur, 0.05, 20.0))
    return as2d(y)
