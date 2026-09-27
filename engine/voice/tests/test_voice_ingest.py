import io

import numpy as np
import pytest
import soundfile as sf

from fvwks_voice import api, ingest as ingest_mod
from fvwks_voice.dsp import SR, active_rms_db, highpass, split_on_silence
from fvwks_voice.errors import VoiceError
from fvwks_voice.ingest import ingest_audio


def encode(x: np.ndarray, sr: int, fmt: str = "WAV", subtype: str | None = None) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, x, sr, format=fmt, subtype=subtype)
    return buf.getvalue()


def tone(freq: float, seconds: float, sr: int, amp: float = 0.3) -> np.ndarray:
    t = np.arange(int(round(seconds * sr))) / sr
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def silence(seconds: float, sr: int) -> np.ndarray:
    return np.zeros(int(round(seconds * sr)), np.float32)


def bursts(sr: int, gaps: list[float], burst_s: float = 0.4) -> np.ndarray:
    parts = [silence(0.5, sr)]
    for g in gaps:
        parts += [tone(440, burst_s, sr), silence(g, sr)]
    parts += [tone(440, burst_s, sr), silence(0.5, sr)]
    return np.concatenate(parts)


@pytest.mark.parametrize("fmt, subtype, sr", [
    ("WAV", "PCM_16", 44100), ("WAV", "PCM_24", 48000), ("WAV", "FLOAT", 22050),
    ("AIFF", "PCM_24", 44100), ("FLAC", "PCM_16", 96000),
])
def test_decodes_formats_to_48k_mono(fmt, subtype, sr):
    x = np.stack([tone(440, 1.0, sr), tone(440, 1.0, sr, 0.1)], axis=1)  # stereo
    r = ingest_audio(encode(x, sr, fmt, subtype), f"take.{fmt.lower()}")
    assert r.audio.dtype == np.float32 and r.audio.ndim == 1
    assert r.source_sample_rate == sr and r.source_channels == 2
    assert abs(len(r.audio) / SR - 1.0) < 0.05  # a steady tone is all "speech": nothing trimmed but fades
    assert len(r.regions) == 1


def test_decodes_mp3():
    x = np.concatenate([tone(300, 0.8, 44100), silence(0.4, 44100), tone(300, 0.8, 44100)])
    try:
        data = encode(x, 44100, "MP3", "MPEG_LAYER_III")
    except (sf.LibsndfileError, TypeError, ValueError) as e:  # pragma: no cover - build without LAME
        pytest.skip(f"this libsndfile can't write MP3: {e}")
    r = ingest_audio(data, "take.mp3")
    assert r.source_format in ("MP3", "MPEG")
    assert len(r.regions) == 2


def test_trims_silence_and_normalizes():
    sr = 44100
    x = np.concatenate([silence(1.0, sr), tone(220, 1.0, sr, 0.05), silence(1.5, sr)])
    r = ingest_audio(encode(x, sr), "quiet.wav")
    assert r.trimmed_start_s == pytest.approx(0.97, abs=0.02)
    assert len(r.audio) / SR == pytest.approx(1.0 + 0.03 + 0.08, abs=0.03)
    level = active_rms_db(r.audio, SR)
    peak_db = 20 * np.log10(np.abs(r.audio).max())
    # a sine has a 3 dB crest factor, so the -20 dB RMS target wins over the -1 dBFS ceiling
    assert level == pytest.approx(-20.0, abs=0.5) and peak_db < -1.0


