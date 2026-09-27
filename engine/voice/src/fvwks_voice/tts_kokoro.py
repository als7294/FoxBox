"""Kokoro-82M on Apple Silicon via mlx-audio.

- Loads offline from the Hugging Face cache (no network when the model is cached).
- Drives KokoroPipeline directly rather than Model.generate(), which reloads the voice pack on every call
  and fetches voices from a different repo (prince-canuma/Kokoro-82M) over the network.
- One pipeline per accent: 'a' (American) and 'b' (British), each with its own misaki G2P.
- Word timings come from Kokoro's duration predictor (12.5 ms grid). They tile the phrase, so pauses land inside
  words; synth.py moves the edges that border a pause onto the audible edges.
- MLX calls are serialized behind a lock; the server may call from several threads.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable

import numpy as np

from . import models
from .engine import PhraseAudio, VoiceSpec, WordTiming
from .errors import VoiceError
from .espeak_path import ensure_short_espeak_path
from .voices import KOKORO_VOICES

log = logging.getLogger(__name__)

MODEL_ID = "mlx-community/Kokoro-82M-bf16"
WEIGHTS_FILE = "kokoro-v1_0.safetensors"
SAMPLE_RATE = 24_000
DEFAULT_SPEED = 0.9
MIN_SPEED, MAX_SPEED = 0.5, 2.0
LANGS = {"a": "en-US", "b": "en-GB"}
# MLX compiles kernel variants per size class on first use (0.5-1 s each for the first few sizes), so warm-up
# covers short, medium and long lines on both accents rather than one short line.
WARMUP_LINES = (
    ("am_fenrir", "Warm up."),
    ("am_fenrir", "We are Guy Fawkes. Expect us."),
    ("am_fenrir", "Remember, remember, the signal never dies, we do not forgive, we do not forget, expect us."),
    ("bm_george", "Warm up."),
    ("bm_george", "We do not forgive, we do not forget, expect us tonight."),
)
_PHRASE_CACHE_BYTES = 64 * 1024 * 1024


class KokoroEngine:
    name = "kokoro-mlx"
    sample_rate = SAMPLE_RATE

    def __init__(self, model_id: str = MODEL_ID) -> None:
        self.model_id = model_id
        self._lock = threading.RLock()
        self._model: Any = None
        self._pipelines: dict[str, Any] = {}
        self._packs: dict[str, Any] = {}
        self._dir: Path | None = None
        self._cache: OrderedDict[tuple, PhraseAudio] = OrderedDict()
        self._cache_bytes = 0
        self.load_seconds: float | None = None
        self.warmup_seconds: float | None = None

    # -- install state ------------------------------------------------------------------------
    def model_dir(self) -> Path | None:
        """The cached snapshot folder, resolved without network access: the pinned revision in use (models.py),
        or for another repo id, whatever the cache has."""
        if self._dir is not None:
            return self._dir
        try:
            from huggingface_hub import try_to_load_from_cache
        except ImportError:
            return None
        if self.model_id == models.KOKORO_REPO.repo_id:
            d = models.repo_path(models.KOKORO, models.KOKORO_REPO)
        else:
            hit = try_to_load_from_cache(self.model_id, "config.json")
            d = Path(hit).parent if isinstance(hit, str) else None
        if d is not None and (d / WEIGHTS_FILE).exists():
            self._dir = d
        return self._dir

    def is_installed(self, voice: str | None = None) -> bool:
        d = self.model_dir()
        if d is None:
            return False
        return voice is None or (d / "voices" / f"{voice}.safetensors").exists()

    def install(self, progress: Callable[[float], None] | None = None) -> Path:
        """Download the pinned model and the English voices (~342 MB), as the engine's installer does. Only needed on
        a fresh machine."""
        models.install(models.KOKORO, (lambda fraction, message: progress(fraction or 0.0)) if progress else None)
        self._dir = None
        path = self.model_dir()
        if path is None:  # pragma: no cover - install() raises first
            raise VoiceError("install_failed", "Kokoro downloaded but can't be found.", status=502)
        return path

    # -- loading ------------------------------------------------------------------------------
    @property
    def loaded(self) -> bool:
        return self._model is not None

    def load(self, warmup: bool = True) -> None:
        with self._lock:
            if self._model is not None:
                return
            t0 = time.perf_counter()
            path = self.model_dir()
            if path is None:
                raise VoiceError("model_not_installed", "The Kokoro voice model isn't installed.",
                                 "Install it from VOICES, or run KokoroEngine().install().", status=503,
                                 model_id=models.KOKORO.id)
            try:
                from mlx_audio.tts.utils import load_model
            except ImportError as e:  # pragma: no cover - dependency problem
                raise VoiceError("tts_unavailable", f"mlx-audio is not available: {e}", status=503) from e
            ensure_short_espeak_path()  # before any pipeline starts espeak (a long path makes espeak exit(1))
            self._model = load_model(path, model_type="kokoro")
            for lang in LANGS:
                self._pipeline(lang)
            self.load_seconds = time.perf_counter() - t0
            if warmup:
                t1 = time.perf_counter()
                for voice, line in WARMUP_LINES:
                    if self.is_installed(voice):
                        self._generate(line, voice, DEFAULT_SPEED, None)
                self.warmup_seconds = time.perf_counter() - t1
            log.info("Kokoro loaded in %.2fs (warm-up %.2fs)", self.load_seconds, self.warmup_seconds or 0)

    def _pipeline(self, lang: str) -> Any:
        pipe = self._pipelines.get(lang)
        if pipe is None:
            from mlx_audio.tts.models.kokoro.pipeline import KokoroPipeline

            pipe = KokoroPipeline(lang_code=lang, model=self._model, repo_id=self.model_id)
            self._pipelines[lang] = pipe
        return pipe

    def _pack(self, voice: str) -> Any:
        pack = self._packs.get(voice)
        if pack is None:
            from mlx_audio.tts.models.kokoro.voice import load_voice_tensor

            d = self.model_dir()
            f = d / "voices" / f"{voice}.safetensors" if d else None
            if f is None or not f.exists():
                raise VoiceError("voice_not_found", f"Kokoro voice {voice!r} isn't installed.", status=404)
            pack = load_voice_tensor(str(f))
            self._packs[voice] = pack
        return pack

    # -- catalog ------------------------------------------------------------------------------
    def voices(self) -> list[VoiceSpec]:
        return list(KOKORO_VOICES)

    def check_voice(self, voice: str) -> None:
        if voice[:1] not in LANGS or not any(v.id == voice for v in KOKORO_VOICES):
            raise VoiceError("voice_not_found", f"Unknown voice {voice!r}.",
                             "Pick one of the voices from GET /api/voices.", status=404)

    # -- synthesis ----------------------------------------------------------------------------
    def synthesize(self, text: str, voice: str, speed: float = DEFAULT_SPEED, *,
                   plain: str | None = None) -> PhraseAudio:
        self.check_voice(voice)
        speed = float(min(MAX_SPEED, max(MIN_SPEED, speed)))
        key = (voice, round(speed, 4), text, plain)
        with self._lock:
            hit = self._cache.get(key)
            if hit is not None:
                self._cache.move_to_end(key)
                return hit
            if self._model is None:
                self.load()
            out = self._generate(text, voice, speed, plain)
            self._remember(key, out)
            return out

    def _generate(self, text: str, voice: str, speed: float, plain: str | None) -> PhraseAudio:
        import mlx.core as mx

        pipe = self._pipeline(voice[0])
        pipe.voices[voice] = self._pack(voice)
        parts: list[np.ndarray] = []
        words: list[WordTiming] = []
        offset = 0
        ref = plain if plain is not None else text
        cursor = 0
        try:
            results = list(pipe(text, voice=voice, speed=speed, split_pattern=None))
        except VoiceError:
            raise
        except Exception as e:  # noqa: BLE001 - surface any G2P/model failure as a tts error
            raise VoiceError("tts_failed", f"Kokoro failed on {text!r}: {e}", status=500) from e
        finally:
            mx.clear_cache()
        for r in results:
            if r.audio is None:
                continue
            a = np.asarray(r.audio, dtype=np.float32).reshape(-1)
            base = offset / SAMPLE_RATE
            for tok in r.tokens or []:
                ts, te = getattr(tok, "start_ts", None), getattr(tok, "end_ts", None)
                cs = ref.find(tok.text, cursor) if tok.text else -1
                ce = cs + len(tok.text) if cs >= 0 else -1
                if cs >= 0:
                    cursor = ce
                if ts is None or te is None:
                    continue
                words.append(WordTiming(tok.text, base + float(ts), base + float(te), cs, ce))
            parts.append(a)
            offset += len(a)
        audio = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
        return PhraseAudio(audio, SAMPLE_RATE, words)

    def _remember(self, key: tuple, out: PhraseAudio) -> None:
        self._cache[key] = out
        self._cache_bytes += out.audio.nbytes
        while self._cache_bytes > _PHRASE_CACHE_BYTES and len(self._cache) > 1:
            _, old = self._cache.popitem(last=False)
            self._cache_bytes -= old.audio.nbytes


_engine: KokoroEngine | None = None
_engine_lock = threading.Lock()


def get_engine() -> KokoroEngine:
    """The process-wide Kokoro engine (lazy; call .load() to pay the start-up cost up front)."""
    global _engine
    with _engine_lock:
        if _engine is None:
            _engine = KokoroEngine()
        return _engine
