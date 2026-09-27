"""Engine orchestration (owned by S3): the only caller of the voice and fx seams, and the only file writer.

``EngineService`` owns the SQLite library, the audio store, the content-addressed caches and the job runner;
``app.py`` maps each route onto one method here.

- Sources: TTS is cached by (script, voice, speed, bpm, name, lexicon); every new source queues a background WORLD
  analysis job (``fx.analyze``).
- Renders: None fields of the request are filled from the preset (plus its arrange/master hints for fields the
  client left unset). STACK voices are synthesized through ``voice.synthesize`` (cached by script, voice, speed and
  lexicon) before ``fx.render(main, stack, req)``. Identical requests return the cached render. Final renders
  become Vault takes and auto-export the wet file.
- Exports: ``writer.export_files`` (AIFF/WAV, tags, filename pattern); rekordbox.xml through ``rekordbox.py``.
  Every returned path is checked to be inside the export root.
- Calls into voice and into fx are serialized (one lock each): model runtimes are not assumed thread-safe.
"""
from __future__ import annotations

import errno
import hashlib
import inspect
import itertools
import json
import logging
import os
import re
import shutil
import sys
import threading
import time
import uuid
from collections import OrderedDict
from contextlib import contextmanager, nullcontext
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Iterator, Literal

import numpy as np
from pydantic import ValidationError

from fvwks_contracts.models import (
    DEFAULT_LEXICON,
    Arrange,
    BatchRequest,
    Chain,
    ExportedFile,
    ExportRequest,
    ExportResult,
    Health,
    Job,
    Lexicon,
    LibraryPage,
    MacroMap,
    Macros,
    Master,
    ModelInfo,
    ModelManifest,
    SignedModelManifest,
    PersonaCandidate,
    PersonaDesignRequest,
    PersonaSaveRequest,
    Preset,
    RekordboxRequest,
    RekordboxResult,
    RenderInfo,
    RenderRequest,
    ScriptPreview,
    ScriptPreviewRequest,
    ScriptPreviewSegment,
    SegmentFlags,
    Settings,
    SourceInfo,
    SourceList,
    StemInfo,
    Take,
    TakePatch,
    TTSRequest,
    Voice,
)
from fvwks_contracts.audio import STANDARD_BARS
from fvwks_contracts.seam import RenderOutput, Source
from fvwks_fx import api as fx
from fvwks_voice import api as voice

from . import manifest as model_manifest
from . import writer
from .audio_io import AudioStore, as_channels_first, peaks, sweep_partials
from .config import VERSION, Config
from .errors import ApiException, NotFound
from .jobs import DONE, ERROR, JobCancelled, JobContext, JobRunner, error_payload
from .library import ArtifactCache, Library, audio_hash, new_id, request_hash, utcnow
from .music import key_name
from .rekordbox import RekordboxOptions, RekordboxTrack, write_rekordbox_xml

log = logging.getLogger("fvwks.engine")

STEM_NAMES = ("dry", "voice", "layers", "fx")
MAX_UPLOAD_BYTES = 200 << 20
DISK_RESERVE = 5_000_000_000  # free space that must remain after a model download
TRANSCRIBE_MODEL = "whisper-aligner"  # the voice package's model behind transcribe()/realign() (v0.3)
GATE_FOR_ENGINE = {"kokoro": "kokoro", "qwen3": "persona", "asr": "aligner", "denoise": "ingest"}  # ModelInfo.engine
_SYSTEM_DIRS = tuple(Path(p) for p in ("/System", "/usr", "/bin", "/sbin", "/etc", "/dev", "/private/etc",
                                       "/Library", "/Applications", "/cores"))
FALLBACK_MODELS = [
    ModelInfo(id="kokoro-82m", name="Kokoro 82M", engine="kokoro", size_bytes=330_000_000, installed=True,
              required=True, license="Apache-2.0", description="Default fast TTS voices."),
    ModelInfo(id="qwen3-tts-voicedesign", name="Qwen3-TTS VoiceDesign", engine="qwen3", size_bytes=3_400_000_000,
              installed=False, required=False, license="Apache-2.0",
              description="Optional persona designer: describe a voice, then clone it."),
]


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


def _mono(audio: np.ndarray) -> np.ndarray:
    return as_channels_first(audio)


def _resolved_bars(out: RenderOutput, arrange: Arrange, n_samples: int, sample_rate: int) -> int | None:
    """RenderInfo.bars: the bar count the render actually used. fx reports it (v0.2, resolving "auto"); an older
    rack doesn't, so take the request's own count. None = FREE."""
    reported = getattr(out, "bars", None)
    if isinstance(reported, int) and not isinstance(reported, bool) and reported > 0:
        return reported
    if arrange.bars == "auto":  # resolved but not reported: a grid-fitted render is exactly N bars long
        bar = 240.0 / arrange.bpm * sample_rate
        return next((b for b in STANDARD_BARS if abs(n_samples - b * bar) <= 1), None)
    return arrange.bars


