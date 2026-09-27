"""Voice-core motion data (v0.5 contracts, S2 proposal 10): plan events, returns level and pitch tracks on every
render."""

import base64

import numpy as np
import pytest

from fvwks_contracts.models import Arrange, Motion, RenderInfo, RenderRequest
from fvwks_fx import api, arrange as A, motion as MOT
from fvwks_fx.music import beat_seconds, note_seconds

SR = 48000


def _bytes(s: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(s), dtype=np.uint8)


def test_events_come_straight_from_the_plan(remember):
    plan = A.plan_placement(remember.audio, SR, remember.info.segments, bpm=140, bars=8, beat_lock=True,
                            first_word_beat=4, stutter_div="1/16", stutter_repeats=4, tape_stop_beats=1)
    ev = MOT.events(plan, bpm=140, tape_beats=1, swell_beats=4, squelch=True, throw_level_db=-4.1,
                    throw_period_s=note_seconds("1/4d", 140))
    kinds = [e["kind"] for e in ev]
    assert [e["t"] for e in ev] == sorted(e["t"] for e in ev) and all(0 <= e["t"] < plan.length_s for e in ev)
    beat, sl = beat_seconds(140), note_seconds("1/16", 140)
    assert kinds.count("beat_lock") == sum(c.lock for c in plan.chunks) == 2
    assert [e["t"] for e in ev if e["kind"] == "stutter"] == pytest.approx([4 * beat + i * sl for i in range(4)], abs=1e-3)
    tape = next(e for e in ev if e["kind"] == "tape_stop")
    assert tape["t"] == pytest.approx(plan.speech_end_s, abs=1e-3) and tape["dur"] == pytest.approx(beat, abs=1e-3)
    swell = next(e for e in ev if e["kind"] == "swell")
    assert swell["t"] == pytest.approx(0.0) and swell["t"] + swell["dur"] == pytest.approx(plan.first_word_s, abs=1e-3)
    # a -4.1 dB throw with 0.55 feedback stays above -30 dB for 5 echoes, a dotted quarter apart
    spans = [sp for pl in plan.placed for sp in pl.throw_spans]
    echoes = [e for e in ev if e["kind"] == "throw_echo"]
    assert spans and len(echoes) <= 5 * len(spans)
    assert echoes[0]["t"] == pytest.approx(spans[0][0] + note_seconds("1/4d", 140), abs=1e-3)
    assert kinds.count("squelch") == 2


def test_tracks_are_levels_and_midi_pitch(we_are):
    plan = A.plan_placement(we_are.audio, SR, we_are.info.segments, bpm=140, bars=4)
    frames = MOT.n_frames(plan.length_s)
    mix = np.random.default_rng(1).standard_normal((2, int(plan.length_s * SR))).astype(np.float32)
    ret = _bytes(MOT.level_track(mix * 0.1, mix, SR, frames))  # returns 20 dB under the mix
    assert ret.size == frames and np.median(ret) == pytest.approx(round((60 - 20) / 60 * 255), abs=3)
    f0 = np.full(1000, 110.0)  # A2 = MIDI 45, 5 ms frames
    f0[500:] = 0.0  # unvoiced from 2.5 s (source time)
    pitch = _bytes(MOT.pitch_track(plan, f0, 5.0, frames))
    assert pitch.size == frames and set(np.unique(pitch)) <= {0, 90}
    assert pitch[int((plan.starts_s[0] + 0.3) * MOT.FPS)] == 90  # voiced, mapped through the plan
    assert pitch[-1] == 0  # past the phrase: unvoiced


@pytest.mark.parametrize("preset_id,kinds,pitched", [("signal", {"stutter", "tape_stop"}, True),
                                                     ("pact", {"throw_echo"}, True),
                                                     ("ghost", {"swell", "throw_echo"}, False)])  # a full whisper
def test_pipeline_attaches_motion(we_are, preset_id, kinds, pitched):
    req = api.apply_hints(RenderRequest(source_id="x", preset_id=preset_id, quality="preview",
                                        arrange=Arrange(bpm=140, bars="auto")), api.get_preset(preset_id))
    out = api.render(we_are, [None] * len(req.stack or []), req)
    m = out.motion
    assert isinstance(m, Motion)  # the v0.5 contract model
    frames = MOT.n_frames(out.bars * 240 / 140)
    assert m.fps == 50 and _bytes(m.returns).size == frames and _bytes(m.f0).size == frames
    assert kinds <= {e.kind for e in m.events}
    assert (_bytes(m.f0).max() > 0) == pitched  # GHOST's breath 1.0 whisper has no pitch at all
    assert RenderInfo.model_fields["motion"]  # S3 copies it into RenderInfo as is
