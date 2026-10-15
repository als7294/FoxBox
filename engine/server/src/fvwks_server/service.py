"""Engine orchestration (owned by S3). FoxBox 2.0 (contracts v1.0): STRINGS' REMIX only, the user's songs and their
stems; PLAY never calls the engine.

``EngineService`` owns the SQLite library, the audio stores, the content-addressed cache and the job runner; ``app.py``
maps each route onto one method here.

- Songs: a track decoded once and kept at its own rate, analysed in the background (fx: tempo, key and grid, then its
  structure: sections, drops and phrases on the grid).
- Stems: MLX Demucs (``voice.separate_stems``), content-addressed by the song's audio, then fx's per-stem features.
- Models: the voice package's catalog, the stems model only, never required at boot (it downloads on the first split).
- Calls into the separator and into fx are serialized (one lock each): model runtimes are not assumed thread-safe.
"""
from __future__ import annotations

import base64
import errno
import hashlib
import io
import json
import logging
import os
import re
import shutil
import string
import sys
import tempfile
import threading
import time
import uuid
from collections import OrderedDict
from contextlib import contextmanager, nullcontext
from pathlib import Path
from typing import Any, Iterator

import numpy as np
import soundfile as sf
from pydantic import ValidationError

from fvwks_contracts.models import (
    Health,
    Job,
    LibraryPlaylist,
    LibrarySource,
    LibrarySourceAdd,
    LibraryTrackPage,
    ModelInfo,
    ModelManifest,
    Settings,
    SignedModelManifest,
    Song,
    SongAnalysis,
    SongCue,
    SongStem,
    SongStructure,
    SongUpdate,
    StemFeatures,
)
from fvwks_fx import api as fx
from fvwks_voice import api as voice

from . import manifest as model_manifest
from .audio_io import AudioStore, as_channels_first, peaks, sweep_partials
from .config import VERSION, Config
from .errors import ApiException, NotFound
from .jobs import JobCancelled, JobContext, JobRunner
from .library import ArtifactCache, Library, audio_hash, new_id, request_hash, utcnow
from .music import key_name, parse_key
from .music_library import SF_EXTS, MusicLibrary, afconvert_wav
from .music_sources import cues_of, grid_of

log = logging.getLogger("fvwks.engine")

MAX_SONG_BYTES = 400 << 20  # a 15-minute WAV at 48 kHz/24-bit is ~260 MB
MAX_SONG_S = 15 * 60
DISK_RESERVE = 5_000_000_000  # free space that must remain after a model download
GATE_FOR_ENGINE = {"demucs": "stems", "stems": "stems"}  # ModelInfo.engine
STEM_TRACKS = ("drums", "bass", "vocals", "other")
STEM_FPS = 60.0
FALLBACK_MODELS = [
    ModelInfo(id="stems-htdemucs", name="Stems (HTDemucs)", engine="stems", size_bytes=84_000_000, installed=False,
              required=False, license="MIT (code); weights for research use",
              description="Splits a song into drums, bass, vocals and other. Downloads on the first split."),
]
# Settings.filename_pattern (kept in the contract; nothing in 2.0 writes files by it): its fields, and the default
DEFAULT_PATTERN = "{slug}_{preset}_{bpm}bpm_{bars}bar_{key}_{variant}_v{version:02d}"
OLD_DEFAULT_PATTERN = "GUYFVWKS_{preset}_{slug}_{bpm}bpm_{bars}bar_{key}_{variant}_v{version:02d}"
PATTERN_FIELDS = frozenset({"artist", "preset", "slug", "bpm", "bars", "key", "variant", "version"})
_SYSTEM_DIRS = tuple(Path(p) for p in ("/System", "/usr", "/bin", "/sbin", "/etc", "/dev", "/private/etc",
                                       "/Library", "/Applications", "/cores"))



def _job(job) -> Job:
    return Job.model_validate(job.snapshot())


def _passthrough(exc: Exception, status: int, code: str, message: str, hint: str | None = None,
                 retryable: bool = False) -> ApiException:
    """Map a seam failure to an ApiException. Errors that carry the engine-wide shape (S1's VoiceError: code,
    message, hint, status, and model_id for model_not_installed) keep it; anything else becomes ``code`` with
    ``message: <exc>``."""
    if isinstance(exc, ApiException):
        return exc
    err_code, err_status = getattr(exc, "code", None), getattr(exc, "status", None)
    if isinstance(err_code, str) and isinstance(err_status, int) and 400 <= err_status < 600:
        model_id = getattr(exc, "model_id", None)
        return ApiException(err_status, err_code, str(getattr(exc, "message", None) or exc),
                            getattr(exc, "hint", None), bool(getattr(exc, "retryable", False)),
                            model_id if isinstance(model_id, str) else None)
    return ApiException(status, code, f"{message}: {exc}", hint, retryable)


def ensure_model_cache() -> None:
    """Create the model cache the app points the engine at (HF_HOME under the data dir, in the bundled app). On a
    fresh Mac it doesn't exist yet, and the installer measures free space on it before the first download."""
    for var in ("HF_HOME", "HF_HUB_CACHE"):
        if path := os.environ.get(var):
            try:
                Path(path).expanduser().mkdir(parents=True, exist_ok=True)
            except OSError:
                log.warning("couldn't create %s=%s", var, path, exc_info=True)


def bind_native_exit_hooks() -> None:
    """Import MLX on the main thread, before any worker thread can.

    MLX (0.32) keeps one compile cache per thread, and its exit hook clears only the cache of the thread that
    first imported ``mlx.core``. The voice package imports MLX lazily, so without this that is a request or job
    thread. Then entries left in the main thread's cache (the main thread ran Kokoro, and later a worker called
    the same compiled function) are destroyed after Python has finalized, and the process segfaults at exit.
    """
    if "mlx.core" in sys.modules or threading.current_thread() is not threading.main_thread():
        return
    try:
        import mlx.core  # noqa: F401
    except Exception:  # noqa: BLE001 - no MLX here (or no Metal device): nothing to bind
        pass


class _LRU(OrderedDict):
    def __init__(self, size: int):
        super().__init__()
        self.size = size

    def put(self, key, value) -> None:
        self[key] = value
        self.move_to_end(key)
        while len(self) > self.size:
            self.popitem(last=False)

    def touch(self, key):
        value = self.get(key)
        if value is not None:
            self.move_to_end(key)
        return value


