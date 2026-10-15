"""HTTP API against the voice and fx stubs: the full tts → render → export → rekordbox.xml flow, auth, library,
presets, settings, batch, jobs and audio streaming."""
import base64
import io
import json
import time
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient
from fvwks_fx import api as fx_api
from fvwks_voice import api as voice_api

from fvwks_server.app import create_app
from fvwks_server.config import Config

TOKEN = "t0ken-s3"


AUTH = {"Authorization": f"Bearer {TOKEN}"}


_CLIENTS: list = []


def open_client(config, token=TOKEN):
    """A TestClient with the app's lifespan entered; the autouse fixture closes it after the test."""
    client = TestClient(create_app(config))
    client.__enter__()
    _CLIENTS.append(client)
    client.headers.update(AUTH if token else {})
    return client


def make_client(tmp_path, token=TOKEN, **config_overrides):
    config = Config.from_env(str(tmp_path / "data"), str(tmp_path / "exports"), token)
    for k, v in config_overrides.items():
        setattr(config, k, v)
    return open_client(config, token)


@pytest.fixture(autouse=True)
def _close_engines():
    """Close every engine the test opened. Its background jobs (WORLD analysis, stack prefetch) and start-up work
    are cancelled and joined, so they never call into the next test's monkeypatched voice/fx functions and no
    worker is still in native code when the interpreter exits."""
    yield
    while _CLIENTS:
        client = _CLIENTS.pop()
        stopped = client.app.state.service.close(timeout=60)
        client.__exit__(None, None, None)  # the lifespan's own close() is then a no-op
        assert stopped, "background work was still running a minute after close()"


@pytest.fixture
def client(tmp_path):
    return make_client(tmp_path)


def ok(response, status=200):
    assert response.status_code == status, response.text
    return response.json() if response.content and status != 204 else None


def wait_job(client, job_id, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = ok(client.get(f"/api/jobs/{job_id}"))
        if job["state"] not in ("queued", "running"):
            return job
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} did not finish")


def test_every_api_route_requires_the_token(tmp_path):
    c = make_client(tmp_path)
    anon = TestClient(c.app)
    routes = [(m.upper(), path) for path, ops in c.app.openapi()["paths"].items() for m in ops]  # the contract
    assert len(routes) == 27  # contracts v1.1 (FoxBox 2.0: v1.0's 17 and the library wheel's 10)
    for method, path in routes:
        url = path.replace("{", "").replace("}", "_x")  # any value: auth runs before the route body
        res = anon.request(method, url)
        assert res.status_code == 401, (method, path, res.status_code)
        res = anon.request(method, url + f"?token={TOKEN}")
        expected_ok = method == "GET" and path.startswith("/api/audio/")
        assert (res.status_code != 401) == expected_ok, (method, path, res.status_code)


