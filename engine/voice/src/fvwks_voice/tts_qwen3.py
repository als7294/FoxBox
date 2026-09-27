"""Qwen3-TTS on MLX (mlx-audio) for personas.

- design(): VoiceDesign 1.7B turns a description ("deep gravelly menacing narrator") into candidate readings of
  a sample line. Each candidate uses its own seed, so they differ. The model (4.6 GB) is loaded only while
  designing, then released.
- clone(): Base 1.7B speaks any line in the voice of a saved candidate (reference clip + its transcript). It
  stays loaded after first use. The seed comes from (persona, text), so the same line always renders the
  same, which keeps re-renders and the server's STACK cache consistent.

Measured on the M3 Pro: about real-time (a 3 s line takes 2.7-4.3 s), against Kokoro's ~0.3 s. Qwen3 gives no
word timings, so persona Sources have `Segment.words == []` (S2 then throws the whole segment).
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from collections import OrderedDict
from typing import Any, Iterator

import numpy as np

from . import models
from .engine import PhraseAudio, VoiceSpec
from .errors import VoiceError
from .util import quiet

log = logging.getLogger(__name__)

SAMPLE_RATE = 24_000
LANGUAGE = "english"
_TOKENS_PER_S = 12.5  # Qwen3-TTS 12 Hz codec
_CACHE_BYTES = 32 * 1024 * 1024


def _seed(*parts: str) -> int:
    return int(hashlib.sha1("|".join(parts).encode()).hexdigest()[:8], 16)


def _max_tokens(text: str) -> int:
    """Generous upper bound on speech length, so a sampling runaway can't babble for minutes."""
    return int(min(4096, _TOKENS_PER_S * (3.0 + 0.25 * len(text))))


class Qwen3Engine:
    name = "qwen3-mlx"
    sample_rate = SAMPLE_RATE

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._designing = 0  # designs in progress (the lock is only held per candidate)
        self._base: Any = None
        self._cache: OrderedDict[tuple, np.ndarray] = OrderedDict()
        self._cache_bytes = 0

    def is_installed(self) -> bool:
        return models.is_installed(models.QWEN3)

    def _require(self) -> None:
        if not self.is_installed():
            raise VoiceError("model_not_installed", "The Qwen3-TTS persona model isn't installed.",
                             "Install it from VOICES → Models (about 9 GB).", status=503, model_id=models.QWEN3.id)

    def _load(self, repo: models.Repo) -> Any:
        from mlx_audio.tts.utils import load_model

        path = models.repo_path(models.QWEN3, repo)
        if path is None:
            self._require()
        t0 = time.perf_counter()
        with quiet():
            model = load_model(path, model_type="qwen3_tts")
        log.info("loaded %s in %.1fs", repo.repo_id, time.perf_counter() - t0)
        return model

    def _generate(self, model: Any, text: str, seed: int, **kw: Any) -> np.ndarray:
        import mlx.core as mx

        mx.random.seed(seed)
        try:
            with quiet():
                results = list(model.generate(text=text, lang_code=LANGUAGE, max_tokens=_max_tokens(text),
                                              verbose=False, **kw))
        except Exception as e:  # noqa: BLE001 - surface model failures as a TTS error
            raise VoiceError("tts_failed", f"Qwen3-TTS failed on {text!r}: {e}", status=500) from e
        finally:
            mx.clear_cache()
        parts = [np.asarray(r.audio, dtype=np.float32).reshape(-1) for r in results if r.audio is not None]
        if not parts or not sum(len(p) for p in parts):
            raise VoiceError("tts_failed", f"Qwen3-TTS returned no audio for {text!r}.", status=500)
        return np.concatenate(parts)

    # -- VoiceDesign -------------------------------------------------------------------------------
    def design(self, description: str, text: str, n: int, base_seed: int | None = None) -> list[np.ndarray]:
        """n candidate readings of `text` in the described voice (24 kHz)."""
        return list(self.design_iter(description, text, n, base_seed))

    def design_iter(self, description: str, text: str, n: int, base_seed: int | None = None) -> Iterator[np.ndarray]:
        """Candidates one by one, as each finishes (about 3 s apart), so the UI can fill its slots progressively
        and a cancel can stop between candidates. The model lock is held per candidate, not across yields."""
        self._require()
        base_seed = base_seed if base_seed is not None else int(time.time() * 1000) & 0x7FFFFFFF
        with self._lock:
            model = self._load(models.QWEN3_DESIGN_REPO)
            self._designing += 1
        try:
            for i in range(n):
                with self._lock:
                    audio = self._generate(model, text, base_seed + i, instruct=description)
                yield audio
        finally:
            with self._lock:
                self._designing -= 1
            del model
            import mlx.core as mx

            mx.clear_cache()

    # -- Base clone ----------------------------------------------------------------------------------
    def clone(self, ref_audio: np.ndarray, ref_text: str, text: str, *, key: str) -> np.ndarray:
        """`text` in the voice of `ref_audio` (24 kHz) whose transcript is `ref_text`. `key` names the voice
        for the deterministic seed and the cache."""
        self._require()
        ck = (key, text)
        with self._lock:
            hit = self._cache.get(ck)
            if hit is not None:
                self._cache.move_to_end(ck)
                return hit
            if self._base is None:
                self._base = self._load(models.QWEN3_BASE_REPO)
            import mlx.core as mx

            out = self._generate(self._base, text, _seed(key, text), ref_audio=mx.array(ref_audio.astype(np.float32)),
                                 ref_text=ref_text)
            self._cache[ck] = out
            self._cache_bytes += out.nbytes
            while self._cache_bytes > _CACHE_BYTES and len(self._cache) > 1:
                _, old = self._cache.popitem(last=False)
                self._cache_bytes -= old.nbytes
            return out

    def unload(self) -> None:
        with self._lock:
            self._base = None
            self._cache.clear()
            self._cache_bytes = 0

    def try_unload(self) -> bool:
        """Unload unless a design or a line is in progress (then False): before the model's files are removed."""
        if not self._lock.acquire(blocking=False):
            return False
        try:
            if self._designing:
                return False
            self.unload()
            return True
        finally:
            self._lock.release()


