"""Airwindows (native ``fvwks_fx._airwin``): COLOR tape / tube, DEREZ, GALACTIC reverb, and the fallback without it."""

import numpy as np
import pytest

from fvwks_contracts.models import Arrange, RenderRequest
from fvwks_fx import api, dsp
from fvwks_fx.modules import airwin as AW

SR = 48000


def sine(hz, secs=1.0, amp=0.25, sr=SR):
    t = np.arange(int(secs * sr)) / sr
    return (amp * np.sin(2 * np.pi * hz * t)).astype(np.float32)[None, :]


def harmonics_db(y, f0, sr=SR):
    """Energy of harmonics 2..10 of ``f0`` relative to the fundamental (dB)."""
    spec = np.abs(np.fft.rfft(y.mean(axis=0) * np.hanning(y.shape[1]))) ** 2
    f = np.fft.rfftfreq(y.shape[1], 1 / sr)
    at = lambda hz: spec[np.abs(f - hz) < 3].sum()
    return 10 * np.log10(sum(at(k * f0) for k in range(2, 11)) / at(f0))


def test_native_module_builds_the_four_effects():
    assert AW.AVAILABLE
    assert sorted(AW._airwin.effects()) == ["DeRez4", "Galactic3", "ToTape9", "Tube2"]
    fx = AW._airwin.Effect("ToTape9", 48000.0, 1)
    assert fx.n_params == 9 and fx.param_name(0) == "Input"
    with pytest.raises(ValueError):
        AW._airwin.Effect("NotAnEffect", 48000.0, 1)


def test_renders_are_reproducible(we_are):
    x = we_are.audio
    for kind in ("tape", "tube"):
        assert np.array_equal(AW.color(x, SR, kind, 0.7, seed=3), AW.color(x, SR, kind, 0.7, seed=3))
    assert np.array_equal(AW.derez(x, SR, 0.5, seed=3), AW.derez(x, SR, 0.5, seed=3))
    assert np.array_equal(AW.galactic(x, SR, decay_s=3.0, seed=3), AW.galactic(x, SR, decay_s=3.0, seed=3))


@pytest.mark.parametrize("kind", ["tape", "tube"])
def test_color_is_level_matched_and_saturates_more_with_drive(we_are, kind):
    y = AW.color(we_are.audio, SR, kind, 0.5)
    assert y.shape == we_are.audio.shape and np.all(np.isfinite(y))
    assert 20 * np.log10(dsp.active_rms(y, SR) / dsp.active_rms(we_are.audio, SR)) == pytest.approx(0.0, abs=0.05)
    x = sine(220)
    soft, hard = harmonics_db(AW.color(x, SR, kind, 0.2), 220), harmonics_db(AW.color(x, SR, kind, 1.0), 220)
    assert hard > soft + 6  # more drive, more harmonics


def test_derez_holds_the_same_rate_in_preview_and_final():
    for amount in (0.1, 0.3, 0.45, 0.7, 1.0):
        assert AW.derez_steps(amount, 48000) == 2 * AW.derez_steps(amount, 24000)
    assert AW.derez_steps(0.45, 48000) == 6  # SIGNAL: 8 kHz
    # a 1 kHz tone held at 8 kHz grows images at 8 kHz +- 1 kHz (smoothed: DeRez4 interpolates its holds)
    f = np.fft.rfftfreq(SR, 1 / SR)

    def image_db(y, hz):
        spec = np.abs(np.fft.rfft(y[0] * np.hanning(y.shape[1])))
        return 20 * np.log10(spec[np.abs(f - hz) < 5].max() / spec[np.abs(f - 1000) < 5].max())

    y = AW.derez(sine(1000.0), SR, 0.45)
    for hz in (7000, 9000):
        assert image_db(y, hz) > image_db(sine(1000.0), hz) + 40
    assert 20 * np.log10(dsp.active_rms(y, SR) / dsp.active_rms(sine(1000.0), SR)) == pytest.approx(0.0, abs=0.05)


