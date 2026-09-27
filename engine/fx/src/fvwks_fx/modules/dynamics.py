"""DYNAMICS: compressor (pedalboard) plus a 3-band upward/downward "OTT" compressor.

OTT bands are split with zero-phase complementary filters (low + mid + high == input exactly), each band
gets downward compression above its threshold and upward compression below it (noise-floor guarded),
and ``amount`` blends the processed bands against the unprocessed split (parallel, like OTT's Depth).
"""

from __future__ import annotations

import numpy as np
import pedalboard

from ..dsp import EPS, active_rms, as2d, butter_sos, db_to_lin, one_pole_lowpass, sos


def compressor(x: np.ndarray, sr: int, *, threshold_db: float = -18.0, ratio: float = 3.0, attack_ms: float = 5.0,
               release_ms: float = 80.0, makeup_db: float = 0.0) -> np.ndarray:
    a = as2d(x)
    if ratio <= 1.0:
        return a
    y = pedalboard.Compressor(threshold_db=float(threshold_db), ratio=float(ratio), attack_ms=float(attack_ms),
                              release_ms=float(release_ms))(a, sr)
    return (y * db_to_lin(makeup_db)).astype(np.float32)


def split3(x: np.ndarray, sr: int, lo_hz: float = 120.0, hi_hz: float = 2500.0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    a = as2d(x).astype(np.float64)
    low = sos(a, butter_sos("lowpass", lo_hz, sr, 2), zero_phase=True).astype(np.float64)
    high = sos(a, butter_sos("highpass", hi_hz, sr, 2), zero_phase=True).astype(np.float64)
    mid = a - low - high
    return low, mid, high


def _band_gain_db(level_db: np.ndarray, down_thr: float, down_ratio: float, up_thr: float, up_ratio: float,
                  max_up_db: float, floor_db: float) -> np.ndarray:
    g = np.zeros_like(level_db)
    over = level_db > down_thr
    g[over] = (down_thr - level_db[over]) * (1.0 - 1.0 / down_ratio)
    under = level_db < up_thr
    boost = (up_thr - level_db[under]) * (1.0 - 1.0 / up_ratio)
    # no upward boost for near-silence (keeps pauses and padding clean)
    guard = np.clip((level_db[under] - floor_db) / 12.0, 0.0, 1.0)
    g[under] = np.minimum(boost, max_up_db) * guard
    return g


def ott(
    x: np.ndarray,
    sr: int,
    *,
    amount: float = 0.3,
    lo_hz: float = 120.0,
    hi_hz: float = 2500.0,
    down_thr_db: float = -30.0,
    up_thr_db: float = -42.0,
    down_ratio: float = 8.0,
    up_ratio: float = 3.0,
    max_up_db: float = 18.0,
    floor_db: float = -68.0,
    time_ms: float = 30.0,
    band_db: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> np.ndarray:
    a = as2d(x)
    m = float(np.clip(amount, 0.0, 1.0))
    if m <= 0:
        return a
    bands = split3(a, sr, lo_hz, hi_hz)
    dry = bands[0] + bands[1] + bands[2]
    wet = np.zeros_like(dry)
    for b, trim in zip(bands, band_db):
        p = one_pole_lowpass(np.mean(b * b, axis=0), 0.010, sr)
        level = 10.0 * np.log10(np.maximum(p, 1e-15)) + 3.0  # ~ RMS->peak-ish reference
        gdb = _band_gain_db(level, down_thr_db, down_ratio, up_thr_db, up_ratio, max_up_db, floor_db)
        gdb = one_pole_lowpass(gdb, time_ms / 1000.0, sr)
        wet += b * db_to_lin(gdb + trim)[None, :]
    ref, cur = active_rms(dry, sr), active_rms(wet, sr)
    if cur > EPS:
        wet *= ref / cur
    return ((1.0 - m) * dry + m * wet).astype(np.float32)


def dynamics(x: np.ndarray, sr: int, *, comp: dict | None = None, ott_params: dict | None = None) -> np.ndarray:
    a = as2d(x)
    if comp:
        a = compressor(a, sr, **comp)
    if ott_params:
        a = ott(a, sr, **ott_params)
    return a