def test_peak_ceiling_limits_gain_for_spiky_audio():
    sr = 48000
    x = np.concatenate([tone(200, 1.0, sr, 0.01), np.full(10, 0.02, np.float32), tone(200, 1.0, sr, 0.01)])
    x[len(x) // 2] = 0.5  # one spike
    r = ingest_audio(encode(x, sr, subtype="FLOAT"))
    assert 20 * np.log10(np.abs(r.audio).max()) == pytest.approx(-1.0, abs=0.05)


def test_highpass_removes_dc_and_rumble_keeps_voice_band():
    sr = 48000
    rumble = tone(25, 2.0, sr, 0.3) + 0.2
    voice = tone(1000, 2.0, sr, 0.3)
    mid = slice(sr // 2, 3 * sr // 2)
    assert np.abs(highpass(rumble, sr)[mid]).max() < 0.02
    assert np.abs(highpass(voice, sr)[mid]).max() == pytest.approx(0.3, abs=0.01)


def test_splits_on_pauses_of_250ms_or_more():
    sr = 48000
    x = bursts(sr, gaps=[0.6, 0.1, 0.4])  # the 100 ms gap is not a split
    regions = split_on_silence(x, sr)
    assert len(regions) == 3
    starts = [s / sr for s, _ in regions]
    assert starts[0] == pytest.approx(0.5 - 0.03, abs=0.02)
    assert all(e0 <= s1 for (_, e0), (s1, _) in zip(regions, regions[1:]))


def test_ingest_segments_match_regions():
    sr = 44100
    src = api.ingest(encode(bursts(sr, gaps=[0.6, 0.5]), sr), "three.wav", "recording")
    assert src.info.kind == "recording" and src.info.name == "three.wav"
    assert src.audio.shape[0] == 1 and src.audio.dtype == np.float32
    segs = src.info.segments
    assert [s.index for s in segs] == [0, 1, 2]
    assert segs[0].start_s == pytest.approx(0.0, abs=0.005)  # trimmed: speech starts right away
    assert all(0 <= s.start_s < s.end_s <= src.info.duration_s for s in segs)
    assert all(s.text is None and not s.flags.throw and s.words == [] for s in segs)
    assert src.info.bpm is None and src.info.warnings == []
    assert src.info.peaks.buckets > 0 and src.info.sample_rate == 48000


def test_kokoro_fixtures_ingest_cleanly(fixtures_dir):
    for wav in sorted((fixtures_dir / "voices").glob("*.wav")):
        src = api.ingest(wav.read_bytes(), wav.name)
        assert src.info.duration_s > 1.0
        assert 1 <= len(src.info.segments) <= 6
        assert np.abs(src.audio).max() <= 10 ** (-1 / 20) + 1e-4


@pytest.mark.parametrize("data, code", [
    (b"", "audio_empty"),
    (b"definitely not audio" * 10, "unsupported_audio"),
])
def test_bad_input(data, code):
    with pytest.raises(VoiceError) as e:
        ingest_audio(data, "x.wav")
    assert e.value.code == code
    assert e.value.to_dict()["error"]["code"] == code


def test_silent_file_is_rejected():
    with pytest.raises(VoiceError) as e:
        ingest_audio(encode(silence(2.0, 48000), 48000))
    assert e.value.code == "no_speech"


def test_too_long_is_rejected(monkeypatch):
    monkeypatch.setattr(ingest_mod, "MAX_SECONDS", 1.0)
    with pytest.raises(VoiceError) as e:
        ingest_audio(encode(tone(200, 2.0, 8000), 8000))
    assert e.value.code == "audio_too_long"


def test_clipping_is_reported():
    x = np.clip(tone(200, 1.0, 48000, 2.0), -1, 1)
    r = ingest_audio(encode(x, 48000, subtype="FLOAT"))
    assert any("clips" in w for w in r.warnings)


def _take(fixtures_dir, *, rumble_db=None, click_at_s=None, sr=44100):
    """S2's review repro: 0.8 s lead-in, a Kokoro line (its speech starts ~0.2 s in), 1.2 s tail, light hiss,
    DC, and optionally 35 Hz rumble or a mic bump."""
    from scipy.signal import resample_poly

    rng = np.random.default_rng(0)
    v24, _ = sf.read(fixtures_dir / "voices" / "we_are_guy_fvwks.wav", dtype="float32")
    v = resample_poly(v24, 147, 80).astype(np.float32)
    x = np.concatenate([silence(0.8, sr), v, silence(1.2, sr)])
    t = np.arange(x.size) / sr
    x = x + rng.standard_normal(x.size).astype(np.float32) * 1e-3 + 0.02
    if rumble_db is not None:
        x = x + (10 ** (rumble_db / 20) * np.sin(2 * np.pi * 35 * t)).astype(np.float32)
    if click_at_s is not None:
        c0 = int(click_at_s * sr)
        x[c0:c0 + 220] += np.hanning(220).astype(np.float32) * 0.95
    return encode(np.stack([x, 0.8 * x], axis=1), sr, "WAV", "PCM_16"), x.size / sr


@pytest.mark.parametrize("rumble_db", [None, -45.0, -30.0])
def test_trim_sees_past_low_rumble(fixtures_dir, rumble_db):
    """A 70 Hz 2nd-order high-pass left -30 dBFS rumble at ~-55 dBFS, above the trim threshold, so nothing was
    trimmed. Trim now listens to a speech-band copy with a noise-aware threshold."""
    data, dur_in = _take(fixtures_dir, rumble_db=rumble_db)
    r = ingest_audio(data, "take.wav")
    assert r.trimmed_start_s == pytest.approx(1.0 - 0.03, abs=0.06)  # speech starts ~1.0 s; 30 ms pre-pad
    assert dur_in - len(r.audio) / SR > 2.3
    spec = np.abs(np.fft.rfft(r.audio)) ** 2
    f = np.fft.rfftfreq(r.audio.size, 1 / SR)
    assert 10 * np.log10(spec[(f > 30) & (f < 40)].sum() / spec.sum()) < -40  # rumble is gone from the source


def test_isolated_mic_bump_is_trimmed(fixtures_dir):
    clean, _ = _take(fixtures_dir)
    bumped, _ = _take(fixtures_dir, click_at_s=0.4)
    a, b = ingest_audio(clean, "a.wav"), ingest_audio(bumped, "b.wav")
    assert b.trimmed_start_s == pytest.approx(a.trimmed_start_s, abs=0.01) and b.trimmed_start_s > 0.9
    assert len(b.audio) == pytest.approx(len(a.audio), abs=int(0.02 * SR))
