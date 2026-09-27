"""The real entry point: `fvwks-engine --port 0 --token T --data-dir D --exit-with-parent` as Electron spawns it."""
import json
import os
import re
import signal
import subprocess
import time
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest


def _get(url, token=None):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"} if token else {})
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read())


def _post(url, token, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as res:
        return json.loads(res.read())


def _spawn(tmp_path, *flags):
    env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    env.pop("FVWKS_TOKEN", None)
    return subprocess.Popen(
        [sys.executable, "-m", "fvwks_server.main", "--port", "0", "--token", "s3cret", "--data-dir",
         str(tmp_path / "data"), "--export-dir", str(tmp_path / "exports"), *flags],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, text=True)


def _ready_port(proc) -> int:
    line = proc.stdout.readline()
    m = re.fullmatch(r"FVWKS_ENGINE_READY port=(\d+)\n", line)
    assert m, (line, proc.stderr.read() if proc.poll() is not None else "")
    return int(m.group(1))


def _wait_warm(port):
    """The real voice engine warms up after READY (health: loading_model → ready)."""
    deadline = time.monotonic() + 120
    while True:
        status, body = _get(f"http://127.0.0.1:{port}/api/health", "s3cret")
        if status != 200 or body["state"] != "loading_model" or time.monotonic() > deadline:
            return status, body
        time.sleep(0.25)


def _assert_clean_exit(proc, code):
    err = proc.stderr.read()
    # uvicorn re-raises the signal after its graceful shutdown, so the status is SIGTERM's (never SIGSEGV's).
    assert code in (0, -signal.SIGTERM), (code, err[-3000:])
    assert "Traceback" not in err and "Fatal Python error" not in err, err[-3000:]


def test_engine_process_ready_line_auth_and_exit_with_parent(tmp_path):
    proc = _spawn(tmp_path, "--exit-with-parent")
    try:
        port = _ready_port(proc)
        status, body = _wait_warm(port)
        assert status == 200 and body["state"] == "ready"
        assert body["export_dir"] == str((tmp_path / "exports").resolve())
        status, body = _get(f"http://127.0.0.1:{port}/api/health")
        assert status == 401 and body["error"]["code"] == "unauthorized"
        # Bound to loopback only: the socket must not accept on other interfaces.
        lsof = subprocess.run(["lsof", "-nP", "-a", "-p", str(proc.pid), "-iTCP", "-sTCP:LISTEN"],
                              capture_output=True, text=True)
        if lsof.returncode == 0:
            assert f"127.0.0.1:{port}" in lsof.stdout and f"*:{port}" not in lsof.stdout
        proc.stdin.close()  # the parent went away
        assert proc.wait(timeout=10) == 0
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_sigterm_after_real_work_shuts_down_cleanly(tmp_path):
    """S4 stops the engine by signalling its process group. After real work (Kokoro and the rack ran on worker
    threads), SIGTERM must shut down gracefully: no crash, and the library closed rather than abandoned."""
    proc = _spawn(tmp_path)
    try:
        port = _ready_port(proc)
        status, body = _wait_warm(port)
        assert status == 200 and body["state"] == "ready", body
        api = f"http://127.0.0.1:{port}/api"
        src = _post(f"{api}/sources/tts", "s3cret", {"script": "WE ARE GUY FVWKS", "voice_id": "kokoro:am_fenrir"})
        _post(f"{api}/render", "s3cret", {"source_id": src["id"], "preset_id": "pact", "arrange": {"bars": 4}})
        proc.send_signal(signal.SIGTERM)
        _assert_clean_exit(proc, proc.wait(timeout=30))
        assert not (tmp_path / "data" / "library.sqlite3-wal").exists()  # SQLite drops the WAL on a clean close
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_sigterm_during_warm_up_exits_promptly(tmp_path):
    proc = _spawn(tmp_path)
    try:
        _ready_port(proc)  # the model is still loading now
        t0 = time.monotonic()
        proc.send_signal(signal.SIGTERM)
        _assert_clean_exit(proc, proc.wait(timeout=30))
        assert time.monotonic() - t0 < 10
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_version_flag():
    out = subprocess.run([sys.executable, "-m", "fvwks_server.main", "--version"], capture_output=True, text=True)
    assert out.returncode == 0 and out.stdout.startswith("fvwks-engine ")


@pytest.mark.parametrize("flag", ["--help"])
def test_cli_documents_flags(flag):
    out = subprocess.run([sys.executable, "-m", "fvwks_server.main", flag], capture_output=True, text=True)
    for option in ("--port", "--token", "--data-dir", "--export-dir", "--exit-with-parent"):
        assert option in out.stdout


def _fresh_mac_cache(root: Path) -> Path | None:
    """An HF_HOME as a fresh Mac's first-run install leaves it: only the pinned snapshots of the required models,
    no refs/main (a commit-sha download never writes one), files linked from this Mac's cache (no copies, no
    network). None when this Mac lacks them."""
    from huggingface_hub import constants
    from fvwks_voice import models

    hub = root / "hub"
    for spec in (s for s in models.MODELS.values() if s.required):
        for repo in spec.repos:
            real = models.repo_dir(repo)
            if real is None:
                return None
            snapshot = Path(constants.HF_HUB_CACHE) / f"models--{repo.repo_id.replace('/', '--')}" / "snapshots" / \
                repo.revision
            target = hub / f"models--{repo.repo_id.replace('/', '--')}" / "snapshots" / repo.revision
            for file in snapshot.rglob("*"):
                if file.is_file():
                    link = target / file.relative_to(snapshot)
                    link.parent.mkdir(parents=True, exist_ok=True)
                    link.symlink_to(file.resolve())
    return root


@pytest.mark.xfail(strict=False, reason="S1: KokoroEngine.model_dir() looks up refs/main, which a pinned first-run "
                                         "download never writes; fixed by resolving models.KOKORO_REPO's revision")
def test_fresh_mac_first_launch_finds_the_pinned_models(tmp_path):
    """Found by a real first launch of the packaged engine: the required models downloaded, then warm-up said Kokoro
    wasn't installed. Here without network: an HF_HOME holding only the pinned snapshots must reach ready."""
    hf = _fresh_mac_cache(tmp_path / "hf")
    if hf is None:
        pytest.skip("this Mac's model cache lacks the pinned required models")
    env = {**os.environ, "PYTHONUNBUFFERED": "1", "HF_HOME": str(hf), "HF_HUB_OFFLINE": "1"}
    env.pop("FVWKS_TOKEN", None)
    env.pop("HF_HUB_CACHE", None)
    proc = subprocess.Popen(
        [sys.executable, "-m", "fvwks_server.main", "--port", "0", "--token", "s3cret", "--data-dir",
         str(tmp_path / "fresh"), "--export-dir", str(tmp_path / "exports")],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, text=True)
    try:
        port = _ready_port(proc)
        status, health = _wait_warm(port)
        assert status == 200 and health["required_missing"] == [], health
        assert health["state"] == "ready", health
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
