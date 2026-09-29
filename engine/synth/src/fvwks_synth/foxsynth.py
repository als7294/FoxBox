"""FoxBox's own bass synth (1.6 REMIX): the same grooves as the Surge path, in numpy/scipy, so REMIX has basses where
surgepy isn't built (and five patches of its own). One mono voice per note, glides like an 808 slide:

  oscillators (saw / square with detuned unison, sine sub, 2-op FM) → drive → resonant low-pass (its cutoff = the
  patch's + an envelope + the groove's tempo-synced wobble) → amp envelope → stereo spread.

The low-pass is a biquad whose coefficients are updated every BLOCK samples: fast in numpy, smooth enough for bass.
"""

from __future__ import annotations

import math

import numpy as np
from scipy.signal import lfilter

from .groove import BEATS_PER_BAR
from .midbus import CROSSOVER_HZ, lr4

BLOCK = 64
GROWL_OCTAVES = 2.0  # growl 1 opens the filter two octaves (the Surge path: 24 semitones)


def _note_hz(midi: np.ndarray | float) -> np.ndarray | float:
    return 440.0 * 2 ** ((np.asarray(midi) - 69) / 12)


def sync_hz(div: str, bpm: float) -> float:
    """Cycles per second of a note value at `bpm`: '1/4' one per beat, '1/8' two, 'T' triplets, 'D' dotted."""
    base = div.rstrip("TD")
    num, den = (int(v) for v in base.split("/"))
    hz = bpm / 60 * (den / 4) / num
    return hz * 1.5 if div.endswith("T") else hz / 1.5 if div.endswith("D") else hz


