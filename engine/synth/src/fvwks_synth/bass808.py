"""The 808 (docs/REMIX_SOUND_BIBLE.md §2.3, with the user's fix: no +24 st whine at the start) and the trap hybrid's
dark long first hit. Complete renders, not growl engines: mono, click-free, (2, n) float32 at `sr`.

  render_808_line(notes, bpm, sr=48000, variant=0)
      notes [(beat, beats, midi)] as one line. A note that starts before the previous one ends is legato: it glides
      there (AXES "808.glide": 80 ms up to 7 st and 240 ms beyond by default, tighter or lazier by the take; at most
      +-12 st) with no retrigger; any other note retriggers (AXES "808.drop_st" sets its drop).
      Each retrigger is a sine starting on its zero crossing, a small drop onto the note (+5..7 st, settled by 30 ms)
      and a gentle low-pass over the attack. Variants: 0 held (S 90 %, R 150 ms), 1 a trap one-shot (a ~3 s decay),
      2 held and dirtier, 3 a short one-shot. Parallel saturation: the dirty path 4x oversampled, low-passed at
      400 Hz, mixed 0.6, so it reads on small speakers.
  render_808(midi, beats, bpm, sr=48000, variant=0)
      one note of that: render_growl's shape.
  render_darkhit(midi, beats, bpm, sr=48000, variant=0)
      the first drop hit: on pitch from the start, dark and heavy, a slow low-pass bloom (~80 Hz up to 0.8-2 kHz)
      with grit under it (a crushed layer), a long tail. Use it for a beat or more.
"""

from __future__ import annotations

import numpy as np
from scipy import signal

from .midbus import distort
from .riddim import option

#            up st, drop tau s, held, decay s (one-shots: to -60 dB), drive dB
TAKES_808 = ((5.0, 0.008, True, 0.0, 10.0), (7.0, 0.009, False, 3.0, 12.0), (5.0, 0.008, True, 0.0, 14.0),
             (6.0, 0.008, False, 1.2, 12.0))
#               bloom to Hz, bloom over (share of the note), grit, octave layer
TAKES_DARK = ((1200.0, 0.6, 0.18, 0.0), (2000.0, 0.5, 0.3, 0.0), (800.0, 0.9, 0.15, 0.0), (1200.0, 0.6, 0.18, 0.12))
PEAK = 0.9


def _hz(midi: np.ndarray | float) -> np.ndarray | float:
    return 440.0 * 2 ** ((np.asarray(midi) - 69) / 12)


def _edge(n: int, k: int, rising: bool) -> np.ndarray:
    ramp = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, max(1, k)))
    return ramp if rising else ramp[::-1]


# The choices sources disagree on, resolved per take by BUILD (choose()) and passed in as `axes` (riddim.option).
AXES: dict[str, dict[str, float]] = {
    "808.glide": {"tight": 0.3, "bible": 0.4, "lazy": 0.3},  # glide times: up to 7 st / beyond (GLIDES)
    "808.drop_st": {"3": 0.3, "5": 0.5, "7": 0.2},  # the drop onto a retriggered note (unset: the variant's own)
}
GLIDES = {"tight": (0.06, 0.18), "bible": (0.08, 0.24), "lazy": (0.1, 0.3)}


def pitch_line(notes: list[tuple[float, float, float]], bpm: float, sr: int, variant: int = 0,
               axes: dict[str, str] | None = None) -> list[tuple[int, np.ndarray]]:
    """The line as segments (start sample, per-sample MIDI pitch): legato notes glide inside a segment, and each
    segment opens with the take's small drop onto its first note."""
    up, tau = TAKES_808[variant % 4][:2]
    if axes and "808.drop_st" in axes:
        up = float(axes["808.drop_st"])
    glide = GLIDES[option(axes, "808.glide", AXES)]
    spb = 60.0 / bpm * sr
    out: list[tuple[int, np.ndarray]] = []
    notes = sorted(notes)
    i = 0
    while i < len(notes):
        seg = [notes[i]]
        while i + 1 < len(notes) and notes[i + 1][0] < seg[-1][0] + seg[-1][1] - 1e-9:  # overlaps: legato
            i += 1
            seg.append(notes[i])
        i += 1
        a = int(round(seg[0][0] * spb))
        b = int(round((seg[-1][0] + seg[-1][1]) * spb))
        p = np.full(b - a, float(seg[0][2]))
        t = np.arange(b - a) / sr
        p += up * np.exp(-t / tau)  # the drop onto the note (never a glide on a first hit)
        prev = float(seg[0][2])
        for beat, _, midi in seg[1:]:
            k = int(round(beat * spb)) - a
            step = float(np.clip(midi - prev, -12, 12))
            g = int((glide[0] if abs(step) <= 7 else glide[1]) * sr)
            ease = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, g))
            p[k:] = midi
            p[k:k + g] = (midi - step) + step * ease[: len(p[k:k + g])]
            prev = float(midi)
        out.append((a, p))
    return out


