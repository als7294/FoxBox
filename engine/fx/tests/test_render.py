"""End-to-end ``fvwks_fx.api.render``: every preset, exact length, loudness, true peak, no NaNs,
mono-compatibility, fit reporting, mask strength, macro resolution and stage memoization."""

import numpy as np
import pytest

from fvwks_contracts.models import (
    Arrange, Chain, Macros, MacroMap, Master, ModuleState, RenderRequest, Segment, StackVoice, Word,
)
from fvwks_fx import api
from fvwks_fx import master as MS
from fvwks_fx.memo import STAGES
from fvwks_fx.modules.stereo import mono_compat

PRESETS = ["pact", "legion", "abyss", "unit", "ghost", "signal", "raw"]


def _req(preset_id: str, quality: str = "final", **arrange) -> RenderRequest:
    base = RenderRequest(source_id="test", preset_id=preset_id, quality=quality,
                         arrange=Arrange(**{"bpm": 140, "bars": 4, "key": "Am", **arrange}))
    return api.apply_hints(base, api.get_preset(preset_id))


def _stack_for(preset_id: str, stack_sources):
    pre = api.get_preset(preset_id)
    return [src if sv.voice_id else None for sv, src in zip(pre.stack, stack_sources)]


def _low_side_ratio_db(x: np.ndarray, sr: int, hz: float = 110.0) -> float:
    """Side energy below ``hz`` relative to the whole signal (dB): the low end must be mono."""
    f = np.fft.rfftfreq(x.shape[1], 1 / sr)
    mid = np.abs(np.fft.rfft(0.5 * (x[0] + x[1]))) ** 2
    side = np.abs(np.fft.rfft(0.5 * (x[0] - x[1]))) ** 2
    return 10 * np.log10((side[f < hz].sum() + 1e-20) / (mid.sum() + side.sum() + 1e-20))


@pytest.mark.parametrize("preset_id", PRESETS)
def test_every_preset_final(we_are, we_are_stack, preset_id):
    out = api.render(we_are, _stack_for(preset_id, we_are_stack), _req(preset_id))
    assert out.sample_rate == 44100
    n = round(out.bars * 240 / 140 * 44100)  # 4 bars asked; v0.4 may grow it to hold the FX tail (GHOST)
    assert out.bars >= 4 and out.audio.shape == (2, n) and out.dry.shape == (2, n)
    assert np.all(np.isfinite(out.audio)) and np.all(np.isfinite(out.dry))
    assert MS.short_term_max(out.audio, 44100) == pytest.approx(-7.0, abs=0.2)  # spec: +-0.5
    assert MS.short_term_max(out.dry, 44100) == pytest.approx(-7.0, abs=0.5)
    assert MS.true_peak(out.audio, 44100) <= -1.0 + 1e-6
    assert MS.true_peak(out.dry, 44100) <= -1.0 + 1e-6
    assert out.loudness.true_peak_db <= -1.0 + 1e-6
    mc = mono_compat(out.audio)
    assert mc["correlation"] > 0.0 and mc["mono_loss_db"] < 3.0  # no cancellation when a club sums to mono
    assert _low_side_ratio_db(out.audio, 44100) < -60.0
    assert out.mask.level == "synthetic"
    assert out.fit.status in ("fits", "stretched", "extended")  # never "overflow": speech is never cut (v0.4)
    assert out.segments and out.segments[0].start_s == pytest.approx(out.first_word_s, abs=1e-4)
    assert [m.id for m in out.resolved_chain.modules][:12] == [m.id for m in api.rack_schema().modules]
    assert "total" in out.timings_ms


def test_preview_matches_final_grid(we_are, we_are_stack):
    out = api.render(we_are, _stack_for("pact", we_are_stack), _req("pact", "preview"))
    assert out.sample_rate == 44100 and out.audio.shape == (2, 302_400)
    assert np.all(np.isfinite(out.audio))
    assert MS.short_term_max(out.audio, 44100) == pytest.approx(-7.0, abs=0.5)
    assert MS.true_peak(out.audio, 44100) <= -1.0 + 1e-6


