"""Model catalog and installer. No real downloads: the child process is replaced by small scripts."""

import errno
import sys
import time
from collections import namedtuple

import pytest

from fvwks_voice import api, models
from fvwks_voice.errors import VoiceError

FAKE = models.ModelSpec("fake-model", "Fake", "qwen3", False, "Apache-2.0", "test",
                        (models.Repo("nobody/fake", "0" * 40, 1_000_000, ("config.json",)),))


@pytest.fixture
def fake_download(monkeypatch):
    """Point the installer at FAKE, with a scripted child and a byte counter that grows while it runs."""
    counter = {"n": 0}

    def fake_bytes(repo):
        counter["n"] += 250_000
        return min(counter["n"], repo.size_bytes)

    monkeypatch.setattr(models, "repo_dir", lambda repo: None)
    monkeypatch.setattr(models, "_repo_bytes", fake_bytes)

    def use(script: str) -> None:
        monkeypatch.setattr(models, "_DOWNLOAD", script)

    return use


def test_catalog_matches_the_server_and_app_ids():
    got = {m.id: m for m in api.list_models()}
    assert set(got) == {"kokoro-82m", "deepfilternet3", "qwen3-tts-voicedesign", "whisper-aligner", "stems-htdemucs"}
    assert got["deepfilternet3"].required and got["deepfilternet3"].license == "MIT"
    assert not got["whisper-aligner"].required and got["whisper-aligner"].engine == "asr"
    assert got["whisper-aligner"].size_bytes == 1_613_979_758 + 4_618_475 + 1_276_475_979
    assert got["kokoro-82m"].required and got["kokoro-82m"].engine == "kokoro"
    q = got["qwen3-tts-voicedesign"]
    assert q.engine == "qwen3" and not q.required and q.license == "Apache-2.0"
    assert q.size_bytes == 4_520_194_992 + 4_544_212_739  # both pinned repos


def test_kokoro_is_reported_installed_here():
    assert next(m for m in api.list_models() if m.id == "kokoro-82m").installed


def test_unknown_model():
    with pytest.raises(VoiceError) as e:
        api.install_model("nope", lambda f, m: None)
    assert e.value.code == "not_found" and e.value.status == 404


def test_installed_model_returns_at_once(monkeypatch):
    monkeypatch.setattr(models, "repo_dir", lambda repo: "/somewhere")
    calls = []
    models.install(FAKE, lambda f, m: calls.append(f))
    assert calls == [1.0]


def test_cancel_stops_the_download_and_propagates(fake_download):
    fake_download("import time\ntime.sleep(60)\n")

    class Cancelled(Exception):
        pass

    seen = []

    def progress(fraction, message):
        seen.append((fraction, message))
        if len(seen) == 3:
            raise Cancelled()

    t0 = time.monotonic()
    with pytest.raises(Cancelled):
        models.install(FAKE, progress, poll_s=0.05)
    assert time.monotonic() - t0 < 15  # the 60 s child was terminated, not waited for
    fractions = [f for f, _ in seen]
    assert fractions == sorted(fractions) and 0 < fractions[-1] < 1
    assert "Downloading Fake" in seen[0][1]


def test_failed_download_is_an_install_error(fake_download):
    fake_download("import sys\nprint('HTTP 404 for nobody/fake', file=sys.stderr)\nsys.exit(1)\n")
    with pytest.raises(VoiceError) as e:
        models.install(FAKE, None, poll_s=0.05)
    assert e.value.code == "install_failed" and "HTTP 404" in e.value.message


def test_full_disk_during_download_is_enospc(fake_download):
    fake_download("import sys\nprint('OSError: [Errno 28] No space left on device', file=sys.stderr)\nsys.exit(1)\n")
    with pytest.raises(OSError) as e:
        models.install(FAKE, None, poll_s=0.05)
    assert e.value.errno == errno.ENOSPC


def test_disk_check_before_download(fake_download, monkeypatch):
    Usage = namedtuple("Usage", "total used free")
    monkeypatch.setattr(models.shutil, "disk_usage", lambda p: Usage(10**12, 10**12, 2_000_000_000))
    with pytest.raises(VoiceError) as e:
        models.install(FAKE, None)
    assert e.value.code == "disk_full" and e.value.status == 507


# -- v0.4–v0.6: installer fields, byte progress, manifest pins, uninstall ------------------------------
NEW_SHA = "1" * 40


