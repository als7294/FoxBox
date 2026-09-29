"""1.6 REMIX: designed growls, for tracks whose bass holds none (an 808 / sub-only drop). Printed as one-shots, then
resampled like a producer would (resample.sequence and its chain). DSP only.

A patch: a detuned saw + square stack an octave over the sub, FM'd (its index falling over the hit), a sine
wavefolder, a 3-formant vowel filter sweeping a vowel path (the "yoi" talking bass: i -> o -> i), optional feedback
comb filters (tearout's metal), then drive. design_shots prints a palette: every vowel path and FM depth of the patch
over the drop's root, so the grid's calls and responses differ.
"""

from __future__ import annotations

import numpy as np
from scipy import signal

from ..dsp import EPS
from .resample import OneShot

VOWELS = {  # F1, F2, F3 (Hz), a male voice
    "i": (270, 2290, 3010), "e": (530, 1840, 2480), "a": (730, 1090, 2440), "o": (450, 800, 2830), "u": (300, 870, 2240),
}
PATCHES = {
    # a riddim growl: a thick FM'd stack, talking through i-o-i ("yoi"), i-a ("yah"), u-a ("wah")
    "riddim": dict(detune=0.10, fm_ratio=1.0, fm_index=(5.0, 1.2), fold=2.2, q=9.0, dry=0.12, drive=3.0, top=6000,
                   vowels=(("i", "o", "i"), ("i", "a"), ("u", "a"), ("o", "i")), comb=()),
    # tearout: inharmonic FM, a harder fold and two metallic combs, darker-to-brighter tearing vowels
    "tearout": dict(detune=0.16, fm_ratio=1.41, fm_index=(9.0, 3.0), fold=3.8, q=7.0, dry=0.2, drive=5.0, top=9000,
                    vowels=(("u", "a", "e"), ("a", "i"), ("o", "e", "a")), comb=((0.0021, 0.82), (0.0013, 0.7))),
    # a VIP growl: smoother, closer to the original line
    "growl": dict(detune=0.07, fm_ratio=2.0, fm_index=(3.0, 1.0), fold=1.6, q=10.0, dry=0.15, drive=2.0, top=5000,
                  vowels=(("u", "o"), ("o", "a"), ("a", "o")), comb=()),
}
BLOCK = 64


