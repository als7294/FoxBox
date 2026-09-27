import json
import time

import numpy as np
import pytest

from fvwks_contracts.models import DEFAULT_LEXICON, Lexicon, LexiconEntry, TTSRequest
from fvwks_voice import api
from fvwks_voice.dsp import SR, speech_bounds
from fvwks_voice.errors import VoiceError
from fvwks_voice.lexicon import Lexicon as VoiceLexicon
from fvwks_voice.markup import parse, speak_chunk
from fvwks_voice.synth import BEAT_GAP_S

pytestmark = pytest.mark.kokoro

WE_ARE = "WE ARE GUY FVWKS | EXPECT *US*"
STACK_VOICES = ["kokoro:am_fenrir", "kokoro:am_michael", "kokoro:bm_george", "kokoro:af_heart"]


def _gpu_busy_pct() -> str:
    import subprocess

    try:
        out = subprocess.run(["ioreg", "-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"], capture_output=True,
                             text=True, timeout=5).stdout
        pct = out.split('"Device Utilization %"=')[1].split(",")[0].split("}")[0]
        return f"GPU {pct}% busy"
    except Exception:  # noqa: BLE001 - diagnostics only
        return "GPU load unknown"


def test_warm_ten_word_line_under_one_second(kokoro, record_property):
    """Best of 3 fresh 10-word lines: the target is what the engine can do, not what a GPU shared with
    another job (a Blender render, say) happens to allow. The failure message includes the GPU load."""
    lines = ["Remember the signal never dies, we are legion, expect us",
             "We are the voice of static, nobody knows our names",
             "Put your hands up high for the final transmission tonight"]
    times = []
    for line in lines:
        assert len(line.replace(",", "").split()) == 10
        t0 = time.perf_counter()
        api.synthesize(TTSRequest(script=line))
        times.append(time.perf_counter() - t0)
    best = min(times)
    record_property("warm_10_word_s", round(best, 3))
    print(f"\nwarm 10-word lines: {', '.join(f'{t * 1000:.0f}' for t in times)} ms")
    assert best < 1.0, f"best {best:.2f}s of {[round(t, 2) for t in times]} ({_gpu_busy_pct()})"


def test_source_shape_and_segments(kokoro):
    src = api.synthesize(TTSRequest(script=WE_ARE, voice_id="kokoro:am_fenrir"))
    info = src.info
    assert info.kind == "tts" and info.voice_id == "kokoro:am_fenrir" and info.speed == 0.9
    assert info.script == WE_ARE and info.script_hash == "65e63311d2375593"  # same as fixtures/sources
    assert info.sample_rate == 48000 and src.audio.shape == (1, round(info.duration_s * SR))
    assert src.audio.dtype == np.float32 and np.all(np.isfinite(src.audio))
    assert np.abs(src.audio).max() <= 10 ** (-1 / 20) + 1e-4
    segs = info.segments
    assert [s.text for s in segs] == ["WE ARE GUY FVWKS", "EXPECT *US*"]
    assert [(s.flags.beat_break, s.flags.throw) for s in segs] == [(True, False), (False, True)]
    assert segs[0].start_s == 0.0 and segs[-1].end_s == pytest.approx(info.duration_s, abs=1e-5)
    assert segs[1].start_s - segs[0].end_s == pytest.approx(BEAT_GAP_S, abs=1 / SR)
    assert info.peaks.duration_s == pytest.approx(info.duration_s, abs=1e-4)
    assert info.bpm == 120 and info.warnings == []
    assert info.denoise is None and info.transcript_state == "none"  # v0.3: TTS is never denoised


def test_segments_carry_word_timings_and_throw_words(kokoro):
    """v0.1: Segment.words in source time; S2 throws exactly the words with throw=True."""
    segs = api.synthesize(TTSRequest(script=WE_ARE, bpm=140)).info.segments
    assert [w.text for w in segs[0].words] == ["We", "are", "guy", "Fawkes"]  # as spoken
    assert [(w.text, w.throw) for w in segs[1].words] == [("Expect", False), ("us", True)]
    for seg in segs:
        times = [t for w in seg.words for t in (w.start_s, w.end_s)]
        assert times == sorted(times)
        assert seg.start_s <= times[0] < seg.start_s + 0.05 and times[-1] <= seg.end_s


def test_whole_chunk_throw_flags_every_word(kokoro):
    seg = api.synthesize(TTSRequest(script="*EXPECT US*")).info.segments[0]
    assert seg.flags.throw and [w.throw for w in seg.words] == [True, True]


def test_bpm_and_parser_warnings_are_recorded(kokoro):
    info = api.synthesize(TTSRequest(script="EXPECT *US [laughs]", bpm=140)).info
    assert info.bpm == 140
    assert len(info.warnings) == 2 and not info.segments[0].flags.throw