@pytest.fixture
def pins(tmp_path):
    """A fresh pins file for the test; the engine's own pins come back afterwards."""
    saved = (dict(models._pins), models._pins_path)
    models.configure(tmp_path)
    yield tmp_path
    models._pins.clear()
    models._pins.update(saved[0])
    models._pins_path = saved[1]


def manifest(models_: dict, published: str = "2026-10-01"):
    from fvwks_contracts.models import ModelManifest

    return ModelManifest.model_validate({"published": published, "models": models_})


def kokoro_update(revision: str = NEW_SHA, version: str = "1.1") -> dict:
    return {"kokoro-82m": {"version": version, "notes": "Clearer consonants.",
                           "repos": [{"repo_id": models.KOKORO_REPO.repo_id, "revision": revision,
                                      "size_bytes": 360_000_000}]}}


def only_builtin_installed(repo):
    """The cache has this build's pins complete, and nothing of any newer revision."""
    builtin = {r.revision for s in models.MODELS.values() for r in s.repos}
    return "/cache/snapshot" if repo.revision in builtin else None


def test_installer_fields_when_installed_and_missing(monkeypatch):
    monkeypatch.setattr(models, "repo_dir", lambda repo: "/cache/snapshot")
    info = {m.id: m for m in api.list_models()}
    k = info["kokoro-82m"]
    assert (k.version, k.installed_version, k.update_available, k.install_needs_bytes) == ("1.0", "1.0", False, None)
    assert k.default_selected and not info["whisper-aligner"].default_selected
    # Not installed: what is left to download (a resumed download counts what is already there) plus the reserve.
    monkeypatch.setattr(models, "repo_dir", lambda repo: None)
    monkeypatch.setattr(models, "_repo_bytes", lambda repo: 100_000_000 if repo is models.WHISPER_REPO else 0)
    asr = next(m for m in api.list_models() if m.id == "whisper-aligner")
    assert not asr.installed and asr.installed_version is None and not asr.update_available
    assert asr.install_needs_bytes == models.ASR.size_bytes - 100_000_000 + models.DISK_RESERVE


def test_progress_reports_bytes_to_a_callback_that_takes_them(fake_download):
    fake_download("import time\ntime.sleep(0.4)\n")
    seen = []

    def progress(fraction=None, message=None, /, **info):
        seen.append((fraction, info))

    with pytest.raises(VoiceError):  # the scripted child downloads nothing, so the files are still missing
        models.install(FAKE, progress, poll_s=0.05)
    running = [info for f, info in seen if f is not None and f < 1]
    assert running and all(i["bytes_total"] == FAKE.size_bytes and i["current_item"] == "nobody/fake" for i in running)
    done = [i["bytes_done"] for i in running]
    assert done == sorted(done) and 0 < done[-1] <= FAKE.size_bytes


def test_disk_space_is_measured_where_the_cache_will_be(tmp_path, monkeypatch):
    fresh = tmp_path / "data" / "models" / "hub"  # a fresh Mac: HF_HOME doesn't exist yet
    Usage = namedtuple("Usage", "total used free")
    asked = []
    monkeypatch.setattr(models.shutil, "disk_usage", lambda p: asked.append(p) or Usage(1, 1, 123))
    assert models._disk_free(fresh) == 123
    assert asked == [tmp_path]


def test_manifest_moves_pins_and_the_old_version_stays_in_use(pins, monkeypatch):
    monkeypatch.setattr(models, "repo_dir", only_builtin_installed)
    monkeypatch.setattr(models, "_repo_bytes", lambda repo: 0)
    assert models.apply_manifest(manifest({**kokoro_update(), "future-model": {
        "version": "9", "repos": [{"repo_id": "x/y", "revision": NEW_SHA, "size_bytes": 1}]}})) == ["kokoro-82m"]
    k = models.model_info(models.KOKORO)
    assert (k.version, k.installed_version, k.update_available) == ("1.1", "1.0", True)
    assert k.installed and k.install_needs_bytes == 360_000_000 + models.DISK_RESERVE and k.size_bytes == 360_000_000
    # Until the update is complete, the loaders keep the installed revision.
    assert models.active(models.KOKORO) is models.KOKORO
    assert models.target(models.KOKORO).repos[0].revision == NEW_SHA
    # Once it's all on disk, it is the one in use.
    monkeypatch.setattr(models, "repo_dir", lambda repo: "/cache/snapshot")
    assert models.active(models.KOKORO).version == "1.1"
    assert not models.model_info(models.KOKORO).update_available
    # The pins survive a restart, and a later manifest that doesn't move kokoro puts it back on this build's pins.
    models.configure(pins)
    assert models.target(models.KOKORO).version == "1.1"
    models.apply_manifest(manifest({}))
    assert models.target(models.KOKORO) is models.KOKORO
    models.configure(pins)
    assert models.target(models.KOKORO) is models.KOKORO


