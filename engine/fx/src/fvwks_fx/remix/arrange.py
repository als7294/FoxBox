"""1.6 REMIX: BUILD, a recipe to a draft arrangement. It only lays sections and clips on the remix's bar grid (bar 1 =
beat 0); prepare.py renders the clips.

build(remix, songs, match=None, vip_drop=False, drum_hits=None) fills remix.bpm / key / sections / lanes from the
source songs (`songs`: slot → Song with its analysis and structure):
  vip     A's sections as they are. In every drop, A's bass stem gives way to its BASS DNA groove on
          remix.bass_patch_id (the synth_bass lane); drums, vocals and other stay. `vip_drop` plays the last drop
          again as a VIP drop.
  mashup  A's sections with B's matched part (remix.mash, LINE IT UP's pick, else `match`; shifted shift_st, and
          prepare stretches it to A's tempo), by the part's kind: B's drop replaces A's next drop from the matched part
          (A's vocals run over it); B's vocals go over A's drop; B's build replaces the section before A's drop. One
          bass at a time, and short fades where the source changes.
  flip    A's sections at the source's tempo (the style's only when it's more than 15 % away, e.g. DnB) (remix.flip). Drums become the kit: A's hits (`drum_hits`, flip.drum_hits
          of A's drum stem) re-programmed to the style section by section (flip.reprogram), inline in the clip; without
          them the style's straight loop. The bass becomes its groove wherever A's bass plays; vocals and other stay
          (prepare stretches them).
A groove clip plays remix.bass_patch_id, or else the FoxBox patch for the section's bass style.
Sections keep the song's own phrase lengths (song_structure's 4-bar blocks), so every change lands on a phrase line.
"""

from __future__ import annotations

import numpy as np

from fvwks_contracts.models import (
    GrooveClipSrc,
    KitClipSrc,
    KitHit,
    Remix,
    RemixClip,
    RemixLane,
    RemixSection,
    Song,
    StemClipSrc,
)

from .flip import FLIP_STYLES, Hit, reprogram
from .styles import Choose, record, resolve, take_style

FADE_BEATS = 0.25  # the outgoing side where the source changes (A ↔ B)
CUT_BEATS = 1 / 64  # the incoming side: only a declick, so the new part's first hit (a drop's kick) lands whole
BASSLESS = {"intro", "outro", "breakdown"}  # without the section's bass fields: where a flip plays no groove
PATCH_FOR = {"deep": "foxbox.reese", "trap": "foxbox.808", "dubstep": "foxbox.wobble", "other": "foxbox.growl"}
# flip styles whose bass is the engine's own (prepare.ENGINE_PATCHES), not a synth patch
FLIP_ENGINE = {"trap_hybrid": "resample:trap_hybrid", "riddim": "riddim:wub"}
FIRST_BEATS = 2.0  # the drop's first bass hit, darker and longer (a synthesized 808 at the root)
SWITCH_STYLES = {"trap_hybrid"}  # styles whose last two beats before a drop are a switch-up (a stutter, a dive)


def _keeps_808(patch_id: str) -> bool:
    """Engine bass that plays over the source's own held 808 (the user's rule: keep the original's weight)."""
    return patch_id.startswith(("hybrid:", "resample:"))


def _grid(song: Song) -> tuple[float, str | None]:
    a = song.analysis
    if a is None or song.structure is None or not song.structure.sections:
        raise ValueError(f"song {song.id} has no analysis or structure yet")
    return float(song.bpm_override or a.bpm), song.key_override or a.key


def _sections(song: Song, slot: str) -> list[RemixSection]:
    """The song's sections as remix sections, tiling from bar 1."""
    bpm, _ = _grid(song)
    bar_s = 4 * 60.0 / bpm
    out: list[RemixSection] = []
    at = 1
    secs = song.structure.sections
    for s, nxt in zip(secs, [*secs[1:], None]):
        # on the bar grid: the first section's seconds include the pre-roll before bar 1, so count bars, not seconds
        bars = max(1, nxt.start_bar - s.start_bar) if nxt else max(1, round((s.end_s - s.start_s) / bar_s))
        out.append(RemixSection(kind=s.kind, start_bar=at, bars=bars, from_slot=slot, from_start_bar=max(1, s.start_bar)))
        at += bars
    return out


