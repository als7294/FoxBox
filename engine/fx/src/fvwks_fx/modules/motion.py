"""MOTION: phaser and chorus (pedalboard), run per channel with offset LFO rates for stereo movement."""

from __future__ import annotations

import numpy as np
import pedalboard

from ..dsp import as2d, to_stereo


def motion(
    x: np.ndarray,
    sr: int,
    *,
    phaser_mix: float = 0.0,
    phaser_rate_hz: float = 0.4,
    phaser_depth: float = 0.6,
    phaser_center_hz: float = 1000.0,
    phaser_feedback: float = 0.4,
    chorus_mix: float = 0.0,
    chorus_rate_hz: float = 0.8,
    chorus_depth: float = 0.25,
    chorus_delay_ms: float = 7.0,
    chorus_feedback: float = 0.0,
) -> np.ndarray:
    a = as2d(x)
    if phaser_mix <= 0 and chorus_mix <= 0:
        return a
    s = to_stereo(a)
    out = np.empty_like(s)
    for ch, spread in ((0, 1.0), (1, 1.13)):  # slightly different LFO rates -> L/R decorrelate
        y = s[ch : ch + 1]
        if phaser_mix > 0:
            y = pedalboard.Phaser(rate_hz=float(phaser_rate_hz * spread), depth=float(phaser_depth),
                                  centre_frequency_hz=float(phaser_center_hz), feedback=float(np.clip(phaser_feedback, -0.95, 0.95)),
                                  mix=float(np.clip(phaser_mix, 0.0, 1.0)))(y, sr)
        if chorus_mix > 0:
            y = pedalboard.Chorus(rate_hz=float(chorus_rate_hz * spread), depth=float(chorus_depth),
                                  centre_delay_ms=float(chorus_delay_ms), feedback=float(np.clip(chorus_feedback, -0.95, 0.95)),
                                  mix=float(np.clip(chorus_mix, 0.0, 1.0)))(y, sr)
        out[ch] = y[0]
    return out
