"""ARRANGE: exact lengths, first word on the grid, fit (pad / R3 stretch / overflow), Beat-Lock, pauses,
stutter and tape-stop."""

import math

import numpy as np
import pytest

from fvwks_fx import arrange as A
from fvwks_fx.master import output_samples
from fvwks_fx.music import beat_seconds, note_seconds

SR = 48000


@pytest.mark.parametrize("bars,bpm,sr,expected", [
    (4, 140, 44100, 302_400),  # the brief's example
    (1, 140, 44100, 75_600),
    (8, 140, 44100, 604_800),
    (2, 128, 44100, 165_375),
    (16, 174, 48000, round(16 * 240 / 174 * 48000)),
    (4, 120, 48000, 384_000),
])
def test_output_samples_is_bar_exact(bars, bpm, sr, expected):
    assert output_samples(bars, bpm, sr) == expected


def _onset(x: np.ndarray, sr: int = SR, rel_db: float = -32.0) -> int:
    return A.onset_sample(x, sr, rel_db=rel_db)


@pytest.mark.parametrize("fwb", [0.0, 1.0, 4.0])
def test_first_word_lands_on_the_pre_roll_point(we_are, fwb):
    plan = A.plan_placement(we_are.audio, SR, we_are.info.segments, bpm=140, bars=4, first_word_beat=fwb)
    out = A.apply_placement(plan, we_are.audio)
    target = int(round(fwb * beat_seconds(140) * SR))
    assert plan.first_word_s == pytest.approx(fwb * beat_seconds(140))
    assert plan.placed[0].start_s == pytest.approx(plan.first_word_s)
    assert abs(_onset(out) - target) <= int(0.003 * SR)  # onset within 3 ms of the grid point
    assert 0 <= _onset(out, rel_db=-20.0) - target <= int(0.025 * SR)  # the word itself, not a breath
    if target > int(0.002 * SR):
        assert np.max(np.abs(out[:, : target - int(0.002 * SR)])) < 1e-3  # silence before it


def test_fit_pads_when_it_fits(we_are):
    plan = A.plan_placement(we_are.audio, SR, we_are.info.segments, bpm=140, bars=4)
    assert plan.fit.status == "fits" and plan.factor == 1.0
    assert plan.fit.speech_s < plan.fit.available_s == pytest.approx(4 * 240 / 140)
    assert plan.n_samples >= int(4 * 240 / 140 * SR)


def test_fit_stretches_a_little_with_r3(we_are):
    natural = A.plan_placement(we_are.audio, SR, we_are.info.segments, bpm=140, bars=4).fit.speech_s
    bpm = 2 * 240 / (natural / 1.05)  # 2 bars ~5 % too short
    plan = A.plan_placement(we_are.audio, SR, we_are.info.segments, bpm=bpm, bars=2)
    assert plan.fit.status == "stretched"
    assert 0.92 <= plan.fit.stretch_ratio < 1.0
    out = A.apply_placement(plan, we_are.audio)
    end = A.offset_sample(out, SR)
    assert end <= int(2 * 240 / bpm * SR)  # the stretched speech ends inside the 2 bars


def test_fit_pad_mode_never_stretches(we_are):
    natural = A.plan_placement(we_are.audio, SR, we_are.info.segments, bpm=140, bars=4).fit.speech_s
    bpm = 2 * 240 / (natural / 1.05)
    plan = A.plan_placement(we_are.audio, SR, we_are.info.segments, bpm=bpm, bars=2, fit_mode="pad")
    assert plan.fit.status == "extended" and plan.factor == 1.0 and plan.fit.bars == 4  # v0.4: grows, never cuts


def test_too_long_grows_to_the_next_bar_count(we_are):
    # v0.4: speech is never cut at the bar line; the render grows to the next count that holds it
    plan = A.plan_placement(we_are.audio, SR, we_are.info.segments, bpm=140, bars=1)
    assert plan.fit.status == "extended" and plan.fit.bars == 2 and plan.fit.suggested_bars == 2
    assert plan.length_s == pytest.approx(2 * 240 / 140) and plan.speech_end_s <= plan.length_s
    assert "Extended to 2 bars" in plan.fit.message
    # past 16 bars it grows in whole bars
    plan = A.plan_placement(we_are.audio, SR, we_are.info.segments, bpm=140, bars=1, tail_room_s=30.0)
    bars = math.ceil((30.0 + plan.fit.speech_s) / (240 / 140))
    assert plan.fit.status == "extended" and plan.fit.bars == bars > 16 and plan.speech_end_s + 30.0 <= plan.length_s