def test_throw_segment_is_flagged_and_gets_a_tail(we_are):
    out = api.render(we_are, [None, None], _req("pact"))
    throws = [s for s in out.segments if s.flags.throw]
    assert throws, "EXPECT *US* carries the throw flag"
    # the throw send keeps ringing after the speech has ended
    end = int((max(seg.end_s for seg in out.segments) + 0.25) * 44100)
    tail = out.audio[:, end : end + int(0.5 * 44100)]
    assert np.sqrt(np.mean(tail**2)) > 10 ** (-45 / 20)


def test_ghost_swell_fills_the_pre_roll(we_are):
    out = api.render(we_are, [], _req("ghost"))
    first = int(out.first_word_s * 44100)
    assert out.first_word_s == pytest.approx(4 * 60 / 140, abs=1e-4)
    pre = out.audio[:, first - int(0.4 * 44100) : first]
    assert np.sqrt(np.mean(pre**2)) > 10 ** (-40 / 20), "reverse swell rises into the first word"


def test_too_long_grows_instead_of_cutting(remember):
    out = api.render(remember, [], _req("raw", bars=1))
    assert out.fit.status == "extended" and out.bars in (4, 8) and out.fit.suggested_bars == out.bars
    assert out.audio.shape == (2, round(out.bars * 240 / 140 * 44100))
    assert out.tail_s < out.audio.shape[1] / 44100  # the last word is inside the file
    assert any("Extended" in w for w in out.warnings)


@pytest.mark.parametrize("bars", [2, 4])
def test_thrown_last_word_echoes_ring_out(we_are, bars):
    # the user's v0.4 report: the last word's echo was cut at the bar line. v0.4.1: the last word ("US") also
    # ends exactly on a beat (snap_end="beat", the default), then the echoes ring out to the file end.
    out = api.render(we_are, [None, None], _req("pact", bars=bars))
    assert out.bars == 4 and out.fit.status in (("extended",) if bars == 2 else ("fits", "stretched"))
    assert out.fit.reserved_tail_s >= 3.5
    assert abs(out.tail_s - round(out.tail_s * 140 / 60) * 60 / 140) * 1000 <= 5.0  # VOICE OUT on a beat
    x = out.audio.mean(axis=0).astype(np.float64)
    win = int(0.25 * 44100)
    rms = [np.sqrt(np.mean(x[i:i + win] ** 2)) for i in range(0, x.size - win, win)]
    assert 20 * np.log10(rms[-1] / max(rms)) < -30  # the tail has died away before the end: nothing chopped
    # auto_tail off keeps the requested length when the speech itself fits (the FX tail may then be cut)
    off = api.render(we_are, [None, None], _req("pact", bars=2, auto_tail=False))
    assert off.fit.reserved_tail_s == 0.0 and off.bars == 2 and off.fit.status in ("fits", "stretched")


def test_tail_room_follows_the_chain(we_are):
    from fvwks_fx.pipeline import Params, tail_room_s

    def room(pid, **space):
        chain = api.get_preset(pid).chain.model_copy(deep=True)
        for m in chain.modules:
            if m.id == "space":
                m.params.update(space)
        pre = api.get_preset(pid)
        p = Params(api.resolve(chain, pre.macros, pre.macro_map))
        return tail_room_s(p, 140.0, we_are.info.segments, p.f("edit", "tape_stop_beats") if p.on("edit") else 0.0)

    assert room("signal") == 0.0  # a tape-stop is the ending
    assert room("raw") == 0.25  # just the release
    assert room("pact") == 4.0  # the thrown last word: six dotted-quarter echoes to -30 dB
    assert room("pact", throw_send=0.0) < 1.0 and room("ghost", throw_send=0.0) >= 2.0  # GHOST's 6 s tail


