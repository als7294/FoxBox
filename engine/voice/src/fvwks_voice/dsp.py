"""Small mono DSP helpers for sources: trimming, levels, high-pass and silence splitting.

Arrays here are 1-D float32. The contract's Source wants (1, n); the api module adds that axis.
"""

from __future__ import annotations

import math

import numpy as np
from scipy.signal import butter, sosfiltfilt

from fvwks_contracts.audio import resample as _resample

SR = 48_000
TARGET_RMS_DB = -20.0  # active-speech RMS after normalization
PEAK_CEILING_DB = -1.0


def resample(x: np.ndarray, sr_in: int, sr_out: int = SR) -> np.ndarray:
    return _resample(np.asarray(x, dtype=np.float32), sr_in, sr_out).reshape(-1)


def frame_db(x: np.ndarray, sr: int, win_s: float = 0.02, hop_s: float = 0.005) -> tuple[np.ndarray, np.ndarray, int]:
    """Short-time RMS level in dBFS. Returns (db per frame, frame start samples, window length)."""
    win = max(1, int(round(win_s * sr)))
    hop = max(1, int(round(hop_s * sr)))
    n = len(x)
    if n < win:
        x = np.pad(x, (0, win - n))
        n = win
    c = np.concatenate([[0.0], np.cumsum(np.square(x, dtype=np.float64))])
    starts = np.arange(0, n - win + 1, hop)
    energy = (c[starts + win] - c[starts]) / win
    return 10.0 * np.log10(np.maximum(energy, 1e-15)), starts, win


def _active_runs(active: np.ndarray) -> list[tuple[int, int]]:
    """Runs of True as [i0, i1) frame ranges."""
    d = np.diff(np.concatenate([[0], active.astype(np.int8), [0]]))
    return list(zip(np.flatnonzero(d == 1).tolist(), np.flatnonzero(d == -1).tolist()))


def speech_bounds(x: np.ndarray, sr: int, rel_db: float = -50.0, floor_db: float = -70.0,
                  pad_start_s: float = 0.01, pad_end_s: float = 0.05, *, noise_margin_db: float | None = None,
                  min_run_s: float = 0.0, isolation_s: float = 0.15) -> tuple[int, int] | None:
    """[start, end) around everything within `rel_db` of the loudest frame (and above `floor_db`), padded.
    None when nothing clears the threshold.

    For recordings:
    - `noise_margin_db` also keeps the threshold that far above the noise floor (10th-percentile frame). It is
      capped 10 dB below the peak, so a steady sound still counts.
    - `min_run_s` drops a short burst at either edge (a mic bump or click) when it is more than `isolation_s`
      away from the rest; a final plosive right after the speech stays.
    """
    if len(x) == 0:
        return None
    db, starts, win = frame_db(x, sr)
    peak = float(db.max())
    thresh = max(peak + rel_db, floor_db)
    if noise_margin_db is not None:
        thresh = max(thresh, min(float(np.percentile(db, 10)) + noise_margin_db, peak - 10.0))
    runs = _active_runs(db > thresh)
    if not runs:
        return None
    if min_run_s > 0 and len(runs) > 1:
        hop = int(starts[1] - starts[0]) if len(starts) > 1 else win

        def short(r: tuple[int, int]) -> bool:
            return ((r[1] - r[0] - 1) * hop + win) / sr < min_run_s

        def apart(r0: tuple[int, int], r1: tuple[int, int]) -> bool:
            return (r1[0] - r0[1]) * hop / sr > isolation_s

        while len(runs) > 1 and short(runs[0]) and apart(runs[0], runs[1]):
            runs.pop(0)
        while len(runs) > 1 and short(runs[-1]) and apart(runs[-2], runs[-1]):
            runs.pop()
    # Frames only locate the edges to within a window; refine to the first/last sample above the level.
    amp = 10.0 ** (thresh / 20.0)
    a = int(starts[runs[0][0]])
    b = int(min(len(x), starts[runs[-1][1] - 1] + win))
    head = np.flatnonzero(np.abs(x[a:a + win]) > amp)
    tail = np.flatnonzero(np.abs(x[max(a, b - win):b]) > amp)
    start = a + int(head[0]) if head.size else a
    end = max(a, b - win) + int(tail[-1]) + 1 if tail.size else b
    start = max(0, start - int(pad_start_s * sr))
    end = min(len(x), end + int(pad_end_s * sr))
    return start, end


