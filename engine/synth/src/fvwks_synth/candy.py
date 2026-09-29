"""Ear candy (docs/REMIX_SOUND_BIBLE.md §2.1, #13): LEVEL UP's video-game palette, in key, for builds and fills.
The TOP layer: band-limited pulse waves (polyBLEP), no samples. (2, n) float32, mono, peak -3 dBFS.

  render_candy(kind, midi, beats, bpm, sr=48000, variant=0, minor=True)
    arp      the key's triad (+ octave) at 1/16, pulse 25 %: variant 0 up, 1 down, 2 up-down, 3 up with the octave above
    powerup  a +24 st rise over the length, stepped a semitone at a time (the console way), pulse 50 %
    coin     two blips a 4th apart at 1/32 (the second rings), pulse 50 %; variant 1+ a 5th, an octave, two octaves
  `midi` is the key's root; candy plays three octaves above it.
"""

from __future__ import annotations

import numpy as np

from .foxsynth import _phase, _saw

KINDS = ("arp", "powerup", "coin")
UP = 36  # three octaves over the root: the top layer


def _pulse(hz: np.ndarray, width: float, sr: int) -> np.ndarray:
    ph, dt = _phase(hz, sr), hz / sr
    return _saw(ph, dt) - _saw((ph + width) % 1.0, dt)


def _gate(n: int, sr: int, on: int, off: int) -> np.ndarray:
    """A note's envelope: 2 ms in, held, 5 ms out at `off` (raised cosines: no clicks)."""
    env = np.zeros(n)
    a, r = int(0.002 * sr), int(0.005 * sr)
    off = min(off, n)
    if off - on < a + r:
        return env
    env[on:off] = 1.0
    env[on:on + a] = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, a))
    env[off - r:off] = 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, r))
    return env


def render_candy(kind: str, midi: float, beats: float, bpm: float, sr: int = 48_000, variant: int = 0,
                 minor: bool = True) -> np.ndarray:
    if kind not in KINDS:
        raise KeyError(f"unknown candy {kind!r} (one of {', '.join(KINDS)})")
    n = int(round(beats * 60.0 / bpm * sr))
    if n <= 0:
        return np.zeros((2, 0), np.float32)
    base = midi + UP
    step = 60.0 / bpm * sr
    notes = np.full(n, float(base))
    env = np.zeros(n)
    if kind == "arp":
        third = 3 if minor else 4
        seq = [[0, third, 7], [7, third, 0], [0, third, 7, 12, 7, third], [0, third, 7, 12]][variant % 4]
        width = 0.25
        for k in range(int(np.ceil(beats * 4))):  # 1/16s, gated to 70 %
            on = int(round(k * step / 4))
            notes[on:] = base + seq[k % len(seq)]
            env += _gate(n, sr, on, on + int(0.7 * step / 4))
    elif kind == "powerup":
        width = 0.5
        rise = np.floor(np.arange(n) / n * 25)  # 0..24 semitones, a step at a time
        notes = base + np.minimum(rise, 24)
        env = _gate(n, sr, 0, n)
    else:
        width = 0.5
        interval = (5, 7, 12, 24)[variant % 4]
        split = min(n, int(round(step / 8)))  # a 1/32
        notes[split:] = base + interval
        env = _gate(n, sr, 0, split) + _gate(n, sr, split, n) * np.exp(-np.maximum(np.arange(n) - split, 0) / (0.25 * sr))
    x = _pulse(440.0 * 2 ** ((notes - 69) / 12), width, sr) * env
    x *= 0.708 / (np.max(np.abs(x)) + 1e-12)
    return np.stack([x, x]).astype(np.float32)
