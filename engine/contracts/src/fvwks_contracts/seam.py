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
    SongStructure,
    BassGroove,
    MashMatch,
    MashScanRequest,
    Song,
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
class StemFeatureData:
    """v0.9: what FxAPI.stem_features returns; the server wraps it as StemFeatures (base64 of `data`)."""

    fps: float
    tracks: list[str]  # the four stems in STEM_NAMES order, then "mix"
    data: np.ndarray  # uint8, shape (frames, len(tracks), 2): (rms, onset) as documented on StemFeatures
    bass: np.ndarray | None = None  # v0.10.1: uint8 (frames, 4) per StemFeatures.bass_b64; None when not computed


@dataclass
class MashFeatures:
    """v0.11.3: one song as MASH RADAR sees it. `feats` comes from FxAPI.mash_features (per-part arrays, a few KB,
    npz-ready); the server computes it once in the analysis/stems job, caches it next to the song, and recomputes it
    when the song's analysis or structure changes. A scan never touches audio."""

    song_id: str
    analysis: SongAnalysis
    structure: "SongStructure"
    feats: dict[str, np.ndarray]


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
    chop: "list | None" = None  # v0.8: list[ChopSlot] where each chopped piece landed (None when chop is off)
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


    # v0.10 structure (optional; the server checks with getattr)
    def song_structure(self, audio: np.ndarray, sr: int, analysis: SongAnalysis, *,
                       stems: dict[str, np.ndarray] | None = None) -> "SongStructure":
        """Sections, drops, builds and phrases of a whole song on its grid (`analysis`). `audio` is (channels, n) float32
        at `sr`; `stems` (STEM_NAMES → same shape) refine it when present (drum/bass entries mark drops)."""
        ...

    # v0.9 stems (optional, like the song methods: the server checks with getattr)
    def stem_features(self, stems: dict[str, np.ndarray], sr: int, mix: np.ndarray, *,
                      analysis: SongAnalysis | None = None, fps: float = 60.0) -> StemFeatureData:
        """Per-stem envelopes and onsets for the visuals. `stems` maps each of STEM_NAMES to (channels, n) float32
        at `sr`; `mix` is the whole song at `sr`. Onsets may lean on the song's beat grid (`analysis`)."""
        ...

    # v0.11 REMIX (optional; the server checks with getattr)
    def bass_groove(self, bass: np.ndarray, sr: int, analysis: SongAnalysis, *, song_id: str = "",
                    start_bar: int = 1, bars: int | None = None) -> "BassGroove":
        """BASS DNA of bars [start_bar, start_bar + bars) of a song's bass stem (`bass`, (channels, n) float32 at `sr`)
        on its grid (`analysis`): notes and glides, per-bar wobble, level and growl curves, all in beats."""
        ...

    def mash_features(self, audio: np.ndarray, sr: int, analysis: SongAnalysis, structure: "SongStructure", *,
                      vocals: np.ndarray | None = None) -> dict[str, np.ndarray]:
        """MASH RADAR per-part features of one song (`audio`, and the vocals stem when there is one, (channels, n)
        float32 at `sr`). Call it in the analysis/stems job and cache it (npz), never in the scan path."""
        ...

    def mash_scan(self, request: "MashScanRequest", query: MashFeatures,
                  library: "list[MashFeatures]") -> "list[MashMatch]":
        """MASH RADAR: rank the library songs' parts against the query song's part (request.song_id), cached features
        only."""
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

    def separate_stems(self, audio: np.ndarray, sr: int,
                       progress: Callable[[float | None, str | None], None]) -> dict[str, np.ndarray]:
        """v0.9 (optional; the server checks with getattr): split a song into STEM_NAMES, each (channels, n) float32 at
        `sr`, the same length as `audio`. Needs the optional stems model (list_models/install_model); raises the
        usual error with code "model_not_installed" (and model_id) when it isn't installed, like the persona designer. Runs in the song_stems job."""
        ...