def test_free_length(we_are):
    out = api.render(we_are, [], _req("raw", bars=None, tail_beats=2))
    beats = out.audio.shape[1] / 44100 / (60 / 140)
    assert out.fit.status == "free" and beats == pytest.approx(round(beats), abs=1e-3)


@pytest.mark.parametrize("mode,check", [("bake", "peak"), ("custom", "integrated")])
def test_other_master_modes(we_are, mode, check):
    req = _req("pact").model_copy(update={"master": Master(mode=mode, target_lufs=-14.0)})
    out = api.render(we_are, [None, None], req)
    if check == "peak":
        assert MS.sample_peak(out.audio) == pytest.approx(-6.0, abs=0.05)
    else:
        assert MS.integrated_lufs(out.audio, 44100) == pytest.approx(-14.0, abs=0.5)
        assert MS.true_peak(out.audio, 44100) <= -1.0 + 1e-6


def test_48k_output(we_are):
    req = _req("unit").model_copy(update={"master": Master(sample_rate=48000)})
    out = api.render(we_are, [], req)
    assert out.sample_rate == 48000 and out.audio.shape[1] == round(4 * 240 / 140 * 48000)


def test_stems(we_are, we_are_stack):
    req = _req("pact").model_copy(update={"stems": True})
    out = api.render(we_are, _stack_for("pact", we_are_stack), req)
    assert set(out.stems) == {"dry", "voice", "layers", "fx"}
    for v in out.stems.values():
        assert v.shape == out.audio.shape and np.all(np.isfinite(v)) and np.max(np.abs(v)) <= 1.0


# --------------------------------------------------------------------------- mask strength


def _chain(**mask) -> Chain:
    return Chain(modules=[ModuleState(id="mask", params=mask)])


def test_mask_strength_levels(recording):
    pitch_only = api.render(recording, [], RenderRequest(source_id="r", chain=_chain(pitch_st=-5.0), quality="preview"))
    assert pitch_only.mask.level == "weak"
    assert any("Pitch-only" in r for r in pitch_only.mask.reasons)
    raw = api.render(recording, [], _req("raw", "preview"))
    assert raw.mask.level == "medium", raw.mask.reasons
    pact = api.render(recording, [None, None], _req("pact", "preview"))
    assert pact.mask.level == "strong", pact.mask.reasons
    assert pact.mask.score > raw.mask.score > pitch_only.mask.score


def test_tts_is_synthetic(we_are):
    out = api.render(we_are, [], RenderRequest(source_id="t", chain=_chain(pitch_st=-5.0), quality="preview"))
    assert out.mask.level == "synthetic"


# --------------------------------------------------------------------------- resolve / macros


def test_macros_at_half_reproduce_the_preset():
    pre = api.get_preset("pact")
    ch = api.resolve(pre.chain, pre.macros, pre.macro_map)
    params = {m.id: m.params for m in ch.modules}
    assert params["mask"]["pitch_st"] == pytest.approx(-9.0)
    assert params["mask"]["formant_st"] == pytest.approx(-5.0)
    assert params["drive"]["drive_db"] == pytest.approx(8.0)  # tape carries the grit (rack 1.2.0)
    assert params["drive"]["color"] == "tape" and params["drive"]["color_drive"] == pytest.approx(0.55)


