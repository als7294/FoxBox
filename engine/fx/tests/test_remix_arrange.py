"""1.6 BUILD: the three recipes' draft arrangements on synthetic song layouts (120 BPM: a bar is 2 s)."""

from fvwks_contracts.models import FlipSettings, MashMatch, Remix, Song, SongAnalysis, SongSection, SongStructure
from fvwks_fx.remix.arrange import build
from fvwks_fx.remix.flip import FLIP_STYLES
from fvwks_fx.remix.styles import axes, choice, resolve

LAYOUT = [("intro", 8), ("build", 8), ("drop", 16), ("breakdown", 8), ("build", 8), ("drop", 16), ("outro", 8)]


def _song(sid: str, bpm: float = 120.0) -> Song:
    bar = 240.0 / bpm
    secs, at = [], 1
    for kind, bars in LAYOUT:
        secs.append(SongSection(kind=kind, start_s=(at - 1) * bar, end_s=(at - 1 + bars) * bar, start_bar=at, energy=0.5))
        at += bars
    st = SongStructure.model_construct(sections=secs, drops_s=[], builds=[], phrase_bars=8, from_stems=False)
    return Song.model_construct(id=sid, analysis=SongAnalysis(bpm=bpm, downbeat_s=0.0, key="Am"), structure=st,
                                bpm_override=None, key_override=None)


def _remix(recipe: str, **kw) -> Remix:
    return Remix(id="r", name="r", recipe=recipe, sources=[{"slot": "A", "song_id": "a"}], bpm=120, created_at="",
                 updated_at="", **kw)


def _tiles(r: Remix) -> bool:
    return all(b.start_bar == a.start_bar + a.bars for a, b in zip(r.sections, r.sections[1:]))


def _lane(r: Remix, lane_id: str):
    return next((lane for lane in r.lanes if lane.id == lane_id), None)


def test_vip_swaps_the_drop_bass_for_its_groove():
    r = build(_remix("vip", bass_patch_id="reese-1"), {"A": _song("a")}, vip_drop=True)
    assert (r.bpm, r.key) == (120.0, "Am") and _tiles(r)
    assert [s.kind for s in r.sections][-3:] == ["drop", "drop", "outro"]  # the VIP drop repeats the last one
    drops = {(s.start_bar - 1) * 4.0 for s in r.sections if s.kind == "drop"}
    grooves = [c for c in _lane(r, "synth_bass-A").clips if c.at_beat in drops]  # pauses and gaps split each drop's
    assert len(grooves) == 3 and all(c.src.patch_id == "reese-1" for c in grooves)
    assert (grooves[0].at_beat, grooves[0].src.start_bar) == (64, 17) and grooves[0].beats in (30, 31, 46, 47)
    bass_beats = {c.at_beat for c in _lane(r, "bass-A").clips}
    assert not bass_beats & {c.at_beat for c in grooves}  # one bass at a time
    starts = {(s.start_bar - 1) * 4.0 for s in r.sections}
    assert len([c for c in _lane(r, "drums-A").clips if c.at_beat in starts]) == len(r.sections)


def test_mashup_drops_b_in_with_a_vocals_over_it():
    match = MashMatch(song_id="b", part="drop", start_bar=33, bars=16, score=80, shift_st=2, tempo_ratio=0.97,
                      from_start_bar=17)
    r = build(_remix("mashup"), {"A": _song("a"), "B": _song("b", 124.0)}, match=match)
    drop = next(s for s in r.sections if s.from_slot == "B")
    assert (drop.start_bar, drop.bars, drop.from_start_bar) == (17, 16, 33) and _tiles(r)
    b_drums = _lane(r, "drums-B").clips[0]
    # B's drop comes in whole (a 1/64-beat declick, not a fade) and its drums keep their pitch; its bass moves key
    assert (b_drums.at_beat, b_drums.src.start_beat, b_drums.shift_st, b_drums.fade_in_beats) == (64, 128, 0.0, 1 / 64)
    assert _lane(r, "bass-B").clips[0].shift_st == 2.0
    assert not [c for c in _lane(r, "bass-A").clips if c.at_beat == 64]  # A's bass out under B's drop
    assert [c for c in _lane(r, "vocals-A").clips if c.at_beat == 64]  # A's vocals over it


def test_flip_goes_to_the_style_tempo_with_kit_and_groove():
    r = build(_remix("flip", flip=FlipSettings(style_id="halftime", kit_id="808-cc0")), {"A": _song("a")})
    assert r.bpm == 140.0 and _tiles(r) and not _lane(r, "drums-A") and not _lane(r, "bass-A")
    assert len([c for c in _lane(r, "kit-x").clips if not c.id.endswith("b")]) == len(r.sections)
    starts = {c.at_beat for c in _lane(r, "synth_bass-A").clips if not c.id.endswith("b")}  # a pause's second half aside
    assert starts == {32, 64, 160, 192}  # builds and drops, not the rest


