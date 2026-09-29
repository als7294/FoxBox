"""The FoxBox growl bank (1.6 REMIX): designed bass one-shots built in code, one small engine per character, numpy/scipy
only (no presets, no generative AI). S2 chops and sequences them.

  render_growl(style, midi, beats, bpm, sr=48000, variant=0, sub=True) -> (2, n) float32, n = `beats` at `bpm` exactly.

Built like producers build them: three layers, each processed on its own.
  SUB   a pure mono sine at 30-60 Hz (the root, dropped an octave at a time), LR4 low-passed at 115 Hz; it never goes
        through a filter sweep, FM or distortion (that's where the mud comes from). sub=False leaves it out.
  MID   the character engine below, LR4 high-passed at 120 Hz. Every engine is a resample chain: render → distort or fold
        (4x oversampled: no aliasing fizz) → OTT (3-band upward + downward, 88 Hz / 2.5 kHz) → a different process →
        OTT again. One per-note LFO (retriggered at the note, a tempo-synced rate per variant) drives the FM depth, the
        fold and the formants together, so every note moves.
  GRIT  the mid folded hard (oversampled), above 2.5 kHz, low in the mix and widened (mid/side: the mono sum is
        untouched).

  tearout  a "sine comp chomp" (sine an octave or two over the root with self-feedback) and an FM growl (modulator an
           octave BELOW the carrier, depth swept 15 → 40 % by the LFO) → fold → OTT → formant sweep + comb at the note →
           OTT, with a pitch dive on the tail
  riddim   a 50 % square an octave under the mid register, sine-FM 15 → 40 % by the LFO → two formant band-passes swept
           by the same LFO (not a high-Q low-pass) → drive → OTT, gated by the LFO with rounded edges: a riddim wub
  yoi      the ratio-0.5 FM growl through three vowel formants morphing a → o → i → drive → OTT
  808      S1's render_808 (bass808), and darkhit its long dark first hit: finished renders, no growl post
  reese    7 detuned saws (a hollow square stack, or an octave on top, by variant) → saturation → OTT → moving low-pass
  metal    FM, frequency-shifted (inharmonic) and ring-modulated → fold → OTT: a metallic growl
  gunshot  the drop's first hit: a bright stab with a pitch-drop transient and a noise crack, folded, a beat long

Tearout's percussive voices (M1.2, fingerprints §2 B) and printed banks (M1.3, chain A):
  gun / mgun   an 80-200 ms metallic FM shot then silence / that burst retriggered every 1/32, stepping ±1-2 st
  hero / call  printed_bank(midi, bpm, sr, seed): an A/B print (chomp or talker) resampled 3-5 times through chain A, sliced at zero
               crossings: the hero (every generation layered, 400-700 ms) and 80-250 ms calls (`hit` picks one);
               the seed is `variant` itself (any int), cached per (note, tempo, seed)
Every output has its tallest 2-4 kHz resonance notched (midbus.resonance_notch). REMIX_HARMONY 1.4: pitched growls use
integer FM ratios; combs sit on an octave of the note (k f0, k = 1, 2, 4) and move in octaves or fifths; a held note is
frequency-shifted only by m f0 / 2 (a free shift only on hits of 1/8 or less and on dives); Q >= 8 vowels ring on the
note's harmonics; distorted layers stack only 5ths and octaves. The source's tuning: pass `midi` + tuning_cents / 100.

The front has a smooth ~6 ms bump (chops read as hits, without a step), then 3 ms / 10 ms fades, so a chop never
clicks. `python -m fvwks_synth.growls --bank [dir]` writes each one-shot with its QA; `--audition [dir]` writes a
4-bar loop per engine and variant over a kick and snare at 145 BPM, club-safe, for listening.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import sys
from functools import lru_cache, partial
from pathlib import Path

import numpy as np
from scipy import ndimage, signal

from . import midbus as mb
from .foxsynth import _phase, _saw, sync_hz
from . import bass808, hybrid, riddim
from .bass808 import render_808, render_darkhit  # S1's 808 and dark long first hit: complete renders (no growl post)
from .riddim import r1, r2  # S1's RIDDIM voices (R1 square-FM wub, R2 formant yoi)
from .hybrid import dswub, wobble  # S1's trap-hybrid voices (old-school wobble, downsample wub)

STYLES = ("chomp", "talker", "disperser", "dive", "pwm", "gun", "mgun", "hero", "call", "tearout", "riddim", "yoi", "808",
          "darkhit", "wobble", "dswub", "reese", "metal", "gunshot")
_FINISHED = {"808": render_808, "darkhit": render_darkhit}  # (midi, beats, bpm, sr, variant) -> (2, n): their own post
VARIANTS = 4
GROWL_RMS_DB = -13.0
FADE_S = 0.003  # the start
RELEASE_S = 0.010  # the end: a loud buzz stopped in 3 ms still clicks
TOP_HZ = 8000.0
BLOCK = 16  # filter coefficients follow their sweep every 16 samples: fast resonant sweeps don't zipper
OS = 4  # oversampling for every distortion and fold
VOWELS = {"a": (730, 1090, 2440), "o": (570, 840, 2410), "i": (270, 2290, 3010), "e": (530, 1840, 2480), "u": (300, 870, 2240)}


# --------------------------------------------------------------------------- building blocks


def _hz(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def _sine(hz: np.ndarray, sr: int) -> np.ndarray:
    return np.sin(2 * np.pi * _phase(hz, sr))


def _square(ph: np.ndarray, dt: np.ndarray) -> np.ndarray:
    return 0.5 * (_saw(ph, dt) - _saw((ph + 0.5) % 1.0, dt))


def _biquad(x: np.ndarray, fc: np.ndarray, q: float, sr: int, kind: str) -> np.ndarray:
    """A low-pass or band-pass (0 dB peak) biquad with its frequency (Hz, per sample) taken every BLOCK samples. A run
    of blocks at one frequency (a fixed cutoff, a held vowel step) is one lfilter call: the same output, far fewer calls
    (M2.5: the per-block calls were half of every voice's render time)."""
    out = np.empty_like(x)
    zi = np.zeros(2)
    starts = np.arange(0, len(x), BLOCK)
    f = np.clip(np.asarray(fc, float)[starts], 30, sr * 0.45)
    cuts = np.concatenate([[0], starts[np.flatnonzero(np.diff(f)) + 1], [len(x)]])
    for i, j in zip(cuts[:-1], cuts[1:]):
        w = 2 * math.pi * float(f[i // BLOCK]) / sr
        alpha, c = math.sin(w) / (2 * q), math.cos(w)
        b = np.array([(1 - c) / 2, 1 - c, (1 - c) / 2]) if kind == "lp" else np.array([alpha, 0.0, -alpha])
        a = np.array([1 + alpha, -2 * c, 1 - alpha])
        out[i:j], zi = signal.lfilter(b / a[0], a / a[0], x[i:j], zi=zi)
    return out


def _lowpass(x: np.ndarray, fc: np.ndarray, q: float, sr: int) -> np.ndarray:
    return _biquad(x, fc, q, sr, "lp")


def _bandpass(x: np.ndarray, fc: np.ndarray, q: float, sr: int) -> np.ndarray:
    return _biquad(x, fc, q, sr, "bp")


def _lr4(x: np.ndarray, hz: float, sr: int, kind: str) -> np.ndarray:
    """A Linkwitz-Riley 4th-order split (two cascaded 2nd-order Butterworths)."""
    sos = signal.butter(2, hz, kind, fs=sr, output="sos")
    return signal.sosfilt(sos, signal.sosfilt(sos, x))


def _os(fn, x: np.ndarray) -> np.ndarray:
    """`fn` (a distortion or fold) run at OS x the rate, so its new harmonics don't alias back as fizz."""
    return signal.resample_poly(fn(signal.resample_poly(x, OS, 1, axis=-1)), 1, OS, axis=-1)[..., : x.shape[-1]]


def _ott(x: np.ndarray, sr: int, depth: float = 0.3, target_db: float = -16.0) -> np.ndarray:
    """midbus.ott (the one OTT, C13) at the input's RMS; `target_db` is kept for S1's riddim calls and unused."""
    return mb._match(mb.ott(x, sr, depth), x)


def _comb(x: np.ndarray, hz: float, fb: float, sr: int) -> np.ndarray:
    """A feedback comb tuned to the note: its harmonics ring (a fractional delay: a rounded one is cents out)."""
    return mb.moving_comb(x, np.full(len(x), hz), fb, sr)


def _lfo(t: np.ndarray, div: str, bpm: float, start_open: bool = False) -> np.ndarray:
    """0-1 at a tempo-synced rate, retriggered at the note: starting closed (or open)."""
    c = np.cos(2 * np.pi * sync_hz(div, bpm) * t)
    return 0.5 + 0.5 * c if start_open else 0.5 - 0.5 * c


def _feedback_sine(hz: np.ndarray, fb: float, sr: int) -> np.ndarray:
    """A sine phase-modulated by its own output (fb 0.2-0.4): the "sine comp chomp" core. DX7-style: the feedback is
    the average of the last two samples (it stays stable), solved by fixed-point iteration so it stays vectorised."""
    ph = 2 * np.pi * _phase(hz, sr)
    beta = 2.5 * fb
    y = np.sin(ph)
    for _ in range(8):
        prev = np.concatenate([[0.0], y[:-1]])
        y = np.sin(ph + beta * 0.5 * (prev + np.concatenate([[0.0], prev[:-1]])))
    return y


def _fm(hz: np.ndarray, index: np.ndarray, ratio: float, sr: int) -> np.ndarray:
    """2-op FM: a sine carrier at `hz` and a sine modulator at `ratio` x hz, `index` in radians per sample."""
    return np.sin(2 * np.pi * _phase(hz, sr) + index * _sine(hz * ratio, sr))


# --------------------------------------------------------------------------- engines (the MID layer)


TEAROUT_STATES = ("growl", "screech", "dive", "stab")  # a tearout drop: every hit a different sound


def _tearout(f: np.ndarray, t: np.ndarray, sr: int, bpm: float, v: int, f0: float, hit: int | None = None) -> np.ndarray:
    rate = ["1/8", "1/4T", "1/16", "1/8T"][v]
    octave, fb, dive = [(12, 0.30, 12), (24, 0.40, 7), (12, 0.25, 19), (24, 0.35, 0)][v]
    ratio, depth, fold, formant, state = 0.5, 1.0, 1.0, 1.0, "growl"
    if hit is not None:  # a different state per hit: FM ratio / depth, fold, formant, pitch envelope and LFO all jump
        rng = np.random.default_rng(1009 * v + hit)
        state = TEAROUT_STATES[hit % len(TEAROUT_STATES)]
        rate = ("1/4", "1/4T", "1/8", "1/8T", "1/16")[int(rng.integers(5))]
        ratio = float(rng.choice([0.5, 0.5, 1.0, 2.0, 3.0]))  # integer (0.5 the throat): a pitched growl stays in key
        depth, fold, formant = rng.uniform(0.7, 1.4), rng.uniform(0.7, 1.5), rng.uniform(0.6, 1.8)
        fb = float(rng.uniform(0.2, 0.4))
        octave = {"screech": 24, "dive": 12, "stab": 24}.get(state, int(rng.choice([12, 24])))
        dive = {"dive": int(rng.choice([12, 19, 24])), "stab": 0}.get(state, int(rng.choice([0, 0, 5, 7])))
    n = len(t)
    lfo = _lfo(t, rate, bpm, start_open=True)
    tail = np.clip((np.arange(n) / n - (0.0 if state == "dive" else 0.7)) / (1.0 if state == "dive" else 0.3), 0, 1)
    fc = f * 2 ** (octave / 12 - dive / 12 * tail * tail)  # the mid register, diving on the tail (or all the way)
    chomp = _feedback_sine(fc, fb, sr)
    growl = _fm(fc, depth * (1.5 + 2.5 * lfo) * (1.6 if state == "screech" else 1.0), ratio, sr)  # 15 → 40 %
    x = 0.55 * chomp + 0.6 * growl
    # pass 2: fold (driven by the same LFO), then OTT
    x = _ott(_os(np.sin, x * fold * (1.4 + 2.2 * lfo)), sr, 0.3)
    # pass 3: a formant sweep and the note's comb, driven again, then OTT
    fx = formant * (1.6 if state == "screech" else 1.0)
    formants = _bandpass(x, 380 * fx * 5 ** lfo, 3.0, sr) + 0.6 * _bandpass(x, 1100 * fx * 2.5 ** lfo, 4.0, sr)
    x = 0.45 * x + 1.3 * formants + 0.25 * _comb(x, float(fc[0]), 0.5, sr)
    x = _ott(_os(lambda y: np.tanh(1.6 * y), x), sr, 0.25)
    if state == "stab":  # short and hard: a quick decay after the front
        x *= np.exp(-t / (0.25 * 60.0 / bpm))
    return x


def _gunshot(f: np.ndarray, t: np.ndarray, sr: int, bpm: float, v: int, f0: float) -> np.ndarray:
    """The drop's first hit: a loud, bright stab with a pitch-drop transient (from +3 octaves onto the note in ~40 ms),
    a noise crack, folded and OTT'd, decaying in about a beat. Kick + clean sub + this = the hardest hit."""
    drop, crack, tau = [(36, 0.35, 0.35), (24, 0.25, 0.5), (36, 0.5, 0.25), (30, 0.3, 0.7)][v]
    fc = f * 2 * 2 ** (drop / 12 * np.exp(-t / 0.012))
    rng = np.random.default_rng(v)
    body = _fm(fc, 3.0 * np.exp(-t / 0.08) + 1.2, 0.5, sr) + crack * rng.standard_normal(len(t)) * np.exp(-t / 0.015)
    x = _ott(_os(np.sin, 2.5 * body), sr, 0.35)
    x = x + 0.8 * _bandpass(x, 900 + 3000 * np.exp(-t / 0.05), 2.0, sr)
    return _os(lambda y: np.tanh(2.0 * y), x) * np.exp(-t / (tau * 60.0 / bpm))


def _reese(f: np.ndarray, t: np.ndarray, sr: int, bpm: float, v: int, f0: float) -> np.ndarray:
    cents, square, octave, (lo, hi), div, q = [(12, False, 0.0, (250, 2400), "1/2", 1.4),  # the classic stack
                                               (18, True, 0.0, (200, 1600), "1/1", 2.5),  # hollow, square voices
                                               (25, False, 0.5, (400, 3000), "1/4", 1.2),  # wide, an octave on top
                                               (8, False, 0.0, (200, 1200), "1/8T", 4.0)][v]  # dark and talking
    x = np.zeros(len(t))
    for c in np.linspace(-cents, cents, 7):
        fc = f * 2 * 2 ** (c / 1200)
        ph, dt = _phase(fc, sr), fc / sr
        x += _square(ph, dt) if square else _saw(ph, dt)
        if octave:
            x += octave * _saw(_phase(2 * fc, sr), 2 * dt)
    x = _ott(_os(lambda y: np.tanh(1.5 * y), x / 7), sr, 0.25)
    return _lowpass(x, lo * (hi / lo) ** _lfo(t, div, bpm), q, sr)


def _metal(f: np.ndarray, t: np.ndarray, sr: int, bpm: float, v: int, f0: float) -> np.ndarray:
    shift = [37.0, 80.0, 150.0, 60.0][v]  # upward only: a downward shift folds the low partials through 0 Hz
    ring = [2.0, 3.0, 4.0, 0.5][v]
    fc = f * 2.0
    lfo = _lfo(t, "1/8T", bpm, start_open=True)
    fm = _fm(fc, 2.0 + 2.0 * lfo, 2.0, sr)
    # every partial moved (inharmonic, metallic) on the attack only, then back in key: non-integer only on a transient
    shifted = mb.freq_shift(fm, sr, shift * np.exp(-t / 0.06) * np.clip(1 - t / (30.0 / bpm), 0, 1))  # 0 by 1/8
    x = shifted * (0.6 + 0.4 * _sine(fc * ring, sr))
    x = _ott(_os(np.sin, 1.8 * x), sr, 0.3)
    return np.tanh(2.0 * _bandpass(x, 500 * 6 ** lfo, 1.5, sr) * 3 + 0.3 * x)


_ENGINES = {"tearout": _tearout, "riddim": r1, "yoi": r2, "reese": _reese, "metal": _metal,
            "gunshot": _gunshot, "wobble": wobble, "dswub": dswub}
# GRIT's fold drive (the mid times this into sin(3y)). S1's formant / FM voices swell past the fold at 2 and tick
# (HF clicks per 4-bar loop at 2 -> 1.5: yoi 60 -> 0, riddim 28 -> 16, dswub 8 -> 0; the top stays, it's re-levelled).
_GRIT_DRIVE = {"yoi": 1.5, "riddim": 1.5, "dswub": 1.5}


# --------------------------------------------------------------------------- TEAROUT voices (Sound Bible §2.2)
# Each returns the finished MID (its own §1.2 chain through midbus); render_growl adds the clean sub, width and fades.
# `rng` is seeded by (voice, variant, hit), so every hit of a phrase is its own state and the same hit renders the same.


def _voice_chomp(f0: float, t: np.ndarray, sr: int, bpm: float, v: int, rng: np.random.Generator,
                 snap: int = 24) -> np.ndarray:
    """A, "Sine Comp chomp": a feedback sine (20-40 %) at root +12/+24 with a sine 5th (-6 dB), a +`snap` st pitch
    envelope over 25-40 ms (AX-26: +24, or a softer +12), then Distortion 24 dB → OTT 1.0 → clip -6 dB → HP 120 → OTT
    0.5 → whistles notched."""
    octave = (12, 24, 12, 24)[v] if rng is None else int(rng.choice([12, 24]))
    fb = 0.3 if rng is None else float(rng.uniform(0.2, 0.4))
    env_s = 0.032 if rng is None else float(rng.uniform(0.025, 0.04))
    hz = f0 * 2 ** ((octave + snap * np.exp(-t / env_s)) / 12)
    x = _feedback_sine(hz, fb, sr) + 0.5 * _sine(hz * 1.5, sr)  # a just 5th: harmonic, no beating in the distortion
    x = mb.distort(x, 24.0, "hard")
    x = mb.ott(x, sr, 1.0)
    x = mb.clip(x, 6.0)
    x = mb.lr4(x, mb.CROSSOVER_HZ, sr, "highpass")
    return mb.notch_whistles(mb.ott(x, sr, 0.5), sr)


VOWEL_PATHS = ("ioi", "ua", "aoi", "oai", "iau", "eoa")


def _voice_talker(f0: float, t: np.ndarray, sr: int, bpm: float, v: int, rng: np.random.Generator) -> np.ndarray:
    """B, "FM talker/growl": a carrier at root +12 phase-modulated by a sine at ratio 0.5, its index stepped on 1/16
    (rasp 1.5-3, scream 4-8); a vowel stage stepped on 1/16 (F1/F2/F3, Q 8-12) before Distortion 18-24 dB → Phaser
    (1/2, fb 0.6) → HP 120 → -3 dB @ 400 Hz → 2-5 kHz tamed. Syllables bounce on 1/4T."""
    r = rng if rng is not None else np.random.default_rng(v)
    n = len(t)
    step = 15.0 / bpm  # a 1/16
    k = (t / step).astype(int)
    scream = r.random() < 0.3
    levels = r.choice([0.3, 1.0, 0.6, 0.9, 0.5, 0.8], size=8)
    index = (float(r.uniform(4, 8)) if scream else float(r.uniform(1.5, 3.0))) * levels[k % 8]
    index = ndimage.uniform_filter1d(index, int(0.002 * sr), mode="nearest")  # 2 ms steps: no zipper
    hz = np.full(n, f0 * 2.0)
    carrier = _saw(_phase(hz, sr), hz / sr) if r.random() < 0.5 else None
    ph = 2 * np.pi * _phase(hz, sr) + index * _sine(hz * 0.5, sr)
    x = np.sin(ph) if carrier is None else 0.6 * np.sin(ph) + 0.4 * carrier
    path = VOWEL_PATHS[int(r.integers(len(VOWEL_PATHS)))]
    vowel = np.array([path[i % len(path)] for i in k])
    bounce = 0.85 + 0.15 * np.cos(2 * np.pi * sync_hz("1/4T", bpm) * t)
    y = np.zeros(n)
    for j, (gain, q) in enumerate(((1.0, 8.0), (0.7, 10.0), (0.35, 12.0))):
        fc = np.array([VOWELS[c][j] for c in vowel], float)
        fc = ndimage.uniform_filter1d(mb.harmonic_of(fc, f0), int(0.003 * sr), mode="nearest")  # on a harmonic; 3 ms glides
        y += gain * _bandpass(x, fc, q, sr)
    # the dry 20 % rounded off at 3 kHz: a saw carrier's raw edge through the 20 dB diode came out a 3-sample needle
    # once a period (S2's mix click); the formants already carry the voice's top
    y = 0.8 * y * bounce + 0.2 * _lowpass(x, np.full(n, 3000.0), 0.7, sr)
    return mb.midbus(y, sr, "talker", bpm)


def _allpass_sos(f0: float, q: float, sr: int, stages: int) -> np.ndarray:
    """`stages` identical RBJ 2nd-order allpasses at f0: a disperser (the group delay piles up around f0)."""
    w = 2 * math.pi * f0 / sr
    alpha, c = math.sin(w) / (2 * q), math.cos(w)
    b = np.array([1 - alpha, -2 * c, 1 + alpha]) / (1 + alpha)
    a = np.array([1.0, -2 * c / (1 + alpha), (1 - alpha) / (1 + alpha)])
    return np.tile(np.concatenate([b, a]), (stages, 1))


def _voice_disperser(f0: float, t: np.ndarray, sr: int, bpm: float, v: int, rng: np.random.Generator) -> np.ndarray:
    """C, "disperser machine gun": a short saw chomp (+12..+24 → 0 st over 20-40 ms) through 16-64 allpass biquads at
    150-400 Hz (Q 0.7-4), a falling chirp, with a low-pass ramping 4 kHz → 300 Hz per shot; retriggered on 1/16 (or
    1/8T) for as long as the note lasts, each shot a little different. Then midbus "print"."""
    n = len(t)
    period = (15.0 if rng.random() < 0.6 else 20.0) / bpm  # a 1/16 or a 1/8T
    shot_n = max(1, min(n, int(period * sr)))
    out = np.zeros(n)
    for k, start in enumerate(range(0, n, shot_n)):
        m = min(shot_n, n - start)
        ts = np.arange(m) / sr
        up, env = float(rng.uniform(12, 24)), float(rng.uniform(0.02, 0.04))
        hz = f0 * 2 * 2 ** (up / 12 * np.exp(-ts / env))
        shot = _saw(_phase(hz, sr), hz / sr) * np.exp(-ts / (0.6 * period))
        sos = _allpass_sos(float(rng.uniform(150, 400)), float(rng.uniform(0.7, 4.0)), sr, int(rng.integers(16, 65)))
        shot = signal.sosfilt(sos, shot)
        shot = _lowpass(shot, 300 * (4000 / 300) ** (1 - ts / max(ts[-1], 1e-9)), 1.2, sr)
        ramp = min(int(0.003 * sr), m // 4)  # each retrigger joins its neighbour without a click (raised cosine)
        if ramp:
            shot[:ramp] *= 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, ramp))
            shot[-ramp:] *= 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, ramp))
        out[start:start + m] = shot
    return mb.midbus(out, sr, "print", bpm)