def test_manifest_may_only_move_revisions(pins):
    bad_repo = {"kokoro-82m": {"version": "2", "repos": [{"repo_id": "someone/else", "revision": NEW_SHA,
                                                          "size_bytes": 1}]}}
    for m in (bad_repo, kokoro_update(revision="main"), kokoro_update(version=" ")):
        with pytest.raises(VoiceError) as e:
            models.apply_manifest(manifest(m))
        assert e.value.code == "manifest_rejected" and e.value.status == 422
    assert models.target(models.KOKORO) is models.KOKORO
    # Pins equal to this build's are no move at all.
    same = kokoro_update(revision=models.KOKORO_REPO.revision)
    assert models.apply_manifest(manifest(same)) == []


class FakeHub:
    """HfApi.model_info() answers: license and file names per (repo, revision)."""

    def __init__(self, revisions: dict):
        self.revisions = revisions

    def model_info(self, repo_id, revision):
        lic, files = self.revisions[(repo_id, revision)]
        card = {"license": lic} if lic else None
        return namedtuple("Info", "card_data tags siblings")(
            card, [], [namedtuple("Sibling", "rfilename")(f) for f in files])


def test_an_update_keeps_file_names_and_license():
    old = models.KOKORO
    new = models._pinned(manifest(kokoro_update()))["kokoro-82m"]
    files = ["config.json", "kokoro-v1_0.safetensors", "voices/am_fenrir.safetensors", "voices/bm_george.safetensors",
             "README.md"]
    key_old, key_new = (old.repos[0].repo_id, old.repos[0].revision), (new.repos[0].repo_id, NEW_SHA)
    models.check_update(old, new, FakeHub({key_old: ("apache-2.0", files), key_new: ("apache-2.0", files[:-1] + ["x"])}))
    for changed in (("mit", files), ("apache-2.0", files[:2] + files[3:])):
        with pytest.raises(VoiceError) as e:
            models.check_update(old, new, FakeHub({key_old: ("apache-2.0", files), key_new: changed}))
        assert e.value.code == "update_rejected" and e.value.status == 409


def test_install_of_an_update_checks_it_first(pins, monkeypatch):
    monkeypatch.setattr(models, "repo_dir", only_builtin_installed)
    models.apply_manifest(manifest(kokoro_update()))
    checked = []

    def reject(base, new, hub=None):
        checked.append(new.version)
        raise VoiceError("update_rejected", "The update drops a file.", status=409)

    monkeypatch.setattr(models, "check_update", reject)
    with pytest.raises(VoiceError) as e:
        models.install(models.KOKORO, None)
    assert e.value.code == "update_rejected" and checked == ["1.1"]


def _fake_cache(root, repo_id, revision, *, incomplete=False):
    repo = root / f"models--{repo_id.replace('/', '--')}"
    (repo / "blobs").mkdir(parents=True)
    (repo / "blobs" / "abc123").write_bytes(b"x" * 10)
    if incomplete:
        (repo / "blobs" / "def456.incomplete").write_bytes(b"x" * 5)
    snap = repo / "snapshots" / revision
    snap.mkdir(parents=True)
    (snap / "config.json").symlink_to("../../blobs/abc123")
    (repo / "refs").mkdir()
    (repo / "refs" / "main").write_text(revision)
    return repo


def test_uninstall_removes_every_cached_revision(tmp_path, monkeypatch):
    from huggingface_hub import constants

    monkeypatch.setattr(constants, "HF_HUB_CACHE", str(tmp_path))
    repo = _fake_cache(tmp_path, "nobody/fake", FAKE.repos[0].revision, incomplete=True)
    other = _fake_cache(tmp_path, "someone/else", "2" * 40)
    assert models.repo_dir(FAKE.repos[0]) is not None
    models.uninstall(FAKE)
    assert not repo.exists() or not any((repo / "blobs").iterdir())
    assert models.repo_dir(FAKE.repos[0]) is None
    assert other.exists()  # other models' files stay