def test_cors_only_for_dev_origins(tmp_path):
    preflight = {"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"}
    closed = make_client(tmp_path / "a")
    assert "access-control-allow-origin" not in closed.options("/api/health", headers=preflight).headers
    dev = make_client(tmp_path / "b", allow_origins=["http://localhost:5173"])
    res = dev.options("/api/health", headers=preflight)
    assert res.headers.get("access-control-allow-origin") == "http://localhost:5173"
    other = dev.options("/api/health", headers={**preflight, "Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in other.headers


def test_interactive_voice_work_goes_first():
    import threading

    from fvwks_server.service import PriorityLock

    gate, order, hold = PriorityLock(), [], threading.Event()

    def worker(name, background, started):
        started.set()
        with gate.hold(background):
            order.append(name)
            if name == "first":
                hold.wait(5)

    def start(name, background):
        started = threading.Event()
        t = threading.Thread(target=worker, args=(name, background, started))
        t.start()
        started.wait(5)
        time.sleep(0.05)  # let it reach the gate
        return t

    threads = [start("first", True), start("bg", True), start("fg", False)]
    hold.set()
    for t in threads:
        t.join(5)
    assert order == ["first", "fg", "bg"]  # the request jumped the queued background job
    with gate.hold(False):
        with gate.hold(False):  # reentrant
            pass


def test_health(client):
    h = ok(client.get("/api/health"))
    # Engine-agnostic: "stub" before integration, "kokoro-mlx"/"fvwks-rack" once S1/S2 are merged.
    assert h["state"] == "ready" and h["voice_engine"] and h["fx_engine"]
    assert h["disk_free_bytes"] > 0 and Path(h["data_dir"]).is_dir()


QWEN = "qwen3-tts-voicedesign"


class FakeVoiceModels:
    """Stands in for S1's list_models/install_model hooks."""

    def __init__(self, size=1_000_000_000):
        from fvwks_contracts.models import ModelInfo

        self.info = {m: ModelInfo(id=m, name=n, engine=e, size_bytes=sz, installed=inst, required=req,
                                  license="Apache-2.0", description="")
                     for m, n, e, sz, inst, req in [("kokoro-82m", "Kokoro 82M", "kokoro", 330_000_000, True, True),
                                                    (QWEN, "Qwen3-TTS VoiceDesign", "qwen3", size, False, False)]}
        self.release = __import__("threading").Event()
        self.calls = []

    def list_models(self):
        return list(self.info.values())

    def install_model(self, model_id, progress):
        self.calls.append(model_id)
        for i in range(1, 5):
            progress(i / 5, f"shard {i}/4")
            if not self.release.wait(5):
                raise TimeoutError("test never released the download")
        self.info[model_id] = self.info[model_id].model_copy(update={"installed": True})


@pytest.fixture
def models(monkeypatch):
    fake = FakeVoiceModels()
    monkeypatch.setattr(voice_api, "list_models", fake.list_models, raising=False)
    monkeypatch.setattr(voice_api, "install_model", fake.install_model, raising=False)
    return fake


def test_model_install_job_with_progress(client, models):
    assert [m["installed"] for m in ok(client.get("/api/models"))] == [True, False]
    job = ok(client.post(f"/api/models/{QWEN}/install"))
    assert job["kind"] == "model_install" and job["state"] in ("queued", "running")
    assert ok(client.post(f"/api/models/{QWEN}/install"))["id"] == job["id"]  # one download per model
    deadline = time.time() + 5
    while ok(client.get(f"/api/jobs/{job['id']}"))["progress"] < 0.2 and time.time() < deadline:
        time.sleep(0.01)
    running = ok(client.get(f"/api/jobs/{job['id']}"))
    assert running["state"] == "running" and running["message"] == "shard 1/4"
    models.release.set()
    done = wait_job(client, job["id"])
    assert done["state"] == "done" and done["progress"] == 1.0 and done["message"] == "Qwen3-TTS VoiceDesign installed."
    assert models.calls == [QWEN] and ok(client.get("/api/models"))[1]["installed"] is True
    again = ok(client.post(f"/api/models/{QWEN}/install"))
    assert again["state"] == "done" and "already installed" in again["message"]


def test_model_install_can_be_cancelled(client, models):
    job = ok(client.post(f"/api/models/{QWEN}/install"))
    deadline = time.time() + 5
    while ok(client.get(f"/api/jobs/{job['id']}"))["state"] != "running" and time.time() < deadline:
        time.sleep(0.01)
    ok(client.post(f"/api/jobs/{job['id']}/cancel"))
    models.release.set()  # the next progress() call raises
    assert wait_job(client, job["id"])["state"] == "cancelled"
    assert ok(client.get("/api/models"))[1]["installed"] is False


def test_model_install_keeps_5gb_free(client, models, monkeypatch):
    from collections import namedtuple

    from fvwks_server import service as service_module

    usage = namedtuple("usage", "total used free")
    monkeypatch.setattr(service_module.shutil, "disk_usage", lambda path: usage(100e9, 94e9, 5.5e9))
    job = ok(client.post(f"/api/models/{QWEN}/install"))  # 1 GB model + 5 GB reserve > 5.5 GB free
    assert job["state"] == "error" and job["error"]["code"] == "disk_full"
    assert "0.5 GB" in job["error"]["hint"] and models.calls == []


def test_voice_configure_hook(tmp_path, monkeypatch):
    seen = []
    monkeypatch.setattr(voice_api, "configure", lambda data_dir: seen.append(data_dir), raising=False)
    make_client(tmp_path)
    assert seen == [(tmp_path / "data").resolve() / "voice"] and seen[0].is_dir()


def test_fast_peaks_match_the_contract_helper():
    from fvwks_contracts.audio import peaks as contract_peaks

    from fvwks_server.audio_io import peaks

    rng = np.random.default_rng(3)
    for shape in [(2, 604_800), (1, 1_000), (700,), (2, 801), (1, 5)]:
        x = (rng.standard_normal(shape) * 0.7).astype(np.float32)
        assert peaks(x, 44100) == contract_peaks(x, 44100)
    assert peaks(np.zeros((2, 0), np.float32), 44100) == contract_peaks(np.zeros((2, 0), np.float32), 44100)


def test_settings_are_cached_but_updates_are_seen(client):
    service = client.app.state.service
    first = ok(client.get("/api/settings"))
    service.library.get_setting = None  # a cached read never touches the library again
    assert ok(client.get("/api/settings")) == first
    del service.library.get_setting
    ok(client.put("/api/settings", json={**first, "artist": "GUY FVWKS LIVE"}))
    assert ok(client.get("/api/settings"))["artist"] == "GUY FVWKS LIVE"
    got = service.settings()
    got.artist = "mutated by a caller"
    assert service.settings().artist == "GUY FVWKS LIVE"  # callers get copies


def test_startup_sweeps_stale_temp_files_only(client, tmp_path):
    import os

    service = client.app.state.service
    export_root = Path(ok(client.get("/api/settings"))["export_dir"])
    old = time.time() - 7200
    stale = [export_root / ".x_PACT_wet_v01.aiff.0123abcd.part",
             export_root / "Warehouse" / ".warehouse_rekordbox.xml.89abcdef.part",
             service.audio.dir / ".rnd_000000000001.wav.fedcba98.part",
             service.config.cache_dir / "stack" / "ab" / ".abcd.npz.00000000.part"]
    fresh = export_root / ".x_PACT_dry_v01.aiff.11112222.part"  # maybe being written right now
    user_files = [export_root / ".DS_Store", export_root / "notes.part", export_root / "mix.aiff"]
    for path in [*stale, fresh, *user_files]:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x")
    for path in [*stale, *user_files]:
        os.utime(path, (old, old))
    assert service.housekeeping() == len(stale)
    assert not any(p.exists() for p in stale)
    assert fresh.exists() and all(p.exists() for p in user_files)


def test_dev_export_folder_in_a_hidden_path_keeps_working(tmp_path):
    config = Config.from_env(str(tmp_path / ".devdata" / "data"), None, TOKEN)  # dev default: <.devdata>/exports
    assert config.export_dir == (tmp_path / ".devdata" / "exports").resolve()
    c = open_client(config)
    settings = ok(c.get("/api/settings"))
    saved = ok(c.put("/api/settings", json={**settings, "format": "wav"}))  # unchanged folder: accepted
    assert saved["format"] == "wav" and saved["export_dir"] == settings["export_dir"]
    other = c.put("/api/settings", json={**settings, "export_dir": str(tmp_path / ".other" / "x")})
    assert other.status_code == 400  # but a *new* hidden folder isn't


def test_settings_save_with_the_export_drive_unplugged(client, tmp_path):
    usb = tmp_path / "USB"
    settings = ok(client.get("/api/settings"))
    saved = ok(client.put("/api/settings", json={**settings, "export_dir": str(usb / "Drops")}))
    usb.rename(tmp_path / "gone")
    usb.write_bytes(b"")  # can't be created now
    again = ok(client.put("/api/settings", json={**saved, "artist": "GUY FVWKS LIVE"}))  # unchanged folder: no probing
    assert again["artist"] == "GUY FVWKS LIVE"


def test_start_up_survives_a_failing_clean_up(client, monkeypatch):
    service = client.app.state.service

    def boom():
        raise PermissionError("export folder on a hung network share")

    monkeypatch.setattr(service, "housekeeping", boom)
    service.start()
    deadline = time.time() + 10
    while ok(client.get("/api/health"))["state"] != "ready" and time.time() < deadline:
        time.sleep(0.02)
    assert ok(client.get("/api/health"))["state"] == "ready"


def test_v02_settings_saved_before_auto_still_load(tmp_path):
    first = make_client(tmp_path)
    settings = ok(first.get("/api/settings"))
    first.app.state.service.library.set_setting("settings", {**settings, "default_bars": 4})  # a v0.1 row
    again = make_client(tmp_path)
    assert ok(again.get("/api/settings"))["default_bars"] == 4


class FakeRegistry:
    """A fresh Mac: the voice package's models, none downloaded. install() steps its progress on cue."""

    def __init__(self, fail=()):
        from fvwks_contracts.models import ModelInfo

        self.installed: dict[str, bool] = {"kokoro-82m": False, "deepfilternet3": False, "whisper-aligner": False,
                                           "qwen3-tts-voicedesign": False}
        self.sizes = {"kokoro-82m": 356_000_000, "deepfilternet3": 8_700_000, "whisper-aligner": 2_900_000_000,
                      "qwen3-tts-voicedesign": 9_000_000_000}
        self.required = {"kokoro-82m", "deepfilternet3"}
        self.fail, self.order, self.warmed = set(fail), [], []
        self.step = __import__("threading").Semaphore(0)
        self._info = ModelInfo

    def list_models(self):
        return [self._info(id=i, name=i.upper(), engine="x", size_bytes=self.sizes[i], installed=done,
                           required=i in self.required, license="MIT", description="") for i, done in
                self.installed.items()]

    def install_model(self, model_id, progress):
        self.order.append(model_id)
        for fraction in (0.25, 0.5):
            self.step.acquire(timeout=10)
            progress(fraction, f"Downloading {model_id.upper()}: {fraction:.0%}")
        if model_id in self.fail:
            raise type("VoiceError", (Exception,), {"code": "install_failed", "status": 502,
                                                    "message": f"Downloading {model_id} failed: offline",
                                                    "hint": "Check the network connection, then try again."})()
        self.installed[model_id] = True

    def warm_up(self):
        if not self.installed["kokoro-82m"]:
            raise RuntimeError("model_not_installed")
        self.warmed.append(True)


def install_registry(monkeypatch, registry):
    for name in ("list_models", "install_model", "warm_up"):
        monkeypatch.setattr(voice_api, name, getattr(registry, name), raising=False)


def health_while(client, registry, steps):
    """Health as each download step is released: [(state, progress, message)]."""
    seen = []
    for _ in range(steps):
        deadline = time.time() + 10
        while (h := ok(client.get("/api/health")))["state"] == "loading_model" and h["progress"] is None \
                and time.time() < deadline:
            time.sleep(0.01)
        seen.append((h["state"], h["progress"], h["message"]))
        registry.step.release()
        time.sleep(0.05)
    return seen


def wait_state(client, *states, timeout=20):
    deadline = time.time() + timeout
    while (h := ok(client.get("/api/health")))["state"] not in states:
        assert time.time() < deadline, h
        time.sleep(0.02)
    return h


def test_first_launch_installs_the_required_models_with_progress(client, monkeypatch):
    registry = FakeRegistry()
    install_registry(monkeypatch, registry)
    client.app.state.service.start()
    seen = health_while(client, registry, steps=4)
    assert all(state == "loading_model" for state, _, _ in seen)
    progress = [p for _, p, _ in seen]
    assert progress == sorted(progress) and 0 <= progress[0] < progress[-1] < 1  # one bar over both downloads
    assert "KOKORO-82M" in seen[0][2] and "DEEPFILTERNET3" in seen[-1][2]
    health = wait_state(client, "ready")
    assert health["message"] is None
    assert registry.order == ["kokoro-82m", "deepfilternet3"]  # the opt-in models stay opt-in
    assert not registry.installed["whisper-aligner"] and not registry.installed["qwen3-tts-voicedesign"]


def test_first_launch_without_the_denoiser_still_works(client, monkeypatch):
    registry = FakeRegistry(fail={"deepfilternet3"})
    install_registry(monkeypatch, registry)
    client.app.state.service.start()
    for _ in range(4):  # two steps per download
        registry.step.release()
    health = wait_state(client, "ready", "error")
    assert health["state"] == "ready"
    assert health["message"] == "Not installed: DEEPFILTERNET3 (Settings → Models)."
    registry.fail.clear()  # back online: the retry from the models screen...
    ok(client.post("/api/models/deepfilternet3/install"))
    for _ in range(2):
        registry.step.release()
    deadline = time.time() + 10
    while ok(client.get("/api/health"))["message"] and time.time() < deadline:
        time.sleep(0.02)
    assert ok(client.get("/api/health"))["message"] is None  # ...clears the note


def one_model_registry(monkeypatch, *, installer, needs=None, size=2_900_000_000, required=False):
    """A voice package with one model (not installed) whose install() is `installer(progress)`."""
    from fvwks_contracts.models import ModelInfo

    state = {"installed": False}

    def list_models():
        return [ModelInfo(id="asr", name="Transcripts", engine="asr", size_bytes=size, installed=state["installed"],
                          required=required, license="MIT", description="", install_needs_bytes=needs)]

    def install_model(model_id, progress):
        installer(progress)
        state["installed"] = True

    monkeypatch.setattr(voice_api, "list_models", list_models, raising=False)
    monkeypatch.setattr(voice_api, "install_model", install_model, raising=False)
    return state


def test_v04_install_jobs_report_bytes_rate_and_time_left(client, monkeypatch):
    import threading

    gate = threading.Event()

    def installer(progress):  # today's installer: a fraction and a message, no bytes
        progress(0.25, "Downloading Transcripts: 0.7 of 2.9 GB")
        time.sleep(0.6)
        progress(0.5, "Downloading Transcripts: 1.5 of 2.9 GB")
        gate.wait(10)

    one_model_registry(monkeypatch, installer=installer)
    job = ok(client.post("/api/models/asr/install"))
    deadline = time.time() + 10
    while (job := ok(client.get(f"/api/jobs/{job['id']}")))["bytes_done"] != 1_450_000_000:
        assert time.time() < deadline, job
        time.sleep(0.02)
    assert job["bytes_total"] == 2_900_000_000 and job["current_item"] == "Transcripts"
    assert job["rate_bps"] > 0 and job["eta_s"] > 0  # "1.5 of 2.9 GB · 2.4 GB/s · 0:01 left"
    model = ok(client.get("/api/models"))[0]
    assert model["install_job_id"] == job["id"] and model["install_needs_bytes"] == 2_900_000_000 + 5_000_000_000
    gate.set()
    done = wait_job(client, job["id"])
    assert done["state"] == "done" and done["bytes_done"] == done["bytes_total"] and done["eta_s"] == 0
    model = ok(client.get("/api/models"))[0]
    assert model["installed"] and model["install_job_id"] is None and model["install_needs_bytes"] is None


def test_v04_install_jobs_take_the_installers_own_bytes(client, monkeypatch):
    def installer(progress):
        progress(0.1, "Downloading", bytes_done=12_345, bytes_total=99_999, current_item="kokoro-v1_0.safetensors")

    one_model_registry(monkeypatch, installer=installer, size=100_000)
    seen = []
    real_transfer = __import__("fvwks_server.jobs", fromlist=["JobRunner"]).JobRunner._transfer

    def spy(self, job, done, total, item):
        seen.append((done, total, item))
        return real_transfer(self, job, done, total, item)

    monkeypatch.setattr("fvwks_server.jobs.JobRunner._transfer", spy)
    wait_job(client, ok(client.post("/api/models/asr/install"))["id"])
    assert (12_345, 99_999, "kokoro-v1_0.safetensors") in seen


def test_v05_install_needs_bytes_drives_the_disk_guard(client, monkeypatch):
    import collections

    import fvwks_server.service as service_module

    one_model_registry(monkeypatch, installer=lambda progress: None, size=9_000_000_000,
                       needs=6_000_000_000)  # a resumed download: 1 GB to go plus the 5 GB reserve
    usage = collections.namedtuple("usage", "total used free")
    monkeypatch.setattr(service_module.shutil, "disk_usage", lambda path: usage(0, 0, 7_000_000_000))
    assert ok(client.get("/api/models"))[0]["install_needs_bytes"] == 6_000_000_000
    assert wait_job(client, ok(client.post("/api/models/asr/install"))["id"])["state"] == "done"


def test_v04_health_lists_required_models_that_are_missing(client, monkeypatch):
    one_model_registry(monkeypatch, installer=lambda progress: None, required=True)
    monkeypatch.delattr(voice_api, "install_model")  # nothing can fetch it: health still says it's missing
    client.app.state.service._models_seen = None
    assert ok(client.get("/api/health"))["required_missing"] == ["asr"]


def test_the_model_cache_the_app_points_at_is_created(tmp_path, monkeypatch):
    """The bundled app sets HF_HOME=<data dir>/models, which doesn't exist on a fresh Mac; the installer measures
    free space on it before the first download (found by the packaged-layout smoke test)."""
    monkeypatch.setenv("HF_HOME", str(tmp_path / "fresh" / "models"))
    make_client(tmp_path)
    assert (tmp_path / "fresh" / "models").is_dir()


def voice_error(code, status, message="", hint=None):
    return type("VoiceError", (Exception,), {"code": code, "status": status, "message": message or code,
                                             "hint": hint})()


def two_model_registry(monkeypatch, **extra):
    from fvwks_contracts.models import ModelInfo

    state = {"kokoro-82m": True, "asr": True}

    def list_models():
        return [ModelInfo(id="kokoro-82m", name="Kokoro 82M", engine="kokoro", size_bytes=356_000_000,
                          installed=state["kokoro-82m"], required=True, license="Apache-2.0", description="",
                          **extra.get("kokoro-82m", {})),
                ModelInfo(id="asr", name="Transcripts", engine="asr", size_bytes=2_900_000_000,
                          installed=state["asr"], required=False, license="MIT", description="",
                          **extra.get("asr", {}))]

    monkeypatch.setattr(voice_api, "list_models", list_models, raising=False)
    return state


def test_v06_uninstall_models(client, monkeypatch):
    state = two_model_registry(monkeypatch)
    removed = []
    monkeypatch.delattr(voice_api, "uninstall_model", raising=False)
    assert client.delete("/api/models/asr").status_code == 501
    monkeypatch.setattr(voice_api, "uninstall_model", lambda model_id: (removed.append(model_id),
                                                                       state.update({model_id: False})), raising=False)
    assert client.delete("/api/models/nope").status_code == 404
    res = client.delete("/api/models/kokoro-82m")
    assert res.status_code == 409 and res.json()["error"]["code"] == "model_required"
    assert ok(client.delete("/api/models/asr"))["installed"] is False and removed == ["asr"]
    assert ok(client.delete("/api/models/asr"))["installed"] is False and removed == ["asr"]  # already gone
    state["asr"] = True

    def busy(model_id):
        raise voice_error("model_busy", 409, "Transcripts is transcribing a take.", "Try again when it's done.")

    monkeypatch.setattr(voice_api, "uninstall_model", busy, raising=False)
    res = client.delete("/api/models/asr")  # the voice package's own refusal passes through
    assert res.status_code == 409 and res.json()["error"]["hint"] == "Try again when it's done."


def test_v06_a_model_still_downloading_cant_be_removed(client, monkeypatch):
    import threading

    gate = threading.Event()
    one_model_registry(monkeypatch, installer=lambda progress: gate.wait(10))
    monkeypatch.setattr(voice_api, "uninstall_model", lambda model_id: None, raising=False)
    job = ok(client.post("/api/models/asr/install"))
    res = client.delete("/api/models/asr")
    assert res.status_code == 409 and res.json()["error"]["code"] == "model_busy"
    gate.set()
    wait_job(client, job["id"])


def test_v06_an_installed_model_with_an_update_downloads_it(client, monkeypatch):
    two_model_registry(monkeypatch, asr={"update_available": True, "install_needs_bytes": 5_400_000_000,
                                         "version": "1.1", "installed_version": "1.0"})
    fetched = []
    monkeypatch.setattr(voice_api, "install_model", lambda model_id, progress: fetched.append(model_id),
                        raising=False)
    models = {m["id"]: m for m in ok(client.get("/api/models"))}
    assert models["asr"]["install_needs_bytes"] == 5_400_000_000  # installed, but the update's download counts
    assert models["kokoro-82m"]["install_needs_bytes"] is None  # current: nothing to download
    done = wait_job(client, ok(client.post("/api/models/asr/install"))["id"])
    assert done["state"] == "done" and fetched == ["asr"]


@pytest.fixture
def test_key(monkeypatch):
    """A throwaway signing key the engine trusts for this test (the real private key never leaves its owner)."""
    import base64

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    import fvwks_server.manifest as manifest_module

    key = Ed25519PrivateKey.generate()
    public = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    monkeypatch.setattr(manifest_module, "PUBLIC_KEYS", {"test-1": base64.b64encode(public).decode()})
    return key


def signed_manifest(key, published="2026-10-01", key_id="test-1", schema_version=1, version="1.1"):
    import base64

    from fvwks_contracts.models import ManifestModel, ManifestRepo, ModelManifest

    from fvwks_server.manifest import canonical

    manifest = ModelManifest(schema_version=schema_version, published=published, models={"asr": ManifestModel(
        version=version, notes="Faster alignment.", repos=[ManifestRepo(repo_id="mlx-community/whisper",
                                                                        revision="b" * 40, size_bytes=1_000)])})
    return {"manifest": manifest.model_dump(mode="json"), "key_id": key_id,
            "signature": base64.b64encode(key.sign(canonical(manifest))).decode()}


def test_v06_signed_manifests(client, monkeypatch, test_key, tmp_path):
    two_model_registry(monkeypatch)
    applied = []
    monkeypatch.setattr(voice_api, "apply_model_manifest", lambda manifest: applied.append(manifest.published),
                        raising=False)
    models = ok(client.put("/api/models/manifest", json=signed_manifest(test_key)))
    assert applied == ["2026-10-01"]
    assert next(m for m in models if m["id"] == "asr")["version"] == "1.1"  # from the manifest when S1 has none

    tampered = signed_manifest(test_key)
    tampered["manifest"]["models"]["asr"]["repos"][0]["revision"] = "c" * 40
    for body in (tampered, {**signed_manifest(test_key), "key_id": "someone-else"},
                 {**signed_manifest(test_key), "signature": "not base64!"}):
        res = client.put("/api/models/manifest", json=body)
        assert res.status_code == 403 and res.json()["error"]["code"] == "manifest_untrusted"
    res = client.put("/api/models/manifest", json=signed_manifest(test_key, schema_version=2))
    assert res.status_code == 422 and res.json()["error"]["code"] == "manifest_unsupported"
    res = client.put("/api/models/manifest", json=signed_manifest(test_key, published="2026-09-01"))
    assert res.status_code == 409 and res.json()["error"]["code"] == "manifest_outdated"  # no rolling pins back
    assert ok(client.put("/api/models/manifest", json=signed_manifest(test_key)))  # the same one again is fine

    def rejected(manifest):
        raise voice_error("manifest_rejected", 422, "whisper may only move to revisions of its own repos.")

    monkeypatch.setattr(voice_api, "apply_model_manifest", rejected, raising=False)
    res = client.put("/api/models/manifest", json=signed_manifest(test_key, published="2026-11-01"))
    assert res.status_code == 422 and res.json()["error"]["code"] == "manifest_rejected"

    again = make_client(tmp_path)  # the manifest in use survives a restart, so a replay still can't roll back
    res = again.put("/api/models/manifest", json=signed_manifest(test_key, published="2026-09-15"))
    assert res.status_code == 409


def test_v06_the_engine_trusts_the_release_key():
    import base64

    from fvwks_server.manifest import PUBLIC_KEYS

    assert "foxbox-1" in PUBLIC_KEYS and len(base64.b64decode(PUBLIC_KEYS["foxbox-1"], validate=True)) == 32


def test_v06_sign_manifest_script(tmp_path, monkeypatch, capsys):
    import base64
    import importlib.util

    import fvwks_server.manifest as manifest_module

    spec = importlib.util.spec_from_file_location("sign_manifest",
                                                  Path(__file__).parents[1] / "scripts" / "sign_manifest.py")
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)
    key = tmp_path / "keys" / "manifest-signing.key"
    public = script.generate_key(key, "test-1")
    assert oct(key.stat().st_mode & 0o777) == "0o600"
    with pytest.raises(SystemExit, match="already exists"):
        script.generate_key(key, "test-1")
    with pytest.raises(SystemExit, match="git work tree"):
        script.generate_key(Path(__file__).parent / "never-here.key", "test-1")
    monkeypatch.setattr(manifest_module, "PUBLIC_KEYS", {"test-1": public})
    source = tmp_path / "models.json"
    source.write_text(json.dumps({"published": "2026-10-01", "models": {}}))
    out = tmp_path / "models.signed.json"
    assert script.main([str(source), "-o", str(out), "--key", str(key), "--key-id", "test-1"]) == 0
    signed = json.loads(out.read_text())
    assert signed["key_id"] == "test-1" and len(base64.b64decode(signed["signature"])) == 64
    assert "PRIVATE" not in out.read_text()


SONG_SR = 44100


def song_bytes(seconds=20.0, sr=SONG_SR, bpm=120.0, first_beat_s=0.5, channels=2):
    """A synthetic song: a click on every beat from ``first_beat_s``, as a 16-bit WAV."""
    audio = np.zeros((int(seconds * sr), channels), np.float32)
    for t in np.arange(first_beat_s, seconds, 60.0 / bpm):
        i = int(t * sr)
        audio[i:i + 400] = 0.5 * np.hanning(800)[400:, None][: audio[i:i + 400].shape[0]]
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def upload_song(client, data=None, filename="song-1.wav", **form):
    return client.post("/api/songs", files={"file": (filename, data if data is not None else song_bytes(), "audio/wav")},
                       data=form)


class SongFx:
    """Stand-ins for S2's fx.analyze_song / fx.mix_song (the contract's signatures), recording their calls."""

    def __init__(self):
        from fvwks_contracts.models import SongAnalysis
        self.analysis = SongAnalysis(bpm=120.0, bpm_confidence=0.9, key="Am", camelot="8A", key_confidence=0.8,
                                     downbeat_s=0.5)
        self.gate = None  # a threading.Event the analysis waits for, when set
        self.fail = False
        self.analysed, self.mixed = [], []

    def analyze_song(self, audio, sr):
        self.analysed.append((audio.shape, audio.dtype, sr))
        if self.gate is not None:
            assert self.gate.wait(20)
        if self.fail:
            raise RuntimeError("no beat found")
        return self.analysis

    def mix_song(self, song, song_sr, drop, drop_sr, *, drop_start_s, bpm, placement, excerpt_s, master, quality):
        from fvwks_contracts.seam import MixOutput
        self.mixed.append(dict(drop_start_s=drop_start_s, bpm=bpm, at_bar=placement.at_bar, excerpt_s=excerpt_s,
                               quality=quality, song_sr=song_sr, drop_sr=drop_sr, drop_len=drop.shape[-1]))
        start, end = excerpt_s or (0.0, song.shape[-1] / song_sr)
        sr = master.sample_rate
        out = np.zeros((2, int(round((end - start) * sr))), np.float32)
        at = int((drop_start_s - start) * sr)
        piece = drop[:, : max(0, out.shape[-1] - at)]
        out[:, at:at + piece.shape[-1]] += 0.5 * piece[: 2]
        return MixOutput(audio=out, sample_rate=sr, start_s=start, drop_start_s=drop_start_s - start,
                         warnings=["stub mix"])


@pytest.fixture
def song_fx(monkeypatch):
    stub = SongFx()
    monkeypatch.setattr(fx_api, "analyze_song", stub.analyze_song, raising=False)
    return stub


def wait_song(client, song_id, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        song = ok(client.get(f"/api/songs/{song_id}"))
        if song["analysis_state"] not in ("queued", "running"):
            return song
        time.sleep(0.02)
    raise AssertionError(f"song {song_id} was not analysed")


def test_songs_import_analyse_patch_delete(client, song_fx, tmp_path, monkeypatch):
    song = ok(upload_song(client))
    assert (song["name"], song["sample_rate"], song["channels"], song["duration_s"]) == ("song-1", 44100, 2, 20.0)
    assert song["peaks"]["buckets"] > 0 and song["analysis_state"] in ("queued", "running", "done")
    song = wait_song(client, song["id"])
    assert song["analysis_state"] == "done" and song["analysis"]["bpm"] == 120 and song["analysis"]["key"] == "Am"
    assert song_fx.analysed == [((2, 20 * SONG_SR), np.float32, SONG_SR)]  # (channels, n) at the file's own rate
    assert [p.name for p in (tmp_path / "data" / "songs").glob("sng_*")] == [f"{song['audio_id']}.flac"]
    stream = client.get(f"/api/audio/{song['audio_id']}")
    assert stream.status_code == 200 and sf.info(io.BytesIO(stream.content)).duration == pytest.approx(20.0)
    assert ok(upload_song(client, filename="again.wav"))["id"] == song["id"]  # the same audio is the same song
    assert [s["id"] for s in ok(client.get("/api/songs"))] == [song["id"]]
    assert ok(upload_song(client, name="Opener"))["name"] == "song-1"

    patched = ok(client.patch(f"/api/songs/{song['id']}", json={"bpm_override": 125, "key_override": "f# minor"}))
    assert (patched["bpm_override"], patched["key_override"], patched["name"]) == (125, "F#m", "song-1")
    patched = ok(client.patch(f"/api/songs/{song['id']}", json={"name": "Opener"}))  # absent fields stay
    assert (patched["name"], patched["bpm_override"], patched["key_override"]) == ("Opener", 125, "F#m")
    patched = ok(client.patch(f"/api/songs/{song['id']}", json={"bpm_override": None, "downbeat_override_s": 0.25}))
    assert (patched["bpm_override"], patched["downbeat_override_s"], patched["key_override"]) == (None, 0.25, "F#m")
    assert patched["analysis"]["bpm"] == 120  # overrides never touch the analysis
    bad = client.patch(f"/api/songs/{song['id']}", json={"key_override": "H#"})
    assert bad.status_code == 422
    assert client.patch(f"/api/songs/{song['id']}", json={"downbeat_override_s": 99}).status_code == 422

    for data, code in ((b"", "unsupported_format"), (b"not audio at all", "unsupported_format")):
        res = upload_song(client, data)
        assert res.status_code == 400 and res.json()["error"]["code"] == code
    monkeypatch.setattr("fvwks_server.service.MAX_SONG_S", 10)
    res = upload_song(client, song_bytes(seconds=11))
    assert res.status_code == 400 and res.json()["error"]["code"] == "song_too_long"

    ok(client.delete(f"/api/songs/{song['id']}"), 204)
    assert client.get(f"/api/songs/{song['id']}").status_code == 404
    assert client.get(f"/api/audio/{song['audio_id']}").status_code == 404
    assert client.delete(f"/api/songs/{song['id']}").status_code == 404


def test_unfinished_song_analysis_resumes_after_a_restart(tmp_path, song_fx):
    first = make_client(tmp_path)
    song = wait_song(first, ok(upload_song(first))["id"])
    first.app.state.service.library.update("songs", song["id"], analysis_state="running")  # killed mid-analysis
    second = make_client(tmp_path)
    assert wait_song(second, song["id"])["analysis_state"] == "done" and len(song_fx.analysed) == 2


@pytest.fixture
def separator(monkeypatch):
    """A stand-in for S1's separate_stems (htdemucs): four scaled copies of the song, same length."""
    calls = []

    def separate_stems(audio, sr, progress):
        calls.append((audio.shape, sr))
        progress(0.5, "halfway")
        return {name: (audio * g).astype(np.float32) for name, g in
                (("drums", 0.5), ("bass", 0.3), ("vocals", 0.2), ("other", 0.1))}

    monkeypatch.setattr(voice_api, "separate_stems", separate_stems, raising=False)
    return calls


def test_song_stems_job_features_and_cache(client, song_fx, separator):
    song = wait_song(client, ok(upload_song(client))["id"])
    job = wait_job(client, ok(client.post(f"/api/songs/{song['id']}/stems"))["id"])
    assert job["kind"] == "song_stems" and job["state"] == "done", job
    song = ok(client.get(f"/api/songs/{song['id']}"))
    assert song["stems_state"] == "done" and [s["name"] for s in song["stems"]] == ["drums", "bass", "vocals", "other"]
    assert client.get(f"/api/audio/{song['stems'][0]['audio_id']}").status_code == 200
    feats = ok(client.get(f"/api/songs/{song['id']}/stems/features"))
    assert feats["tracks"] == ["drums", "bass", "vocals", "other", "mix"] and feats["fps"] == 60
    assert feats["frames"] == pytest.approx(20 * 60, abs=2)
    assert len(base64.b64decode(feats["data_b64"])) == feats["frames"] * 5 * 2
    if feats["bass_b64"]:  # v0.10.1, when fx computes the bass lane
        assert len(base64.b64decode(feats["bass_b64"])) == feats["frames"] * 4
    again = ok(client.post(f"/api/songs/{song['id']}/stems"))
    assert again["state"] == "done" and len(separator) == 1  # cached: separated once
    ok(client.delete(f"/api/songs/{song['id']}"), 204)
    assert client.get(f"/api/audio/{song['stems'][0]['audio_id']}").status_code == 404


def test_stems_answer_501_without_the_separator_and_409_before_they_exist(client, song_fx, monkeypatch):
    monkeypatch.delattr(voice_api, "separate_stems", raising=False)
    song = ok(upload_song(client))
    res = client.post(f"/api/songs/{song['id']}/stems")
    assert res.status_code == 501 and res.json()["error"]["code"] == "not_implemented"
    res = client.get(f"/api/songs/{song['id']}/stems/features")
    assert res.status_code == 409 and res.json()["error"]["code"] == "stems_not_ready"


def test_stems_job_error_names_the_missing_model(client, song_fx, monkeypatch):
    """Found by the packaged 1.4.0 check: the song_stems job's model_not_installed lost its model_id."""
    class ModelMissing(Exception):
        code, status, hint, retryable, model_id = "model_not_installed", 503, "Install it.", False, "stems-htdemucs"

    def separate_stems(audio, sr, progress):
        raise ModelMissing("The stem splitter isn't installed.")

    monkeypatch.setattr(voice_api, "separate_stems", separate_stems, raising=False)
    song = ok(upload_song(client))
    job = wait_job(client, ok(client.post(f"/api/songs/{song['id']}/stems"))["id"])
    assert job["state"] == "error" and job["error"]["code"] == "model_not_installed"
    assert job["error"]["model_id"] == "stems-htdemucs"


@pytest.fixture
def structurer(monkeypatch):
    """A stand-in for S2's song_structure: one intro and one drop at bar 5, refined (from_stems) when given stems."""
    from fvwks_contracts.models import SongSection, SongStructure
    calls = []

    def song_structure(audio, sr, analysis, *, stems=None):
        calls.append((analysis.bpm, sorted(stems or {})))
        drop = analysis.downbeat_s + 4 * analysis.beats_per_bar * 60.0 / analysis.bpm
        end = audio.shape[-1] / sr
        return SongStructure(sections=[SongSection(kind="intro", start_s=0.0, end_s=drop, start_bar=1, energy=0.3),
                                       SongSection(kind="drop", start_s=drop, end_s=end, start_bar=5, energy=1.0)],
                             drops_s=[drop], from_stems=bool(stems))

    monkeypatch.setattr(fx_api, "song_structure", song_structure, raising=False)
    return calls


def test_song_structure_after_analysis_then_refined_with_stems(client, song_fx, structurer, separator):
    song = wait_song(client, ok(upload_song(client))["id"])
    assert song["structure"]["drops_s"] == [pytest.approx(8.5)] and song["structure"]["from_stems"] is False
    wait_job(client, ok(client.post(f"/api/songs/{song['id']}/stems"))["id"])
    song = ok(client.get(f"/api/songs/{song['id']}"))
    assert song["structure"]["from_stems"] is True and structurer[-1][1] == ["bass", "drums", "other", "vocals"]
    ok(client.patch(f"/api/songs/{song['id']}", json={"bpm_override": 60.0}))  # a new grid: structured again
    deadline = time.time() + 10
    while ok(client.get(f"/api/songs/{song['id']}"))["structure"]["drops_s"] != [pytest.approx(16.5)]:
        assert time.time() < deadline, structurer
        time.sleep(0.02)