def build(remix: Remix, songs: dict[str, Song], *, match=None, vip_drop: bool = False,
          drum_hits: list[Hit] | None = None, choose: Choose | None = None) -> Remix:
    """The recipe's draft arrangement (see the module doc); `match` is the MashMatch for a mashup. The take's variation
    axes are resolved first (styles.resolve: `choose` is the server's, else a kept take replays and a new seed draws)
    and recorded in remix.takes for remix.seed."""
    style = take_style(remix)
    flip_patch = FLIP_ENGINE.get(remix.flip.style_id) if remix.recipe == "flip" and remix.flip else None
    choices = resolve(remix, style, remix.bass_patch_id or flip_patch, choose)
    ch = {c.axis: c.option for c in choices}
    a = songs["A"]
    bpm, key = _grid(a)
    sections = _sections(a, "A")
    bass_style = {s.start_bar: s.bass_style for s in a.structure.sections}

    if remix.recipe == "vip" and vip_drop:
        drops = [s for s in sections if s.kind == "drop"]
        if drops:
            last = drops[-1]
            i = sections.index(last) + 1
            sections.insert(i, last.model_copy(update={"start_bar": last.start_bar + last.bars}))
            for s in sections[i + 1:]:
                s.start_bar += last.bars
    a_under: dict[int, int] = {}  # remix section index → A's bars B's drop replaced (A's vocals continue from there)
    b_vocals: set[int] = set()  # A's sections that take B's vocals
    if remix.recipe == "mashup":
        match = remix.mash or match
        if match is None or "B" not in songs:
            raise ValueError("a mashup needs song B and a MashMatch (remix.mash, or run() picks one)")
        at = next((i for i, s in enumerate(sections) if s.from_start_bar == match.from_start_bar), None)
        if match.part == "drop":  # A's build (or vocals) into B's drop: B's drop replaces A's next drop
            at = next((i for i, s in enumerate(sections) if s.kind == "drop" and s.from_start_bar >= match.from_start_bar), None)
        elif match.part == "build" and at is not None:  # B's build into A's drop: it replaces the section before it
            at = at - 1 if at > 0 else None
        if at is None:
            raise ValueError(f"song A has no part for B's {match.part} at bar {match.from_start_bar}")
        if match.part == "vocals":
            b_vocals.add(at)
        else:
            s = sections[at]
            if match.part == "drop":
                a_under[at] = s.from_start_bar
            sections[at] = RemixSection(kind=match.part, start_bar=s.start_bar, bars=match.bars, from_slot="B",
                                        from_start_bar=match.start_bar)
            for t in sections[at + 1:]:
                t.start_bar += match.bars - s.bars
    if remix.recipe == "flip":
        if remix.flip is None or remix.flip.style_id not in FLIP_STYLES:
            raise ValueError("a flip needs remix.flip with a known style")
        style_bpm = FLIP_STYLES[remix.flip.style_id]["bpm"]
        # a flip stays at the source's tempo (the user's rule) unless the style is truly elsewhere (DnB off a 145)
        bpm = bpm if abs(style_bpm / bpm - 1) <= 0.15 else style_bpm

    lanes: dict[str, RemixLane] = {}

    def patch(s: RemixSection) -> str:
        if remix.recipe == "flip" and not remix.bass_patch_id and remix.flip.style_id in FLIP_ENGINE:
            return FLIP_ENGINE[remix.flip.style_id]
        return remix.bass_patch_id or PATCH_FOR.get(bass_style.get(s.from_start_bar) or "other", "foxbox.growl")

    def clip(role: str, slot: str | None, src, s: RemixSection, **kw) -> None:
        lane = lanes.setdefault(f"{role}-{slot or 'x'}", RemixLane(id=f"{role}-{slot or 'x'}", role=role, slot=slot))
        lane.clips.append(RemixClip(id=f"{lane.id}-{len(lane.clips) + 1}", at_beat=(s.start_bar - 1) * 4,
                                    beats=s.bars * 4, src=src, **kw))

    for k, s in enumerate(sections):
        slot = s.from_slot
        start_beat = (s.from_start_bar - 1) * 4
        prev = sections[k - 1].from_slot if k else slot
        nxt = sections[k + 1].from_slot if k + 1 < len(sections) else slot
        fades = {"fade_in_beats": CUT_BEATS if prev != slot else 0.0, "fade_out_beats": FADE_BEATS if nxt != slot else 0.0}
        stem = lambda name: StemClipSrc(slot=slot, stem=name, start_beat=start_beat)
        if remix.recipe == "flip":
            style = remix.flip.style_id
            if drum_hits is None:
                kit = KitClipSrc(kit_id=remix.flip.kit_id, pattern_id=style)
            else:
                hits = reprogram(drum_hits, style, s.from_start_bar, s.bars, remix.flip.swing, ch.get(f"{style}.drums"))
                kit = KitClipSrc(kit_id=remix.flip.kit_id, hits=[KitHit(beat=h.beat, voice=h.kind, vel=h.vel) for h in hits])
            clip("kit", None, kit, s)
            plays = bass_style.get(s.from_start_bar) is not None if a.structure.from_stems else s.kind not in BASSLESS
            if plays:
                clip("synth_bass", "A", GrooveClipSrc(slot="A", start_bar=s.from_start_bar, bars=s.bars,
                                                      patch_id=patch(s)), s)
                if _keeps_808(patch(s)):
                    clip("bass", "A", stem("bass"), s)
            for name in ("vocals", "other"):
                clip(name, "A", stem(name), s)
            continue
        shift = float(match.shift_st) if slot == "B" else 0.0
        for name in ("drums", "other"):
            clip(name, slot, stem(name), s, shift_st=0.0 if name == "drums" else shift, **fades)  # drums keep their pitch
        if remix.recipe == "vip" and s.kind == "drop":
            clip("synth_bass", "A", GrooveClipSrc(slot="A", start_bar=s.from_start_bar, bars=s.bars, patch_id=patch(s)), s)
            if _keeps_808(patch(s)):
                clip("bass", slot, stem("bass"), s, **fades)
        else:
            clip("bass", slot, stem("bass"), s, shift_st=shift, **fades)
        if k in a_under:  # A's vocals carry on over B's drop, from A's own drop
            clip("vocals", "A", StemClipSrc(slot="A", stem="vocals", start_beat=(a_under[k] - 1) * 4), s,
                 fade_in_beats=CUT_BEATS, fade_out_beats=CUT_BEATS)
        elif k in b_vocals:  # B's vocals over A's drop
            clip("vocals", "B", StemClipSrc(slot="B", stem="vocals", start_beat=(match.start_bar - 1) * 4), s,
                 shift_st=float(match.shift_st), fade_in_beats=FADE_BEATS, fade_out_beats=FADE_BEATS)
        else:
            clip("vocals", slot, stem("vocals"), s, shift_st=shift, **fades)

    if remix.recipe == "flip" and remix.flip.style_id in SWITCH_STYLES:
        _switch_ups(sections, lanes)
    _first_hits(sections, lanes)
    _beat_pauses(sections, lanes.values(), ch.get("drop.pause", "bar8"), float(ch.get("drop.pause_len", "1")))
    _pre_drop_gaps(sections, lanes.values(), float(ch.get("drop.gap", "1")))
    _declick(lanes.values())
    return remix.model_copy(update={"bpm": bpm, "key": key, "sections": sections, "lanes": list(lanes.values()),
                                    "takes": record(remix, style, choices)})


