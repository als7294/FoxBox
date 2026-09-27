"""Small shared audio helpers used by stubs and tests (frozen with the contracts; safe for every session to import)."""

from __future__ import annotations

import io
import math

import numpy as np
from scipy.signal import resample_poly

from .models import Peaks


def to_mono(x: np.ndarray) -> np.ndarray:
    """(n,) or (n, ch) or (ch, n) → (1, n) float32."""
    a = np.asarray(x, dtype=np.float32)
    if a.ndim == 1:
        return a[None, :]
    if a.shape[0] > a.shape[1]:  # (n, ch) from soundfile
        a = a.T
    return a.mean(axis=0, keepdims=True).astype(np.float32)


def resample(x: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    """Polyphase resample along the last axis."""
    if sr_in == sr_out:
        return x.astype(np.float32, copy=False)
    g = math.gcd(sr_in, sr_out)
    return resample_poly(x, sr_out // g, sr_in // g, axis=-1).astype(np.float32)


def bar_samples(bars: int, bpm: float, sr: int) -> int:
    """Exact file length for N bars of 4/4: round(bars * 240 / bpm * sr)."""
    return int(round(bars * 240.0 / bpm * sr))


def peaks(x: np.ndarray, sr: int, buckets: int = 800) -> Peaks:
    """Min/max overview of the channel-summed signal."""
    a = np.asarray(x, dtype=np.float32)
    mono = a.mean(axis=0) if a.ndim == 2 else a
    n = mono.shape[-1]
    buckets = max(1, min(buckets, n)) if n else 1
    if n == 0:
        return Peaks(buckets=1, duration_s=0.0, min=[0.0], max=[0.0])
    edges = np.linspace(0, n, buckets + 1).astype(int)
    mins, maxs = [], []
    for i in range(buckets):
        seg = mono[edges[i] : max(edges[i + 1], edges[i] + 1)]
        mins.append(round(float(np.clip(seg.min(), -1, 1)), 4))
        maxs.append(round(float(np.clip(seg.max(), -1, 1)), 4))
    return Peaks(buckets=buckets, duration_s=round(n / sr, 5), min=mins, max=maxs)


def wav_bytes(x: np.ndarray, sr: int, subtype: str = "PCM_16") -> bytes:
    """Encode (channels, n) float32 as a WAV (integer PCM, fmt tag 1) for streaming to the UI."""
    import soundfile as sf

    buf = io.BytesIO()
    a = np.asarray(x, dtype=np.float32)
    sf.write(buf, a.T if a.ndim == 2 else a, sr, format="WAV", subtype=subtype)
    return buf.getvalue()


def db(x: float) -> float:
    return -120.0 if x <= 1e-6 else 20.0 * math.log10(x)


STANDARD_BARS = (1, 2, 4, 8, 16)


def resolve_auto_bars(speech_s: float, bpm: float, first_word_beat: float = 0.0, tail_beats: float = 0.0,
                      max_stretch: float = 0.08, options: tuple[int, ...] = STANDARD_BARS,
                      tail_s: float = 0.0) -> int:
    """Arrange.bars == "auto" (v0.2): the standard bar count nearest to the phrase's natural length that it fits.

    A bar count fits when the speech fits between first_word_beat and the reserved tail, by padding or by
    compressing at most `max_stretch`. Among the options that fit, pick the one closest to the natural length
    in bars. On a tie, take the longer one, because it needs no stretch. If nothing fits, return the longest option.
    `tail_s` (v0.4) is extra room kept after the last word for its release and the FX tail, so AUTO never
    picks a length that chops the ending.
    """
    beat = 60.0 / bpm
    bar = 4.0 * beat
    reserved = (first_word_beat + tail_beats) * beat + max(tail_s, 0.0)  # v0.4: release + FX tail room
    natural_bars = (max(speech_s, 0.0) + reserved) / bar
    fitting = []
    for b in options:
        available = b * bar - reserved
        if available > 0 and max(speech_s, 0.0) / available <= 1.0 + max_stretch:
            fitting.append(b)
    if not fitting:
        return options[-1]
    return min(fitting, key=lambda b: (abs(b - natural_bars), -b))
