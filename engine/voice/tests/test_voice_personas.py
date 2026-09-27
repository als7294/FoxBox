"""Persona designer: storage, the seam hooks, and (with the Qwen3 model installed) the real flow."""

import time

import numpy as np
import pytest
import soundfile as sf

from fvwks_contracts.models import PersonaDesignRequest, TTSRequest
from fvwks_contracts.seam import Source
from fvwks_voice import api
from fvwks_voice.errors import VoiceError
from fvwks_voice.personas import PersonaStore, guess_gender
from fvwks_voice.tts_qwen3 import get_qwen3, time_stretch

DESC = "A deep, gravelly, menacing male voice, slow and calm, like an anonymous hacker broadcast."
SCRIPT = "WE ARE GUY FVWKS | EXPECT *US* [1b] REMEMBER THE SIGNAL"


@pytest.fixture
def voice_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "_store", None)
    api.configure(tmp_path)
    return tmp_path


def _fixture_candidate(fixtures_dir) -> Source:
    """A stand-in for a VoiceDesign candidate: a Kokoro fixture line as a 48 kHz Source."""
    src = api.ingest((fixtures_dir / "voices" / "we_are_guy_fvwks.wav").read_bytes(), "cand.wav")
    info = src.info.model_copy(update={"name": DESC, "script": "We are Guy Fawkes. Expect us.", "kind": "tts"})
    return Source(info=info, audio=src.audio)


@pytest.mark.parametrize("text, gender", [
    (DESC, "male"), ("A soft female whisper", "female"), ("A robotic, metallic announcer", "neutral"),
    ("A man and a woman in unison", "neutral"),
])
def test_gender_guess(text, gender):
    assert guess_gender(text) == gender


def test_store_round_trip(tmp_path):
    store = PersonaStore(tmp_path / "personas")
    ref = np.sin(np.arange(24_000) / 10).astype(np.float32) * 0.3
    p = store.save("  The   Hacker ", DESC, ref, "We are Guy Fawkes. Expect us.")
    assert p.name == "The Hacker" and p.gender == "male" and len(p.id) == 12
    assert [x.id for x in store.list()] == [p.id]
    assert store.get(p.id) == p
    assert np.allclose(store.ref_audio(p.id), ref)
    with pytest.raises(VoiceError) as e:
        store.get("../etc")
    assert e.value.code == "voice_not_found"
    with pytest.raises(VoiceError):
        store.get("abcdef123456")


def test_save_persona_lists_it_as_a_voice(voice_dir, fixtures_dir):
    v = api.save_persona("Hacker", _fixture_candidate(fixtures_dir))
    assert v.id.startswith("persona:") and v.engine == "persona" and v.name == "Hacker"
    assert v.description == DESC and v.gender == "male" and v.tags[0] == "persona"
    f0 = [t for t in v.tags if t.startswith("f0:")]  # measured on the reference clip (am_fenrir fixture)
    assert len(f0) == 1 and 110 <= int(f0[0][3:]) <= 180
    assert (voice_dir / "personas" / v.id.split(":")[1] / "ref.wav").exists()
    listed = [x for x in api.list_voices() if x.engine == "persona"]
    assert [x.id for x in listed] == [v.id]
    ref, sr = sf.read(voice_dir / "personas" / v.id.split(":")[1] / "ref.wav")
    assert sr == 24_000 and len(ref) > 24_000


def test_persona_needs_the_model(voice_dir, fixtures_dir, monkeypatch):
    v = api.save_persona("Hacker", _fixture_candidate(fixtures_dir))
    monkeypatch.setattr(type(get_qwen3()), "is_installed", lambda self: False)
    with pytest.raises(VoiceError) as e:
        api.synthesize(TTSRequest(script="hello", voice_id=v.id))
    assert e.value.code == "model_not_installed" and e.value.status == 503
    assert not next(x for x in api.list_voices() if x.id == v.id).installed


def test_unknown_persona(voice_dir):
    with pytest.raises(VoiceError) as e:
        api.synthesize(TTSRequest(script="hello", voice_id="persona:abcdef123456"))
    assert e.value.code == "voice_not_found" and e.value.status == 404


def test_time_stretch_keeps_pitch_and_changes_length():
    sr = 24_000
    x = (0.3 * np.sin(2 * np.pi * 150 * np.arange(sr) / sr)).astype(np.float32)
    slow = time_stretch(x, sr, 0.8)
    assert len(slow) == pytest.approx(sr / 0.8, rel=0.02)
    spec = np.abs(np.fft.rfft(slow[2000:-2000]))
    assert np.fft.rfftfreq(len(slow) - 4000, 1 / sr)[np.argmax(spec)] == pytest.approx(150, abs=3)


# -- the real Qwen3 flow ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def qwen3():
    eng = get_qwen3()
    if not eng.is_installed():
        pytest.skip("Qwen3-TTS persona model not installed (api.install_model('qwen3-tts-voicedesign', ...))")
    return eng


@pytest.mark.qwen3
def test_design_save_and_speak(qwen3, voice_dir, kokoro, record_property):
    t0 = time.perf_counter()
    gen = api.design_persona(PersonaDesignRequest(description=DESC, candidates=2))
    first = next(gen)  # candidates arrive one by one (the UI fills its slots as they come)
    cands = [first, *gen]
    record_property("design_2_candidates_s", round(time.perf_counter() - t0, 1))
    assert len(cands) == 2
    for c in cands:
        assert c.info.name == DESC and c.info.script == "We are Guy Fawkes. Expect us."
        assert c.audio.shape[0] == 1 and c.info.sample_rate == 48_000 and 1.0 < c.info.duration_s < 10
        assert np.abs(c.audio).max() <= 10 ** (-1 / 20) + 1e-4
    assert not np.array_equal(cands[0].audio, cands[1].audio)  # each candidate has its own seed

    v = api.save_persona("Hacker", cands[0])
    t0 = time.perf_counter()
    src = api.synthesize(TTSRequest(script=SCRIPT, voice_id=v.id, bpm=140))
    record_property("persona_3_chunk_s", round(time.perf_counter() - t0, 1))
    info = src.info
    assert info.voice_id == v.id and info.sample_rate == 48_000
    assert all(s.words == [] for s in info.segments)  # Qwen3 gives no word timings
    kokoro_src = api.synthesize(TTSRequest(script=SCRIPT, voice_id="kokoro:am_fenrir", bpm=140))
    assert [(s.text, s.flags) for s in info.segments] == [(s.text, s.flags) for s in kokoro_src.info.segments]
    assert info.script_hash == kokoro_src.info.script_hash
    gap = info.segments[2].start_s - info.segments[1].end_s
    assert gap == pytest.approx(60 / 140, abs=1 / 48_000)  # [1b] at 140 bpm

    again = api.synthesize(TTSRequest(script=SCRIPT, voice_id=v.id, bpm=140))
    assert np.array_equal(again.audio, src.audio)  # same line, same voice -> same take
    faster = api.synthesize(TTSRequest(script=SCRIPT, voice_id=v.id, bpm=140, speed=1.3))
    assert faster.info.duration_s < src.info.duration_s * 0.85


def test_personas_saved_before_f0_still_load(tmp_path):
    store = PersonaStore(tmp_path / "personas")
    p = store.save("Old", DESC, np.zeros(24_000, np.float32) + 0.01, "We are Guy Fawkes.")
    meta = store.root / p.id / "persona.json"
    import json

    data = json.loads(meta.read_text())
    data.pop("f0_hz", None)
    meta.write_text(json.dumps(data))
    assert store.get(p.id).f0_hz is None
