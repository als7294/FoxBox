"""v0.2 AUTO bars: the shared resolver semantics, and the engine honouring it once fx supports it."""
import pytest

from fvwks_contracts.audio import resolve_auto_bars
from fvwks_contracts.models import Arrange, Settings


def test_resolver_nearest_fitting_bar_count():
    bar = 240 / 140  # 1.714 s at 140 BPM
    assert resolve_auto_bars(0.4 * bar, 140) == 1          # short line -> 1 bar (pad)
    assert resolve_auto_bars(1.6 * bar, 140) == 2          # 1.6 bars -> 2 (pad), 1 would need 60% squeeze
    assert resolve_auto_bars(4.3 * bar, 140) == 4          # 4.3 bars -> 4 (7.5% squeeze <= 8%)
    assert resolve_auto_bars(4.5 * bar, 140) == 8          # 4.5 bars needs 12.5% -> not allowed -> 8
    assert resolve_auto_bars(3.0 * bar, 140) == 4          # tie 2 vs 4 impossible (2 doesn't fit) -> 4
    assert resolve_auto_bars(40 * bar, 140) == 16          # nothing fits -> longest
    # pre-roll/tail count against the room: GHOST's 1-bar swell pushes 3.5 bars of speech to 8
    assert resolve_auto_bars(3.5 * bar, 140, first_word_beat=4) == 8


def test_tail_room_moves_to_next_bar_count():
    bar = 240 / 140
    # 3.99 bars of speech "fits" 4 bars with no room; reserving a 0.5 s tail pushes AUTO to 8 (never chop the ending)
    assert resolve_auto_bars(3.99 * bar, 140) == 4
    assert resolve_auto_bars(3.99 * bar, 140, tail_s=0.5, max_stretch=0.0) == 8


def test_defaults_are_auto():
    assert Arrange().bars == "auto" and Settings(export_dir="/tmp").default_bars == "auto"
    assert Arrange(bars=4).bars == 4 and Arrange(bars=None).bars is None


def test_engine_resolves_auto_bars(tmp_path):
    fx = pytest.importorskip("fvwks_fx.api")
    if not getattr(fx, "AUTO_BARS", False):
        pytest.skip("fx has not implemented v0.2 AUTO bars yet (set fvwks_fx.api.AUTO_BARS = True)")
    from fastapi.testclient import TestClient
    from fvwks_server.app import create_app
    from fvwks_server.config import Config

    with TestClient(create_app(Config.from_env(str(tmp_path / "d"), str(tmp_path / "e")))) as c:
        src = c.post("/api/sources/tts", json={"script": "WE ARE GUY FVWKS | EXPECT *US*"}).json()
        r = c.post("/api/render", json={"source_id": src["id"], "preset_id": "pact", "arrange": {"bpm": 140}}).json()
        assert r["bars"] in (1, 2, 4, 8, 16) and r["n_samples"] == round(r["bars"] * 240 / 140 * r["sample_rate"])