def test_tail_room_is_kept_after_the_last_word(we_are):
    plain = A.plan_placement(we_are.audio, SR, we_are.info.segments, bpm=140, bars=4)
    kept = A.plan_placement(we_are.audio, SR, we_are.info.segments, bpm=140, bars=4, tail_room_s=2.0)
    assert kept.fit.reserved_tail_s == 2.0 and kept.fit.available_s == pytest.approx(plain.fit.available_s - 2.0)
    assert kept.speech_end_s + 2.0 <= kept.length_s + 1e-6 and "2.00s tail" in kept.fit.message
    # a tail that can't fit even squeezed grows the render instead of chopping the echo
    long = A.plan_placement(we_are.audio, SR, we_are.info.segments, bpm=140, bars=2, tail_room_s=2.0)
    assert long.fit.status == "extended" and long.fit.bars == 4
    # AUTO counts the tail when it picks the length
    auto = A.plan_placement(we_are.audio, SR, we_are.info.segments, bpm=140, bars="auto", tail_room_s=4.0)
    assert auto.speech_end_s + 4.0 <= auto.length_s + 1e-6 and auto.fit.status in ("fits", "stretched")


def test_free_length_is_whole_beats(we_are):
    plan = A.plan_placement(we_are.audio, SR, we_are.info.segments, bpm=140, bars=None, tail_beats=1)
    beats = plan.length_s / beat_seconds(140)
    assert plan.fit.status == "free" and beats == pytest.approx(round(beats))
    assert plan.length_s >= plan.fit.speech_s + beat_seconds(140)


def test_beat_lock_starts_chunks_on_beats(remember):
    plan = A.plan_placement(remember.audio, SR, remember.info.segments, bpm=140, bars=8, beat_lock=True)
    beat = beat_seconds(140)
    segs = remember.info.segments
    for prev, cur in zip(segs, plan.placed[1:]):
        if prev.flags.beat_break:
            chunk_start = [st for c, st in zip(plan.chunks, plan.starts_s) if cur.index in [segs[i].index for i in c.seg_idx]]
            assert chunk_start and (chunk_start[0] / beat) == pytest.approx(round(chunk_start[0] / beat), abs=1e-6)
    off = A.plan_placement(remember.audio, SR, remember.info.segments, bpm=140, bars=8, beat_lock=False)
    assert len(off.chunks) == 1  # without Beat-Lock the natural timing is kept as one chunk


def _chunk_onsets_ms(plan: A.PlacementPlan, out: np.ndarray) -> list[float]:
    """Audible onset of each chunk in the render, relative to the grid point it was laid out on (ms)."""
    res = []
    for i, st in enumerate(plan.starts_s):
        a = max(0, int(round(st * SR)) - int(0.002 * SR))
        b = int(round((plan.starts_s[i + 1] if i + 1 < len(plan.starts_s) else plan.speech_end_s) * SR))
        res.append(((a + _onset(out[:, a:b])) / SR - st) * 1000)
    return res


@pytest.mark.parametrize("name", ["we_are__am_fenrir", "we_are__am_michael", "we_are__bm_george",
                                  "remember__am_fenrir", "remember__am_michael", "remember__bm_george"])
@pytest.mark.parametrize("bpm", [140, 174])
def test_beat_locked_chunks_land_their_onset_on_the_beat(loaders, name, bpm):
    # Regression (S1 review): locked chunks were placed by their segment's lead-in (pre-pad, TTS pad, consonant
    # rise), so the sound came 22-68 ms after the beat on S1 sources and ~240-420 ms on these fixtures.
    src = loaders["source"](name)
    plan = A.plan_placement(src.audio, SR, src.info.segments, bpm=bpm, bars=8, beat_lock=True)
    assert len(plan.chunks) > 1
    beat = beat_seconds(bpm)
    for st in plan.starts_s:
        assert (st / beat) == pytest.approx(round(st / beat), abs=1e-6)
    errs = _chunk_onsets_ms(plan, A.apply_placement(plan, src.audio))
    assert all(0.0 <= e <= 2.0 for e in errs), errs  # 1 ms pre-roll before each onset, nothing later