class PriorityLock:
    """Reentrant lock where waiting interactive (request) threads always go before background (job) threads.

    Plain locks aren't fair: a background loop that releases and re-acquires between steps could starve an
    interactive TTS request for seconds. Background acquirers here wait while any interactive thread is waiting.
    """

    def __init__(self) -> None:
        self._cond = threading.Condition(threading.Lock())
        self._owner: int | None = None
        self._depth = 0
        self._waiting_interactive = 0

    @contextmanager
    def hold(self, background: bool) -> Iterator[None]:
        me = threading.get_ident()
        with self._cond:
            if self._owner == me:
                self._depth += 1
            else:
                if not background:
                    self._waiting_interactive += 1
                try:
                    while self._owner is not None or (background and self._waiting_interactive):
                        self._cond.wait()
                finally:
                    if not background:
                        self._waiting_interactive -= 1
                self._owner, self._depth = me, 1
        try:
            yield
        finally:
            with self._cond:
                self._depth -= 1
                if self._depth == 0:
                    self._owner = None
                    self._cond.notify_all()



class EngineService:
    def __init__(self, config: Config):
        bind_native_exit_hooks()
        ensure_model_cache()
        self.config = config
        self.library = Library(config.library_path)
        self.audio = AudioStore(config.data_dir)  # engine audio (1.x mixes of a song go with it)
        self.song_audio = AudioStore(config.data_dir, folder="songs")  # the user's tracks and their stems
        self.cache = ArtifactCache(self.library, config.cache_dir, max_bytes=config.cache_bytes)
        self.jobs = JobRunner()
        self.music = MusicLibrary(self.library, config.data_dir)  # the library wheel's index (v1.1)
        self._notes: list[str] = []  # start-up problems worth showing in /api/health
        configure = getattr(voice, "configure", None)
        if callable(configure):  # <data>/voice: the model pins a signed manifest set (the voice package's folder)
            (config.data_dir / "voice").mkdir(parents=True, exist_ok=True)
            try:
                configure(config.data_dir / "voice")
            except Exception as exc:  # noqa: BLE001 - a broken hook must not keep the engine from starting
                log.exception("voice configure() failed")
                self._notes.append(f"Model setup failed: {exc}")
        self._lock = threading.RLock()
        self._voice_gates = {"stems": PriorityLock()}  # one separation at a time
        self._fx_background = threading.Lock()  # fx's song analysis, structure and stem features, one at a time
        self._tls = threading.local()
        self._voice_digest = _package_digest(voice)
        self._fx_digest = _package_digest(fx)
        self._state: tuple[str, float | None, str | None] = ("ready", None, None)
        self._settings: Settings | None = None  # this process is the only writer, so a cached copy stays true
        self._closing = threading.Event()
        self._starter: threading.Thread | None = None
        self._models_seen: tuple[float, list[ModelInfo]] | None = None  # health's cached list of missing models
        self._manifest: ModelManifest | None = self._load_manifest()  # the last signed model-update manifest (P9)
        self._songs: _LRU = _LRU(1)  # song id → (audio, sr); a decoded 15-minute song is ~300 MB
        self._song_lock = threading.Lock()  # read-modify-write of song rows (analysis job vs PATCH)
        for song_id in self.library.unfinished_song_analyses():  # song analyses are stored: unfinished ones run again
            self._queue_song_analysis(song_id)
        for row in self.library.select("songs"):
            if row["info"].get("stems_state") in ("queued", "running"):  # a separation never finished: ask again
                self._set_song(row["id"], stems_state="none")
            if row["analysis_state"] == "done" and not row["info"].get("structure"):  # analysed before v0.10
                self._queue_structure(row["id"])

    def close(self, timeout: float = 3.0) -> bool:
        """Stop the engine: cancel background jobs and start-up work, wait up to ``timeout`` s for them (so no worker
        is inside native code while the interpreter shuts down), then close the library. Safe to call again; returns
        whether all background work stopped in time."""
        self._closing.set()
        deadline = time.monotonic() + timeout
        stopped = self.jobs.shutdown(cancel=True, wait=True, timeout=timeout)
        starter = self._starter
        if starter is not None and starter is not threading.current_thread():
            starter.join(max(0.0, deadline - time.monotonic()))
            stopped = stopped and not starter.is_alive()
        if not stopped:
            log.warning("engine closed while background work was still running")
        self.music.close()
        self.library.close()
        return stopped

    @property
    def voice_salt(self) -> str:
        """Cache salt: engine name/version plus a digest of the voice code, so a code change misses old entries."""
        return f"voice:{getattr(voice, 'ENGINE_NAME', 'stub')}:{getattr(voice, 'ENGINE_VERSION', '')}:{self._voice_digest}"

    @property
    def fx_salt(self) -> str:
        return f"fx:{getattr(fx, 'ENGINE_NAME', 'stub')}:{getattr(fx, 'RACK_VERSION', '')}:{self._fx_digest}"

    def _model_lock(self, model: str):
        return self._voice_gates[model].hold(background=getattr(self._tls, "background", False))

    def start(self) -> None:
        """Start-up work for the real engine process: install any missing required model (none in 2.0: the stems
        model downloads on the first split), then sweep the temp files a crash left. /api/health shows a download."""
        missing = self._missing_required() if callable(getattr(voice, "install_model", None)) else []
        if missing:
            self._state = ("loading_model", 0.0, f"Downloading {missing[0].name}")

        def run() -> None:
            self._install_required(missing)
            if self._closing.is_set():
                return
            self._state = ("ready", None, None)
            try:
                self.housekeeping()
            except Exception:  # noqa: BLE001 - clean-up is best effort
                log.exception("start-up housekeeping failed")

        # Daemon, so a hung download can't keep the process alive; close() still joins it (bounded).
        self._starter = threading.Thread(target=run, name="engine-start", daemon=True)
        self._starter.start()
        self.music.start()  # each library refreshes in the background; the last index serves meanwhile

    def _missing_required(self) -> list[ModelInfo]:
        """Required models that aren't installed (Health.required_missing)."""
        try:
            return [m for m in self.list_models() if m.required and not m.installed]
        except Exception:  # noqa: BLE001 - a broken model list must not stop the engine
            log.exception("list_models failed")
            return []

    def _install_required(self, missing: list[ModelInfo]) -> dict[str, str]:
        """Install each missing required model through the ordinary install jobs (disk guard, cancel), mirroring
        their progress into health. Opt-in models are never installed here. Returns failures: model id → message."""
        failures: dict[str, str] = {}
        total = sum(m.size_bytes for m in missing) or 1
        done_bytes = 0
        for model in missing:
            job = self.jobs.get(self.install_model(model.id).id)
            while job is not None and job.active:
                if self._closing.is_set():
                    return failures
                share = (done_bytes + job.progress * model.size_bytes) / total
                self._state = ("loading_model", round(min(share, 1.0), 4), job.message or f"Downloading {model.name}")
                try:
                    self.jobs.wait(job, timeout=0.25)
                except TimeoutError:
                    pass
            if job is not None and job.state != "done":
                error = job.error or {}
                failures[model.id] = " ".join(filter(None, (f"Couldn't install {model.name}: "
                                                            f"{error.get('message') or job.state}.",
                                                            error.get("hint"))))
                log.warning("first-run install of %s failed: %s", model.id, failures[model.id])
            done_bytes += model.size_bytes
        with self._lock:
            self._models_seen = None
        return failures

    def _missing_required_now(self) -> list[ModelInfo]:
        """_missing_required, remembered for a few seconds (health is polled often)."""
        with self._lock:
            seen = self._models_seen
        if seen is not None and time.monotonic() - seen[0] < 5.0:
            return seen[1]
        missing = self._missing_required()
        with self._lock:
            self._models_seen = (time.monotonic(), missing)
        return missing

    def housekeeping(self) -> int:
        """Start-up clean-up: temp files a crash left behind, in the data dir and the export folder. Returns how many were removed."""
        removed = sweep_partials([self.config.data_dir], depth=3)
        removed += sweep_partials([self._root_path()], depth=1)
        if removed:
            log.info("removed %d stale temp files", removed)
        return removed

    def health(self) -> Health:
        state, progress, message = self._state
        notes = list(self._notes)
        missing = self._missing_required_now()
        if state == "ready" and missing:  # a required model's download failed
            notes.append(f"Not installed: {', '.join(m.name for m in missing)} (Settings → Models).")
        message = message or ("; ".join(notes) or None)
        return Health(state=state, version=VERSION, progress=progress, message=message,
                      voice_engine=getattr(voice, "ENGINE_NAME", "stub"), fx_engine=getattr(fx, "ENGINE_NAME", "stub"),
                      disk_free_bytes=shutil.disk_usage(self.config.data_dir).free,
                      data_dir=str(self.config.data_dir), export_dir=self.settings().export_dir,
                      required_missing=[m.id for m in missing])

    def settings(self) -> Settings:
        with self._lock:  # load and fill under one lock, so a concurrent update can't be overwritten by a stale read
            if self._settings is None:
                loaded = Settings(export_dir=str(self.config.export_dir))
                stored = self.library.get_setting("settings")
                if stored:
                    try:
                        loaded = Settings.model_validate(stored)
                        if loaded.filename_pattern == OLD_DEFAULT_PATTERN:  # 1.2.2: the words lead now
                            loaded.filename_pattern = DEFAULT_PATTERN
                    except ValidationError:
                        log.warning("stored settings no longer validate; using defaults")
                self._settings = loaded
            return self._settings.model_copy(deep=True)

    def update_settings(self, new: Settings) -> Settings:
        # Where-to-export rules only apply to a *new* folder: the app PUTs the whole Settings object, and a dev
        # engine's default folder (<worktree>/.devdata/exports) must keep working.
        changed = Path(new.export_dir).expanduser().resolve() != self._root_path()
        root = _validate_export_dir(new.export_dir, strict=changed)
        target = _target_root(new.rekordbox.target_path_root, 400, "invalid_settings")
        new = new.model_copy(update={"rekordbox": new.rekordbox.model_copy(update={"target_path_root": target})})
        try:
            _validate_pattern(new.filename_pattern)
        except ValueError as exc:
            raise ApiException(400, "invalid_settings", f"Filename pattern: {exc}",
                               hint="Keep {variant} and {version}; fields: " + ", ".join(sorted(PATTERN_FIELDS)))
        try:
            key_name(new.default_key)
        except ValueError as exc:
            raise ApiException(400, "invalid_settings", str(exc), hint="Use a key like Am, F#m or C.")
        settings = new.model_copy(update={"export_dir": str(root)})
        with self._lock:
            self.library.set_setting("settings", settings.model_dump(mode="json"))
            self._settings = settings.model_copy(deep=True)
        return settings

    def _root_path(self) -> Path:
        """The export root for path checks: no filesystem access, never raises (the drive may be unplugged)."""
        return Path(self.settings().export_dir).expanduser().resolve()

    # ------------------------------------------------------------------ models
    def list_models(self) -> list[ModelInfo]:
        """The voice package's models, plus what only the server knows (v0.5): the running install job (so a model
        screen can reattach after a reload) and the free space an install needs (the voice package's own figure,
        which counts a resumed download, else the whole package plus the reserve)."""
        hook = getattr(voice, "list_models", None)
        models = list(hook()) if callable(hook) else [m.model_copy() for m in FALLBACK_MODELS]
        running = {j.meta.get("model_id"): j.id for j in self.jobs.list(kind="model_install", active_only=True)}
        with self._lock:
            published = self._manifest.models if self._manifest is not None else {}
        return [m.model_copy(update={
            "install_job_id": running.get(m.id),
            # installed: the voice package's own figure (None when current, an update's download otherwise)
            "install_needs_bytes": m.install_needs_bytes if m.installed
            else (m.install_needs_bytes or m.size_bytes + DISK_RESERVE),
            "version": m.version or (published[m.id].version if m.id in published else None),
        }) for m in models]

    def install_model(self, model_id: str) -> Job:
        model = next((m for m in self.list_models() if m.id == model_id), None)
        if model is None:
            raise NotFound("model", model_id)
        meta = {"model_id": model_id}
        if model.installed and not model.update_available:
            job = self.jobs.new_job("model_install", lane="install", meta=meta)
            return _job(self.jobs.complete(job, f"{model.name} is already installed."))
        free = shutil.disk_usage(self.config.data_dir).free
        need = model.install_needs_bytes or model.size_bytes + DISK_RESERVE  # what GET /api/models shows
        if free < need:
            job = self.jobs.new_job("model_install", lane="install", meta=meta)
            return _job(self.jobs.fail(
                job, "disk_full", f"{model.name} needs {(need - DISK_RESERVE) / 1e9:.1f} GB and {DISK_RESERVE / 1e9:.0f} GB "
                f"must stay free; {free / 1e9:.1f} GB is available.",
                hint=f"Free up at least {(need - free) / 1e9:.1f} GB, then try again."))
        installer = getattr(voice, "install_model", None)
        if not callable(installer):
            job = self.jobs.new_job("model_install", lane="install", meta=meta)
            return _job(self.jobs.fail(job, "not_available", "Model installs are not available in this build yet."))

        def run(ctx: JobContext) -> None:
            ctx.progress(0.0, f"Downloading {model.name}")
            total = max(1, need - DISK_RESERVE)
            ctx.transfer(0, total, model.name)

            def progress(fraction: float | None = None, message: str | None = None, /, **info: Any) -> None:
                ctx.check()  # raises once the user cancels; the installer lets it propagate
                ctx.progress(fraction, message)
                # v0.4 transfer fields: the installer's own bytes when it reports them, else its fraction
                done = info.get("bytes_done")
                if done is None and fraction is not None:
                    done = round(fraction * (info.get("bytes_total") or total))
                ctx.transfer(done, info.get("bytes_total") or total, info.get("current_item") or model.name)

            try:
                installer(model_id, progress)
            except OSError as exc:
                if exc.errno == errno.ENOSPC:
                    raise ApiException(500, "disk_full", f"The disk filled up while downloading {model.name}.",
                                       hint="Free up space, then try again.") from exc
                raise
            ctx.progress(1.0, f"{model.name} installed.")
            ctx.transfer(ctx.job.bytes_total, None, None)
            with self._lock:
                self._models_seen = None

        return _job(self.jobs.submit("model_install", run, lane="install", dedupe_key=f"install:{model_id}",
                                     meta=meta))

    def uninstall_model(self, model_id: str) -> ModelInfo:
        """v0.6 (P8): free the disk a model takes. Required models stay; a model still downloading is busy."""
        model = next((m for m in self.list_models() if m.id == model_id), None)
        if model is None:
            raise NotFound("model", model_id)
        if model.required:
            raise ApiException(409, "model_required", f"{model.name} is required, so it can't be removed.",
                               hint="Only optional models can be removed.")
        if model.install_job_id:
            raise ApiException(409, "model_busy", f"{model.name} is still downloading.",
                               hint="Cancel the download first.")
        if not model.installed:
            return model
        hook = getattr(voice, "uninstall_model", None)
        if not callable(hook):
            raise ApiException(501, "not_implemented", "Removing models isn't available in this build yet.")
        gate = self._voice_gates.get(GATE_FOR_ENGINE.get(model.engine, ""))
        try:  # holding the model's gate lets a running separation finish first
            with gate.hold(background=False) if gate is not None else nullcontext():
                hook(model_id)
        except Exception as exc:
            raise _passthrough(exc, 500, "uninstall_failed", f"Couldn't remove {model.name}") from exc
        with self._lock:
            self._models_seen = None
        return next((m for m in self.list_models() if m.id == model_id), model)

    def apply_model_manifest(self, signed: SignedModelManifest) -> list[ModelInfo]:
        """v0.6 (P9): a model-update manifest from the app's updater. Accepted only with a trusted signature and never
        older than the one in use (a replay can't roll pins back); the voice package applies the new pins."""
        try:
            key_id = model_manifest.verify(signed)
        except ValueError as exc:
            raise ApiException(403, "manifest_untrusted", str(exc),
                               hint="Only manifests signed with FoxBox's release key are accepted.") from None
        new = signed.manifest
        if new.schema_version != 1:
            raise ApiException(422, "manifest_unsupported",
                               f"Manifest schema {new.schema_version} is newer than this engine understands.",
                               hint="Update the app, then check for model updates again.")
        with self._lock:
            current = self._manifest
        if current is not None and new.published < current.published:
            raise ApiException(409, "manifest_outdated",
                               f"This manifest ({new.published}) is older than the one in use ({current.published}).")
        hook = getattr(voice, "apply_model_manifest", None)
        if callable(hook):
            try:
                hook(new)
            except Exception as exc:
                raise _passthrough(exc, 422, "manifest_rejected", "The voice engine rejected the manifest") from exc
        self.library.set_setting("model_manifest", signed.model_dump(mode="json"))
        with self._lock:
            self._manifest = new
            self._models_seen = None
        log.info("model manifest %s applied (key %s)", new.published, key_id)
        return self.list_models()

    def _load_manifest(self) -> ModelManifest | None:
        """The stored manifest, if its signature still verifies (a rotated-out key drops it)."""
        stored = self.library.get_setting("model_manifest")
        if not stored:
            return None
        try:
            signed = SignedModelManifest.model_validate(stored)
            model_manifest.verify(signed)
        except (ValidationError, ValueError):
            log.warning("the stored model manifest no longer verifies; ignoring it")
            return None
        return signed.manifest

    # ------------------------------------------------------------------ songs (REMIX)
    def upload_song(self, data: bytes, filename: str | None, name: str | None, *, analysis: SongAnalysis | None = None,
                    cues: list[SongCue] | None = None) -> Song:
        """Import a track: decoded once, kept at its own rate (FLAC-24 when it fits), analysed in the background. A
        given `analysis` (a library track's Rekordbox grid) and `cues` go with it (see _store_song)."""
        unreadable = ApiException(400, "unsupported_format", "Couldn't read this file as audio.",
                                  hint="Use WAV, AIFF, FLAC or MP3 (the app converts other formats).")
        if not data:
            raise unreadable
        if len(data) > MAX_SONG_BYTES:
            raise ApiException(400, "file_too_large", f"Songs are limited to {MAX_SONG_BYTES >> 20} MB.",
                               hint="Use an MP3 or FLAC of it, or trim it.")
        too_long = ApiException(400, "song_too_long", f"Songs are limited to {MAX_SONG_S // 60} minutes.",
                                hint="Trim it to the part you'll play.")
        try:
            head = sf.info(io.BytesIO(data))
            if head.samplerate > 0 and head.frames / head.samplerate > MAX_SONG_S:  # before decoding all of it
                raise too_long
            frames, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
        except ApiException:
            raise
        except Exception:  # libsndfile: not audio, or a format it can't decode
            raise unreadable from None
        audio = np.ascontiguousarray(frames.T)
        if audio.shape[-1] == 0 or sr <= 0 or not np.isfinite(audio).all():
            raise unreadable
        if audio.shape[0] > 2:
            raise ApiException(400, "unsupported_format", f"This file has {audio.shape[0]} channels.",
                               hint="Use a mono or stereo mix of it.")
        if audio.shape[-1] / sr > MAX_SONG_S:
            raise too_long
        name = (name or "").strip()[:200] or Path(filename or "").stem[:200] or "Song"
        if cues is not None:
            cues = [c for c in cues if c.start_s <= audio.shape[-1] / sr]
        return self._store_song(audio, int(sr), name, analysis=analysis, cues=cues)[0]

    # ------------------------------------------------------------------ the library wheel (v1.1)
    def library_sources(self) -> list[LibrarySource]:
        return self.music.sources()

    def add_library_source(self, body: LibrarySourceAdd) -> LibrarySource:
        return self.music.add(body.kind, body.path)

    def detect_serato_library(self) -> LibrarySource:
        return self.music.add_serato()

    def remove_library_source(self, source_id: str) -> None:
        self.music.remove(source_id)

    def rescan_library_source(self, source_id: str) -> LibrarySource:
        return self.music.rescan(source_id)

    def library_playlists(self, source_id: str) -> list[LibraryPlaylist]:
        return self.music.playlists(source_id)

    def library_tracks(self, **query: Any) -> LibraryTrackPage:
        return self.music.tracks(**query)

    def library_art(self, track_id: str) -> tuple[Path, str]:
        return self.music.art(track_id)

    def library_preview(self, track_id: str) -> Path:
        return self.music.preview(track_id)

    def load_library_track(self, track_id: str) -> Song:
        """A library track as a Song, through the upload's own pipeline (afconvert first for AAC, M4A, ALAC). A
        Rekordbox track with a fixed beat grid keeps it (with its key) as the analysis, and its cues; any other track
        gets FoxBox's own analysis."""
        row, f = self.music.track_file(track_id)
        if f.stat().st_size > MAX_SONG_BYTES:
            raise ApiException(400, "file_too_large", f"Songs are limited to {MAX_SONG_BYTES >> 20} MB.",
                               hint="Use an MP3 or FLAC of it, or trim it.")
        if f.suffix.lower() in SF_EXTS:
            data, filename = f.read_bytes(), f.name
        else:
            with tempfile.TemporaryDirectory(prefix="fvwks-load-") as tmp:
                wav = Path(tmp) / f"{f.stem}.wav"
                afconvert_wav(f, wav)
                data, filename = wav.read_bytes(), wav.name
        extra = json.loads(row["extra"]) if row["extra"] else {}
        analysis, cues = None, None
        if extra:
            grid, bpm, down = grid_of(extra.get("tempo") or [])
            try:
                key = parse_key(row["key"]) if row["key"] else None
            except ValueError:
                key = None
            if grid == "fixed" and bpm and down is not None:
                analysis = SongAnalysis(bpm=bpm, bpm_confidence=1.0, key=key.name if key else None,
                                        camelot=key.camelot if key else None, key_confidence=1.0 if key else 0.0,
                                        downbeat_s=down, source="rekordbox")
            cues = [SongCue.model_validate(c) for c in cues_of(extra.get("marks") or [])]
        log.info("library track %s loads with %s", track_id,
                 "its Rekordbox grid" if analysis else "FoxBox's analysis" + (" (its Rekordbox grid varies)" if extra.get("tempo") else ""))
        name = " - ".join(x for x in (row["artist"], row["title"]) if x) or f.stem
        return self.upload_song(data, filename, name[:200], analysis=analysis, cues=cues)

    def _store_song(self, audio: np.ndarray, sr: int, name: str, *, analysis: SongAnalysis | None = None,
                    cues: list[SongCue] | None = None, cache: bool = True) -> tuple[Song, bool]:
        """A decoded track stored as a Song (new: True), or the Song already holding the same audio (False). A given
        `analysis` (a Rekordbox grid) skips FoxBox's tempo analysis: only the structure runs on it. On an existing song
        the given analysis and cues replace the old ones; the user's overrides are never touched."""
        digest = audio_hash(audio, sr)
        for row in self.library.select("songs", "audio_hash = ?", (digest,), limit=1):  # the same file again
            if self.song_audio.exists(row["audio_id"]):
                song = self._song(row)
                if analysis is None and cues is None:
                    return song, False
                update = {"cues": cues} if cues is not None else {}
                if analysis is not None:
                    update.update(analysis=analysis, analysis_state="done")
                song = self._set_song(song.id, **update) or song
                if analysis is not None:
                    self._queue_structure(song.id)
                return song, False
        try:
            audio_id = self.song_audio.put(audio, sr, "sng", compact=True)
        except Exception as exc:
            raise _write_error(exc, "upload_failed", "Couldn't store the song") from exc
        analyse = callable(getattr(fx, "analyze_song", None))
        song = Song(id=new_id("sng"), name=name, duration_s=round(audio.shape[-1] / sr, 5), sample_rate=int(sr),
                    channels=audio.shape[0], peaks=peaks(audio, sr), audio_id=audio_id, analysis=analysis,
                    analysis_state="done" if analysis else "queued" if analyse else "error", cues=cues or [],
                    created_at=utcnow())
        self.library.insert("songs", id=song.id, name=song.name, created_at=song.created_at, audio_hash=digest,
                            audio_id=audio_id, analysis_state=song.analysis_state, info=song.model_dump(mode="json"))
        if cache:
            with self._lock:
                self._songs.put(song.id, (audio, int(sr)))
        if analysis is not None:
            self._queue_structure(song.id)
        elif analyse:
            self._queue_song_analysis(song.id)
        return song, True

    def list_songs(self) -> list[Song]:
        return [self._song(row) for row in self.library.select("songs")]

    def get_song(self, song_id: str) -> Song:
        row = self.library.get("songs", song_id)
        if row is None:
            raise NotFound("song", song_id)
        return self._song(row)

    def update_song(self, song_id: str, body: SongUpdate) -> Song:
        """PATCH: only the fields present in the body; an explicit null clears an override."""
        fields = body.model_fields_set
        update: dict[str, Any] = {}
        if "name" in fields and body.name is not None and body.name.strip():
            update["name"] = body.name.strip()
        if "bpm_override" in fields:
            update["bpm_override"] = body.bpm_override
        if "downbeat_override_s" in fields:
            update["downbeat_override_s"] = body.downbeat_override_s
        if "key_override" in fields:
            try:
                update["key_override"] = key_name(body.key_override) if body.key_override else None
            except ValueError:
                raise ApiException(422, "invalid_request", f"key_override: unknown key '{body.key_override}'.",
                                   hint="Use a key like Am, F#m or C.") from None
        song = self.get_song(song_id)
        if update.get("downbeat_override_s") is not None and update["downbeat_override_s"] >= song.duration_s:
            raise ApiException(422, "invalid_request", "Bar 1 must be inside the song.")
        updated = self._set_song(song_id, **update)
        if updated is None:
            raise NotFound("song", song_id)
        if {"bpm_override", "downbeat_override_s"} & set(update) and updated.analysis is not None:
            self._queue_structure(song_id)  # the sections sit on the song's grid
        return updated

    def delete_song(self, song_id: str) -> None:
        """The song, its audio and stems, and any 1.x mix of it."""
        row = self.library.get("songs", song_id)
        if row is None:
            raise NotFound("song", song_id)
        for job in self.jobs.list(kind="song_analysis", active_only=True):
            if job.meta.get("song_id") == song_id:
                self.jobs.cancel(job.id)
        for kind in ("song_stems",):
            for job in self.jobs.list(kind=kind, active_only=True):
                if job.meta.get("song_id") == song_id:
                    self.jobs.cancel(job.id)
        for mix in self.library.select("mixes", "song_id = ?", (song_id,)):
            self._drop_mix(mix)
        self.library.delete("songs", [song_id])
        self.song_audio.delete(row["audio_id"], *(s.get("audio_id") for s in row["info"].get("stems") or []))
        with self._lock:
            self._songs.pop(song_id, None)

    def _drop_mix(self, row: dict[str, Any]) -> None:
        self.library.delete("mixes", [row["id"]])
        self.audio.delete(row["audio_id"])

    def _queue_song_analysis(self, song_id: str) -> None:
        self.jobs.submit("song_analysis", self._analyze_song, song_id, lane="songs",
                         dedupe_key=f"song_analysis:{song_id}", meta={"song_id": song_id})

    def _analyze_song(self, ctx: JobContext, song_id: str) -> dict[str, Any] | None:
        if self._set_song(song_id, analysis_state="running") is None:
            return None  # deleted while queued
        try:
            audio, sr = self._song_audio(song_id)
            ctx.check()
            with self._fx_background:
                analysis = SongAnalysis.model_validate(fx.analyze_song(audio, sr))
        except JobCancelled:
            self._set_song(song_id, analysis_state="queued")  # the engine is stopping: analysed on next launch
            raise
        except Exception:
            self._set_song(song_id, analysis_state="error")
            raise
        row = self.library.get("songs", song_id)
        if row is None:
            return None
        song = self._song(row).model_copy(update={"analysis": analysis})
        structure = self._structure(song, audio, sr, None, with_stems=song.stems_state == "done")
        self._set_song(song_id, analysis_state="done", analysis=analysis,
                       **({"structure": structure} if structure is not None else {}))
        return {"song_id": song_id}

    def _queue_structure(self, song_id: str) -> None:
        """Structure an analysed song again (analysed before v0.10, or its grid changed)."""
        if callable(getattr(fx, "song_structure", None)):
            self.jobs.submit("song_analysis", self._restructure, song_id, lane="songs",
                             dedupe_key=f"song_structure:{song_id}", meta={"song_id": song_id}, retain=False)

    def _restructure(self, ctx: JobContext, song_id: str) -> dict[str, Any] | None:
        row = self.library.get("songs", song_id)
        if row is None:
            return None
        song = self._song(row)
        ctx.check()
        structure = self._structure(song, None, 0, None, with_stems=song.stems_state == "done")
        if structure is not None:
            self._set_song(song_id, structure=structure)
        return {"song_id": song_id}

    def _structure(self, song: Song, audio: np.ndarray | None, sr: int, stems: dict[str, np.ndarray] | None,
                   *, with_stems: bool = True) -> SongStructure | None:
        """S2's sections, drops and phrases on the song's grid (the user's BPM and bar 1 when set), refined with the
        stems when there are any. None without the hook, or when it fails: a song without a structure still plays."""
        make = getattr(fx, "song_structure", None)
        if not callable(make) or song.analysis is None:
            return None
        grid = self._grid(song)
        try:
            if audio is None:
                audio, sr = self._song_audio(song.id)
            if stems is None and with_stems and song.stems:
                stems = {s.name: self._load_stem(s.audio_id)[0] for s in song.stems}
            with self._fx_background:
                return SongStructure.model_validate(make(audio, sr, grid, stems=stems or None))
        except Exception:  # noqa: BLE001
            log.exception("song structure failed for %s", song.id)
            return None

    @staticmethod
    def _grid(song: Song) -> SongAnalysis:
        """The song's analysis with the user's BPM and bar 1, when set."""
        return song.analysis.model_copy(update={k: v for k, v in (("bpm", song.bpm_override),
                                                                 ("downbeat_s", song.downbeat_override_s)) if v is not None})

    def _song(self, row: dict[str, Any]) -> Song:
        return Song.model_validate({**row["info"], "name": row["name"], "analysis_state": row["analysis_state"]})

    def _set_song(self, song_id: str, **update: Any) -> Song | None:
        """Change a stored song (None when it was deleted meanwhile)."""
        with self._song_lock:
            row = self.library.get("songs", song_id)
            if row is None:
                return None
            song = self._song(row).model_copy(update=update)
            self.library.update("songs", song_id, name=song.name, analysis_state=song.analysis_state,
                                info=song.model_dump(mode="json"))
            return song

    def _song_audio(self, song_id: str) -> tuple[np.ndarray, int]:
        with self._lock:
            cached = self._songs.touch(song_id)
        if cached is not None:
            return cached
        row = self.library.get("songs", song_id)
        if row is None:
            raise NotFound("song", song_id)
        try:
            loaded = self.song_audio.load(row["audio_id"])
        except FileNotFoundError:
            raise ApiException(409, "song_missing", "This song's audio is gone.", hint="Import it again.") from None
        with self._lock:
            self._songs.put(song_id, loaded)
        return loaded

    # ------------------------------------------------------------------ stems
    def request_stems(self, song_id: str) -> Job:
        """POST /songs/{id}/stems: separate the song into drums/bass/vocals/other (a song_stems job). Stems are
        content-addressed by the song's audio and the separator, so asking again (or re-importing the song) is
        instant."""
        separate = getattr(voice, "separate_stems", None)
        if not callable(separate):
            raise ApiException(501, "not_implemented", "Stem separation arrives with the stems model update.")
        song = self.get_song(song_id)
        if song.stems_state in ("queued", "running"):
            for job in self.jobs.list(kind="song_stems", active_only=True):
                if job.meta.get("song_id") == song_id:
                    return _job(job)
        if song.stems_state == "done" and all(self.song_audio.exists(s.audio_id) for s in song.stems):
            return _job(self.jobs.complete(self.jobs.new_job("song_stems", meta={"song_id": song_id}),
                                           message="Stems ready.", result={"song_id": song_id}))
        self._set_song(song_id, stems_state="queued")
        return _job(self.jobs.submit("song_stems", self._separate_stems, song_id, lane="songs",
                                     dedupe_key=f"song_stems:{song_id}", meta={"song_id": song_id}))

    def _separate_stems(self, ctx: JobContext, song_id: str) -> dict[str, Any] | None:
        row = self.library.get("songs", song_id)
        if row is None or self._set_song(song_id, stems_state="running") is None:
            return None  # deleted while queued
        audio, sr, checked = None, 0, {}
        try:
            key = self._stems_key(row)
            hit = self.cache.lookup(key)
            ids = (hit or {}).get("meta", {}).get("stems") or {}
            if not (set(ids) == set(STEM_TRACKS) and all(self.song_audio.exists(i) for i in ids.values())):
                audio, sr = self._song_audio(song_id)
                ctx.check()
                ctx.progress(0.0, "Separating stems")

                def progress(fraction: float | None = None, message: str | None = None, /, **_: Any) -> None:
                    ctx.check()
                    ctx.progress(None if fraction is None else 0.9 * max(0.0, min(1.0, fraction)), message)

                with self._model_lock("stems"):
                    stems = voice.separate_stems(audio, sr, progress)
                ctx.check()
                checked = {}
                for name in STEM_TRACKS:
                    raw = stems.get(name) if isinstance(stems, dict) else None
                    arr = as_channels_first(raw) if raw is not None else np.zeros((1, 0), np.float32)
                    if arr.ndim != 2 or arr.shape[-1] != audio.shape[-1] or not np.isfinite(arr).all():
                        raise ApiException(500, "stems_failed", f"The separator's {name} stem is missing or malformed.")
                    checked[name] = arr
                # Separated stems overshoot full scale (they sum back to the mix; ±1.6 on a real song), which would
                # force float WAV (~55 MB per 2.5-minute stem). One shared gain keeps them in FLAC-24 (~1/4 of it)
                # and keeps their balance; the features come from the unscaled stems and are normalised per song.
                peak = max(float(np.max(np.abs(a))) for a in checked.values())
                headroom = min(1.0, 0.999 / peak) if peak > 0 else 1.0
                ids = {}
                for name, arr in checked.items():
                    try:
                        ids[name] = self.song_audio.put(arr * headroom if headroom < 1.0 else arr, sr, "sgs", compact=True)
                    except Exception as exc:
                        self.song_audio.delete(*ids.values())
                        raise _write_error(exc, "stems_failed", "Couldn't store the stems") from exc
                self.cache.remember("song_stems", key, artifact_id=song_id, meta={"stems": ids})
                ctx.progress(0.92, "Stem features")
                if callable(getattr(fx, "stem_features", None)):
                    song = self._song(self.library.get("songs", song_id) or row)
                    self._compute_features(song.model_copy(update={"stems": [SongStem(name=n, audio_id=ids[n])
                                                                             for n in STEM_TRACKS]}),
                                           checked, audio, sr)
        except JobCancelled:
            self._set_song(song_id, stems_state="none")
            raise
        except Exception:
            self._set_song(song_id, stems_state="error")
            raise
        stems = [SongStem(name=n, audio_id=ids[n]) for n in STEM_TRACKS]
        update: dict[str, Any] = {"stems_state": "done", "stems": stems}
        song = self._song(self.library.get("songs", song_id) or row).model_copy(update={"stems": stems})
        if song.structure is None or not song.structure.from_stems:  # v0.10: drums and bass mark the drops
            ctx.progress(0.96, "Song structure")
            structure = self._structure(song, audio, sr, checked or None)
            if structure is not None:
                update["structure"] = structure
        if self._set_song(song_id, **update) is None:
            return None
        return {"song_id": song_id}

    def stem_features(self, song_id: str) -> StemFeatures:
        """GET /songs/{id}/stems/features: per-stem envelopes and onsets over the whole song (S2's fx), cached."""
        if not callable(getattr(fx, "stem_features", None)):
            raise ApiException(501, "not_implemented", "Stem features arrive with the sound engine's stems update.")
        song = self.get_song(song_id)
        if song.stems_state != "done" or not song.stems:
            running = song.stems_state in ("queued", "running")
            raise ApiException(409, "stems_not_ready",
                               "This song's stems are still being separated." if running else "This song has no stems yet.",
                               hint=None if running else "Separate its stems first.", retryable=running)
        key = self._features_key(song)
        cached = self.cache.lookup(key)
        data = self.cache.get_bytes(key) if cached else None
        if data is None or not cached:
            stems = {s.name: self._load_stem(s.audio_id)[0] for s in song.stems}
            mix, sr = self._song_audio(song_id)
            data, frames = self._compute_features(song, stems, mix, sr)
        else:
            frames = int(cached["meta"].get("frames", 0))
        size = frames * (len(STEM_TRACKS) + 1) * 2  # v0.10.1: the bass lane (4 bytes a frame) follows, when fx made one
        return StemFeatures(song_id=song_id, fps=STEM_FPS, frames=frames, tracks=[*STEM_TRACKS, "mix"],
                            data_b64=base64.b64encode(data[:size]).decode("ascii"),
                            bass_b64=base64.b64encode(data[size:]).decode("ascii"))

    def _stems_key(self, song_row: dict[str, Any]) -> str:
        engine = str(getattr(voice, "STEMS_ENGINE", "") or self.voice_salt)
        return request_hash("song_stems", {"audio": song_row["audio_hash"]}, salt=engine)

    def _features_key(self, song: Song) -> str:
        return request_hash("stem_features", {"stems": [s.audio_id for s in song.stems], "fps": STEM_FPS,
                                              "grid": song.analysis.model_dump(mode="json") if song.analysis else None},
                            salt=self.fx_salt)

    def _load_stem(self, audio_id: str) -> tuple[np.ndarray, int]:
        try:
            return self.song_audio.load(audio_id)
        except FileNotFoundError:
            raise ApiException(409, "stems_missing", "This song's stems are gone.", hint="Separate its stems again.") from None

    def _compute_features(self, song: Song, stems: dict[str, np.ndarray], mix: np.ndarray, sr: int) -> tuple[bytes, int]:
        with self._fx_background:
            out = fx.stem_features(stems, sr, mix, analysis=song.analysis, fps=STEM_FPS)
        data = np.ascontiguousarray(out.data, dtype=np.uint8)
        if data.ndim != 3 or data.shape[1:] != (len(STEM_TRACKS) + 1, 2) or list(out.tracks) != [*STEM_TRACKS, "mix"]:
            raise ApiException(500, "stems_failed", f"Stem features came back as {data.shape} for {list(out.tracks)}.")
        raw = data.tobytes()
        bass = getattr(out, "bass", None)  # v0.10.1: (frames, 4) uint8, documented on StemFeatures.bass_b64
        if bass is not None:
            bass = np.ascontiguousarray(bass, dtype=np.uint8)
            if bass.shape != (data.shape[0], 4):
                raise ApiException(500, "stems_failed", f"Bass features came back as {bass.shape}.")
            raw += bass.tobytes()
        self.cache.put_bytes("stem_features", self._features_key(song), raw, artifact_id=song.id,
                             meta={"frames": int(data.shape[0])})
        return raw, int(data.shape[0])

    # ------------------------------------------------------------------ jobs and audio
    def job(self, job_id: str) -> Job:
        job = self.jobs.get(job_id)
        if job is None:
            raise NotFound("job", job_id)
        return _job(job)

    def cancel_job(self, job_id: str) -> Job:
        self.job(job_id)
        self.jobs.cancel(job_id)
        return self.job(job_id)

    def audio_path(self, audio_id: str) -> Path:
        if not AudioStore.valid(audio_id):
            raise NotFound("audio", audio_id)
        store = self.song_audio if audio_id.startswith(("sng_", "sgs_")) else self.audio  # songs and stems
        path = store.stream_path(audio_id)
        if path is None:
            raise NotFound("audio", audio_id)
        return path


