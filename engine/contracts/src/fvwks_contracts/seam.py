"""Python seams between the engine packages (frozen v0 contracts).

- fvwks_voice.api (S1) implements VoiceAPI as module-level functions.
- fvwks_fx.api (S2) implements FxAPI as module-level functions.
- fvwks_server (S3) is the only caller. It fills every None field of a RenderRequest (chain, macros, macro_map,
  stack) from the preset before calling fx.render, synthesizes STACK voices through voice.synthesize (cached by
  script, voice, speed and lexicon), and does all file writing.

Audio arrays are float32 numpy arrays shaped (channels, n_samples).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

import numpy as np

from collections.abc import Callable, Iterable
from pathlib import Path

from .models import (
    Chain,
    FitReport,
    Lexicon,
    Loudness,
    MacroMap,
    Macros,
    Master,
    MaskStrength,
    ModelInfo,
    Motion,
    PersonaDesignRequest,
    Preset,
    RackDescriptor,
    RenderRequest,
    ScriptPreview,
    Segment,
    SourceInfo,
    SongAnalysis,
    SongPlacement,
    SourceKind,
    TTSRequest,
    Voice,
)

ENGINE_SR = 48000


@dataclass
class Source:
    """A voice source: mono float32 audio at ENGINE_SR plus metadata (info.audio_id is assigned by the server)."""

    info: SourceInfo
    audio: np.ndarray  # shape (1, n), float32, ENGINE_SR


@dataclass
class MixOutput:
    """v0.7: a song + drop mix."""

    audio: np.ndarray  # (channels, n) float32 at sample_rate
    sample_rate: int
    start_s: float  # excerpt start on the song timeline
    drop_start_s: float  # drop start inside `audio`
    loudness: "Loudness | None" = None
    warnings: list[str] = field(default_factory=list)


@dataclass
class RenderOutput:
    audio: np.ndarray  # (channels, n) float32 at sample_rate; mastered; exact length
    dry: np.ndarray  # (channels, n) same length/rate: dry voice on the same plan, mastered to the same target (A/B, delivery-safe)
    sample_rate: int
    segments: list[Segment]  # placed on the output timeline
    fit: FitReport
    loudness: Loudness
    mask: MaskStrength
    resolved_chain: Chain
    first_word_s: float
    tail_s: float | None = None  # end of the last word on the output timeline (memory cue 'VOICE OUT'); None only without speech
    bars: int | None = None  # v0.2: bar count actually used (Arrange.bars 'auto' resolved); None = FREE
    motion: "Motion | None" = None  # v0.5: voice-core motion data (events, returns envelope, f0 track)
    stems: dict[str, np.ndarray] = field(default_factory=dict)  # 'dry' | 'voice' | 'layers' | 'fx'
    timings_ms: dict[str, float] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


class VoiceAPI(Protocol):
    def list_voices(self) -> list[Voice]: ...

    def synthesize(self, req: TTSRequest, lexicon: Lexicon | None = None) -> Source: ...

    def ingest(self, data: bytes, filename: str | None = None, kind: SourceKind = "import", *,
               denoise: float | None = None) -> Source: ...  # v0.3: denoise strength 0-1; None = default per kind

    def voice_sample(self, voice_id: str) -> Source: ...


class FxAPI(Protocol):
    def rack_schema(self) -> RackDescriptor: ...

    def list_presets(self) -> list[Preset]: ...

    def resolve(self, chain: Chain, macros: Macros, macro_map: MacroMap) -> Chain: ...

    def analyze(self, source: Source) -> None:
        """Warm per-source caches (e.g. WORLD analysis). Called in a background job after a source is created."""
        ...

    def render(self, main: Source, stack: list[Source | None], req: RenderRequest) -> RenderOutput:
        """`stack[i]` corresponds to req.stack[i]; None means pseudo-stack (detuned copy of main)."""
        ...

    # v0.7 songs (optional: the server checks with getattr and answers 501 until the sound engine has them)
    def analyze_song(self, audio: np.ndarray, sr: int) -> SongAnalysis:
        """Tempo, key and bar-1 position of a song. `audio` is (channels, n) float32 at `sr` (the file's own rate)."""
        ...

    def mix_song(self, song: np.ndarray, song_sr: int, drop: np.ndarray, drop_sr: int, *, drop_start_s: float,
                 bpm: float, placement: SongPlacement, excerpt_s: tuple[float, float] | None,
                 master: Master, quality: str) -> "MixOutput":
        """Put the (already mastered) drop into the song at `drop_start_s` on the song's timeline: duck the song
        under it, apply the gains, keep true peak <= master.true_peak_db, and return the excerpt
        [start, end) of the song timeline (None = the whole song) at master.sample_rate."""
        ...


class VoiceHooks(Protocol):
    """OPTIONAL module-level hooks on fvwks_voice.api (v0.1, accepted from S3's proposal P1).

    The server finds them with getattr and falls back to the v0 behaviour when one is missing. Errors that
    carry code/message/hint/status (S1's VoiceError) become the HTTP error unchanged.
    """

    ENGINE_NAME: str  # e.g. "kokoro-mlx"; shown in /api/health
    ENGINE_VERSION: str  # salts the TTS/stack caches

    def warm_up(self) -> None: ...  # called at engine start; /api/health reports loading_model until it returns

    def configure(self, data_dir: Path) -> None: ...  # <data dir>/voice, owned by the voice package

    def list_models(self) -> list[ModelInfo]: ...

    def install_model(self, model_id: str, progress: Callable[[float | None, str | None], None]) -> None:
        """progress() raises when the user cancels; let it propagate."""
        ...

    def design_persona(self, req: PersonaDesignRequest) -> Iterable[Source]: ...

    def save_persona(self, name: str, candidate: Source) -> Voice: ...

    def preview_script(self, script: str, lexicon: Lexicon | None = None, bpm: float | None = None) -> ScriptPreview: ...

    def transcribe(self, source: Source) -> Source:
        """v0.3: recordings/imports get info.script + Segment.words (Whisper + Qwen3-ForcedAligner). Background job."""
        ...

    def realign(self, source: Source, script: str) -> Source:
        """v0.3: apply an edited transcript (markup allowed): one segment per chunk with flags, words aligned."""
        ...