def _lane(lanes: dict, lane_id: str, role: str) -> RemixLane:
    return lanes.setdefault(lane_id, RemixLane(id=lane_id, role=role, slot="A"))


def _drops(sections) -> list[tuple[float, RemixSection]]:
    return [((s.start_bar - 1) * 4.0, s) for k, s in enumerate(sections) if k and s.kind == "drop"]


def _first_hits(sections, lanes: dict) -> None:
    """The drop's first bass hit is its hardest, darker and longer (the user's rules): where the source's held 808
    enters a drop, its first FIRST_BEATS become a synthesized 808 at the root (808:dark: no whiny glide in from above)."""
    for d, s in _drops(sections):
        held = [c for lane in lanes.values() if lane.role == "bass" for c in lane.clips
                if c.src.kind == "stem" and abs(c.at_beat - d) < 1e-6 and c.beats > FIRST_BEATS]
        if not held:
            continue
        for c in held:
            c.at_beat += FIRST_BEATS
            c.beats -= FIRST_BEATS
            c.src = c.src.model_copy(update={"start_beat": c.src.start_beat + FIRST_BEATS})
            c.fade_in_beats = CUT_BEATS
        hit = _lane(lanes, "first_hit-A", "synth_bass")
        hit.clips.append(RemixClip(id=f"{hit.id}-{len(hit.clips) + 1}", at_beat=d, beats=FIRST_BEATS, src=GrooveClipSrc(
            slot="A", start_bar=s.from_start_bar, bars=1, patch_id="808:dark")))


