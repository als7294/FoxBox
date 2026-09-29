"""Surge XT, rendering one groove. Run by surge.py as a child process: it has its own HOME (Surge makes its user
folders there, never in the user's Documents), and a native crash can't take the engine down.

stdin: JSON {patch, sr, bpm, clip}: `clip` is groove.cut()'s (beats, per_beat, notes with pitch curves, wobble, growl).
stdout: one JSON line {"channels": 2, "frames": n}, then n × 2 float32 (channel-major).
"""

from __future__ import annotations

import json
import math
import sys
from collections import defaultdict
import os
from pathlib import Path

import numpy as np

sys.path.insert(0, os.environ.get("FVWKS_SURGEPY_DIR") or str(Path(__file__).parent / "_native"))
from fvwks_synth.groove import BEATS_PER_BAR, pitch_at  # noqa: E402
import surgepy  # noqa: E402  (the built module lives in _native/)

BEND_RANGE = 24  # semitones either way: glides of up to two octaves
GROWL_ST = 24  # growl 1 opens the wobble's filter this many semitones
WOBBLE_DEPTH = 0.6  # a groove wobble at depth 1: its LFO -> filter 1 cutoff at this much of its range
LFO_SOURCES = ("ms_lfo1", "ms_lfo2", "ms_lfo3", "ms_lfo4", "ms_lfo5", "ms_lfo6")


def sync_rate(div: str) -> float:
    """A tempo-synced LFO rate for a note value: '1/4' is 1, '1/8' is 2 (log2 steps); 'T' triplets, 'D' dotted."""
    base = div.rstrip("TD")
    value = math.log2(int(base.split("/")[1]) / int(base.split("/")[0])) - 1
    if div.endswith("T"):
        value += math.log2(1.5)
    elif div.endswith("D"):
        value -= math.log2(1.5)
    return value


def shape_value(s, param, name: str) -> float | None:
    """The LFO shape whose name starts with `name` ('sine', 'square', 'saw', …), or None."""
    lo, hi = int(s.getParamMin(param)), int(s.getParamMax(param))
    for v in range(lo, hi + 1):
        s.setParamVal(param, v)
        if s.getParamDisplay(param).lower().startswith(name.lower()):
            return v
    return None


def free_lfo(s, scene: int) -> int:
    """The first voice LFO this scene doesn't use (its own movement stays as designed); LFO 6 if all are taken."""
    routes = s.getAllModRoutings().get("scene", [])
    mine = routes[scene] if scene < len(routes) else {}
    used = {r.getSource().getName() for r in mine.get("voice", []) + mine.get("scene", [])}
    return next((i for i in range(6) if f"Voice LFO {i + 1}" not in used), 5)


def wobble_target(s, sc):
    """What a wobble moves: the first low-pass filter's cutoff, else the first active filter's, else the level."""
    types = [s.getParamDisplay(f["type"]) for f in sc["filterunit"]]
    for i, t in enumerate(types):
        if t.startswith("LP"):
            return sc["filterunit"][i]["cutoff"]
    for i, t in enumerate(types):
        if t != "Off":
            return sc["filterunit"][i]["cutoff"]
    return sc["vca_level"]


def render(job: dict) -> np.ndarray:
    sr, bpm = int(job["sr"]), float(job["bpm"])
    s = surgepy.createSurge(sr)
    s.setTempo(bpm)
    s.loadPatch(job["patch"])
    patch = s.getPatch()
    # A layered patch (Dual / Split) plays both scenes: each gets the bend range and its own wobble.
    scenes = [0] if s.getParamDisplay(patch["scenemode"]) == "Single" else [0, 1]
    wobblers = []
    for i in scenes:
        sc = patch["scene"][i]
        s.setParamVal(sc["pbrange_up"], BEND_RANGE)
        s.setParamVal(sc["pbrange_dn"], BEND_RANGE)
        k = free_lfo(s, i)
        wobblers.append((i, sc["lfo"][k], wobble_target(s, sc), s.getModSource(getattr(surgepy.constants, LFO_SOURCES[k]))))

    clip = job["clip"]
    bs = s.getBlockSize()
    per_beat = sr * 60.0 / bpm / bs  # blocks per beat
    blocks = math.ceil(clip["beats"] * 60.0 / bpm * sr / bs)
    events: dict[int, list] = defaultdict(list)

    def at(beat: float) -> int:
        return min(blocks - 1, max(0, round(beat * per_beat)))

    def bend_to(semis: float) -> int:
        return round(8191 * max(-1.0, min(1.0, semis / BEND_RANGE)))

    for n in clip["notes"]:
        key = int(round(n["midi"]))
        vel = max(1, min(127, round(n["vel"] * 127)))
        on, off = at(n["beat"]), at(n["beat"] + n["beats"])
        start = bend_to(pitch_at(n, 0.0) - key)
        events[on].append(lambda key=key, vel=vel, start=start: (s.pitchBend(0, start), s.playNote(0, key, vel, 0)))
        events[off].append(lambda key=key: s.releaseNote(0, key, 0))
        last = start
        for blk in range(on + 1, off):  # the pitch curve: a bend event only where it moves
            bend = bend_to(pitch_at(n, (blk - on) / per_beat) - key)
            if bend != last:
                events[blk].append(lambda bend=bend: s.pitchBend(0, bend))
                last = bend

    for w in clip["wobble"]:

        def wobble(w=w):
            for scene, lfo, target, source in wobblers:
                s.setTempoSync(lfo["rate"], True)
                s.setParamVal(lfo["rate"], sync_rate(w.get("div", "1/8")))
                if w.get("shape") and (v := shape_value(s, lfo["shape"], w["shape"])) is not None:
                    s.setParamVal(lfo["shape"], v)
                # ponytail: phase applies from the next note on (key-triggered LFOs restart there), not at the bar line.
                s.setParamVal(lfo["start_phase"], float(w.get("phase", 0.0)))
                s.setModDepth01(target, source, float(w.get("depth", 0.5)) * WOBBLE_DEPTH, scene)

        events[at(int(w["bar"]) * BEATS_PER_BAR)].append(wobble)

    # Growl: the wobble's filter opens with it (a cutoff offset, per curve step, only where it changes).
    growl = clip.get("growl") or []
    targets = [(t, s.getParamVal(t)) for _, _, t, _ in wobblers if "Cutoff" in repr(t)]
    last_g = None
    for k, g in enumerate(growl):
        q = round(g * 32) / 32
        if q != last_g and targets:
            events[at(k / clip["per_beat"])].append(lambda q=q: [s.setParamVal(t, base + q * GROWL_ST) for t, base in targets])
            last_g = q

    out = s.createMultiBlock(blocks)
    b = 0
    for e in sorted(events):
        if e > b:
            s.processMultiBlock(out, b, e - b)  # nothing changes in between: let Surge run
        for act in events[e]:
            act()
        s.processMultiBlock(out, e, 1)
        b = e + 1
    if b < blocks:
        s.processMultiBlock(out, b, blocks - b)
    return np.ascontiguousarray(out, dtype=np.float32)


def main() -> None:
    audio = render(json.load(sys.stdin))
    sys.stdout.buffer.write((json.dumps({"channels": audio.shape[0], "frames": audio.shape[1]}) + "\n").encode())
    sys.stdout.buffer.write(audio.tobytes())


if __name__ == "__main__":
    main()