def _voice_dive(f0: float, t: np.ndarray, sr: int, bpm: float, v: int, rng: np.random.Generator) -> np.ndarray:
    """D, "freq-shift dive" (fills; the Echobode idea): a short chomp into a delay loop (1/32 or 1/16, feedback
    0.7-0.9, HP 150 Hz inside the loop) whose every pass is frequency-shifted further down, 0 → -300..-800 Hz over the
    note: a dive that falls apart into the next downbeat."""
    n = len(t)
    d = max(1, int((7.5 if rng.random() < 0.5 else 15.0) / bpm * sr))  # a 1/32 or a 1/16
    fb, depth = float(rng.uniform(0.7, 0.9)), float(rng.uniform(300, 800))
    ts = np.arange(min(n, d)) / sr
    hz = f0 * 2 * 2 ** (24 / 12 * np.exp(-ts / 0.03))
    seed = _feedback_sine(hz, 0.3, sr) * np.exp(-ts / 0.03)
    seed = mb.distort(mb.distort(seed, 12.0, "tanh"), 6.0, "tanh")  # the drive goes on the shot, before the loop:
    out = np.zeros(n)  # after it, saturation would square up every echo's seam into an edge
    block = np.zeros(d)
    block[: len(seed)] = seed
    ramp = min(int(0.003 * sr), d // 4)
    fade = np.ones(d)
    if ramp:  # every echo joins the next without a click (raised cosine)
        fade[:ramp] = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, ramp))
        fade[-ramp:] = 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, ramp))
    for k, start in enumerate(range(0, n, d)):
        m = min(d, n - start)
        out[start:start + m] = (block * fade)[:m]
        shift = -depth * min(1.0, (start + d) / n)  # further down every pass
        block = fb * mb.lr4(mb.freq_shift(block * fade, sr, shift), 150.0, sr, "highpass")
    return mb.midbus(out, sr, {"dist1_db": 0.0, "fx": None, "dist2_db": 0.0, "ott": 0.6, "clip_db": 1.5}, bpm)


