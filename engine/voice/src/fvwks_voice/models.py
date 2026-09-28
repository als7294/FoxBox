"""Installable voice models: what's on disk, how big it is, and how to fetch, update or remove it.

- kokoro-82m (required): Kokoro-82M on MLX, the config, weights and the 28 English voices.
- deepfilternet3 (required, 8.7 MB): denoises recordings at ingest.
- whisper-aligner (opt-in): word timings for recordings (Whisper large-v3-turbo + Qwen3-ForcedAligner).
- qwen3-tts-voicedesign (opt-in): the persona designer. It is two repos installed together: VoiceDesign 1.7B
  (describe a voice) and Base 1.7B (clone the chosen candidate for every line). The id matches the server's
  fallback list and the app's VOICES screen, which gates the designer on the first `engine == "qwen3"` model.
- stems-htdemucs (opt-in, 84 MB): splits a song into drums, bass, vocals and other for the visuals (v0.9).

Revisions are pinned, so an install is reproducible and ENGINE_VERSION means something. A pinned snapshot that is
already complete elsewhere on this Mac (the standard Hugging Face cache, another FoxBox data dir) is cloned into ours
(APFS clones: instant, no extra disk) instead of downloaded again.
Downloads run in a child process: a cancel really stops the transfer (a thread can't be killed), and the
partial files stay in the Hugging Face cache, so the next install resumes where it stopped.

Updates (v0.6, S3 P9): a signed model manifest, verified by the server, can move a model's pins to newer
revisions of the same repos. The pins are kept in <data>/voice/model_pins.json. A model keeps loading its
installed revision until the new one is completely downloaded; the loaders then use the new one from their next
load. Before it downloads an update, install() checks with the Hub that every file of the current revision is
still there under the same name, and that the license is unchanged. Anything else needs a new engine build.
"""

from __future__ import annotations

import errno
import inspect
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, replace
from fnmatch import fnmatch
from pathlib import Path
from typing import Any, Callable

from fvwks_contracts.models import ModelInfo, ModelManifest

from .errors import VoiceError

DISK_RESERVE = 5_000_000_000  # must stay free after a download
BUILTIN_VERSION = "1.0"  # the pins this engine build ships with
# progress(fraction, message, *, bytes_done, bytes_total, current_item): the keywords go only to a callback
# that takes **kwargs (the server's does since v0.4).
Progress = Callable[..., None]
_SHA_RE = re.compile(r"[0-9a-f]{40}")


@dataclass(frozen=True)
class Repo:
    repo_id: str
    revision: str
    size_bytes: int
    required_files: tuple[str, ...]
    allow_patterns: tuple[str, ...] | None = None


@dataclass(frozen=True)
class ModelSpec:
    id: str
    name: str
    engine: str
    required: bool
    license: str
    description: str
    repos: tuple[Repo, ...]
    version: str = BUILTIN_VERSION

    @property
    def size_bytes(self) -> int:
        return sum(r.size_bytes for r in self.repos)


KOKORO_REPO = Repo(
    "mlx-community/Kokoro-82M-bf16", "a71e4d38b236d968966a2002c4c895dbd12b1c3c", 341_742_463,
    ("config.json", "kokoro-v1_0.safetensors", "voices/am_fenrir.safetensors", "voices/bm_george.safetensors"),
    ("config.json", "kokoro-v1_0.safetensors", "voices/a*.safetensors", "voices/b*.safetensors"))
QWEN3_FILES = ("config.json", "model.safetensors", "speech_tokenizer/model.safetensors")
QWEN3_DESIGN_REPO = Repo("mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16",
                         "7d3824abff87e49756bb0f83fb5411de75d160c4", 4_520_194_992, QWEN3_FILES)
QWEN3_BASE_REPO = Repo("mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16",
                       "a6eb4f68e4b056f1215157bb696209bc82a6db48", 4_544_212_739, QWEN3_FILES)

KOKORO = ModelSpec(
    "kokoro-82m", "Kokoro 82M", "kokoro", True, "Apache-2.0",
    "Default fast TTS on the Apple GPU: 28 English voices.", (KOKORO_REPO,))