def test_beat_pause_ends_at_the_next_onset(we_are):
    segs = [s.model_copy(deep=True) for s in we_are.info.segments]
    segs[0].flags.pause_after_beats = 2.0
    segs[0].flags.beat_break = False
    for bpm in (100, 140, 160):
        plan = A.plan_placement(we_are.audio, SR, segs, bpm=bpm, bars=8)
        out = A.apply_placement(plan, we_are.audio)
        onset = plan.starts_s[1] + _chunk_onsets_ms(plan, out)[1] / 1000
        assert onset - plan.placed[0].end_s == pytest.approx(2 * beat_seconds(bpm), abs=0.002)


def test_beat_pause_uses_render_tempo(we_are):
    segs = [s.model_copy(deep=True) for s in we_are.info.segments]
    segs[0].flags.pause_after_beats = 2.0
    segs[0].flags.beat_break = False
    for bpm in (100, 160):
        plan = A.plan_placement(we_are.audio, SR, segs, bpm=bpm, bars=8)
        gap = plan.placed[1].start_s - plan.placed[0].end_s
        # the chunk starts 2 beats after the first segment's speech end (+ the segment's own lead-in)
        assert gap == pytest.approx(2 * beat_seconds(bpm), abs=0.03)


def test_stutter_repeats_the_first_slice(we_are):
    slice_s = note_seconds("1/16", 140)
    plan = A.plan_placement(we_are.audio, SR, we_are.info.segments, bpm=140, bars=4, stutter_div="1/16", stutter_repeats=4)
    out = A.apply_placement(plan, we_are.audio)
    ln = int(round(slice_s * SR))
    a, b = out[0, int(0.004 * SR) : ln - int(0.004 * SR)], out[0, ln + int(0.004 * SR) : 2 * ln - int(0.004 * SR)]
    assert np.corrcoef(a, b)[0, 1] > 0.98
    plain = A.plan_placement(we_are.audio, SR, we_are.info.segments, bpm=140, bars=4)
    assert plan.fit.speech_s == pytest.approx(plain.fit.speech_s + 3 * slice_s, abs=1e-6)


def test_tape_stop_slows_then_silences():
    sr = SR
    t = np.arange(int(2.0 * sr)) / sr
    x = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)[None, :].repeat(2, axis=0)
    y = A.tape_stop(x, sr, end_s=1.5, beats=1, bpm=120)  # the last 0.5 s slows to a stop over 1.0 s
    assert np.allclose(y[:, : int(0.99 * sr)], x[:, : int(0.99 * sr)])
    assert np.max(np.abs(y[:, int(2.0 * sr) - 10 :])) < 1e-3 or y.shape[1] <= int(2.0 * sr)
    seg = y[0, int(1.6 * sr) : int(1.9 * sr)]
    zc = np.sum(np.abs(np.diff(np.sign(seg)))) / 2 / 0.3  # zero crossings/s ~ 2 f
    assert zc < 0.8 * 2 * 440  # pitch has dropped


def test_placement_is_identical_for_wet_and_dry(we_are):
    plan = A.plan_placement(we_are.audio, SR, we_are.info.segments, bpm=140, bars=4, beat_lock=True)
    a = A.apply_placement(plan, we_are.audio)
    b = A.apply_placement(plan, we_are.audio * 0.5)
    assert np.allclose(a * 0.5, b, atol=1e-6)


