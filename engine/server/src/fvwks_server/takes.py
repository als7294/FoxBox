"""REMIX takes (v0.11.8, M4.3; plan v2 §7.3-§7.4, §7.7): what ROLL learns from the user's ratings. Plain counting, no AI.

Counts: every take counts once, from its latest feedback since the style's last RESET (a re-rating replaces the earlier
one, a rating of 0 withdraws it; the history rows stay). 👍 +1 up on every option the take used (LOVE IT +2). 👎 +1 down
on the axes its tags blame (§7.4) and +0.25 on the take's other axes; with no tags, +0.5 on every axis.

The draw, for a new seed (BUILD asks `choose(axis, {option: default weight})`): θ ~ Beta(1 + up, 1 + down) per option,
p ∝ weight · θ, every live option floored at 5 % (there isn't one right answer), then one draw, all on the axis's own
stream seeded by (seed, axis). A kept take replays its recorded option instead: a take never changes.
"""

from __future__ import annotations

import zlib
from collections.abc import Callable, Iterable

import numpy as np
from fvwks_contracts.models import RemixPrefs, TakeChoice, TakeFeedback

# §7.4: the axes each tag's 👎 blames in full (AX numbers → axis ids, §4.3)
_AX = {1: "drop.gap", 3: "drop.pause", 4: "drop.pause_len", 5: "drop.fill", 6: "drop.cadence", 7: "drop.end",
       9: "mix.mid_duck", 10: "mix.sub_duck", 11: "mix.808_duck", 12: "mix.ott", 13: "mix.drum_clip",
       14: "riddim.drums", 15: "riddim.grid", 16: "riddim.lfo", 17: "riddim.r2", 18: "riddim.sub", 19: "riddim.drive",
       20: "riddim.half2", 21: "top.layer", 22: "tearout.order", 23: "tearout.grid", 24: "tearout.second",
       26: "tearout.chomp_snap", 27: "hybrid.first_len", 28: "hybrid.first_growl", 29: "trap.mids", 32: "808.glide"}
_RESAMPLE = {"resample.passes", "resample.movement", "resample.mangle"}  # AX-25
TAG_AXES: dict[str, set[str]] = {
    "growls": {_AX[n] for n in (22, 23, 24, 26, 17, 19, 12, 29)} | _RESAMPLE,
    "rhythm": {_AX[n] for n in (14, 15, 16, 23, 5, 6)},
    "mix": {_AX[n] for n in (9, 10, 11, 12, 13)},
    "arrangement": {_AX[n] for n in (3, 4, 6, 7, 20, 24, 28)},
    "sounds_like_trap": {_AX[n] for n in (14, 15, 16, 18)},
    "too_long": {_AX[n] for n in (1, 4, 27)},
    "whiny": {_AX[n] for n in (26, 27, 21, 32)},
    "boring": {_AX[n] for n in (6, 20, 24, 21, 22)},
}
FLOOR = 0.05


def prefs_from(feedback: Iterable[TakeFeedback], style: str) -> RemixPrefs:
    """One style's counts from its feedback rows (oldest first, already filtered to after its last RESET)."""
    latest: dict[tuple[str, int], TakeFeedback] = {}
    for f in feedback:
        if f.style == style:
            latest[(f.remix_id, f.seed)] = f
    counts: dict[str, dict[str, list[float]]] = {}
    rated = 0
    for f in latest.values():
        if f.rating == 0:
            continue  # withdrawn
        rated += 1
        tags = [t for t in f.tags if not (t == "sounds_like_trap" and style == "trap_hybrid")]
        blamed = set().union(*(TAG_AXES.get(t, set()) for t in tags))
        for c in f.choices:
            cell = counts.setdefault(c.axis, {}).setdefault(c.option, [0.0, 0.0])
            if f.rating > 0:
                cell[0] += 2.0 if "love_it" in f.tags else 1.0
            else:
                cell[1] += (1.0 if c.axis in blamed else 0.25) if tags else 0.5
    return RemixPrefs(style=style, ratings=rated,
                      axes=[{"axis": a, "options": [{"option": o, "up": u, "down": d} for o, (u, d) in opts.items()]}
                            for a, opts in counts.items()])


def shares(weights: np.ndarray, theta: np.ndarray) -> np.ndarray:
    """§7.3 steps 2-3: p ∝ w·θ, every live option (w > 0) floored at 5 %, renormalized."""
    live = weights > 0  # weight 0: declared, not live yet (a prior mask: never drawn)
    if not live.any():
        return np.full(len(weights), 1.0 / len(weights))  # nothing live: the engine shouldn't ask, but never divide by 0
    p = weights * theta
    p = p / p.sum() if p.sum() > 0 else live / live.sum()
    p = np.where(live, np.maximum(p, FLOOR), 0.0)
    return p / p.sum()


def chooser(seed: int, recorded: list[TakeChoice], prefs: list[RemixPrefs]
            ) -> tuple[Callable[[str, dict[str, float]], str], dict[str, str]]:
    """BUILD's `choose(axis, {option: default weight}) -> option`, and the {axis: option} it fills, in asking order."""
    fixed = {c.axis: c.option for c in recorded}
    table: dict[str, dict[str, list[float]]] = {}
    for p in prefs:  # the style's prefs (or all styles' when BUILD can't know the style yet: the axis ids carry it)
        for a in p.axes:
            for o in a.options:
                cell = table.setdefault(a.axis, {}).setdefault(o.option, [0.0, 0.0])
                cell[0], cell[1] = cell[0] + o.up, cell[1] + o.down
    made: dict[str, str] = {}

    def choose(axis: str, options: dict[str, float]) -> str:
        if axis in made:
            return made[axis]
        pick = fixed.get(axis)
        if pick not in options:
            rng = np.random.default_rng([seed, zlib.crc32(axis.encode())])
            keys = list(options)
            counts = table.get(axis, {})
            theta = np.array([rng.beta(1 + counts.get(k, (0, 0))[0], 1 + counts.get(k, (0, 0))[1]) for k in keys])
            pick = keys[int(rng.choice(len(keys), p=shares(np.array([options[k] for k in keys], float), theta)))]
        made[axis] = pick
        return pick

    return choose, made