def _pitch_track(notes: list[dict], n: int, sr: int, bpm: float) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Per sample: the MIDI pitch (each note along its curve), whether a note is held, the time since its start (s),
    and its velocity (0-1)."""
    spb = 60.0 / bpm
    pitch = np.full(n, np.nan)
    gate = np.zeros(n, bool)
    since = np.full(n, 1e9)
    vel = np.zeros(n)
    for note in sorted(notes, key=lambda x: x["beat"]):
        a = int(note["beat"] * spb * sr)
        b = min(n, int((note["beat"] + note["beats"]) * spb * sr))
        if b <= a:
            continue
        beats_in = np.arange(b - a) / sr / spb
        pts = note["pitch"]
        if pts:
            xp = [t for t, _ in pts]
            fp = [m for _, m in pts]
            if xp[0] > 0:
                xp, fp = [0.0, *xp], [note["midi"], *fp]
            pitch[a:b] = np.interp(beats_in, xp, fp)
        else:
            pitch[a:b] = note["midi"]
        gate[a:b] = True
        since[a:b] = np.arange(b - a) / sr
        vel[a:b] = note.get("vel", 1.0)
    # Between notes the last pitch and velocity hold (the release rings on them).
    idx = np.where(~np.isnan(pitch), np.arange(n), 0)
    np.maximum.accumulate(idx, out=idx)
    return np.nan_to_num(pitch[idx], nan=36.0), gate, since, vel[idx]


def _env(gate: np.ndarray, since: np.ndarray, sr: int, a: float, d: float, s: float, r: float) -> np.ndarray:
    """ADSR per sample (seconds, sustain 0-1), re-triggered by each note; the release is a smoothed fall."""
    att = np.clip(since / max(a, 1e-4), 0, 1)
    dec = s + (1 - s) * np.exp(-np.maximum(since - a, 0) / max(d, 1e-4))
    target = np.where(gate, np.where(since < a, att, dec), 0.0)
    k = math.exp(-1 / (max(r, 1e-3) * sr))  # the release (and any drop) as a one-pole fall
    return lfilter([1 - k], [1, -k], target).astype(np.float64) if r > 0 else target


def _phase(hz: np.ndarray, sr: int) -> np.ndarray:
    return np.cumsum(hz / sr) % 1.0


def _saw(ph: np.ndarray, dt: np.ndarray) -> np.ndarray:
    """A band-limited saw (polyBLEP)."""
    y = 2 * ph - 1
    t = ph / np.maximum(dt, 1e-9)
    y -= np.where(ph < dt, 2 * t - t * t - 1, 0)
    t2 = (ph - 1) / np.maximum(dt, 1e-9)
    y -= np.where(ph > 1 - dt, t2 * t2 + 2 * t2 + 1, 0)
    return y


def _lowpass(x: np.ndarray, cutoff: np.ndarray, q: float, sr: int) -> np.ndarray:
    """A resonant biquad low-pass with its cutoff (Hz, per sample) taken every BLOCK samples."""
    out = np.empty_like(x)
    zi = np.zeros(2)
    for i in range(0, len(x), BLOCK):
        fc = float(np.clip(cutoff[i], 20, sr * 0.45))
        w = 2 * math.pi * fc / sr
        alpha = math.sin(w) / (2 * q)
        c = math.cos(w)
        b = np.array([(1 - c) / 2, 1 - c, (1 - c) / 2]) / (1 + alpha)
        a = np.array([1, -2 * c / (1 + alpha), (1 - alpha) / (1 + alpha)])
        out[i : i + BLOCK], zi = lfilter(b, a, x[i : i + BLOCK], zi=zi)
    return out


def render(p: dict, clip: dict, bpm: float, sr: int = 48_000) -> np.ndarray:
    """A FoxBox patch (`p['params']`) playing a clip (groove.cut()) at `bpm`: (2, n) float32."""
    q = p["params"]
    n = int(round(clip["beats"] * 60.0 / bpm * sr))
    midi, gate, since, vel = _pitch_track(clip["notes"], n, sr, bpm)
    hz = _note_hz(midi + q.get("octave", 0) * 12)

    # 808: the pitch drops from above onto the note at each hit.
    if q.get("pitch_drop"):
        hz = hz * 2 ** (q["pitch_drop"] / 12 * np.exp(-since / q.get("pitch_drop_s", 0.04)))

    dt = hz / sr
    x = np.zeros(n)
    voices = max(1, int(q.get("unison", 1)))
    for v in range(voices):
        spread = (v - (voices - 1) / 2) / max(1, voices - 1) * 2 if voices > 1 else 0
        f = hz * 2 ** (spread * q.get("detune_cents", 0) / 1200)
        ph = (_phase(f, sr) + v / voices) % 1
        if q.get("wave", "saw") == "saw":
            x += _saw(ph, f / sr) / voices
        elif q["wave"] == "square":
            x += (_saw(ph, f / sr) - _saw((ph + 0.5) % 1, f / sr)) / voices
        else:  # 'sine'
            x += np.sin(2 * np.pi * ph) / voices
    if q.get("fm"):
        # 2-op FM: a modulator at `fm_ratio` × the note, its index swept by the wobble below.
        x = x * (1 - q.get("fm_mix", 0.7))

    # The wobble: a tempo-synced LFO, bar by bar (rate, depth, shape).
    lfo = np.zeros(n)
    wob = sorted(clip["wobble"], key=lambda w: w["bar"])
    t = np.arange(n) / sr
    for i, w in enumerate(wob):
        a = int(int(w["bar"]) * BEATS_PER_BAR * 60 / bpm * sr)
        b = int(int(wob[i + 1]["bar"]) * BEATS_PER_BAR * 60 / bpm * sr) if i + 1 < len(wob) else n
        a, b = max(0, a), min(n, b)
        if b <= a:
            continue
        # `phase` is the LFO's phase at the bar line, 0 = its peak.
        ph = ((t[a:b] - t[a]) * sync_hz(w.get("div", "1/8"), bpm) + float(w.get("phase", 0.0))) % 1
        shape = w.get("shape", "sine")
        wave = (
            np.sign(np.sin(2 * np.pi * ph)) if shape.startswith("square")
            else 1 - 2 * ph if shape.startswith("saw")
            else 1 - 4 * np.abs(ph - 0.5) if shape.startswith("tri")
            else np.cos(2 * np.pi * ph)
        )
        lfo[a:b] = (wave + 1) / 2 * float(w.get("depth", 0.5))

    if q.get("fm"):
        index = q.get("fm_index", 2.0) * (0.3 + lfo * 2.5)
        mod = np.sin(2 * np.pi * _phase(hz * q.get("fm_ratio", 2.0), sr))
        x += q.get("fm_mix", 0.7) * np.sin(2 * np.pi * _phase(hz, sr) + index * mod)

    if q.get("drive"):
        x = np.tanh(x * (1 + q["drive"] * (1 + 2 * lfo))) / math.tanh(1 + q["drive"])

    fenv = _env(gate, since, sr, 0.002, q.get("filter_decay", 0.3), 0.0, 0.05)
    growl = np.zeros(n)
    if clip.get("growl"):
        beat_pos = np.arange(n) / sr * bpm / 60.0 * clip["per_beat"]
        growl = np.interp(beat_pos, np.arange(len(clip["growl"])), clip["growl"])
    cutoff = q.get("cutoff", 400) * 2 ** (q.get("env_amount", 2.0) * fenv + q.get("wobble_octaves", 4.0) * lfo + GROWL_OCTAVES * growl)
    y = _lowpass(x, cutoff, q.get("resonance", 1.2), sr)
    amp = _env(gate, since, sr, q.get("attack", 0.003), q.get("decay", 0.4), q.get("sustain", 0.9), q.get("release", 0.08))
    y = y * amp * (0.35 + 0.65 * vel) * q.get("gain", 0.7)
    # One owner of the low end (Sound Bible §1.1): an 808 patch (a sine body) IS the low end; every other patch is a mid
    # layer, LR4 high-passed at 120 Hz, over a clean sine sub (the note folded into 30-60 Hz, continuous phase through
    # glides, gated A 2.5 ms / R 15 ms). The sub never goes through the drive, the filter or the wobble.
    if q.get("wave", "saw") != "sine":
        y = lr4(y, CROSSOVER_HZ, sr, "highpass")
        if q.get("sub", 0):
            f_sub = hz / 2 ** np.floor(np.log2(np.maximum(hz, 1e-3) / 30.0))
            sub = lr4(np.sin(2 * np.pi * np.cumsum(f_sub) / sr), CROSSOVER_HZ, sr, "lowpass")
            y = y + 0.7 * q["sub"] * q.get("gain", 0.7) * sub * _env(gate, since, sr, 0.0025, 1.0, 1.0, 0.015)
    width = q.get("width", 0.0)
    side = lr4(np.roll(y, int(0.004 * sr)), 150.0, sr, "highpass") * width  # air above 150 Hz, never in the sub
    return np.stack([y + side, y - side]).astype(np.float32)