def test_throws_follow_exactly_the_flagged_words(we_are):
    segs = [seg.model_dump() for seg in we_are.info.segments]
    s1 = segs[1]
    mid = s1["start_s"] + 0.5 * (s1["end_s"] - s1["start_s"])
    s1["words"] = [{"text": "expect", "start_s": s1["start_s"], "end_s": mid, "throw": False},
                   {"text": "us", "start_s": mid, "end_s": s1["end_s"], "throw": True}]
    plan = A.plan_placement(we_are.audio, SR, segs, bpm=140, bars=4, first_word_beat=1)
    spans = [sp for pl in plan.placed for sp in pl.throw_spans]
    assert len(spans) == 1
    us = plan.placed[1].words[1]
    assert spans[0] == pytest.approx((us.start_s - A.THROW_LEAD_S, us.end_s))  # opens early for the attack
    # flagged segment but no flagged word (inconsistent input) -> the whole segment, never a silently lost throw
    s1["words"][1]["throw"] = False
    plan = A.plan_placement(we_are.audio, SR, segs, bpm=140, bars=4)
    spans = [sp for pl in plan.placed for sp in pl.throw_spans]
    assert spans == [(plan.placed[1].start_s, plan.placed[1].end_s)]
    # no flag and no flagged word -> nothing is thrown
    s1["flags"]["throw"] = False
    plan = A.plan_placement(we_are.audio, SR, segs, bpm=140, bars=4)
    assert not [sp for pl in plan.placed for sp in pl.throw_spans]
    s1["flags"]["throw"] = True
    # no word timings (recordings, pre-v0.1 sources) -> the whole flagged segment
    s1.pop("words")
    plan = A.plan_placement(we_are.audio, SR, segs, bpm=140, bars=4)
    spans = [sp for pl in plan.placed for sp in pl.throw_spans]
    assert spans == [(plan.placed[1].start_s, plan.placed[1].end_s)]


def test_words_follow_stretch_and_beat_lock(we_are):
    segs = [seg.model_dump() for seg in we_are.info.segments]
    for sg in segs:
        sg["words"] = [{"text": "w", "start_s": sg["start_s"] + 0.1, "end_s": sg["end_s"] - 0.1, "throw": False}]
    natural = A.plan_placement(we_are.audio, SR, segs, bpm=140, bars=4).fit.speech_s
    bpm = 2 * 240 / (natural / 1.04)
    stretched = A.plan_placement(we_are.audio, SR, segs, bpm=bpm, bars=2)
    assert stretched.fit.status == "stretched"
    for i, (pl, sg) in enumerate(zip(stretched.placed, segs)):
        w = pl.words[0]
        assert pl.start_s <= w.start_s < w.end_s <= pl.end_s + 1e-9
        if i:  # (the first word may start before the detected onset and is clamped to the first-word point)
            assert (w.end_s - w.start_s) == pytest.approx((sg["end_s"] - sg["start_s"] - 0.2) / stretched.factor, rel=1e-6)
    # Beat-Lock layouts shrink in whole beats, so an 8 % stretch can't always save one: it grows (v0.4)
    for sg in segs:  # words after the fixture's leading silence, so they follow the chunk's onset
        sg["words"] = [{"text": "w", "start_s": sg["start_s"] + 0.3, "end_s": sg["end_s"] - 0.1, "throw": False}]
    locked = A.plan_placement(we_are.audio, SR, segs, bpm=140, bars=4, beat_lock=True)
    beat = beat_seconds(140)
    assert (locked.starts_s[1] / beat) == pytest.approx(round(locked.starts_s[1] / beat), abs=1e-6)
    w = locked.placed[1].words[0]
    assert locked.placed[1].start_s == pytest.approx(locked.starts_s[1])  # the segment opens on its beat
    expected = segs[1]["start_s"] + 0.3 - locked.chunks[1].src0 / SR
    assert 0.0 < expected and w.start_s - locked.placed[1].start_s == pytest.approx(expected / locked.factor, abs=1e-6)


def test_auto_bars_resolves_on_the_arranged_length(we_are, remember):
    from fvwks_contracts.audio import resolve_auto_bars

    for src, lock in ((we_are, False), (remember, True)):
        plan = A.plan_placement(src.audio, SR, src.info.segments, bpm=140, bars="auto", beat_lock=lock)
        assert plan.fit.status in ("fits", "stretched")  # AUTO never overflows while a standard count fits
        assert plan.fit.bars == resolve_auto_bars(plan.fit.speech_s, 140)
        assert plan.length_s == pytest.approx(plan.fit.bars * 240 / 140)
        assert plan.fit.message.startswith(f"AUTO → {plan.fit.bars:g} bars")
    # pre-roll counts against the room, as in the resolver
    plan = A.plan_placement(we_are.audio, SR, we_are.info.segments, bpm=140, bars="auto", first_word_beat=4)
    assert plan.fit.bars == resolve_auto_bars(plan.fit.speech_s, 140, first_word_beat=4)


