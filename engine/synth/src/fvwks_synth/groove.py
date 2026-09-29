"""BASS DNA (contracts BassGroove, v0.11.1) cut to a clip and made ready for either synth. Pure: no surgepy here.

A clip plays `bars` bars of the groove from song bar `start_bar`, transposed by `shift_st`. Each note gets a pitch
curve, (beats into the note, MIDI) points: its `bend` when BASS DNA measured one, else an 808 slide to `glide_to` over
the note's last half beat. `level` (the bounce) and `growl` come as per-beat curves (0-1).
"""

from __future__ import annotations

import base64

import numpy as np

GLIDE_BEATS = 0.5
BEATS_PER_BAR = 4  # ponytail: BassGroove has no meter yet; every REMIX source so far is 4/4


def _curve(b64: str, per_beat: int, first: float, beats: float) -> list[float]:
    if not b64:
        return []
    v = np.frombuffer(base64.b64decode(b64), dtype=np.uint8).astype(np.float32) / 255.0
    a = int(round(first * per_beat))
    return v[a : a + int(round(beats * per_beat))].tolist()


def cut(groove, *, start_bar: int, bars: int, shift_st: float = 0.0) -> dict:
    """The clip's slice of a BassGroove (model or dict): {beats, per_beat, notes, wobble, level, growl}, beats from
    the clip's start. Notes crossing the clip's edges are trimmed to them."""
    g = groove.model_dump() if hasattr(groove, "model_dump") else dict(groove)
    first = (start_bar - int(g["start_bar"])) * BEATS_PER_BAR
    beats = bars * BEATS_PER_BAR
    notes = []
    for n in g.get("notes", []):
        a, b = float(n["beat"]) - first, float(n["beat"]) + float(n["beats"]) - first
        if b <= 0 or a >= beats:
            continue
        a0, b0 = max(0.0, a), min(beats, b)
        if n.get("bend"):
            pts = [(float(t), float(m)) for t, m in n["bend"]]
        elif n.get("glide_to") is not None:
            length = b - a
            pts = [(length - min(GLIDE_BEATS, length / 2), float(n["midi"])), (length, float(n["glide_to"]))]
        else:
            pts = []
        # The curve stays in the note's own time; trimming the start shifts it.
        pts = [(t - (a0 - a), m + shift_st) for t, m in pts]
        notes.append({"beat": a0, "beats": b0 - a0, "midi": float(n["midi"]) + shift_st, "vel": float(n.get("vel", 1.0)), "pitch": pts})
    wobble = [
        {**w, "bar": int(w["bar"]) - (start_bar - int(g["start_bar"]))}
        for w in g.get("wobble", [])
        if 0 <= int(w["bar"]) - (start_bar - int(g["start_bar"])) < bars
    ]
    per_beat = int(g.get("per_beat", 24))
    return {
        "beats": beats,
        "per_beat": per_beat,
        "notes": notes,
        "wobble": wobble,
        "level": _curve(g.get("level_b64", ""), per_beat, first, beats),
        "growl": _curve(g.get("growl_b64", ""), per_beat, first, beats),
    }


def pitch_at(note: dict, t: float) -> float:
    """A note's pitch (MIDI, fractional) `t` beats into it, along its curve."""
    pts = note["pitch"]
    if not pts or t <= pts[0][0]:
        return note["midi"] if not pts or pts[0][0] > 0 else pts[0][1]
    for (t0, m0), (t1, m1) in zip(pts, pts[1:]):
        if t <= t1:
            return m0 + (m1 - m0) * (t - t0) / max(1e-9, t1 - t0)
    return pts[-1][1]


def level_gain(level: list[float], per_beat: int, bpm: float, sr: int, n: int) -> np.ndarray | None:
    """The bounce as a per-sample gain (None: no curve, leave the level alone)."""
    if not level:
        return None
    t = np.arange(n) / sr * bpm / 60.0 * per_beat
    return np.interp(t, np.arange(len(level)), np.asarray(level, np.float32)).astype(np.float32)
