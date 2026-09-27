"""Shared DSP helpers for the FVWKS rack.

Buffers are float32 arrays shaped ``[channels, n]``. The rack runs at 48 kHz internally (``SR``).
Every function here is pure: no file I/O, no global state except explicit caches.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from scipy import signal

SR = 48000
EPS = 1e-12


# --------------------------------------------------------------------------- shapes


def as2d(x: np.ndarray) -> np.ndarray:
    """Return ``x`` as a C-contiguous float32 ``[channels, n]`` array."""
    a = np.asarray(x, dtype=np.float32)
    if a.ndim == 1:
        a = a[None, :]
    if a.ndim != 2:
        raise ValueError(f"expected [channels, n] audio, got shape {a.shape}")
    return np.ascontiguousarray(a)


def to_mono(x: np.ndarray) -> np.ndarray:
    """Average channels to ``[1, n]``."""
    a = as2d(x)
    return a if a.shape[0] == 1 else a.mean(axis=0, keepdims=True)


def to_stereo(x: np.ndarray) -> np.ndarray:
    """Duplicate a mono buffer to ``[2, n]``; stereo passes through; more channels are folded."""
    a = as2d(x)
    if a.shape[0] == 2:
        return a
    if a.shape[0] == 1:
        return np.repeat(a, 2, axis=0)
    return np.stack([a[0::2].mean(axis=0), a[1::2].mean(axis=0)])


def match_channels(x: np.ndarray, channels: int) -> np.ndarray:
    return to_stereo(x) if channels == 2 else to_mono(x)


def fit_length(x: np.ndarray, n: int) -> np.ndarray:
    """Zero-pad or truncate along the last axis to exactly ``n`` samples."""
    a = as2d(x)
    if a.shape[1] == n:
        return a
    if a.shape[1] > n:
        return np.ascontiguousarray(a[:, :n])
    out = np.zeros((a.shape[0], n), dtype=np.float32)
    out[:, : a.shape[1]] = a
    return out


def add_at(dst: np.ndarray, src: np.ndarray, offset: int) -> None:
    """Mix ``src`` into ``dst`` starting at ``offset`` (clipped to ``dst``'s bounds). In place."""
    n_dst = dst.shape[-1]
    n_src = src.shape[-1]
    a0, b0 = offset, offset + n_src
    s0 = max(0, -a0)
    a0 = max(0, a0)
    b0 = min(n_dst, b0)
    if b0 <= a0:
        return
    dst[..., a0:b0] += src[..., s0 : s0 + (b0 - a0)]


def finite(x: np.ndarray) -> np.ndarray:
    """Replace NaN/inf with zeros (never let a bad frame poison the whole render)."""
    a = np.asarray(x, dtype=np.float32)
    if not np.all(np.isfinite(a)):
        a = np.nan_to_num(a, nan=0.0, posinf=0.0, neginf=0.0)
    return a


# --------------------------------------------------------------------------- levels


def db_to_lin(db: float | np.ndarray) -> float | np.ndarray:
    return np.power(10.0, np.asarray(db) / 20.0) if isinstance(db, np.ndarray) else 10.0 ** (db / 20.0)


def lin_to_db(v: float | np.ndarray, floor_db: float = -150.0) -> float | np.ndarray:
    out = 20.0 * np.log10(np.maximum(np.abs(v), 10 ** (floor_db / 20.0)))
    return float(out) if np.ndim(out) == 0 else out


def rms(x: np.ndarray) -> float:
    a = np.asarray(x, dtype=np.float64)
    return float(np.sqrt(np.mean(a * a))) if a.size else 0.0


def active_rms(x: np.ndarray, sr: int = SR, win_s: float = 0.05, rel_db: float = -40.0) -> float:
    """RMS over the active (non-silent) parts only, so level matching ignores padding.

    Power is averaged across channels (not the channel average squared), so decorrelated stereo reads the
    same per-channel level as mono."""
    a = as2d(x).astype(np.float64)
    if a.shape[1] == 0:
        return 0.0
    pw = np.mean(a * a, axis=0)
    w = max(1, int(win_s * sr))
    n_blocks = max(1, pw.size // w)
    blocks = pw[: n_blocks * w].reshape(n_blocks, w) if pw.size >= w else pw[None, :]
    e = np.sqrt(np.mean(blocks, axis=1))
    top = float(e.max())
    if top <= 0:
        return 0.0
    keep = e >= top * 10 ** (rel_db / 20.0)
    return float(np.sqrt(np.mean(e[keep] ** 2)))


def match_level(y: np.ndarray, ref: np.ndarray, sr: int = SR, max_gain_db: float = 24.0) -> np.ndarray:
    """Scale ``y`` so its active RMS equals ``ref``'s."""
    ry, rr = active_rms(y, sr), active_rms(ref, sr)
    if ry <= EPS or rr <= EPS:
        return as2d(y)
    g = float(np.clip(rr / ry, db_to_lin(-max_gain_db), db_to_lin(max_gain_db)))
    return (as2d(y) * g).astype(np.float32)


def fade_edges(x: np.ndarray, fade_in: int = 0, fade_out: int = 0) -> np.ndarray:
    """Raised-cosine fades at the buffer edges (returns a copy)."""
    a = as2d(x).copy()
    n = a.shape[1]
    if fade_in > 0:
        k = min(fade_in, n)
        a[:, :k] *= (0.5 - 0.5 * np.cos(np.pi * (np.arange(k) + 0.5) / k)).astype(np.float32)
    if fade_out > 0:
        k = min(fade_out, n)
        a[:, n - k :] *= (0.5 + 0.5 * np.cos(np.pi * (np.arange(k) + 0.5) / k)).astype(np.float32)
    return a


def crossfade_window(n: int) -> np.ndarray:
    return (0.5 - 0.5 * np.cos(np.pi * (np.arange(n) + 0.5) / max(n, 1))).astype(np.float32)


# --------------------------------------------------------------------------- filters


def butter_sos(kind: str, freq: float | tuple[float, float], sr: int, order: int = 4) -> np.ndarray:
    nyq = sr / 2.0
    if isinstance(freq, tuple):
        lo, hi = (max(1.0, freq[0]), min(nyq * 0.98, freq[1]))
        return signal.butter(order, [lo / nyq, hi / nyq], btype=kind, output="sos")
    f = float(np.clip(freq, 1.0, nyq * 0.98))
    return signal.butter(order, f / nyq, btype=kind, output="sos")


def sos(x: np.ndarray, sos_coef: np.ndarray, zero_phase: bool = False) -> np.ndarray:
    a = as2d(x)
    if zero_phase:
        if a.shape[1] <= 3 * (2 * len(sos_coef) + 1):
            return a
        return signal.sosfiltfilt(sos_coef, a, axis=-1).astype(np.float32)
    return signal.sosfilt(sos_coef, a, axis=-1).astype(np.float32)


def highpass(x: np.ndarray, sr: int, hz: float, order: int = 4, zero_phase: bool = False) -> np.ndarray:
    return sos(x, butter_sos("highpass", hz, sr, order), zero_phase)


def lowpass(x: np.ndarray, sr: int, hz: float, order: int = 4, zero_phase: bool = False) -> np.ndarray:
    return sos(x, butter_sos("lowpass", hz, sr, order), zero_phase)


def one_pole_lowpass(x: np.ndarray, tau_s: float, sr: float) -> np.ndarray:
    """First-order smoother along the last axis (time constant ``tau_s``)."""
    if tau_s <= 0:
        return np.asarray(x)
    a = float(np.exp(-1.0 / (tau_s * sr)))
    return signal.lfilter([1.0 - a], [1.0, -a], x, axis=-1)


def envelope(x: np.ndarray, sr: float, attack_s: float = 0.005, release_s: float = 0.08) -> np.ndarray:
    """Vectorised peak-ish envelope follower: a fast smoother on the rectified signal, then a
    slower smoother on the max of both (approximates asymmetric attack/release without a loop)."""
    r = np.abs(np.asarray(x, dtype=np.float64))
    fast = one_pole_lowpass(r, attack_s, sr)
    slow = one_pole_lowpass(fast, release_s, sr)
    return np.maximum(fast, slow)


# --------------------------------------------------------------------------- STFT


def _stft_window(n_fft: int) -> np.ndarray:
    return np.sqrt(np.hanning(n_fft + 1)[:-1]).astype(np.float64)  # periodic sqrt-Hann


def stft(x: np.ndarray, n_fft: int = 1024, hop: int = 256) -> np.ndarray:
    """Centered STFT of a 1-D signal -> ``[frames, n_fft//2+1]`` complex128."""
    v = np.asarray(x, dtype=np.float64)
    pad = n_fft // 2
    n_frames = int(np.ceil((v.size + 2 * pad - n_fft) / hop)) + 1 if v.size else 1
    total = (n_frames - 1) * hop + n_fft
    xp = np.zeros(total)
    xp[pad : pad + v.size] = v
    frames = sliding_window_view(xp, n_fft)[::hop][:n_frames]
    return np.fft.rfft(frames * _stft_window(n_fft), axis=1)


def istft(spec: np.ndarray, n: int, n_fft: int = 1024, hop: int = 256) -> np.ndarray:
    """Inverse of :func:`stft` (weighted overlap-add), trimmed to ``n`` samples."""
    if n_fft % hop:
        raise ValueError("hop must divide n_fft")
    w = _stft_window(n_fft)
    frames = np.fft.irfft(spec, n=n_fft, axis=1) * w
    n_frames = frames.shape[0]
    r = n_fft // hop
    total = (n_frames + r - 1) * hop
    y = np.zeros(total)
    norm = np.zeros(total)
    chunks = frames.reshape(n_frames, r, hop)
    wchunks = (w * w).reshape(r, hop)
    for k in range(r):
        y[k * hop : k * hop + n_frames * hop] += chunks[:, k, :].reshape(-1)
        norm[k * hop : k * hop + n_frames * hop] += np.tile(wchunks[k], n_frames)
    y /= np.maximum(norm, 1e-8)
    pad = n_fft // 2
    return y[pad : pad + n]


# --------------------------------------------------------------------------- oscillators


def _phase(freq: float | np.ndarray, n: int, sr: float, phase0: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    f = np.broadcast_to(np.asarray(freq, dtype=np.float64), (n,))
    dt = f / sr
    ph = (phase0 + np.cumsum(dt) - dt[0]) % 1.0
    return ph, dt


def _polyblep(t: np.ndarray, dt: np.ndarray) -> np.ndarray:
    out = np.zeros_like(t)
    lo = t < dt
    u = t[lo] / dt[lo]
    out[lo] = u + u - u * u - 1.0
    hi = t > 1.0 - dt
    u = (t[hi] - 1.0) / dt[hi]
    out[hi] = u * u + u + u + 1.0
    return out


def saw(freq: float | np.ndarray, n: int, sr: float, phase0: float = 0.0) -> np.ndarray:
    """Band-limited (polyBLEP) sawtooth in [-1, 1]."""
    ph, dt = _phase(freq, n, sr, phase0)
    return (2.0 * ph - 1.0 - _polyblep(ph, dt)).astype(np.float32)


def square(freq: float | np.ndarray, n: int, sr: float, phase0: float = 0.0) -> np.ndarray:
    """Band-limited (polyBLEP) square in [-1, 1]."""
    ph, dt = _phase(freq, n, sr, phase0)
    y = np.where(ph < 0.5, 1.0, -1.0)
    y += _polyblep(ph, dt)
    y -= _polyblep((ph + 0.5) % 1.0, dt)
    return y.astype(np.float32)


def pink_noise(n: int, rng: np.random.Generator) -> np.ndarray:
    """Approximate pink noise (Voss-McCartney-ish via FFT shaping), unit RMS."""
    if n <= 0:
        return np.zeros(0, np.float32)
    m = int(2 ** np.ceil(np.log2(max(n, 2))))
    spec = np.fft.rfft(rng.standard_normal(m))
    f = np.arange(spec.size, dtype=np.float64)
    f[0] = 1.0
    spec /= np.sqrt(f)
    y = np.fft.irfft(spec, n=m)[:n]
    return (y / max(rms(y), EPS)).astype(np.float32)


# --------------------------------------------------------------------------- panning


def pan_gains(pan: float) -> tuple[float, float]:
    """Constant-power pan normalised so centre is unity in both channels. ``pan`` in [-1, 1]."""
    p = float(np.clip(pan, -1.0, 1.0))
    th = (p + 1.0) * np.pi / 4.0
    return float(np.sqrt(2.0) * np.cos(th)), float(np.sqrt(2.0) * np.sin(th))


def pan_mono(x: np.ndarray, pan: float, gain: float = 1.0) -> np.ndarray:
    m = to_mono(x)[0]
    gl, gr = pan_gains(pan)
    return np.stack([m * gl * gain, m * gr * gain]).astype(np.float32)


# --------------------------------------------------------------------------- hashing


def _jsonable(o: Any) -> Any:
    if hasattr(o, "model_dump"):
        return o.model_dump(mode="json")
    if isinstance(o, np.ndarray):
        return {"__nd__": hashlib.sha1(np.ascontiguousarray(o).tobytes()).hexdigest(), "shape": list(o.shape)}
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    if isinstance(o, dict):
        return {str(k): _jsonable(v) for k, v in sorted(o.items(), key=lambda kv: str(kv[0]))}
    if isinstance(o, (list, tuple)):
        return [_jsonable(v) for v in o]
    if hasattr(o, "__dataclass_fields__"):
        return {k: _jsonable(getattr(o, k)) for k in o.__dataclass_fields__}
    return o


def stable_hash(*parts: Any) -> str:
    """Deterministic hash of params/arrays for memo keys."""
    payload = json.dumps([_jsonable(p) for p in parts], sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha1(payload.encode()).hexdigest()


def audio_hash(x: np.ndarray, sr: int) -> str:
    a = np.ascontiguousarray(np.asarray(x, dtype=np.float32))
    h = hashlib.sha1(a.tobytes())
    h.update(f"{a.shape}|{sr}".encode())
    return h.hexdigest()
