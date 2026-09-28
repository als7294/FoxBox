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
