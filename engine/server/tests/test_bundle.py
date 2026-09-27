"""Portable engine bundle. The bundle tests are opt-in: they build a ~0.7 GB bundle (about a minute).

    FVWKS_TEST_BUNDLE=1 uv run --all-packages pytest server/tests/test_bundle.py
"""
import importlib.util
import json
import os
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "bundle_engine.sh"
TOKEN = "tok"
# An install folder deep enough that espeak-ng's data path (…/site-packages/espeakng_loader/espeak-ng-data/phontab)
# passes the ~160 characters espeak-ng silently truncates at (docs/sessions/README.md, Open issues).
DEEP = "an-install-folder-deliberately-long-enough-to-push-espeak-ng-data-past-its-160-character-limit"
ESPEAK_XFAIL = ("espeak-ng truncates data paths longer than ~160 characters; waiting for S1's short-path fix in "
                "fvwks_voice configure()/warm_up() (docs/sessions/README.md, Open issues)")
# S1's fix (session/s1-voice db1bb79) adds fvwks_voice.espeak_path; once it's merged this test must pass.
HAS_ESPEAK_FIX = importlib.util.find_spec("fvwks_voice.espeak_path") is not None


def test_refuses_to_replace_a_foreign_folder(tmp_path):
    precious = tmp_path / "Music"
    precious.mkdir()
    (precious / "set.aiff").write_bytes(b"keep me")
    out = subprocess.run([str(SCRIPT), str(precious)], capture_output=True, text=True)
    assert out.returncode == 1 and "refusing" in out.stderr
    assert (precious / "set.aiff").read_bytes() == b"keep me"


@pytest.fixture(scope="module")
def app_engine(tmp_path_factory):
    """The bundle, built once and moved into a deep `.app` path, as the packaged app would carry it."""
    if os.environ.get("FVWKS_TEST_BUNDLE") != "1":
        pytest.skip("set FVWKS_TEST_BUNDLE=1 to build the engine bundle")
    root = tmp_path_factory.mktemp("bundle")
    built = root / "build" / "engine"
    subprocess.run([str(SCRIPT), str(built)], check=True, capture_output=True, text=True)
    resources = root / DEEP / "FoxBox.app" / "Contents" / "Resources"
    resources.mkdir(parents=True)
    yield Path(shutil.move(str(built), str(resources / "engine")))
    shutil.rmtree(root, ignore_errors=True)  # don't leave 0.7 GB in pytest's kept tmp dirs


def _call(port, method, path, body=None, token=TOKEN):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json",
                                          **({"Authorization": f"Bearer {token}"} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=180) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read())
    except (ConnectionError, urllib.error.URLError) as err:  # the engine process died
        return None, {"state": "dead", "message": str(err)}