def fade(x: np.ndarray, sr: int, fade_in_s: float = 0.003, fade_out_s: float = 0.01) -> np.ndarray:
    """Raised-cosine fades on a copy."""
    y = np.array(x, dtype=np.float32, copy=True)
    for seconds, at_end in ((fade_in_s, False), (fade_out_s, True)):
        n_fade = min(int(seconds * sr), len(y) // 2)
        if n_fade <= 0:
            continue
        ramp = (0.5 - 0.5 * np.cos(np.linspace(0.0, math.pi, n_fade, dtype=np.float64))).astype(np.float32)
        if at_end:
            y[-n_fade:] *= ramp[::-1]
        else:
            y[:n_fade] *= ramp
    return y


def active_rms_db(x: np.ndarray, sr: int, gate_rel_db: float = -40.0) -> float | None:
    """RMS over frames within `gate_rel_db` of the loudest frame: a simple active-speech level."""
    if len(x) == 0:
        return None
    db, _, _ = frame_db(x, sr, 0.05, 0.025)
    if db.max() < -100:
        return None
    active = db[db > db.max() + gate_rel_db]
    return float(10.0 * np.log10(np.mean(10.0 ** (active / 10.0))))


def normalize_speech(x: np.ndarray, sr: int, target_rms_db: float = TARGET_RMS_DB,
                     peak_ceiling_db: float = PEAK_CEILING_DB) -> tuple[np.ndarray, float]:
    """Gain speech to a consistent active level, capped so the sample peak stays under the ceiling.
    Returns (audio, gain_db). Consistent input level keeps DRIVE/CRUSH behaving the same across voices."""
    level = active_rms_db(x, sr)
    peak = float(np.max(np.abs(x))) if len(x) else 0.0
    if level is None or peak <= 0:
        return np.asarray(x, dtype=np.float32), 0.0
    gain_db = target_rms_db - level
    ceiling_gain_db = peak_ceiling_db - 20.0 * math.log10(peak)
    gain_db = min(gain_db, ceiling_gain_db)
    y = (np.asarray(x, dtype=np.float64) * 10.0 ** (gain_db / 20.0)).astype(np.float32)
    return y, gain_db


def highpass(x: np.ndarray, sr: int, cutoff_hz: float = 70.0, order: int = 2) -> np.ndarray:
    """Zero-phase Butterworth high-pass (order doubles through filtfilt). Removes DC and rumble."""
    if len(x) < 64:
        return np.asarray(x, dtype=np.float32)
    sos = butter(order, cutoff_hz, btype="highpass", fs=sr, output="sos")
    padlen = min(len(x) - 1, int(0.1 * sr))  # long enough for a 70 Hz filter to settle at the edges
    return sosfiltfilt(sos, np.asarray(x, dtype=np.float64), padlen=padlen).astype(np.float32)


def speech_band(x: np.ndarray, sr: int, lo_hz: float = 150.0, hi_hz: float = 5000.0) -> np.ndarray:
    """Zero-phase 150 Hz-5 kHz band-pass: a detector copy for finding speech past rumble, hum and hiss."""
    if len(x) < 64:
        return np.asarray(x, dtype=np.float32)
    sos = butter(2, [lo_hz, min(hi_hz, 0.45 * sr)], btype="bandpass", fs=sr, output="sos")
    padlen = min(len(x) - 1, int(0.05 * sr))
    return sosfiltfilt(sos, np.asarray(x, dtype=np.float64), padlen=padlen).astype(np.float32)


def quietest_point(x: np.ndarray, center: int, radius: int, win: int = 96) -> int:
    """Index of the lowest short-window energy within center±radius (for click-free cuts)."""
    lo = max(0, center - radius)
    hi = min(len(x), center + radius)
    if hi - lo <= win:
        return int(np.clip(center, 0, len(x)))
    seg = np.square(x[lo:hi], dtype=np.float64)
    c = np.concatenate([[0.0], np.cumsum(seg)])
    e = c[win:] - c[:-win]
    return int(lo + np.argmin(e) + win // 2)


def split_on_silence(x: np.ndarray, sr: int, min_silence_s: float = 0.25, min_speech_s: float = 0.08,
                     rel_db: float = -40.0, floor_db: float = -60.0, pad_s: float = 0.03) -> list[tuple[int, int]]:
    """Speech regions [start, end) separated by at least `min_silence_s` below the threshold.
    The threshold follows the loudest frame (rel_db) but never drops under the noise floor + 6 dB."""
    if len(x) == 0:
        return []
    db, starts, win = frame_db(x, sr, 0.03, 0.01)
    noise = float(np.percentile(db, 10))
    thresh = max(float(db.max()) + rel_db, floor_db, noise + 6.0)
    voiced = db > thresh
    if not voiced.any():
        return []
    hop = int(starts[1] - starts[0]) if len(starts) > 1 else win
    # Runs of voiced frames, then bridge gaps shorter than min_silence_s.
    edges = np.flatnonzero(np.diff(np.concatenate([[0], voiced.astype(np.int8), [0]])))
    runs = [(int(edges[i]), int(edges[i + 1])) for i in range(0, len(edges), 2)]  # frame indices [a, b)
    min_gap = max(1, int(round(min_silence_s * sr / hop)))
    merged: list[list[int]] = []
    for a, b in runs:
        if merged and a - merged[-1][1] < min_gap:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    pad = int(pad_s * sr)
    regions: list[tuple[int, int]] = []
    for a, b in merged:
        s = int(starts[a])
        e = int(min(len(x), starts[b - 1] + win))
        if (e - s) < min_speech_s * sr and len(merged) > 1:
            continue
        regions.append((max(0, s - pad), min(len(x), e + pad)))
    # Padding may overlap neighbours: meet in the middle of the gap.
    for i in range(1, len(regions)):
        (s0, e0), (s1, e1) = regions[i - 1], regions[i]
        if e0 > s1:
            mid = (e0 + s1) // 2
            regions[i - 1], regions[i] = (s0, mid), (mid, e1)
    return regions


def median_f0(x: np.ndarray, sr: int) -> float | None:
    """Median voiced F0 (WORLD Harvest, 50-500 Hz), or None when nothing is voiced. The same measure as the
    voice catalog's MEASURED table, so persona and stock voices compare directly."""
    import pyworld

    if len(x) < sr // 10:
        return None
    f0, _ = pyworld.harvest(np.asarray(x, dtype=np.float64), sr, f0_floor=50.0, f0_ceil=500.0, frame_period=5.0)
    voiced = f0[f0 > 0]
    return float(np.median(voiced)) if voiced.size else None


def f0_tag(f0_hz: float | None) -> str | None:
    """'f0:142' (the app shows it as "F0 142 Hz" and hides it from the tag chips)."""
    return f"f0:{int(round(f0_hz))}" if f0_hz else None


def find_pauses(x: np.ndarray, sr: int, rel_db: float = -40.0,
                min_silence_s: float = 0.03) -> tuple[list[tuple[float, float]], float | None]:
    """Pauses inside a phrase (>= min_silence_s below rel_db of its loudest 5 ms) as (speech stops, speech
    resumes) in seconds, plus the audible onset. Leading and trailing silence are not pauses."""
    db, starts, win = frame_db(x, sr, 0.005, 0.0025)
    active = db > db.max() + rel_db
    if not active.any():
        return [], None
    d = np.diff(np.concatenate([[1], active.astype(np.int8), [1]]))
    out = []
    for i0, i1 in zip(np.flatnonzero(d == -1), np.flatnonzero(d == 1)):  # inactive frames [i0, i1)
        if i0 == 0 or i1 >= len(active):
            continue
        t0, t1 = (starts[i0] + win / 2) / sr, starts[i1] / sr
        if t1 - t0 >= min_silence_s:
            out.append((float(t0), float(t1)))
    return out, float(starts[int(np.argmax(active))] / sr)