def _voice_pwm(f0: float, t: np.ndarray, sr: int, bpm: float, v: int, rng: np.random.Generator) -> np.ndarray:
    """E, "PWM reso" (drop 2's patch family): a pulse at root +12 with its width swept 10-50 % on 1/8, a resonant
    24 dB low-pass 300 Hz → 2.5 kHz (resonance 60-75 %) with its envelope decaying over a 1/16, then OTT 1.0 → clip 4 dB
    → HP 120."""
    hz = np.full(len(t), f0 * 2.0)
    ph, dt = _phase(hz, sr), hz / sr
    width = 0.3 + 0.2 * np.sin(2 * np.pi * sync_hz("1/8", bpm) * t + float(rng.uniform(0, 2 * np.pi)))
    pulse = _saw(ph, dt) - _saw((ph + width) % 1.0, dt)
    decay = 15.0 / bpm * float(rng.uniform(0.7, 1.4))
    cutoff = 300 + 2200 * np.exp(-t / decay)
    q = 1.0 + 3.0 * float(rng.uniform(0.6, 0.75))
    x = _lowpass(_lowpass(pulse, cutoff, q, sr), cutoff, 0.7, sr)  # 24 dB: a resonant stage then a plain one
    x = mb.clip(mb.ott(x, sr, 1.0), 4.0)
    return mb.lr4(x, mb.CROSSOVER_HZ, sr, "highpass")


