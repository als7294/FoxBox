"""TTS engine protocol. Kokoro-MLX is the default; a persona engine (Qwen3-TTS) can slot in later."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

import numpy as np


@dataclass(frozen=True)
class WordTiming:
    text: str
    start_s: float  # relative to the start of the phrase audio
    end_s: float
    char_start: int = -1  # offsets into the phrase's plain text; -1 when the word couldn't be matched
    char_end: int = -1


@dataclass
class PhraseAudio:
    audio: np.ndarray  # mono float32 at `sample_rate`
    sample_rate: int
    words: list[WordTiming] = field(default_factory=list)


@dataclass(frozen=True)
class VoiceSpec:
    id: str  # engine-local id, e.g. "am_fenrir"
    name: str
    language: str  # BCP-47
    gender: str  # "male" | "female" | "neutral"
    tags: tuple[str, ...] = ()
    recommended: bool = False
    description: str | None = None


class TTSEngine(Protocol):
    name: str  # reported in /api/health, e.g. "kokoro-mlx"
    sample_rate: int

    def voices(self) -> list[VoiceSpec]: ...

    def is_installed(self, voice: str | None = None) -> bool: ...

    def load(self) -> None:
        """Load weights and warm up. Idempotent and thread-safe."""
        ...

    def synthesize(self, text: str, voice: str, speed: float, *, plain: str | None = None) -> PhraseAudio:
        """One phrase. `text` may carry engine markup (misaki phoneme links); `plain` is the same text
        without it, used to map word timings back to character offsets."""
        ...
