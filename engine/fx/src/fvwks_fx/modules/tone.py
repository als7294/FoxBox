"""TONE: ladder high-/low-pass (24 dB/oct, optional resonance), low/high shelf and a mid peak/scoop."""

from __future__ import annotations

import numpy as np
import pedalboard

from ..dsp import as2d

_LADDER = pedalboard.LadderFilter.Mode


def tone(
    x: np.ndarray,
    sr: int,
    *,
    hpf_hz: float | None = None,
    lpf_hz: float | None = None,
    resonance: float = 0.0,
    low_shelf_hz: float = 250.0,
    low_shelf_db: float = 0.0,
    peak_hz: float = 1000.0,
    peak_db: float = 0.0,
    peak_q: float = 1.0,
    high_shelf_hz: float = 6000.0,
    high_shelf_db: float = 0.0,
) -> np.ndarray:
    a = as2d(x)
    board = []
    nyq = sr / 2.0
    res = float(np.clip(resonance, 0.0, 0.95))
    if hpf_hz and hpf_hz > 10:
        board.append(pedalboard.LadderFilter(mode=_LADDER.HPF24, cutoff_hz=float(min(hpf_hz, nyq * 0.9)), resonance=res, drive=1.0))
    if low_shelf_db:
        board.append(pedalboard.LowShelfFilter(cutoff_frequency_hz=float(low_shelf_hz), gain_db=float(low_shelf_db), q=0.707))
    if peak_db:
        board.append(pedalboard.PeakFilter(cutoff_frequency_hz=float(peak_hz), gain_db=float(peak_db), q=float(max(peak_q, 0.1))))
    if high_shelf_db:
        board.append(pedalboard.HighShelfFilter(cutoff_frequency_hz=float(high_shelf_hz), gain_db=float(high_shelf_db), q=0.707))
    if lpf_hz and lpf_hz < nyq * 0.95:
        board.append(pedalboard.LadderFilter(mode=_LADDER.LPF24, cutoff_hz=float(lpf_hz), resonance=res, drive=1.0))
    if not board:
        return a
    return as2d(pedalboard.Pedalboard(board)(a, sr))
