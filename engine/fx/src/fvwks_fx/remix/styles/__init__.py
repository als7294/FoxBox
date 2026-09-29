"""1.6 REMIX styles as data (plan M1.7) and the take's variation axes (M2.2).

Each `<style>.json` holds a GENRE FLIP style's drum patterns (`drums`: option -> {hits, alt}, [beat, voice, vel] rows),
its engine axes (`axes`: {axis: {option: default weight}}) and which of the voices' own axes it passes down (`synth`:
{patch prefix: [axis ids from fvwks_synth.growls.AXES]}). `common.json` holds the axes every style shares (drop.*).
A weight of 0 is declared but inactive (an option waiting on the corpus QA).

resolve(remix, style, patch, choose) -> [TakeChoice]: every axis once per take. `choose(axis, {option: weight}) ->
option` is the server's (it replays a kept take and draws from the ratings); without it a kept take (remix.takes, by
seed) replays its record and a new seed draws each axis from its own stream (seed, axis id), so adding an axis never
reshuffles the others. choice(remix, axis) reads a take's option back for prepare and mixdown.
"""

from __future__ import annotations

import datetime as _dt
import json
import zlib
from functools import cache
from importlib import resources
from typing import Callable

import numpy as np

from fvwks_contracts.models import Remix, RemixTake, TakeChoice

Choose = Callable[[str, dict[str, float]], str]


@cache
def load(style: str) -> dict:
    f = resources.files(__name__) / f"{style}.json"
    return json.loads(f.read_text()) if f.is_file() else {}


@cache
def flip_styles() -> dict[str, dict]:
    """The GENRE FLIP styles (every style file with drums), in their `order`: {id: {name, bpm, half_time, drums}}."""
    names = [f.name[:-5] for f in resources.files(__name__).iterdir() if f.name.endswith(".json")]
    return {k: load(k) for k in sorted((n for n in names if "drums" in load(n)), key=lambda n: load(n).get("order", 99))}


def pattern(style: str, drums: str | None = None) -> dict:
    """A flip style's drum pattern: {hits, alt?} as (beat, voice, vel) tuples, for the take's drums option."""
    opts = flip_styles()[style]["drums"]
    p = opts.get(drums) or next(iter(opts.values()))
    return {k: [tuple(h) for h in v] for k, v in p.items()}


def axes(style: str, patch: str | None = None) -> dict[str, dict[str, float]]:
    """The take-level axes for a style (and bass patch): the shared drop axes, the style's own, the voices' it uses."""
    out = {**load("common").get("axes", {}), **load(style).get("axes", {})}
    synth = [a for prefix, ids in load(style).get("synth", {}).items() if patch and patch.startswith(prefix) for a in ids]
    if synth:
        try:
            from fvwks_synth.growls import AXES
        except ImportError:
            AXES = {}
        out.update({a: AXES[a] for a in synth if a in AXES})
    return out


def _draw(seed: int, axis: str, opts: dict[str, float]) -> str:
    live = {o: w for o, w in opts.items() if w > 0} or opts
    w = np.asarray(list(live.values()), float)
    return list(live)[int(np.random.default_rng([int(seed), zlib.crc32(axis.encode())]).choice(len(live), p=w / w.sum()))]


def take_style(remix: Remix) -> str:
    """What ratings count under: the flip's style, else the bass patch's (riddim / tearout / trap_hybrid / hybrid)."""
    if remix.recipe == "flip" and remix.flip is not None:
        return remix.flip.style_id
    kind, _, arg = (remix.bass_patch_id or "").partition(":")
    return {"riddim": "riddim", "hybrid": "hybrid", "808": "trap_hybrid", "resample": arg or "trap_hybrid"}.get(kind, remix.recipe)


def resolve(remix: Remix, style: str, patch: str | None = None, choose: Choose | None = None) -> list[TakeChoice]:
    kept = next((t for t in remix.takes if t.seed == remix.seed), None)
    rec = {c.axis: c.option for c in kept.choices} if kept else {}
    out = []
    for axis, opts in axes(style, patch).items():
        if choose is not None:
            opt = choose(axis, dict(opts))
        elif rec.get(axis) in opts:
            opt = rec[axis]
        else:
            opt = _draw(remix.seed, axis, opts)
        out.append(TakeChoice(axis=axis, option=str(opt)))
    return out


def record(remix: Remix, style: str, choices: list[TakeChoice]) -> list[RemixTake]:
    """remix.takes with the take for remix.seed added or refreshed (its name, star and rating kept)."""
    takes = list(remix.takes)
    i = next((k for k, t in enumerate(takes) if t.seed == remix.seed), None)
    if i is None:
        now = _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")
        takes.append(RemixTake(seed=remix.seed, style=style, choices=choices, created_at=now))
    else:
        takes[i] = takes[i].model_copy(update={"style": style, "choices": choices})
    return takes


def choice(remix: Remix, axis: str) -> str | None:
    """The take's option on an axis: its record (remix.takes for remix.seed), else the seeded default draw (a doc
    built before the axis existed), else None (an axis no style declares)."""
    kept = next((t for t in remix.takes if t.seed == remix.seed), None)
    for c in kept.choices if kept else ():
        if c.axis == axis:
            return c.option
    opts = axes(take_style(remix), remix.bass_patch_id).get(axis)
    return _draw(remix.seed, axis, opts) if opts else None


def synth_axes(remix: Remix) -> dict[str, str]:
    """The take's recorded options on the voices' own axes (fvwks_synth.growls.AXES ids), for render_growl(axes=)."""
    try:
        from fvwks_synth.growls import AXES
    except ImportError:
        return {}
    kept = next((t for t in remix.takes if t.seed == remix.seed), None)
    return {c.axis: c.option for c in (kept.choices if kept else ()) if c.axis in AXES}
