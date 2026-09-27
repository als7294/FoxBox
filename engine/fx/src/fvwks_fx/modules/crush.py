"""CRUSH: bit depth, sample-rate reduction, GSM / MP3 codec grit, radio noise bed with squelch."""

from __future__ import annotations

import numpy as np
import pedalboard

from ..dsp import EPS, active_rms, as2d, butter_sos, db_to_lin, fade_edges, pink_noise, sos
from . import airwin as AW


def bitcrush(x: np.ndarray, bits: float) -> np.ndarray:
    q = 2.0 ** (float(np.clip(bits, 1.0, 24.0)) - 1.0)
    return (np.round(as2d(x) * q) / q).astype(np.float32)


def downsample(x: np.ndarray, sr: int, rate_hz: float) -> np.ndarray:
    """Zero-order-hold decimation (aliasing is the point)."""
    a = as2d(x)
    if rate_hz >= sr:
        return a
    return pedalboard.Resample(float(rate_hz), quality=pedalboard.Resample.Quality.ZeroOrderHold)(a, sr)


def codec(x: np.ndarray, sr: int, kind: str, mp3_quality: float = 9.0) -> np.ndarray:
    a = as2d(x)
    if kind == "gsm":
        # latency-compensated by pedalboard (verified on speech: 0-sample envelope/waveform lag)
        return pedalboard.GSMFullRateCompressor()(a, sr)
    if kind == "mp3":
        return pedalboard.MP3Compressor(vbr_quality=float(np.clip(mp3_quality, 0.0, 9.99)))(a, sr)
    return a


def noise_bed(n: int, sr: int, level_db: float, *, start: int = 0, end: int | None = None, squelch: bool = False,
              seed: int = 0, channels: int = 2) -> np.ndarray:
    """Radio hiss (band-limited pink noise + crackle) between ``start`` and ``end`` with optional squelch
    bursts at both edges. Level is RMS dBFS. Returns ``[channels, n]``."""
    end = n if end is None else int(np.clip(end, 0, n))
    start = int(np.clip(start, 0, n))
    out = np.zeros((channels, n), np.float32)
    if end - start < 16:
        return out
    rng = np.random.default_rng(seed)
    length = end - start
    hiss = np.stack([pink_noise(length, rng) for _ in range(channels)])
    hiss = sos(hiss, butter_sos("bandpass", (250.0, 5000.0), sr, 2))
    hiss *= db_to_lin(level_db) / max(active_rms(hiss, sr), EPS)
    # sparse band-limited ticks ~12 dB above the hiss (radio crackle, never a full-scale click)
    ticks = (rng.random((channels, length)) < 12.0 / sr) * rng.standard_normal((channels, length))
    ticks = sos(ticks.astype(np.float32), butter_sos("bandpass", (1000.0, 6000.0), sr, 2))
    ticks *= db_to_lin(level_db + 12.0) / max(float(np.max(np.abs(ticks))), EPS)
    bed = hiss + ticks
    bed *= db_to_lin(level_db) / max(active_rms(bed, sr), EPS)
    bed = fade_edges(bed, int(0.004 * sr), int(0.02 * sr))
    out[:, start:end] = bed
    if squelch:
        burst_len = int(0.09 * sr)
        for pos in (start, max(start, end - burst_len)):
            b = rng.standard_normal((channels, burst_len)).astype(np.float32)
            b = sos(b, butter_sos("bandpass", (400.0, 7000.0), sr, 2))
            env = np.exp(-np.arange(burst_len) / (0.018 * sr)).astype(np.float32)
            b = b * env[None, :] * db_to_lin(level_db + 20.0) / max(float(np.sqrt(np.mean(b**2))), EPS)
            click = np.zeros_like(b)
            click[:, :24] = np.hanning(48)[24:] * db_to_lin(level_db + 22.0)
            seg = out[:, pos : pos + burst_len]
            seg += (b + click)[:, : seg.shape[1]]
    return out


def crush(
    x: np.ndarray,
    sr: int,
    *,
    bits: float | None = None,
    rate_hz: float | None = None,
    codec_kind: str | None = None,
    mp3_quality: float = 9.0,
    mix: float = 1.0,
    derez: float = 0.0,
    seed: int = 0,
) -> np.ndarray:
    """Degrade the signal: Airwindows DeRez4, sample rate, bits, codec. Noise bed is added separately (it needs the
    arranged timeline)."""
    a = as2d(x)
    y = a
    if derez > 0 and AW.AVAILABLE:
        y = AW.derez(y, sr, derez, seed)
    if rate_hz:
        y = downsample(y, sr, rate_hz)
    if bits:
        y = bitcrush(y, bits)
    if codec_kind and codec_kind not in ("none", "off"):
        y = codec(y, sr, codec_kind, mp3_quality)
    m = float(np.clip(mix, 0.0, 1.0))
    return ((1.0 - m) * a + m * y).astype(np.float32)
