"""The REMIX kit's drum voices (docs/REMIX_SOUND_BIBLE.md §3.1), synthesized: numpy/scipy, click-free, (2, n) float32.
S2 sequences them, buses them and matches their loudness; levels here are the table's peaks relative to the kick.

  render_drum(voice, sr=48000, vel=1.0, seed=0, variant=0, root_hz=None, length_s=None) -> (2, n)

  kick          a sine body 150 Hz -> 52 Hz (tau 25 ms; ends on `root_hz` when that's 45-60 Hz), 220 ms decay, gone by
                300 ms, HP 30 Hz; a noise click (HP 2 kHz, 8-15 ms, -8 dB) and a +4 dB transient; lightly soft-clipped
  kick_riddim   the same, low-passed at 4 kHz (dull)
  kick_tearout  the same, the transient kept and nothing squashed
  snare         the stack: L1 body (noise + a 185 Hz tone, 150 ms, HP 120), L2 crack (noise, BP 1-5 kHz, 15 ms),
                L3 clap (3 bursts 10 ms apart, BP 1.2 kHz, HP 500, its own short room), L4 tail (noise HP 2 kHz,
                -12 dB). Variants: 0 tail A (180 ms), 1 tail B (300 ms), 2 tail A +2 st, 3 Tape B/UK (the clap
                -8 dB under the snare, -1 st). Alternate 0 and 1 hit by hit.
  snare_pan     tearout's metallic "pan" snare: the stack with a struck-plate layer (inharmonic modes) at 25 %
  clap          L3 alone (with its room)
  hat           closed: 808-style metal (six square partials) + noise, HP 7 kHz, 60 / 80 / 100 / 70 ms by variant
  open_hat      the same, 300-450 ms
  impact        the drop's boom: a sine at 40 + 60 exp(-t / 0.06) Hz, 0.35 s, about -10 dBFS
  crash         noise and inharmonic partials, HP 400 Hz, a ~2 s decay, wide (two noise seeds)
  reverse_cymbal the crash reversed, `length_s` long (1.5 s by default), swelling to its last sample: place it so
                that sample lands on the downbeat

`seed` gives each hit its own tiny pitch (+-15 cents) and decay (+-6 %) jitter and its own noise: repeats aren't
machine-identical, and the same seed is the same hit. `vel` 0-1 scales the level (a ghost kick is about 0.35).
"""

from __future__ import annotations

import zlib

import numpy as np
from scipy import signal

VOICES = ("kick", "kick_riddim", "kick_tearout", "snare", "snare_pan", "clap", "hat", "open_hat", "impact", "crash",
          "reverse_cymbal")
KICK_PEAK = 10 ** (-1 / 20)
#            peak dB relative to the kick (§3.1)
LEVEL_DB = {"kick": 0.0, "kick_riddim": 0.0, "kick_tearout": 0.0, "snare": -0.7, "snare_pan": -0.7, "clap": -1.5,
            "hat": -6.8, "open_hat": -10.3, "impact": -9.0, "crash": -8.0, "reverse_cymbal": -10.0}
HAT_808 = (205.3, 304.4, 369.6, 522.7, 540.0, 800.0)  # the 808's six hat oscillators (Hz)
PLATE = (1.0, 1.59, 2.14, 2.30, 2.65, 2.92, 3.16)  # a struck plate's first modes, relative


def _sos(kind: str, hz, sr: int, order: int = 2):
    return signal.butter(order, hz, kind, fs=sr, output="sos")


def _f(x: np.ndarray, kind: str, hz, sr: int, order: int = 2) -> np.ndarray:
    return signal.sosfilt(_sos(kind, hz, sr, order), x, axis=-1)


def _t(s: float, sr: int) -> np.ndarray:
    return np.arange(int(round(s * sr))) / sr


def _in(x: np.ndarray, sr: int, ms: float = 0.5) -> np.ndarray:
    """A raised-cosine start (noise can't start mid-swing)."""
    k = max(2, int(ms / 1000 * sr))
    x[..., :k] *= 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, k))
    return x


def _out(x: np.ndarray, sr: int, ms: float = 5.0) -> np.ndarray:
    k = min(x.shape[-1] // 2, max(2, int(ms / 1000 * sr)))
    x[..., -k:] *= 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, k))
    return x


