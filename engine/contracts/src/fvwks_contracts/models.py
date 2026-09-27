"""Frozen API/data models for FoxBox (v0.7 contracts: songs (drop over your own track, baked exports, mixes for camera clips); v0.6: model manifest/uninstall, error model_id; voice-core motion data, model install reattach; installer/update fields; AUTO bars, denoise, transcripts; otherwise additive over v0).

These pydantic models are the single source of truth. contracts/openapi.yaml is exported from the server built
on them, and contracts/chain.schema.json is exported from Preset. Sessions don't edit this file; they send
proposals to contracts/proposals/S<n>.md.

Conventions:
- Engine-internal audio is float32 at 48 kHz. Final renders use Master.sample_rate (44.1 kHz by default).
- Times are in seconds unless a name says otherwise (`_ms`, `_beats`).
- The chain has a fixed *shape*: an ordered list of module states with free-form params. The modules, their
  params, ranges, labels and control kinds come at runtime from GET /api/rack (RackDescriptor, owned by S2),
  so the DSP can evolve without contract changes, and the UI renders one generic ModuleCard per module.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --------------------------------------------------------------------------- errors


class ApiError(Model):
    code: str = Field(description="Stable machine code, e.g. 'not_found', 'tts_failed', 'engine_busy'.")
    message: str = Field(description="Human-readable message, safe to show in the UI.")
    hint: str | None = Field(default=None, description="Optional next step for the user.")
    retryable: bool = False
    model_id: str | None = Field(default=None, description="For model_not_installed: the model to install (deep link) (v0.6, S3 P7).")


class ErrorEnvelope(Model):
    """Body of every non-2xx response."""

    error: ApiError


# --------------------------------------------------------------------------- audio primitives


class Peaks(Model):
    """Waveform overview: `buckets` min/max pairs of the channel-summed signal, normalized to [-1, 1]."""

    buckets: int
    duration_s: float
    min: list[float]
    max: list[float]


class SegmentFlags(Model):
    throw: bool = Field(default=False, description="*word* markup: gets the SPACE throw send.")
    beat_break: bool = Field(default=False, description="Chunk ended with '|': Beat-Lock starts the next chunk on the next beat.")
    pause_after_s: float = Field(default=0.0, ge=0, description="[0.5] markup.")
    pause_after_beats: float = Field(default=0.0, ge=0, description="[2b] markup.")


class Word(Model):
    """Word timing inside a segment (TTS sources only). Added in v0.1."""

    text: str = Field(description="As spoken, e.g. 'Fawkes' for FVWKS.")
    start_s: float = Field(description="Absolute Source time.")
    end_s: float
    throw: bool = Field(default=False, description="Inside *...*: S2 throws exactly these words.")


class Segment(Model):
    index: int
    text: str | None = Field(default=None, description="Original chunk text including markup, e.g. 'EXPECT *US*'.")
    start_s: float
    end_s: float
    flags: SegmentFlags = Field(default_factory=SegmentFlags)
    words: list[Word] = Field(default_factory=list, description="TTS sources only; empty for recordings (v0.1).")


SourceKind = Literal["tts", "recording", "import"]


class SourceInfo(Model):
    id: str
    kind: SourceKind
    name: str | None = None
    script: str | None = Field(default=None, description="Raw script with markup (TTS sources).")
    script_hash: str | None = Field(default=None, description="Hash of the script; STACK voices must share it (1:1 segments).")
    voice_id: str | None = None
    speed: float | None = None
    sample_rate: int
    duration_s: float
    segments: list[Segment]
    peaks: Peaks
    audio_id: str = Field(description="Fetch with GET /api/audio/{audio_id}.")
    created_at: str
    bpm: float | None = Field(default=None, description="BPM used to size [Nb] pauses (TTS only). Stack voices reuse it (v0.1).")
    warnings: list[str] = Field(default_factory=list, description="Parser/ingest warnings, e.g. unmatched '*' (v0.1).")
    analysis_state: Literal["none", "queued", "running", "done", "error"] = Field(
        default="none", description="Background WORLD analysis state; UI can show 'analysing…' (v0.1).")
    denoise: float | None = Field(default=None, ge=0, le=1, description="DeepFilterNet3 strength applied at ingest (recordings/imports); None for TTS (v0.3).")
    transcript_state: Literal["none", "queued", "running", "done", "error"] = Field(
        default="none", description="Background transcribe+align state for recordings; UI can show 'transcribing…' (v0.3).")


class TranscriptUpdate(Model):
    """Edited transcript for a recording (markup allowed): re-segments and re-aligns words, like TTS (v0.3)."""

    script: str = Field(min_length=1, max_length=2000)


class SourceList(Model):
    items: list[SourceInfo]
    total: int


class TTSRequest(Model):
    script: str = Field(min_length=1, max_length=2000, description="Markup: '|' beat break, [0.5] pause s, [2b] pause beats, *word* throw.")
    voice_id: str = "kokoro:am_fenrir"
    speed: float = Field(default=0.9, ge=0.5, le=2.0)
    bpm: float | None = Field(default=None, ge=60, le=200, description="Needed to size [Nb] pauses; defaults to 120.")
    name: str | None = None


class ScriptPreviewRequest(Model):
    script: str = Field(min_length=1, max_length=2000)
    bpm: float | None = Field(default=None, ge=60, le=200)


class ScriptPreviewSegment(Model):
    text: str = Field(description="Chunk as typed, including markup.")
    say: str = Field(description="What TTS will say after lexicon + ALL-CAPS handling.")
    flags: SegmentFlags = Field(default_factory=SegmentFlags)


class ScriptPreview(Model):
    """Parse without synthesizing (ScriptEditor highlighting). Same shape as fixtures/markup_cases.json (v0.1)."""

    segments: list[ScriptPreviewSegment]
    warnings: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------- voices, models, health


class Voice(Model):
    id: str = Field(description="'kokoro:am_fenrir' | 'persona:<id>'")
    engine: Literal["kokoro", "qwen3", "persona"]
    name: str
    language: str = Field(description="BCP-47, e.g. 'en-US', 'en-GB'.")
    gender: Literal["male", "female", "neutral"]
    tags: list[str] = Field(default_factory=list)
    recommended: bool = False
    installed: bool = True
    sample_audio_id: str | None = Field(default=None, description="Short audition clip, if available.")
    description: str | None = None


class ModelInfo(Model):
    id: str
    name: str
    engine: str
    size_bytes: int
    installed: bool
    required: bool = Field(description="Required models ship by default; others are opt-in downloads.")
    license: str
    description: str
    version: str | None = Field(default=None, description="Latest available version of this model package (v0.4).")
    installed_version: str | None = Field(default=None, description="Installed version, if any (v0.4).")
    update_available: bool = Field(default=False, description="installed_version is older than version (v0.4).")
    default_selected: bool = Field(default=False, description="Installer pre-ticks this optional model (v0.4).")
    install_job_id: str | None = Field(default=None, description="Running install job for this model, so UIs can reattach after a reload (v0.5, S3 P6).")
    install_needs_bytes: int | None = Field(default=None, description="Remaining download + the disk reserve needed to install (v0.5, S3 P6).")


EngineState = Literal["starting", "loading_model", "ready", "error"]


class ManifestRepo(Model):
    repo_id: str
    revision: str = Field(description="Pinned Hugging Face commit sha (content-addressed).")
    size_bytes: int


class ManifestModel(Model):
    version: str
    notes: str | None = None
    repos: list[ManifestRepo]


class ModelManifest(Model):
    """Model-update manifest published with app releases (v0.6, S3 P9). Only same-file-name/same-license pin moves."""

    schema_version: int = Field(default=1)
    published: str
    models: dict[str, ManifestModel]


class SignedModelManifest(Model):
    """PUT /api/models/manifest body: the manifest plus a base64 ed25519 signature over its canonical JSON (v0.6)."""

    manifest: ModelManifest
    signature: str
    key_id: str | None = None


class Health(Model):
    state: EngineState
    version: str
    progress: float | None = Field(default=None, ge=0, le=1, description="While loading_model.")
    message: str | None = None
    voice_engine: str = Field(description="e.g. 'stub', 'kokoro-mlx'.")
    fx_engine: str = Field(description="e.g. 'stub', 'fvwks-rack'.")
    disk_free_bytes: int
    data_dir: str
    export_dir: str
    required_missing: list[str] = Field(default_factory=list, description="Required model ids not installed yet; the installer/first-run screen fetches them (v0.4).")


# --------------------------------------------------------------------------- rack descriptor (runtime, S2-owned values)

ControlKind = Literal["knob", "fader", "switch", "select", "segmented", "number"]
ParamValue = float | int | str | bool


class ParamSpec(Model):
    id: str
    label: str
    kind: ControlKind
    default: ParamValue
    min: float | None = None
    max: float | None = None
    step: float | None = None
    unit: str | None = Field(default=None, description="'st', 'dB', 'Hz', 'ms', '%', 's', 'beats', 'x'.")
    scale: Literal["lin", "log"] = "lin"
    options: list[str] | None = Field(default=None, description="For select/segmented.")
    description: str | None = None
    advanced: bool = False


class ModuleSpec(Model):
    id: str = Field(description="'prep', 'mask', 'layers', 'machine', 'drive', 'crush', 'tone', 'motion', 'dynamics', 'space', 'stereo'.")
    label: str
    description: str
    params: list[ParamSpec]
    available: bool = Field(default=True, description="False → not implemented yet; rendered bypassed with a warning.")


MacroId = Literal["depth", "grit", "machine", "space"]


class MacroSpec(Model):
    id: MacroId
    label: str
    description: str


class RackDescriptor(Model):
    version: str
    modules: list[ModuleSpec] = Field(description="In fixed rack order.")
    macros: list[MacroSpec]


# --------------------------------------------------------------------------- chain, macros, stack


class ModuleState(Model):
    id: str
    enabled: bool = True
    params: dict[str, ParamValue] = Field(default_factory=dict, description="Missing params use the rack default.")


class Chain(Model):
    modules: list[ModuleState] = Field(default_factory=list, description="Modules not listed are disabled. Order is fixed by the rack.")


class Macros(Model):
    depth: float = Field(default=0.0, ge=0, le=1)
    grit: float = Field(default=0.0, ge=0, le=1)
    machine: float = Field(default=0.0, ge=0, le=1)
    space: float = Field(default=0.0, ge=0, le=1)


class MacroTarget(Model):
    module: str
    param: str
    min: float = Field(description="Value at macro = 0.")
    max: float = Field(description="Value at macro = 1.")
    curve: Literal["lin", "exp", "log"] = "lin"


class MacroMap(Model):
    """Macro-controlled params are overwritten by interpolation (like an Ableton macro rack)."""

    depth: list[MacroTarget] = Field(default_factory=list)
    grit: list[MacroTarget] = Field(default_factory=list)
    machine: list[MacroTarget] = Field(default_factory=list)
    space: list[MacroTarget] = Field(default_factory=list)


class StackVoice(Model):
    """Extra voice layered on the main one (the 'robotic TTS collage')."""

    voice_id: str | None = Field(default=None, description="None → pseudo-stack: a detuned copy of the main source (use for recordings).")
    pitch_st: float = Field(default=0.0, ge=-24, le=24)
    formant_st: float = Field(default=0.0, ge=-12, le=12)
    pan: float = Field(default=0.0, ge=-1, le=1)
    gain_db: float = Field(default=-12.0, ge=-60, le=6)


# --------------------------------------------------------------------------- arrange / master

BarsChoice = Literal[1, 2, 4, 8, 16]
BarsSetting = BarsChoice | Literal["auto"]  # v0.2: "auto" = nearest standard bar count that fits (see audio.resolve_auto_bars)


class Arrange(Model):
    bpm: float = Field(default=140.0, ge=60, le=200)
    bars: BarsSetting | None = Field(default="auto", description="'auto' (default) = the standard bar count (1/2/4/8/16) nearest to the phrase's natural length that it fits, padding or compressing by at most max_stretch (fvwks_contracts.audio.resolve_auto_bars). None = FREE (no grid fit). RenderInfo.bars reports the resolved count.")
    key: str = Field(default="Am", description="Root + optional 'm', e.g. 'Am', 'F#m', 'C'. Drives monotone and vocoder notes.")
    fit: Literal["auto", "pad", "stretch"] = Field(default="auto", description="auto (v0.4): warp to the grid per snap_end, pad the rest with the tail; if even max_stretch can't fit, grow to the next bar count (FitReport.status 'extended'), never cut. pad: no time manipulation. stretch: always stretch to fill.")
    max_stretch: float = Field(default=0.08, ge=0, le=0.25)
    beat_lock: bool = False
    first_word_beat: float = Field(default=0.0, ge=0, description="Where the first word lands, in beats from the file start (room for swells/pre-roll).")
    tail_beats: float = Field(default=0.0, ge=0, description="Ring-out reserved at the end, inside the N bars.")
    snap_end: Literal["off", "beat", "bar"] = Field(default="beat", description="v0.4.1: time-manipulate the phrase so its first word starts on the downbeat and its LAST word ends exactly on a beat ('beat') or bar line ('bar'), stretching/squeezing within max_stretch (R3), then let the tail ring; 'off' = natural length. Speech is never truncated.")
    auto_tail: bool = Field(default=True, description="Reserve room after the last word for its natural release and the chain's FX tail (reverb/delay/throws) when fitting; speech is never truncated (v0.4).")
    fade_in_ms: float = Field(default=2.0, ge=0)
    fade_out_ms: float = Field(default=30.0, ge=0)


class Master(Model):
    mode: Literal["club", "bake", "custom"] = "club"
    target_lufs: float = Field(default=-7.0, description="club: short-term (3 s) max; custom: integrated.")
    true_peak_db: float = Field(default=-1.0, le=0)
    bake_peak_db: float = Field(default=-6.0, le=0)
    sample_rate: Literal[44100, 48000] = 44100
    channels: Literal[1, 2] = 2


# --------------------------------------------------------------------------- presets


class Preset(Model):
    id: str
    name: str
    description: str
    factory: bool = False
    tags: list[str] = Field(default_factory=list)
    voice_hint: str | None = None
    speed_hint: float | None = None
    chain: Chain
    macros: Macros = Field(default_factory=Macros)
    macro_map: MacroMap = Field(default_factory=MacroMap)
    stack: list[StackVoice] = Field(default_factory=list, max_length=3)
    arrange_hint: dict[str, ParamValue | None] = Field(default_factory=dict, description="Partial Arrange overrides, e.g. {'first_word_beat': 4}.")
    master_hint: dict[str, ParamValue | None] = Field(default_factory=dict)


# --------------------------------------------------------------------------- render

Quality = Literal["preview", "final"]


class RenderRequest(Model):
    source_id: str
    preset_id: str | None = None
    chain: Chain | None = Field(default=None, description="None → preset's chain. The server fills None fields from the preset before calling fx.")
    macros: Macros | None = None
    macro_map: MacroMap | None = None
    stack: list[StackVoice] | None = Field(default=None, max_length=3)
    arrange: Arrange = Field(default_factory=Arrange)
    master: Master = Field(default_factory=Master)
    quality: Quality = "preview"
    stems: bool = False
    auto_export: bool = Field(default=True, description="Final renders also write the wet file to the export root so it is drag-ready.")


class FitReport(Model):
    status: Literal["fits", "stretched", "extended", "overflow", "free"] = Field(
        description="'extended' (v0.4): the phrase + tail did not fit the requested bars, so the render grew to the next bar count instead of cutting speech. 'overflow' is legacy (speech is never truncated from v0.4).")
    speech_s: float
    available_s: float
    total_s: float
    stretch_ratio: float = 1.0
    suggested_bars: int | None = None
    message: str
    reserved_tail_s: float | None = Field(default=None, description="Room kept after the last word for its release + FX tail (v0.4).")


class Loudness(Model):
    integrated_lufs: float | None = None
    short_term_max_lufs: float | None = None
    true_peak_db: float
    sample_peak_db: float


class MaskStrength(Model):
    level: Literal["synthetic", "weak", "medium", "strong"]
    score: float
    reasons: list[str]


class StemInfo(Model):
    name: Literal["dry", "voice", "layers", "fx"]
    audio_id: str


class ExportedFile(Model):
    id: str
    render_id: str
    variant: str = Field(description="'wet' | 'dry' | 'alt:<preset_id>' | 'stem:<name>' | 'baked' (v0.7: the song with the drop in it)")
    title: str
    filename: str
    path: str = Field(description="Absolute path inside the export root.")
    format: Literal["aiff", "wav"]
    sample_rate: int
    bit_depth: int
    channels: int
    n_samples: int
    duration_s: float
    bpm: float | None = None
    key: str | None = None
    bars: int | None = None
    first_word_s: float = 0.0
    tail_s: float | None = Field(default=None, description="End of the last word (rekordbox memory cue 'VOICE OUT').")
    size_bytes: int
    created_at: str


class MotionEvent(Model):
    """Exact arrange event for the voice-core visuals (v0.5, S2 proposal 10)."""

    t: float = Field(description="Output-timeline seconds.")
    dur: float = Field(ge=0)
    kind: Literal["beat_lock", "stutter", "tape_stop", "swell", "throw_echo", "squelch"]


class Motion(Model):
    """Voice-core motion data: exact arrange events plus two per-frame tracks (frames = ceil(duration_s * fps)) (v0.5)."""

    fps: int = 50
    events: list[MotionEvent] = Field(default_factory=list)
    returns: str = Field(description="base64 uint8 per frame: SPACE returns (reverb+delay+throws), 0..255 = -60..0 dB re the loudest frame of the mix.")
    f0: str = Field(description="base64 uint8 per frame: output pitch as MIDI note x 2 (0 = unvoiced).")


class RenderInfo(Model):
    id: str
    source_id: str
    preset_id: str | None = None
    quality: Quality
    created_at: str
    sample_rate: int
    channels: int
    n_samples: int
    duration_s: float
    audio_id: str
    dry_audio_id: str = Field(description="Dry voice placed on the same plan as the wet (onset, stretch, Beat-Lock, stutter) and mastered to the same target, so it is delivery-safe (A/B).")
    peaks: Peaks
    dry_peaks: Peaks
    segments: list[Segment] = Field(description="Placed on the output timeline.")
    bpm: float
    bars: int | None = None
    key: str
    first_word_s: float
    tail_s: float | None = Field(default=None, description="End of the last word on the output timeline (rekordbox memory cue 'VOICE OUT'), independent of tail_beats; None only without speech.")
    fit: FitReport
    loudness: Loudness
    mask: MaskStrength
    resolved_chain: Chain
    macros: Macros
    stems: list[StemInfo] = Field(default_factory=list)
    export: ExportedFile | None = Field(default=None, description="Set when a final render auto-exported.")
    timings_ms: dict[str, float] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    motion: Motion | None = Field(default=None, description="Voice-core motion data (v0.5); None when fx doesn't provide it.")


# --------------------------------------------------------------------------- exports


class ExportRequest(Model):
    render_ids: list[str] = Field(min_length=1)
    format: Literal["aiff", "wav"] = "aiff"
    bit_depth: Literal[16, 24] = 24
    variants: list[str] = Field(default_factory=lambda: ["wet"], description="'wet' | 'dry' | 'alt:<preset_id>'")
    stems: bool = False
    title: str | None = None
    bake: "SongPlacement | None" = Field(default=None, description=(
        "v0.7: also write the song with this drop baked in (variant 'baked'), one per render. start_bar/end_bar "
        "cut an excerpt; None = the whole song."))


class ExportResult(Model):
    files: list[ExportedFile]
    warnings: list[str] = Field(default_factory=list, description="e.g. 'no stems: the sound engine doesn't produce them yet' (v0.1).")


class RekordboxRequest(Model):
    export_ids: list[str] = Field(min_length=1)
    playlist: str = "GUY FVWKS — Drops"
    target_path_root: str | None = Field(default=None, description="Rewrite file locations for another Mac (e.g. the Rekordbox laptop).")


class RekordboxResult(Model):
    path: str
    filename: str
    tracks: int
    playlist: str


# --------------------------------------------------------------------------- library


class Take(Model):
    id: str
    render_id: str
    source_id: str | None = Field(default=None, description="For 'Open in Studio' without an extra round trip (v0.1).")
    title: str
    created_at: str
    starred: bool = False
    tags: list[str] = Field(default_factory=list)
    script: str | None = None
    source_kind: SourceKind
    voice_id: str | None = None
    preset_id: str | None = None
    preset_name: str | None = None
    bpm: float
    bars: int | None = None
    key: str
    duration_s: float
    loudness: Loudness
    mask: MaskStrength
    audio_id: str
    peaks: Peaks
    exports: list[ExportedFile] = Field(default_factory=list)


class TakePatch(Model):
    title: str | None = None
    starred: bool | None = None
    tags: list[str] | None = None


class LibraryPage(Model):
    items: list[Take]
    total: int


# --------------------------------------------------------------------------- jobs, batch, personas

JobState = Literal["queued", "running", "done", "error", "cancelled"]


class JobItem(Model):
    index: int
    label: str
    state: JobState
    progress: float = Field(default=0.0, ge=0, le=1)
    error: ApiError | None = None
    result_ids: list[str] = Field(default_factory=list, description="e.g. take/export ids produced by this item.")


class Job(Model):
    id: str
    kind: Literal["model_install", "batch", "analysis", "persona_design", "song_analysis"]
    state: JobState
    progress: float = Field(default=0.0, ge=0, le=1)
    message: str | None = None
    items: list[JobItem] = Field(default_factory=list)
    result_ids: list[str] = Field(default_factory=list, description="batch: export ids (+ rekordbox xml path in message); persona_design: candidate ids.")
    error: ApiError | None = None
    created_at: str
    updated_at: str
    bytes_done: int | None = Field(default=None, description="Download/installer progress in bytes (v0.4).")
    bytes_total: int | None = Field(default=None, description="Total bytes for this job, when known (v0.4).")
    rate_bps: float | None = Field(default=None, description="Current transfer rate, bytes per second (v0.4).")
    eta_s: float | None = Field(default=None, description="Estimated seconds remaining (v0.4).")
    current_item: str | None = Field(default=None, description="What is being fetched right now, e.g. a model file or component name (v0.4).")


class BatchLine(Model):
    script: str = Field(min_length=1, max_length=2000)
    title: str | None = None
    voice_id: str | None = None
    preset_id: str | None = None
    bpm: float | None = Field(default=None, ge=60, le=200)
    bars: BarsSetting | None = None
    key: str | None = None


class BatchExportOptions(Model):
    format: Literal["aiff", "wav"] = "aiff"
    bit_depth: Literal[16, 24] = 24
    variants: list[str] = Field(default_factory=lambda: ["wet"])


class BatchRequest(Model):
    lines: list[BatchLine] = Field(min_length=1, max_length=200)
    voice_id: str = "kokoro:am_fenrir"
    speed: float = Field(default=0.9, ge=0.5, le=2.0)
    preset_id: str = "pact"
    macros: Macros | None = None
    arrange: Arrange = Field(default_factory=Arrange)
    master: Master = Field(default_factory=Master)
    export: BatchExportOptions = Field(default_factory=BatchExportOptions)
    playlist: str | None = Field(default=None, description="Also write rekordbox.xml with this playlist name.")


class PersonaDesignRequest(Model):
    description: str = Field(min_length=3, max_length=500)
    sample_text: str = "We are Guy Fawkes. Expect us."
    candidates: int = Field(default=3, ge=1, le=4)


class PersonaCandidate(Model):
    id: str
    audio_id: str
    description: str


class PersonaSaveRequest(Model):
    candidate_id: str
    name: str = Field(min_length=1, max_length=60)


# --------------------------------------------------------------------------- settings, lexicon


class RekordboxSettings(Model):
    hot_cue_first_word: bool = True
    memory_cue_tail: bool = True
    target_path_root: str | None = None
    playlist_default: str = "GUY FVWKS — Drops"


class Settings(Model):
    export_dir: str
    format: Literal["aiff", "wav"] = "aiff"
    bit_depth: Literal[16, 24] = 24
    master: Master = Field(default_factory=Master)
    filename_pattern: str = "GUYFVWKS_{preset}_{slug}_{bpm}bpm_{bars}bar_{key}_{variant}_v{version:02d}"
    artist: str = "GUY FVWKS"
    rekordbox: RekordboxSettings = Field(default_factory=RekordboxSettings)
    default_voice_id: str = "kokoro:am_fenrir"
    default_preset_id: str = "pact"
    default_bpm: float = Field(default=140.0, ge=60, le=200)
    default_bars: BarsSetting = "auto"
    default_key: str = "Am"


class LexiconEntry(Model):
    word: str = Field(min_length=1)
    say: str = Field(min_length=1, description="Respelling or /phonemes/ (misaki syntax).")
    acronym: bool = Field(default=False, description="Keep ALL-CAPS (spell it out) instead of lower-casing.")


class Lexicon(Model):
    entries: list[LexiconEntry]


_ACRONYMS = ["DJ", "MC", "BPM", "CDJ", "VIP", "EDM", "UK", "USA", "FBI", "CIA", "NSA", "TV"]

DEFAULT_LEXICON = Lexicon(
    entries=[
        LexiconEntry(word="FVWKS", say="Fawkes"),
        *[LexiconEntry(word=a, say=a, acronym=True) for a in _ACRONYMS],
    ]
)


# --------------------------------------------------------------------------- songs (v0.7)


class SongAnalysis(Model):
    """Tempo, key and grid of an imported song (v0.7). Produced by the sound engine (FxAPI.analyze_song)."""

    bpm: float = Field(gt=0)
    bpm_confidence: float = Field(default=0.0, ge=0, le=1)
    key: str | None = Field(default=None, description="e.g. 'Am', 'F#'; None when the key is unclear.")
    camelot: str | None = Field(default=None, description="e.g. '8A'.")
    key_confidence: float = Field(default=0.0, ge=0, le=1)
    downbeat_s: float = Field(default=0.0, ge=0, description="Time of bar 1, beat 1: the grid anchor.")
    beats_per_bar: int = Field(default=4, ge=1)


class Song(Model):
    """A track the user imported to put drops over (v0.7). Songs are local-only; they never leave the Mac."""

    id: str
    name: str
    duration_s: float
    sample_rate: int
    channels: int
    peaks: Peaks
    audio_id: str = Field(description="Stream with GET /api/audio/{audio_id} (preview / backing track).")
    analysis_state: Literal["queued", "running", "done", "error"] = "queued"
    analysis: SongAnalysis | None = None
    bpm_override: float | None = Field(default=None, gt=0, description="User's tempo when the detected one is wrong.")
    downbeat_override_s: float | None = Field(default=None, ge=0, description="User's bar-1 position (grid nudge).")
    key_override: str | None = None
    created_at: str


class SongUpdate(Model):
    """PATCH body. Only the fields present are applied; an explicit null clears an override."""

    name: str | None = Field(default=None, min_length=1, max_length=200)
    bpm_override: float | None = Field(default=None, gt=0)
    downbeat_override_s: float | None = Field(default=None, ge=0)
    key_override: str | None = None


class SongPlacement(Model):
    """Where a drop sits in a song, and how the two are balanced (v0.7)."""

    song_id: str
    at_bar: int = Field(default=1, ge=1, description="Song bar (1-based, on the song's grid) where the drop starts.")
    duck_db: float = Field(default=-6.0, ge=-24, le=0, description="Song level under the drop (sidechain-style duck).")
    song_gain_db: float = Field(default=0.0, ge=-24, le=12)
    drop_gain_db: float = Field(default=0.0, ge=-24, le=12)
    start_bar: int | None = Field(default=None, ge=1, description="Excerpt start bar (camera clips, previews); None = song start.")
    end_bar: int | None = Field(default=None, ge=2, description="Excerpt end bar, exclusive; None = song end.")


class MixRequest(Model):
    render_id: str
    placement: SongPlacement
    quality: Literal["preview", "final"] = "preview"


class MixInfo(Model):
    """A song + drop mix (v0.7): the backing-track preview, and the soundtrack of camera clips."""

    id: str
    render_id: str
    song_id: str
    audio_id: str = Field(description="Stream with GET /api/audio/{audio_id}.")
    sample_rate: int
    duration_s: float
    start_s: float = Field(default=0.0, description="Where this mix starts on the song's timeline (excerpt start).")
    drop_start_s: float = Field(description="Where the drop starts inside this mix.")
    peaks: Peaks
    loudness: Loudness | None = None
    warnings: list[str] = Field(default_factory=list)


ExportRequest.model_rebuild()  # v0.7: ExportRequest.bake refers to SongPlacement, defined above
