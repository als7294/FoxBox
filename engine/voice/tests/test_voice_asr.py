"""Word timings for recordings (Whisper large-v3-turbo + Qwen3-ForcedAligner), and the editable transcript."""

import io

import numpy as np
import pytest
import soundfile as sf

from fvwks_contracts.models import TTSRequest
from fvwks_voice import api
from fvwks_voice.asr import _repair, get_transcriber, tokens
from fvwks_voice.errors import VoiceError
from fvwks_voice.ingest import ingest_audio

SR = 48_000
SCRIPT = "REMEMBER, REMEMBER, THE SIGNAL NEVER DIES. WE DO NOT FORGIVE."


def test_tokens_split_like_the_aligner():
    toks = tokens("Remember, remember the 5th signal. Don't x-ray *US*!")
    assert [t[0] for t in toks] == ["Remember", "remember", "the", "5th", "signal", "Don't", "xray", "US"]
    assert [t[2] for t in toks] == [True, False, False, False, True, False, False, True]


def test_repair_resplits_a_squeezed_word():
    words = [[1.68, 2.08], [2.08, 2.96], [2.96, 2.96]]  # the aligner's failure: "OF" swallowed "SIGNAL"
    _repair(words, ["END", "OF", "SIGNAL"], None)
    assert words[1][1] == words[2][0] == pytest.approx(2.08 + 0.88 * 2 / 8)
    assert words[0] == [1.68, 2.08]


def test_capitals_are_normalized_for_the_aligner():
    from fvwks_voice.asr import _normal_case

    assert _normal_case("REMEMBER, REMEMBER THE SIGNAL NEVER DIES") == "Remember, remember the signal never dies"
    assert tokens("REMEMBER, REMEMBER") == [("REMEMBER", 0, True), ("REMEMBER", 10, False)]  # words keep the spelling


def test_repair_prefers_whisper_when_it_has_the_word():
    words = [[2.08, 2.96], [2.96, 2.96]]
    _repair(words, ["OF", "SIGNAL"], [("of", 2.04, 2.2), ("signal", 2.2, 2.8)])
    assert words[1] == [2.2, 2.8] and words[0][1] == pytest.approx(2.2)


@pytest.fixture(scope="module")
def asr():
    t = get_transcriber()
    if not t.is_installed():
        pytest.skip("whisper-aligner not installed (api.install_model('whisper-aligner', ...))")
    return t


@pytest.fixture(scope="module")
def recording(asr, kokoro):
    """A Kokoro line played back as a noisy recording: (Source after ingest, true word times in its timeline)."""
    tts = api.synthesize(TTSRequest(script=SCRIPT, voice_id="kokoro:bm_george"))
    x = np.concatenate([np.zeros(int(0.6 * SR), np.float32), tts.audio[0], np.zeros(SR, np.float32)])
    x = x + np.random.default_rng(7).standard_normal(x.size).astype(np.float32) * 10 ** (-45 / 20)
    buf = io.BytesIO()
    sf.write(buf, x, SR, format="WAV", subtype="PCM_24")
    shift = 0.6 - ingest_audio(buf.getvalue(), "take.wav", denoise=1.0).trimmed_start_s
    src = api.ingest(buf.getvalue(), "take.wav", "recording")
    truth = [(w.text.lower(), w.start_s + shift, w.end_s + shift) for s in tts.info.segments for w in s.words]
    return src, truth


@pytest.mark.asr
def test_transcribe_fills_the_transcript_and_words(recording):
    src, truth = recording
    out = api.transcribe(src)
    assert np.array_equal(out.audio, src.audio)
    assert out.info.transcript_state == "done"
    text = (out.info.script or "").lower()
    assert all(w in text for w in ("remember", "signal", "forgive"))
    words = [w for s in out.info.segments for w in s.words]
    assert len(words) == len(truth)
    starts = [abs(w.start_s - t[1]) for w, t in zip(words, truth)]
    assert np.median(starts) < 0.04 and max(starts) < 0.15
    for s in out.info.segments:
        assert all(s.start_s <= w.start_s < w.end_s <= s.end_s for w in s.words)
        if s.words:
            assert s.words[-1].end_s == pytest.approx(s.end_s)  # the release belongs to the last word, as in TTS
            assert s.text == " ".join(w.text for w in s.words)


@pytest.mark.asr
def test_realign_turns_markup_into_segments_and_throws(recording):
    src, truth = recording
    out = api.realign(src, "REMEMBER, REMEMBER | THE SIGNAL NEVER *DIES* [2b] WE DO NOT FORGIVE")
    segs = out.info.segments
    assert [s.text for s in segs] == ["REMEMBER, REMEMBER", "THE SIGNAL NEVER *DIES*", "WE DO NOT FORGIVE"]
    assert [(s.flags.beat_break, s.flags.throw, s.flags.pause_after_beats) for s in segs] == [
        (True, False, 0.0), (False, True, 2.0), (False, False, 0.0)]
    words = [w for s in segs for w in s.words]
    assert [w.text for w in words] == ["REMEMBER", "REMEMBER", "THE", "SIGNAL", "NEVER", "DIES", "WE", "DO", "NOT",
                                       "FORGIVE"]
    assert [w.throw for w in words] == [False] * 5 + [True] + [False] * 4
    thrown = words[5]
    assert abs(thrown.start_s - truth[5][1]) < 0.08  # the throw starts on the right word
    assert out.info.script.startswith("REMEMBER, REMEMBER |") and out.info.script_hash
    assert out.info.transcript_state == "done"
    assert all(a.end_s <= b.start_s for a, b in zip(segs, segs[1:]))


@pytest.mark.asr
def test_ingest_can_add_words_inline(asr, fixtures_dir):
    data = (fixtures_dir / "voices" / "hands_up.wav").read_bytes()
    src = api.ingest(data, "hands.wav", "recording", with_words=True)
    assert "transmission" in (src.info.script or "").lower()
    assert sum(len(s.words) for s in src.info.segments) >= 6


def test_realign_rejects_tts_and_empty_transcripts(kokoro):
    tts = api.synthesize(TTSRequest(script="EXPECT US"))
    with pytest.raises(VoiceError) as e:
        api.realign(tts, "EXPECT US")
    assert e.value.code == "invalid_request"
    rec = api.ingest(tts_bytes(tts), "t.wav", "recording", denoise=0.0)
    with pytest.raises(VoiceError) as e:
        api.realign(rec, " | [1b] ")
    assert e.value.code == "script_empty"


def tts_bytes(src) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, src.audio[0], SR, format="WAV", subtype="PCM_24")
    return buf.getvalue()
