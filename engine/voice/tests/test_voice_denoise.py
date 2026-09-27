"""DeepFilterNet3 at ingest: noise goes, speech (consonants, onsets, timing) stays."""

import io

import numpy as np
import pytest
import soundfile as sf
from scipy.signal import butter, sosfiltfilt

from fvwks_voice import api
from fvwks_voice.denoise import get_denoiser
from fvwks_voice.dsp import SR, frame_db, resample
from fvwks_voice.ingest import ingest_audio

pytestmark = pytest.mark.denoise


@pytest.fixture(scope="module")
def dn():
    d = get_denoiser()
    if not d.is_installed():
        pytest.skip("DeepFilterNet3 not installed (api.install_model('deepfilternet3', ...))")
    return d


@pytest.fixture(scope="module")
def clean(fixtures_dir):
    x, sr = sf.read(fixtures_dir / "voices" / "remember_remember.wav", dtype="float32")
    x = resample(x, sr, SR)
    pad = np.zeros(SR // 2, np.float32)
    return np.concatenate([pad, x, pad]) * 0.9


def _noise(kind: str, n: int, rng) -> np.ndarray:
    if kind == "white":
        return rng.standard_normal(n).astype(np.float32)
    if kind == "pink":
        w = np.fft.rfft(rng.standard_normal(n))
        f = np.maximum(np.fft.rfftfreq(n), 1 / n)
        return np.fft.irfft(w / np.sqrt(f), n).astype(np.float32)
    t = np.arange(n) / SR  # hum + rumble
    return (sum(np.sin(2 * np.pi * 60 * k * t) / k for k in range(1, 6)) + 2 * np.sin(2 * np.pi * 30 * t)).astype(np.float32)


def _at_snr(sig: np.ndarray, noise: np.ndarray, snr_db: float) -> np.ndarray:
    return (noise * np.sqrt(np.mean(sig ** 2) / np.mean(noise ** 2) / 10 ** (snr_db / 10))).astype(np.float32)


def si_sdr(est: np.ndarray, ref: np.ndarray) -> float:
    alpha = np.dot(est, ref) / np.dot(ref, ref)
    return float(10 * np.log10(np.sum((alpha * ref) ** 2) / np.sum((alpha * ref - est) ** 2)))


def _sibilant_energy(x: np.ndarray, ref: np.ndarray) -> float:
    """4-10 kHz energy in the frames where the clean reference speaks."""
    y = sosfiltfilt(butter(4, [4000, 10000], btype="band", fs=SR, output="sos"), x.astype(np.float64))
    w = int(0.02 * SR)
    speech = np.sqrt((np.lib.stride_tricks.sliding_window_view(ref, w)[::w] ** 2).mean(1)) > 0.01
    return float((np.lib.stride_tricks.sliding_window_view(y, w)[::w][speech] ** 2).sum())


@pytest.mark.parametrize("kind, snr, gain", [("white", 15, 6.0), ("pink", 15, 3.0), ("hum", 5, 10.0)])
def test_denoise_improves_si_sdr(dn, clean, kind, snr, gain):
    noisy = clean + _at_snr(clean, _noise(kind, clean.size, np.random.default_rng(1)), snr)
    assert si_sdr(dn.enhance(noisy), clean) - si_sdr(noisy, clean) > gain


def test_clean_speech_passes_almost_untouched(dn, clean):
    out = dn.enhance(clean)
    assert si_sdr(out, clean) > 30
    assert _sibilant_energy(out, clean) / _sibilant_energy(clean, clean) > 0.85  # consonants survive


def test_no_delay_and_onsets_stay(dn, clean):
    noisy = clean + _at_snr(clean, _noise("white", clean.size, np.random.default_rng(2)), 15)
    out = dn.enhance(noisy)
    a = slice(SR // 2, SR // 2 + 24_000)
    lag = int(np.argmax(np.correlate(out[a], clean[a], "full"))) - (24_000 - 1)
    assert lag == 0 and out.size == clean.size


def test_strength_is_a_dry_wet_mix(dn, clean):
    noisy = clean + _at_snr(clean, _noise("white", clean.size, np.random.default_rng(3)), 10)
    full = dn.enhance(noisy, 1.0)
    assert np.array_equal(dn.enhance(noisy, 0.0), noisy)
    assert np.allclose(dn.enhance(noisy, 0.5), 0.5 * full + 0.5 * noisy, atol=1e-5)


def test_long_takes_go_through_in_blocks(dn, clean):
    long = np.tile(clean, int(np.ceil(70 * SR / clean.size)))[: 70 * SR]  # 70 s: three 30 s blocks
    noisy = long + _at_snr(long, _noise("white", long.size, np.random.default_rng(4)), 15)
    out = dn.enhance(noisy)
    assert out.size == long.size and np.all(np.isfinite(out))
    assert si_sdr(out, long) - si_sdr(noisy, long) > 6.0


def _wav(x: np.ndarray) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, x, SR, format="WAV", subtype="PCM_24")
    return buf.getvalue()


def test_recordings_are_denoised_by_default(dn, clean):
    rng = np.random.default_rng(5)
    noisy = clean + _at_snr(clean, _noise("white", clean.size, rng), 20)
    on, off = ingest_audio(_wav(noisy), "t.wav", denoise=1.0), ingest_audio(_wav(noisy), "t.wav", denoise=0.0)
    assert on.denoise == 1.0 and off.denoise == 0.0

    def floor(x):  # quietest frames against the loudest, in dB
        db, _, _ = frame_db(x, SR)
        return float(np.percentile(db, 5) - db.max())

    assert floor(on.audio) < floor(off.audio) - 10  # the noise floor between words drops
    src = api.ingest(_wav(noisy), "t.wav", "recording")
    assert not any("denoiser" in w for w in src.info.warnings)
    assert src.info.denoise == 1.0 and src.info.transcript_state == "none"  # v0.3 fields
    assert api.ingest(_wav(noisy), "t.wav", "recording", denoise=0.0).info.denoise == 0.0


@pytest.mark.parametrize("freqs", [(350.0,), (220.0, 277.0, 330.0)])
def test_tones_and_music_are_kept_as_recorded(dn, freqs):
    """A speech denoiser fades a steady tone or chord out; such a take is kept as recorded, with a warning."""
    t = np.arange(2 * SR) / SR
    x = (0.25 / len(freqs) * sum(np.sin(2 * np.pi * f * t) for f in freqs)).astype(np.float32)
    r = ingest_audio(_wav(x), "tone.wav", denoise=1.0)
    assert r.denoise == 0.0 and len(r.audio) / SR > 1.8
    assert any("kept as recorded" in w for w in r.warnings)


def test_noisy_speech_is_still_denoised(dn, clean):
    noisy = clean + _at_snr(clean, _noise("white", clean.size, np.random.default_rng(6)), 5)
    r = ingest_audio(_wav(noisy), "noisy.wav", denoise=1.0)
    assert r.denoise == 1.0 and not r.warnings