def _on_grid(req: RenderRequest, info: RenderInfo) -> RenderRequest:
    """A re-render of a stored render (alt preset, stems) on its resolved bar count: "auto" could land elsewhere for
    another chain, and the variants must stay sample-aligned with the original."""
    if req.arrange.bars != "auto" or info.bars is None:
        return req
    return req.model_copy(update={"arrange": req.arrange.model_copy(update={"bars": info.bars})})


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
        self.audio = AudioStore(config.data_dir)
        self.cache = ArtifactCache(self.library, config.cache_dir, max_bytes=config.cache_bytes)
        self.jobs = JobRunner()
        self._notes: list[str] = []  # start-up problems worth showing in /api/health
        configure = getattr(voice, "configure", None)
        if callable(configure):  # a folder the voice package owns (persona clips and metadata)
            (config.data_dir / "voice").mkdir(parents=True, exist_ok=True)
            try:
                configure(config.data_dir / "voice")
            except Exception as exc:  # noqa: BLE001 - a broken hook must not keep the engine from starting
                log.exception("voice configure() failed")
                self._notes.append(f"Voice setup failed: {exc}")
        self._lock = threading.RLock()
        # One call per voice model at a time (requests go before background jobs). Kokoro, the persona model
        # (Qwen3), the transcriber (Whisper + aligner) and the ingest denoiser (DeepFilterNet3) are separate models,
        # so an 8 s persona design or a transcription never holds up an ordinary TTS line.
        self._voice_gates = {"kokoro": PriorityLock(), "persona": PriorityLock(), "aligner": PriorityLock(),
                             "ingest": PriorityLock()}
        # Two fx lanes: interactive renders (HTTP) queue among themselves, and background work (batch renders, WORLD
        # analysis, stack prefetch) queues on its own lock, so a preview never waits behind a Setlist render.
        # fvwks_fx is pure apart from its own locked caches, so one render of each kind can run at once.
        self._fx_interactive = threading.Lock()
        self._fx_background = threading.Lock()
        self._tls = threading.local()
        self._sources: _LRU = _LRU(16)  # source id → Source (decoded audio)
        self._stack: _LRU = _LRU(16)  # stack cache key → Source
        self._renders: _LRU = _LRU(256)  # render request hash → render id (the library is the fallback)
        self._key_locks: dict[str, list] = {}  # request hash → [lock, users]: identical requests run once
        self._preview_ticket = itertools.count(1)
        self._latest_preview: _LRU = _LRU(256)  # source id → ticket of its newest interactive preview
        self._finalize_lock = threading.Lock()  # one take and one auto-export per final render
        self._voice_digest = _package_digest(voice)
        self._fx_digest = _package_digest(fx)
        self._samples: dict[str, str] = {}  # voice audition audio id → voice id
        self._candidates: _LRU = _LRU(12)  # persona candidate audio id → Source
        self._state: tuple[str, float | None, str | None] = ("ready", None, None)
        self._settings: Settings | None = None  # this process is the only writer, so a cached copy stays true
        self._closing = threading.Event()
        self._starter: threading.Thread | None = None
        self._models_seen: tuple[float, list[ModelInfo]] | None = None  # health's cached list of missing models
        self._manifest: ModelManifest | None = None
        self._manifest = self._load_manifest()  # the last signed model-update manifest (P9)
        # fx keeps its WORLD analyses in memory, so none survive a restart (and a job killed mid-way left its row
        # "queued"/"running"): start every source at "none" and analyse again on first use.
        self.library.reset_analysis_states()
        self.library.reset_transcript_states()  # transcripts are stored; only unfinished jobs start over

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
        self.library.close()
        return stopped

    # ------------------------------------------------------------------------------------------ system

    @property
    def voice_salt(self) -> str:
        """Cache salt: engine name/version plus a digest of the voice code, so a code change misses old entries."""
        return f"voice:{getattr(voice, 'ENGINE_NAME', 'stub')}:{getattr(voice, 'ENGINE_VERSION', '')}:{self._voice_digest}"

    @property
    def fx_salt(self) -> str:
        return f"fx:{getattr(fx, 'ENGINE_NAME', 'stub')}:{getattr(fx, 'RACK_VERSION', '')}:{self._fx_digest}"

    @contextmanager
    def _background(self) -> Iterator[None]:
        """Mark this thread's fx work as background (job threads), for the lifetime of the block."""
        previous = getattr(self._tls, "background", False)
        self._tls.background = True
        try:
            yield
        finally:
            self._tls.background = previous

    def _voice_lock(self, voice_id: str | None = None):
        """Hold the model behind ``voice_id`` (Kokoro by default; ``persona:``/``qwen3:`` ids use the persona model).
        Interactive requests are served before background prefetch and batch work."""
        return self._model_lock("persona" if voice_id and voice_id.split(":", 1)[0] in ("persona", "qwen3")
                                else "kokoro")

    def _model_lock(self, model: str):
        return self._voice_gates[model].hold(background=getattr(self._tls, "background", False))

    def _fx_lock(self) -> threading.Lock:
        return self._fx_background if getattr(self._tls, "background", False) else self._fx_interactive

    @contextmanager
    def _keyed(self, key: str) -> Iterator[None]:
        """A lock per request hash, held from cache check to store, so identical requests run once (and unrelated
        ones never wait for each other)."""
        with self._lock:
            entry = self._key_locks.setdefault(key, [threading.Lock(), 0])
            entry[1] += 1
        try:
            with entry[0]:
                yield
        finally:
            with self._lock:
                entry[1] -= 1
                if entry[1] == 0:
                    self._key_locks.pop(key, None)

    def start(self) -> None:
        """Start-up work for the real engine process: install any missing required model (a first launch on a fresh
        Mac), warm the voice model, then pre-render the recommended voices' audition clips so auditions are
        instant. /api/health shows each step (loading_model with progress and a message)."""
        warm = getattr(voice, "warm_up", None)
        # Install what's missing only when the voice package can (else health just lists it).
        missing = self._missing_required() if callable(getattr(voice, "install_model", None)) else []
        if missing:
            self._state = ("loading_model", 0.0, f"Downloading {missing[0].name}")
        elif callable(warm):
            self._state = ("loading_model", None, "Loading the voice model")

        def run() -> None:
            failures = self._install_required(missing)
            if self._closing.is_set():
                return
            warmed = True
            if callable(warm):
                self._state = ("loading_model", None, "Loading the voice model")
                try:
                    with self._voice_lock():
                        warm()
                    self._state = ("ready", None, None)
                except Exception as exc:  # noqa: BLE001 - surfaced through /api/health
                    log.exception("voice warm-up failed")
                    # A download that failed explains a model that won't load better than the load error does.
                    self._state = ("error", None, next(iter(failures.values()), f"Voice model failed to load: {exc}"))
                    warmed = False
            elif missing:
                self._state = ("ready", None, None)
            if self._closing.is_set():
                return
            try:  # after warm-up, so a slow (network) export folder never delays READY
                self.housekeeping()
            except Exception:  # noqa: BLE001 - clean-up is best effort
                log.exception("start-up housekeeping failed")
            if warmed:
                with self._background():  # audition clips never hold up the user's first line
                    self.prerender_samples()

        # Daemon, so a hung model load can't keep the process alive; close() still joins it (bounded).
        self._starter = threading.Thread(target=run, name="engine-start", daemon=True)
        self._starter.start()

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
        """Start-up clean-up: temp files a crash left behind, in the data dir and the export folder (plus one level
        of Setlist folders). Returns how many were removed."""
        removed = sweep_partials([self.config.data_dir], depth=3)
        removed += sweep_partials([self._root_path()], depth=1)
        if removed:
            log.info("removed %d stale temp files", removed)
        return removed

    def health(self) -> Health:
        state, progress, message = self._state
        notes = list(self._notes)
        missing = self._missing_required_now()
        if state == "ready" and missing:  # e.g. the denoiser's download failed: the app works, takes aren't cleaned
            notes.append(f"Not installed: {', '.join(m.name for m in missing)} (VOICES → Models).")
        message = message or ("; ".join(notes) or None)
        return Health(state=state, version=VERSION, progress=progress, message=message,
                      voice_engine=getattr(voice, "ENGINE_NAME", "stub"), fx_engine=getattr(fx, "ENGINE_NAME", "stub"),
                      disk_free_bytes=shutil.disk_usage(self.config.data_dir).free,
                      data_dir=str(self.config.data_dir), export_dir=self.settings().export_dir,
                      required_missing=[m.id for m in missing])

    def rack(self):
        return fx.rack_schema()

    # ------------------------------------------------------------------------------------------ settings

    def settings(self) -> Settings:
        with self._lock:  # load and fill under one lock, so a concurrent update can't be overwritten by a stale read
            if self._settings is None:
                loaded = Settings(export_dir=str(self.config.export_dir))
                stored = self.library.get_setting("settings")
                if stored:
                    try:
                        loaded = Settings.model_validate(stored)
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
            writer.validate_pattern(new.filename_pattern)
        except ValueError as exc:
            raise ApiException(400, "invalid_settings", f"Filename pattern: {exc}",
                               hint="Keep {variant} and {version}; fields: " + ", ".join(sorted(writer.PATTERN_FIELDS)))
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

    @property
    def export_root(self) -> Path:
        """The export root for writing: created if needed, 409 when it isn't available."""
        root = Path(self.settings().export_dir).expanduser()
        try:
            root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ApiException(409, "export_dir_unavailable", f"The export folder {root} is not available: "
                               f"{exc.strerror or exc}.", hint="Plug the drive back in, or pick another folder "
                               "in Settings.") from exc
        return root.resolve()

    def _inside_root(self, path: Path | str, root: Path | None = None) -> Path:
        """Only paths inside the export root (or the root a Setlist started with) ever leave the engine."""
        root, resolved = (root or self._root_path()), Path(path).resolve()
        if resolved != root and root not in resolved.parents:
            raise ApiException(500, "outside_export_root", "Refusing to return a path outside the export root.")
        return resolved

    def lexicon(self) -> Lexicon:
        stored = self.library.get_setting("lexicon")
        if stored:
            try:
                return Lexicon.model_validate(stored)
            except ValidationError:
                log.warning("stored lexicon no longer validates; using the default")
        return DEFAULT_LEXICON.model_copy(deep=True)

    def update_lexicon(self, lexicon: Lexicon) -> Lexicon:
        self.library.set_setting("lexicon", lexicon.model_dump(mode="json"))
        return lexicon

    # ------------------------------------------------------------------------------------------ voices

    def list_voices(self) -> list[Voice]:
        personas: list[Voice] = []
        for row in self.library.select("personas", order="created_at, rowid"):
            try:
                personas.append(Voice.model_validate(row["data"]["voice"]))
            except (KeyError, ValidationError):
                log.warning("skipping unreadable persona %s", row["id"])
        # A saved persona auditions with its chosen candidate clip; re-synthesizing it would run the slow model.
        saved_clips = {p.id: p.sample_audio_id for p in personas if self.audio.exists(p.sample_audio_id)}
        out = []
        for v in voice.list_voices():  # metadata only: no model lock, so it never waits behind a warm-up
            sample_id = saved_clips.get(v.id)
            if sample_id is None:
                sample_id = "smp_" + hashlib.sha256(f"{v.id}|{self.voice_salt}".encode()).hexdigest()[:12]
                self._samples[sample_id] = v.id
            out.append(v.model_copy(update={"sample_audio_id": sample_id}))
        known = {v.id for v in out}
        out += [p for p in personas if p.id not in known]  # the voice package may list its personas itself
        return out

    def _check_voice(self, voice_id: str) -> None:
        if voice_id not in {v.id for v in self.list_voices()}:
            persona = voice_id.split(":", 1)[0] in ("persona", "qwen3")
            raise ApiException(404, "voice_not_found", f"voice '{voice_id}' not found",
                               hint="Persona voices need the optional Qwen3-TTS model." if persona
                               else "GET /api/voices lists the installed voices.")

    # ------------------------------------------------------------------------------------------ models

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
            if model_id == TRANSCRIBE_MODEL:
                self._queue_pending_transcripts()
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
            if model_id == TRANSCRIBE_MODEL:
                self._queue_pending_transcripts()

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
        try:  # holding the model's gate lets a line or design that uses it finish first
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

    # ------------------------------------------------------------------------------------------ personas

    def design_persona(self, req: PersonaDesignRequest) -> Job:
        design = getattr(voice, "design_persona", None)
        if not callable(design):
            job = self.jobs.new_job("persona_design")
            return _job(self.jobs.fail(job, "model_missing", "Install Qwen3-TTS VoiceDesign first.",
                                       hint="VOICES → Persona designer shows the download."))

        def run(ctx: JobContext) -> None:
            # The hook returns a list (all the work done) or yields candidates one by one (~3 s apart): each is
            # stored as it arrives, so the app's slots fill in turn, and a cancel stops between candidates. The
            # model gate is held per candidate, so a persona TTS line can go in between.
            with self._voice_lock("persona:"):
                candidates = iter(design(req))
            try:
                for done in itertools.count(1):
                    ctx.check()
                    with self._voice_lock("persona:"):
                        src = next(candidates, None)
                    if src is None:
                        break
                    ctx.check()  # one that finished after a cancel isn't shown
                    audio = _mono(src.audio)
                    cid = self.audio.put(audio, src.info.sample_rate, "cand")
                    with self._lock:
                        self._candidates.put(cid, Source(info=src.info, audio=audio))
                    ctx.add_results([cid])
                    ctx.progress(min(1.0, done / req.candidates), f"{done} of {req.candidates} voices ready")
            finally:
                close = getattr(candidates, "close", None)
                if callable(close):
                    close()  # a generator stopped early releases what it holds

        return _job(self.jobs.submit("persona_design", run))

    def save_persona(self, req: PersonaSaveRequest) -> Voice:
        save = getattr(voice, "save_persona", None)
        with self._lock:
            candidate = self._candidates.get(req.candidate_id)
        if not callable(save) or candidate is None:
            raise NotFound("persona candidate", req.candidate_id)
        with self._voice_lock("persona:"):
            v: Voice = save(req.name, candidate)
        v = v.model_copy(update={"sample_audio_id": req.candidate_id})
        self.library.insert("personas", id=new_id("per"), name=req.name, data={"voice": v.model_dump(mode="json")})
        return v

    def get_persona_candidate(self, candidate_id: str) -> PersonaCandidate:
        """v0.1: candidates are keyed by their audio id (see design_persona)."""
        with self._lock:
            candidate = self._candidates.get(candidate_id)
        if candidate is None:
            raise NotFound("persona candidate", candidate_id)
        return PersonaCandidate(id=candidate_id, audio_id=candidate_id,
                                description=candidate.info.name or candidate.info.script or "Persona candidate")

    # ------------------------------------------------------------------------------------------ script preview

    def preview_script(self, req: ScriptPreviewRequest) -> ScriptPreview:
        """v0.1: parse without synthesizing. Uses fvwks_voice.api.preview_script when S1 provides it."""
        lexicon = self.lexicon()
        fn = getattr(voice, "preview_script", None)
        if callable(fn):
            kwargs = {"bpm": req.bpm} if _accepts(fn, "bpm") else {}  # S1's pre-v0.1 hook had no bpm
            try:
                out = fn(req.script, lexicon, **kwargs)
                return out if isinstance(out, ScriptPreview) else ScriptPreview.model_validate(out)
            except Exception as exc:
                raise _passthrough(exc, 500, "preview_failed", "Script preview failed") from exc
        parse = getattr(voice, "parse_script", None)  # v0 stub fallback
        chunks = parse(req.script) if callable(parse) else [(req.script, SegmentFlags())]
        return ScriptPreview(segments=[ScriptPreviewSegment(text=t, say=t.replace("*", "").lower(), flags=f)
                                       for t, f in chunks],
                             warnings=["script preview: voice engine has no preview_script yet (stub parse)"])

    # ------------------------------------------------------------------------------------------ sources

    def create_tts(self, req: TTSRequest) -> SourceInfo:
        self._check_voice(req.voice_id)
        lexicon = self.lexicon()
        key = request_hash("tts", {"req": req, "lexicon": lexicon}, salt=self.voice_salt)
        with self._keyed(key):
            return self._create_tts(req, lexicon, key)

    def _create_tts(self, req: TTSRequest, lexicon: Lexicon, key: str) -> SourceInfo:
        entry = self.cache.lookup(key)
        if entry and entry["artifact_id"]:
            row = self.library.get("sources", entry["artifact_id"])
            if row and self.audio.exists(row["audio_id"]):
                self.library.update("sources", row["id"], used_at=utcnow())
                self._ensure_analysis(row["id"])
                return _source_info(self.library.get("sources", row["id"]))
            self.library.cache_delete(key)
        try:
            with self._voice_lock(req.voice_id):
                src = voice.synthesize(req, lexicon)
        except Exception as exc:
            raise _passthrough(exc, 500, "tts_failed", "TTS failed", hint="Try another voice or a shorter line.",
                               retryable=True) from exc
        self._model_works()
        info = self._add_source(src, request_hash=key, request=req.model_dump(mode="json"))
        self.cache.remember("tts", key, info.id)
        return info

    def _model_works(self) -> None:
        """A successful synthesis proves the voice model loads: clear a start-up error in /api/health."""
        if self._state[0] == "error":
            self._state = ("ready", None, None)

    def upload(self, data: bytes, filename: str | None, kind: Literal["recording", "import"],
               name: str | None, denoise: float | None = None) -> SourceInfo:
        if not data:
            raise ApiException(400, "unsupported_audio", "The uploaded file is empty.")
        if len(data) > MAX_UPLOAD_BYTES:
            raise ApiException(400, "file_too_large", f"Uploads are limited to {MAX_UPLOAD_BYTES >> 20} MB.",
                               hint="Trim the recording first.")
        options, warnings = {}, []
        if denoise is not None:
            if _accepts(voice.ingest, "denoise"):
                options["denoise"] = denoise
            else:
                warnings.append("This voice engine can't denoise; the recording was kept as it is.")
        try:  # decoding, clean-up and the denoiser model: one ingest at a time, and TTS never waits for it
            with self._model_lock("ingest"):
                src = voice.ingest(data, name or filename, kind, **options)
        except Exception as exc:
            raise _passthrough(exc, 400, "unsupported_audio", "Could not read audio",
                               hint="Use WAV, AIFF, FLAC or MP3 (the app converts other formats).") from exc
        update: dict[str, Any] = {}
        if "denoise" in options and src.info.denoise is None:  # a voice package that doesn't report the strength
            update["denoise"] = denoise
        if warnings:
            update["warnings"] = [*src.info.warnings, *warnings]
        if update:
            src = Source(info=src.info.model_copy(update=update), audio=src.audio)
        # The same audio uploaded again (e.g. the app re-sending a recording after a relaunch) is the same source.
        # The digest is of the ingested audio, so another denoise strength is another source.
        digest = audio_hash(_mono(src.audio), src.info.sample_rate)
        for row in self.library.select("sources", "audio_hash = ? AND kind = ?", (digest, kind), limit=1):
            if self.audio.exists(row["audio_id"]):
                self.library.update("sources", row["id"], used_at=utcnow())
                self._ensure_analysis(row["id"])
                self._ensure_transcript(row["id"])
                return _source_info(self.library.get("sources", row["id"]))
        return self._add_source(src)

    def _add_source(self, src: Source, request_hash: str | None = None, request: dict | None = None) -> SourceInfo:
        audio = _mono(src.audio)
        sr = src.info.sample_rate
        bpm = src.info.bpm if src.info.bpm is not None else (request or {}).get("bpm")
        now = utcnow()  # the server's clock orders sources (GC), whatever the voice package stamped
        info = src.info.model_copy(update={"id": new_id("src"), "audio_id": self.audio.put(audio, sr, "src"),
                                           "bpm": bpm, "created_at": now})
        self.library.insert("sources", id=info.id, kind=info.kind, created_at=now, used_at=now,
                            request_hash=request_hash, audio_hash=audio_hash(audio, sr), audio_id=info.audio_id,
                            request=request or {}, info=info.model_dump(mode="json"))
        with self._lock:
            self._sources.put(info.id, Source(info=info, audio=audio))
        self._queue_analysis(info.id)
        self._queue_stack_prefetch(info)
        self._queue_transcript(info.id, info.kind)
        self._gc_sources()
        return _source_info(self.library.get("sources", info.id))

    def load_source(self, source_id: str) -> Source:
        with self._lock:
            cached = self._sources.touch(source_id)
        if cached is not None:
            return cached
        row = self.library.get("sources", source_id)
        if row is None:
            raise NotFound("source", source_id)
        try:
            audio, _ = self.audio.load(row["audio_id"])
        except FileNotFoundError:
            raise ApiException(409, "source_missing", "This source's audio is gone.",
                               hint="Synthesize or import it again.") from None
        src = Source(info=SourceInfo.model_validate(row["info"]), audio=audio)
        with self._lock:
            self._sources.put(source_id, src)
        self._ensure_analysis(source_id)
        self._ensure_transcript(source_id)
        return src

    def list_sources(self, kind: str | None, limit: int, offset: int) -> SourceList:
        where, params = ("kind = ?", (kind,)) if kind else ("", ())
        rows = self.library.select("sources", where, params, limit=max(0, limit), offset=max(0, offset))
        return SourceList(items=[_source_info(r) for r in rows],
                          total=self.library.count("sources", where, params))

    def get_source(self, source_id: str) -> SourceInfo:
        row = self.library.get("sources", source_id)
        if row is None:
            raise NotFound("source", source_id)
        return _source_info(row)

    def delete_source(self, source_id: str) -> None:
        row = self.library.get("sources", source_id)
        if row is None:
            raise NotFound("source", source_id)
        self._drop_source(row)

    def _drop_source(self, row: dict[str, Any]) -> None:
        self.library.delete("sources", [row["id"]])
        self.library.cache_forget_artifact(row["id"])
        self.audio.delete(row["audio_id"])
        with self._lock:
            self._sources.pop(row["id"], None)

    # -- WORLD analysis (background) --------------------------------------------------------------------

    def _queue_analysis(self, source_id: str) -> None:
        if not callable(getattr(fx, "analyze", None)):
            return
        self.library.update("sources", source_id, analysis_state="queued")
        self.jobs.submit("analysis", self._analyze, source_id, lane="analysis", dedupe_key=f"analysis:{source_id}",
                         meta={"source_id": source_id}, retain=False)  # state lives in sources.analysis_state

    def _ensure_analysis(self, source_id: str) -> None:
        """Queue the background analysis of a source that has none in this process (fx caches it in memory)."""
        row = self.library.get("sources", source_id)
        if row is not None and row["analysis_state"] == "none":
            self._queue_analysis(source_id)

    def _analysis_ready(self, source_id: str) -> bool:
        row = self.library.get("sources", source_id)
        return row is not None and row["analysis_state"] == "done"

    def _analyze(self, ctx: JobContext, source_id: str) -> None:
        if self.library.get("sources", source_id) is None:
            return  # deleted while queued
        self.library.update("sources", source_id, analysis_state="running")
        try:
            src = self.load_source(source_id)
            ctx.check()
            with self._fx_background:
                fx.analyze(src)
        except JobCancelled:
            if self.library.get("sources", source_id) is not None:  # the engine is stopping: not an error
                self.library.update("sources", source_id, analysis_state="none")
            raise
        except Exception:
            if self.library.get("sources", source_id) is not None:
                self.library.update("sources", source_id, analysis_state="error")
            raise
        if self.library.get("sources", source_id) is not None:
            self.library.update("sources", source_id, analysis_state="done")

    # ------------------------------------------------------------------------------------------ transcripts (v0.3)

    def _transcriber_ready(self) -> bool:
        """A transcribe hook with its model installed. A voice package that doesn't list the model is just tried."""
        if not callable(getattr(voice, "transcribe", None)):
            return False
        try:
            model = next((m for m in self.list_models() if m.id == TRANSCRIBE_MODEL), None)
        except Exception:  # noqa: BLE001
            return True
        return model is None or model.installed

    def _queue_transcript(self, source_id: str, kind: str) -> None:
        if kind != "tts" and self._transcriber_ready():
            self._submit_transcript(source_id)

    def _submit_transcript(self, source_id: str) -> None:
        self.library.update("sources", source_id, transcript_state="queued")
        self.jobs.submit("transcribe", self._transcribe, source_id, lane="transcribe",
                         dedupe_key=f"transcript:{source_id}", meta={"source_id": source_id}, retain=False)

    def _queue_pending_transcripts(self) -> int:
        """Transcribe the recordings that arrived before the transcriber's model was installed (newest first)."""
        if not self._transcriber_ready():
            return 0
        rows = self.library.select("sources", "kind != 'tts' AND transcript_state = 'none'")
        for row in rows:
            self._submit_transcript(row["id"])
        return len(rows)

    def _ensure_transcript(self, source_id: str) -> None:
        """Transcribe a recording that has no transcript yet: uploaded before the model was installed, or cut short
        by a restart. A failed one stays failed; the user can type the transcript instead."""
        row = self.library.get("sources", source_id)
        if row is not None and row["kind"] != "tts" and row["transcript_state"] == "none":
            self._queue_transcript(source_id, row["kind"])

    def _transcribe(self, ctx: JobContext, source_id: str) -> None:
        row = self.library.get("sources", source_id)
        if row is None or row["transcript_state"] != "queued":
            return  # deleted, or the user typed the transcript meanwhile
        self.library.update("sources", source_id, transcript_state="running")
        try:
            src = self.load_source(source_id)
            with self._background(), self._model_lock("aligner"):
                ctx.check()  # a transcript the user typed while this waited for the model cancelled it
                if self.library.get("sources", source_id) is None:
                    return  # deleted while waiting
                out = voice.transcribe(src)
        except Exception as exc:
            missing = getattr(exc, "code", None) == "model_not_installed"  # it runs once the model is installed
            stopped = isinstance(exc, JobCancelled) or ctx.cancelled
            self._set_transcript_state(source_id, "none" if missing or stopped else "error", only_if="running")
            if missing:
                return
            raise
        with self._keyed(f"transcript:{source_id}"):
            row = self.library.get("sources", source_id)
            if row is not None and row["transcript_state"] == "running":  # else the user's own transcript won
                self._store_transcript(row, out.info)

    def _set_transcript_state(self, source_id: str, state: str, only_if: str) -> None:
        with self._keyed(f"transcript:{source_id}"):
            row = self.library.get("sources", source_id)
            if row is not None and row["transcript_state"] == only_if:
                self.library.update("sources", source_id, transcript_state=state)

    def _store_transcript(self, row: dict[str, Any], new: SourceInfo) -> SourceInfo:
        """Keep the voice package's transcript and segments on the stored source (same id, audio and clock)."""
        old = SourceInfo.model_validate(row["info"])
        info = new.model_copy(update={"id": old.id, "audio_id": old.audio_id, "kind": old.kind,
                                      "created_at": old.created_at, "bpm": old.bpm,
                                      "denoise": old.denoise if new.denoise is None else new.denoise})
        self.library.update("sources", old.id, info=info.model_dump(mode="json"), transcript_state="done")
        with self._lock:
            cached = self._sources.get(old.id)
            if cached is not None:
                self._sources.put(old.id, Source(info=info, audio=cached.audio))
        return _source_info(self.library.get("sources", old.id))

    def update_transcript(self, source_id: str, script: str) -> SourceInfo:
        """The user's edited transcript (markup allowed) re-segments and re-aligns a recording, like TTS."""
        row = self.library.get("sources", source_id)
        if row is None:
            raise NotFound("source", source_id)
        if row["kind"] == "tts":
            raise ApiException(400, "invalid_request", "A TTS line is edited by synthesizing it again.",
                               hint="Change the script and render again.")
        realign = getattr(voice, "realign", None)
        if not callable(realign):
            raise ApiException(501, "not_implemented", "This voice engine can't align an edited transcript.")
        src = self.load_source(source_id)
        try:
            with self._model_lock("aligner"):
                out = realign(src, script)
        except Exception as exc:
            raise _passthrough(exc, 422, "align_failed", "Couldn't align the transcript") from exc
        with self._keyed(f"transcript:{source_id}"):
            row = self.library.get("sources", source_id)
            if row is None:
                raise NotFound("source", source_id)
            info = self._store_transcript(row, out.info)
        for job in self.jobs.list(kind="transcribe", active_only=True):  # the user's text wins over a pending one
            if job.dedupe_key == f"transcript:{source_id}":
                self.jobs.cancel(job.id)
        return info

    def _queue_stack_prefetch(self, info: SourceInfo) -> None:
        if info.kind == "tts" and info.script:  # its own lane: it must not wait behind the main voice's analysis
            self.jobs.submit("analysis", self._prefetch_stack, info.id, lane="prefetch",
                             dedupe_key=f"stack:{info.id}", retain=False)

    def _prefetch_stack(self, ctx: JobContext, source_id: str) -> None:
        """Synthesize and analyse the presets' STACK voices for the newest TTS line in the background, so the
        first preview doesn't pay for them (about 0.4 s of TTS plus analysis per voice)."""
        def superseded() -> bool:  # the user moved on to a newer line: warm that one instead
            newest = self.library.select("sources", "kind = 'tts'", limit=1)
            return not newest or newest[0]["id"] != source_id

        with self._background():
            if superseded():
                return
            try:
                main = self.load_source(source_id)
            except ApiException:
                return
            # All the voices first, then their analyses: a preview needs the voices (it falls back to DIO without
            # an analysis), and analyses wait on the background fx lock, e.g. behind the main voice's own.
            stack = []
            for voice_id in self._stack_voice_ids():
                ctx.check()
                if superseded():
                    return
                stack.append(self._stack_voice(main, voice_id)[1])
            if callable(getattr(fx, "analyze", None)):
                for src in stack:
                    ctx.check()
                    if superseded():
                        return
                    with self._fx_background:
                        fx.analyze(src)

    def _stack_voice_ids(self) -> list[str]:
        """TTS stack voices of the default preset first, then of the other factory presets (deduplicated)."""
        presets = self.presets()
        default = self.settings().default_preset_id
        ordered = sorted(presets, key=lambda p: (p.id != default, not p.factory))
        ids = [sv.voice_id for p in ordered if p.id == default or p.factory for sv in p.stack if sv.voice_id]
        return list(dict.fromkeys(ids))[:4]

    def analysis_state(self, source_id: str) -> str:
        row = self.library.get("sources", source_id)
        if row is None:
            raise NotFound("source", source_id)
        return row["analysis_state"]

    # ------------------------------------------------------------------------------------------ presets

    def presets(self) -> list[Preset]:
        factory = [p.model_copy(update={"factory": True}) for p in fx.list_presets()]
        user = [Preset.model_validate(r["data"]) for r in self.library.select("presets", order="name COLLATE NOCASE, id")]
        return factory + user

    def preset(self, preset_id: str) -> Preset:
        for p in self.presets():
            if p.id == preset_id:
                return p
        raise NotFound("preset", preset_id)

    def _factory_ids(self) -> set[str]:
        return {p.id for p in fx.list_presets()}

    def _check_preset_modules(self, preset: Preset) -> None:
        modules = {m.id: {p.id for p in m.params} for m in fx.rack_schema().modules}
        for m in preset.chain.modules:
            if m.id not in modules:
                raise ApiException(422, "invalid_preset", f"Unknown rack module '{m.id}'.")
            unknown = set(m.params) - modules[m.id]
            if unknown:
                raise ApiException(422, "invalid_preset", f"Unknown {m.id} params: {', '.join(sorted(unknown))}.")

    def create_preset(self, preset: Preset) -> Preset:
        if any(p.id == preset.id for p in self.presets()):
            raise ApiException(409, "exists", f"Preset '{preset.id}' already exists.")
        self._check_preset_modules(preset)
        p = preset.model_copy(update={"factory": False})
        now = utcnow()
        self.library.insert("presets", id=p.id, name=p.name, created_at=now, updated_at=now,
                            data=p.model_dump(mode="json"))
        return p

    def update_preset(self, preset_id: str, preset: Preset) -> Preset:
        if self.library.get("presets", preset_id) is None:
            if preset_id in self._factory_ids():
                raise ApiException(409, "read_only", "Factory presets are read-only. Save a copy instead.")
            raise NotFound("preset", preset_id)
        self._check_preset_modules(preset)
        p = preset.model_copy(update={"id": preset_id, "factory": False})
        self.library.update("presets", preset_id, name=p.name, updated_at=utcnow(), data=p.model_dump(mode="json"))
        return p

    def delete_preset(self, preset_id: str) -> None:
        if self.library.get("presets", preset_id) is None:
            if preset_id in self._factory_ids():
                raise ApiException(409, "read_only", "Factory presets are read-only.")
            raise NotFound("user preset", preset_id)
        self.library.delete("presets", [preset_id])

    def _preset_label(self, preset_id: str | None) -> str:
        if not preset_id:
            return "CUSTOM"
        try:
            return self.preset(preset_id).name
        except NotFound:
            return preset_id.upper()

    # ------------------------------------------------------------------------------------------ render

    def render(self, req: RenderRequest) -> RenderInfo:
        try:
            key_name(req.arrange.key)
        except ValueError:
            raise ApiException(422, "invalid_request", f"arrange.key: unknown key '{req.arrange.key}'.",
                               hint="Use a key like Am, F#m or C.") from None
        source = self.load_source(req.source_id)
        preset = self.preset(req.preset_id) if req.preset_id else None
        filled, warnings = _fill(req, preset, self.settings())
        ticket = None
        if filled.quality == "preview" and not getattr(self._tls, "background", False):
            with self._lock:  # the newest preview of a source wins: older ones still waiting are dropped
                ticket = next(self._preview_ticket)
                self._latest_preview.put(source.info.id, ticket)
        info = self._render(source, filled, preset, warnings, ticket)
        if filled.quality == "final":
            info = self._finalize(info, source, preset, filled.auto_export)
        return info

    def _render(self, source: Source, filled: RenderRequest, preset: Preset | None,
                warnings: Iterable[str] = (), ticket: int | None = None) -> RenderInfo:
        t_stack = time.perf_counter()
        stack, stack_keys, stack_warnings = self._stack_sources(source, filled)
        stack_ms = round((time.perf_counter() - t_stack) * 1000, 1)
        payload = {"req": filled.model_dump(mode="json", exclude={"auto_export"}), "stack": stack_keys,
                   "timeline": _timeline_digest(source.info)}  # a new transcript re-renders
        if filled.quality == "preview":  # previews use a quick analysis until the background one lands
            payload["analysed"] = self._analysis_ready(source.info.id)
        key = request_hash("render", payload, salt=self.fx_salt)
        if self.library.get("sources", source.info.id) is not None:
            self.library.update("sources", source.info.id, used_at=utcnow())
        with self._keyed(key):
            cached = self._cached_render(key)
            if cached is not None:
                return cached
            t0 = time.perf_counter()
            out = self._run_fx(source, stack, filled, ticket)
            t1 = time.perf_counter()
            info = self._store_render(source, filled, out, key, preset, [*warnings, *stack_warnings],
                                      {"engine_stack": stack_ms, "engine_fx": round((t1 - t0) * 1000, 1)})
        if filled.quality == "preview":
            self._gc_previews()
        return info

    def _run_fx(self, source: Source, stack: list[Source | None], filled: RenderRequest,
                ticket: int | None = None) -> RenderOutput:
        try:
            with self._fx_lock():
                if ticket is not None and self._latest_preview.get(source.info.id) != ticket:
                    raise ApiException(409, "superseded", "A newer preview of this line replaced this one.")
                return fx.render(source, stack, filled)
        except Exception as exc:
            if not isinstance(exc, ApiException):
                log.exception("render failed")
            raise _passthrough(exc, 500, "render_failed", "Render failed", retryable=True) from exc

    def _cached_render(self, key: str) -> RenderInfo | None:
        with self._lock:
            render_id = self._renders.touch(key)
        row = self.library.get("renders", render_id) if render_id else self.library.find("renders", "request_hash", key)
        if row is None or not self.audio.exists(row["audio"].get("wet")):
            with self._lock:
                self._renders.pop(key, None)
            return None
        with self._lock:
            self._renders.put(key, row["id"])
        if row["quality"] == "preview":  # just used again: the preview GC keeps the most recently used
            self.library.update("renders", row["id"], created_at=utcnow())
        return self._visible(RenderInfo.model_validate(row["info"]))

    def _store_render(self, source: Source, filled: RenderRequest, out: RenderOutput, key: str,
                      preset: Preset | None, warnings: list[str], timings: dict[str, float]) -> RenderInfo:
        t0 = time.perf_counter()
        sr = int(out.sample_rate)
        wet, dry = as_channels_first(out.audio), as_channels_first(out.dry)
        if not (np.isfinite(wet).all() and np.isfinite(dry).all()):
            raise ApiException(500, "render_failed", "The render produced NaN/Inf samples.", retryable=False)
        stems: dict[str, str] = {}
        written: list[str] = []
        compact = filled.quality == "final"  # finals are kept: FLAC-24 is ~1/4 of float32; previews stay fast WAV
        try:
            for name, arr in (out.stems or {}).items():
                if name in STEM_NAMES:
                    stems[name] = self.audio.put(arr, sr, "stm")
                    written.append(stems[name])
                else:
                    warnings.append(f"Unknown stem '{name}' was dropped.")
            wet_id = self.audio.put(wet, sr, "rnd", compact=compact)
            written.append(wet_id)
            dry_id = self.audio.put(dry, sr, "dry", compact=compact)
            written.append(dry_id)
        except Exception as exc:
            self.audio.delete(*written)  # no half-stored render
            raise _write_error(exc, "render_failed", "Couldn't store the render") from exc
        timings = {**out.timings_ms, **timings, "engine_store": round((time.perf_counter() - t0) * 1000, 1)}
        info = RenderInfo(
            id=new_id("rnd"), source_id=source.info.id, preset_id=filled.preset_id, quality=filled.quality,
            created_at=utcnow(), sample_rate=sr, channels=wet.shape[0], n_samples=wet.shape[-1],
            duration_s=round(wet.shape[-1] / sr, 5), audio_id=wet_id, dry_audio_id=dry_id, peaks=peaks(wet, sr),
            dry_peaks=peaks(dry, sr), segments=out.segments, bpm=filled.arrange.bpm,
            bars=_resolved_bars(out, filled.arrange, wet.shape[-1], sr),
            key=filled.arrange.key, first_word_s=out.first_word_s, tail_s=out.tail_s, fit=out.fit,
            loudness=out.loudness, mask=out.mask, resolved_chain=out.resolved_chain,
            macros=filled.macros or Macros(), stems=[StemInfo(name=k, audio_id=v) for k, v in stems.items()],
            timings_ms=timings, warnings=[*out.warnings, *warnings],
            motion=getattr(out, "motion", None),  # v0.5: voice-core motion data, when fx provides it
        )
        meta = {"script": source.info.script, "source_name": source.info.name, "source_kind": source.info.kind,
                "voice_id": source.info.voice_id, "preset_name": preset.name if preset else None}
        self.library.insert("renders", id=info.id, source_id=source.info.id, created_at=info.created_at,
                            quality=info.quality, request_hash=key, request=filled.model_dump(mode="json"),
                            info=info.model_dump(mode="json"), audio={"wet": wet_id, "dry": dry_id, "stems": stems},
                            meta=meta)
        with self._lock:
            self._renders.put(key, info.id)
        return info

    def get_render(self, render_id: str) -> RenderInfo:
        row = self.library.get("renders", render_id)
        if row is None:
            raise NotFound("render", render_id)
        return self._visible(RenderInfo.model_validate(row["info"]))

    def _export_ok(self, f: ExportedFile) -> bool:
        """Only exports that still exist inside the current export root are ever returned. Never raises: with the
        export drive unplugged, the Vault still lists its takes (without their files)."""
        root, path = self._root_path(), Path(f.path).resolve()
        try:
            return (path == root or root in path.parents) and path.is_file()
        except OSError:
            return False

    def _visible(self, info: RenderInfo) -> RenderInfo:
        if info.export is not None and not self._export_ok(info.export):
            return info.model_copy(update={"export": None})
        return info

    def _finalize(self, info: RenderInfo, source: Source, preset: Preset | None, auto_export: bool) -> RenderInfo:
        """A final render is a Vault take, and (by default) its wet file is exported right away.

        Serialized and re-read from the library, so identical final renders racing each other end up with one take
        and one export."""
        with self._finalize_lock:
            row = self.library.get("renders", info.id)
            if row is not None:
                info = RenderInfo.model_validate(row["info"])
            if self.library.find("takes", "render_id", info.id) is None:
                self._add_take(info, source, preset)
            settings = self.settings()
            current = info.export
            if auto_export and (current is None or not self._export_ok(current) or current.format != settings.format
                                or current.bit_depth != settings.bit_depth):
                try:
                    [exported], _ = self._export_render(info.id, ["wet"], settings.format, settings.bit_depth, None)
                except ApiException as exc:
                    if exc.error.code not in ("export_dir_unavailable", "export_failed", "disk_full"):
                        raise
                    # The render and its take are safe; say why there's no file instead of losing the result.
                    info = self._visible(info)
                    return info.model_copy(update={"warnings": [*info.warnings, f"Not exported: {exc.error.message}"]})
                info = info.model_copy(update={"export": exported})
                self.library.update("renders", info.id, info=info.model_dump(mode="json"))
        return self._visible(info)

    def _add_take(self, info: RenderInfo, source: Source, preset: Preset | None) -> None:
        if source.info.name:
            title = source.info.name
        elif source.info.script:
            title = writer.display_title(source.info.script)
        else:
            title = "Untitled take"
        self.library.insert("takes", id=new_id("tak"), render_id=info.id, created_at=info.created_at, title=title,
                            script=source.info.script, preset_id=info.preset_id,
                            data={"source_kind": source.info.kind, "voice_id": source.info.voice_id,
                                  "preset_name": preset.name if preset else None})

    # -- STACK voices -----------------------------------------------------------------------------------

    def _stack_sources(self, main: Source, filled: RenderRequest) -> tuple[list[Source | None], list, list[str]]:
        """``stack[i]`` for ``filled.stack[i]``: a synthesized TTS voice on the same script, or None (pseudo-stack)."""
        sources: list[Source | None] = []
        keys: list[str | None] = []
        warnings: list[str] = []
        for sv in filled.stack or []:
            if not sv.voice_id or main.info.kind != "tts" or not main.info.script:
                sources.append(None)
                keys.append(None)
                continue
            key, src = self._stack_voice(main, sv.voice_id)
            if len(src.info.segments) != len(main.info.segments):
                warnings.append(f"Stack voice {sv.voice_id} has {len(src.info.segments)} segments, not "
                                f"{len(main.info.segments)}; using a detuned copy instead.")
                sources.append(None)
                keys.append(None)
                continue
            sources.append(src)
            keys.append(key)
        return sources, keys, warnings

    def _stack_voice(self, main: Source, voice_id: str) -> tuple[str, Source]:
        lexicon = self.lexicon()
        bpm = main.info.bpm
        if bpm is None:  # sources stored before v0.1 kept it only in their TTS request
            row = self.library.get("sources", main.info.id)
            bpm = (row["request"] if row else {}).get("bpm")
        req = TTSRequest(script=main.info.script, voice_id=voice_id, speed=main.info.speed or 0.9, bpm=bpm)
        key = request_hash("stack", {"script": req.script, "voice_id": voice_id, "speed": req.speed, "bpm": bpm,
                                     "lexicon": lexicon}, salt=self.voice_salt)
        with self._lock:
            hit = self._stack.touch(key)
        if hit is not None:
            return key, hit
        with self._keyed(key):  # a render racing the background prefetch waits for it instead of re-synthesizing
            return key, self._stack_voice_locked(key, req, lexicon, voice_id)

    def _stack_voice_locked(self, key: str, req: TTSRequest, lexicon: Lexicon, voice_id: str) -> Source:
        with self._lock:
            hit = self._stack.touch(key)
        if hit is not None:
            return hit
        entry = self.cache.lookup(key)
        arrays = self.cache.get_arrays(key) if entry else None
        if arrays is not None:
            src = Source(info=SourceInfo.model_validate(entry["meta"]["info"]), audio=arrays["audio"])
        else:
            try:
                with self._voice_lock(voice_id):
                    src = voice.synthesize(req, lexicon)
            except Exception as exc:
                raise _passthrough(exc, 500, "tts_failed", f"Stack voice {voice_id} failed", retryable=True) from exc
            src = Source(info=src.info.model_copy(update={"id": f"stack_{key[:12]}", "audio_id": ""}),
                         audio=_mono(src.audio))
            self.cache.put_arrays("stack", key, {"audio": src.audio}, meta={"info": src.info.model_dump(mode="json")})
            self.cache.prune()
        with self._lock:
            self._stack.put(key, src)
        return src

    # ------------------------------------------------------------------------------------------ exports

    def create_exports(self, req: ExportRequest) -> ExportResult:
        files: list[ExportedFile] = []
        warnings: list[str] = []
        for render_id in dict.fromkeys(req.render_ids):
            more, notes = self._export_render(render_id, req.variants, req.format, req.bit_depth, req.title,
                                              stems=req.stems)
            files += more
            warnings += [n for n in notes if n not in warnings]
        return ExportResult(files=files, warnings=warnings)

    def _export_render(self, render_id: str, variants: Iterable[str], fmt: str, bit_depth: int, title: str | None,
                       stems: bool = False, directory: Path | None = None,
                       root: Path | None = None) -> tuple[list[ExportedFile], list[str]]:
        """Write one render's variants (and stems) as one export group. Returns the files and any warnings."""
        row = self.library.get("renders", render_id)
        if row is None:
            raise NotFound("render", render_id)
        info = RenderInfo.model_validate(row["info"])
        filled = RenderRequest.model_validate(row["request"])
        items = [self._variant_item(row, info, filled, v) for v in dict.fromkeys(variants)]
        warnings: list[str] = []
        if stems:
            stem_items = self._stem_items(row, info, filled)
            if not stem_items:
                warnings.append("No stems: the sound engine doesn't produce them yet.")
            items += stem_items
        if not items:
            raise ApiException(422, "invalid_request", "Nothing to export.", hint="Pick at least one variant.")
        settings = self.settings()
        meta = row["meta"]
        export_meta = writer.ExportMeta(
            script=meta.get("script") or meta.get("source_name") or "take", preset=self._preset_label(info.preset_id),
            bpm=info.bpm, bars=info.bars, key=info.key, name=title, artist=settings.artist,
            render_params=_render_params(info, filled, self.fx_salt), pattern=settings.filename_pattern)
        directory = directory or self.export_root
        self._inside_root(directory, root)
        try:
            written = writer.export_files(directory, export_meta, items, fmt=fmt, bit_depth=bit_depth,
                                          channels=info.channels)
        except ValueError as exc:
            raise ApiException(422, "export_failed", f"Could not export: {exc}") from exc
        except Exception as exc:  # libsndfile (RuntimeError), mutagen and OS errors while writing
            raise _write_error(exc, "export_failed", "Could not write the export") from exc
        files = []
        for w in written:
            path = self._inside_root(w.path, root)
            f = ExportedFile(id=new_id("exp"), render_id=info.id, variant=w.variant, title=w.title,
                             filename=w.filename, path=str(path), format=fmt, sample_rate=w.sample_rate,
                             bit_depth=w.bit_depth, channels=w.channels, n_samples=w.frames,
                             duration_s=round(w.duration_s, 5), bpm=info.bpm, key=info.key, bars=info.bars,
                             first_word_s=info.first_word_s, tail_s=info.tail_s, size_bytes=w.bytes,
                             created_at=utcnow())
            self.library.insert("exports", id=f.id, render_id=info.id, created_at=f.created_at, path=f.path,
                                info=f.model_dump(mode="json"))
            files.append(f)
            if w.clipped_samples:
                warnings.append(f"{w.filename}: {w.clipped_samples} samples clipped at {w.bit_depth}-bit.")
        return files, warnings

    def _load_render_audio(self, audio_id: str | None) -> tuple[np.ndarray, int]:
        try:
            return self.audio.load(audio_id or "")
        except (FileNotFoundError, KeyError):
            raise ApiException(409, "render_missing", "This render's audio is gone.",
                               hint="Render it again, then export.") from None

    def _variant_item(self, row: dict, info: RenderInfo, filled: RenderRequest, variant: str) -> writer.ExportItem:
        if variant in ("wet", "dry"):
            audio, sr = self._load_render_audio(row["audio"].get(variant))
            return writer.ExportItem(variant, audio, sr)
        if variant.startswith("alt:") and variant[4:]:
            alt = self.preset(variant[4:])
            alt_req = _on_grid(filled, info).model_copy(update={
                "preset_id": alt.id, "chain": alt.chain, "macros": alt.macros, "macro_map": alt.macro_map,
                "stack": list(alt.stack), "quality": "final", "stems": False, "auto_export": False})
            out = self._rerender(info, alt_req)
            return writer.ExportItem(variant, as_channels_first(out.audio), out.sample_rate, preset=alt.name,
                                     render_params=_render_params(info, alt_req, self.fx_salt))
        raise ApiException(422, "invalid_request", f"Unknown export variant '{variant}'.",
                           hint="Use wet, dry or alt:<preset_id>.")

    def _stem_items(self, row: dict, info: RenderInfo, filled: RenderRequest) -> list[writer.ExportItem]:
        stored = row["audio"].get("stems") or {}
        if stored:
            return [writer.ExportItem(f"stem:{name}", *self._load_render_audio(aid)) for name, aid in stored.items()]
        out = self._rerender(info, _on_grid(filled, info).model_copy(update={"stems": True, "quality": "final",
                                                                               "auto_export": False}))
        return [writer.ExportItem(f"stem:{name}", as_channels_first(arr), out.sample_rate)
                for name, arr in (out.stems or {}).items() if name in STEM_NAMES]

    def _rerender(self, info: RenderInfo, req: RenderRequest) -> RenderOutput:
        """Render a variation of a stored render (alt preset, stems) without keeping it as a render."""
        try:
            source = self.load_source(info.source_id)
        except NotFound:
            raise ApiException(409, "source_missing", "The source of this render was deleted.",
                               hint="Alt presets and stems need the original source.") from None
        stack, _, _ = self._stack_sources(source, req)
        return self._run_fx(source, stack, req)

    def rekordbox(self, req: RekordboxRequest, directory: Path | None = None,
                  root: Path | None = None) -> RekordboxResult:
        ids = list(dict.fromkeys(req.export_ids))
        rows = self.library.by_ids("exports", ids)
        missing = [i for i in ids if i not in {r["id"] for r in rows}]
        if missing:
            raise NotFound("export", ", ".join(missing))
        files = [ExportedFile.model_validate(r["info"]) for r in rows]
        gone = [f.filename for f in files if not Path(f.path).is_file()]
        if gone:
            raise ApiException(409, "file_missing", f"Exported file(s) missing: {', '.join(gone)}.",
                               hint="Export them again, then rebuild the XML.")
        settings = self.settings()
        target = _target_root(req.target_path_root, 422, "invalid_request") or settings.rekordbox.target_path_root
        tracks = [self._rekordbox_track(f, settings) for f in files]
        root = root or self.export_root
        options = RekordboxOptions(
            local_root=root, target_path_root=target,
            hot_cue_first_word=settings.rekordbox.hot_cue_first_word,
            memory_cue_tail=settings.rekordbox.memory_cue_tail, product_version=VERSION)
        directory = Path(directory or root)
        self._inside_root(directory, root)  # checked before anything is written
        filename = f"{writer.slugify(req.playlist, max_words=8, max_len=48)}_rekordbox.xml"
        try:
            written = write_rekordbox_xml(directory / filename, tracks, req.playlist, options)
        except ValueError as exc:
            raise ApiException(422, "invalid_request", f"rekordbox.xml: {exc}") from exc
        except Exception as exc:
            raise _write_error(exc, "export_failed", "Could not write rekordbox.xml") from exc
        path = self._inside_root(written, root)
        return RekordboxResult(path=str(path), filename=filename, tracks=len(tracks), playlist=req.playlist)

    def _rekordbox_track(self, f: ExportedFile, settings: Settings) -> RekordboxTrack:
        render = self.library.get("renders", f.render_id)
        meta = render["meta"] if render else {}
        preset = meta.get("preset_name") or ""
        script = meta.get("script") or meta.get("source_name") or ""
        tail = f.tail_s
        if tail is None and render is not None:  # no ring-out reserved: mark where the last word ends
            ends = [seg["end_s"] for seg in render["info"].get("segments", [])]
            tail = max(ends) if ends else None
        return RekordboxTrack(
            path=Path(f.path), name=f.title, duration_s=f.duration_s, size=Path(f.path).stat().st_size, bpm=f.bpm,
            key=f.key, artist=settings.artist, album=writer.DEFAULT_ALBUM, grouping=preset, mix=f.variant,
            comments=f"[{preset}] {script}".strip() if preset else script, sample_rate=f.sample_rate,
            bit_depth=f.bit_depth, channels=f.channels, first_word_s=f.first_word_s, tail_s=tail)

    # ------------------------------------------------------------------------------------------ library

    def library_page(self, q: str | None, starred: bool | None, preset_id: str | None, limit: int,
                     offset: int) -> LibraryPage:
        rows, total = self.library.query_takes(q=q, starred=starred, preset_id=preset_id,
                                               limit=max(0, min(limit, 500)), offset=max(0, offset))
        return LibraryPage(items=[t for t in map(self._take, rows) if t is not None], total=total)

    def _take(self, row: dict[str, Any]) -> Take | None:
        render = self.library.get("renders", row["render_id"])
        if render is None:
            return None
        info = RenderInfo.model_validate(render["info"])
        exports = [f for f in (ExportedFile.model_validate(e["info"]) for e in
                               self.library.select("exports", "render_id = ?", (info.id,), order="created_at, rowid"))
                   if self._export_ok(f)]
        data = row["data"]
        return Take(id=row["id"], render_id=info.id, source_id=info.source_id, title=row["title"],
                    created_at=row["created_at"],
                    starred=row["starred"], tags=row["tags"], script=row["script"],
                    source_kind=data.get("source_kind", "tts"), voice_id=data.get("voice_id"),
                    preset_id=row["preset_id"], preset_name=data.get("preset_name"), bpm=info.bpm, bars=info.bars,
                    key=info.key, duration_s=info.duration_s, loudness=info.loudness, mask=info.mask,
                    audio_id=info.audio_id, peaks=info.peaks, exports=exports)

    def get_take(self, take_id: str) -> Take:
        row = self.library.get("takes", take_id)
        take = self._take(row) if row else None
        if take is None:
            raise NotFound("take", take_id)
        return take

    def update_take(self, take_id: str, patch: TakePatch) -> Take:
        self.get_take(take_id)
        changes = patch.model_dump(exclude_none=True)
        if "title" in changes and not changes["title"].strip():
            raise ApiException(422, "invalid_request", "A take needs a title.")
        self.library.update("takes", take_id, **changes)
        return self.get_take(take_id)

    def delete_take(self, take_id: str) -> None:
        row = self.library.get("takes", take_id)
        if row is None:
            raise NotFound("take", take_id)
        self.library.delete("takes", [take_id])
        # Exported files stay on disk (and in rekordbox.xml); the render's own audio goes with its last take.
        if self.library.count("takes", "render_id = ?", (row["render_id"],)) == 0:
            render = self.library.get("renders", row["render_id"])
            if render is not None:
                self._drop_render(render)

    # ------------------------------------------------------------------------------------------ batch

    def create_batch(self, req: BatchRequest) -> Job:
        name = req.playlist or f"Setlist {datetime.now():%Y-%m-%d %H%M}"
        root = self.export_root  # the whole Setlist goes where it started, even if Settings change meanwhile
        directory = writer.safe_path(root, writer.folder_name(name))
        labels = [line.title or line.script for line in req.lines]
        return _job(self.jobs.submit("batch", self._run_batch, req, directory, root, labels=labels,
                                     meta={"directory": str(directory)}))

    def _run_batch(self, ctx: JobContext, req: BatchRequest, directory: Path, root: Path) -> dict[str, Any]:
        with self._background():  # batch renders never hold up interactive previews
            return self._batch_lines(ctx, req, directory, root)

    def _batch_lines(self, ctx: JobContext, req: BatchRequest, directory: Path, root: Path) -> dict[str, Any]:
        export_ids: list[str] = []
        failures = 0
        for i, line in enumerate(req.lines):
            ctx.check()
            ctx.item(i, state="running", progress=0.05)
            try:
                arrange_patch = {k: v for k, v in {"bpm": line.bpm, "bars": line.bars, "key": line.key}.items()
                                 if v is not None}
                arrange = req.arrange.model_copy(update=arrange_patch)
                src = self.create_tts(TTSRequest(script=line.script, voice_id=line.voice_id or req.voice_id,
                                                 speed=req.speed, bpm=arrange.bpm, name=line.title))
                ctx.item(i, progress=0.35)
                ctx.check()
                info = self.render(RenderRequest(source_id=src.id, preset_id=line.preset_id or req.preset_id,
                                                 macros=req.macros, arrange=arrange, master=req.master,
                                                 quality="final", auto_export=False))
                ctx.item(i, progress=0.75)
                files, _ = self._export_render(info.id, req.export.variants, req.export.format,
                                               req.export.bit_depth, line.title, directory=directory, root=root)
                ids = [f.id for f in files]
                export_ids += ids
                ctx.add_results(ids)
                ctx.item(i, state=DONE, result_ids=ids)
            except Exception as exc:  # noqa: BLE001 - one bad line doesn't sink the setlist
                if ctx.cancelled:
                    raise
                failures += 1
                log.warning("batch line %d failed: %s", i, exc)
                ctx.item(i, state=ERROR, error=error_payload(exc, "line_failed"))
        if failures == len(req.lines):
            raise ApiException(500, "batch_failed", f"All {failures} lines failed.",
                               hint="Check the first line's error.")
        if req.playlist and export_ids:
            result = self.rekordbox(RekordboxRequest(export_ids=export_ids, playlist=req.playlist), directory, root)
            ctx.message(result.path)
        else:
            ctx.message(f"{len(export_ids)} files in {directory}")
        return {"export_ids": export_ids, "failures": failures}

    # ------------------------------------------------------------------------------------------ jobs

    def job(self, job_id: str) -> Job:
        job = self.jobs.get(job_id)
        if job is None:
            raise NotFound("job", job_id)
        return _job(job)

    def cancel_job(self, job_id: str) -> Job:
        self.job(job_id)
        self.jobs.cancel(job_id)
        return self.job(job_id)

    # ------------------------------------------------------------------------------------------ audio

    def audio_path(self, audio_id: str) -> Path:
        if not AudioStore.valid(audio_id):
            raise NotFound("audio", audio_id)
        path = self.audio.stream_path(audio_id)
        if path is None and audio_id.startswith("smp_"):
            if audio_id not in self._samples:
                self.list_voices()
            voice_id = self._samples.get(audio_id)
            if voice_id is not None:
                self._render_sample(audio_id, voice_id)
                path = self.audio.stream_path(audio_id)
        if path is None:
            raise NotFound("audio", audio_id)
        return path

    def _render_sample(self, audio_id: str, voice_id: str) -> None:
        try:
            with self._voice_lock(voice_id):
                sample = voice.voice_sample(voice_id)
        except Exception as exc:
            raise _passthrough(exc, 500, "tts_failed", "Voice sample failed", retryable=True) from exc
        self.audio.put(_mono(sample.audio), sample.info.sample_rate, audio_id=audio_id)

    def prerender_samples(self, recommended_only: bool = True) -> int:
        """Render missing audition clips (recommended voices by default); returns how many were rendered."""
        rendered = 0
        for v in self.list_voices():
            if self._closing.is_set():
                break
            sample_id = v.sample_audio_id
            if (recommended_only and not v.recommended) or not sample_id or not sample_id.startswith("smp_"):
                continue
            if self.audio.exists(sample_id):
                continue
            try:
                self._render_sample(sample_id, v.id)
                rendered += 1
            except Exception:  # noqa: BLE001 - that clip is rendered on first GET instead
                log.warning("audition clip for %s failed", v.id, exc_info=True)
        return rendered

    # ------------------------------------------------------------------------------------------ housekeeping

    def _drop_render(self, row: dict[str, Any]) -> None:
        audio = row["audio"]
        self.library.delete("renders", [row["id"]])
        self.audio.delete(audio.get("wet"), audio.get("dry"), *(audio.get("stems") or {}).values())
        with self._lock:
            for key in [k for k, v in self._renders.items() if v == row["id"]]:
                self._renders.pop(key, None)

    def _gc_previews(self) -> None:
        """Keep the newest previews (and any preview someone exported); the rest were knob-twiddling."""
        for row in self.library.select("renders", "quality = 'preview'", limit=-1, offset=self.config.preview_keep):
            if self.library.count("exports", "render_id = ?", (row["id"],)) == 0:
                self._drop_render(row)

    def _gc_sources(self) -> None:
        """Drop TTS sources beyond the most recently used ``source_keep`` that no render references. Recordings
        and imports are never collected: they can't be re-created."""
        for source_id, audio_id in self.library.stale_tts_sources(self.config.source_keep):
            self._drop_source({"id": source_id, "audio_id": audio_id})


