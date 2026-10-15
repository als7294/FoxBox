"""Portable engine bundle. The bundle tests are opt-in: they build a ~0.7 GB bundle (about a minute).

    FVWKS_TEST_BUNDLE=1 uv run --all-packages pytest server/tests/test_bundle.py
"""
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
# A deep install folder, as a user's Applications folder can be: nothing in the bundle may depend on a short path.
DEEP = "an-install-folder-deliberately-long-enough-to-push-the-bundles-paths-past-160-characters"


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


def _call(port, method, path, body=None, token=TOKEN, headers=None, raw=False):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **(headers or {}),
                                          **({"Authorization": f"Bearer {token}"} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=180) as res:
            return res.status, res.read() if raw else json.loads(res.read())
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
    for link in (app_engine / "runtime" / "venv" / "bin").glob("python*"):
        assert not os.readlink(link).startswith("/"), f"{link} is an absolute link"
    with _running(app_engine, tmp_path) as (port, proc):
        status, health = _call(port, "GET", "/api/health")
        assert status == 200 and health["state"] in ("loading_model", "ready")
        assert _call(port, "GET", "/api/health", token=None)[0] == 401
        proc.stdin.close()  # the parent went away
        assert proc.wait(timeout=10) == 0


def _tree(root: Path) -> dict[str, tuple[int, int]]:
    """Every file under the bundle with its size and mtime: the app is signed, so running it must change none."""
    return {str(p.relative_to(root)): (p.stat().st_size, p.stat().st_mtime_ns)
            for p in root.rglob("*") if p.is_file() and not p.is_symlink()}


def _unchanged(before: dict, after: dict) -> list[str]:
    return sorted({k for k in before.keys() | after.keys() if before.get(k) != after.get(k)})[:10]


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


def _upload(port, path, data: bytes, name="song.wav", token=TOKEN):
    boundary = "fvwks-bundle-test"
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
            "Content-Type: audio/wav\r\n\r\n").encode() + data + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=body, method="POST", headers={
        "Authorization": f"Bearer {token}", "Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=180) as res:
        return res.status, json.loads(res.read())


def _song_wav(seconds=16.0, sr=44100, bpm=124.0) -> bytes:
    """Four-on-the-floor over a bass line with a break: enough for a tempo, a key and sections."""
    import io
    import wave

    import numpy as np

    n = int(seconds * sr)
    t = np.arange(n) / sr
    beat = 60.0 / bpm
    phase = (t % beat) / beat
    kick = np.exp(-phase * 30) * np.sin(2 * np.pi * 50 * t)
    bass = 0.3 * np.sin(2 * np.pi * 55 * t) * (t % (4 * beat) < 3 * beat)
    x = 0.7 * kick + bass
    x[int(8 * sr):int(10 * sr)] *= 0.1  # a break
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 30000).astype("<i2").tobytes())
    return buf.getvalue()


def _wait(port, path, field, timeout=300):
    deadline = time.monotonic() + timeout
    while True:
        status, body = _call(port, "GET", path)
        assert status == 200, body
        if body.get(field) not in ("queued", "running") or time.monotonic() > deadline:
            return body
        time.sleep(0.25)