def test_first_word_lands_on_sample_zero(kokoro):
    src = api.synthesize(TTSRequest(script="EXPECT US", voice_id="kokoro:am_michael"))
    start, _ = speech_bounds(src.audio[0], SR, pad_start_s=0.0, pad_end_s=0.0)
    assert start / SR < 0.015


@pytest.mark.parametrize("script, bpm, gap", [
    ("WE DO NOT FORGIVE [2b] WE DO NOT FORGET", 140, 2 * 60 / 140),
    ("WE DO NOT FORGIVE [2b] WE DO NOT FORGET", None, 1.0),  # default 120 bpm
    ("REMEMBER, REMEMBER [0.5] THE SIGNAL NEVER DIES", 140, 0.5),
])
def test_pauses_are_exact(kokoro, script, bpm, gap):
    segs = api.synthesize(TTSRequest(script=script, bpm=bpm)).info.segments
    assert segs[1].start_s - segs[0].end_s == pytest.approx(gap, abs=1 / SR)


def test_trailing_pause_is_silence_at_the_end(kokoro):
    src = api.synthesize(TTSRequest(script="EXPECT US [1b]"))
    seg = src.info.segments[0]
    assert seg.flags.pause_after_beats == 1
    assert src.info.duration_s - seg.end_s == pytest.approx(0.5, abs=1 / SR)
    assert np.abs(src.audio[0, int(seg.end_s * SR) + 10:]).max() == 0


def test_stack_voices_share_segments(kokoro):
    script = "REMEMBER, REMEMBER [0.5] THE SIGNAL NEVER DIES | WE DO NOT FORGIVE | *EXPECT US*"
    sources = [api.synthesize(TTSRequest(script=script, voice_id=v, bpm=140)) for v in STACK_VOICES]
    ref = sources[0].info
    for s in sources[1:]:
        assert s.info.script_hash == ref.script_hash
        assert [(x.index, x.text, x.flags) for x in s.info.segments] == [
            (x.index, x.text, x.flags) for x in ref.segments]
    assert len({round(s.info.duration_s, 3) for s in sources}) > 1  # the voices really differ


def test_matches_coordinator_stack_fixtures(kokoro, fixtures_dir):
    for meta_path in sorted((fixtures_dir / "sources").glob("*.source.json")):
        meta = json.loads(meta_path.read_text())
        src = api.synthesize(TTSRequest(script=meta["script"], voice_id=meta["voice_id"], speed=meta["speed"]),
                             DEFAULT_LEXICON)
        assert src.info.script_hash == meta["script_hash"], meta_path.name
        got = [(s.index, s.text, s.flags.model_dump()) for s in src.info.segments]
        exp = [(s["index"], s["text"], s["flags"]) for s in meta["segments"]]
        assert got == exp, meta_path.name


def test_caps_rule_and_lexicon_reach_the_g2p(kokoro):
    g2p = kokoro._pipeline("a").g2p
    lex = VoiceLexicon.from_contract(DEFAULT_LEXICON)
    raw_ps, _ = g2p("EXPECT US. WE ARE GUY FVWKS.")
    assert "jˌuˈɛs" in raw_ps  # without the rule misaki says "U.S."
    for chunk in parse("EXPECT US | WE ARE GUY FVWKS").chunks:
        ps, _ = g2p(speak_chunk(chunk, lex).g2p)
        assert "jˌuˈɛs" not in ps and "ˌɛfvˌi" not in ps
    ps, _ = g2p(speak_chunk(parse("WE ARE GUY FVWKS").chunks[0], lex).g2p)
    assert "fˈɔks" in ps


def test_phoneme_lexicon_entry_is_spoken(kokoro):
    lex = Lexicon(entries=[LexiconEntry(word="FVWKS", say="/fˈɔks/")])
    chunk = parse("FVWKS").chunks[0]
    sp = speak_chunk(chunk, VoiceLexicon.from_contract(lex))
    ps, _ = kokoro._pipeline("a").g2p(sp.g2p)
    assert ps.startswith("fˈɔks")
    assert api.synthesize(TTSRequest(script="FVWKS"), lex).info.duration_s > 0.2


def test_throw_span_lands_on_the_throw_word(kokoro):
    vr = api.render(TTSRequest(script="EXPECT *US*", voice_id="kokoro:am_fenrir"))
    chunk = vr.chunks[0]
    us = next(w for w in chunk.words if w.text.lower() == "us")
    (t0, t1), = chunk.throw_spans
    assert t0 == pytest.approx(us.start_s, abs=1e-6) and t1 == pytest.approx(chunk.end_s)
    assert chunk.start_s < t0 < chunk.end_s


def test_speed_changes_duration(kokoro):
    slow = api.synthesize(TTSRequest(script="We do not forgive", speed=0.7)).info.duration_s
    fast = api.synthesize(TTSRequest(script="We do not forgive", speed=1.4)).info.duration_s
    assert slow > fast * 1.5