def test_uninstall_refusals(monkeypatch):
    with pytest.raises(VoiceError) as e:
        api.uninstall_model("kokoro-82m")
    assert (e.value.code, e.value.status) == ("model_required", 409)
    with pytest.raises(VoiceError) as e:
        api.uninstall_model("nope")
    assert e.value.status == 404

    class Busy:
        def try_unload(self):
            return False

    monkeypatch.setattr(api, "get_qwen3", lambda: Busy())
    with pytest.raises(VoiceError) as e:
        api.uninstall_model("qwen3-tts-voicedesign")
    assert (e.value.code, e.value.status) == ("model_busy", 409)
    monkeypatch.setattr(models, "_installing", {"whisper-aligner"})
    monkeypatch.setattr(api, "get_transcriber", lambda: type("Idle", (), {"try_unload": lambda self: True})())
    with pytest.raises(VoiceError) as e:
        api.uninstall_model("whisper-aligner")
    assert (e.value.code, e.value.status) == ("model_busy", 409)


def test_model_not_installed_names_the_model():
    err = VoiceError("model_not_installed", "Recording transcription isn't installed.", status=503,
                     model_id="whisper-aligner")
    assert err.to_dict()["error"]["model_id"] == "whisper-aligner"
    assert "model_id" not in VoiceError("tts_failed", "x").to_dict()["error"]


def test_kokoro_loads_from_a_pinned_download_without_refs_main(tmp_path, monkeypatch):
    """A fresh Mac's cache: the installer fetched the pinned revision, which writes no refs/main (S3's DMG repro)."""
    from huggingface_hub import constants

    from fvwks_voice.tts_kokoro import WEIGHTS_FILE, KokoroEngine

    monkeypatch.setattr(constants, "HF_HUB_CACHE", str(tmp_path))
    snap = tmp_path / "models--mlx-community--Kokoro-82M-bf16" / "snapshots" / models.KOKORO_REPO.revision
    for name in (*models.KOKORO_REPO.required_files, WEIGHTS_FILE):
        (snap / name).parent.mkdir(parents=True, exist_ok=True)
        (snap / name).write_bytes(b"x")
    assert not (snap.parent.parent / "refs").exists()
    engine = KokoroEngine()
    assert engine.model_dir() == snap and engine.is_installed("am_fenrir")
    assert next(m for m in api.list_models() if m.id == "kokoro-82m").installed


@pytest.mark.skipif(sys.platform != "darwin", reason="APFS clones")
def test_reuses_a_complete_copy_already_on_this_mac(tmp_path, monkeypatch):
    from huggingface_hub import constants

    ours, other = tmp_path / "ours", tmp_path / "other"
    ours.mkdir()
    monkeypatch.setattr(constants, "HF_HUB_CACHE", str(ours))
    monkeypatch.setattr(models, "_other_caches", lambda: [other])
    rev = "a" * 40
    repo = models.Repo("org/tiny", rev, 11, ("config.json", "w/model.bin"))
    spec = models.ModelSpec("tiny", "Tiny", "kokoro", False, "MIT", "", (repo,))
    # Another cache holds the pinned snapshot in the hub's layout: blobs, and the snapshot's links to them.
    blobs = other / "models--org--tiny" / "blobs"
    snap = other / "models--org--tiny" / "snapshots" / rev
    blobs.mkdir(parents=True)
    (snap / "w").mkdir(parents=True)
    (blobs / "h1").write_bytes(b"{}{}{}")
    (blobs / "h2").write_bytes(b"1234")  # short: the sizes don't add up to the pin
    (snap / "config.json").symlink_to("../../blobs/h1")
    (snap / "w" / "model.bin").symlink_to("../../../blobs/h2")
    assert models.repo_dir(repo) is None  # not trusted: it downloads as before
    (blobs / "h2").write_bytes(b"12345")

    said = []
    models.install(spec, lambda fraction, message: said.append(message))
    assert said == ["Found Tiny on this Mac."]  # cloned, nothing downloaded
    found = models.repo_dir(repo)
    assert found == ours / "models--org--tiny" / "snapshots" / rev
    assert (found / "w" / "model.bin").read_bytes() == b"12345"
    assert (found / "config.json").is_symlink() and (ours / "models--org--tiny" / "blobs" / "h1").is_file()
