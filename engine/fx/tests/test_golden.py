"""Golden renders with tolerance: a compact spectral fingerprint of each preset's final render is compared
against ``tests/golden/<preset>.json`` (24 log bands x 100 ms frames, plus loudness numbers).

Regenerate intentionally changed sounds with ``FVWKS_UPDATE_GOLDEN=1 scripts/check.sh fx``."""

import json
import os
from pathlib import Path

import numpy as np
import pytest

from fvwks_contracts.models import Arrange, RenderRequest
from fvwks_fx import api

GOLDEN = Path(__file__).parent / "golden"
PRESETS = ["pact", "legion", "abyss", "unit", "ghost", "signal", "raw"]
UPDATE = os.environ.get("FVWKS_UPDATE_GOLDEN") == "1"
BANDS = np.geomspace(60.0, 16000.0, 25)


def fingerprint(x: np.ndarray, sr: int) -> np.ndarray:
    mono = x.mean(axis=0).astype(np.float64)
    hop = int(0.1 * sr)
    n_frames = mono.size // hop
    frames = mono[: n_frames * hop].reshape(n_frames, hop) * np.hanning(hop)
    spec = np.abs(np.fft.rfft(frames, axis=1)) ** 2
    f = np.fft.rfftfreq(hop, 1 / sr)
    out = np.stack([spec[:, (f >= lo) & (f < hi)].sum(axis=1) for lo, hi in zip(BANDS[:-1], BANDS[1:])], axis=1)
    return 10 * np.log10(np.maximum(out, 1e-12))


@pytest.mark.parametrize("preset_id", PRESETS)
def test_golden_render(we_are, we_are_stack, preset_id):
    pre = api.get_preset(preset_id)
    stack = [src if sv.voice_id else None for sv, src in zip(pre.stack, we_are_stack)]
    req = api.apply_hints(RenderRequest(source_id="golden", preset_id=preset_id, quality="final",
                                        arrange=Arrange(bpm=140, bars=4, key="Am")), pre)
    out = api.render(we_are, stack, req)
    fp = fingerprint(out.audio, out.sample_rate)
    path = GOLDEN / f"{preset_id}.json"
    if UPDATE or not path.exists():
        if not UPDATE:
            pytest.fail(f"missing golden {path.name}; run with FVWKS_UPDATE_GOLDEN=1 to create it")
        GOLDEN.mkdir(exist_ok=True)
        path.write_text(json.dumps({
            "preset": preset_id, "loudness": out.loudness.model_dump(), "fit": out.fit.status,
            "fingerprint_db": np.round(fp, 2).tolist(),
        }) + "\n")
        pytest.skip("golden updated")
    ref = json.loads(path.read_text())
    gold = np.asarray(ref["fingerprint_db"])
    assert gold.shape == fp.shape
    peak = max(gold.max(), fp.max())
    audible = (gold > peak - 60) | (fp > peak - 60)
    diff = np.abs(gold - fp)[audible]
    assert float(np.mean(diff)) < 1.5, f"{preset_id}: mean band difference {np.mean(diff):.2f} dB"
    assert out.loudness.short_term_max_lufs == pytest.approx(ref["loudness"]["short_term_max_lufs"], abs=0.3)
