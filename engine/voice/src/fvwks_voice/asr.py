"""Word timings for recordings.

Whisper large-v3-turbo writes the transcript. Qwen3-ForcedAligner then places each word, on an 80 ms grid. Two
refinements follow:
- Whisper's own word times (finer, but with outliers) are used wherever they agree with the aligner's within one
  grid step;
- the first word's start and the edges next to punctuation or a chunk break are snapped to the audible pause. It is
  the same guard as for Kokoro's words: no snapping inside continuous speech, where stop closures fool it.

Measured on Kokoro lines with known word times (4 voices, 100 words):

| | Starts: median / p90 / max | Ends: median / p90 / max |
|---|---|---|
| This module | 11.8 / 34.9 / 70 ms | 14.3 / 43.4 / 76 ms |
| The aligner alone | 14.5 / 51.2 / 70 ms | 21.1 / 54.8 / 76 ms |
"""

from __future__ import annotations

import re
import threading
import unicodedata
import warnings
from dataclasses import dataclass
from typing import Any, Sequence

import numpy as np

from . import models
from .dsp import find_pauses, resample
from .errors import VoiceError
from .lexicon import apply_caps_rule
from .util import quiet

SR = 48_000
ASR_SR = 16_000
GRID_S = 0.08  # the aligner's time step
SNAP_WINDOW_S = 0.10
MIN_WORD_S = 0.02
MIN_ALIGNED_S = 0.04  # shorter than this, an aligned word is a failure to repair
MAX_SECONDS = 300.0  # the aligner's comfortable input length
_PAUSE_END = tuple(",.;:!?…—")


@dataclass(frozen=True)
class AlignedWord:
    text: str  # as written, punctuation removed
    start_s: float
    end_s: float
    pause_after: bool = False  # punctuation or a chunk break follows


def _kept(ch: str) -> bool:
    return ch == "'" or unicodedata.category(ch)[0] in "LN"


def tokens(text: str) -> list[tuple[str, int, bool]]:
    """Words the way the aligner splits English: whitespace tokens with only letters, digits and apostrophes kept.
    Returns (word, char offset of the token, followed by punctuation)."""
    out = []
    for m in re.finditer(r"\S+", text):
        word = "".join(c for c in m.group(0) if _kept(c))
        if word:
            out.append((word, m.start(), m.group(0).rstrip("\"'”’)]").endswith(_PAUSE_END)))
    return out


class Transcriber:
    name = "whisper-aligner"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._whisper: Any = None
        self._aligner: Any = None

    def is_installed(self) -> bool:
        return models.is_installed(models.ASR)

    def _require(self) -> None:
        if not self.is_installed():
            raise VoiceError("model_not_installed", "Recording transcription isn't installed.",
                             "Install it from VOICES → Models (about 2.9 GB).", status=503, model_id=models.ASR.id)

    def _models(self) -> tuple[Any, Any]:
        if self._whisper is None or self._aligner is None:
            self._require()
            from mlx_audio.stt.utils import load_model
            from transformers import WhisperProcessor

            with quiet(), warnings.catch_warnings():
                # The MLX conversion has no processor files; mlx-audio warns, then we attach Whisper's own.
                warnings.filterwarnings("ignore", message="Could not load WhisperProcessor")
                whisper = load_model(models.repo_path(models.ASR, models.WHISPER_REPO), model_type="whisper")
                whisper._processor = WhisperProcessor.from_pretrained(
                    str(models.repo_path(models.ASR, models.WHISPER_TOKENIZER_REPO)))
                aligner = load_model(models.repo_path(models.ASR, models.ALIGNER_REPO), model_type="qwen3_forced_aligner")
            self._whisper, self._aligner = whisper, aligner
        return self._whisper, self._aligner

    # -- public -------------------------------------------------------------------------------------
    def transcribe(self, x: np.ndarray) -> tuple[str, list[AlignedWord]]:
        """Transcript and aligned words for mono 48 kHz speech."""
        x16 = self._prep(x)
        with self._lock:
            whisper, _ = self._models()
            try:
                with quiet():
                    r = whisper.generate(x16, language="en", word_timestamps=True, verbose=None)
            except Exception as e:  # noqa: BLE001
                raise VoiceError("transcribe_failed", f"Whisper failed: {e}", status=500) from e
            finally:
                _clear()
        text = " ".join((r.text or "").split())
        if not text:
            return "", []
        hint = [(str(w.get("word", "")).strip(), float(w["start"]), float(w["end"]))
                for seg in (r.segments or []) for w in seg.get("words", []) if "start" in w and "end" in w]
        return text, self.align(x, text, hint=hint)

    def align(self, x: np.ndarray, text: str, *, hint: Sequence[tuple[str, float, float]] | None = None,
              breaks: set[int] | None = None) -> list[AlignedWord]:
        """Place every word of `text` in the audio. `hint`: Whisper's words for the same text (used where they agree
        with the aligner). `breaks`: indexes of words followed by a chunk break (treated like punctuation)."""
        toks = tokens(text)
        if not toks:
            return []
        x16 = self._prep(x)
        with self._lock:
            _, aligner = self._models()
            try:
                with quiet():
                    res = aligner.generate(x16, text=_normal_case(text), language="English")
            except Exception as e:  # noqa: BLE001
                raise VoiceError("align_failed", f"Forced alignment failed: {e}", status=500) from e
            finally:
                _clear()
        items = list(res.items)
        if len(items) != len(toks):  # the tokenizers disagree; keep the aligner's words without refinement
            return [AlignedWord(it.text, float(it.start_time), float(it.end_time)) for it in items]
        words = [[float(it.start_time), float(it.end_time)] for it in items]
        hint = list(hint) if hint and len(hint) == len(words) else None
        if hint:
            for w, (_, hs, he) in zip(words, hint):
                if abs(hs - w[0]) < GRID_S:
                    w[0] = hs
                if abs(he - w[1]) < GRID_S:
                    w[1] = he
        _repair(words, [t[0] for t in toks], hint)
        pause_after = [t[2] or (breaks is not None and i in breaks) for i, t in enumerate(toks)]
        _snap(words, pause_after, x)
        for w in words:
            w[1] = max(w[1], w[0] + MIN_WORD_S)
        return [AlignedWord(t[0], w[0], w[1], p) for t, w, p in zip(toks, words, pause_after)]

    def unload(self) -> None:
        with self._lock:
            self._whisper = self._aligner = None

    def try_unload(self) -> bool:
        """Unload unless a transcription or alignment is running (then False): before the model's files go."""
        if not self._lock.acquire(blocking=False):
            return False
        try:
            self._whisper = self._aligner = None
            return True
        finally:
            self._lock.release()

    @staticmethod
    def _prep(x: np.ndarray) -> np.ndarray:
        x = np.asarray(x, dtype=np.float32).reshape(-1)
        if x.size / SR > MAX_SECONDS:
            raise VoiceError("audio_too_long", f"Transcription handles up to {MAX_SECONDS / 60:.0f} minutes.",
                             "Trim the recording first.", status=413)
        return resample(x, SR, ASR_SR)