class PersonaTTS:
    """TTSEngine adapter: one saved persona speaking through Qwen3 Base. Speed is applied afterwards with a
    pitch-preserving time stretch, since Qwen3 has no speed control."""

    def __init__(self, qwen: Qwen3Engine, persona_id: str, ref_audio: np.ndarray, ref_text: str) -> None:
        self.qwen = qwen
        self.persona_id = persona_id
        self.ref_audio = ref_audio
        self.ref_text = ref_text
        self.name = qwen.name
        self.sample_rate = SAMPLE_RATE

    def voices(self) -> list[VoiceSpec]:
        return []

    def is_installed(self, voice: str | None = None) -> bool:
        return self.qwen.is_installed()

    def load(self) -> None:
        pass

    def synthesize(self, text: str, voice: str, speed: float, *, plain: str | None = None) -> PhraseAudio:
        # misaki phoneme links mean nothing to Qwen3; the plain text keeps the lexicon respellings.
        audio = self.qwen.clone(self.ref_audio, self.ref_text, plain or text, key=self.persona_id)
        if abs(speed - 1.0) > 1e-3:
            audio = time_stretch(audio, SAMPLE_RATE, speed)
        return PhraseAudio(audio, SAMPLE_RATE, [])


def time_stretch(audio: np.ndarray, sr: int, speed: float) -> np.ndarray:
    """Pitch-preserving speed change (Rubber Band via pedalboard); speed 0.9 = 10% slower."""
    from pedalboard import time_stretch as _ts

    out = _ts(audio.astype(np.float32)[None, :], float(sr), stretch_factor=float(speed), high_quality=True)
    return np.asarray(out, dtype=np.float32).reshape(-1)


_engine: Qwen3Engine | None = None
_engine_lock = threading.Lock()


def get_qwen3() -> Qwen3Engine:
    global _engine
    with _engine_lock:
        if _engine is None:
            _engine = Qwen3Engine()
        return _engine