def test_packaged_layout_as_the_app_spawns_it(app_engine, tmp_path):
    """FoxBox 2.0's bundle smoke: Resources/engine/bin/fvwks-engine with no uv: marker, token from the environment,
    HF_HOME under the data dir (pointed at this Mac's model cache, so nothing downloads); health, a song uploaded,
    analysed and sectioned, its stems split (when the stems model is in that cache), and a clean SIGTERM."""
    import signal

    assert (app_engine / ".fvwks-engine-bundle").is_file()
    hub = Path(os.environ.get("HF_HUB_CACHE") or Path(os.environ.get("HF_HOME") or Path.home() / ".cache" /
                                                             "huggingface") / "hub")
    if not hub.is_dir():
        pytest.skip("no local model cache to point HF_HOME at")
    (tmp_path / "data" / "models").mkdir(parents=True)
    (tmp_path / "data" / "models" / "hub").symlink_to(hub)
    before = _tree(app_engine)
    with _packaged(app_engine, tmp_path) as (port, proc):
        health = _settled(port)
        assert health["state"] == "ready" and health["required_missing"] == [], health
        status, song = _upload(port, "/api/songs", _song_wav())
        assert status == 200, song
        song = _wait(port, f"/api/songs/{song['id']}", "analysis_state")
        assert song["analysis_state"] == "done" and abs(song["analysis"]["bpm"] - 124) < 2, song
        assert song["structure"] and song["structure"]["sections"], song
        status, models = _call(port, "GET", "/api/models")
        stems_model = next(m for m in models if m["id"] == "stems-htdemucs")
        if stems_model["installed"]:
            status, job = _call(port, "POST", f"/api/songs/{song['id']}/stems", {})
            assert status == 200, job
            job = _wait(port, f"/api/jobs/{job['id']}", "state")
            assert job["state"] == "done", job
            song = _call(port, "GET", f"/api/songs/{song['id']}")[1]
            assert song["stems_state"] == "done" and [s["name"] for s in song["stems"]] == [
                "drums", "bass", "vocals", "other"]
            status, feats = _call(port, "GET", f"/api/songs/{song['id']}/stems/features")
            assert status == 200 and feats["frames"] > 0, feats
        proc.send_signal(signal.SIGTERM)
        assert proc.wait(timeout=30) in (0, -signal.SIGTERM)
        assert not (tmp_path / "data" / "library.sqlite3-wal").exists()  # closed, not abandoned
    assert _unchanged(before, _tree(app_engine)) == []  # nothing written into the signed bundle


def test_packaged_first_launch_on_a_fresh_mac_offline(app_engine, tmp_path):
    """A fresh Mac: no models under HF_HOME, and no network. FoxBox 2.0 needs none at boot (the stems model downloads
    on the first split), so the engine is ready at once, lists the stems model as not installed, and writes nothing
    into the bundle."""
    before = _tree(app_engine)
    with _packaged(app_engine, tmp_path, HF_HUB_OFFLINE="1") as (port, proc):
        health = _settled(port)
        assert health["state"] == "ready" and health["required_missing"] == [], health
        status, models = _call(port, "GET", "/api/models")
        # installed only when another cache on this Mac already holds it (adopted by an APFS clone, no download)
        assert status == 200 and [(m["id"], m["required"], m["install_job_id"]) for m in models] == [
            ("stems-htdemucs", False, None)]
        proc.stdin.close()
        assert proc.wait(timeout=10) == 0
    assert _unchanged(before, _tree(app_engine)) == []


def test_bytecode_is_never_revalidated(app_engine):
    """Unchecked-hash .pyc files: a packaging copy that changes source mtimes can't make any interpreter rewrite
    them (flags word 0b01 = hash-based, source not checked)."""
    pycs = [*(app_engine / "runtime").rglob("*.pyc"), *(app_engine / "code").rglob("*.pyc")]
    assert len(pycs) > 1000
    flags = {int.from_bytes(p.read_bytes()[4:8], "little") for p in pycs[::50]}
    assert flags == {1}, flags


def test_no_file_names_the_build_machine(app_engine):
    """The app ships to other people: no file may carry the builder's home folder (also dash-escaped, as temp folders
    spell it) or the folder the bundle was built in. uv writes both into sysconfig, pyvenv.cfg, direct_url.json,
    libpython's install name and every .pyc; bundle_engine.sh rewrites them to /install."""
    home = os.path.expanduser("~")
    built = app_engine.parents[4] / "build" / "engine"  # where the app_engine fixture built it
    needles = [n.encode() for n in {home, home.replace("/", "-"), str(built), os.path.realpath(built)}]
    leaks = []
    for folder, _, files in os.walk(app_engine):
        for name in files:
            path = Path(folder, name)
            data = os.readlink(path).encode() if path.is_symlink() else path.read_bytes()
            if any(n in data for n in needles):
                leaks.append(str(path.relative_to(app_engine)))
    assert leaks == []
    out = subprocess.run([str(app_engine / "runtime" / "venv" / "bin" / "python"), "-I", "-B", "-c",
                          "import sys, sysconfig; print(sys.base_prefix); print(sysconfig.get_paths()['stdlib'])"],
                         capture_output=True, text=True, check=True)
    base_prefix, stdlib = out.stdout.split()
    python = app_engine / "runtime" / "python"
    assert Path(base_prefix) == python and Path(stdlib) == python / "lib" / "python3.12"


