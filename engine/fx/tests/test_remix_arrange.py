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


def test_tearout_flip_rides_the_tearout_engine():  # C18
    r = build(_remix("flip", flip=FlipSettings(style_id="tearout", kit_id="foxbox")), {"A": _song("a")})
    assert {c.src.patch_id for lane in r.lanes if lane.role == "synth_bass" for c in lane.clips} >= {"resample:tearout"}
    assert r.takes[0].style == "tearout" and FLIP_STYLES["tearout"]["grid"][1]["bars"][0][8] == "x"  # snare on 3


def test_trap_switch_up_replaces_the_gap_and_no_lane_is_empty():  # S4's RC smoke: an empty 2nd SYNTH BASS row
    r = build(_remix("flip", flip=FlipSettings(style_id="trap_hybrid", kit_id="foxbox")), {"A": _song("a")})
    assert all(lane.clips for lane in r.lanes)
    dives = [c for lane in r.lanes for c in lane.clips if c.src.kind == "groove" and c.src.patch_id == "808:dive"]
    drops = [(s.start_bar - 1) * 4.0 for k, s in enumerate(r.sections) if k and s.kind == "drop"]
    assert sorted(c.at_beat + c.beats for c in dives) == drops  # each dive lands on its drop, not cut by a gap


def test_build_fills_each_sections_chords():  # v0.14: the source's chords under each section, bar by bar
    from fvwks_contracts.models import Chord

    song = _song("a")
    names = ["A", "F", "C", "G"]
    chords = [Chord(root=names[i % 4], quality="min" if i % 4 == 0 else "maj") for i in range(sum(b for _, b in LAYOUT))]
    song = song.model_copy(update={"structure": song.structure.model_copy(update={"chords": chords})})
    r = build(_remix("vip", bass_patch_id="reese-1"), {"A": song})
    for s in r.sections:
        assert [c.root for c in s.chords] == [c.root for c in chords[s.from_start_bar - 1 : s.from_start_bar - 1 + s.bars]]
    assert r.sections[0].chords[0] == Chord(root="A", quality="min")


def test_drop_plans():  # REMIX_HARMONY 1.5 / 5.3 / 6.5
    from fvwks_contracts.models import Chord
    from fvwks_fx.remix.plan import drop_plan, options

    am = [Chord(root=r, quality=q) for r, q in (("A", "min"), ("F", "maj"), ("C", "maj"), ("G", "maj"))] * 4
    t = drop_plan("tearout", "phrygian_v", 16, 9, True, None)  # Am: i x7, i/bII, i x7, VI/V
    assert [c.root for c in t[:8]] == ["A"] * 8 and (t[7].root2, t[7].quality2) == ("Bb", "maj")
    assert (t[15].root, t[15].root2, t[15].quality2) == ("F", "E", "maj")
    rid = drop_plan("riddim", "source", 16, 9, True, am)  # a pedal on A, the commonest other root as the lift
    assert {c.root for c in rid[:8] + rid[12:]} == {"A"} and {c.root for c in rid[8:12]} == {"F"}
    trap = drop_plan("trap_hybrid", "source", 16, 9, True, am)  # the loop, at its own rate
    assert [c.root for c in trap[:4]] == ["A", "F", "C", "G"] and "source" in options("riddim", am)
    assert "source" not in options("riddim", [Chord()] * 4)  # no chords read: templates only
    tear = drop_plan("tearout", "source", 16, 9, True, [Chord(root="A", quality="min")] * 16)  # a pedal source
    assert [c.root for c in tear[5:9]] == ["A", "F", "G", "A"]  # still turns at 7-8: VI - VII


def test_build_writes_the_drop_plan_and_records_it():
    from fvwks_contracts.models import Chord

    song = _song("a")
    chords = [Chord(root="A", quality="min")] * sum(b for _, b in LAYOUT)
    song = song.model_copy(update={"structure": song.structure.model_copy(update={"chords": chords})})
    r = build(_remix("flip", flip=FlipSettings(style_id="riddim", kit_id="foxbox")), {"A": song})
    got = {c.axis: c.option for c in r.takes[0].choices}
    assert got["harmony.progression"] in ("source", "pedal", "lift_iv", "phrygian")
    drops = [s for k, s in enumerate(r.sections) if k and s.kind == "drop"]
    assert drops and all(len(s.chords) == s.bars and s.chords[0].root == "A" for s in drops)