def test_auto_bars_moves_up_when_the_layout_cannot_shrink():
    bar = 240 / 140
    # 4.3 bars squeezes 7.5 % into 4 when the layout shrinks in proportion ...
    assert A.auto_bars(4.3 * bar, 4.3 * bar / 1.08, 140, 0, 0, 0.08) == 4
    # ... but a Beat-Lock layout that only shrinks to 4.2 bars needs 8
    assert A.auto_bars(4.3 * bar, 4.2 * bar, 140, 0, 0, 0.08) == 8
    assert A.auto_bars(40 * bar, 38 * bar, 140, 0, 0, 0.08) == 16  # nothing fits: the longest, like the resolver


def test_auto_bars_in_pad_mode_never_squeezes(we_are):
    plan = A.plan_placement(we_are.audio, SR, we_are.info.segments, bpm=128, bars="auto", fit_mode="pad")
    assert plan.fit.status == "fits" and plan.factor == 1.0
    assert plan.fit.speech_s <= plan.fit.available_s + 1e-6


def _voice_out_s(plan):
    from fvwks_fx.pipeline import _voice_out

    return _voice_out(plan)


def _grid_err_ms(t, grid_s):
    return abs(t - round(t / grid_s) * grid_s) * 1000


@pytest.mark.parametrize("bpm", [120, 128, 140, 160, 174])
def test_snap_end_puts_the_last_word_on_a_beat(we_are, bpm):
    # v0.4.1 (the user: "manipulate, not space out"): warp so the last word ends exactly on a beat
    plan = A.plan_placement(we_are.audio, SR, we_are.info.segments, bpm=bpm, bars=4, snap_end="beat", tail_room_s=0.25)
    assert _grid_err_ms(_voice_out_s(plan), beat_seconds(bpm)) <= 5.0
    assert abs(plan.fit.stretch_ratio - 1.0) <= 0.08 + 1e-9 and plan.placed[0].start_s == pytest.approx(plan.first_word_s)
    assert "last word on the beat" in plan.fit.message


@pytest.mark.parametrize("bpm", [160, 174])
def test_snap_end_bar_lands_on_the_bar_line(we_are, bpm):
    plan = A.plan_placement(we_are.audio, SR, we_are.info.segments, bpm=bpm, bars=4, snap_end="bar", tail_room_s=0.25)
    assert _grid_err_ms(_voice_out_s(plan), 4 * beat_seconds(bpm)) <= 5.0 and "on the bar" in plan.fit.message


def test_snap_end_bar_falls_back_to_the_nearest_reachable_beat(we_are):
    plan = A.plan_placement(we_are.audio, SR, we_are.info.segments, bpm=140, bars=4, snap_end="bar", tail_room_s=0.25)
    assert _grid_err_ms(_voice_out_s(plan), beat_seconds(140)) <= 5.0 and "on the beat" in plan.fit.message


def test_snap_end_off_keeps_the_natural_length(we_are):
    plan = A.plan_placement(we_are.audio, SR, we_are.info.segments, bpm=140, bars=4, snap_end="off")
    assert plan.factor == 1.0 and plan.fit.status == "fits"


def test_snap_end_with_beat_lock(remember):
    beat = beat_seconds(140)
    exact = A.plan_placement(remember.audio, SR, remember.info.segments, bpm=140, bars=8, beat_lock=True, snap_end="beat")
    assert _grid_err_ms(_voice_out_s(exact), beat) <= 5.0
    # locked starts only let the last chunk's length move: the closest approach counts when it is near ...
    near = A.plan_placement(remember.audio, SR, remember.info.segments, bpm=128, bars=8, beat_lock=True, snap_end="beat")
    assert _grid_err_ms(_voice_out_s(near), beat_seconds(128)) <= A.SNAP_NEAR_S * 1000 and "Beat-Lock allows" in near.fit.message
    # ... and when nothing is in reach, the natural timing stays (said in the message) rather than a pointless warp
    far = A.plan_placement(remember.audio, SR, remember.info.segments, bpm=120, bars=8, beat_lock=True, snap_end="beat")
    assert far.factor == 1.0 and "out of stretch reach" in far.fit.message