def test_components_runtime_hash_only_moves_with_dependencies(app_engine, tmp_path):
    """1.2 component updates: a second clean build from the same uv.lock, with one change to our code, has the
    same runtime hash and a new code hash (so the app downloads ~2 MB, not the ~800 MB runtime)."""
    engine = SCRIPT.parents[2]
    copy = tmp_path / "engine"
    shutil.copytree(engine, copy, symlinks=True, ignore=shutil.ignore_patterns(
        ".venv", "__pycache__", "*.egg-info", ".pytest_cache", "tests"))
    changed = copy / "server" / "src" / "fvwks_server" / "service.py"
    changed.write_text(changed.read_text() + "\n# a code-only change\n")
    built = tmp_path / "build" / "engine"
    subprocess.run([str(copy / "server" / "scripts" / "bundle_engine.sh"), str(built)], check=True,
                   capture_output=True, text=True)
    first, second = (json.loads((b / "components.json").read_text()) for b in (app_engine, built))
    assert first["runtime"] == second["runtime"] and first["code"] != second["code"]
    loaded = subprocess.run([str(built / "runtime" / "venv" / "bin" / "python"), "-I", "-B", "-c",
                             "import fvwks_server.service as m; print(m.__file__)"],
                            capture_output=True, text=True, check=True)
    assert Path(loaded.stdout.strip()) == built / "code" / "fvwks_server" / "service.py"


def test_packaged_library_wheel(app_engine, tmp_path):
    """2.0's library wheel in the packaged engine (mutagen from code/, macOS's afconvert and sips): a music folder, a
    rekordbox.xml (added by main) and Serato's standard library (found under HOME), each listed, previewed and loaded."""
    import sys

    sys.path.insert(0, str(Path(__file__).parent))
    from test_music_library import music_folder, rekordbox_xml, serato_library

    home = tmp_path / "home"
    files = music_folder(home / "Music" / "Tunes")
    xml = rekordbox_xml(tmp_path / "rekordbox.xml", [("1", files["mp3"].as_posix(), {
        "Name": "RB Tune", "Artist": "Guy", "_kids": [("TEMPO", {"Inizio": "0.25", "Bpm": "140.00", "Battito": "1"})]})])
    serato_library(home / "Music", [files["m4a"], files["flac"]])
    main = {"X-FoxBox-Main": TOKEN}
    with _packaged(app_engine, tmp_path, HOME=str(home)) as (port, _):
        _settled(port)
        assert _call(port, "POST", "/api/library/sources", {"kind": "folder", "path": "/tmp"})[0] == 403  # not main
        added = [_call(port, "POST", "/api/library/sources", {"kind": "folder", "path": str(home / "Music" / "Tunes")},
                       headers=main)[1],
                 _call(port, "POST", "/api/library/sources", {"kind": "rekordbox", "path": str(xml)}, headers=main)[1],
                 _call(port, "POST", "/api/library/sources/serato")[1]]
        assert [a["kind"] for a in added] == ["folder", "rekordbox", "serato"], added
        deadline = time.monotonic() + 60
        while any(s["state"] == "scanning" for s in _call(port, "GET", "/api/library/sources")[1]):
            assert time.monotonic() < deadline
            time.sleep(0.2)
        sources = {s["kind"]: s for s in _call(port, "GET", "/api/library/sources")[1]}
        assert [sources[k]["tracks"] for k in ("folder", "rekordbox", "serato")] == [4, 1, 2], sources
        for kind, src in sources.items():
            page = _call(port, "GET", f"/api/library/tracks?source_id={src['id']}&sort=title")[1]
            track = next(t for t in page["items"] if t["format"] in ("m4a", "mp3"))
            status, wav = _call(port, "GET", f"/api/library/tracks/{track['id']}/preview", raw=True)
            assert status == 200 and wav[:4] == b"RIFF" and len(wav) > 44100 * 2 * 2 * 15, kind
            status, song = _call(port, "POST", f"/api/library/tracks/{track['id']}/song")
            assert status == 200 and abs(song["duration_s"] - 30) < 0.3, (kind, song)
            if kind == "rekordbox":
                assert song["analysis"]["source"] == "rekordbox" and song["analysis"]["bpm"] == 140
        art = next(t for t in _call(port, "GET", f"/api/library/tracks?source_id={sources['folder']['id']}")[1]["items"]
                   if t["has_art"])
        status, jpeg = _call(port, "GET", f"/api/library/tracks/{art['id']}/art", raw=True)
        assert status == 200 and jpeg[:2] == b"\xff\xd8"