def _formant(x: np.ndarray, sr: int, path: tuple[str, ...], q: float) -> np.ndarray:
    """Three band-passes at the path's formants, swept across the hit (64-sample blocks), summed 1 / 0.7 / 0.45."""
    n = x.size
    keys = np.array([VOWELS[v] for v in path], float)  # (k, 3)
    pos = np.linspace(0, len(path) - 1, max(2, n // BLOCK + 1))
    acc = np.zeros(n)
    for j, gain in enumerate((1.0, 0.7, 0.45)):
        fr = np.interp(pos, np.arange(len(path)), keys[:, j])
        zi = np.zeros(2)
        for bi, i in enumerate(range(0, n, BLOCK)):
            b, a = signal.iirpeak(min(fr[bi], 0.45 * sr), q, fs=sr)
            y, zi = signal.lfilter(b, a, x[i : i + BLOCK], zi=zi)
            acc[i : i + BLOCK] += gain * y
    return acc


def one_shot(patch: str, midi: float, seconds: float, sr: int, path: tuple[str, ...], fm_scale: float = 1.0) -> np.ndarray:
    """One printed growl hit: (2, n) float32."""
    p = PATCHES[patch]
    n = int(seconds * sr)
    t = np.arange(n) / sr
    f0 = 440 * 2 ** ((midi - 69) / 12)
    idx = fm_scale * (p["fm_index"][1] + (p["fm_index"][0] - p["fm_index"][1]) * np.exp(-t / max(seconds * 0.4, 1e-3)))
    mod = idx * np.sin(2 * np.pi * f0 * p["fm_ratio"] * t)
    voices = []
    for k, det in enumerate((-p["detune"], 0.0, p["detune"])):
        ph = f0 * 2 ** (det / 12) * t + mod / (2 * np.pi)
        saw = 2 * (ph % 1.0) - 1
        sq = np.sign(np.sin(2 * np.pi * ph + k))
        voices.append(0.6 * saw + 0.4 * sq)
    x = np.mean(voices, axis=0)
    x = np.sin(p["fold"] * x)  # the wavefolder
    y = p["dry"] * x + (1 - p["dry"]) * _formant(x, sr, path, p["q"])
    for delay, fb in p["comb"]:  # tearout's metal: feedback combs
        d = max(1, int(delay * sr))
        y = signal.lfilter([1.0], np.r_[1.0, np.zeros(d - 1), -fb], y) * (1 - fb)
    y = np.tanh(p["drive"] * y / max(float(np.abs(y).max()), EPS))
    y = signal.sosfilt(signal.butter(2, p["top"], "low", fs=sr, output="sos"), y)  # the fizz off the top
    env = np.minimum(1.0, t / 0.003) * np.minimum(1.0, (seconds - t) / 0.02)
    y = (y * env).astype(np.float32)
    # a touch of width: the right channel a hair later
    r = np.r_[np.zeros(int(0.0004 * sr), np.float32), y[: n - int(0.0004 * sr)]]
    return np.stack([y, r])


BANK = {"riddim": "riddim", "tearout": "tearout", "growl": "yoi"}  # this module's patch -> S3's growl bank style


def design_shots(patch: str, root_pc: int, bpm: float, sr: int, octave: int = 2) -> list[OneShot]:
    """The patch's palette over the root (MIDI octave `octave`, above the sub), one beat each (the grid cuts them
    shorter): S3's growl bank (fvwks_synth.growls, every variant) when it's installed, else this module's own
    synthesis (every vowel path at two FM depths)."""
    midi = 12 * (octave + 1) + root_pc
    secs = 60.0 / bpm
    try:
        from fvwks_synth.growls import VARIANTS, render_growl
    except ImportError:
        render_growl = None
    if render_growl is not None:
        ys = [render_growl(BANK[patch], midi, 1.0, bpm, sr=sr, variant=v) for v in range(int(VARIANTS))]
    else:
        ys = [one_shot(patch, midi, secs, sr, path, fm) for path in PATCHES[patch]["vowels"] for fm in (1.0, 1.6)]
    shots = []
    for y in ys:
        m = y.mean(axis=0)
        spec = np.abs(np.fft.rfft(m))
        f = np.fft.rfftfreq(m.size, 1 / sr)
        shots.append(OneShot(np.asarray(y, np.float32), float(midi), secs, float((spec * f).sum() / max(spec.sum(), EPS)),
                             float(np.sqrt((m**2).mean()))))
    return shots


def has_growls(bass: np.ndarray, sr: int, start_s: float, seconds: float, min_db: float = -18.0) -> bool:
    """Does the bass hold growls to resample: its 100-600 Hz energy within `min_db` of its < 80 Hz sub?"""
    x = np.asarray(bass, np.float64)
    x = x.mean(axis=0) if x.ndim > 1 else x
    x = x[int(start_s * sr) : int((start_s + seconds) * sr)]
    if x.size < sr // 10:
        return False
    rms = lambda sos: np.sqrt((signal.sosfilt(sos, x) ** 2).mean()) + 1e-12
    sub = rms(signal.butter(4, 80, "low", fs=sr, output="sos"))
    mid = rms(signal.butter(4, (100, 600), "band", fs=sr, output="sos"))
    return 20 * np.log10(mid / sub) >= min_db


WUB_DIV = {"1/4": 1.0, "1/4T": 2 / 3, "1/8": 0.5, "1/8T": 1 / 3}  # an LFO cycle, in beats


def wub(midi: float, beats: float, bpm: float, sr: int, div: str, open_oct: float = 3.0, base_hz: float = 180.0,
        variant: int = 0) -> np.ndarray:
    """A riddim wub (the placeholder until S3's riddim engine): a square carrier (a touch of FM for grit) through a
    low-pass that an LFO sweeps from `base_hz` up `open_oct` octaves at `div` (retriggered open at the note's start; a
    rounded square; a morph across three fixed low-passes, so nothing ticks), then drive. (2, n) float32."""
    n = int(round(beats * 60.0 / bpm * sr))
    t = np.arange(n) / sr
    f0 = 440 * 2 ** ((midi - 69) / 12)
    ph = f0 * t + (0.8 + 0.4 * variant) / (2 * np.pi) * np.sin(2 * np.pi * f0 * 2 * t)
    car = np.tanh(6 * np.sin(2 * np.pi * ph))  # a square with soft corners
    rate = 1.0 / (WUB_DIV[div] * 60.0 / bpm)
    lfo = 0.5 + 0.5 * np.tanh(2.2 * np.cos(2 * np.pi * rate * t))  # starts open, rounded edges
    # the sweep as a morph across three fixed low-passes (closed, half, open): switching a running filter's
    # coefficients is discontinuous (it ticks), crossfading fixed ones isn't
    stops = [signal.sosfilt(signal.butter(2, min(base_hz * 2 ** (open_oct * q), 0.45 * sr), fs=sr, output="sos"), car)
             for q in (0.0, 0.5, 1.0)]
    pos = 2.0 * lfo  # 0..2 across the three
    w1 = np.clip(1.0 - np.abs(pos - 1.0), 0.0, 1.0)
    w0, w2 = np.clip(1.0 - pos, 0.0, 1.0), np.clip(pos - 1.0, 0.0, 1.0)
    y = w0 * stops[0] + w1 * stops[1] + w2 * stops[2]
    y = np.tanh(2.5 * y / max(float(np.abs(y).max()), EPS)) * (0.75 + 0.25 * lfo)
    y = signal.sosfilt(signal.butter(2, 3500, fs=sr, output="sos"), y)  # the drive's fizz off (a wub lives below it)
    env = np.minimum(1.0, t / 0.003) * np.minimum(1.0, (n / sr - t) / 0.01)
    y = (y * env).astype(np.float32)
    return np.stack([y, y])