QWEN3 = ModelSpec(
    "qwen3-tts-voicedesign", "Qwen3-TTS persona designer", "qwen3", False, "Apache-2.0",
    "Describe a voice and get 3 candidates (VoiceDesign 1.7B); the one you save speaks every line "
    "(Base 1.7B voice clone).", (QWEN3_DESIGN_REPO, QWEN3_BASE_REPO))
DF3_REPO = Repo("mlx-community/DeepFilterNet-mlx", "220d5dfb7266352272d74c2a7d2025c59e07b391", 8_683_690,
                ("v3/config.json", "v3/model.safetensors"), ("v3/*",))
DENOISE = ModelSpec(
    "deepfilternet3", "DeepFilterNet3 denoiser", "denoise", True, "MIT",
    "Cleans recordings before the mask: room noise, hum and hiss. 8.7 MB.", (DF3_REPO,))
WHISPER_REPO = Repo("mlx-community/whisper-large-v3-turbo", "a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb",
                    1_613_979_758, ("config.json", "weights.safetensors"))
# The MLX conversion ships no tokenizer; Whisper's own (MIT) is loaded next to it.
WHISPER_TOKENIZER_REPO = Repo("openai/whisper-large-v3-turbo", "41f01f3fe87f28c78e2fbf8b568835947dd65ed9",
                              4_618_475, ("tokenizer.json", "preprocessor_config.json", "tokenizer_config.json",
                                          "vocab.json", "merges.txt"), ("*.json", "*.txt"))
ALIGNER_REPO = Repo("mlx-community/Qwen3-ForcedAligner-0.6B-8bit", "0e1a68e91d815300c7c9754b2a7639378b23db15",
                    1_276_475_979, ("config.json", "model.safetensors"))
ASR = ModelSpec(
    "whisper-aligner", "Recording transcription", "asr", False, "MIT (Whisper) + Apache-2.0 (Qwen3-ForcedAligner)",
    "Transcribes recordings (Whisper large-v3-turbo) and places every word (Qwen3-ForcedAligner), so throws "
    "hit exact words and the transcript can be edited.", (WHISPER_REPO, WHISPER_TOKENIZER_REPO, ALIGNER_REPO))
# Meta's HT-Demucs, converted to MLX (fp16) from the official checkpoint; only the one model of the repo's eight.
STEMS_FILES = ("htdemucs_config.json", "htdemucs.safetensors")
STEMS_REPO = Repo("mlx-community/demucs-mlx-fp16", "908d2d05cf3035bf4017fc0f52be64163689a61f", 84_038_036,
                  STEMS_FILES, STEMS_FILES)
STEMS = ModelSpec(
    "stems-htdemucs", "HT-Demucs stem splitter", "stems", False, "MIT",
    "Splits a song into drums, bass, vocals and other, so the visuals can follow each one. 84 MB.", (STEMS_REPO,))
MODELS: dict[str, ModelSpec] = {m.id: m for m in (KOKORO, DENOISE, QWEN3, ASR, STEMS)}

_lock = threading.RLock()
_pins: dict[str, ModelSpec] = {}  # model id -> the spec a manifest moved it to
_pins_path: Path | None = None
_installing: set[str] = set()


def _cache_root() -> Path:
    from huggingface_hub import constants

    return Path(constants.HF_HUB_CACHE)


def _cached_dir(repo: Repo) -> Path | None:
    from huggingface_hub import try_to_load_from_cache

    found = [try_to_load_from_cache(repo.repo_id, f, revision=repo.revision) for f in repo.required_files]
    if not all(isinstance(p, str) and Path(p).exists() for p in found):
        return None
    return Path(found[0]).parent


def repo_dir(repo: Repo) -> Path | None:
    """The folder holding the first required file (usually the snapshot root) when every required file is cached
    (no network). A complete copy elsewhere on this Mac is cloned in first (see _adopt)."""
    found = _cached_dir(repo)
    if found is None and _adopt(repo):
        found = _cached_dir(repo)
    return found


