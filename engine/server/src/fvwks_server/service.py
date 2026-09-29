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

import base64
import errno
import hashlib
import inspect
import io
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
import soundfile as sf
from pydantic import ValidationError

from fvwks_contracts.models import (
    DEFAULT_LEXICON,
    Arrange,
    BassGroove,
    BassPatch,
    BatchRequest,
    Chain,
    DrumKit,
    ExportedFile,
    ExportRequest,
    ExportResult,
    FlipStyle,
    GrooveRenderRequest,
    GrooveRenderResult,
    Health,
    Job,
    Lexicon,
    LibraryPage,
    MashMatch,
    MashScanRequest,
    MashScanResult,
    Remix,
    RemixClip,
    RemixCreate,
    RemixExportRequest,
    RemixExportResult,
    RemixBuildRequest,
    RemixLane,
    RemixPrefs,
    RemixPrefsResult,
    RemixTake,
    RemixUpdate,
    TakeChoice,
    TakeFeedback,
    TakeFeedbackCreate,
    MacroMap,
    Macros,
    Master,
    MixInfo,
    MixRequest,
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
    Segment,
    Song,
    SongLyrics,
    SongStem,
    SongStructure,
    SongWord,
    StemFeatures,
    SongAnalysis,
    SongCue,
    SamplePack,
    SamplePackAdd,
    SamplePackUpdate,
    RekordboxEntry,
    RekordboxImportRequest,
    RekordboxLibrary,
    RekordboxPlaylist,
    SongSection,
    SongPlacement,
    SongUpdate,
    SourceInfo,
    SourceList,
    StemInfo,
    Take,
    TakePatch,
    TTSRequest,
    Voice,
)
from fvwks_contracts.audio import STANDARD_BARS, resample
from fvwks_contracts.seam import ENGINE_SR, MashFeatures, RenderOutput, Source
from fvwks_fx import api as fx
from fvwks_voice import api as voice

from . import manifest as model_manifest
from . import takes as take_weights
from . import rekordbox as rbx
from . import writer
from .audio_io import AudioStore, as_channels_first, peaks, sweep_partials
from .config import VERSION, Config
from .errors import ApiException, NotFound
from .jobs import DONE, ERROR, JobCancelled, JobContext, JobRunner, error_payload
from .library import ArtifactCache, Library, audio_hash, new_id, request_hash, utcnow
from .masks import MaskStore
from .sample_packs import PackStore, check_folder
from .music import key_name
from .rekordbox import RekordboxOptions, RekordboxTrack, write_rekordbox_xml

log = logging.getLogger("fvwks.engine")

STEM_NAMES = ("dry", "voice", "layers", "fx")
MAX_UPLOAD_BYTES = 200 << 20
MAX_SONG_BYTES = 400 << 20  # v0.7 songs: a 15-minute WAV at 48 kHz/24-bit is ~260 MB
MAX_SONG_S = 15 * 60
MIX_KEEP = 8  # newest song mixes kept; they're re-creatable (and a whole-song mix is big)
DISK_RESERVE = 5_000_000_000  # free space that must remain after a model download
TRANSCRIBE_MODEL = "whisper-aligner"  # the voice package's model behind transcribe()/realign() (v0.3)
GATE_FOR_ENGINE = {"kokoro": "kokoro", "qwen3": "persona", "asr": "aligner", "denoise": "ingest",
                   "demucs": "stems", "stems": "stems"}  # ModelInfo.engine