# ---------------------------------------------------------------------------------------------- helpers


def _disk_full(exc: BaseException) -> bool:
    seen: set[int] = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        if isinstance(exc, OSError) and exc.errno == errno.ENOSPC or "No space left" in str(exc):
            return True
        exc = exc.__cause__ or exc.__context__
    return False


def _write_error(exc: Exception, code: str, what: str) -> ApiException:
    """A failed file write (OSError, libsndfile's RuntimeError, mutagen's errors) as the engine's error shape."""
    if isinstance(exc, ApiException):
        return exc
    if _disk_full(exc):
        return ApiException(500, "disk_full", f"{what}: the disk is full.", hint="Free up space, then try again.",
                            retryable=True)
    detail = getattr(exc, "strerror", None) or str(exc) or type(exc).__name__
    return ApiException(500, code, f"{what}: {detail}", retryable=True,
                        hint="Check the export folder in Settings and the free disk space.")


def _source_info(row: dict[str, Any]) -> SourceInfo:
    """SourceInfo as stored, with the live background states (WORLD analysis, transcript)."""
    return SourceInfo.model_validate({**row["info"], "analysis_state": row["analysis_state"],
                                      "transcript_state": row.get("transcript_state") or "none"})


def _timeline_digest(info: SourceInfo) -> str:
    """What fx reads from a source besides its audio: the script and the segments with their words and flags."""
    data = {"script": info.script, "segments": [s.model_dump(mode="json") for s in info.segments]}
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()[:16]


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


