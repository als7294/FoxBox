"""Chunk clips without a model: exact start, and an end that keeps the natural release."""

import numpy as np
import pytest

from fvwks_voice import synth
from fvwks_voice.dsp import SR, frame_db
from fvwks_voice.engine import PhraseAudio


def _phrase(tail_db: float = -40.0, tail_db_per_s: float = -110.0, tail_s: float = 0.5) -> tuple[PhraseAudio, float]:
    """24 kHz: 100 ms silence, 500 ms of "speech", then a `tail_s` breathy release decaying from `tail_db` at
    `tail_db_per_s`, then 300 ms of silence. Returns the phrase and when the speech stops (s)."""
    sr = 24_000
    rng = np.random.default_rng(5)
    t = np.arange(int((0.9 + tail_s) * sr)) / sr
    speech = (t >= 0.1) & (t < 0.6)
    x = np.where(speech, rng.standard_normal(t.size) * 0.3, 0.0)
    tail = (t >= 0.6) & (t < 0.6 + tail_s)
    level = 0.3 * 10 ** ((tail_db + tail_db_per_s * (t - 0.6)) / 20)
    x = np.where(tail, rng.standard_normal(t.size) * level, x).astype(np.float32)
    return PhraseAudio(audio=x, sample_rate=sr, words=[]), 0.6


def test_the_clip_keeps_the_release():
    pa, speech_end = _phrase()
    clip, at = synth._clip(pa)
    assert at == pytest.approx(0.1 - synth.PAD_START_S, abs=0.003)  # the start stays exact
    end = at + len(clip) / SR
    # -40 dB at the speech end, falling 110 dB/s: the release floor (re the loudest frame) is ~0.25 s later.
    assert end > speech_end + synth.PAD_END_S + 0.1
    assert end <= speech_end + synth.PAD_END_S + synth.RELEASE_MAX_S + 0.01
    db, _, _ = frame_db(clip, SR)
    assert db[-1] < db.max() + synth.RELEASE_REL_DB  # it ends below the release floor, faded
    assert abs(float(clip[-1])) < 1e-4


def test_a_long_release_is_capped():
    pa, speech_end = _phrase(tail_db=-55.0, tail_db_per_s=0.0, tail_s=1.0)  # under the trim level, over the floor
    clip, at = synth._clip(pa)
    end = at + len(clip) / SR
    assert end == pytest.approx(speech_end + synth.PAD_END_S + synth.RELEASE_MAX_S, abs=0.03)