def test_voice_sample_returns_fresh_copies(kokoro):
    a = api.voice_sample("kokoro:am_puck")
    a.info.id = "src_taken"
    a.audio[:] = 0
    b = api.voice_sample("kokoro:am_puck")
    assert b.info.id == "" and b.info.name == "Puck sample" and np.abs(b.audio).max() > 0.1


def test_list_voices():
    voices = api.list_voices()
    assert len(voices) == 28
    assert {v.id for v in voices if v.recommended} == {
        "kokoro:am_fenrir", "kokoro:am_michael", "kokoro:am_puck", "kokoro:bm_george", "kokoro:af_heart"}
    assert all(v.engine == "kokoro" and v.language in ("en-US", "en-GB") for v in voices)
    assert all(v.gender in ("male", "female") and v.tags for v in voices)
    # S4 option A: measured median F0 as an "f0:NNN" tag (the app shows "F0 NNN Hz" and hides the chip)
    for v in voices:
        f0 = [t for t in v.tags if t.startswith("f0:")]
        assert len(f0) == 1 and 60 <= int(f0[0][3:]) <= 400, v.id
    assert "f0:142" in next(v for v in voices if v.id == "kokoro:am_fenrir").tags


def test_list_voices_marks_installed(kokoro):
    assert all(v.installed for v in api.list_voices())


@pytest.mark.parametrize("voice_id", ["kokoro:zz_nobody", "persona:abc", "qwen3:x", "ef_dora"])
def test_unknown_voice(voice_id):
    with pytest.raises(VoiceError) as e:
        api.synthesize(TTSRequest(script="hello", voice_id=voice_id))
    assert e.value.code == "voice_not_found" and e.value.status == 404


def test_markup_only_script_is_rejected():
    with pytest.raises(VoiceError) as e:
        api.synthesize(TTSRequest(script="| [1b] | *...*"))
    assert e.value.code == "script_empty"


def test_spacy_model_is_pinned_so_misaki_never_downloads():
    import spacy

    assert spacy.util.is_package("en_core_web_sm")


def test_loads_and_speaks_offline(kokoro):
    """No network: the model, the voices and the spaCy model all come from local caches."""
    import os
    import subprocess
    import sys

    code = ("from fvwks_voice.tts_kokoro import KokoroEngine\n"
            "e = KokoroEngine(); e.load(warmup=False)\n"
            "pa = e.synthesize('Expect us.', 'bm_george')\n"
            "print(len(pa.audio), len(pa.words))\n")
    env = {**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}
    out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr[-2000:]
    n_samples, n_words = map(int, out.stdout.split()[-2:])
    assert n_samples > 12000 and n_words >= 2


def _loud(x: np.ndarray, t0: float, t1: float, peak_db: float, rel_db: float = -40.0) -> bool:
    """Any 5 ms window in [t0, t1] within rel_db of the peak window."""
    a, b = max(0, int(t0 * SR)), min(len(x), int(t1 * SR))
    w = int(0.005 * SR)
    frames = [x[i:i + w] for i in range(a, max(a + 1, b - w + 1), w // 2)]
    return any(20 * np.log10(np.sqrt(np.mean(f.astype(np.float64) ** 2)) + 1e-12) > peak_db + rel_db
               for f in frames if len(f))


@pytest.mark.parametrize("voice", ["kokoro:am_fenrir", "kokoro:bm_george"])
def test_word_edges_follow_the_audio_at_pauses(kokoro, voice):
    """S2's review: Kokoro's timings tile the chunk, so pauses were counted inside the neighbouring words (up to
    ~100 ms). Edges bordering a pause now sit on the audible edges."""
    src = api.synthesize(TTSRequest(script="WE DO NOT FORGIVE. WE DO NOT *FORGET*.", voice_id=voice))
    x = src.audio[0]
    w = int(0.005 * SR)
    peak = max(20 * np.log10(np.sqrt(np.mean(x[i:i + w].astype(np.float64) ** 2)) + 1e-12)
               for i in range(0, len(x) - w, w // 2))
    words = src.info.segments[0].words
    assert [v.text for v in words] == ["We", "do", "not", "forgive", "we", "do", "not", "forget"]
    first, forgive, we = words[0], words[3], words[4]
    assert _loud(x, first.start_s, first.start_s + 0.02, peak)  # starts at the sound, not in the lead-in
    assert not _loud(x, 0.0, first.start_s - 0.01, peak)
    assert we.start_s - forgive.end_s >= 0.05  # the pause between the sentences is nobody's word
    assert not _loud(x, forgive.end_s + 0.01, we.start_s - 0.01, peak)
    assert _loud(x, forgive.end_s - 0.02, forgive.end_s, peak)  # "forgive" ends where its sound ends
    assert _loud(x, we.start_s, we.start_s + 0.02, peak)  # "we" starts where its sound starts


def test_word_text_has_no_edge_punctuation(kokoro):
    words = [w.text for s in api.synthesize(TTSRequest(script="ONE. TWO. THREE.")).info.segments for w in s.words]
    assert words == ["One", "two", "three"]