def _disk_full(exc: BaseException) -> bool:
    seen: set[int] = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        if isinstance(exc, OSError) and exc.errno == errno.ENOSPC or "No space left" in str(exc):
            return True
        exc = exc.__cause__ or exc.__context__
    return False


def _write_error(exc: Exception, code: str, what: str) -> ApiException:
    """A failed file write (OSError, libsndfile's RuntimeError) as the engine's error shape."""
    if isinstance(exc, ApiException):
        return exc
    if _disk_full(exc):
        return ApiException(500, "disk_full", f"{what}: the disk is full.", hint="Free up space, then try again.",
                            retryable=True)
    detail = getattr(exc, "strerror", None) or str(exc) or type(exc).__name__
    return ApiException(500, code, f"{what}: {detail}", retryable=True,
                        hint="Check the export folder in Settings and the free disk space.")


def _package_digest(module: Any) -> str:
    """Short digest of a package's .py/.json files (the voice or fx implementation behind a seam)."""
    try:
        root = Path(module.__file__).resolve().parent
    except (AttributeError, TypeError):
        return "unknown"
    h = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if path.suffix in (".py", ".json") and path.is_file() and "__pycache__" not in path.parts:
            h.update(path.relative_to(root).as_posix().encode())
            h.update(path.read_bytes())
    return h.hexdigest()[:12]