def _amp(n: int, sr: int, held: bool, decay: float) -> np.ndarray:
    t = np.arange(n) / sr
    env = 0.9 + 0.1 * np.exp(-t / 0.04) if held else np.exp(-t * 6.9 / decay)  # S 90 %, or -60 dB at `decay`
    env[: int(0.001 * sr)] *= _edge(n, int(0.001 * sr), True)  # 1 ms: A 0 without a corner
    r = min(int((0.15 if held else 0.3) * sr), n // 3)
    env[n - r:] *= _edge(n, r, False)
    return env


def _saturate(x: np.ndarray, drive_db: float, sr: int, starts: list[int]) -> np.ndarray:
    """Parallel saturation: the dirty path (4x oversampled) low-passed at 400 Hz, opening from 150 Hz over each
    attack (a gentle low-pass there, no bright tick), mixed 0.6 under the clean sine."""
    from .growls import _lowpass

    fc = np.full(len(x), 400.0)
    for a in starts:
        k = np.arange(min(int(0.06 * sr), len(x) - a))
        fc[a:a + len(k)] = 400.0 - 250.0 * np.exp(-k / (0.02 * sr))
    return x + 0.6 * _lowpass(distort(x, drive_db, "tanh"), fc, 0.7, sr)


def _out(x: np.ndarray) -> np.ndarray:
    x = x * (PEAK / (np.max(np.abs(x)) + 1e-12))
    return np.stack([x, x]).astype(np.float32)


def render_808_line(notes: list[tuple[float, float, float]], bpm: float, sr: int = 48_000, variant: int = 0,
                    axes: dict[str, str] | None = None) -> np.ndarray:
    if not notes:
        return np.zeros((2, 0), np.float32)
    _, _, held, decay, drive = TAKES_808[variant % 4]
    segs = pitch_line(notes, bpm, sr, variant, axes)
    n = max(a + len(p) for a, p in segs)
    x = np.zeros(n)
    for a, p in segs:
        ph = np.cumsum(_hz(p)) / sr - _hz(p[0]) / sr  # phase 0 at the segment's start: a zero crossing
        x[a:a + len(p)] += np.sin(2 * np.pi * ph) * _amp(len(p), sr, held, decay)
    return _out(_saturate(x, drive, sr, [a for a, _ in segs]))


def render_808(midi: float, beats: float, bpm: float, sr: int = 48_000, variant: int = 0,
               axes: dict[str, str] | None = None) -> np.ndarray:
    return render_808_line([(0.0, beats, midi)], bpm, sr, variant, axes)


def render_darkhit(midi: float, beats: float, bpm: float, sr: int = 48_000, variant: int = 0) -> np.ndarray:
    from .growls import _lowpass

    top, share, grit, octave = TAKES_DARK[variant % 4]
    n = int(round(beats * 60.0 / bpm * sr))
    if n <= 0:
        return np.zeros((2, 0), np.float32)
    t = np.arange(n) / sr
    f = _hz(midi)
    body = np.sin(2 * np.pi * f * t) + octave * np.sin(4 * np.pi * f * t)  # on pitch from the first sample
    env = 0.7 + 0.3 * np.exp(-t / (0.5 * n / sr))
    env[: int(0.0015 * sr)] *= _edge(n, int(0.0015 * sr), True)
    r = min(int(0.3 * sr), n // 3)
    env[n - r:] *= _edge(n, r, False)
    body *= env
    # The bloom: a low-pass on the dirty path opening from 80 Hz to `top` over `share` of the note, easing back a little.
    pos = np.clip(t / (share * n / sr), 0, 1)
    fc = 80.0 * (top / 80.0) ** (np.sin(0.5 * np.pi * pos)) * (1 - 0.25 * np.clip((t - share * n / sr) / (n / sr), 0, 1))
    dirty = distort(body, 16.0, "tanh")
    step = int(sr / 6000)  # grit: 6 kHz sample-and-hold, 6 bits
    crushed = np.round(np.repeat(dirty[::step], step)[:n] * 32) / 32
    wet = _lowpass(_lowpass(dirty + grit * crushed, fc, 0.9, sr), fc, 0.9, sr)
    x = body + 0.7 * wet
    return _out(x)