def test_resolve_interpolates_clamps_and_fills():
    mm = MacroMap(depth=[{"module": "mask", "param": "pitch_st", "min": 0, "max": -40},
                         {"module": "space", "param": "reverb_mix", "min": -0.2, "max": 0.2}],
                  grit=[{"module": "drive", "param": "drive_db", "min": 1, "max": 30, "curve": "exp"}])
    ch = api.resolve(Chain(modules=[ModuleState(id="mask")]), Macros(depth=1.0, grit=0.5), mm)
    p = {m.id: m for m in ch.modules}
    assert p["mask"].params["pitch_st"] == -24.0  # clamped to the rack range
    assert p["space"].params["reverb_mix"] == pytest.approx(0.2)
    assert p["drive"].params["drive_db"] == pytest.approx(30**0.5, rel=1e-3)
    assert not p["space"].enabled and not p["drive"].enabled  # macro targets never switch modules on
    assert set(p["tone"].params) == {s.id for s in next(m for m in api.rack_schema().modules if m.id == "tone").params}
    ch0 = api.resolve(Chain(modules=[ModuleState(id="mask")]), Macros(depth=0.0), mm)
    assert {m.id: m for m in ch0.modules}["space"].params["reverb_mix"] == 0.0  # dead zone below 0.5


def test_presets_validate_and_macros_hit_enabled_modules():
    for pre in api.list_presets():
        enabled = {m.id for m in pre.chain.modules if m.enabled}
        for macro in ("depth", "grit", "machine", "space"):
            targets = getattr(pre.macro_map, macro)
            assert targets, f"{pre.id}: {macro} does nothing"
            assert any(t.module in enabled for t in targets), f"{pre.id}: {macro} only targets disabled modules"


# --------------------------------------------------------------------------- memoization


def test_stage_memo_skips_upstream(we_are):
    STAGES.clear()
    req = _req("pact", "preview")
    first = api.render(we_are, [None, None], req)
    again = api.render(we_are, [None, None], req)
    assert np.array_equal(first.audio, again.audio)
    assert again.timings_ms["total"] < first.timings_ms["total"]
    ch = req.chain.model_copy(deep=True)
    for m in ch.modules:
        if m.id == "space":
            m.params["reverb_decay_s"] = 2.0
    tweaked = api.render(we_are, [None, None], req.model_copy(update={"chain": ch}))
    assert tweaked.timings_ms["mask"] < 1.0 and tweaked.timings_ms["layers"] < 1.0  # served from the memo
    assert not np.array_equal(tweaked.audio, first.audio)


def test_analyze_warms_the_cache(we_are):
    from fvwks_fx.modules import mask as M
    from fvwks_fx.pipeline import source_audio48

    M.ANALYSIS_CACHE.clear()
    api.analyze(we_are)
    assert M.cached_analysis(source_audio48(we_are), 48000, "harvest") is not None


def test_stack_segment_mismatch_falls_back(we_are, remember):
    out = api.render(we_are, [remember], RenderRequest(
        source_id="t", chain=_chain(pitch_st=-3.0), quality="preview",
        stack=[StackVoice(voice_id="kokoro:bm_george", pitch_st=-5, gain_db=-10)]))
    assert np.all(np.isfinite(out.audio))
    assert any("segments" in w for w in out.warnings)


# --------------------------------------------------------------------------- v0.1: words, tail cue


def _with_words(src, throw_word: bool = True, flagged_segment: bool = True):
    """we_are with word timings on segment 1 ('EXPECT *US*'): 'expect' plain, 'us' thrown."""
    segs = [seg.model_copy(deep=True) for seg in src.info.segments]
    s1 = segs[1]
    mid = s1.start_s + 0.55 * (s1.end_s - s1.start_s)
    segs[1] = s1.model_copy(update={
        "words": [Word(text="expect", start_s=s1.start_s + 0.02, end_s=mid, throw=False),
                  Word(text="us", start_s=mid + 0.02, end_s=s1.end_s - 0.05, throw=throw_word)],
        "flags": s1.flags.model_copy(update={"throw": flagged_segment}),
    })
    info = src.info.model_copy(update={"segments": segs})
    return type(src)(info=info, audio=src.audio)