def _target_root(text: str | None, status: int, code: str) -> str | None:
    """A rekordbox target path root: an absolute path on the target machine (POSIX or a Windows drive)."""
    if text is None or not text.strip():
        return None
    root = text.strip()
    if root.startswith("/") or re.match(r"^[A-Za-z]:[\\/]", root):
        return root
    raise ApiException(status, code, f"target_path_root must be an absolute path on the target machine, not {root!r}.",
                       hint="Write the full path, e.g. /Users/dj/Music/FoxBox or C:\\Music\\FoxBox (no ~).")


def _validate_export_dir(text: str, strict: bool = True) -> Path:
    """The export folder is the one client-chosen path the engine accepts; keep it to sane, writable places."""
    if not text or "\x00" in text:
        raise ApiException(400, "invalid_settings", "The export folder is empty or malformed.")
    path = Path(text).expanduser()
    if not path.is_absolute():
        raise ApiException(400, "invalid_settings", "The export folder must be an absolute path.")
    path = path.resolve()
    if path == Path("/") or any(path == d or d in path.parents for d in _SYSTEM_DIRS):
        raise ApiException(400, "invalid_settings", f"{path} is a system folder.", hint="Pick a folder in ~/Music.")
    # The export root is where the app may drag and reveal files from: never a whole home folder or a hidden one
    # (~/.ssh, ~/.config, ...).
    if strict and (path == Path.home().resolve() or path in (Path("/Users"), Path("/Volumes"))):
        raise ApiException(400, "invalid_settings", f"{path} is too broad for exports.",
                           hint="Pick a folder inside it, e.g. ~/Music/FoxBox.")
    if strict and any(part.startswith(".") for part in path.parts[1:]):
        raise ApiException(400, "invalid_settings", f"{path} is inside a hidden folder.",
                           hint="Pick a visible folder, e.g. in ~/Music.")
    if not strict:
        return path  # unchanged folder: saving other settings never depends on the drive being plugged in
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / f".fvwks-write-test-{uuid.uuid4().hex[:8]}"
        probe.write_bytes(b"")
        probe.unlink()
    except OSError as exc:
        raise ApiException(400, "invalid_settings", f"Can't write to {path}: {exc.strerror or exc}.",
                           hint="Pick a folder you own, e.g. in ~/Music.") from exc
    return path



def _validate_pattern(pattern: str) -> str:
    """A user filename pattern (Settings): known fields only, and ``{variant}`` + ``{version}``."""
    fields = {fld for _, fld, _, _ in string.Formatter().parse(pattern) if fld is not None}
    if not {"variant", "version"} <= fields:
        raise ValueError("filename pattern must contain {variant} and {version}")
    unknown = {fld.split(":")[0].split("!")[0] for fld in fields} - PATTERN_FIELDS
    if unknown:
        raise ValueError(f"unknown field(s): {', '.join(sorted(unknown))}")
    return pattern
