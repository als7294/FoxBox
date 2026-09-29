"""1.6 REMIX in one call: build → prepare → mixdown through remix.run, the way the server's jobs use it."""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from test_bassline import SR, _tracks  # noqa: E402

from fvwks_contracts.models import FlipSettings, Master, Remix, Song, SongAnalysis, SongSection, SongStructure  # noqa: E402
from fvwks_fx.remix import SongInput, clip_key, run  # noqa: E402


def _source() -> SongInput:
    bass, drums = _tracks()  # 24 bars at 140 BPM: held subs, a wobble, 808s (a snare track)
    bar = 240 / 140
    secs = [SongSection(kind=k, start_s=a * bar, end_s=(a + 8) * bar, start_bar=a + 1, energy=0.5)
            for k, a in (("intro", 0), ("drop", 8), ("drop", 16))]
    st = SongStructure.model_construct(sections=secs, drops_s=[8 * bar], builds=[], phrase_bars=8, from_stems=False)
    song = Song.model_construct(id="s", analysis=SongAnalysis(bpm=140, downbeat_s=0.0, key="Am"), structure=st,
                                bpm_override=None, downbeat_override_s=None, key_override=None)
    other = (0.1 * np.sin(2 * np.pi * 330 * np.arange(bass.shape[1]) / SR))[None].astype(np.float32)
    return SongInput(song, {"drums": drums, "bass": bass, "vocals": other * 0, "other": other}, SR)


def test_run_stages():
    src = {"A": _source()}
    r0 = Remix(id="r", name="r", recipe="flip", sources=[{"slot": "A", "song_id": "s"}], bpm=140, created_at="",
               updated_at="", flip=FlipSettings(style_id="halftime", kit_id="foxbox"))
    built = run(r0, src, stage="build")
    assert built.remix.build_state == "done" and built.remix.sections and not built.audio
    clips = [c for lane in built.remix.lanes for c in lane.clips]
    prepared = run(built.remix, src, stage="prepare", sr=SR)
    assert set(prepared.audio) == {c.id for c in clips}
    # the server stores them and sets audio_id; a mixdown then prepares nothing again
    stored = built.remix.model_copy(deep=True)
    for lane in stored.lanes:
        for c in lane.clips:
            c.audio_id = clip_key(c, stored, src)
    done = run(stored, src, stage="mixdown", audio=prepared.audio, sr=SR, master=Master(sample_rate=48000))
    assert not done.audio and done.mix.shape == (2, round(24 * 240 / 140 * 48000)) and np.isfinite(done.mix).all()
    a = next(c for c in clips if c.src.kind == "stem")
    b = a.model_copy(update={"at_beat": 64.0, "id": "moved"})
    assert clip_key(a, stored, src) == clip_key(b, stored, src)  # the same sound anywhere in the remix
    assert clip_key(a, stored, src) != clip_key(a.model_copy(update={"gain_db": -3.0}), stored, src)
    kit = next(c for c in clips if c.src.kind == "kit")  # seeded: a new take (seed) is a new sound
    assert clip_key(kit, stored, src) != clip_key(kit, stored.model_copy(update={"seed": stored.seed + 1}), src)


def test_prepare_streams_the_first_bars_first():
    from fvwks_fx.remix import pipeline as PL

    src = {"A": _source()}
    r0 = Remix(id="r", name="r", recipe="flip", sources=[{"slot": "A", "song_id": "s"}], bpm=140, created_at="",
               updated_at="", flip=FlipSettings(style_id="halftime", kit_id="foxbox"))
    built = run(r0, src, stage="build").remix
    events = []
    got = run(built, src, stage="prepare", sr=SR, on_clip=lambda cid, audio, info: events.append((cid, info)))
    total = sum(len(lane.clips) for lane in built.lanes)
    assert len(events) == total and events[-1][1].playable and events[-1][1].drop_ready
    flags = [info.playable for _, info in events]
    assert flags == sorted(flags) and not flags[0]  # it turns playable once, and stays
    serial, PL.WORKERS = PL.WORKERS, 1
    try:
        again = run(built, src, stage="prepare", sr=SR).audio
    finally:
        PL.WORKERS = serial
    assert all(np.array_equal(got.audio[k], again[k]) for k in got.audio)  # threads change nothing