STEM_TRACKS = ("drums", "bass", "vocals", "other")  # v0.9 STEM_NAMES, in order
STEM_FPS = 60.0
REMIX_SR = 48_000  # prepared remix clips and mixdowns
LYRICS_WINDOW_S = 240.0  # v0.10: the transcriber takes up to 5 minutes at a time; longer songs go in windows
LYRICS_SEEK_S = 40.0  # each window ends at the quietest half second of its last LYRICS_SEEK_S
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
                             "ingest": PriorityLock(), "stems": PriorityLock()}
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
        # v0.7 songs: the user's own tracks, kept at their own rate under <data>/songs/, apart from engine audio
        self.song_audio = AudioStore(config.data_dir, folder="songs")
        self.masks = MaskStore(config.data_dir)  # v0.11.6 camera face masks
        self.packs = PackStore(config.data_dir)  # v0.15 the user's drum sample packs
        self._sync_packs(invalidate=False)
        self._songs: _LRU = _LRU(1)  # song id → (audio, sr); a decoded 15-minute song is ~300 MB
        self._song_lock = threading.Lock()  # read-modify-write of song rows (analysis job vs PATCH)
        self._remix_lock = threading.Lock()  # read-modify-write of remix rows (jobs vs PATCH)
        self._previews: dict[str, tuple[str, str]] = {}  # pvw_ audio id → (patch | kit, id); fvwks_synth renders it
        self._rekordbox: dict[str, tuple[float, dict[str, dict]]] = {}  # v0.12: library id → (made at, entry id → TRACK)
        if synth := _synth():
            synth.bass.configure(self.config.data_dir / "synth")  # Surge's own folders stay in the engine's data
        # fx keeps its WORLD analyses in memory, so none survive a restart (and a job killed mid-way left its row
        # "queued"/"running"): start every source at "none" and analyse again on first use.
        self.library.reset_analysis_states()
        self.library.reset_transcript_states()  # transcripts are stored; only unfinished jobs start over
        for song_id in self.library.unfinished_song_analyses():  # song analyses are stored too
            self._queue_song_analysis(song_id)
        for row in self.library.select("songs"):  # a separation or transcription never finished: ask again
            if row["info"].get("stems_state") in ("queued", "running"):
                self._set_song(row["id"], stems_state="none")
            if row["info"].get("lyrics_state") in ("queued", "running"):
                self._set_song(row["id"], lyrics_state="none")
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
                        if loaded.filename_pattern == writer.OLD_DEFAULT_PATTERN:  # 1.2.2: the words lead now
                            loaded.filename_pattern = writer.DEFAULT_PATTERN
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
            chop=getattr(out, "chop", None),  # v0.8: where each chopped piece landed
        )
        meta = {"script": source.info.script or " ".join(g.text for g in source.info.segments if g.text) or None, "source_name": source.info.name, "source_kind": source.info.kind,
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

    # ------------------------------------------------------------------------------------------ songs (v0.7)

    def upload_song(self, data: bytes, filename: str | None, name: str | None) -> Song:
        """Import a track: decoded once, kept at its own rate (FLAC-24 when it fits), analysed in the background."""
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
        return self._store_song(audio, int(sr), name)[0]

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

    # -- Rekordbox library import (v0.12) -----------------------------------------------------------------------

    REKORDBOX_TTL_S, MAX_REKORDBOX_XML = 1800.0, 100 << 20

    # -- the user's drum sample packs (v0.15) -------------------------------------------------------------------

    def list_sample_packs(self) -> list[SamplePack]:
        return [self.packs.info(p) for p in self.packs.list()]

    def add_sample_pack(self, req: SamplePackAdd) -> Job:
        """POST /sample-packs: the picked folder (the path gate: local, resolved, a folder) scanned for one-shots."""
        return self._scan_job(self.packs.save(self.packs.new(check_folder(req.folder), req.name)))

    def rescan_sample_pack(self, pack_id: str) -> Job:
        """POST /sample-packs/{id}/rescan: read its folder again (a renamed file names its role again)."""
        pack = self.packs.get(pack_id)
        check_folder(pack["folder"])
        return self._scan_job(pack)

    def update_sample_pack(self, pack_id: str, req: SamplePackUpdate) -> SamplePack:
        pack = self.packs.get(pack_id)
        if req.name is not None:
            pack["name"] = req.name.strip()[:80] or pack["name"]
        if req.enabled is not None:
            pack["enabled"] = req.enabled
        self.packs.save(pack)
        self._sync_packs()
        return self.packs.info(pack)

    def delete_sample_pack(self, pack_id: str) -> None:
        """Forget it: its files are never touched."""
        self.packs.delete(pack_id)
        self._sync_packs()

    def _scan_job(self, pack: dict) -> Job:
        from fvwks_synth import oneshots

        try:
            files = oneshots.candidates(pack["folder"])
        except OSError:
            raise ApiException(404, "missing", "That folder isn't there any more.", hint="Plug its drive in, or pick it again.") from None
        return _job(self.jobs.submit("sample_scan", self._scan_pack, pack, files, lane="import",
                                     labels=[f.name[:200] for f in files]))

    def _scan_pack(self, ctx: JobContext, pack: dict, files: list[Path]) -> dict[str, Any]:
        """One item per audio file (its name): done, or error with the reason as the code. Paths are logged nowhere."""
        from fvwks_synth import oneshots

        samples = []
        for i, f in enumerate(files):
            ctx.check()
            ctx.progress(i / max(1, len(files)), f"Reading {i + 1} of {len(files)}")
            shot, why = oneshots.check(f)
            if shot is None:
                ctx.item(i, state="error", error={"code": why, "message": _PACK_SKIP[why], "hint": None, "retryable": False})
                continue
            samples.append({"path": str(shot.path), "role": shot.role, "name": shot.name})
            ctx.item(i, state="done", progress=1.0)
        pack["samples"] = samples
        self.packs.save(pack)
        ctx.add_results([pack["id"]])
        self._sync_packs()
        ctx.progress(1.0, f"{len(samples)} one-shots")
        return {"pack_id": pack["id"]}

    def _sync_packs(self, invalidate: bool = True) -> None:
        """The enabled packs whose folder is there replace the bundled one-shots for their roles (fvwks_synth.layers).
        When that changes the sound, the remixes' kit clips prepare again."""
        try:
            from fvwks_synth import layers
        except ImportError:
            return
        before = layers.bank_version()
        layers.set_user_samples(self.packs.active())
        if not invalidate or layers.bank_version() == before:
            return
        with self._remix_lock:
            for row in self.library.select("remixes"):
                cur = Remix.model_validate(row["info"])
                if not any(c.src.kind == "kit" and c.audio_id for lane in cur.lanes for c in lane.clips):
                    continue
                lanes = [lane.model_copy(update={"clips": [c.model_copy(update={"audio_id": None}) if c.src.kind == "kit" else c
                                                           for c in lane.clips]}) for lane in cur.lanes]
                self.library.update("remixes", cur.id, info=cur.model_copy(update={"lanes": lanes}).model_dump(mode="json"))

    def rekordbox_library(self, data: bytes) -> RekordboxLibrary:
        """POST /rekordbox/library: the uploaded rekordbox.xml's tracks (an opaque id each, their grid, key and cues, and
        whether the file is on this Mac) and playlists, kept 30 min for the import. No path is returned or logged."""
        if len(data) > self.MAX_REKORDBOX_XML:
            raise ApiException(413, "file_too_large", "This rekordbox.xml is over 100 MB.",
                               hint="Export a playlist's tracks instead of the whole collection.")
        try:
            tracks, playlists = rbx.read_library(data)
        except ValueError:
            raise ApiException(400, "bad_xml", "This isn't a Rekordbox library file.",
                               hint="In Rekordbox: File > Export Collection in xml format.") from None
        known = self.library.get_setting("rekordbox_songs", {})
        by_id: dict[str, dict] = {}
        entries = []
        for t in tracks:
            eid = rbx.entry_id(t.get("Location", ""))
            if eid in by_id:
                continue
            by_id[eid] = t
            path, _ = rbx.local_audio_path(t.get("Location", ""))
            grid, bpm, _ = rbx.grid_of(t["tempo"])
            song_id = known.get(eid)
            entries.append(RekordboxEntry(
                id=eid, title=(t.get("Name") or "Untitled").strip()[:200] or "Untitled", artist=(t.get("Artist") or None),
                duration_s=max(0.0, _num(t.get("TotalTime"))), bpm=bpm or (_num(t.get("AverageBpm")) or None),
                key=_key(t.get("Tonality")), grid=grid, cues=len(rbx.cues_of(t["marks"])), available=path is not None,
                song_id=song_id if song_id and self.library.get("songs", song_id) else None))
        lists = [RekordboxPlaylist(name=p["name"] or "Playlist", folders=p["folders"],
                                   track_ids=[e for e in (rbx.entry_id(loc) for loc in p["locations"]) if e in by_id])
                 for p in playlists]
        lib_id = new_id("rbx")
        with self._lock:
            now = time.monotonic()
            live = sorted(((k, v) for k, v in self._rekordbox.items() if now - v[0] < self.REKORDBOX_TTL_S),
                          key=lambda kv: kv[1][0])[-2:]  # at most 3 held (they can be big)
            self._rekordbox = {**dict(live), lib_id: (now, by_id)}
        return RekordboxLibrary(id=lib_id, tracks=entries, playlists=lists, missing=sum(not e.available for e in entries))

    def import_rekordbox(self, req: RekordboxImportRequest) -> Job:
        """POST /rekordbox/import: the chosen tracks become Songs (a rekordbox_import job, its own lane)."""
        with self._lock:
            held = self._rekordbox.get(req.library_id)
        if held is None or time.monotonic() - held[0] > self.REKORDBOX_TTL_S:
            raise ApiException(404, "library_expired", "This Rekordbox library has expired.",
                               hint="Choose the rekordbox.xml again.")
        unknown = [t for t in req.track_ids if t not in held[1]]
        if unknown:
            raise ApiException(422, "invalid_request", f"{len(unknown)} of these tracks aren't in this library.")
        tracks = {t: held[1][t] for t in dict.fromkeys(req.track_ids)}
        return _job(self.jobs.submit("rekordbox_import", self._import_rekordbox, tracks, lane="import",
                                     labels=[(t.get("Name") or "Untitled").strip()[:200] or "Untitled" for t in tracks.values()]))

    def _import_rekordbox(self, ctx: JobContext, tracks: dict[str, dict]) -> dict[str, Any]:
        """One job item per track (its title): done with its song id, or error with the skip reason as the code; the
        job's result_ids are every song imported or refreshed."""
        done: list[str] = []
        for i, (eid, t) in enumerate(tracks.items()):
            ctx.check()
            ctx.progress(i / len(tracks), f"Importing {i + 1} of {len(tracks)}")
            ctx.item(i, state="running")
            try:
                song, _ = self._import_track(t)
            except _Skip as skip:
                log.info("rekordbox import: %s skipped (%s)", eid, skip.reason)  # the entry id, never the path
                ctx.item(i, state="error", error={"code": skip.reason, "message": _SKIPPED[skip.reason], "hint": None,
                                                  "retryable": skip.reason == "missing"})
                continue
            if song.id not in done:
                ctx.add_results([song.id])  # appends: each song once
                done.append(song.id)
            ctx.item(i, state="done", progress=1.0, result_ids=[song.id])
            known = self.library.get_setting("rekordbox_songs", {})
            self.library.set_setting("rekordbox_songs", {**known, eid: song.id})
        ctx.progress(1.0, "Imported")
        return {"song_ids": done}

    def _import_track(self, t: dict) -> tuple[Song, bool]:
        """One TRACK: its local audio file (the path gate in rekordbox.local_audio_path), decoded with the upload's
        limits (pedalboard: AAC / M4A too), stored under its XML title with its grid, key and cues."""
        path, why = rbx.local_audio_path(t.get("Location", ""))
        if path is None:
            raise _Skip(why)
        if path.stat().st_size > MAX_SONG_BYTES:
            raise _Skip("too_large")
        try:
            from pedalboard.io import AudioFile

            with AudioFile(str(path)) as f:
                if f.samplerate <= 0 or f.frames / f.samplerate > MAX_SONG_S:
                    raise _Skip("too_long")
                audio, sr = np.ascontiguousarray(f.read(f.frames), np.float32), int(f.samplerate)
        except _Skip:
            raise
        except Exception:  # noqa: BLE001  not audio after all, or damaged
            raise _Skip("unreadable") from None
        if audio.shape[-1] == 0 or not np.isfinite(audio).all():
            raise _Skip("unreadable")
        if audio.shape[0] > 2:
            raise _Skip("unsupported")
        grid, bpm, down = rbx.grid_of(t["tempo"])
        key = _key(t.get("Tonality"))
        analysis = SongAnalysis(bpm=bpm, bpm_confidence=1.0, key=key, key_confidence=1.0 if key else 0.0,
                                downbeat_s=down, source="rekordbox") if grid == "fixed" else None
        length = audio.shape[-1] / sr
        cues = [SongCue.model_validate(c) for c in rbx.cues_of(t["marks"]) if c["start_s"] <= length]
        name = (t.get("Name") or "").strip()[:200] or "Untitled"
        return self._store_song(audio, sr, name, analysis=analysis, cues=cues, cache=False)

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
        """The song, its audio and every mix of it."""
        row = self.library.get("songs", song_id)
        if row is None:
            raise NotFound("song", song_id)
        for job in self.jobs.list(kind="song_analysis", active_only=True):
            if job.meta.get("song_id") == song_id:
                self.jobs.cancel(job.id)
        for kind in ("song_stems", "song_lyrics"):
            for job in self.jobs.list(kind=kind, active_only=True):
                if job.meta.get("song_id") == song_id:
                    self.jobs.cancel(job.id)
        for mix in self.library.select("mixes", "song_id = ?", (song_id,)):
            self._drop_mix(mix)
        self.library.delete("songs", [song_id])
        self.song_audio.delete(row["audio_id"], *(s.get("audio_id") for s in row["info"].get("stems") or []))
        with self._lock:
            self._songs.pop(song_id, None)

    def mix_song(self, req: MixRequest) -> MixInfo:
        return self._mix(req.render_id, req.placement, req.quality)

    # -- stems (v0.9, VISUALS) ------------------------------------------------------------------------------

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
        try:  # the timed words from the vocals stem, queued behind this on the songs lane: lyrics come with the split,
            self.request_lyrics(song_id)  # never a separate click (the user). No transcriber or its model: the
        except ApiException:  # LYRICS button says so when asked
            pass
        return {"song_id": song_id}

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

    # -- structure and lyrics (v0.10, SMART VISUALS) ------------------------------------------------------------

    def _structure(self, song: Song, audio: np.ndarray | None, sr: int, stems: dict[str, np.ndarray] | None,
                   *, with_stems: bool = True) -> SongStructure | None:
        """S2's sections, drops and phrases on the song's grid (the user's BPM and bar 1 when set), refined with the
        stems when there are any. None without the hook, or when it fails: a song without a structure still plays,
        mixes and exports."""
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
                structure = SongStructure.model_validate(make(audio, sr, grid, stems=stems or None))
                self._cache_mash(song, grid, structure, audio, sr, (stems or {}).get("vocals"))
            return structure
        except Exception:  # noqa: BLE001
            log.exception("song structure failed for %s", song.id)
            return None

    @staticmethod
    def _grid(song: Song) -> SongAnalysis:
        """The song's analysis with the user's BPM and bar 1, when set."""
        return song.analysis.model_copy(update={k: v for k, v in (("bpm", song.bpm_override),
                                                                 ("downbeat_s", song.downbeat_override_s)) if v is not None})

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

    # -- MASH RADAR (v0.11.3, REMIX) -----------------------------------------------------------------------------

    def _mash_key(self, song: Song, grid: SongAnalysis, structure: SongStructure) -> str:
        vocals = next((s.audio_id for s in song.stems if s.name == "vocals"), None)
        return request_hash("mash_features", {"audio": song.audio_id, "grid": grid.model_dump(mode="json"),
                                              "structure": structure.model_dump(mode="json"), "vocals": vocals},
                            salt=self.fx_salt)

    def _cache_mash(self, song: Song, grid: SongAnalysis, structure: SongStructure, audio: np.ndarray, sr: int,
                    vocals: np.ndarray | None) -> None:
        """S2's per-part MASH RADAR features, cached next to the song whenever its structure is computed (analysis,
        stems, a grid change): a scan only ever reads this cache."""
        make = getattr(fx, "mash_features", None)
        if not callable(make):
            return
        try:
            feats = make(audio, sr, grid, structure, vocals=vocals)
            self.cache.put_arrays("mash_features", self._mash_key(song, grid, structure), feats, artifact_id=song.id)
        except Exception:  # noqa: BLE001
            log.exception("mash features failed for %s", song.id)

    def _mash_cached(self, song: Song) -> dict[str, np.ndarray] | None:
        if song.analysis is None or song.structure is None:
            return None
        return self.cache.get_arrays(self._mash_key(song, self._grid(song), song.structure))

    def mash_scan(self, req: MashScanRequest) -> MashScanResult:
        """POST /mash/scan (synchronous): the other songs' parts that fit one part of this song, from cached features
        only. Songs without them are listed in `missing` and queued (the features come with their structure)."""
        scan = getattr(fx, "mash_scan", None)
        if not callable(scan) or not callable(getattr(fx, "mash_features", None)):
            raise ApiException(501, "not_implemented", "MASH RADAR arrives with the sound engine's REMIX update.")
        self.get_song(req.song_id)  # 404
        library: list[MashFeatures] = []
        missing: list[str] = []
        for row in self.library.select("songs", order=""):
            song = self._song(row)
            feats = self._mash_cached(song)
            if feats is None:
                missing.append(song.id)
                if song.analysis_state == "done":
                    self._queue_structure(song.id)
                continue
            library.append(MashFeatures(song_id=song.id, analysis=self._grid(song), structure=song.structure, feats=feats))
        query = next((m for m in library if m.song_id == req.song_id), None)
        if query is None:
            return MashScanResult(missing=missing)
        return MashScanResult(matches=[MashMatch.model_validate(m, from_attributes=True) for m in scan(req, query, library)],
                              missing=missing)

    # -- REMIX (v0.11, 1.6): the arrangement library ---------------------------------------------------------------

    def create_remix(self, req: RemixCreate) -> Remix:
        """POST /remixes: a new remix of song A (and B for a mashup) at A's tempo and key, empty until built. The
        recipes cut stems, so separating them starts now for sources that have none."""
        slots = sorted(s.slot for s in req.sources)  # (a mashup's `mash` is B's part LINE IT UP chose)
        if slots != (["A", "B"] if req.recipe == "mashup" else ["A"]):
            raise ApiException(422, "invalid_request", "A mashup takes songs A and B; VIP and FLIP take song A only.")
        songs = {s.slot: self.get_song(s.song_id) for s in req.sources}
        a = songs["A"]
        grid = self._grid(a) if a.analysis else None
        now = utcnow()
        remix = Remix(id=new_id("rmx"), name=(req.name or "").strip() or f"{a.name} {req.recipe.upper()}", recipe=req.recipe,
                      sources=req.sources, bpm=grid.bpm if grid else 140.0, key=a.key_override or (grid.key if grid else None),
                      mash=req.mash, seed=req.seed, created_at=now, updated_at=now)
        self.library.insert("remixes", id=remix.id, name=remix.name, created_at=now, info=remix.model_dump(mode="json"))
        for song in songs.values():
            if song.stems_state in ("none", "error"):
                try:
                    self.request_stems(song.id)  # its structure (and MASH features) come again with the stems
                except ApiException:  # no separator in this engine: BUILD says so
                    pass
            elif song.analysis_state == "done" and self._mash_cached(song) is None:
                self._queue_structure(song.id)
        return remix

    def list_remixes(self, song_id: str | None = None, recipe: str | None = None) -> list[Remix]:
        """GET /remixes, optionally only those of one song (in any slot) and / or recipe (v0.11.9: RESUME)."""
        remixes = [Remix.model_validate(r["info"]) for r in self.library.select("remixes")]
        return [r for r in remixes if (song_id is None or any(s.song_id == song_id for s in r.sources))
                and (recipe is None or r.recipe == recipe)]

    def get_remix(self, remix_id: str) -> Remix:
        row = self.library.get("remixes", remix_id)
        if row is None:
            raise NotFound("remix", remix_id)
        return Remix.model_validate(row["info"])

    def update_remix(self, remix_id: str, body: RemixUpdate) -> Remix:
        """PATCH: the whole arrangement at the rev it was edited from (a stale rev is 409, so edits never overwrite
        each other). A clip keeps its prepared audio only while it sounds the same."""
        fields = body.model_fields_set - {"rev"}
        required = {"name", "bpm", "sections", "lanes", "seed", "takes", "top_layers"}  # null there: unchanged; elsewhere clears
        update = {k: getattr(body, k) for k in fields if not (k in required and getattr(body, k) is None)}
        with self._remix_lock:
            cur = self.get_remix(remix_id)
            if body.rev != cur.rev:
                raise ApiException(409, "remix_conflict", "This remix changed since it was loaded.",
                                   hint="Reload it, then edit again.")
            if "takes" in update:  # the takes to keep: renamed / starred; a seed left out goes; the rest stays as BUILD made it
                keep = {e.seed: e for e in update["takes"]}
                update["takes"] = [t.model_copy(update={"name": keep[t.seed].name, "starred": keep[t.seed].starred})
                                   for t in cur.takes if t.seed in keep]
            built_rev = self.library.get_setting("remix_built_rev", {}).get(remix_id, {}).get(str(cur.seed))
            edited = cur.rev != built_rev or "sections" in update or "lanes" in update
            if update.get("seed", cur.seed) != cur.seed and edited:  # v0.11.9: switching away saves an edited take
                shown = cur.model_copy(update={k: update[k] for k in ("sections", "lanes") if k in update})
                saved = {"sections": shown.sections, "lanes": _keep_prepared(cur, shown)}
                update["takes"] = [t.model_copy(update=saved) if t.seed == cur.seed else t for t in update.get("takes", cur.takes)]
            new = cur.model_copy(update=update)
            new = Remix.model_validate({**new.model_dump(), "lanes": _keep_prepared(cur, new), "rev": cur.rev + 1,
                                        "updated_at": utcnow()})
            self.library.update("remixes", remix_id, name=new.name, info=new.model_dump(mode="json"))
            return new

    def _remix_engine(self):
        try:
            from fvwks_fx import remix as engine
        except ImportError:
            raise ApiException(501, "not_implemented", "REMIX arrives with the sound engine's 1.6 update.") from None
        return engine

    def _remix_sources(self, remix: Remix) -> dict[str, Any]:
        """slot → SongInput (the song with its analysis and structure, its four stems at their rate)."""
        engine = self._remix_engine()
        out = {}
        for src in remix.sources:
            song = self.get_song(src.song_id)
            if song.analysis is None or song.structure is None:
                raise ApiException(409, "song_not_ready", f"{song.name} is still being analysed.",
                                   hint="Try again once its analysis is done.", retryable=True)
            if song.stems_state != "done" or not song.stems:
                running = song.stems_state in ("queued", "running")
                raise ApiException(409, "stems_not_ready", f"{song.name}'s stems are still being separated." if running
                                   else f"{song.name} has no stems yet.", hint=None if running else "Separate its stems first.",
                                   retryable=running)
            loaded = {s.name: self._load_stem(s.audio_id) for s in song.stems}
            sr = next(iter(loaded.values()))[1]
            extra = {}
            if song.lyrics_state == "done" and "words" in inspect.signature(engine.SongInput).parameters:  # S2's seam
                stored = (self.library.get("songs", song.id) or {}).get("lyrics")
                extra["words"] = SongLyrics.model_validate(stored).words if stored else None
            out[src.slot] = engine.SongInput(song=song.model_copy(update={"analysis": self._grid(song)}),
                                             stems={k: a for k, (a, _) in loaded.items()}, sr=sr, **extra)
        return out

    def _set_remix(self, remix_id: str, bump: bool = False, **update: Any) -> Remix | None:
        with self._remix_lock:
            row = self.library.get("remixes", remix_id)
            if row is None:
                return None
            cur = Remix.model_validate(row["info"])
            new = cur.model_copy(update={**update, **({"rev": cur.rev + 1, "updated_at": utcnow()} if bump else {})})
            self.library.update("remixes", remix_id, name=new.name, info=new.model_dump(mode="json"))
            return new

    def build_remix(self, remix_id: str, req: RemixBuildRequest | None = None) -> Job:
        """POST /remixes/{id}/build: the recipe → a draft arrangement (a remix_build job). It replaces the sections and
        lanes (a new rev); a mashup lines up on Remix.mash, or the best match S2's build finds. v0.11.9: a take with a
        saved arrangement gets it back instead (unless `fresh`), its clips keeping their prepared audio."""
        self._remix_engine()
        self.get_remix(remix_id)
        self._set_remix(remix_id, build_state="queued")
        fresh = bool(req and req.fresh)
        return _job(self.jobs.submit("remix_build", self._build_remix, remix_id, fresh, lane="remix",
                                     dedupe_key=f"remix_build:{remix_id}", meta={"remix_id": remix_id}))

    def _build_remix(self, ctx: JobContext, remix_id: str, fresh: bool = False) -> dict[str, Any] | None:
        try:
            remix = self._set_remix(remix_id, build_state="running")
            if remix is None:
                return None
            saved = next((t for t in remix.takes if t.seed == remix.seed and t.lanes is not None), None)
            if saved and not fresh:  # the take's own arrangement, as it was left (audio that's since been evicted goes)
                lanes = [lane.model_copy(update={"clips": [c.model_copy(update={"audio_id": c.audio_id if c.audio_id and
                         self.song_audio.exists(c.audio_id) else None}) for c in lane.clips]}) for lane in saved.lanes]
                self._built(self._set_remix(remix_id, bump=True, build_state="done", sections=saved.sections or [],
                                            lanes=lanes))
                return {"remix_id": remix_id}
            if saved:  # fresh: the edits go; the take's recorded choices rebuild it
                remix = remix.model_copy(update={"takes": [t.model_copy(update={"sections": None, "lanes": None})
                                                           if t.seed == remix.seed else t for t in remix.takes]})
            sources = self._remix_sources(remix)
            ctx.check()
            engine = self._remix_engine()
            # M4.3: a kept take replays its choices; a new seed draws them from the ratings (the style's, when known)
            take = next((t for t in remix.takes if t.seed == remix.seed), None)
            style = take.style if take else _take_style(remix)
            prefs = [self._remix_prefs(style)] if style else self.remix_prefs().styles
            choose, made = take_weights.chooser(remix.seed, take.choices if take else [], prefs)
            extra = {"choose": choose} if "choose" in inspect.signature(engine.run).parameters else {}  # S2's seam
            with self._fx_background:
                out = engine.run(remix, sources, stage="build", match=remix.mash,
                                 progress=lambda f, m: (ctx.check(), ctx.progress(f, m)), **extra)
        except Exception:
            self._set_remix(remix_id, build_state="error")
            raise
        built = out.remix
        mine = next((t for t in built.takes if t.seed == remix.seed), None)  # S2's BUILD records the take it made
        style = mine.style if mine else built.flip.style_id if built.flip else style or built.recipe
        record = RemixTake(seed=remix.seed, style=style, created_at=utcnow(),
                           choices=mine.choices if mine and mine.choices else [TakeChoice(axis=a, option=o) for a, o in made.items()])
        if take:
            record = take.model_copy(update={"style": record.style, "choices": record.choices, "sections": None, "lanes": None})
        with self._remix_lock:  # the takes as they are now (a PATCH may have renamed one meanwhile)
            now = self.get_remix(remix_id).takes
            takes = [record if t.seed == remix.seed else t for t in now] + ([] if any(t.seed == remix.seed for t in now) else [record])
        self._built(self._set_remix(remix_id, bump=True, build_state="done", bpm=built.bpm, key=built.key,
                                    sections=built.sections, lanes=built.lanes, bass_patch_id=built.bass_patch_id,
                                    flip=built.flip, mash=built.mash, takes=takes))
        return {"remix_id": remix_id}

    def _built(self, remix: Remix | None) -> None:
        """The rev a take's arrangement had as BUILD left it (a build or a restore), so switching away saves it only when
        it's been edited since (1.5.1: a ROLL marked take 1 EDITED untouched)."""
        if remix is not None:
            revs = self.library.get_setting("remix_built_rev", {})
            self.library.set_setting("remix_built_rev", {**revs, remix.id: {**revs.get(remix.id, {}), str(remix.seed): remix.rev}})

    def prepare_remix(self, remix_id: str) -> Job:
        """POST /remixes/{id}/prepare: every clip without audio rendered at the remix tempo and key (a remix_prepare
        job), cached by what it sounds like, so the app only schedules clips. Sets audio_ids (no new rev)."""
        self._remix_engine()
        self.get_remix(remix_id)
        return _job(self.jobs.submit("remix_prepare", self._prepare_remix, remix_id, lane="remix",
                                     dedupe_key=f"remix_prepare:{remix_id}", meta={"remix_id": remix_id}))

    def _clip_audio(self, key: str) -> str | None:
        hit = self.cache.lookup(key)
        audio_id = (hit or {}).get("artifact_id")
        return audio_id if audio_id and self.song_audio.exists(audio_id) else None

    def _prepare_remix(self, ctx: JobContext, remix_id: str) -> dict[str, Any] | None:
        """Clips already rendered (by clip_key) get their audio at once; S2's run renders the rest, the playhead's first
        16 bars and the first drop first, and each one lands on the latest arrangement as it's ready (the app refetches
        the remix while the job runs; edits made meanwhile stay)."""
        engine = self._remix_engine()
        remix = self.get_remix(remix_id)
        for job in self.jobs.list("take_loudness", active_only=True):  # v0.15.3: a new PREPARE drops the old readout
            if job.meta.get("remix_id") == remix_id:  # (ROLL spam never stacks them; this one queues its own)
                self.jobs.cancel(job.id)
        sources = self._remix_sources(remix)
        known: dict[str, str] = {}  # clip_key → audio_id

        def resolve(r: Remix) -> Remix:
            lanes = []
            for lane in r.lanes:
                clips = []
                for c in lane.clips:
                    if c.audio_id is None:
                        key = engine.clip_key(c, r, sources)
                        if key not in known and (hit := self._clip_audio(key)):
                            known[key] = hit
                        c = c.model_copy(update={"audio_id": known.get(key)})
                    clips.append(c)
                lanes.append(lane.model_copy(update={"clips": clips}))
            return r.model_copy(update={"lanes": lanes})

        def land() -> bool:
            with self._remix_lock:
                row = self.library.get("remixes", remix_id)
                if row is not None:
                    self.library.update("remixes", remix_id, info=resolve(Remix.model_validate(row["info"])).model_dump(mode="json"))
                return row is not None

        state: dict[str, Any] = {}

        def on_clip(clip_id: str, audio: np.ndarray, p: Any) -> None:
            key = engine.clip_key(state["clips"][clip_id], state["remix"], sources)
            known[key] = self.song_audio.put(audio, REMIX_SR, "rmc", compact=True)
            self.cache.remember("remix_clip", key, artifact_id=known[key])
            land()
            ctx.progress(p.done / max(1, p.total), "Ready to play" if p.playable else f"Preparing clips {p.done}/{p.total}")

        prepared = 0
        for _ in range(3):  # v0.11.10 (M3.2): clips a PATCH adds while a pass runs (splits, new ids) get the next pass
            if not land():
                return None
            remix = resolve(self.get_remix(remix_id))
            if all(c.audio_id for lane in remix.lanes for c in lane.clips):
                break
            state.update(remix=remix, clips={c.id: c for lane in remix.lanes for c in lane.clips})
            ctx.check()
            with self._fx_background:
                out = engine.run(remix, sources, stage="prepare", sr=REMIX_SR, on_clip=on_clip, audio=self._drop_bass(remix),
                                 progress=lambda f, m: ctx.check())
            prepared += len(out.audio)
        remix = self.get_remix(remix_id)
        if any(t.seed == remix.seed for t in remix.takes) and all(c.audio_id for lane in remix.lanes for c in lane.clips):
            loud = self.jobs.submit("take_loudness", self._take_loudness, remix_id, remix.seed, lane="loudness",
                                    meta={"remix_id": remix_id})  # (no dedupe: a cancelled one may still be finishing)
            ctx.add_results([loud.id])  # v0.15.3: the app waits on it, then refetches the take
        return {"remix_id": remix_id, "prepared": prepared}

    def _drop_bass(self, remix: Remix) -> dict[str, np.ndarray]:
        """S2's first-hit carrier (1.5.1) lifts its sub against the drop's whole bass bus, so when a bass clip is still to
        prepare, run() gets the bass-lane clips that already have audio over the drops (and only those: bounded RAM)."""
        bass = [c for lane in remix.lanes if lane.role in ("bass", "synth_bass") for c in lane.clips]
        if all(c.audio_id for c in bass):
            return {}
        drops = [((s.start_bar - 1) * 4.0, (s.start_bar - 1 + s.bars) * 4.0) for s in remix.sections if s.kind == "drop"]
        over = lambda c: any(c.at_beat < b and c.at_beat + c.beats > a for a, b in drops)  # noqa: E731
        return {c.id: self.song_audio.load(c.audio_id)[0] for c in bass
                if c.audio_id and over(c) and self.song_audio.exists(c.audio_id)}

    def _take_loudness(self, ctx: JobContext, remix_id: str, seed: int) -> dict[str, Any] | None:
        """v0.11.10 / v0.15.3 (a take_loudness job after PREPARE, M2.5): the take's prepared mix, mastered as the export
        would be: its short-term max and true peak on the take at `seed` (the TakeCard readout). Low priority: it waits
        while a BUILD or PREPARE runs, runs outside the fx lock (so a new PREPARE never waits behind it; fvwks_fx is
        pure), and a new PREPARE of this remix cancels it."""
        while any(j.active for kind in ("remix_build", "remix_prepare") for j in self.jobs.list(kind)):
            ctx.check()
            time.sleep(0.25)
        remix = self.get_remix(remix_id)
        clips = [c for lane in remix.lanes for c in lane.clips]
        if remix.seed != seed or not all(c.audio_id and self.song_audio.exists(c.audio_id) for c in clips):
            return None  # rolled or edited meanwhile: that take's own PREPARE queues its own
        engine = self._remix_engine()
        sources = self._remix_sources(remix)
        audio = {}
        for c in clips:
            ctx.check()
            audio[c.id] = self.song_audio.load(c.audio_id)[0]
        ctx.progress(0.5, "Measuring the take's loudness")
        report = engine.run(remix, sources, stage="mixdown", audio=audio, master=Master(), sr=REMIX_SR).report
        ctx.check()
        if report is None:
            return None
        with self._remix_lock:
            cur = self.get_remix(remix_id)
            loud = {"short_term_max_lufs": round(float(report.short_term_max_lufs), 2),
                    "true_peak_db": round(min(0.0, float(report.true_peak_dbtp)), 2)}
            takes = [t.model_copy(update=loud) if t.seed == seed else t for t in cur.takes]
            self.library.update("remixes", remix_id, info=cur.model_copy(update={"takes": takes}).model_dump(mode="json"))
        return {"remix_id": remix_id}

    # -- the sound library and BASS DNA (v0.11.4) ---------------------------------------------------------------

    def list_patches(self) -> list[BassPatch]:
        """GET /patches: S1's bass library; preview_audio_id streams a short audition (rendered on first play)."""
        synth = _synth()
        if synth is None:
            return []
        library = [p.model_copy(update={"preview_audio_id": self._preview_id(synth, "patch", p.id)}) for p in synth.library.patches()]
        growls = getattr(synth, "growls", None)  # v0.11.10: S3's designed voices, the SWAP SOUND tabs (tearout, top, ...)
        if growls is None or not hasattr(growls, "designed_patches"):
            return library
        return library + [p.model_copy(update={"preview_audio_id": self._preview_id(synth, "designed", p.id)})
                          for p in growls.designed_patches()]

    def list_kits(self) -> list[DrumKit]:
        """GET /kits: S1's drum kits; preview_audio_id streams a one-bar audition (rendered on first play)."""
        synth = _synth()
        return [k.model_copy(update={"preview_audio_id": self._preview_id(synth, "kit", k.id)}) for k in synth.kit.kits()] if synth else []

    def _preview_id(self, synth: Any, kind: str, ref: str) -> str | None:
        if not hasattr(synth, "preview"):
            return None
        pid = "pvw_" + hashlib.sha1(f"{kind}:{ref}".encode()).hexdigest()[:12]
        self._previews[pid] = (kind, ref)
        return pid

    def list_flip_styles(self) -> list[FlipStyle]:
        try:
            from fvwks_fx.remix.flip import FLIP_STYLES
        except ImportError:
            return []
        return [FlipStyle(id=k, name=v["name"], bpm=v["bpm"], half_time=v["half_time"], grid=v.get("grid", []))
                for k, v in FLIP_STYLES.items()]

    def bass_groove(self, song_id: str, start_bar: int, bars: int | None) -> BassGroove:
        """GET /songs/{id}/bass/groove: BASS DNA of bars [start_bar, start_bar + bars) of the bass stem, on the song's
        grid, half time as its section says; cached."""
        make = getattr(fx, "bass_groove", None)
        if not callable(make):
            raise ApiException(501, "not_implemented", "BASS DNA arrives with the sound engine's REMIX update.")
        song = self.get_song(song_id)
        bass = next((s for s in song.stems if s.name == "bass"), None)
        if song.analysis is None or song.stems_state != "done" or bass is None:
            running = song.stems_state in ("queued", "running") or song.analysis_state in ("queued", "running")
            raise ApiException(409, "stems_not_ready", "This song's bass stem isn't ready." if running else
                               "This song has no stems yet.", hint=None if running else "Separate its stems first.",
                               retryable=running)
        grid = self._grid(song)
        section = next((s for s in reversed((song.structure.sections if song.structure else [])) if s.start_bar <= start_bar), None)
        half = bool(section and section.half_time)
        key = request_hash("bass_groove", {"bass": bass.audio_id, "grid": grid.model_dump(mode="json"), "start_bar": start_bar,
                                           "bars": bars, "half_time": half}, salt=self.fx_salt)
        cached = self.cache.get_bytes(key)
        if cached:
            return BassGroove.model_validate_json(cached)
        audio, sr = self._load_stem(bass.audio_id)
        with self._fx_background:
            groove = BassGroove.model_validate(make(audio, sr, grid, song_id=song_id, start_bar=start_bar, bars=bars,
                                                    half_time=half))
        self.cache.put_bytes("bass_groove", key, groove.model_dump_json().encode(), ".json", artifact_id=song_id)
        return groove

    def render_groove(self, req: GrooveRenderRequest) -> GrooveRenderResult:
        """POST /grooves/render: a section's BASS DNA on a patch at the song's (or a given) tempo; cached."""
        synth = _synth()
        if synth is None:
            raise ApiException(501, "not_implemented", "The bass synth arrives with the REMIX update.")
        if req.patch_id not in {p["id"] for p in synth.library.entries()}:
            raise NotFound("patch", req.patch_id)
        if not synth.bass.usable(req.patch_id):
            raise ApiException(409, "synth_unavailable", "This patch needs the Surge engine, which this build doesn't have.",
                               hint="Pick a FoxBox patch.")
        groove = self.bass_groove(req.song_id, req.start_bar, req.bars)
        bpm = req.bpm or groove.bpm
        key = request_hash("groove_render", {"groove": groove.model_dump(mode="json"), "patch": req.patch_id, "bpm": bpm,
                                             "shift": req.shift_st}, salt=self.fx_salt)
        audio_id = self._clip_audio(key)
        if audio_id is None:
            try:
                with self._fx_background:
                    audio = synth.bass.render_groove(groove, req.patch_id, start_bar=req.start_bar, bars=req.bars, bpm=bpm,
                                                     shift_st=req.shift_st, sr=REMIX_SR)
            except Exception as exc:  # noqa: BLE001
                raise _passthrough(exc, 500, "synth_failed", "The bass render failed") from exc
            audio_id = self.song_audio.put(audio, REMIX_SR, "rmc", compact=True)
            self.cache.remember("groove_render", key, artifact_id=audio_id)
        return GrooveRenderResult(audio_id=audio_id, duration_s=round(req.bars * 4 * 60.0 / bpm, 4), sample_rate=REMIX_SR)

    # -- REMIX export (v0.11.4) ---------------------------------------------------------------------------------

    def export_remix(self, remix_id: str, req: RemixExportRequest) -> Job:
        """POST /remixes/{id}/export (a remix_export job): the mixdown as AIFF-24 / MP3, the Ableton Live 11 set, and
        (visuals) a new Song whose structure is the arrangement's. GET /remixes/{id}/export has the result."""
        self._remix_engine()
        self.get_remix(remix_id)
        self.export_root  # 409 export_dir_unavailable before any work
        return _job(self.jobs.submit("remix_export", self._export_remix, remix_id, req, lane="remix",
                                     dedupe_key=f"remix_export:{remix_id}", meta={"remix_id": remix_id}))

    def remix_export(self, remix_id: str) -> RemixExportResult:
        row = self.library.get("remixes", remix_id)
        if row is None:
            raise NotFound("remix", remix_id)
        if not row["export"]:
            raise NotFound("export", remix_id)
        return RemixExportResult.model_validate(row["export"])

    def _export_remix(self, ctx: JobContext, remix_id: str, req: RemixExportRequest) -> dict[str, Any] | None:
        engine = self._remix_engine()
        remix = self.get_remix(remix_id)
        sources = self._remix_sources(remix)
        clip_files: dict[str, Path] = {}
        audio: dict[str, np.ndarray] = {}
        for c in (c for lane in remix.lanes for c in lane.clips if c.audio_id and self.song_audio.exists(c.audio_id)):
            audio[c.id] = self.song_audio.load(c.audio_id)[0]
            clip_files[c.id] = self.song_audio.stream_path(c.audio_id)
        master = Master()
        with self._fx_background:
            out = engine.run(remix, sources, stage="mixdown", audio=audio, master=master, sr=REMIX_SR,
                             progress=lambda f, m: (ctx.check(), ctx.progress(0.8 * f, m)))
        for c in (c for lane in remix.lanes for c in lane.clips if c.id in out.audio):  # clips it had to prepare now
            clip_files[c.id] = self.song_audio.stream_path(self.song_audio.put(out.audio[c.id], REMIX_SR, "rmc", compact=True))
        ctx.check()
        title = (req.name or remix.name).strip() or remix.name
        root = self.export_root
        folder = writer.safe_path(root, writer.folder_name(title, "Remix"))
        folder.mkdir(parents=True, exist_ok=True)
        base, sr, mix = writer.remix_file_stem(_export_stem(remix, title)), master.sample_rate, out.mix
        bars = sum(s.bars for s in remix.sections) or None
        files: list[ExportedFile] = []
        warnings: list[str] = []
        ctx.progress(0.85, "Writing files")
        for fmt in dict.fromkeys(req.formats):
            if fmt == "als":
                continue
            path = folder / f"{base}.{fmt}"
            try:
                if fmt == "mp3":
                    from pedalboard.io import AudioFile
                    with AudioFile(str(path), "w", sr, mix.shape[0], quality=320) as f:  # LAME inside pedalboard
                        f.write(np.ascontiguousarray(mix, dtype=np.float32))
                    depth = 0
                else:
                    depth = writer.write_track(path, mix, sr, fmt="aiff", bit_depth=24).bit_depth
            except Exception as exc:  # noqa: BLE001
                raise _write_error(exc, "export_failed", "Could not write the remix") from exc
            f = ExportedFile(id=new_id("exp"), render_id=remix.id, variant="remix", title=title, filename=path.name,
                             path=str(path), format=fmt, sample_rate=sr, bit_depth=depth, channels=mix.shape[0],
                             n_samples=mix.shape[-1], duration_s=round(mix.shape[-1] / sr, 5), bpm=remix.bpm, key=remix.key,
                             bars=bars, size_bytes=path.stat().st_size, created_at=utcnow())
            self.library.insert("exports", id=f.id, render_id=remix.id, created_at=f.created_at, path=f.path,
                                info=f.model_dump(mode="json"))
            files.append(f)
        rekordbox_xml = None
        aiff = next((f for f in files if f.format == "aiff"), None)
        if aiff is not None:  # TEMPO at bar 1, hot cues A.. at the drops, memory cues at every section
            bar = remix.beats_per_bar * 60.0 / remix.bpm
            starts = [((s.start_bar - 1) * bar, s) for s in remix.sections]
            drops = [t for i, (t, s) in enumerate(starts) if s.kind == "drop" and (i == 0 or starts[i - 1][1].kind != "drop")]
            cues = [(f"DROP {n + 1}", t, n) for n, t in enumerate(drops[:8])] + [(s.kind.upper(), t, -1) for t, s in starts]
            track = RekordboxTrack(path=Path(aiff.path), name=title, duration_s=aiff.duration_s, size=aiff.size_bytes,
                                   bpm=remix.bpm, key=remix.key, mix="remix", sample_rate=sr, bit_depth=24,
                                   channels=aiff.channels, first_word_s=None, tail_s=None, cues=cues)
            rekordbox_xml = str(write_rekordbox_xml(folder / "rekordbox.xml", [track], title,
                                                    RekordboxOptions(local_root=root, product_version=VERSION)))
        als_path = None
        if "als" in req.formats:
            ctx.progress(0.9, "Writing the Ableton set")
            try:
                from .als import write_als
                als_path = str(write_als(remix, clip_files, folder, name=title))
            except Exception as exc:  # noqa: BLE001 (BETA: the audio files still stand)
                log.exception("als export failed for %s", remix_id)
                warnings.append(f"The Ableton set couldn't be written: {exc}")
        song_id = self._register_remix_song(mix, sr, title, remix).id if req.visuals else None
        result = RemixExportResult(remix_id=remix.id, files=files, als_path=als_path, song_id=song_id, warnings=warnings,
                                   rekordbox_xml_path=rekordbox_xml)
        self.library.update("remixes", remix_id, export=result.model_dump(mode="json"))
        return {"remix_id": remix_id, "files": len(files)}

    def _register_remix_song(self, mix: np.ndarray, sr: int, name: str, remix: Remix) -> Song:
        """The mixdown as a Song on the remix grid (bar 1 at 0 s) whose sections, drops and builds are the
        arrangement's: VISUALS, TRACK and the pre-drop text know it exactly, with no re-analysis."""
        bar = remix.beats_per_bar * 60.0 / remix.bpm
        dur = mix.shape[-1] / sr
        level = [float(np.sqrt(np.mean(mix[:, int((s.start_bar - 1) * bar * sr):int((s.start_bar - 1 + s.bars) * bar * sr)] ** 2)))
                 for s in remix.sections]
        top = max(level, default=0.0) or 1.0
        sections = [SongSection(kind=s.kind, start_s=round(min(dur, (s.start_bar - 1) * bar), 3),
                                end_s=round(min(dur, (s.start_bar - 1 + s.bars) * bar), 3), start_bar=s.start_bar,
                                energy=round(v / top, 3)) for s, v in zip(remix.sections, level)]
        drops = [x.start_s for i, x in enumerate(sections) if x.kind == "drop" and (i == 0 or sections[i - 1].kind != "drop")]
        builds = [(sections[i - 1].start_s, x.start_s) for i, x in enumerate(sections)
                  if i and x.kind == "drop" and sections[i - 1].kind == "build"]
        structure = SongStructure(sections=sections, drops_s=drops, builds=builds, phrase_bars=8)
        analysis = SongAnalysis(bpm=remix.bpm, bpm_confidence=1.0, key=remix.key, key_confidence=1.0 if remix.key else 0.0,
                                downbeat_s=0.0, beats_per_bar=remix.beats_per_bar)
        audio_id = self.song_audio.put(mix, sr, "sng", compact=True)
        song = Song(id=new_id("sng"), name=name[:200], duration_s=round(dur, 5), sample_rate=int(sr), channels=mix.shape[0],
                    peaks=peaks(mix, sr), audio_id=audio_id, analysis_state="done", analysis=analysis, structure=structure,
                    created_at=utcnow())
        self.library.insert("songs", id=song.id, name=song.name, created_at=song.created_at, audio_hash=audio_hash(mix, sr),
                            audio_id=audio_id, analysis_state="done", info=song.model_dump(mode="json"))
        with self._fx_background:
            self._cache_mash(song, analysis, structure, mix, sr, None)
        return song

    def rate_take(self, remix_id: str, req: TakeFeedbackCreate) -> TakeFeedback:
        """POST /remixes/{id}/feedback: one take rated. The take's style and choices are copied into the record (history
        is never rewritten) and its rating shown on the take (no new rev: not an edit). The counts come from each
        take's latest record (takes.prefs_from): a re-rating replaces the earlier one, a 0 withdraws it."""
        with self._remix_lock:
            cur = self.get_remix(remix_id)
            take = next((t for t in cur.takes if t.seed == req.seed), None)
            if take is None:
                raise NotFound("take", str(req.seed))
            fb = TakeFeedback(id=new_id("tfb"), remix_id=remix_id, seed=req.seed, style=take.style, choices=take.choices,
                              rating=req.rating, tags=req.tags, note=req.note, created_at=utcnow())
            self.library.insert("remix_feedback", id=fb.id, remix_id=remix_id, created_at=fb.created_at,
                                data=fb.model_dump(mode="json"))
            takes = [t.model_copy(update={"rating": req.rating}) if t.seed == req.seed else t for t in cur.takes]
            new = cur.model_copy(update={"takes": takes})
            self.library.update("remixes", remix_id, info=new.model_dump(mode="json"))
        try:
            self._golden(new, take, req.rating, req.tags)
        except (OSError, ApiException):  # a golden is a dev aid: it never fails the rating
            log.warning("remix golden for %s s%s not written", remix_id, req.seed, exc_info=True)
        return fb

    GOLDENS_PER_STYLE, GOLDENS_MAX = 3, 40  # plan v2 §7.5

    def _golden(self, remix: Remix, take: RemixTake, rating: int, tags: list[str]) -> None:
        """M4.4 (1.5.1): a liked take (👍, LOVE IT) as a golden for S2's runner, <data>/goldens/<song>-<remix>-s<seed>.json
        = {"song": its audio file, "remix": the doc at that seed, its arrangement and choices, "love", "style", "engine": the
        engine version}; a 0 or a 👎
        removes it. At most 3 per (song, style) and 40 in all, LOVE IT first then the newest. They stay in the engine's
        data dir (plan v2 §7.6: ratings stay on this machine): copying them into a dev checkout's out/goldens is the
        user's export."""
        folder = self.config.data_dir / "goldens"
        song_id = next(s.song_id for s in remix.sources if s.slot == "A")
        path = folder / f"{song_id}-{remix.id}-s{take.seed}.json"
        if rating <= 0:
            path.unlink(missing_ok=True)
            return
        if take.seed == remix.seed:
            arrangement = {"sections": remix.sections, "lanes": remix.lanes}
        else:  # its saved arrangement, else none: the runner rebuilds it from the take's choices
            arrangement = {"sections": take.sections or [], "lanes": take.lanes or []}
        doc = remix.model_copy(update={"seed": take.seed, **arrangement}).model_dump(mode="json")
        audio = self.song_audio.stream_path(self.get_song(song_id).audio_id)
        folder.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"song": str(audio), "remix": doc, "love": "love_it" in tags, "style": take.style,
                                    "engine": VERSION}))
        entries = []
        for f in folder.glob("*.json"):
            try:
                g = json.loads(f.read_text())
            except (OSError, ValueError):
                continue
            entries.append((not g.get("love"), -f.stat().st_mtime, f, f.name.split("-rmx_")[0], g.get("style")))
        entries.sort(key=lambda e: e[:2])  # LOVE IT first, then the newest
        per: dict[tuple, int] = {}
        kept = 0
        for _, _, f, song, style in entries:
            per[song, style] = per.get((song, style), 0) + 1
            if per[song, style] > self.GOLDENS_PER_STYLE or kept >= self.GOLDENS_MAX:
                f.unlink(missing_ok=True)
            else:
                kept += 1

    def _feedback_since_reset(self) -> dict[str, list[TakeFeedback]]:
        """Every style's feedback rows since its last RESET, oldest first."""
        reset = {r["id"]: r["data"].get("reset_at", "") for r in self.library.select("remix_prefs")}
        out: dict[str, list[TakeFeedback]] = {}
        for r in self.library.select("remix_feedback", order="created_at, rowid"):
            f = TakeFeedback.model_validate(r["data"])
            if f.created_at > reset.get(f.style, ""):
                out.setdefault(f.style, []).append(f)
        return out

    def _remix_prefs(self, style: str) -> RemixPrefs:
        return take_weights.prefs_from(self._feedback_since_reset().get(style, []), style)

    def remix_prefs(self) -> RemixPrefsResult:
        """GET /remix-prefs: the counts of every style rated since its last RESET."""
        return RemixPrefsResult(styles=[take_weights.prefs_from(rows, style)
                                        for style, rows in sorted(self._feedback_since_reset().items())])

    def reset_remix_prefs(self, style: str) -> None:
        """DELETE /remix-prefs/{style}: RESET. ROLL counts only that style's ratings made after now (the rows stay)."""
        data = {"style": style, "reset_at": utcnow()}
        if self.library.get("remix_prefs", style):
            self.library.update("remix_prefs", style, data=data)
        else:
            self.library.insert("remix_prefs", id=style, data=data)

    def delete_remix(self, remix_id: str) -> None:
        """The arrangement (its prepared clips are content-addressed cache and go when evicted)."""
        self.get_remix(remix_id)
        for job in self.jobs.list(active_only=True):
            if job.meta.get("remix_id") == remix_id:
                self.jobs.cancel(job.id)
        self.library.delete("remixes", [remix_id])
        revs = self.library.get_setting("remix_built_rev", {})
        if remix_id in revs:
            self.library.set_setting("remix_built_rev", {k: v for k, v in revs.items() if k != remix_id})

    def request_lyrics(self, song_id: str) -> Job:
        """POST /songs/{id}/lyrics: the song's timed words (a song_lyrics job), from the vocals stem when it has
        stems, else the whole mix. Asking again returns the stored lyrics, unless they came from the mix and the
        song has stems now."""
        if not callable(getattr(voice, "transcribe", None)):
            raise ApiException(501, "not_implemented", "This voice engine can't transcribe lyrics.")
        song = self.get_song(song_id)
        if not self._transcriber_ready():
            raise ApiException(503, "model_not_installed", "Lyrics need the transcription model.",
                               hint="Install it from VOICES → Models (about 2.9 GB).", model_id=TRANSCRIBE_MODEL)
        if song.lyrics_state in ("queued", "running"):
            for job in self.jobs.list(kind="song_lyrics", active_only=True):
                if job.meta.get("song_id") == song_id:
                    return _job(job)
        if song.lyrics_state == "done":
            stored = (self.library.get("songs", song_id) or {}).get("lyrics") or {}
            if stored and not (stored.get("source") == "mix" and self._vocals_stem(song)):
                return _job(self.jobs.complete(self.jobs.new_job("song_lyrics", meta={"song_id": song_id}),
                                               message="Lyrics ready.", result={"song_id": song_id}))
        self._set_song(song_id, lyrics_state="queued")
        return _job(self.jobs.submit("song_lyrics", self._transcribe_song, song_id, lane="songs",
                                     dedupe_key=f"song_lyrics:{song_id}", meta={"song_id": song_id}))

    def lyrics(self, song_id: str) -> SongLyrics:
        """GET /songs/{id}/lyrics."""
        row = self.library.get("songs", song_id)
        if row is None:
            raise NotFound("song", song_id)
        song = self._song(row)
        if song.lyrics_state != "done" or not row.get("lyrics"):
            running = song.lyrics_state in ("queued", "running")
            raise ApiException(409, "lyrics_not_ready",
                               "This song's lyrics are still being transcribed." if running else "This song has no lyrics yet.",
                               hint=None if running else "Transcribe its lyrics first.", retryable=running)
        return SongLyrics.model_validate(row["lyrics"])

    def _vocals_stem(self, song: Song) -> SongStem | None:
        if song.stems_state != "done":
            return None
        stem = next((s for s in song.stems if s.name == "vocals"), None)
        return stem if stem is not None and self.song_audio.exists(stem.audio_id) else None

    def _transcribe_song(self, ctx: JobContext, song_id: str) -> dict[str, Any] | None:
        song = self._set_song(song_id, lyrics_state="running")
        if song is None:
            return None  # deleted while queued
        stem = self._vocals_stem(song)  # the songs lane runs a stems job asked for first before this
        words: list[SongWord] = []
        try:
            audio, sr = self._load_stem(stem.audio_id) if stem else self._song_audio(song_id)
            x = resample(np.asarray(audio, np.float32).mean(axis=0), int(sr), ENGINE_SR)
            spans = _lyric_windows(x, ENGINE_SR)
            for i, (a, b) in enumerate(spans):
                ctx.check()
                ctx.progress(i / len(spans), "Transcribing lyrics")
                part = x[a:b]
                if float(np.max(np.abs(part), initial=0.0)) < 1e-3:  # a silent stretch (Whisper invents words there)
                    continue
                dur = round(part.size / ENGINE_SR, 6)
                src = Source(info=SourceInfo(id=song_id, kind="import", name=song.name, sample_rate=ENGINE_SR,
                                             duration_s=dur, segments=[Segment(index=0, start_s=0.0, end_s=dur)],
                                             peaks=peaks(part[None, :], ENGINE_SR), audio_id="",
                                             created_at=song.created_at),
                             audio=part[None, :])
                with self._background(), self._model_lock("aligner"):
                    ctx.check()
                    out = voice.transcribe(src)
                offset = a / ENGINE_SR
                words += [SongWord(text=w.text, start_s=round(offset + w.start_s, 3), end_s=round(offset + w.end_s, 3))
                          for seg in out.info.segments for w in seg.words]
        except Exception as exc:
            missing = getattr(exc, "code", None) == "model_not_installed"
            stopped = isinstance(exc, JobCancelled) or ctx.cancelled
            self._set_song(song_id, lyrics_state="none" if missing or stopped else "error")
            raise
        lyrics = SongLyrics(song_id=song_id, source="vocals_stem" if stem else "mix", words=words)
        if self.library.get("songs", song_id) is None:
            return None
        self.library.update("songs", song_id, lyrics=lyrics.model_dump(mode="json"))
        self._set_song(song_id, lyrics_state="done")
        return {"song_id": song_id, "words": len(words)}

    @staticmethod
    def _song_grid(song: Song) -> tuple[float, float, int]:
        """(bpm, bar 1 in seconds, beats per bar): the user's overrides, else the analysis."""
        a = song.analysis
        bpm = song.bpm_override or (a.bpm if a else None)
        downbeat = song.downbeat_override_s if song.downbeat_override_s is not None else (a.downbeat_s if a else None)
        if bpm is None or downbeat is None:
            pending = song.analysis_state in ("queued", "running")
            raise ApiException(409, "song_not_analyzed",
                               "This song is still being analysed." if pending else "This song's analysis failed.",
                               hint="Wait a moment, or set its BPM and bar 1 yourself.", retryable=pending)
        return float(bpm), float(downbeat), a.beats_per_bar if a else 4

    def _mix(self, render_id: str, placement: SongPlacement, quality: str) -> MixInfo:
        mix_fn = getattr(fx, "mix_song", None)
        if not callable(mix_fn):
            raise ApiException(501, "not_implemented", "This sound engine can't mix songs yet.")
        row = self.library.get("renders", render_id)
        if row is None:
            raise NotFound("render", render_id)
        song = self.get_song(placement.song_id)
        bpm, downbeat, beats = self._song_grid(song)
        bar_s = beats * 60.0 / bpm

        def at(bar: int) -> float:  # song bars are 1-based on the song's grid
            return downbeat + (bar - 1) * bar_s

        drop_start = at(placement.at_bar)
        if drop_start >= song.duration_s:
            raise ApiException(422, "invalid_request", f"Bar {placement.at_bar} is past the end of the song.")
        excerpt = None
        if placement.start_bar is not None or placement.end_bar is not None:
            start = at(placement.start_bar) if placement.start_bar is not None else 0.0
            end = at(placement.end_bar) if placement.end_bar is not None else song.duration_s
            start, end = min(max(start, 0.0), song.duration_s), min(max(end, 0.0), song.duration_s)
            if end <= start:
                raise ApiException(422, "invalid_request", "The excerpt is empty or outside the song.")
            if not start <= drop_start < end:
                raise ApiException(422, "invalid_request", f"Bar {placement.at_bar} is outside the excerpt.",
                                   hint="Start the excerpt at or before the drop.")
            excerpt = (round(start, 6), round(end, 6))
        master = RenderRequest.model_validate(row["request"]).master
        payload = {"render": render_id, "song": song.id, "song_audio": song.audio_id, "grid": [bpm, downbeat, beats],
                   "placement": placement.model_dump(mode="json"), "quality": quality,
                   "master": master.model_dump(mode="json")}
        key = request_hash("mix", payload, salt=self.fx_salt)
        with self._keyed(key):
            hit = self.library.find("mixes", "request_hash", key)
            if hit is not None and self.audio.exists(hit["audio_id"]):
                self.library.update("mixes", hit["id"], created_at=utcnow())  # just used: the GC keeps it
                return MixInfo.model_validate(hit["info"])
            drop, drop_sr = self._load_render_audio(row["audio"].get("wet"))
            audio, sr = self._song_audio(song.id)
            try:
                with self._fx_lock():
                    out = mix_fn(audio, sr, drop, drop_sr, drop_start_s=drop_start, bpm=bpm, placement=placement,
                                 excerpt_s=excerpt, master=master, quality=quality)
            except Exception as exc:
                if not isinstance(exc, ApiException):
                    log.exception("mix failed")
                raise _passthrough(exc, 500, "mix_failed", "Mixing failed", retryable=True) from exc
            mixed, out_sr = as_channels_first(out.audio), int(out.sample_rate)
            if mixed.shape[-1] == 0 or not np.isfinite(mixed).all():
                raise ApiException(500, "mix_failed", "The mix came out empty or with NaN/Inf samples.")
            try:
                audio_id = self.audio.put(mixed, out_sr, "mix", compact=quality == "final")
            except Exception as exc:
                raise _write_error(exc, "mix_failed", "Couldn't store the mix") from exc
            info = MixInfo(id=new_id("mix"), render_id=render_id, song_id=song.id, audio_id=audio_id,
                           sample_rate=out_sr, duration_s=round(mixed.shape[-1] / out_sr, 5),
                           start_s=float(out.start_s), drop_start_s=float(out.drop_start_s),
                           peaks=peaks(mixed, out_sr), loudness=out.loudness, warnings=list(out.warnings))
            self.library.insert("mixes", id=info.id, render_id=render_id, song_id=song.id, created_at=utcnow(),
                                request_hash=key, audio_id=audio_id, info=info.model_dump(mode="json"))
        self._gc_mixes()
        return info

    def _drop_mix(self, row: dict[str, Any]) -> None:
        self.library.delete("mixes", [row["id"]])
        self.audio.delete(row["audio_id"])

    def _gc_mixes(self) -> None:
        for row in self.library.select("mixes", limit=-1, offset=MIX_KEEP):
            self._drop_mix(row)

    # ------------------------------------------------------------------------------------------ exports

    def create_exports(self, req: ExportRequest) -> ExportResult:
        files: list[ExportedFile] = []
        warnings: list[str] = []
        for render_id in dict.fromkeys(req.render_ids):
            # v0.7: the song with this drop in it. Mixed first, so a song that can't be mixed yet (409) or a bad
            # placement (422) fails the export before any file is written.
            mix = self._mix(render_id, req.bake, "final") if req.bake is not None else None
            more, notes = self._export_render(render_id, req.variants, req.format, req.bit_depth, req.title,
                                              stems=req.stems)
            if mix is not None:
                baked, baked_notes = self._export_baked(render_id, req.bake, mix, req.format, req.bit_depth,
                                                        req.title)
                more, notes = [*more, *baked], [*notes, *baked_notes]
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
        return self._record_exports(written, info, fmt, root, warnings), warnings

    def _record_exports(self, written: list[writer.WrittenFile], info: RenderInfo, fmt: str, root: Path | None,
                        warnings: list[str], **fields: Any) -> list[ExportedFile]:
        """Library rows for written files. ``fields`` override the render's bpm/key/bars/first_word_s/tail_s."""
        files = []
        for w in written:
            path = self._inside_root(w.path, root)
            f = ExportedFile(**{
                "id": new_id("exp"), "render_id": info.id, "variant": w.variant, "title": w.title,
                "filename": w.filename, "path": str(path), "format": fmt, "sample_rate": w.sample_rate,
                "bit_depth": w.bit_depth, "channels": w.channels, "n_samples": w.frames,
                "duration_s": round(w.duration_s, 5), "bpm": info.bpm, "key": info.key, "bars": info.bars,
                "first_word_s": info.first_word_s, "tail_s": info.tail_s, "size_bytes": w.bytes,
                "created_at": utcnow(), **fields})
            self.library.insert("exports", id=f.id, render_id=info.id, created_at=f.created_at, path=f.path,
                                info=f.model_dump(mode="json"))
            files.append(f)
            if w.clipped_samples:
                warnings.append(f"{w.filename}: {w.clipped_samples} samples clipped at {w.bit_depth}-bit.")
        return files

    def _export_baked(self, render_id: str, placement: SongPlacement, mix: MixInfo, fmt: str, bit_depth: int,
                      title: str | None) -> tuple[list[ExportedFile], list[str]]:
        """v0.7: the song (or its excerpt) with the drop baked in (``mix``, final quality), as variant 'baked' next to
        the render's files. Tagged with the song's tempo and key, since that's what the file plays at; the drop's cues
        move with it."""
        row = self.library.get("renders", render_id)
        info, filled = RenderInfo.model_validate(row["info"]), RenderRequest.model_validate(row["request"])
        song = self.get_song(placement.song_id)
        bpm, _, _ = self._song_grid(song)
        try:
            audio, sr = self.audio.load(mix.audio_id)
        except FileNotFoundError:
            raise ApiException(409, "render_missing", "The mix for this export is gone.", hint="Export again.",
                               retryable=True) from None
        try:
            key = key_name(song.key_override or (song.analysis.key if song.analysis else None))
        except ValueError:
            key = None
        settings, meta = self.settings(), row["meta"]
        params = {**_render_params(info, filled, self.fx_salt), "song_id": song.id, "mix_id": mix.id,
                  "placement": placement.model_dump(mode="json"), "start_s": mix.start_s,
                  "drop_start_s": mix.drop_start_s}
        export_meta = writer.ExportMeta(
            script=meta.get("script") or meta.get("source_name") or "take", preset=self._preset_label(info.preset_id),
            bpm=round(bpm, 2), bars=None, key=key, name=title, artist=settings.artist, render_params=params,
            pattern=settings.filename_pattern)
        directory = self.export_root
        self._inside_root(directory)
        try:
            written = writer.export_files(directory, export_meta, [writer.ExportItem("baked", audio, sr)], fmt=fmt,
                                          bit_depth=bit_depth, channels=as_channels_first(audio).shape[0])
        except ValueError as exc:
            raise ApiException(422, "export_failed", f"Could not export: {exc}") from exc
        except Exception as exc:
            raise _write_error(exc, "export_failed", "Could not write the export") from exc
        warnings = list(mix.warnings)
        files = self._record_exports(
            written, info, fmt, None, warnings, bpm=round(bpm, 2), key=key, bars=None,
            first_word_s=round(mix.drop_start_s + info.first_word_s, 5),
            tail_s=round(mix.drop_start_s + info.tail_s, 5) if info.tail_s is not None else None)
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
        store = self.song_audio if audio_id.startswith(("sng_", "sgs_", "rmc_")) else self.audio  # songs, stems, remix clips
        path = store.stream_path(audio_id)
        if path is None and audio_id.startswith("pvw_") and audio_id in self._previews and (synth := _synth()):
            kind, ref = self._previews[audio_id]
            try:
                render = {"patch": synth.preview.preview, "kit": synth.preview.kit_preview,
                          "designed": getattr(getattr(synth, "growls", None), "designed_preview", None)}[kind]
                return Path(render(ref))
            except Exception as exc:  # noqa: BLE001
                raise _passthrough(exc, 500, "synth_failed", "The patch preview failed") from exc
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