# -- reuse what this Mac already has (1.1.1) ------------------------------------------------------------
def _other_caches() -> list[Path]:
    """Hugging Face hub caches on this Mac besides ours: the standard one (and $HF_HUB_CACHE / $HF_HOME) and the
    other FoxBox data dirs' (<data>/models/hub)."""
    home = Path.home()
    places = [Path(p) for p in (os.environ.get("HF_HUB_CACHE"),) if p]
    if os.environ.get("HF_HOME"):
        places.append(Path(os.environ["HF_HOME"]) / "hub")
    places.append(home / ".cache" / "huggingface" / "hub")
    places += sorted((home / "Library" / "Application Support").glob("FoxBox*/models/hub"))
    ours = _cache_root().resolve()
    out: list[Path] = []
    for p in places:
        try:
            p = p.resolve()
        except OSError:
            continue
        if p != ours and p.is_dir() and p not in out:
            out.append(p)
    return out


def _complete_snapshot(cache: Path, repo: Repo) -> dict[str, Path] | None:
    """The pinned snapshot's files in `cache` (path in the repo → file) when it is complete: every required file is
    there, and the files the install would download add up to exactly the pinned size."""
    snap = cache / f"models--{repo.repo_id.replace('/', '--')}" / "snapshots" / repo.revision
    if not snap.is_dir():
        return None
    files: dict[str, Path] = {}
    total = 0
    try:
        for p in snap.rglob("*"):
            name = p.relative_to(snap).as_posix()
            if not p.is_file() or (repo.allow_patterns and not any(fnmatch(name, pat) for pat in repo.allow_patterns)):
                continue  # folders, broken links (a blob that never finished), files the install doesn't fetch
            total += p.stat().st_size
            files[name] = p
    except OSError:
        return None
    if total != repo.size_bytes or not all(f in files for f in repo.required_files):
        return None
    return files