def test_mashup_uses_line_it_up_else_picks():
    from fvwks_contracts.models import MashMatch

    a, b = _source(), _source()
    b.song = b.song.model_copy(update={"id": "b"})
    src = {"A": a, "B": b}
    r0 = Remix(id="r", name="r", recipe="mashup", sources=[{"slot": "A", "song_id": "s"}, {"slot": "B", "song_id": "b"}],
               bpm=140, created_at="", updated_at="")
    picked = run(r0, src, stage="build").remix
    assert picked.mash is not None  # BUILD chose, and says what
    assert any(getattr(c.src, "slot", None) == "B" for lane in picked.lanes for c in lane.clips)
    chosen = MashMatch(song_id="b", part="vocals", start_bar=17, bars=8, score=70, shift_st=1, tempo_ratio=1.0,
                       from_start_bar=9)
    r = run(r0.model_copy(update={"mash": chosen}), src, stage="build").remix
    assert r.mash == chosen and all(s.from_slot == "A" for s in r.sections)  # B's vocals over A's drop: A's sections
    voc = [c for lane in r.lanes if lane.role == "vocals" for c in lane.clips if c.src.slot == "B"]
    assert len(voc) == 1 and voc[0].at_beat == 32 and voc[0].src.start_beat == 64 and voc[0].shift_st == 1


def test_any_track_renders():  # M2.3: no drop found, a drop as the very first section, no key, 4 bars, half tempo
    base = _source()
    bar = 240 / 140
    layouts = {"no drop": (("intro", 0, 24),), "drop first": (("drop", 0, 16), ("outro", 16, 8)),
               "4 bars": (("build", 0, 2), ("drop", 2, 2)), "half tempo": (("intro", 0, 4), ("drop", 4, 8))}
    for name, layout in layouts.items():
        secs = [SongSection(kind=k, start_s=a * bar, end_s=(a + n) * bar, start_bar=a + 1, energy=0.5) for k, a, n in layout]
        st = SongStructure.model_construct(sections=secs, drops_s=[], builds=[], phrase_bars=8, from_stems=False)
        bpm = 70.0 if name == "half tempo" else 140.0  # an analysis an octave low
        song = base.song.model_copy(update={"structure": st, "analysis": SongAnalysis(bpm=bpm, downbeat_s=0.0, key=None)})
        n = int(4 * bar * SR) if name == "4 bars" else base.stems["bass"].shape[1]
        src = {"A": SongInput(song, {k: v[..., :n] for k, v in base.stems.items()}, SR)}
        for recipe, kw in (("vip", {"bass_patch_id": "hybrid:tearout"}),
                           ("flip", {"flip": FlipSettings(style_id="riddim", kit_id="foxbox")})):
            r = Remix(id="r", name="r", recipe=recipe, sources=[{"slot": "A", "song_id": "s"}], bpm=140, created_at="",
                      updated_at="", **kw)
            y = run(r, src, stage="mixdown", sr=SR, master=Master(sample_rate=48000)).mix
            assert y.shape[1] > 0 and np.isfinite(y).all() and np.abs(y).max() > 1e-3, (name, recipe)


def test_kit_keys_follow_the_sample_bank():  # v0.15: a changed pack re-prepares the layered kit clips
    from fvwks_contracts.models import RemixTake, TakeChoice
    from fvwks_synth import layers

    src = {"A": _source()}
    r = run(Remix(id="r", name="r", recipe="flip", sources=[{"slot": "A", "song_id": "s"}], bpm=140, created_at="",
                  updated_at="", flip=FlipSettings(style_id="halftime", kit_id="foxbox")), src, stage="build").remix
    kit = next(c for lane in r.lanes for c in lane.clips if c.src.kind == "kit")
    for layer in ("synth", "both"):
        rl = r.model_copy(update={"takes": [RemixTake(seed=r.seed, style="halftime", created_at="",
                                                      choices=[TakeChoice(axis="kit.layer", option=layer)])]})
        before = clip_key(kit, rl, src)
        saved, layers._USER = dict(layers._USER), {"kick": "/nowhere/kick.wav"}
        try:
            after = clip_key(kit, rl, src)
        finally:
            layers._USER = saved
        assert (before == after) == (layer == "synth"), layer  # only a layered take hears the bank


def test_a_quiet_source_pre_drop_keeps_its_own_gap():  # the user's 1 beat: our gap never stacks on the source's
    from fvwks_fx.remix.pipeline import own_gaps

    src = _source()
    assert own_gaps(src) == set()  # the tone runs into both drops
    beat = int(60 / 140 * SR)
    for k in src.stems:  # the source goes quiet 3 beats before the first drop (bar 9)
        src.stems[k] = src.stems[k].copy()  # (_tracks may be shared)
        src.stems[k][..., 32 * beat - 3 * beat : 32 * beat] = 0
    assert own_gaps(src) == {9}