def _kick(sr: int, rng: np.random.Generator, pitch: float, decay: float, root_hz: float | None, style: str) -> np.ndarray:
    t = _t(0.3, sr)
    end = root_hz if root_hz is not None and 45 <= root_hz <= 60 else 52.0
    hz = (end + (150.0 - end) * np.exp(-t / 0.025)) * pitch
    body = np.sin(2 * np.pi * np.cumsum(hz) / sr)  # from phase 0: no step
    env = np.exp(-t / (0.09 * decay))
    fade = np.clip((0.3 - t) / 0.08, 0, 1)  # 220 ms, then gone by 300 ms
    body *= env * (0.5 - 0.5 * np.cos(np.pi * fade))
    body = _f(body, "highpass", 30, sr)
    n_click = int((0.008 + 0.007 * rng.random()) * sr)  # 8-15 ms
    click = np.zeros(len(t))
    click[:n_click] = _f(rng.standard_normal(n_click), "highpass", 2000, sr) * np.exp(-np.arange(n_click) / (0.003 * sr))
    x = body + 10 ** (-8 / 20) * _in(_out(click, sr, 2.0), sr, 0.3) * np.max(np.abs(body)) / (np.max(np.abs(click)) + 1e-12)
    x *= 1 + (10 ** (4 / 20) - 1) * np.exp(-t / 0.010)  # the transient, +4 dB over ~10 ms
    if style == "riddim":
        x = _f(x, "lowpass", 4000, sr)
    if style != "tearout":
        x = np.tanh(1.4 * x / np.max(np.abs(x))) / np.tanh(1.4)  # a light squash (tearout keeps it all)
    return _in(x, sr, 0.3)


def _room(x: np.ndarray, sr: int, rng: np.random.Generator, wet: float = 0.35, rt60: float = 0.9) -> np.ndarray:
    """The clap's own short room: decaying noise impulse responses (two: it's wide), 15 ms pre-delay, wet HP 600 Hz and
    LP 12 kHz. Returns (2, n + tail)."""
    t = _t(rt60, sr)
    irs = [np.concatenate([np.zeros(int(0.015 * sr)), rng.standard_normal(len(t)) * np.exp(-t * 6.9 / rt60)]) for _ in "LR"]
    wets = [signal.fftconvolve(x, ir) for ir in irs]
    wets = [_f(_f(w, "highpass", 600, sr), "lowpass", 12000, sr) for w in wets]
    peak = max(np.max(np.abs(w)) for w in wets) + 1e-12
    dry = np.concatenate([x, np.zeros(len(wets[0]) - len(x))])
    return np.stack([dry + wet * w / peak * np.max(np.abs(x)) for w in wets])


def _clap(sr: int, rng: np.random.Generator, decay: float, tune: float) -> np.ndarray:
    t = _t(0.2, sr)
    x = np.zeros(len(t))
    for k, d in enumerate((0.004, 0.004, 0.004, 0.05 * decay)):  # three bursts 10 ms apart, then the body
        a = int(k * 0.010 * sr)
        seg = rng.standard_normal(len(t) - a) * np.exp(-np.arange(len(t) - a) / (d * sr))
        x[a:] += _in(seg, sr, 0.3)
    x = _f(_f(x, "bandpass", (1200 * tune / 1.6, 1200 * tune * 1.6), sr), "highpass", 500, sr)
    return _room(_out(x / np.max(np.abs(x)), sr), sr, rng)


def _snare(sr: int, rng: np.random.Generator, pitch: float, decay: float, variant: int, plate: float = 0.0) -> np.ndarray:
    tune = pitch * (2 ** (-1 / 12) if variant == 3 else 1.0)
    t = _t(0.35, sr)
    tone = np.sin(2 * np.pi * np.cumsum(185 * tune * (1 + 0.15 * np.exp(-t / 0.01))) / sr)
    body = (0.6 * tone + 0.5 * _f(rng.standard_normal(len(t)), "bandpass", (180, 6000), sr)) * np.exp(-t / (0.05 * decay))
    body = _f(body, "highpass", 120, sr)
    crack = _f(rng.standard_normal(len(t)), "bandpass", (1000, 5000), sr) * np.exp(-t / 0.005) * 1.8  # +5 dB, ~15 ms
    tail_s = 0.3 if variant == 1 else 0.18
    tail_hz = 2000 * (2 ** (2 / 12) if variant == 2 else 1.0)
    tail = _f(rng.standard_normal(len(t)), "highpass", tail_hz, sr) * np.exp(-t / (tail_s / 3 * decay))
    norm = lambda y: y / (np.max(np.abs(y)) + 1e-12)
    snare = 10 ** (-3 / 20) * norm(body) + 10 ** (-4 / 20) * norm(crack) + 10 ** (-12 / 20) * norm(tail)
    if plate:
        modes = sum(np.sin(2 * np.pi * 540 * pitch * m * t) * np.exp(-t / (0.12 / m)) for m in PLATE)
        ring = _f(rng.standard_normal(len(t)), "bandpass", (1500, 6000), sr) * np.sin(2 * np.pi * 1730 * t) * np.exp(-t / 0.05)
        snare = snare + plate * norm(norm(modes) + 0.5 * norm(ring))
    snare = _in(_out(snare, sr, 20.0), sr, 0.3)
    clap = _clap(sr, rng, decay, tune) * (10 ** (-8 / 20) if variant == 3 else 1.0)
    n = clap.shape[1]
    stack = clap.copy()
    stack[:, : len(snare)] += snare
    return stack[:, :n]


