"""1.6 REMIX: the drop's hook (REMIX_HARMONY 3), as notes: DSP-free, seeded.

motif(chord_at, bars, key, rng, pcs=None) -> [(beat, beats, midi)]
  One 1-bar motif (3-6 onsets from 2-3 rhythm cells, range <= 9 st): chord tones on the strong steps (beats 1, 2, 4),
  diatonic passing tones on the weak ones, moving mostly by step; sequenced through the plan's chords as the phrase
  A A' A B (A' ends on the 5th: the question; B ends on the root with its longest note: the answer), played twice over
  8 bars with bar 8 up an octave. `pcs`, the source hook's pitch classes, are preferred for the passing tones (3.2
  "source first"). Nothing starts in the snare window (beats 1.75-2.25). MIDI around C4-C5; the voice lifts it.
squeak(chord_at, bars) -> [(beat, beats, midi)]
  Riddim's squeak (3.3): the wub's responses, on R or 5 only.
chord_at(bar, beat) -> (root pc, third) as prepare's chord().
"""

from __future__ import annotations

import numpy as np

from ..music import parse_key

CELLS = [[(0.0, 0.5)], [(1.0, 0.25), (1.25, 0.25)], [(1.5, 0.25)], [(2.5, 0.25), (2.75, 0.25)], [(3.0, 0.5), (3.5, 0.5)],
         [(3.0, 0.75)]]  # rhythm cells (beat, beats); the first (the downbeat) always plays
STRONG = (0.0, 1.0, 3.0)
BASE = 60  # C4


def _chord_tones(root: int, third: int) -> list[int]:
    return [root % 12, (root + third) % 12, (root + 7) % 12]


def _near_pc(pc: int, around: float) -> int:
    return int(round(around + ((pc - around + 6) % 12 - 6)))


def _rhythm(rng: np.random.Generator) -> list[tuple[float, float]]:
    extra = list(rng.choice(np.arange(1, len(CELLS)), size=int(rng.integers(1, 3)), replace=False))
    hits = sorted({h for i in [0, *extra] for h in CELLS[int(i)]})
    if len(hits) < 3:  # at least 3 onsets
        hits = sorted({*hits, *CELLS[4]})
    return hits[:6]


def _bar(rhythm, root: int, third: int, scale: list[int], pcs: set[int] | None, start: float, end_on: int | None,
         rng: np.random.Generator) -> list[tuple[float, float, int]]:
    """One bar of the motif over a chord: strong steps on chord tones, weak steps a scale step from the last note."""
    tones = _chord_tones(root, third)
    prefer = [p for p in scale if pcs and p in pcs] or scale
    out, prev = [], start
    for i, (b, d) in enumerate(rhythm):
        last = i == len(rhythm) - 1
        if last and end_on is not None:
            m = _near_pc((root + end_on) % 12, prev)
        elif b in STRONG:
            m = min((_near_pc(t, prev) for t in tones), key=lambda x: (abs(x - prev), x))
        else:  # a passing tone: the next scale note up or down (the source's pitch set first)
            step = 1 if rng.random() < 0.5 else -1
            cands = sorted({_near_pc(p, prev) for p in prefer}, key=lambda x: (abs(x - prev - step * 2), x))
            m = next((c for c in cands if c != prev), cands[0])
        m = BASE - 2 + (m - (BASE - 2)) % 12  # folded by octaves into its 12-note window (the pitch class kept)
        out.append((b, d, m))
        prev = m
    return out


def motif(chord_at, bars: int, key: str | None, rng: np.random.Generator, pcs: set[int] | None = None
          ) -> list[tuple[float, float, int]]:
    k = parse_key(key)
    scale = list(k.scale)
    rhythm = _rhythm(rng)
    notes: list[tuple[float, float, int]] = []
    for bar in range(bars):
        pos = bar % 4  # A A' A B
        root, third = chord_at(bar, 0.0)
        end_on = 7 if pos == 1 else 0 if pos == 3 else None
        rhy = list(rhythm)
        if pos == 3:  # the answer ends on the root with its longest note
            b, _ = rhy[-1]
            rhy[-1] = (b, 4.0 - b)
        start = BASE + (notes[-1][2] - BASE if notes else (root % 12))
        one = _bar(rhy, root, third, scale, pcs, start, end_on, rng)
        lift = 12 if bar % 8 == 7 else 0  # bar 8 up an octave
        notes += [(4 * bar + b, d, m + lift) for b, d, m in one]
    return notes


def squeak(chord_at, bars: int) -> list[tuple[float, float, int]]:
    from .resample import RIDDIM_H, _deg

    out = []
    for bar in range(bars):
        for b, d, degree, role in RIDDIM_H[bar % 2]:
            if role != "resp":
                continue
            root, third = chord_at(bar, b)
            deg = 7 if degree == "5" else 0  # R or 5 only
            out.append((4 * bar + b, d, 36 + root + deg + (_deg("8", third) if degree == "8" else 0)))
    return out
