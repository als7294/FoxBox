"""1.6 REMIX: the harmonic plan of a drop (REMIX_HARMONY 1.5 / 5.3 / 6.5). The source's harmony, our rhythm and sound.

options(style, skeleton) -> {option: weight}     the take's harmony.progression choices for a style: "source" (the
                                                 source drop's own chords, style-transformed) when it has them, and
                                                 the style's templates (1.5 PLANS)
drop_plan(style, option, bars, tonic, minor, skeleton) -> [Chord]
                                                 one Chord per drop bar ("x/y" symbols fill root2 / quality2 for the
                                                 second half-bar); bar 1 on `tonic` (the source drop's bar-1 root,
                                                 1.3 rule 2)

Style transforms of the source skeleton (1.5 "the source always wins"; its roots per half-bar are the source bass's,
6.5): riddim collapses it to a pedal on its tonic and keeps its commonest other root as a 4-bar lift at bars 9-12;
tearout keeps its last two roots as the turnaround in bars 7-8 and 15-16 (VI - VII on a pedal source); trap-hybrid
and halftime play it as is, the source's 808 under the engine (a shorter skeleton loops).
"""

from __future__ import annotations

from collections import Counter

from fvwks_contracts.models import Chord

from ..music import _NAMES

DEGREE = {"i": (0, "m"), "bII": (1, "M"), "III": (3, "M"), "iv": (5, "m"), "v": (7, "m"), "V": (7, "M"), "VI": (8, "M"),
          "VII": (10, "M")}
PLANS: dict[str, dict[str, tuple[float, list[str]]]] = {
    "riddim": {"pedal": (0.50, ["i"] * 16), "lift_iv": (0.25, ["i"] * 8 + ["iv"] * 4 + ["i"] * 4),
               "phrygian": (0.25, ["i"] * 7 + ["i/bII"] + ["i"] * 7 + ["i/bII"])},
    "tearout": {"vi_vii": (0.50, ["i"] * 6 + ["VI", "VII"] + ["i"] * 6 + ["VI", "VII"]),
                "phrygian_v": (0.30, ["i"] * 7 + ["i/bII"] + ["i"] * 7 + ["VI/V"]), "pedal": (0.20, ["i"] * 16)},
    "trap_hybrid": {"loop": (1.0, ["i", "i", "VI", "VI", "iv", "iv", "VII", "VII"] * 2)},
    "halftime": {"loop": (1.0, ["i", "i", "VI", "VI", "VII", "VII", "i", "i"] * 2)},
}
STYLE_PLAN = {"riddim": "riddim", "tearout": "tearout", "trap_hybrid": "trap_hybrid", "hybrid": "trap_hybrid",
              "halftime": "halftime", "dubstep140": "halftime"}  # the take style -> its plan family
SOURCE_W = 0.7  # "the source always wins": its share of the draw when it has chords (ratings may still move it)


def family(style: str) -> str:
    return STYLE_PLAN.get(style, "halftime")


def options(style: str, skeleton: list[Chord] | None) -> dict[str, float]:
    t = {k: w for k, (w, _) in PLANS[family(style)].items()}
    if not skeleton or all(c.root is None for c in skeleton):
        return t
    return {"source": SOURCE_W, **{k: (1 - SOURCE_W) * w / sum(t.values()) for k, w in t.items()}}


def _chord(tonic: int, minor: bool, sym: str) -> tuple[str, str]:
    semis, q = DEGREE[sym]
    quality = ("min" if minor else "maj") if sym == "i" else {"m": "min", "M": "maj", "5": "5"}[q]
    return _NAMES[(tonic + semis) % 12], quality


def _from_symbols(syms: list[str], bars: int, tonic: int, minor: bool) -> list[Chord]:
    out = []
    for b in range(bars):
        a, _, c = syms[b % len(syms)].partition("/")
        r, q = _chord(tonic, minor, a)
        r2, q2 = _chord(tonic, minor, c) if c else (None, None)
        out.append(Chord(root=r, quality=q, root2=r2, quality2=q2))
    return out


def drop_plan(style: str, option: str, bars: int, tonic: int, minor: bool, skeleton: list[Chord] | None) -> list[Chord]:
    fam = family(style)
    if option != "source" or not skeleton:
        syms = PLANS[fam].get(option, next(iter(PLANS[fam].values())))[1]
        return _from_symbols(syms, bars, tonic, minor)
    pc = [None if c.root is None else _NAMES.index(c.root) for c in skeleton]
    tonic_chord = Chord(root=_NAMES[tonic], quality="min" if minor else "maj")
    others = Counter(r for r in pc if r is not None and r != tonic)
    if fam == "riddim":  # a pedal on the tonic, its commonest other root as the lift (bars 9-12)
        lift = others.most_common(1)[0][0] if others else None
        out = [tonic_chord] * bars
        if lift is not None:
            src = next(c for c, r in zip(skeleton, pc) if r == lift)
            out = [src if 8 <= b < 12 else tonic_chord for b in range(bars)]
        return out
    if fam == "tearout":  # a pedal, the source's last two roots as the turnaround at bars 7-8 and 15-16
        turn = [c for c, r in zip(skeleton, pc) if r is not None and r != tonic][-2:]
        if len(turn) < 2:  # a pedal source: the template's VI - VII turnaround (5.2: the drop still turns at 7-8, 15-16)
            turn = _from_symbols(["VI", "VII"], 2, tonic, minor)
        return [turn[b % 8 - 6] if b % 8 >= 6 else tonic_chord for b in range(bars)]
    if not any(c.root for c in skeleton):  # trap-hybrid / halftime: as is (the kept 808 plays exactly this)
        return _from_symbols(PLANS[fam]["loop"][1], bars, tonic, minor)
    return [skeleton[b % len(skeleton)] for b in range(bars)]
