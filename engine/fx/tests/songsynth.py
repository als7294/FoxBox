"""Synthetic songs for the v0.7 song tests: a kick on every beat (accented on bar 1 with a bass note), off-beat
hats, and one sustained chord per bar, so tempo, bar phase and key are all known exactly."""

from __future__ import annotations

import numpy as np

SR = 44100
PROGRESSIONS = {  # one chord per bar, as MIDI notes
    "Am": [(57, 60, 64), (62, 65, 69), (64, 68, 71), (57, 60, 64)],  # Am Dm E Am
    "C": [(60, 64, 67), (65, 69, 72), (67, 71, 74), (60, 64, 67)],  # C F G C
}


def _hz(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def _kick(gain: float) -> np.ndarray:
    t = np.arange(int(0.18 * SR)) / SR
    f = 48.0 + 110.0 * np.exp(-t / 0.018)
    return gain * np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.07)


def _hat(rng: np.random.Generator, gain: float) -> np.ndarray:
    n = int(0.04 * SR)
    return gain * np.diff(rng.standard_normal(n + 1)) * np.exp(-np.arange(n) / (0.008 * SR))


def _tone(midi: float, n: int, gain: float, harmonics: int = 3) -> np.ndarray:
    t = np.arange(n) / SR
    y = sum(np.sin(2 * np.pi * _hz(midi) * h * t) / h**1.5 for h in range(1, harmonics + 1))
    env = np.minimum(1.0, np.minimum(t / 0.02, (n / SR - t) / 0.05))
    return gain * y * env


def _add(x: np.ndarray, y: np.ndarray, at_s: float) -> None:
    i = int(round(at_s * SR))
    if i >= x.size:
        return
    j = min(x.size, i + y.size)
    x[i:j] += y[: j - i]


def song(bpm: float, downbeat_s: float, seconds: float = 40.0, key: str = "Am", pickup: bool = True,
         seed: int = 0) -> np.ndarray:
    """(2, n) float32. Bar 1 beat 1 at ``downbeat_s``; with ``pickup`` the music starts one beat earlier."""
    rng = np.random.default_rng(seed)
    beat = 60.0 / bpm
    x = np.zeros(int(seconds * SR))
    prog = PROGRESSIONS[key]
    i = -1 if pickup else 0
    while True:
        t = downbeat_s + i * beat
        if t >= seconds:
            break
        down = i % 4 == 0
        _add(x, _kick(0.9 if down else 0.45), t)
        _add(x, _hat(rng, 0.12), t + beat / 2)
        if down and i >= 0:
            chord = prog[(i // 4) % len(prog)]
            n = int(4 * beat * SR)
            for m in chord:
                _add(x, _tone(m, n, 0.06), t)
            _add(x, _tone(chord[0] - 24, int(beat * SR), 0.25, 2), t)
        i += 1
    x /= max(1e-9, float(np.max(np.abs(x))))
    x *= 0.9
    return np.stack([x, 0.97 * x]).astype(np.float32)