@pytest.mark.parametrize("decay_s", [1.0, 2.5, 6.0])
def test_galactic_rings_for_the_requested_time(decay_s):
    for sr in (48000, 24000):  # the preview must ring like the final
        imp = np.zeros((2, int(12 * sr)), np.float32)
        imp[:, 0] = 1.0
        rt, _ = AW._rt60_and_energy(AW.galactic(imp, sr, decay_s=decay_s, predelay_ms=0.0), sr)
        assert rt == pytest.approx(decay_s, rel=0.05)


@pytest.mark.parametrize("sr", [48000, 24000])
def test_galactic_space_sits_like_the_hall(we_are, sr):
    from fvwks_fx.modules import space as SP

    x = np.vstack([we_are.audio, we_are.audio])
    x = x if sr == SR else np.ascontiguousarray(x[:, ::2])
    rms = lambda y: float(np.sqrt(np.mean(y.astype(np.float64) ** 2)))
    for decay, dark in ((1.0, 0.6), (2.5, 0.3), (6.0, 0.85)):
        gal = SP.reverb_wet(x, sr, decay_s=decay, predelay_ms=30, damping=dark, kind="galactic")
        hall = SP.reverb_wet(x, sr, decay_s=decay, predelay_ms=30, damping=dark, kind="hall")
        assert 20 * np.log10(rms(gal) / rms(hall)) == pytest.approx(0.0, abs=2.0)  # same send, same level
        assert np.corrcoef(gal[0], gal[1])[0, 1] > 0.0  # wide, but it survives a mono sum


def test_presets_use_airwindows_and_render_without_it(we_are, monkeypatch):
    chains = {p.id: {m.id: m.params for m in p.chain.modules} for p in api.list_presets()}
    assert chains["pact"]["drive"]["color"] == "tape" and chains["abyss"]["drive"]["color"] == "tube"
    assert chains["ghost"]["space"]["reverb_type"] == "galactic" and chains["signal"]["crush"]["derez"] > 0
    monkeypatch.setattr(AW, "AVAILABLE", False)
    from fvwks_fx.memo import STAGES

    STAGES.clear()  # memoized stages would skip the fallback path
    preset = api.get_preset("ghost")
    req = api.apply_hints(RenderRequest(source_id="x", preset_id="ghost", quality="preview",
                                        arrange=Arrange(bpm=140, bars=4, key="Am")), preset)
    out = api.render(we_are, [None] * len(req.stack or []), req)
    assert np.all(np.isfinite(out.audio))
    assert any("galactic" in w and "Airwindows" in w for w in out.warnings)


def test_rack_loads_and_renders_when_the_native_module_is_missing():
    """As if the C++ extension failed to build (setup.py marks it optional): a fresh interpreter where importing
    fvwks_fx._airwin fails. The rack loads, flags the Airwindows params, and presets still render with warnings."""
    import json
    import subprocess
    import sys
    from pathlib import Path

    code = f"""
import json, sys
sys.modules["fvwks_fx._airwin"] = None
sys.path.insert(0, {str(Path(__file__).parent)!r})
from conftest import load_source
from fvwks_contracts.models import Arrange, RenderRequest
from fvwks_fx import api
from fvwks_fx.modules import airwin
rack = api.rack_schema()
flagged = sorted(f"{{m.id}}.{{p.id}}" for m in rack.modules for p in m.params if "Unavailable" in (p.description or ""))
src = load_source("we_are__am_fenrir")
warnings = {{}}
for pid in ("pact", "signal", "ghost"):
    req = api.apply_hints(RenderRequest(source_id="x", preset_id=pid, quality="preview",
                                        arrange=Arrange(bpm=140, bars=4)), api.get_preset(pid))
    out = api.render(src, [None] * len(req.stack or []), req)
    assert out.audio.shape[1] > 0 and bool((out.audio == out.audio).all())
    warnings[pid] = [w for w in out.warnings if "Airwindows" in w]
print(json.dumps({{"available": airwin.AVAILABLE, "flagged": flagged, "warnings": warnings}}))
"""
    res = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=300)
    assert res.returncode == 0, res.stderr[-2000:]
    got = json.loads(res.stdout.strip().splitlines()[-1])
    assert got["available"] is False
    assert got["flagged"] == ["crush.derez", "drive.color", "drive.color_drive", "space.reverb_type"]
    assert got["warnings"]["pact"] and got["warnings"]["signal"] and got["warnings"]["ghost"]
