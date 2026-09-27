"""DRIVE: tanh / tube / fold / hard clip waveshapers, oversampled, level-matched, parallel mix."""

from __future__ import annotations

from typing import Iterable

import numpy as np
from scipy import signal

from ..dsp import EPS, active_rms, as2d, db_to_lin, lowpass
from . import airwin as AW

CURVES = ("tanh", "tube", "fold", "hardclip", "softclip")


def shape(x: np.ndarray, curve: str, gain: float, bias: float = 0.2) -> np.ndarray:
    """Memoryless waveshaper. ``gain`` is linear pre-gain."""
    g = x * gain
    if curve == "tanh":
        return np.tanh(g)
    if curve == "tube":
        # asymmetric: even harmonics like a single-ended stage; DC removed afterwards
        return np.tanh(g + bias) - np.tanh(bias)
    if curve == "fold":
        return np.sin(0.5 * np.pi * g)
    if curve == "hardclip":
        return np.clip(g, -1.0, 1.0)
    if curve == "softclip":
        c = np.clip(g, -1.5, 1.5)
        return c - (4.0 / 27.0) * c**3
    raise ValueError(f"unknown drive curve {curve!r}")


def _curves(mode: str | Iterable[str]) -> list[str]:
    if isinstance(mode, str):
        parts = [p.strip().lower() for p in mode.replace("->", ">").replace("→", ">").split(">")]
    else:
        parts = [str(p).lower() for p in mode]
    alias = {"hard": "hardclip", "clip": "hardclip", "hard_clip": "hardclip", "soft": "softclip", "wavefold": "fold"}
    return [alias.get(p, p) for p in parts if p]


def drive(
    x: np.ndarray,
    sr: int,
    *,
    mode: str | Iterable[str] = "tanh",
    drive_db: float = 12.0,
    mix: float = 1.0,
    bias: float = 0.2,
    oversample: int = 4,
    tone_hz: float | None = None,
    color: str = "off",
    color_drive: float = 0.5,
    seed: int = 0,
) -> np.ndarray:
    """Optional Airwindows COLOR (tape / tube, in series, level-matched), then waveshape the signal (series curves,
    e.g. "tube>hardclip") at ``oversample``x and blend.

    The wet path is level-matched to the dry path so ``mix`` changes colour, not loudness.
    """
    a = as2d(x)
    # normalise so the drive knobs act on a consistent level regardless of upstream gain
    ref = active_rms(a, sr)
    pre = 0.25 / ref if ref > EPS else 1.0
    if color in ("tape", "tube") and AW.AVAILABLE:
        a = (AW.color(a * np.float32(pre), sr, color, color_drive, seed) / np.float32(pre)).astype(np.float32)
    m = float(np.clip(mix, 0.0, 1.0))
    if m <= 0:
        return a
    curves = _curves(mode)
    os = max(1, int(oversample))
    up = signal.resample_poly(a.astype(np.float64) * pre, os, 1, axis=-1) if os > 1 else a.astype(np.float64) * pre
    g = db_to_lin(drive_db)
    for c in curves:
        up = shape(up, c, g, bias)
        g = 1.0  # only the first stage gets the drive gain; later stages shape the result
    wet = signal.resample_poly(up, 1, os, axis=-1)[:, : a.shape[1]] if os > 1 else up
    # DC block (tube / asymmetric curves)
    wet = signal.lfilter([1.0, -1.0], [1.0, -0.9995], wet, axis=-1)
    if tone_hz:
        wet = lowpass(wet, sr, tone_hz, order=2)
    cur = active_rms(wet, sr)
    if cur > EPS:
        wet = wet * (ref / cur)
    return ((1.0 - m) * a + m * wet).astype(np.float32)