def test_hook_motif_and_squeak():  # REMIX_HARMONY 3.2 / 3.3
    import numpy as np

    from fvwks_fx.remix.hook import motif, squeak

    prog = {0: (9, 3), 1: (5, 4), 2: (0, 4), 3: (7, 4)}  # Am F C G
    notes = motif(lambda bar, beat: prog[bar % 4], 8, "Am", np.random.default_rng(1), pcs={9, 0, 4, 2, 7})
    per_bar = [[n for n in notes if 4 * b <= n[0] < 4 * b + 4] for b in range(8)]
    assert all(3 <= len(p) <= 6 for p in per_bar)
    assert not any(1.75 <= n[0] % 4 < 2.25 for n in notes)  # the snare window stays clear
    assert per_bar[1][-1][2] % 12 == (5 + 7) % 12 and per_bar[3][-1][2] % 12 == 7  # A' ends on its 5th, B on its root
    assert max(m for _, _, m in notes[:len(notes) // 2]) - min(m for _, _, m in notes[:len(notes) // 2]) <= 11
    sq = squeak(lambda bar, beat: (9, 3), 2)
    assert sq and all((m - 9) % 12 in (0, 7) for _, _, m in sq)  # R or 5 only


def test_bar_9_is_a_second_first_hit():  # REMIX_HARMONY 5.2
    r = build(_remix("vip", bass_patch_id="reese-1"), {"A": _song("a")})
    fx = [c for lane in r.lanes if lane.id == "kit-fx" for c in lane.clips if c.src.pattern_id == "fx.impact"]
    for d in [(s.start_bar - 1) * 4.0 for k, s in enumerate(r.sections) if k and s.kind == "drop" and s.bars >= 12]:
        assert {(c.at_beat - d, c.gain_db) for c in fx if d <= c.at_beat < d + 64} == {(0.0, 0.0), (32.0, -1.0)}


def test_vocals_move():  # the user's set3: "It should be able to move around vocals too"
    import numpy as np

    from fvwks_fx.remix.vocals import phrases

    sr, beat = 22050, 0.5  # 120 BPM
    t = np.arange(int(beat * sr)) / sr
    tone = lambda f, beats: np.concatenate([np.sin(2 * np.pi * f * t)] * beats)  # noqa: E731
    rest = np.zeros(int(beat * sr))
    x = np.concatenate([tone(440, 2), rest, rest, tone(440, 2), rest, tone(330, 3), rest])  # A A' (the same line), E
    got = phrases(x, sr, 120.0, 0.0)
    assert [(round(a), round(b), pc, n) for a, b, pc, n in got] == [(0, 2, 9, 1), (4, 6, 9, 1), (7, 10, 4, 0)]

    ph = [(40.0, 44.0, 9, 1), (48.0, 52.0, 9, 1), (70.0, 72.0, 4, 0)]  # the hook twice in the build, a line in the drop
    build_with = lambda mode: build(_remix("vip", bass_patch_id="reese-1"), {"A": _song("a")}, vocal_phrases=ph,  # noqa: E731
                                    choose=lambda axis, opts: mode if axis == "vocals.arrangement" else next(iter(opts)))
    keep = next(ln for ln in build_with("keep").lanes if ln.id == "vocals-A")
    assert sorted((c.src.start_beat, c.beats) for c in keep.clips) == [(40.0, 4.0), (48.0, 4.0), (70.0, 2.0)]  # phrases
    hook = next(c for ln in build_with("hook_move").lanes for c in ln.clips if c.id == "vocals-A-hook-1")
    assert (hook.at_beat, hook.beats, hook.src.start_beat) == (64.0 - 1.0 - 4.0, 4.0, 48.0)  # it ends on the gap
    r = build_with("chops")
    chops = next(ln for ln in r.lanes if ln.id == "vocals-chops")
    assert chops.clips[0].at_beat == 63.5 and all(c.beats == 0.5 for c in chops.clips)  # the gap cue, then answers
    assert not [c for ln in r.lanes if ln.id == "vocals-A" for c in ln.clips if 64 <= c.at_beat < 128]  # the drop's own out