def _clone(src: Path, dst: Path) -> None:
    """An APFS clone: nothing is copied and no disk is used until one side changes. Raises where it can't clone
    (another volume, another file system)."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["cp", "-c", str(src), str(dst)], check=True, capture_output=True)


def _adopt(repo: Repo) -> bool:
    """Clone a complete copy of the pinned snapshot from another cache on this Mac into ours, in the hub's layout
    (blobs, and the snapshot's links to them), so the pinned revision resolves without a download. False, leaving
    nothing behind, when there is no complete copy or it can't be cloned (then it downloads as before)."""
    if sys.platform != "darwin":
        return False
    with _lock:
        for other in _other_caches():
            files = _complete_snapshot(other, repo)
            if files is None:
                continue
            ours = _cache_root() / f"models--{repo.repo_id.replace('/', '--')}"
            snap = ours / "snapshots" / repo.revision
            made: list[Path] = []
            try:
                for name, src in files.items():
                    dst = snap / name
                    if dst.exists():
                        continue
                    if dst.is_symlink():
                        dst.unlink()  # a link to a blob that never finished
                    real = src.resolve()
                    if src.is_symlink() and real.parent.name == "blobs":
                        blob = ours / "blobs" / real.name
                        if not blob.exists():
                            _clone(real, blob)
                            made.append(blob)
                        dst.parent.mkdir(parents=True, exist_ok=True)
                        dst.symlink_to(os.path.relpath(blob, dst.parent))
                    else:
                        _clone(real, dst)
                    made.append(dst)
                return True
            except (OSError, subprocess.CalledProcessError):
                for p in reversed(made):
                    p.unlink(missing_ok=True)
    return False


# -- which revision is in use ---------------------------------------------------------------------
def target(spec: ModelSpec) -> ModelSpec:
    """What an install fetches: the manifest's pins when one moved them, else this build's own."""
    return _pins.get(spec.id, spec)


def active(spec: ModelSpec) -> ModelSpec | None:
    """The newest completely installed version: the manifest's once it's all on disk, else this build's own."""
    base = MODELS.get(spec.id, spec)
    for s in dict.fromkeys((target(spec), base)):
        if all(repo_dir(r) is not None for r in s.repos):
            return s
    return None


def is_installed(spec: ModelSpec) -> bool:
    return active(spec) is not None


def repo_path(spec: ModelSpec, repo: Repo) -> Path | None:
    """Where the loaders find `repo` (matched by repo id) in the version in use, or None if it isn't installed."""
    s = active(spec)
    r = next((x for x in s.repos if x.repo_id == repo.repo_id), None) if s else None
    return repo_dir(r) if r else None


def _repo_bytes(repo: Repo) -> int:
    """Bytes of the pinned snapshot already on disk, counting partial downloads."""
    root = _cache_root() / f"models--{repo.repo_id.replace('/', '--')}"
    total = sum(p.stat().st_size for p in (root / "blobs").glob("*.incomplete")) if (root / "blobs").exists() else 0
    snap = root / "snapshots" / repo.revision
    if snap.exists():
        total += sum(p.stat().st_size for p in snap.rglob("*") if p.is_file())
    return total


def _left_bytes(spec: ModelSpec) -> int:
    return sum(max(0, r.size_bytes - _repo_bytes(r)) for r in spec.repos if repo_dir(r) is None)


def model_info(spec: ModelSpec) -> ModelInfo:
    new, used = target(spec), active(spec)
    return ModelInfo(
        id=spec.id, name=spec.name, engine=spec.engine, size_bytes=new.size_bytes, installed=used is not None,
        required=spec.required, license=spec.license, description=spec.description,
        version=new.version, installed_version=used.version if used else None,
        update_available=used is not None and used != new,
        # The installer pre-ticks what ships by default; the opt-ins stay unticked.
        default_selected=spec.required,
        # What the install (or update) still downloads, a resumed one counting what's already there, plus the reserve.
        install_needs_bytes=None if used == new else _left_bytes(new) + DISK_RESERVE,
    )


def _disk_free(path: Path) -> int:
    """Free space where `path` is, or would be (a fresh Mac has no model cache yet)."""
    p = Path(path)
    while not p.exists() and p != p.parent:
        p = p.parent
    return shutil.disk_usage(p).free


# -- manifest pins (v0.6, S3 P9) --------------------------------------------------------------------
def configure(voice_dir: Path) -> None:
    """Load the pins a model manifest set earlier (<data>/voice/model_pins.json)."""
    global _pins_path
    path = Path(voice_dir) / "model_pins.json"
    pins: dict[str, ModelSpec] = {}
    if path.exists():
        try:
            pins = _pinned(ModelManifest.model_validate_json(path.read_text()))
        except (ValueError, VoiceError):
            pins = {}  # a damaged pins file: this build's own pins
    with _lock:
        _pins_path = path
        _pins.clear()
        _pins.update(pins)


def _pinned(manifest: ModelManifest) -> dict[str, ModelSpec]:
    """The specs a manifest moves models to. Models this build doesn't know are skipped (they need a new engine
    build); a known model may only move its repos' revisions, never its repos."""
    out: dict[str, ModelSpec] = {}
    for model_id, entry in manifest.models.items():
        base = MODELS.get(model_id)
        if base is None:
            continue
        pins = {r.repo_id: r for r in entry.repos}
        if sorted(pins) != sorted(r.repo_id for r in base.repos) or len(entry.repos) != len(base.repos):
            raise VoiceError("manifest_rejected", f"The manifest changes which repositories {model_id} uses.",
                             "That needs a new engine build.", status=422)
        if not entry.version.strip():
            raise VoiceError("manifest_rejected", f"The manifest gives {model_id} no version.", status=422)
        repos = []
        for r in base.repos:
            p = pins[r.repo_id]
            if not _SHA_RE.fullmatch(p.revision) or p.size_bytes <= 0:
                raise VoiceError("manifest_rejected", f"The manifest's pin for {r.repo_id} isn't a commit sha with a "
                                 "size.", status=422)
            repos.append(replace(r, revision=p.revision, size_bytes=p.size_bytes))
        if any(r.revision != b.revision for r, b in zip(repos, base.repos)):
            out[model_id] = replace(base, repos=tuple(repos), version=entry.version.strip())
    return out


def apply_manifest(manifest: ModelManifest) -> list[str]:
    """Take the pins of a manifest the server has verified. It replaces any earlier manifest: a model it doesn't
    move goes back to this build's pins. Returns the ids it moved. Nothing is downloaded until install()."""
    pins = _pinned(manifest)
    with _lock:
        if _pins_path is not None:
            kept = ModelManifest(published=manifest.published, models={
                k: v for k, v in manifest.models.items() if k in pins})
            _pins_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = _pins_path.with_suffix(".tmp")
            tmp.write_text(kept.model_dump_json(indent=1))
            os.replace(tmp, _pins_path)
        _pins.clear()
        _pins.update(pins)
    return sorted(pins)


def _license(info: Any) -> str | None:
    card = getattr(info, "card_data", None)
    lic = card.get("license") if card is not None else None
    if lic:
        return str(lic).lower()
    return next((t.split(":", 1)[1].lower() for t in (getattr(info, "tags", None) or []) if t.startswith("license:")),
                None)


def _files(info: Any, patterns: tuple[str, ...] | None) -> set[str]:
    names = {s.rfilename for s in (getattr(info, "siblings", None) or [])}
    return names if patterns is None else {n for n in names if any(fnmatch(n, p) for p in patterns)}


def check_update(base: ModelSpec, new: ModelSpec, hub: Any = None) -> None:
    """S1's conditions for a manifest pin move, asked of the Hub before downloading: each moved repo keeps every
    file it had (within its download patterns) under the same name, and keeps its license."""
    if hub is None:
        from huggingface_hub import HfApi

        hub = HfApi()
    for old, upd in zip(base.repos, new.repos):
        if old.revision == upd.revision:
            continue
        try:
            before = hub.model_info(old.repo_id, revision=old.revision)
            after = hub.model_info(upd.repo_id, revision=upd.revision)
        except Exception as e:  # noqa: BLE001 - network or Hub errors
            raise VoiceError("install_failed", f"Couldn't check the update of {old.repo_id}: {e}",
                             "Check the network connection, then try again.", status=502) from e
        if _license(before) != _license(after):
            raise VoiceError("update_rejected", f"The update of {old.repo_id} changes its license "
                             f"({_license(before)} → {_license(after)}).", "It needs a new engine build.", status=409)
        gone = _files(before, old.allow_patterns) - _files(after, old.allow_patterns)
        if gone:
            raise VoiceError("update_rejected", f"The update of {old.repo_id} drops or renames "
                             f"{', '.join(sorted(gone)[:3])}{'…' if len(gone) > 3 else ''}.",
                             "It needs a new engine build.", status=409)


# -- install / uninstall ------------------------------------------------------------------------------
_DOWNLOAD = """
import json, sys
from huggingface_hub import snapshot_download
repo, rev, patterns = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
snapshot_download(repo, revision=rev, allow_patterns=patterns)
"""


def _stop(proc: subprocess.Popen) -> None:
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def _reporter(progress: Progress | None) -> Callable[..., None]:
    """progress() with the byte counts as keywords when the callback takes **kwargs, else just (fraction, message)."""
    if progress is None:
        return lambda fraction, message, **info: None
    try:
        keywords = any(p.kind is inspect.Parameter.VAR_KEYWORD for p in inspect.signature(progress).parameters.values())
    except (TypeError, ValueError):
        keywords = False

    def report(fraction: float | None, message: str | None, **info: Any) -> None:
        if keywords:
            progress(fraction, message, **info)
        else:
            progress(fraction, message)

    return report


def install(spec: ModelSpec, progress: Progress | None = None, *, poll_s: float = 0.5, hub: Any = None) -> None:
    """Download every missing repo of the model's target version (an update, when a manifest moved its pins).
    `progress(fraction, message, bytes_done=, bytes_total=, current_item=)` is called from this thread; if it raises
    (the user cancelled), the download is stopped and the exception propagates. The version in use stays usable
    until the new one is complete."""
    report = _reporter(progress)
    new = target(spec)
    found = [r for r in new.repos if _cached_dir(r) is None and _adopt(r)]
    missing = [r for r in new.repos if repo_dir(r) is None]
    total = new.size_bytes
    if not missing:
        message = f"Found {spec.name} on this Mac." if found else f"{spec.name} is installed."
        report(1.0, message, bytes_done=total, bytes_total=total, current_item=None)
        return
    if found:
        done = sum(r.size_bytes for r in found)
        report(done / total, f"Found part of {spec.name} on this Mac.", bytes_done=done, bytes_total=total,
               current_item=None)
    base = MODELS.get(spec.id, spec)
    if new != base:
        check_update(base, new, hub)
    need = sum(max(0, r.size_bytes - _repo_bytes(r)) for r in missing)
    free = _disk_free(_cache_root())
    if free < need + DISK_RESERVE:
        raise VoiceError("disk_full", f"{spec.name} needs {need / 1e9:.1f} GB and {DISK_RESERVE / 1e9:.0f} GB must "
                         f"stay free; {free / 1e9:.1f} GB is available.",
                         f"Free up at least {(need + DISK_RESERVE - free) / 1e9:.1f} GB, then try again.", status=507)
    with _lock:
        _installing.add(spec.id)
    try:
        for repo in missing:
            patterns = list(repo.allow_patterns) if repo.allow_patterns else None
            env = {**os.environ, "HF_HUB_DISABLE_PROGRESS_BARS": "1"}
            proc = subprocess.Popen([sys.executable, "-c", _DOWNLOAD, repo.repo_id, repo.revision, json.dumps(patterns)],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, env=env)
            try:
                while proc.poll() is None:
                    done = min(total, sum(_repo_bytes(r) for r in new.repos))
                    report(min(0.99, done / total), f"Downloading {spec.name}: {done / 1e9:.1f} of {total / 1e9:.1f} GB",
                           bytes_done=done, bytes_total=total, current_item=repo.repo_id)
                    time.sleep(poll_s)
            except BaseException:
                _stop(proc)
                raise
            err = proc.stderr.read() if proc.stderr else ""
            if proc.returncode != 0:
                if "No space left" in err or "ENOSPC" in err:
                    raise OSError(errno.ENOSPC, f"The disk filled up while downloading {repo.repo_id}.")
                last = err.strip().splitlines()[-1] if err.strip() else f"exit code {proc.returncode}"
                raise VoiceError("install_failed", f"Downloading {repo.repo_id} failed: {last}",
                                 "Check the network connection, then try again.", status=502)
    finally:
        with _lock:
            _installing.discard(spec.id)
    if active(spec) != new:
        raise VoiceError("install_failed", f"{spec.name} downloaded but some files are missing.",
                         "Try the install again.", status=502)
    report(1.0, f"{spec.name} installed.", bytes_done=total, bytes_total=total, current_item=None)


def uninstall(spec: ModelSpec) -> None:
    """Remove every cached revision of the model's repos (and partial downloads) from the Hugging Face cache.
    Required models can't be removed, nor one that is downloading; the caller unloads it first."""
    if spec.required:
        raise VoiceError("model_required", f"{spec.name} is required, so it can't be removed.", status=409)
    with _lock:
        if spec.id in _installing:
            raise VoiceError("model_busy", f"{spec.name} is downloading.", "Cancel the download first.", status=409)
    root = _cache_root()
    if not root.exists():
        return
    from huggingface_hub import scan_cache_dir

    repo_ids = {r.repo_id for s in dict.fromkeys((target(spec), MODELS.get(spec.id, spec))) for r in s.repos}
    cache = scan_cache_dir(root)
    hashes = [rev.commit_hash for repo in cache.repos if repo.repo_type == "model" and repo.repo_id in repo_ids
              for rev in repo.revisions]
    if hashes:
        cache.delete_revisions(*hashes).execute()
    for repo_id in repo_ids:  # a download that never completed has no revision to delete
        blobs = root / f"models--{repo_id.replace('/', '--')}" / "blobs"
        if blobs.exists():
            for p in blobs.glob("*.incomplete"):
                p.unlink(missing_ok=True)
