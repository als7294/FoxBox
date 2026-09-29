"""The trap hybrid's two mid voices (docs/REMIX_SOUND_BIBLE.md §2.3) as growl engines, (f, t, sr, bpm, v, f0, axes) ->
the MID layer, for growls.render_growl ("wobble", "dswub"). One note each, the LFO restarted on the note.

  wobble  the old-school half: a saw on the mid note (two voices, a few cents apart; the bible's octave down from the
          patch's note), phase-modulated by a sine an octave below it (FM 25 %, up to 40 % with the LFO); a 24 dB resonant low-pass swept 150 Hz -> 1.5 kHz by an
          LFO that rises slowly and falls fast (the same LFO drives the FM at half the depth); drive 11 dB before
          the filter; a gentle top at 4 kHz, -2 dB at 400 Hz. The variant is the LFO rate: 1/8, 1/16T, 1/4, 1/4T (the bible's per-note grid).
  dswub   the new-school half ("freeform wub / downsample"): the same core, its cutoff (250 Hz - 1.2 kHz), FM and a
          vowel formant driven by a hand-drawn 3-4 step shape at 1/2 (the variant picks the shape; cutoff 200 Hz -
          2 kHz), a second, small
          LFO at 1/8 or 1/8T on the cutoff; downsampled (zero-order hold, 6-11 kHz) before the drive; a light chorus.

AXES: the options the research gives as ranges (resonance, FM depth, the downsample rate, the second LFO), resolved
per take by BUILD and passed in as `axes` (riddim.option); unset, the likeliest.
"""

from __future__ import annotations

import numpy as np

from .foxsynth import _phase, _saw, sync_hz
from .midbus import _peak, distort
from .riddim import option

AXES: dict[str, dict[str, float]] = {
    "hybrid.wobble_res": {"0.3": 0.5, "0.45": 0.5},  # the ladder's resonance (the bible: 30-45 %)
    "hybrid.wobble_fm": {"0.25": 0.6, "0.4": 0.4},  # FM depth at rest (the bible: 25 %, cap 40 %)
    "hybrid.ds_rate_hz": {"6000": 0.4, "8000": 0.3, "11025": 0.3},  # the downsample (the bible: 6-11 kHz)
    "hybrid.ds_lfo2": {"1/8": 0.5, "1/8T": 0.5},  # the dswub's second LFO
}
WOBBLE_RATES = ("1/8", "1/16T", "1/4", "1/4T")
DS_SHAPES = ((1.0, 0.3, 0.7, 0.1), (0.2, 1.0, 0.5, 0.8), (1.0, 0.6, 0.2), (0.4, 0.9, 0.1, 0.6))  # hand-drawn steps
VOWEL = ((730, 1090), (570, 840))  # a -> o, F1/F2 (Hz)


def rise_fall(t: np.ndarray, div: str, bpm: float) -> np.ndarray:
    """The wobble's LFO from t = 0: rising slowly over 80 % of each cycle, falling fast over the last 20 %."""
    ph = (t * sync_hz(div, bpm)) % 1.0
    return np.where(ph < 0.8, (ph / 0.8) ** 1.5, 1 - (ph - 0.8) / 0.2)


def steps(t: np.ndarray, shape: tuple[float, ...], bpm: float, sr: int) -> np.ndarray:
    """A hand-drawn step shape over one 1/2-note cycle, its corners slewed over 6 ms (a step would click)."""
    ph = (t * sync_hz("1/2", bpm)) % 1.0
    y = np.asarray(shape)[np.minimum((ph * len(shape)).astype(int), len(shape) - 1)]
    k = max(1, int(0.006 * sr))
    return np.convolve(np.pad(y, (k, 0), mode="edge"), np.ones(k) / k, mode="valid")[: len(t)]


def _core(f: np.ndarray, t: np.ndarray, sr: int, lfo: np.ndarray, fm: float) -> np.ndarray:
    """A saw on the note (two voices, +-6 cents), phase-modulated by a sine an octave down; `lfo` adds FM. (The bible's
    saw an octave down is relative to the patch's own note; below ~40 Hz a saw's edges tick one by one.)"""
    index = 6.0 * np.minimum(fm + 0.3 * fm * lfo, 0.4)  # radians: 25 % ~ 1.5
    mod = np.sin(2 * np.pi * _phase(f / 2, sr))
    x = np.zeros(len(t))
    for cents in (-6.0, 6.0):
        fc = f * 2 ** (cents / 1200)
        ph = np.cumsum(fc / sr) + index * mod / (2 * np.pi)
        x += _saw(ph % 1.0, np.maximum(np.abs(np.gradient(ph)), 1e-6))
    return x / 2


def wobble(f: np.ndarray, t: np.ndarray, sr: int, bpm: float, v: int, f0: float, axes: dict[str, str] | None = None) -> np.ndarray:
    from .growls import _lowpass

    lfo = rise_fall(t, WOBBLE_RATES[v], bpm)
    x = _core(f, t, sr, lfo, float(option(axes, "hybrid.wobble_fm", AXES)))
    # The drive before the filter, then the bible's post EQ (-3 dB at 3-5 kHz as a gentle top, -2 dB at 400 Hz): driven
    # after it, each saw edge came back above the filter and ticked (HF bursts every period; 50 -> 4 on the QA).
    x = distort(x, 11.0, "tanh")
    q = 0.7 + 2.5 * float(option(axes, "hybrid.wobble_res", AXES))  # resonance 30-45 % -> Q 1.45-1.83
    fc = 150.0 * (1500.0 / 150.0) ** lfo
    x = _lowpass(_lowpass(x, fc, q, sr), fc, 0.7, sr)  # 24 dB: one resonant stage, one flat
    top = np.full(len(t), 4000.0)
    return _peak(_lowpass(_lowpass(x, top, 0.6, sr), top, 0.6, sr), sr, 400.0, -2.0, 1.0)


def dswub(f: np.ndarray, t: np.ndarray, sr: int, bpm: float, v: int, f0: float, axes: dict[str, str] | None = None) -> np.ndarray:
    from .growls import _bandpass, _lowpass

    shape = steps(t, DS_SHAPES[v], bpm, sr)
    wiggle = 0.5 - 0.5 * np.cos(2 * np.pi * sync_hz(option(axes, "hybrid.ds_lfo2", AXES), bpm) * t)
    x = _core(f, t, sr, shape, 0.3)
    fc = 200.0 * (2000.0 / 200.0) ** np.clip(shape + 0.12 * (wiggle - 0.5), 0, 1)  # the bible's 250 Hz-1.2 kHz, widened:
    # with the saw on the mid note (not an octave down) that range moved too few harmonics to read as a wub
    x = _lowpass(_lowpass(x, fc, 1.4, sr), fc, 0.7, sr)
    formant = sum(_bandpass(x, np.full(len(t), a) + (b - a) * shape, 6.0, sr) for a, b in zip(*VOWEL))
    x = x + 0.5 * formant
    hold = max(1, int(round(sr / float(option(axes, "hybrid.ds_rate_hz", AXES)))))  # zero-order hold
    x = np.repeat(x[::hold], hold)[: len(t)]
    x = distort(x, 10.0, "tanh")
    d = (0.012 + 0.004 * np.sin(2 * np.pi * 0.7 * t)) * sr  # a light chorus: 12 +-4 ms, 20 %
    return 0.8 * x + 0.2 * np.interp(np.arange(len(t)) - d, np.arange(len(t)), x, left=0.0)