# --------------------------------------------------------------------------- v0.8 chop


def _four_words(lengths=(0.2, 0.2, 0.2, 0.2), gap=0.05):
    """Four tone bursts ("words") with word timings, as one segment."""
    t, words, x = 0.1, [], np.zeros((1, int(SR * (0.2 + sum(lengths) + gap * 4))), np.float32)
    for i, ln in enumerate(lengths):
        a, b = int(t * SR), int((t + ln) * SR)
        x[0, a:b] = 0.5 * np.sin(2 * np.pi * 220 * np.arange(b - a) / SR)
        words.append({"text": f"W{i}", "start_s": t, "end_s": t + ln})
        t += ln + gap
    return x, [{"index": 0, "text": "W0 W1 W2 W3", "start_s": words[0]["start_s"], "end_s": words[-1]["end_s"],
                "flags": {}, "words": words}]


def test_chop_beat_puts_each_word_on_its_beat():
    x, segs = _four_words()
    plan = A.plan_placement(x, SR, segs, bpm=120, bars="auto", chop="beat")
    beat = beat_seconds(120)
    assert plan.chop == [(0, 0.0), (1, 1.0), (2, 2.0), (3, 3.0)] and plan.fit.bars == 1
    assert [round(st * SR) for st in plan.starts_s] == [round(k * beat * SR) for k in range(4)]  # exact samples
    out = A.apply_placement(plan, x)
    for k in range(4):  # each word sounds from its beat (the 1 ms pre-roll of the onset, then the 5 ms fade)
        slot = int(round(k * beat * SR))
        a = max(0, slot - int(0.002 * SR))
        assert 0 <= (a + _onset(out[:, a: slot + int(0.2 * SR)])) - slot <= int(0.004 * SR)
    assert [w.start_s for w in plan.placed[0].words] == pytest.approx([0, beat, 2 * beat, 3 * beat], abs=0.002)


def test_chop_custom_slots_squeeze_then_slide_never_cut():
    x, segs = _four_words(lengths=(0.2, 0.2, 0.26, 0.2))
    beat = beat_seconds(120)
    slots = [{"index": 0, "beat": 0}, {"index": 1, "beat": 2}, {"index": 2, "beat": 2.5}, {"index": 3, "beat": 3}]
    plan = A.plan_placement(x, SR, segs, bpm=120, bars=2, chop="custom", chop_slots=slots)
    assert plan.chop == [(0, 0.0), (1, 2.0), (2, 2.5), (3, 3.0)]  # honoured
    assert 1.0 < plan.factors[2] <= 1.08 and plan.fit.status == "stretched"  # squeezed into its half beat
    speech = [(c.speech_end - c.src0) / SR for c in plan.chunks]
    assert plan.starts_s[2] + speech[2] / plan.factors[2] <= plan.starts_s[3] + 1e-9

    x, segs = _four_words(lengths=(0.2, 0.2, 0.45, 0.2))  # too long for R3's 8 %: the next slot moves, no cut
    plan = A.plan_placement(x, SR, segs, bpm=120, bars=2, chop="custom", chop_slots=slots)
    assert plan.chop[:3] == [(0, 0.0), (1, 2.0), (2, 2.5)] and plan.chop[3][1] == 4.0  # next beat after it ends
    speech = [(c.speech_end - c.src0) / SR for c in plan.chunks]
    assert plan.starts_s[2] + speech[2] / plan.factors[2] <= plan.starts_s[3] + 1e-9
    out = A.apply_placement(plan, x)
    word2 = out[:, int(2.5 * beat * SR): int(4.0 * beat * SR)]
    assert np.sum(np.abs(word2) > 0.05) / SR >= 0.4  # the whole 0.45 s word is in the render