def _accepts(fn: Any, name: str) -> bool:
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return True
    return name in params or any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values())


def _fill(req: RenderRequest, preset: Preset | None, settings: Settings | None = None) -> tuple[RenderRequest, list[str]]:
    """Fill every None field from the preset. Arrange/Master fields the client didn't send come from the preset's
    hints, then from the saved Settings (master, default bpm/bars/key): client > preset hint > settings > model."""
    update: dict[str, Any] = {
        "chain": req.chain if req.chain is not None else (preset.chain if preset else Chain()),
        "macros": req.macros if req.macros is not None else (preset.macros if preset else Macros()),
        "macro_map": req.macro_map if req.macro_map is not None else (preset.macro_map if preset else MacroMap()),
        "stack": req.stack if req.stack is not None else (list(preset.stack) if preset else []),
    }
    warnings: list[str] = []
    defaults = {
        "arrange": ({"bpm": settings.default_bpm, "bars": settings.default_bars, "key": settings.default_key}
                    if settings else {}),
        "master": settings.master.model_dump() if settings else {},
    }
    for field, model in (("arrange", Arrange), ("master", Master)):
        current = getattr(req, field)
        hints = (preset.arrange_hint if field == "arrange" else preset.master_hint) if preset else {}
        unset = set(model.model_fields) - current.model_fields_set
        from_settings = {k: v for k, v in defaults[field].items() if k in unset}
        from_hints = {k: v for k, v in hints.items() if k in unset}
        if not (from_settings or from_hints):
            continue
        base = {**current.model_dump(), **from_settings}
        try:
            update[field] = model.model_validate({**base, **from_hints})
        except ValidationError:
            warnings.append(f"Preset {preset.id if preset else ''} has an invalid {field} hint; ignored.")
            update[field] = model.model_validate(base)
    return req.model_copy(update=update), warnings


def _render_params(info: RenderInfo, req: RenderRequest, fx_salt: str) -> dict[str, Any]:
    """What goes into the TXXX:FVWKS_RENDER tag: enough to reproduce the file."""
    return {
        "engine": VERSION, "fx": fx_salt, "render_id": info.id, "preset_id": req.preset_id,
        "request": req.model_dump(mode="json", exclude={"source_id", "auto_export"}),
        "bars": info.bars,  # the count "auto" resolved to
        "resolved_chain": info.resolved_chain.model_dump(mode="json") if req.preset_id == info.preset_id else None,
        "loudness": info.loudness.model_dump(mode="json"), "mask": info.mask.model_dump(mode="json"),
        "fit": info.fit.model_dump(mode="json"),
    }


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
