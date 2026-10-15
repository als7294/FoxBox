from __future__ import annotations

from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
FIXTURES = REPO / "fixtures"


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "stems: needs the stems-htdemucs model (skipped when it isn't installed)")


@pytest.fixture(scope="session")
def fixtures_dir() -> Path:
    return FIXTURES