def _normal_case(text: str) -> str:
    """The aligner was trained on normal text: an ALL-CAPS script collapses several words to
    zero length and misplaces the rest, while the same words in normal case align cleanly. Case never changes the
    word split, so the user's spelling is kept for the results."""
    t = apply_caps_rule(text)
    for i, c in enumerate(t):
        if c.isalpha():
            return t[:i] + c.upper() + t[i + 1:]
    return t


def _clear() -> None:
    import mlx.core as mx

    mx.clear_cache()


def _repair(words: list[list[float]], texts: list[str], hint: list[tuple[str, float, float]] | None) -> None:
    """In place. The aligner sometimes squeezes a word to nothing and hands its time to a neighbour (seen on the last
    word of a phrase: "OF" 2.08-2.96 s, "SIGNAL" 2.96-2.96 s). Such a word takes Whisper's times when Whisper
    has a plausible span for it; otherwise it and the neighbour that absorbed its time split their joint span in
    proportion to their letters."""
    n = len(words)
    for i in range(n):
        if words[i][1] - words[i][0] >= MIN_ALIGNED_S:
            continue
        if hint and hint[i][2] - hint[i][1] >= MIN_ALIGNED_S:
            hs, he = hint[i][1], hint[i][2]
            lo = words[i - 1][0] + MIN_WORD_S if i > 0 else 0.0
            hi = words[i + 1][1] - MIN_WORD_S if i + 1 < n else he
            hs, he = max(hs, lo), min(he, hi)
            if he - hs >= MIN_ALIGNED_S:
                words[i][0], words[i][1] = hs, he
                if i > 0:
                    words[i - 1][1] = min(words[i - 1][1], hs)
                if i + 1 < n:
                    words[i + 1][0] = max(words[i + 1][0], he)
                continue
        nbrs = [j for j in (i - 1, i + 1) if 0 <= j < n]
        if not nbrs:
            continue
        j = max(nbrs, key=lambda k: (words[k][1] - words[k][0]) / max(1, len(texts[k])))
        a, b = min(i, j), max(i, j)
        t0, t1 = words[a][0], words[b][1]
        if t1 - t0 < 2 * MIN_WORD_S:
            continue
        cut = t0 + (t1 - t0) * len(texts[a]) / max(1, len(texts[a]) + len(texts[b]))
        words[a][1] = words[b][0] = cut


def _snap(words: list[list[float]], pause_after: list[bool], x: np.ndarray) -> None:
    """In place: first start to the audible onset; edges around a pause to the pause edges (+-100 ms).

    The aligner can run a short word after a pause mostly into the pause ("REMEMBER, THE" gave THE 1.28-1.52 s for
    a pause that ends at 1.505 s). Its start still goes to the end of the pause, and it keeps at least MIN_ALIGNED_S,
    taking that time from the start of the next word, never below that word's own minimum."""
    pauses, onset = find_pauses(x, SR)
    if onset is not None and abs(onset - words[0][0]) <= SNAP_WINDOW_S:
        words[0][0] = min(onset, words[0][1] - MIN_WORD_S)
    n = len(words)
    for i in range(n - 1):
        if not pause_after[i]:
            continue
        lo, hi = words[i][1] - SNAP_WINDOW_S, words[i + 1][0] + SNAP_WINDOW_S
        found = [(t1 - t0, t0, t1) for t0, t1 in pauses if lo <= (t0 + t1) / 2 <= hi]
        if not found:
            continue
        _, t0, t1 = max(found)
        if t0 - words[i][0] < MIN_WORD_S:
            continue
        end = max(words[i + 1][1], t1 + MIN_ALIGNED_S)
        if i + 2 < n:
            if end > words[i + 2][1] - MIN_WORD_S:
                continue  # no room for the word after the pause: leave the aligner's edges
            words[i + 2][0] = max(words[i + 2][0], end)
        words[i][1], words[i + 1][0], words[i + 1][1] = t0, t1, end


_transcriber: Transcriber | None = None
_transcriber_lock = threading.Lock()


def get_transcriber() -> Transcriber:
    global _transcriber
    with _transcriber_lock:
        if _transcriber is None:
            _transcriber = Transcriber()
        return _transcriber