def _lyric_windows(x: np.ndarray, sr: int) -> list[tuple[int, int]]:
    """Sample spans of at most LYRICS_WINDOW_S for the transcriber, each cut at the quietest half second of its last
    LYRICS_SEEK_S so a cut rarely lands inside a word."""
    hop, n, start = sr // 2, x.shape[-1], 0
    spans = []
    while n - start > LYRICS_WINDOW_S * sr:
        lo = start + int((LYRICS_WINDOW_S - LYRICS_SEEK_S) * sr)
        frames = x[lo:lo + int(LYRICS_SEEK_S * sr) // hop * hop].reshape(-1, hop)
        cut = lo + int(np.argmin(np.mean(frames ** 2, axis=1))) * hop + hop // 2
        spans.append((start, cut))
        start = cut
    spans.append((start, n))
    return spans


def _keep_prepared(old: Remix, new: Remix) -> list[RemixLane]:
    """The new lanes, each clip keeping a prepared audio_id only when a clip of the old version sounded the same (its
    source, shift, length, fades and gain, at the same remix tempo and seed). The client's own audio_id is never trusted."""
    # ponytail: a source song's grid changing (its BPM override) isn't seen here; PREPARE's clip_key cache is
    def sound(c: Any) -> str:
        return json.dumps(c.model_dump(mode="json", exclude={"id", "at_beat", "audio_id"}), sort_keys=True)

    have = {sound(c): c.audio_id for lane in old.lanes for c in lane.clips if c.audio_id} if (old.bpm, old.seed) == (new.bpm, new.seed) else {}
    if old.bass_macros != new.bass_macros:  # v0.11.12: the knobs re-prepare only the engine bass (S2's patch prefixes)
        have = {k: v for k, v in have.items() if not _engine_bass(json.loads(k))}
    return [lane.model_copy(update={"clips": [c.model_copy(update={"audio_id": have.get(sound(c))}) for c in lane.clips]})
            for lane in new.lanes]


def _engine_bass(clip: dict) -> bool:
    src = clip.get("src") or {}
    return src.get("kind") == "groove" and str(src.get("patch_id", "")).startswith(("resample:", "hybrid:", "riddim:", "808:"))


_PACK_SKIP = {"not_one_shot": "Longer than 2 s, or more than one hit (a loop).",
              "unreadable": "The audio couldn't be read.", "unsupported": "Not a local audio file FoxBox can use."}
_SKIPPED = {"missing": "The file isn't on this Mac (a drive not plugged in?).",
            "unsupported": "Not a local audio file FoxBox can import.", "too_long": "Longer than 15 minutes.",
            "too_large": "Over 400 MB.", "unreadable": "The audio couldn't be read."}


class _Skip(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _num(text: str | None) -> float:
    try:
        return float(text or 0)
    except ValueError:
        return 0.0


def _key(text: str | None) -> str | None:
    """A Rekordbox Tonality ('Am', '8A', ...) as FoxBox's key name, None when it's empty or unreadable."""
    try:
        return key_name(text or None)
    except ValueError:
        return None


def _export_stem(remix: Remix, title: str) -> str:
    """A remix export's name (1.5.1, S5's R21 in the PM's ASCII form): "<song> (<STYLE> <RECIPE> - TAKE <n>)". A default
    name's trailing recipe word moves into the bracket ("ncs-01 VIP" -> "ncs-01 (RIDDIM VIP - TAKE 2)"); another name is
    kept as it is. STYLE (the take's, trap_hybrid -> TRAP HYBRID) is left out when it's the recipe; n is the take's place
    in Remix.takes, left out when there's no take."""
    recipe = remix.recipe.upper()
    words = title.split()
    song = " ".join(words[:-1]) if len(words) > 1 and words[-1].upper() == recipe else title
    take = next(((n, t) for n, t in enumerate(remix.takes, 1) if t.seed == remix.seed), None)
    style = take[1].style.replace("_", " ").upper() if take else ""
    label = recipe if not style or style == recipe else f"{style} {recipe}"
    return f"{song} ({label}{f' - TAKE {take[0]}' if take else ''})"


def _take_style(remix: Remix) -> str | None:
    """What a take's ratings count under, before BUILD (S2's styles.take_style: the flip's style, else the bass
    patch's), so ROLL draws from that style's prefs (plan v2 §7.7); None when the engine doesn't say."""
    try:
        from fvwks_fx.remix.styles import take_style
    except ImportError:
        return remix.flip.style_id if remix.flip else None
    return take_style(remix)


def _synth():
    """S1's fvwks_synth (patches, kits, the bass renderer), or None in an engine built without it."""
    try:
        import fvwks_synth.bass
        import fvwks_synth.kit
        import fvwks_synth.library
    except ImportError:
        return None
    try:
        import fvwks_synth.preview  # noqa: F401 (help/s1-als: patch previews)
    except ImportError:
        pass
    try:
        import fvwks_synth.growls  # noqa: F401 (help/s3-growls: the designed voices)
    except ImportError:
        pass
    return fvwks_synth