def test_output_segments_carry_words_on_the_timeline(we_are):
    src = _with_words(we_are)
    out = api.render(src, [], _req("raw", "preview", first_word_beat=2, snap_end="off"))
    words = out.segments[1].words
    assert [w.text for w in words] == ["expect", "us"] and [w.throw for w in words] == [False, True]
    # natural timing, no stretch: word offsets inside the segment are preserved exactly
    src_seg = src.info.segments[1]
    for w, sw in zip(words, src_seg.words):
        assert w.start_s - out.segments[1].start_s == pytest.approx(sw.start_s - src_seg.start_s, abs=1e-4)
        assert w.end_s - w.start_s == pytest.approx(sw.end_s - sw.start_s, abs=1e-4)
        assert out.segments[1].start_s - 1e-6 <= w.start_s < w.end_s <= out.segments[1].end_s + 1e-6
    assert out.segments[0].start_s == pytest.approx(out.first_word_s)  # 2 beats of pre-roll


def test_tail_s_is_voice_out(we_are):
    """Ruling (integration i1): tail_s = end of the last word on the output timeline (memory cue "VOICE OUT"),
    independent of any reserved ring-out."""
    plain = api.render(we_are, [], _req("raw", "preview"))
    assert plain.tail_s == pytest.approx(max(s.end_s for s in plain.segments), abs=1e-4)
    ring = api.render(we_are, [], _req("raw", "preview", tail_beats=4))
    assert ring.tail_s == pytest.approx(max(s.end_s for s in ring.segments), abs=1e-4)
    assert ring.first_word_s < ring.tail_s < 12 * 60 / 140  # before the reserved ring-out, not at its start
    worded = api.render(_with_words(we_are), [], _req("raw", "preview", first_word_beat=2))
    assert worded.tail_s == pytest.approx(worded.segments[-1].words[-1].end_s, abs=1e-4)
    assert worded.tail_s <= worded.segments[-1].end_s + 1e-6


def test_output_segments_serialize_without_pydantic_warnings(we_are):
    """RenderInfo embeds these segments: words must be real ``Word`` models (no serializer warnings)."""
    import warnings

    from pydantic import TypeAdapter

    out = api.render(_with_words(we_are), [], _req("raw", "preview"))
    assert all(isinstance(w, Word) for seg in out.segments for w in seg.words)
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        TypeAdapter(list[Segment]).dump_json(out.segments)


def test_auto_bars_reports_the_count_it_rendered(we_are):
    req = _req("raw", quality="preview", bars="auto")
    out = api.render(we_are, [], req)
    assert out.bars in (1, 2, 4, 8, 16)
    assert out.audio.shape[1] == round(out.bars * 240 / 140 * out.sample_rate)
    free = api.render(we_are, [], _req("raw", quality="preview", bars=None))
    assert free.bars is None


@pytest.mark.parametrize("bars", ["auto", 1])
def test_radio_bed_and_its_echoes_end_inside_the_file(bars):
    # QA v1.0.0: LEGION's noise bed closes 0.25 s after the speech with a squelch, and DYNAMICS brings it up nearly
    # to the voice, so its delay echo was cut by a tight 2-bar file end (the last 50 ms sat at -35 dBFS). It now
    # closes sooner when the file is tight -- still after the last word -- and the drop doesn't grow for it.
    import sys
    from pathlib import Path

    from fvwks_fx.pipeline import BED_END_MARGIN_S, TAIL_FLOOR_DB

    sys.path.insert(0, str(Path(__file__).parent))
    from conftest import load_voice

    out = api.render(load_voice("remember_remember"), [None, None], _req("legion", bars=bars, bpm=120))
    x = out.audio.astype(np.float64)
    db = lambda z: 10 * np.log10(np.mean(z**2) + 1e-30)
    assert db(x[:, -int(0.05 * out.sample_rate):]) < db(x) + TAIL_FLOOR_DB
    assert out.bars == 2 and out.fit.reserved_tail_s == 0.5  # the voice's tail room: same length as before the fix
    close = max(e.t for e in out.motion.events if e.kind == "squelch")  # the closing burst, where the audio has it
    assert out.tail_s - 0.09 <= close and close + 0.09 <= out.audio.shape[1] / out.sample_rate - BED_END_MARGIN_S