GUN_RATIOS = (1.41, 1.73, 2.24, 2.76, 3.3, 3.5)  # layer (b): non-integer, fine on a transient (fingerprints §2 B)


def _gun_shot(f0: float, sr: int, bpm: float, rng: np.random.Generator, metal: bool = True) -> np.ndarray:
    """One gun shot (fingerprints §2 B) as MID: (a) a 5-20 ms metal clang (inharmonic partials, a ~3 ms decay) over
    (b) an FM burst at root +12/+24, a non-integer ratio, its index falling 5-9 → ~1 over 30-80 ms and its amp over
    80-200 ms, run through chain A once or twice and gated again by its own envelope: silence after it stays silent.
    Layer (c), the root sine under it, is the SUB (render_growl). HP 120 Hz."""
    m = int(float(rng.uniform(0.08, 0.2)) * sr)
    ts = np.arange(m) / sr
    hz = np.full(m, f0 * 2 ** (int(rng.choice([12, 24])) / 12))
    index = 1.0 + float(rng.uniform(4, 8)) * np.exp(-ts / (float(rng.uniform(0.03, 0.08)) / 3))
    amp = np.exp(-ts / (m / sr / 4)) * (0.5 + 0.5 * np.cos(np.linspace(0, np.pi, m)))  # ends at exactly 0
    b = _fm(hz, index, float(rng.choice(GUN_RATIOS)), sr) * amp
    for _ in range(int(rng.integers(1, 3))):
        b = mb.chain_a(b, sr, rng, bpm) * amp
    if metal:
        k = min(m, int(float(rng.uniform(0.005, 0.02)) * sr))
        tk = ts[:k]
        clang = sum(_sine(np.full(k, float(rng.uniform(700, 1600)) * r), sr) for r in (1.0, 1.41, 2.76, 3.3))
        b[:k] += 0.35 * clang / 4 * np.exp(-tk / 0.003) * (0.5 + 0.5 * np.cos(np.linspace(0, np.pi, k)))
    return mb.lr4(b, mb.CROSSOVER_HZ, sr, "highpass")


def _voice_gun(f0: float, t: np.ndarray, sr: int, bpm: float, v: int, rng: np.random.Generator) -> np.ndarray:
    """F, "gun shot" (M1.2): one 80-200 ms shot, then real silence to the end of the note. Every (variant, hit) is its
    own state (ratio, index, lengths, register, the chain's drive and movement)."""
    out = np.zeros(len(t))
    shot = _gun_shot(f0, sr, bpm, rng)[: len(t)]
    out[: len(shot)] = shot
    return out


def _voice_mgun(f0: float, t: np.ndarray, sr: int, bpm: float, v: int, rng: np.random.Generator) -> np.ndarray:
    """G, "machine gun" (M1.2): layer (b) retriggered every 1/32 for the note, each repeat ±1-2 st further (down or up,
    by the seed) and 5-15 % quieter, joined with 3 ms raised cosines."""
    n = len(t)
    step = max(1, int(7.5 / bpm * sr))
    shot = _gun_shot(f0, sr, bpm, rng, metal=False)
    st, fall = float(rng.choice([-1, 1]) * rng.uniform(1, 2)), float(rng.uniform(0.85, 0.95))
    ramp = min(int(0.003 * sr), step // 4)
    out = np.zeros(n)
    for k, start in enumerate(range(0, n, step)):
        up = int(round(100 * 2 ** (k * st / 12)))
        s = signal.resample_poly(shot, 100, up)[: min(step, n - start)] * fall ** k  # varispeed: the pitch steps
        s[-ramp:] *= 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, ramp))[-len(s):]
        if k:
            s[:ramp] *= (0.5 - 0.5 * np.cos(np.linspace(0, np.pi, ramp)))[: len(s)]
        out[start:start + len(s)] = s
    return out


# --------------------------------------------------------------------------- M1.3: printed one-shot banks (chain A)


def _slice(x: np.ndarray, start: int, length: int, sr: int) -> np.ndarray:
    """Chain A step 11: a one-shot from the next zero crossing on, 1.5 ms in and 8 ms out (raised cosines), its peaks
    clipped (4x) to a 12 dB crest when a slice caught a spike: printed shots stay dense (M1.3: crest <= 14 dB)."""
    z = start + int(np.argmax(np.signbit(x[start:-1]) != np.signbit(x[start + 1:]))) + 1
    y = x[z:z + length].copy()
    crest = 20 * np.log10(np.max(np.abs(y)) / (np.sqrt(np.mean(y * y)) + 1e-12) + 1e-12)
    if crest > 12.0:
        y = mb.clip(y, crest - 12.0)
    a, r = min(len(y) // 4, int(0.0015 * sr)), min(len(y) // 4, int(0.008 * sr))
    y[:a] *= 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, a))
    y[len(y) - r:] *= 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, r))
    return y


