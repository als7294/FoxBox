"""espeak-ng exits the whole process when its data path is too long (packaged .app, deep worktrees)."""

import os
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from fvwks_voice.espeak_path import MAX_DATA_PATH, short_data_path

# Pretend espeak-ng-data lives at argv[1], then phonemize a word no lexicon knows (reaches misaki's espeak fallback).
SCRIPT = textwrap.dedent("""
    import sys
    import espeakng_loader
    espeakng_loader.get_data_path = lambda: sys.argv[1]
    import misaki.espeak
    if sys.argv[2] == "fix":
        from fvwks_voice.espeak_path import ensure_short_espeak_path
        print("PATH", ensure_short_espeak_path())
    fallback = misaki.espeak.EspeakFallback(british=False)
    class Tok:
        text = "XYLOQUENDRAX"
    print("PS", fallback(Tok())[0])
""")


@pytest.fixture(scope="module")
def deep_data(tmp_path_factory):
    import espeakng_loader

    src = Path(espeakng_loader.get_data_path())
    app = tmp_path_factory.mktemp("deep") / "FoxBox.app/Contents/Resources/engine/.venv/lib/python3.12"
    deep = app / "site-packages" / ("x" * 40) / "espeak-ng-data"
    assert len(str(deep / "phontab")) > 170
    deep.parent.mkdir(parents=True)
    try:
        subprocess.run(["cp", "-cR", str(src), str(deep)], check=True, capture_output=True)  # APFS clone
    except subprocess.CalledProcessError:
        shutil.copytree(src, deep)
    return deep


def _run(deep: Path, mode: str, home: Path) -> subprocess.CompletedProcess:
    env = {**os.environ, "HOME": str(home)}
    return subprocess.run([sys.executable, "-c", SCRIPT, str(deep), mode], capture_output=True, text=True,
                          timeout=120, env=env)


def test_deep_path_kills_espeak_without_the_fix(deep_data, tmp_path):
    out = _run(deep_data, "nofix", tmp_path)
    assert out.returncode != 0, "expected espeak-ng to reject the long data path"


def test_deep_path_works_with_the_fix(deep_data, tmp_path):
    out = _run(deep_data, "fix", tmp_path)
    assert out.returncode == 0, out.stderr[-2000:]
    lines = dict(line.split(" ", 1) for line in out.stdout.splitlines() if " " in line)
    used = Path(lines["PATH"])
    try:
        assert len(str(used)) <= MAX_DATA_PATH and (used / "phontab").exists()
        assert lines["PS"].strip() and lines["PS"].strip() != "None"
    finally:
        shutil.rmtree(used.parent, ignore_errors=True)  # the per-source copy made for this test


def test_short_paths_are_left_alone(tmp_path):
    short = Path("/tmp")
    assert short_data_path(short) == short
