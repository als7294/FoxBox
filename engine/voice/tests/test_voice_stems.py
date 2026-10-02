from __future__ import annotations

import numpy as np
import pytest

from fvwks_contracts.models import STEM_NAMES
from fvwks_voice import api, models, stems
from fvwks_voice.errors import VoiceError


def _song(sr: int, seconds: float, channels: int) -> np.ndarray:
    """A kick on every beat at 120 BPM over a bass tone: enough for drums and bass to come apart."""
    t = np.arange(int(sr * seconds)) / sr
    kick = np.sin(2 * np.pi * 55 * t) * np.exp(-(t % 0.5) * 30)
    bass = 0.3 * np.sin(2 * np.pi * 82.4 * t)
    x = (0.5 * kick + bass).astype(np.float32)
    return np.tile(x, (channels, 1))


def test_listed_as_an_optional_download():
    info = next(m for m in api.list_models() if m.id == "stems-htdemucs")
    assert (info.required, info.license, info.size_bytes) == (False, "MIT", 84_038_036)


def test_needs_the_model(monkeypatch):
    monkeypatch.setattr(models, "is_installed", lambda spec: False)
    monkeypatch.setattr(stems.get_splitter(), "_model", None)
    with pytest.raises(VoiceError) as e:
        api.separate_stems(_song(48_000, 1, 2), 48_000, lambda f, m: None)
    assert (e.value.code, e.value.model_id) == ("model_not_installed", "stems-htdemucs")


@pytest.mark.stems
@pytest.mark.parametrize("sr,channels", [(48_000, 2), (44_100, 1)])
def test_stems_keep_the_input_shape(sr, channels):
    if not stems.get_splitter().is_installed():
        pytest.skip("stems-htdemucs isn't installed")
    x = _song(sr, 9.0, channels)
    ticks: list[float] = []
    out = api.separate_stems(x, sr, lambda f, m: ticks.append(f))
    assert list(out) == list(STEM_NAMES)
    assert all(s.shape == x.shape and s.dtype == np.float32 for s in out.values())
    assert ticks[-1] == 1.0 and ticks == sorted(ticks)
    rms = {k: float(np.sqrt(np.mean(v**2))) for k, v in out.items()}
    assert rms["drums"] + rms["bass"] > 5 * rms["vocals"]


def _808(sr: int, seconds: float) -> np.ndarray:
    """An 808 every half second: a click and a long 50 Hz sub (400 ms), stereo."""
    t = np.arange(int(sr * seconds)) / sr
    ph = t % 0.5
    sub = np.sin(2 * np.pi * 50 * t) * np.exp(-ph * 3) * (ph < 0.4)
    click = np.random.default_rng(0).normal(0, 1, t.size) * np.exp(-ph * 400)
    return np.tile((0.8 * sub + 0.3 * click).astype(np.float32), (2, 1))


def test_refined_stems_still_sum_to_the_mix():
    rng = np.random.default_rng(1)
    sr, n = stems.MODEL_SR, stems.MODEL_SR * 3
    mix = rng.normal(0, 0.2, (2, n)).astype(np.float32)
    parts = rng.dirichlet(np.ones(4), size=1)[0]
    est = {k: (mix * w + rng.normal(0, 0.01, mix.shape)).astype(np.float32) for k, w in zip(STEM_NAMES, parts)}
    out = stems.refine(mix, est)
    assert all(v.shape == mix.shape for v in out.values())
    residual = sum(out.values()) - mix
    assert np.sqrt(np.mean(residual**2)) < 1e-4 * np.sqrt(np.mean(mix**2)) + 1e-6
    off = stems.refine(mix, est, sharpen_p=1, route_808=False, vocal_p=1, vocal_gate_db=None)
    assert off is est  # all off: as they came


def test_the_808s_sustained_sub_goes_to_the_bass_the_drums_keep_the_hit():
    sr = stems.MODEL_SR
    drums = _808(sr, 3.0)
    est = {"drums": drums, "bass": np.zeros_like(drums), "other": np.zeros_like(drums), "vocals": np.zeros_like(drums)}
    out = stems.refine(drums, est, sharpen_p=1, route_808=True, vocal_p=1, vocal_gate_db=None)
    np.testing.assert_allclose(out["drums"] + out["bass"], drums, atol=1e-4)  # moved, not lost
    t = np.arange(drums.shape[1]) / sr
    ph = t % 0.5
    hit, tail = (ph < 0.05) & (t > 0.5), (ph > 0.15) & (ph < 0.38) & (t > 0.5)
    e = lambda x, sel: float(np.mean(x[:, sel] ** 2))  # noqa: E731
    assert e(out["bass"], tail) > 10 * e(out["drums"], tail)  # the sustain: in the bass
    assert e(out["drums"], hit) > e(out["bass"], hit)  # the hit: still the drums'


def test_the_vocal_gate_moves_leftovers_to_other_and_keeps_a_voice():
    rng = np.random.default_rng(2)
    sr, n = stems.MODEL_SR, stems.MODEL_SR * 4
    mix = rng.normal(0, 0.3, (2, n)).astype(np.float32)
    vocals = mix * 0.5
    vocals[:, : n // 2] *= 0.002  # the first half: only leftovers, ~-60 dB under the mix
    zero = np.zeros_like(mix)
    est = {"drums": zero, "bass": zero, "other": mix - vocals, "vocals": vocals}
    out = stems.refine(mix, est, sharpen_p=1, route_808=False, vocal_p=1, vocal_gate_db=-30)
    np.testing.assert_allclose(out["vocals"] + out["other"], vocals + (mix - vocals), atol=1e-4)  # moved, not dropped
    quiet, voice = slice(sr // 2, n // 2 - sr // 2), slice(n // 2 + sr // 2, n - sr // 2)
    assert np.sqrt(np.mean(out["vocals"][:, quiet] ** 2)) < 0.1 * np.sqrt(np.mean(vocals[:, quiet] ** 2))
    np.testing.assert_allclose(out["vocals"][:, voice], vocals[:, voice], atol=1e-3)  # a voice: kept as it was