@lru_cache(maxsize=64)
def printed_bank(midi: float, bpm: float, sr: int, seed: int, passes: int | None = None, movement: str | None = None,
                 mangle: str | None = None) -> dict[str, tuple[np.ndarray, ...]]:
    """One seed's tearout one-shots (fingerprints §2 A, M1.3, plan v2 M1.2b), printed once and cached: a 3 s A or B
    print (a held chomp or talker note, by the seed) resampled 3 or 5 times (midbus.resample_chain, every generation
    plus a mangle), then sliced at zero crossings. `hero`: every generation layered from the onset (the impact),
    400-700 ms. `calls`: 80-250 ms slices, one or two per generation, the mangle's among them."""
    rng = np.random.default_rng([seed, int(round(midi * 100))])
    voice = _voice_chomp if rng.random() < 0.5 else _voice_talker
    src = voice(_hz(midi), np.arange(int(3.0 * sr)) / sr, sr, bpm, seed % VARIANTS, rng)
    gens = mb.resample_chain(src, sr, seed, passes, bpm=bpm, movement=movement, mangle=mangle, f0=_hz(midi))
    hero_n = int(float(rng.uniform(0.4, 0.7)) * sr)
    hero = sum(g[: len(gens[0])] for g in gens[:-1] if len(g) >= len(gens[0]))
    calls = []
    for g in gens:
        for _ in range(int(rng.integers(1, 3))):
            n = int(float(rng.uniform(0.08, 0.25)) * sr)
            calls.append(_slice(g, int(rng.integers(0, max(1, len(g) - n - sr // 10))), n, sr))
    return {"hero": (_slice(hero, 0, hero_n, sr),), "calls": tuple(calls)}


def _printed(style: str, midi: float, n: int, sr: int, bpm: float, seed: int, hit: int, axes: dict[str, str]) -> np.ndarray:
    """A hero or the hit-th call (never the same call twice in a row) from the seed's bank, then silence."""
    passes = axes.get("resample.passes")
    bank = printed_bank(float(midi), float(bpm), sr, seed, int(passes) if passes else None, axes.get("resample.movement"),
                        axes.get("resample.mangle"))
    shots = bank["hero" if style == "hero" else "calls"]
    shot = shots[hit % len(shots)][:n]
    out = np.zeros(n)
    out[: len(shot)] = shot
    return out


_VOICES = {"chomp": _voice_chomp, "talker": _voice_talker, "disperser": _voice_disperser, "dive": _voice_dive,
           "pwm": _voice_pwm, "gun": _voice_gun, "mgun": _voice_mgun}
_PERCUSSIVE = {"gun": 0.08, "mgun": 0.08}  # their SUB is layer (c): a root sine this long, not held


def _finish_voice(mid: np.ndarray, f0: float, n: int, sr: int, sub: bool, sub_s: float | None = None) -> np.ndarray:
    """A designed voice's MID, its 2-4 kHz resonance notched, at GROWL_RMS_DB over the clean SUB (midbus.sub_voice, at the
    mid's level: growl bars sit within a few dB of the sub band; only `sub_s` long for a gun), a touch of width above
    1 kHz (mid/side), raised-cosine fades (4 ms in, 12 ms out)."""
    mid = signal.sosfilt(signal.butter(2, 10_000, "lowpass", fs=sr, output="sos"), mid)  # a bass needs no air: the TOP layer's
    mid = mb.resonance_notch(mid, sr)
    live = mid[np.abs(mid) > 1e-3 * np.max(np.abs(mid))] if sub_s else mid  # a gun's level is its shot's, not the gap's
    level = np.sqrt(np.mean(live * live)) + 1e-12
    mid = mid * 10 ** (GROWL_RMS_DB / 20) / level
    low = np.zeros(n)
    if sub:
        m = n if sub_s is None else min(n, int(sub_s * sr))
        low[:m] = mb.sub_voice(mb.sub_hz(12 * math.log2(f0 / 440.0) + 69), m, sr, release_s=0.015 if sub_s is None else m / sr / 2)
        low *= 0.9 * 10 ** (GROWL_RMS_DB / 20) / (np.sqrt(np.mean(low[:m] * low[:m])) + 1e-12)
    side = 0.25 * mb.lr4(np.roll(mid, int(0.005 * sr)), 1000.0, sr, "highpass")
    x = np.stack([mid + low + side, mid + low - side])
    x *= 0.95 / (np.max(np.abs(x)) + 1e-12)
    fade, rel = min(int(0.004 * sr), n // 4), min(int(0.012 * sr), n // 4)  # the bible's chop fades: 4 ms in, >= 8 out
    x[:, :fade] *= 0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, fade))
    x[:, n - rel:] *= 0.5 + 0.5 * np.cos(np.linspace(0.0, np.pi, rel))
    return x.astype(np.float32)


# every synth axis in one registry for the resolver: midbus's (AX-25), the chomp snap (AX-26), S1's riddim and 808
AXES: dict[str, dict[str, float]] = {**mb.AXES, "tearout.chomp_snap": {"24": 0.7, "12": 0.3}, **riddim.AXES, **bass808.AXES,
                                     **hybrid.AXES}


def render_hero(midi: float, beats: float, bpm: float, sr: int = 48_000, seed: int = 0, sub: bool = True,
                axes: dict[str, str] | None = None) -> np.ndarray:
    """M1.2b: the tearout drop's hero hit (drop bar 1, beat 1 only): the seed's printed hero, every generation of an A/B
    print layered, 400-700 ms, then silence to `beats`. Peak-normalized like every growl: the +2..+3 dB over the
    drop's later hits is the arrangement's gain (FIRST_DB)."""
    return render_growl("hero", midi, beats, bpm, sr, seed, sub, 0, axes)


# --------------------------------------------------------------------------- the print cache (M2.5)

PRINT_CAP_BYTES = 256 << 20
_SOURCES = ("growls", "midbus", "riddim", "bass808", "hybrid", "candy", "foxsynth")  # the code a print depends on
_writes = 0


@lru_cache(maxsize=1)
def _code_version() -> str:
    """A fingerprint of the voices' code: a changed voice never serves an old print."""
    h = hashlib.sha1()
    for name in _SOURCES:
        f = Path(__file__).with_name(f"{name}.py")
        h.update(f.read_bytes() if f.is_file() else name.encode())
    return h.hexdigest()[:12]


def _print_dir() -> Path | None:
    """<engine data dir>/synth/prints once the server has configured the synth (bass.configure); off otherwise (tests,
    scripts), so nothing lands outside the engine's own data."""
    from . import bass

    return bass._data / "prints" if bass._data is not None else None


def _prune(folder: Path) -> None:
    """LRU by mtime (a hit touches its file) down to 80 % of PRINT_CAP_BYTES."""
    files = sorted(folder.glob("*.npy"), key=lambda f: f.stat().st_mtime)
    total = sum(f.stat().st_size for f in files)
    for f in files:
        if total <= PRINT_CAP_BYTES * 0.8:
            break
        total -= f.stat().st_size
        f.unlink(missing_ok=True)


def render_growl(style: str, midi: float, beats: float, bpm: float, sr: int = 48_000, variant: int = 0,
                 sub: bool = True, hit: int | None = None, axes: dict[str, str] | None = None) -> np.ndarray:
    """_render_growl, content-addressed on disk (M2.5): the key is every argument and the voices' code, so a ROLL or a
    re-PREPARE that asks for a voice state it has rendered before reads it back instead of rendering it again."""
    global _writes
    folder = _print_dir()
    if folder is None:
        return _render_growl(style, midi, beats, bpm, sr, variant, sub, hit, axes)
    key = json.dumps([_code_version(), style, float(midi), float(beats), float(bpm), int(sr), int(variant), bool(sub), None if hit is None else int(hit),
                      sorted((axes or {}).items())])
    path = folder / f"{hashlib.sha1(key.encode()).hexdigest()[:24]}.npy"
    try:
        y = np.load(path)
        os.utime(path)
        return y
    except (OSError, ValueError):
        pass
    y = _render_growl(style, midi, beats, bpm, sr, variant, sub, hit, axes)
    try:
        folder.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(f".{os.getpid()}.tmp")
        with open(tmp, "wb") as f:
            np.save(f, y)
        tmp.replace(path)
        _writes += 1
        if _writes % 64 == 0:
            _prune(folder)
    except OSError:
        pass  # a full disk costs a re-render, never the note
    return y


def _render_growl(style: str, midi: float, beats: float, bpm: float, sr: int = 48_000, variant: int = 0,
                  sub: bool = True, hit: int | None = None, axes: dict[str, str] | None = None) -> np.ndarray:
    """One growl note: (2, n) float32 at `sr`, n = `beats` at `bpm` exactly. `variant` 0-3 picks the character's take;
    `sub=False` leaves the sine sub out (the sequencer adds its own). `hit` (tearout): the hit's index in the phrase;
    each one is a different state of the patch (growl / screech / dive / stab, with its own FM, fold, formant, pitch
    envelope and LFO), the same for the same (variant, hit). `axes`: the take's resolved options for AXES (BUILD's
    choose(), plan v2 §4.1), e.g. {"resample.passes": "5", "tearout.chomp_snap": "12"}; unset ones fall back to the
    voice's own seeded pick or default."""
    if style in _FINISHED:  # S1's 808 / dark hit: already a finished, sub-safe render
        finished = partial(render_808, axes=axes) if style == "808" else _FINISHED[style]  # 808.* axes: S1's bass808
        return finished(midi, beats, bpm, sr, variant % VARIANTS)
    if style not in _ENGINES and style not in _VOICES and style not in ("hero", "call"):
        raise KeyError(f"unknown growl style {style!r} (one of {', '.join(STYLES)})")
    n = int(round(beats * 60.0 / bpm * sr))
    if n <= 0:
        return np.zeros((2, 0), np.float32)
    t = np.arange(n) / sr
    f0 = _hz(midi)
    v = variant % VARIANTS
    if style in ("hero", "call"):  # the printed bank's (its seed is the variant itself: any int, not just 0-3)
        mid = _printed(style, midi, n, sr, bpm, variant, hit or 0, axes or {})
        sounding = int(np.flatnonzero(mid)[-1]) + 1 if mid.any() else n
        return _finish_voice(mid, f0, n, sr, sub, sounding / sr)
    if style in _VOICES:
        seed = 7919 * list(_VOICES).index(style) + 1009 * v + (hit if hit is not None else 0)
        voice = _VOICES[style]
        if style == "chomp" and axes and "tearout.chomp_snap" in axes:
            voice = partial(voice, snap=int(axes["tearout.chomp_snap"]))
        return _finish_voice(voice(f0, t, sr, bpm, v, np.random.default_rng(seed)), f0, n, sr, sub, _PERCUSSIVE.get(style))
    top = np.full(n, TOP_HZ)
    engine = partial(_ENGINES[style], axes=axes) if style in ("riddim", "wobble", "dswub") else _ENGINES[style]  # S1's axes
    mid = engine(np.full(n, f0), t, sr, bpm, v, f0, hit) if style == "tearout" else engine(np.full(n, f0), t, sr, bpm, v, f0)
    mid = mb.resonance_notch(_lowpass(_lowpass(_lr4(mid, 120.0, sr, "highpass"), top, 0.7, sr), top, 0.7, sr), sr)
    mid *= 10 ** (GROWL_RMS_DB / 20) / (np.sqrt(np.mean(mid * mid)) + 1e-12)
    grit = _lr4(_os(lambda y: np.sin(3.0 * y), mid * _GRIT_DRIVE.get(style, 2.0)), 2500.0, sr, "highpass")
    grit = _lowpass(_lowpass(grit, top, 0.7, sr), top, 0.7, sr)
    grit *= 0.25 * np.sqrt(np.mean(mid * mid)) / (np.sqrt(np.mean(grit * grit)) + 1e-12)
    if sub:  # the one sub fold and voice (C13): midbus
        low = mb.sub_voice(mb.sub_hz(midi), n, sr)
        low *= 0.9 * np.sqrt(np.mean(mid * mid)) / (np.sqrt(np.mean(low * low)) + 1e-12)
    else:
        low = 0.0
    front = 1 + 0.6 * (t / 0.006) * np.exp(1 - t / 0.006)  # a smooth ~6 ms bump: a hit, not a step
    centre = (mid + low) * front
    side = 0.5 * np.roll(grit, int(0.006 * sr)) * front
    x = np.stack([centre + grit + side, centre + grit - side])
    x = _os(lambda y: np.tanh(1.2 * y), x / (np.max(np.abs(x)) + 1e-12)) / math.tanh(1.2) * 0.95  # oversampled too
    fade, rel = min(int(FADE_S * sr), n // 4), min(int(RELEASE_S * sr), n // 4)
    x[:, :fade] *= 0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, fade))  # raised cosine: no slope corners to splatter
    x[:, n - rel:] *= 0.5 + 0.5 * np.cos(np.linspace(0.0, np.pi, rel))
    return x.astype(np.float32)


# --------------------------------------------------------------------------- the designed voices as library patches

# v0.11.10: the SWAP SOUND tabs. patch_id (plan v2 §3.13's grammar) → (name, BassPatch.category)
DESIGNED: dict[str, tuple[str, str]] = {
    "voice:chomp": ("Chomp", "tearout"), "voice:talker": ("Talker", "tearout"), "voice:disperser": ("Disperser", "tearout"),
    "voice:dive": ("Dive", "tearout"), "voice:pwm": ("PWM reso", "tearout"), "voice:metal": ("Metal", "tearout"),
    "voice:gun": ("Gun shot", "tearout"), "voice:mgun": ("Machine gun", "tearout"), "voice:hero": ("Hero hit", "tearout"),
    "top:arp": ("8-bit arp", "top"), "top:powerup": ("Power-up", "top"), "top:coin": ("Coin", "top"),
    "top:squeak": ("Squeak", "top"),
    "riddim:wub": ("Riddim wub", "riddim"), "voice:yoi": ("Yoi", "riddim"),
    "808:line": ("808 line", "808"), "808:dark": ("Dark hit", "808"),
    "wobble:old": ("Old-school wobble", "wobble"), "wobble:ds": ("Downsample wub", "wobble"),
}
_AS_STYLE = {"riddim:wub": "riddim", "808:line": "808", "808:dark": "darkhit", "wobble:old": "wobble", "wobble:ds": "dswub"}


def designed_patches() -> list:
    from fvwks_contracts.models import BassPatch

    return [BassPatch(id=pid, name=name, category=cat, engine="foxbox") for pid, (name, cat) in DESIGNED.items()]


def render_designed(patch_id: str, midi: float, beats: float, bpm: float, sr: int = 48_000, variant: int = 0,
                    hit: int | None = None, axes: dict[str, str] | None = None) -> np.ndarray:
    """One note of a designed patch, (2, n) float32: voice:<style> is render_growl; top:* the candy or the squeak."""
    if patch_id not in DESIGNED:
        raise KeyError(f"unknown designed patch {patch_id!r}")
    if patch_id == "top:squeak":
        return riddim.render_squeak(midi, beats, bpm, sr, variant)
    if patch_id.startswith("top:"):
        from .candy import render_candy

        return render_candy(patch_id[4:], midi, beats, bpm, sr, variant)
    style = _AS_STYLE.get(patch_id, patch_id.split(":", 1)[1])
    return render_growl(style, midi, beats, bpm, sr, variant, hit=hit, axes=axes)


def designed_preview(patch_id: str) -> Path:
    """Its ~2 s audition (one bar at 140, S1's stock riff: root 1.5 beats, a pickup, the root, the fifth), loudness-
    matched and cached like the library's (fvwks_synth.preview)."""
    from .preview import BPM, SR, STOCK, _cached

    def render() -> np.ndarray:
        out = np.zeros((2, int(round(4 * 60.0 / BPM * SR))))
        for hit, (beat, beats, midi) in enumerate(((0, 1.5, 36), (1.5, 0.5, 36), (2, 1.5, 36), (3.5, 0.5, 43))):
            y = render_designed(patch_id, midi, beats, BPM, SR, 0, hit)
            i = int(round(beat * 60.0 / BPM * SR))
            out[:, i:i + y.shape[1]] += y[:, : out.shape[1] - i]
        return out

    return _cached(patch_id.replace(":", "-"), {"stock": STOCK, "designed": patch_id, "v": 1}, render)


# --------------------------------------------------------------------------- QA, the bank and the audition


BUZZ_GAP_S = 0.065  # two periods of the lowest riddim note (C1, 61 ms) and a comb's few % of wobble (S1's R1)


def clicks(e: np.ndarray, sr: int, skip_s: float = 0.0, floor_db: float = -45.0) -> int:
    """Clicks in `e` (power above 4 kHz): events that pack their energy into ~0.3 ms (25x their 10 ms surround, over
    `floor_db`), not counting a buzzy note's own edges. Buzz is local regularity: three or more events in a row with gaps
    under BUZZ_GAP_S that match (+-12 %, or a whole multiple where edges dipped under the threshold) are a note's pitch
    period, whatever the note (a line changes pitch); a lone event 1-6 local periods (+-5 %) from such a train is its
    too. The rest, merged within 30 ms, are clicks (scripts/remix_qa.py counts the same way). BUZZ_GAP_S is 65 ms: S1's
    R1 (0.5-ratio FM) repeats every two periods, 61 ms on C1. Blind spot: a click at every 1/32 retrigger (50-54 ms at
    140-150 BPM) is as regular as that buzz."""
    short = ndimage.uniform_filter1d(e, max(3, int(0.0003 * sr)), mode="nearest")
    wide = ndimage.uniform_filter1d(e, int(0.010 * sr), mode="nearest")
    hits = np.flatnonzero((short > 25 * wide) & (short > 10 ** (floor_db / 10)))
    if not len(hits):
        return 0
    first = hits[np.concatenate([[True], np.diff(hits) > int(0.005 * sr)])]
    ev, db = first / sr, 10 * np.log10(short[first] + 1e-30)
    buzz = np.zeros(len(ev), bool)
    period = np.full(len(ev), np.nan)
    gaps = np.diff(ev)
    for i in range(1, len(ev) - 1):
        a, b = gaps[i - 1], gaps[i]
        if a < BUZZ_GAP_S and b < BUZZ_GAP_S:
            r = max(a, b) / min(a, b)
            if round(r) <= 2 and abs(r - round(r)) <= 0.12 * round(r):  # the same gap, or one edge dipped under
                buzz[i - 1:i + 2] = True
                period[i - 1:i + 2] = min(a, b)
    lone = np.flatnonzero(~buzz)
    trains = np.flatnonzero(buzz)
    for i in lone if len(trains) else []:
        j = trains[np.argmin(np.abs(ev[trains] - ev[i]))]
        k = abs(ev[i] - ev[j]) / period[j]
        if round(k) <= 6 and abs(k - round(k)) <= 0.05:  # a few edges lost at the threshold (a masked yoi: up to 6)
            buzz[i] = True
    for i in np.flatnonzero(~buzz)[:-1]:  # an isolated pair under 30 ms apart, level within 1 dB: a buzz's two edges
        j = i + 1  # (S1: a masked yoi saw's), not two clicks
        if (not buzz[j] and ev[j] - ev[i] < 0.030 and abs(db[i] - db[j]) <= 1.0
                and (i == 0 or ev[i] - ev[i - 1] >= 0.030) and (j + 1 == len(ev) or ev[j + 1] - ev[j] >= 0.030)):
            buzz[i] = buzz[j] = True
    lone = ev[~buzz]
    lone = lone[lone >= skip_s]  # a one-shot's own attack isn't a click
    return int(len(lone) and 1 + np.sum(np.diff(lone) >= 0.030))


def qa(x: np.ndarray, sr: int) -> dict[str, float]:
    """The REMIX QA for a one-shot (Sound Bible §5): mid-bass crest (dB), spectral-centroid movement (octaves per
    30 ms), clicks at its joins (0-2: an edge sample more than -60 dB re the peak; a slice cut dead clicks where it
    meets its neighbour, and a faded one can't), the interior's HF events (texture, for information: a hard-driven growl
    is meant to crackle; the mix-level detector is scripts/remix_qa.py's), and the peak and edge levels."""
    mono = x.mean(axis=0).astype(np.float64)
    mid = signal.sosfiltfilt(signal.butter(4, (100, 1000), "bandpass", fs=sr, output="sos"), mono)
    f, _, z = signal.stft(mono, sr, nperseg=2048, noverlap=2048 - int(0.03 * sr))
    p = np.abs(z[:, 1:-1]) ** 2
    cen = np.log2(np.maximum((f[:, None] * p).sum(axis=0) / (p.sum(axis=0) + 1e-20), 20.0))
    e = signal.sosfiltfilt(signal.butter(4, 4000, "highpass", fs=sr, output="sos"), mono) ** 2
    peak = float(np.max(np.abs(x))) + 1e-12
    edges = [float(np.max(np.abs(x[:, :1]))), float(np.max(np.abs(x[:, -1:])))]
    return {"crest_db": float(20 * np.log10(np.max(np.abs(mid)) / (np.sqrt(np.mean(mid ** 2)) + 1e-12))),
            "centroid_move": float(np.mean(np.abs(np.diff(cen)))) if len(cen) > 1 else 0.0,
            "clicks": float(sum(v > 1e-3 * peak for v in edges)),
            "hf_events": float(clicks(e, sr, skip_s=0.010, floor_db=-35.0)),
            "peak_db": float(20 * np.log10(peak)),
            "edge": max(edges)}


def bank(out_dir: Path, midi: float = 36, beats: float = 2.0, bpm: float = 140.0, sr: int = 48_000) -> None:
    """Every style and variant as a one-shot WAV in `out_dir`, with its QA."""
    import soundfile as sf

    try:
        import pyloudnorm as pyln
        meter = pyln.Meter(sr)
    except ImportError:  # the engine runtime ships without it; LUFS is only a report
        meter = None
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"{'growl':<14}{'crest dB':>9}{'centroid':>9}{'clicks':>7}{'peak dB':>8}{'LUFS':>7}")
    for style in STYLES:
        for v in range(VARIANTS):
            x = render_growl(style, midi, beats, bpm, sr, v)
            sf.write(out_dir / f"{style}-{v + 1}.wav", x.T, sr, subtype="PCM_24")
            m = qa(x, sr)
            lufs = meter.integrated_loudness(x.T.astype(np.float64)) if meter else float("nan")
            print(f"{style}-{v + 1:<{13 - len(style)}}{m['crest_db']:>9.1f}{m['centroid_move']:>9.3f}{m['clicks']:>7.0f}"
                  f"{m['peak_db']:>8.1f}{lufs:>7.1f}")


# ---------------------------------------------------------------------------------------- the growl audition
# Sound Bible §2.2's tearout grid at 145 BPM (1/16 steps): (step, steps long, voice, semitones). Bar 4 is the
# machine-gun bar. The SUB holds under it with a gap at the snare; KICK / SNARE / HATS as §3.1.
TEAROUT_BAR = [(0, 3, "chomp", 0), (6, 1, "chomp", 0), (9, 2, "talker", 0), (12, 1, "talker", 3), (14, 2, "dive", 0)]
MACHINE_GUN = [(0, 2, "chomp", 0), (2, 6, "disperser", 0),
               *[(9 + a, b, "talker", s) for a, b, s in ((0, 1, 0), (1, 1, 3), (2, 0.75, 0), (2.75, 0.75, 5),
                                                         (3.5, 0.5, 0), (4, 0.5, 7), (4.5, 0.5, 0), (5, 0.5, 12))]]
VOICE_BAR = [(0, 3, 0), (6, 1, 0), (9, 2, 0), (12, 1, 3), (14, 2, 0)]  # one voice alone, on the same grid
# fingerprints §2 tearout, one mid voice per step, silence between: H=====--s-s----s / s--s-s--mmmm---- / (call) /
# s--s-s--S===--rr (H = the printed hero; bar 3 calls again from other generations; S = a screaming talker; m / rr =
# the machine gun)
_SHOTS = [(0, 1, "gun", 0), (3, 1, "gun", 0), (5, 1, "gun", 0)]
GUN_BARS = [[(0, 6, "hero", 0), (8, 1, "gun", 0), (10, 1, "gun", 0), (15, 1, "gun", 0)],
            [*_SHOTS, (8, 4, "mgun", 0)],
            [(0, 2, "call", 0), (3, 2, "call", 0), (8, 1, "gun", 0), (10, 1, "gun", 0), (15, 1, "gun", 0)],
            [*_SHOTS, (8, 4, "talker", 12), (14, 2, "mgun", 0)]]
SUB_STEPS = [(0, 7), (9, 7)]  # held, with the gap at the snare
DESCRIBE = {
    "gun": "M1.2/M1.3 gun-shot tearout (fingerprints §2): the printed hero (a held note resampled 3-5x, every generation "
           "layered), 80-200 ms metallic FM shots with silence between, a 1/32 machine gun stepping in pitch, printed calls "
           "and a scream stab; every shot its own state",
    "tearout": "the bible's tearout grid: A chomp calls, B talker answers after the snare, D dives into the next bar; "
               "bar 4 = the machine gun (C disperser x6, a talker ratchet); first hit = the hardest chomp + impact",
    "chomp": "voice A: sine comp chomp (feedback sine + 5th, +24 st pitch env) → dist 24 → OTT 1.0 → clip → OTT 0.5",
    "talker": "voice B: FM ratio 0.5, index + vowels stepped on 1/16 → diode → phaser → OTT",
    "disperser": "voice C: saw chomps through 16-64 allpasses (falling chirps), LP 4 kHz → 300 Hz, retriggered on 1/16",
    "pwm": "voice E: PWM pulse, resonant 24 dB LP 300 Hz → 2.5 kHz decaying over a 1/16, OTT, clip",
    "reese": "7 detuned saws → saturation → OTT → moving low-pass",
    "metal": "FM, frequency-shifted and ring-modulated → fold → OTT: inharmonic",
}


def _drums(n: int, sr: int, bpm: float, bars: int = 4) -> np.ndarray:
    """§3.1, simplified: a kick (body 150 → 52 Hz, 220 ms, plus a click) on 1 (and 7 / 15 on even bars), a clap-led
    snare stack on step 9 (the drop's top peak), 8th hats (16ths on the last beat of even bars)."""
    rng = np.random.default_rng(7)
    step = 15.0 / bpm
    out = np.zeros(n)

    def put(y: np.ndarray, at_step: float, bar: int) -> None:
        i = int(round((bar * 16 + at_step) * step * sr))
        j = min(n, i + len(y))
        if i < n:
            out[i:j] += y[: j - i]

    def burst(ms: float, lo: float | None, hi: float | None, tau: float) -> np.ndarray:
        k = np.arange(int(ms / 1000 * sr)) / sr
        y = rng.standard_normal(len(k)) * np.exp(-k / tau) * (1 - k / k[-1])
        return mb.lr4(y, lo, sr, "highpass") if lo and not hi else signal.sosfilt(signal.butter(2, (lo, hi), "bandpass", fs=sr, output="sos"), y) if hi else y

    k = np.arange(int(0.3 * sr)) / sr
    kick = np.sin(2 * np.pi * np.cumsum(52 + 98 * np.exp(-k / 0.025)) / sr) * np.exp(-k / 0.1) * (1 - k / k[-1])
    click = 0.4 * burst(12, 2000, None, 0.004)  # the click, -8 dB under the body
    kick[: len(click)] += click
    s_ = np.arange(int(0.2 * sr)) / sr
    body = (0.5 * np.sin(2 * np.pi * 185 * s_) + 0.5 * rng.standard_normal(len(s_))) * np.exp(-s_ / 0.05) * (1 - s_ / s_[-1])
    clap = np.zeros(int(0.2 * sr))
    for c in range(3):
        b = burst(12, 900, 1600, 0.004)
        clap[int(c * 0.010 * sr): int(c * 0.010 * sr) + len(b)] += b
    tail = 0.25 * burst(180, 2000, None, 0.06)
    snare = 0.7 * mb.lr4(body, 120, sr, "highpass") + 1.2 * clap + np.pad(tail, (0, max(0, len(clap) - len(tail))))[: len(clap)]
    hat = 0.35 * burst(80, 7000, None, 0.02)
    for bar in range(bars):
        for st in ((0, 6, 14) if bar % 2 else (0,)):
            put(kick, st, bar)
        put(snare / np.max(np.abs(snare)) * 1.05, 8, bar)
        for st in range(0, 16, 2):
            put(hat, st, bar)
        if bar % 2:
            for st in (12, 13, 14, 15):
                put(0.6 * hat, st, bar)
    return out


def _sub_line(n: int, sr: int, bpm: float, midi: int, bars: int = 4) -> np.ndarray:
    """The held SUB (§1.1): the root in 30-60 Hz on SUB_STEPS, ducked -10 dB by the kick (release 130 ms)."""
    step = 15.0 / bpm
    out = np.zeros(n)
    hz = mb.sub_hz(midi)
    for bar in range(bars):
        for st, length in SUB_STEPS:
            i = int(round((bar * 16 + st) * step * sr))
            m = min(n - i, int(round(length * step * sr)))
            out[i:i + m] += mb.sub_voice(hz, m, sr)
    duck = np.ones(n)
    kicks = [(bar * 16 + st) for bar in range(bars) for st in ((0, 6, 14) if bar % 2 else (0,))]
    t_rel = np.arange(int(0.4 * sr)) / sr
    dip = 1 - (1 - 10 ** (-10 / 20)) * np.exp(-t_rel / 0.13)
    for k in kicks[1:]:  # the first hit is not ducked (§1.7: layer the kick instead)
        i = int(round(k * step * sr))
        m = min(n - i, len(dip))
        duck[i:i + m] = np.minimum(duck[i:i + m], dip[:m])
    return out * duck


def _club(mix: np.ndarray, sr: int, st_max_lufs: float = -7.0, ceiling_db: float = -1.2) -> np.ndarray:
    """Club-safe (§1.5): the drop's short-term (3 s) max at -7 LUFS, a look-ahead peak limiter under -1 dBTP (4x
    oversampled peaks), three rounds so the two meet."""
    import pyloudnorm as pyln

    ceiling = 10 ** (ceiling_db / 20)
    meter = pyln.Meter(sr)
    for _ in range(3):
        k = mix.T.copy()
        for stage in meter._filters.values():  # BS.1770 K-weighting
            k = stage.apply_filter(k.T).T
        blk, hop = int(3 * sr), int(0.1 * sr)
        st = max(-0.691 + 10 * np.log10(np.mean(k[i:i + blk] ** 2, axis=0).sum() + 1e-12) for i in range(0, max(1, len(k) - blk), hop))
        mix = mix * 10 ** ((st_max_lufs - st) / 20)
        peak = np.max(np.abs(signal.resample_poly(mix, 4, 1, axis=1)), axis=0).reshape(-1, 4).max(axis=1)[: mix.shape[1]]
        gain = np.minimum(1.0, ceiling / np.maximum(peak, 1e-9))
        gain = ndimage.uniform_filter1d(ndimage.minimum_filter1d(gain, int(0.003 * sr)), int(0.003 * sr))
        mix = mix * np.minimum(gain, 1.0)
    return mix


def _loop(voice: str, v: int, sr: int, bpm: float, root: int, n: int) -> np.ndarray:
    step = 15.0 / bpm
    bus = np.zeros((2, n))
    hit = 0
    for bar in range(4):
        cells = GUN_BARS[bar] if voice == "gun" else (MACHINE_GUN if bar == 3 else TEAROUT_BAR) if voice == "tearout" \
            else [(a, b, voice, s) for a, b, s in VOICE_BAR]
        for st, length, who, semis in cells:
            note = render_growl(who, root + semis, length / 4, bpm, sr, v, sub=False, hit=hit)
            if voice in ("tearout", "gun") and bar == 0 and st == 0:
                note = note * 10 ** (1.5 / 20)  # the first hit is the hardest (§1.7)
            i = int(round((bar * 16 + st) * step * sr))
            bus[:, i:i + note.shape[1]] += note[:, : n - i]
            hit += 1
    return bus


def audition(out_dir: Path, bpm: float = 145.0, root: int = 37, sr: int = 48_000) -> None:
    """4-bar loops at 145 BPM in C# (song-1's key): the tearout grid per variant, and each voice alone, over the held
    sub and §3.1-ish drums, -7 LUFS short-term max under -1 dBTP (club-safe), MP3 320 with a README; prints QA."""
    from pedalboard.io import AudioFile

    out_dir.mkdir(parents=True, exist_ok=True)
    for old in ("riddim", "yoi", "808", "gunshot"):  # S1 owns these now; the old loops go
        for f in out_dir.glob(f"{old}-[0-9].mp3"):
            f.unlink()
    n = int(round(16 * 60.0 / bpm * sr))
    drums, sub = _drums(n, sr, bpm), _sub_line(n, sr, bpm, root)
    t = np.arange(int(0.35 * sr)) / sr
    impact = 0.3 * np.sin(2 * np.pi * np.cumsum(40 + 60 * np.exp(-t / 0.06)) / sr) * np.exp(-t / 0.12) * (1 - t / t[-1])
    impact = np.pad(impact, (0, n - len(impact)))
    lines = [f"FoxBox growl audition (S3): 4 bars at {bpm:g} BPM in C#, over a held clean sub, kick, clap-led snare and",
             "hats. Every sound is built in code (fvwks_synth.growls + midbus), no presets, no AI. Club-safe: -7 LUFS",
             "short-term max, under -1 dBTP. Every hit is its own state (the bible: a tearout drop never repeats a shot).", ""]
    print(f"{'loop':<14}{'LUFS':>7}{'peak':>7}{'joins':>7}")
    for voice in ("gun", "tearout", "chomp", "talker", "disperser", "pwm", "reese", "metal"):
        for v in range(VARIANTS):
            bus = _loop(voice, v, sr, bpm, root, n)
            bass = bus * (0.5 / (np.sqrt(np.mean(bus ** 2)) + 1e-12) * 0.25) + sub * 0.22
            mix = _club(bass + 0.55 * drums + (impact if voice in ("tearout", "gun") else 0), sr)
            name = f"{voice}-{v + 1}.mp3"
            with AudioFile(str(out_dir / name), "w", sr, 2, quality=320) as f:
                f.write(mix.astype(np.float32))
            import pyloudnorm as pyln
            hf = signal.sosfiltfilt(signal.butter(4, 4000, "highpass", fs=sr, output="sos"), mix.mean(axis=0)) ** 2
            print(f"{name[:-4]:<14}{pyln.Meter(sr).integrated_loudness(mix.T):>7.1f}{20 * np.log10(np.max(np.abs(mix))):>7.1f}"
                  f"{clicks(hf, sr):>7d}")
            lines.append(f"{name:<16} {voice.upper()} variant {v + 1}: {DESCRIBE[voice]}")
    (out_dir / "README-S3.txt").write_text("\n".join(lines) + "\n")
    old_readme = out_dir / "README.txt"
    if old_readme.is_file() and "4 bars at" in old_readme.read_text() and "engines x" in old_readme.read_text():
        old_readme.unlink()  # the previous S3 pack's


if __name__ == "__main__":
    if "--bank" in sys.argv:
        rest = [a for a in sys.argv[1:] if a != "--bank"]
        bank(Path(rest[0]) if rest else Path("out/growl-bank"))
    elif "--audition" in sys.argv:
        rest = [a for a in sys.argv[1:] if a != "--audition"]
        audition(Path(rest[0]) if rest else Path("out/growl-audition"))
    else:
        print(__doc__)