@contextmanager
def _running(engine: Path, tmp_path: Path):
    """The bundled launcher as Electron spawns it, with the bare environment of a Finder-launched app."""
    proc = subprocess.Popen(
        [str(engine / "bin" / "fvwks-engine"), "--port", "0", "--token", TOKEN, "--data-dir", str(tmp_path / "data"),
         "--export-dir", str(tmp_path / "exports"), "--exit-with-parent"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        env={"HOME": os.environ["HOME"], "PATH": "/usr/bin:/bin"})
    try:
        m = re.fullmatch(r"FVWKS_ENGINE_READY port=(\d+)\n", proc.stdout.readline())
        assert m, proc.stderr.read() if proc.poll() is not None else "no ready line"
        yield int(m.group(1)), proc
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_bundle_is_relocatable(app_engine, tmp_path):
    for link in (app_engine / "venv" / "bin").glob("python*"):
        assert not os.readlink(link).startswith("/"), f"{link} is an absolute link"
    with _running(app_engine, tmp_path) as (port, proc):
        status, health = _call(port, "GET", "/api/health")
        assert status == 200 and health["state"] in ("loading_model", "ready")
        assert _call(port, "GET", "/api/health", token=None)[0] == 401
        proc.stdin.close()  # the parent went away
        assert proc.wait(timeout=10) == 0


@pytest.mark.xfail(not HAS_ESPEAK_FIX, reason=ESPEAK_XFAIL, strict=False)
def test_tts_espeak_fallback_from_a_deep_install_path(app_engine, tmp_path):
    phontab = next((app_engine / "venv").rglob("espeakng_loader/espeak-ng-data/phontab"))
    assert len(str(phontab)) > 160, "the scenario must really be past espeak-ng's limit"
    with _running(app_engine, tmp_path) as (port, proc):
        deadline = time.monotonic() + 180
        while (health := _call(port, "GET", "/api/health")[1])["state"] == "loading_model":
            assert time.monotonic() < deadline, "voice warm-up never finished"
            time.sleep(0.25)
        if health["state"] == "dead":
            proc.wait(timeout=10)
            pytest.fail(f"engine died during warm-up (exit {proc.returncode}): {proc.stderr.read()[-1500:]}")
        assert health["state"] == "ready", health
        # A word no lexicon knows, so G2P falls back to espeak-ng (reading its data from the deep path).
        status, src = _call(port, "POST", "/api/sources/tts",
                            {"script": "WE ARE XYLOQUENDRAX | EXPECT *US*", "voice_id": "kokoro:am_fenrir"})
        assert status == 200, src
        assert src["duration_s"] > 1.0 and len(src["segments"]) == 2


@contextmanager
def _packaged(engine: Path, tmp_path: Path, **env):
    """As the packaged app spawns the bundled engine: token in the environment (never argv), models under the data
    dir (HF_HOME), a Finder-launched app's bare environment."""
    data = tmp_path / "data"
    proc = subprocess.Popen(
        [str(engine / "bin" / "fvwks-engine"), "--port", "0", "--data-dir", str(data), "--export-dir",
         str(tmp_path / "exports"), "--exit-with-parent"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        env={"HOME": os.environ["HOME"], "PATH": "/usr/bin:/bin", "FVWKS_TOKEN": TOKEN,
             "HF_HOME": str(data / "models"), **env})
    try:
        m = re.fullmatch(r"FVWKS_ENGINE_READY port=(\d+)\n", proc.stdout.readline())
        assert m, proc.stderr.read() if proc.poll() is not None else "no ready line"
        yield int(m.group(1)), proc
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def _settled(port, timeout=300):
    deadline = time.monotonic() + timeout
    while (health := _call(port, "GET", "/api/health")[1])["state"] in ("starting", "loading_model"):
        assert time.monotonic() < deadline, health
        time.sleep(0.25)
    return health


def test_packaged_layout_as_the_app_spawns_it(app_engine, tmp_path):
    """Resources/engine/bin/fvwks-engine with no uv: marker, token from the environment, HF_HOME under the data dir
    (pointed at this Mac's model cache, so nothing downloads), a line rendered, and a clean SIGTERM."""
    import signal

    assert (app_engine / ".fvwks-engine-bundle").is_file()
    hub = Path(os.environ.get("HF_HUB_CACHE") or Path(os.environ.get("HF_HOME") or Path.home() / ".cache" /
                                                             "huggingface") / "hub")
    if not hub.is_dir():
        pytest.skip("no local model cache to point HF_HOME at")
    (tmp_path / "data" / "models").mkdir(parents=True)
    (tmp_path / "data" / "models" / "hub").symlink_to(hub)
    with _packaged(app_engine, tmp_path) as (port, proc):
        health = _settled(port)
        assert health["state"] == "ready" and health["required_missing"] == [], health
        status, src = _call(port, "POST", "/api/sources/tts", {"script": "WE ARE GUY FVWKS"})
        assert status == 200, src
        status, r = _call(port, "POST", "/api/render", {"source_id": src["id"], "preset_id": "pact",
                                                       "arrange": {"bpm": 140, "bars": 4}})
        assert status == 200 and r["bars"] == 4, r
        proc.send_signal(signal.SIGTERM)
        assert proc.wait(timeout=30) in (0, -signal.SIGTERM)
        assert not (tmp_path / "data" / "library.sqlite3-wal").exists()  # closed, not abandoned


def test_packaged_first_launch_on_a_fresh_mac_offline(app_engine, tmp_path):
    """A fresh Mac: no models under HF_HOME, and no network. The engine tries the required downloads, says why they
    failed, lists what's missing, and keeps running (never a crash)."""
    with _packaged(app_engine, tmp_path, HF_HUB_OFFLINE="1") as (port, proc):
        health = _settled(port)
        assert health["state"] == "error" and health["required_missing"] == ["kokoro-82m", "deepfilternet3"], health
        assert "Couldn't install Kokoro 82M" in health["message"] and "network" in health["message"], health
        assert proc.poll() is None
        status, models = _call(port, "GET", "/api/models")
        assert status == 200 and not any(m["installed"] for m in models if m["required"])
        proc.stdin.close()
        assert proc.wait(timeout=10) == 0
