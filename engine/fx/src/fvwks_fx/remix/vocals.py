"""1.6 REMIX: the source vocals as phrases (the user's set3: "It should be able to move around vocals too"). DSP only.

phrases(vocals, sr, bpm, downbeat_s, words=None, cents=0.0) -> [(start_beat, end_beat, pc, repeats)]
  The sung phrases in song beats from bar 1's downbeat: from the lyrics' word times when the song has them (v0.10
  SongLyrics, transcribed at import), else from the vocals stem's level (50 ms RMS within REL_DB of its loudest).
  A gap under GAP_BEATS joins two spans; a phrase under MIN_BEATS is a breath or bleed, dropped. Starts snap down and
  ends up to the 1/16. `pc` is the pitch class of the phrase's first CHOP_BEATS (150 Hz-1 kHz power per class, on
  the song's tuning), None when unpitched: BUILD's chops pick by it (REMIX_HARMONY 1.3.7). `repeats` counts the other
  phrases that are the same line (the same words; without words, chroma cosine >= SAME_COS at a length within 25 %):
  the most repeated is the hook.
"""

from __future__ import annotations

import math

import numpy as np
from scipy import ndimage

GAP_BEATS = 0.375
MIN_BEATS = 0.5
REL_DB = -24.0  # a reverb tail sits under it (-30 bridged whole verses)
CHOP_BEATS = 0.5
SAME_COS = 0.92


def _spans_from_level(x: np.ndarray, sr: int, beat: float, downbeat_s: float) -> list[tuple[float, float]]:
    env = 10 * np.log10(ndimage.uniform_filter1d(x.astype(np.float64) ** 2, max(1, int(0.05 * sr))) + 1e-12)
    on = env > max(float(env.max()) + REL_DB, -60.0)
    edges = np.flatnonzero(np.diff(np.concatenate([[0], on.astype(np.int8), [0]])))
    return [((a / sr - downbeat_s) / beat, (b / sr - downbeat_s) / beat) for a, b in zip(edges[::2], edges[1::2])]


def _chroma(x: np.ndarray, sr: int, cents: float) -> np.ndarray | None:
    """The slice's 150 Hz-1 kHz power per pitch class (one Hann window, zero-padded to <= 1 Hz bins), unit-norm."""
    if len(x) < sr // 20 or not np.any(x):
        return None
    nfft = 1 << int(np.ceil(np.log2(max(len(x), sr))))
    p = np.abs(np.fft.rfft(x * np.hanning(len(x)), nfft)) ** 2
    f = np.fft.rfftfreq(nfft, 1 / sr)
    use = (f >= 150.0) & (f <= 1000.0)
    pc = np.round(69.0 + 12.0 * np.log2(f[use] / 440.0) - cents / 100.0).astype(np.int64) % 12
    m = np.bincount(pc, weights=p[use], minlength=12)
    return m / np.linalg.norm(m) if m.any() else None


def _pc(x: np.ndarray, sr: int, cents: float) -> int | None:
    m = _chroma(x, sr, cents)
    return int(np.argmax(m)) if m is not None and m.max() > 2.0 * np.median(m) else None


def phrases(vocals: np.ndarray, sr: int, bpm: float, downbeat_s: float, words=None,
            cents: float = 0.0) -> list[tuple[float, float, int | None, int]]:
    beat = 60.0 / bpm
    x = np.asarray(vocals, np.float64)
    x = x.mean(axis=0) if x.ndim > 1 else x
    if words:
        spans = [((w.start_s - downbeat_s) / beat, (w.end_s - downbeat_s) / beat) for w in words]
    else:
        spans = _spans_from_level(x, sr, beat, downbeat_s)
    merged: list[list[float]] = []
    for a, b in sorted(spans):
        if merged and a - merged[-1][1] < GAP_BEATS:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    kept, sigs = [], []
    for a, b in merged:
        a, b = max(0.0, math.floor(a * 4) / 4), math.ceil(b * 4) / 4
        if b - a < MIN_BEATS:
            continue
        i, j = int((downbeat_s + a * beat) * sr), int((downbeat_s + b * beat) * sr)
        kept.append((a, b, _pc(x[max(0, i):i + int(CHOP_BEATS * beat * sr)], sr, cents)))
        if words:
            sigs.append(" ".join(w.text.lower().strip(" .,!?'\"") for w in words
                                 if a <= (w.start_s - downbeat_s) / beat < b))
        else:
            sigs.append(_chroma(x[max(0, i):max(0, j)], sr, cents))
    same = lambda p, q: (p[1] - p[0]) / (q[1] - q[0]) < 1.25 and (q[1] - q[0]) / (p[1] - p[0]) < 1.25  # noqa: E731
    out = []
    for k, (p, sk) in enumerate(zip(kept, sigs)):
        if words:
            n = sum(1 for m, sm in enumerate(sigs) if m != k and sk and sm == sk)
        else:
            n = sum(1 for m, (q, sm) in enumerate(zip(kept, sigs)) if m != k and sk is not None and sm is not None
                    and same(p, q) and float(sk @ sm) >= SAME_COS)
        out.append((*p, n))
    return out