def _switch_ups(sections, lanes: dict) -> None:
    """The last two beats before a drop as a switch-up (the user's trap rule): everything else ends two beats early;
    a 1/16 snare stutter, then an 808 diving into the drop."""
    for d, s in _drops(sections):
        for lane in list(lanes.values()):
            if lane.role == "vocals":
                continue
            for c in lane.clips:
                if abs(c.at_beat + c.beats - d) < 1e-6 and c.beats > 2:
                    c.beats -= 2.0
                    c.fade_out_beats = CUT_BEATS
        kit = next((c.src.kit_id for lane in lanes.values() for c in lane.clips if c.src.kind == "kit"), "source")
        k = _lane(lanes, "kit-x", "kit")
        k.clips.append(RemixClip(id=f"{k.id}-su{len(k.clips) + 1}", at_beat=d - 2, beats=1.0, src=KitClipSrc(
            kit_id=kit, hits=[KitHit(beat=q / 4, voice="snare", vel=0.5 + 0.13 * q) for q in range(4)])))
        hit = _lane(lanes, "first_hit-A", "synth_bass")
        hit.clips.append(RemixClip(id=f"{hit.id}-dive{len(hit.clips) + 1}", at_beat=d - 1, beats=1.0, src=GrooveClipSrc(
            slot="A", start_bar=max(1, s.from_start_bar - 1), bars=1, patch_id="808:dive")))


def _beat_pauses(sections, lanes, where: str, beats: float) -> None:
    """A planned stop mid-drop (the user's "occasionally", AX-03/04): the take's pause ("bar8", "bar12", "none") ends
    that bar with `beats` of silence but for the vocals, then it slams back on the next downbeat."""
    if where == "none":
        return
    for d, s in _drops(sections):
        bar = 12 if where == "bar12" and s.bars >= 12 else 8
        if s.bars < bar:
            continue
        end = d + 4.0 * bar
        _cut_window(lanes, end - beats, end)


def _cut_window(lanes, t0: float, t1: float, vocals: bool = False) -> None:
    """[t0, t1) cut out of every clip but the vocals' (theirs too with `vocals`), each clip that spans it split in two
    around it."""
    for lane in lanes:
        if lane.role == "vocals" and not vocals:
            continue
        out = []
        for c in lane.clips:
            e = c.at_beat + c.beats
            if c.at_beat >= t1 or e <= t0:
                out.append(c)
                continue
            if c.at_beat < t0:
                out.append(_part(c, c.at_beat, t0, "a"))
            if e > t1:
                out.append(_part(c, t1, e, "b"))
        lane.clips = out


def _part(c: RemixClip, a: float, b: float, tag: str) -> RemixClip:
    """The piece [a, b) of a clip (its source advanced to match)."""
    off = a - c.at_beat
    src = c.src
    if src.kind == "stem":
        src = src.model_copy(update={"start_beat": src.start_beat + off})
    elif src.kind == "groove" and off:
        src = src.model_copy(update={"start_bar": src.start_bar + int(off // 4), "bars": max(1, int(np.ceil((b - a) / 4)))})
    elif src.kind == "kit":
        src = src.model_copy(update={"hits": [h.model_copy(update={"beat": h.beat - off}) for h in src.hits
                                              if off <= h.beat < off + (b - a)]})
    return c.model_copy(update={"id": f"{c.id}{tag}", "at_beat": a, "beats": b - a, "src": src,
                                "fade_in_beats": CUT_BEATS if tag == "b" else c.fade_in_beats,
                                "fade_out_beats": CUT_BEATS if tag == "a" else c.fade_out_beats})


def _pre_drop_gaps(sections, lanes, gap: float) -> None:
    """A beat of silence before every drop (Sound Bible 1.8, the user's "1 beat of silence"): every lane, the vocals
    too (QA: >= 1/2 beat at <= -40 dBFS), is cut for `gap` beats (the take's drop.gap) before a drop, so its first hit
    lands out of silence.
    Only the mixdown's reverse cymbal rises into the gap's second half."""
    lanes = list(lanes)
    for k, s in enumerate(sections):
        if k and s.kind == "drop":
            d = (s.start_bar - 1) * 4.0
            _cut_window(lanes, d - gap, d, vocals=True)


def _declick(lanes) -> None:
    """Every clip edge that doesn't run seamlessly on (the same stem, contiguous in the remix and in its source) gets at
    least a CUT_BEATS fade: audio cut mid-waveform clicks. Generated clips (grooves, kits) always get both."""
    for lane in lanes:
        clips = sorted(lane.clips, key=lambda c: c.at_beat)
        for i, c in enumerate(clips):
            nxt = clips[i + 1] if i + 1 < len(clips) else None
            prv = clips[i - 1] if i else None
            joins = lambda x, y: (x is not None and y is not None and x.src.kind == y.src.kind == "stem"
                                  and (x.src.slot, x.src.stem) == (y.src.slot, y.src.stem)
                                  and abs(x.at_beat + x.beats - y.at_beat) < 1e-6
                                  and abs(x.src.start_beat + x.beats - y.src.start_beat) < 1e-6)
            if not joins(c, nxt):
                c.fade_out_beats = max(c.fade_out_beats, CUT_BEATS)
            if not joins(prv, c):
                c.fade_in_beats = max(c.fade_in_beats, CUT_BEATS)