def _hat(sr: int, rng: np.random.Generator, pitch: float, length: float) -> np.ndarray:
    t = _t(length * 1.3, sr)
    metal = sum(np.sign(np.sin(2 * np.pi * f * pitch * t + rng.random() * 6.28)) for f in HAT_808)
    x = 0.6 * _f(metal, "bandpass", (7000, 12000), sr, 1) + 0.4 * rng.standard_normal(len(t))
    x = _f(x, "highpass", 7000, sr) * np.exp(-t / (length / 4))
    return _in(_out(x, sr, 5.0), sr, 0.3)


def _cymbal(sr: int, rng: np.random.Generator, pitch: float, decay: float, length: float) -> np.ndarray:
    t = _t(length, sr)
    out = []
    for _ in "LR":  # two noise seeds: wide
        partials = sum(np.sin(2 * np.pi * f * pitch * t + rng.random() * 6.28) for f in rng.uniform(3000, 11000, 24))
        x = 0.7 * rng.standard_normal(len(t)) + 0.3 * partials / 5
        x = _f(_f(x, "highpass", 400, sr), "lowpass", 14000, sr) * np.exp(-t / (0.45 * decay))
        out.append(x)
    return np.stack(out)


def render_drum(voice: str, sr: int = 48_000, vel: float = 1.0, seed: int = 0, variant: int = 0,
                root_hz: float | None = None, length_s: float | None = None) -> np.ndarray:
    if voice not in VOICES:
        raise KeyError(f"unknown drum voice {voice!r} (one of {', '.join(VOICES)})")
    rng = np.random.default_rng([seed, zlib.crc32(voice.encode()), variant])
    pitch = 2 ** (rng.uniform(-15, 15) / 1200)  # +-15 cents
    decay = 1 + rng.uniform(-0.06, 0.06)  # +-6 %
    v = variant % 4
    if voice.startswith("kick"):
        x = _kick(sr, rng, pitch, decay, root_hz, voice.removeprefix("kick_") if "_" in voice else "")
    elif voice in ("snare", "snare_pan"):
        x = _snare(sr, rng, pitch, decay, v, plate=0.25 if voice == "snare_pan" else 0.0)
    elif voice == "clap":
        x = _clap(sr, rng, decay, pitch)
    elif voice == "hat":
        x = _hat(sr, rng, pitch, (0.06, 0.08, 0.1, 0.07)[v] * decay)
    elif voice == "open_hat":
        x = _hat(sr, rng, pitch, (0.3, 0.38, 0.45, 0.34)[v] * decay)
    elif voice == "impact":
        t = _t(0.5, sr)
        x = np.sin(2 * np.pi * np.cumsum((40 + 60 * np.exp(-t / 0.06)) * pitch) / sr) * np.exp(-t / (0.12 * decay))
        x = _in(_out(x, sr, 60.0), sr, 0.3)
    elif voice == "crash":
        x = _in(_out(_cymbal(sr, rng, pitch, decay, 2.5), sr, 200.0), sr, 0.3)
    else:  # reverse_cymbal: swells to its last sample (a 3 ms fade there, so the downbeat takes over without a step)
        x = _cymbal(sr, rng, pitch, decay, length_s or 1.5)[:, ::-1].copy()
        x = _out(_in(x, sr, 50.0), sr, 3.0)
    x = np.atleast_2d(x)
    if x.shape[0] == 1:
        x = np.repeat(x, 2, axis=0)
    x *= KICK_PEAK * 10 ** (LEVEL_DB[voice] / 20) * float(np.clip(vel, 0, 1)) / (np.max(np.abs(x)) + 1e-12)
    return x.astype(np.float32)