def test_flip_kit_clips_carry_the_songs_hits():
    from fvwks_fx.remix.flip import Hit

    hits = [Hit("kick", b, 1.0) for b in range(0, 4 * 72)] + [Hit("snare", b + 1, 0.8) for b in range(0, 4 * 72, 2)]
    r = build(_remix("flip", flip=FlipSettings(style_id="halftime", kit_id="foxbox")), {"A": _song("a")}, drum_hits=hits)
    kits = _lane(r, "kit-x").clips
    first = kits[0].src
    # the style's whole kit plays in a played bar (hats too, though the source had none)
    assert first.hits and first.pattern_id is None and {h.voice for h in first.hits} == {"kick", "snare", "hats"}
    assert [h.beat for h in first.hits if h.voice == "snare" and h.beat < 4] == [2]  # re-programmed: half-time
    grooves = _lane(r, "synth_bass-A").clips
    assert all(c.src.patch_id == "foxbox.growl" for c in grooves)  # no bass style known: the default patch


def test_sections_follow_the_bar_grid():
    # a downbeat 1.2 s in: the first section's seconds include the pre-roll, but it's still 8 bars (no bar twice)
    song = _song("a")
    secs = [s.model_copy(update={"start_s": s.start_s + 1.2, "end_s": s.end_s + 1.2}) for s in song.structure.sections]
    secs[0] = secs[0].model_copy(update={"start_s": 0.0})
    song = song.model_copy(update={"structure": song.structure.model_copy(update={"sections": secs}),
                                   "analysis": song.analysis.model_copy(update={"downbeat_s": 1.2})})
    r = build(_remix("vip"), {"A": song})
    assert [(s.start_bar, s.bars, s.from_start_bar) for s in r.sections[:3]] == [(1, 8, 1), (9, 8, 9), (17, 16, 17)]


def test_a_beat_of_silence_before_each_drop():
    r = build(_remix("vip"), {"A": _song("a")})
    ends = {lane.role: max(c.at_beat + c.beats for c in lane.clips if c.at_beat < 64)
            for lane in r.lanes if any(c.at_beat < 64 for c in lane.clips)}
    assert ends["drums"] == ends["other"] == ends["bass"] == ends["vocals"] == 63.0  # all stop a beat before the drop


def test_beat_pauses_follow_the_seed_and_spare_the_vocals():
    def pause(seed):
        r = build(_remix("vip", bass_patch_id="reese-1").model_copy(update={"seed": seed}), {"A": _song("a")})
        drums = sorted(_lane(r, "drums-A").clips, key=lambda c: c.at_beat)
        gaps = [(a.at_beat + a.beats, b.at_beat) for a, b in zip(drums, drums[1:]) if b.at_beat - (a.at_beat + a.beats) > 0.4]
        voc = sorted(_lane(r, "vocals-A").clips, key=lambda c: c.at_beat)
        drops = {(s.start_bar - 1) * 4.0 for s in r.sections if s.kind == "drop"}
        assert all(b.at_beat == a.at_beat + a.beats for a, b in zip(voc, voc[1:])
                   if b.at_beat not in drops)  # the vocals run through the pauses (only the pre-drop gap stops them)
        return [g for g in gaps if 64 < g[0] < 128]  # inside the first drop (bars 17-32)
    seen = {tuple(pause(k)) for k in range(12)}
    assert all(len(p) <= 1 and all(g[1] in (96.0, 112.0) for g in p) for p in seen)  # at most one, ending bar 8 or 12
    assert () in seen and len(seen) > 2  # "occasionally" (C9): some takes have none; the seed moves it


# styles as data and the take's variation axes (plan M1.7 / M2.2)
def test_flip_styles_load_from_data():
    assert {"riddim", "trap_hybrid", "halftime", "dnb"} <= set(FLIP_STYLES)
    assert (2, "snare", 1.0) in FLIP_STYLES["riddim"]["hits"] and FLIP_STYLES["riddim"]["alt"]
    assert set(axes("riddim")) >= {"drop.gap", "drop.gap_fill", "drop.pause", "drop.pause_len", "drop.cadence", "riddim.drums"}


def test_build_records_the_take_and_replays_it():
    r = build(_remix("vip", bass_patch_id="reese-1").model_copy(update={"seed": 5}), {"A": _song("a")})
    (take,) = r.takes
    got = {c.axis: c.option for c in take.choices}
    assert take.seed == 5 and got["drop.gap"] == "1" and got["drop.pause"] in ("bar8", "bar12", "none")
    assert choice(r, "drop.cadence") == got["drop.cadence"]
    # a kept take replays its record, whatever the draw would say now
    kept = r.model_copy(update={"takes": [take.model_copy(update={"choices": [c.model_copy(update={"option": "none"})
                                                                               if c.axis == "drop.pause" else c for c in take.choices]})]})
    assert {c.axis: c.option for c in resolve(kept, take.style)}["drop.pause"] == "none"
    assert build(kept, {"A": _song("a")}).takes[0].choices == kept.takes[0].choices


def test_choose_decides_every_axis():
    asked = {}

    def choose(axis, opts):
        asked[axis] = opts
        return "none" if axis == "drop.pause" else next(iter(opts))

    r = build(_remix("vip", bass_patch_id="reese-1"), {"A": _song("a")}, choose=choose)
    assert asked["drop.pause"] == {"bar8": 0.45, "bar12": 0.25, "none": 0.3}  # the declared default weights
    assert {c.axis: c.option for c in r.takes[0].choices}["drop.pause"] == "none"
