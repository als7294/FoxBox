from __future__ import annotations

from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
FIXTURES = REPO / "fixtures"


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "kokoro: needs the cached Kokoro model (skipped when it isn't installed)")
    config.addinivalue_line("markers", "qwen3: needs the Qwen3-TTS persona model (skipped when it isn't installed)")
    config.addinivalue_line("markers", "denoise: needs the DeepFilterNet3 model (skipped when it isn't installed)")
    config.addinivalue_line("markers", "asr: needs the whisper-aligner model (skipped when it isn't installed)")


@pytest.fixture(scope="session")
def fixtures_dir() -> Path:
    return FIXTURES


@pytest.fixture(scope="session")
def kokoro():
    """The process-wide Kokoro engine, loaded and warmed once per test session."""
    from fvwks_voice.tts_kokoro import get_engine

    eng = get_engine()
    if not eng.is_installed():
        pytest.skip("Kokoro model not cached (run KokoroEngine().install())")
    eng.load()
    return eng
