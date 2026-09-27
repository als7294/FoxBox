"""fvwks_voice public seam: VoiceAPI plus the optional VoiceHooks (fvwks_contracts.seam). fvwks_server is the only
caller; it calls these from worker threads and serializes voice work.

VoiceAPI
- list_voices(): the 28 English Kokoro voices ("kokoro:<id>") and saved personas ("persona:<id>").
- synthesize(req, lexicon): one Segment per markup chunk, with word timings for Kokoro voices. STACK voices given
  the same script get the same segments (count, texts, flags) and script_hash; only the times differ.
- ingest(data, filename, kind, denoise=None): WAV/AIFF/FLAC/MP3 -> cleaned 48 kHz mono (DeepFilterNet3, on by
  default for recordings and imports), segments split on silence.
- voice_sample(voice_id): a short audition line, cached per voice.

VoiceHooks
- ENGINE_NAME, ENGINE_VERSION, warm_up(), configure(data_dir), preview_script(script, lexicon, bpm)
- list_models() / install_model(model_id, progress): kokoro-82m (required), qwen3-tts-voicedesign (personas)
- design_persona(req) -> candidate Sources; save_persona(name, candidate) -> Voice
- transcribe(source) -> Source: recordings get a transcript and Segment.words (Whisper + Qwen3-ForcedAligner).
  Slow-ish (about 1.5 s for 5 s), so the server runs it in the background after an upload.
- realign(source, script) -> Source: the user's edited transcript, markup included, re-segments a recording
  (one segment per chunk, flags and per-word throws), exactly like TTS.

Failures raise fvwks_voice.errors.VoiceError (code, message, hint, HTTP status).
"""

from __future__ import annotations

import hashlib

# Import MLX on the importing (normally main) thread. MLX 0.32 keeps one compile cache per thread and its atexit
# hook clears only the first importer's, so a first import on a worker thread can segfault at exit (found by S3).
import mlx.core  # noqa: F401
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Callable, Iterator

import numpy as np

from fvwks_contracts.audio import peaks
from fvwks_contracts.models import (
    Lexicon,
    ModelInfo,
    ModelManifest,
    PersonaDesignRequest,
    ScriptPreview,
    ScriptPreviewSegment,
    Segment,
    SegmentFlags,
    SourceInfo,
    SourceKind,
    TTSRequest,
    Voice,
    Word,
)
from fvwks_contracts.seam import ENGINE_SR, Source

from . import models
from .dsp import SR, f0_tag, fade, normalize_speech, resample, speech_bounds
from .engine import TTSEngine
from .asr import AlignedWord, get_transcriber, tokens as asr_tokens
from .errors import VoiceError
from .espeak_path import ensure_short_espeak_path
from .ingest import ingest_audio
from .lexicon import Lexicon as VoiceLexicon
from .markup import parse, speak_chunk
from .personas import Persona, PersonaStore, default_root
from .synth import VoiceRender, render_script
from .tts_kokoro import get_engine
from .tts_qwen3 import SAMPLE_RATE as QWEN3_SR, PersonaTTS, get_qwen3


def _dist(name: str) -> str:
    try:
        return version(name)
    except PackageNotFoundError:  # pragma: no cover
        return "0"


ENGINE_NAME = "kokoro-mlx"
_BUILD = "s1.5"  # bump whenever synthesis output changes: ENGINE_VERSION salts the server's TTS and STACK caches


def _engine_version() -> str:
    """Build, mlx-audio and the Kokoro revision in use (a manifest update changes it once it's installed)."""
    used = models.active(models.KOKORO) or models.KOKORO
    return f"{_BUILD}+mlx-audio-{_dist('mlx-audio')}+kokoro-{used.repos[0].revision[:8]}"


ENGINE_VERSION = _engine_version()
SAMPLE_LINE = "We are Guy Fawkes. Expect us."
_NAME_CHARS = 60

__all__ = ["ENGINE_NAME", "ENGINE_VERSION", "VoiceError", "apply_model_manifest", "configure", "design_persona",
           "ingest", "install_model", "list_models", "list_voices", "preview_script", "realign", "save_persona",
           "synthesize", "transcribe", "uninstall_model", "voice_sample", "warm_up"]
# DeepFilterNet3 strength when the caller doesn't choose: on for anything recorded, never for TTS.
DEFAULT_DENOISE: dict[str, float] = {"recording": 1.0, "import": 1.0, "tts": 0.0}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def script_hash(script: str) -> str:
    return hashlib.sha256(script.encode()).hexdigest()[:16]


# -- configuration ------------------------------------------------------------------------------
_store: PersonaStore | None = None
_store_lock = threading.Lock()


def configure(data_dir: Path) -> None:
    """Called once at engine start with <engine data dir>/voice, a folder this package owns (personas, and the
    model pins a manifest set)."""
    global _store, ENGINE_VERSION
    with _store_lock:
        _store = PersonaStore(Path(data_dir) / "personas")
    models.configure(Path(data_dir))
    ENGINE_VERSION = _engine_version()
    ensure_short_espeak_path()  # before anything can start espeak


def _personas() -> PersonaStore:
    global _store
    with _store_lock:
        if _store is None:
            _store = PersonaStore(default_root())
        return _store


def warm_up() -> None:
    """Load Kokoro and run the warm-up lines (~5 s). Called once at engine start, off the request path."""
    ensure_short_espeak_path()
    get_engine().load()


# -- voices ---------------------------------------------------------------------------------------
@dataclass(frozen=True)
class _Voice:
    voice_id: str  # canonical, e.g. "kokoro:am_fenrir" or "persona:3f2a…"
    engine: TTSEngine
    engine_voice: str  # what the engine's synthesize() takes
    name: str


def _resolve(voice_id: str) -> _Voice:
    engine_name, sep, vid = voice_id.partition(":")
    if not sep:
        engine_name, vid = "kokoro", voice_id
    if engine_name == "kokoro":
        eng = get_engine()
        eng.check_voice(vid)
        name = next((v.name for v in eng.voices() if v.id == vid), vid)
        return _Voice(f"kokoro:{vid}", eng, vid, name)
    if engine_name == "persona":
        store = _personas()
        persona = store.get(vid)
        qwen = get_qwen3()
        if not qwen.is_installed():
            raise VoiceError("model_not_installed", f"Persona {persona.name!r} needs the Qwen3-TTS model.",
                             "Install it from VOICES → Models.", status=503, model_id=models.QWEN3.id)
        engine = PersonaTTS(qwen, persona.id, store.ref_audio(persona.id), persona.ref_text)
        return _Voice(f"persona:{persona.id}", engine, f"persona:{persona.id}", persona.name)
    raise VoiceError("voice_not_found", f"Voice {voice_id!r} isn't available.",
                     "Pick a voice from GET /api/voices.", status=404)


def _persona_voice(p: Persona, installed: bool) -> Voice:
    return Voice(id=f"persona:{p.id}", engine="persona", name=p.name, language="en", gender=p.gender,  # type: ignore[arg-type]
                 tags=["persona"] + ([t] if (t := f0_tag(p.f0_hz)) else []), recommended=False,
                 installed=installed, sample_audio_id=None,
                 description=p.description or None)


def list_voices() -> list[Voice]:
    eng = get_engine()
    voices = [
        Voice(id=f"kokoro:{v.id}", engine="kokoro", name=v.name, language=v.language, gender=v.gender,  # type: ignore[arg-type]
              tags=list(v.tags), recommended=v.recommended, installed=eng.is_installed(v.id),
              sample_audio_id=None, description=v.description)
        for v in eng.voices()
    ]
    personas = _personas().list()
    if personas:
        qwen_ok = get_qwen3().is_installed()
        voices += [_persona_voice(p, qwen_ok) for p in personas]
    return voices


# -- TTS ------------------------------------------------------------------------------------------
def _flags(chunk) -> SegmentFlags:
    return SegmentFlags(throw=chunk.throw, beat_break=chunk.beat_break, pause_after_s=float(chunk.pause_after_s),
                        pause_after_beats=float(chunk.pause_after_beats))


def _segments(vr: VoiceRender) -> list[Segment]:
    return [
        Segment(index=c.chunk.index, text=c.chunk.text, start_s=round(c.start_s, 6), end_s=round(c.end_s, 6),
                flags=_flags(c.chunk),
                words=[Word(text=w.text, start_s=round(w.start_s, 6), end_s=round(w.end_s, 6), throw=w.throw)
                       for w in c.words])
        for c in vr.chunks
    ]


def _default_name(text: str) -> str:
    text = " ".join(text.split())
    return text if len(text) <= _NAME_CHARS else text[: _NAME_CHARS - 1].rstrip() + "…"


def render(req: TTSRequest, lexicon: Lexicon | None = None) -> VoiceRender:
    """Like synthesize() but returns the internal render (word timings, throw spans, timings)."""
    v = _resolve(req.voice_id)
    script = parse(req.script)
    vr = render_script(script, v.engine_voice, v.engine, speed=req.speed, bpm=req.bpm,
                       lexicon=VoiceLexicon.from_contract(lexicon))
    vr.voice = v.voice_id
    return vr


def synthesize(req: TTSRequest, lexicon: Lexicon | None = None) -> Source:
    vr = render(req, lexicon)
    audio = vr.audio.reshape(1, -1).astype(np.float32, copy=False)
    info = SourceInfo(
        id="", kind="tts", name=req.name or _default_name(" ".join(c.chunk.clean_text for c in vr.chunks)),
        script=req.script, script_hash=script_hash(req.script), voice_id=vr.voice, speed=req.speed,
        sample_rate=ENGINE_SR, duration_s=round(audio.shape[-1] / ENGINE_SR, 6), segments=_segments(vr),
        peaks=peaks(audio, ENGINE_SR), audio_id="", created_at=_now(), bpm=vr.bpm, warnings=list(vr.script.warnings),
    )
    return Source(info=info, audio=audio)


def preview_script(script: str, lexicon: Lexicon | None = None, bpm: float | None = None) -> ScriptPreview:
    """Parse without synthesizing, for ScriptEditor highlighting: per segment the text as typed, what TTS will
    say, and the flags. Same shape as fixtures/markup_cases.json. `bpm` is accepted for the VoiceHooks
    signature; beat pauses stay in beats, so the parse doesn't depend on it."""
    lex = VoiceLexicon.from_contract(lexicon)
    parsed = parse(script)
    return ScriptPreview(
        segments=[ScriptPreviewSegment(text=c.text, say=speak_chunk(c, lex, sentence=False).say, flags=_flags(c))
                  for c in parsed.chunks],
        warnings=list(parsed.warnings),
    )


_samples: dict[str, Source] = {}
_samples_lock = threading.Lock()


def voice_sample(voice_id: str) -> Source:
    v = _resolve(voice_id)
    with _samples_lock:
        cached = _samples.get(v.voice_id)
    if cached is None:
        cached = synthesize(TTSRequest(script=SAMPLE_LINE, voice_id=v.voice_id, name=f"{v.name} sample"))
        with _samples_lock:
            _samples[v.voice_id] = cached
    # The server assigns ids on the object it gets, so never hand out the cached one.
    return Source(info=cached.info.model_copy(deep=True, update={"created_at": _now()}), audio=cached.audio.copy())


# -- models -------------------------------------------------------------------------------------
def list_models() -> list[ModelInfo]:
    return [models.model_info(spec) for spec in models.MODELS.values()]


def _model(model_id: str) -> models.ModelSpec:
    spec = models.MODELS.get(model_id)
    if spec is None:
        raise VoiceError("not_found", f"Unknown model {model_id!r}.", "GET /api/models lists them.", status=404)
    return spec


def install_model(model_id: str, progress: Callable[..., None]) -> None:
    """Blocking download (run it in a background job), or the update a manifest pinned. progress(fraction, message)
    also gets bytes_done, bytes_total and current_item as keywords when it takes **kwargs. It raises when the user
    cancels; that exception propagates after the download is stopped."""
    models.install(_model(model_id), progress)


def uninstall_model(model_id: str) -> None:
    """v0.6 (S3 P8): remove a model's files; list_models() then shows it not installed. Required models are
    model_required (409). A model working in memory (a persona design, a transcription) is model_busy (409);
    an idle one is unloaded first."""
    spec = _model(model_id)
    if spec.required:
        raise VoiceError("model_required", f"{spec.name} is required, so it can't be removed.", status=409)
    engine = {models.QWEN3.id: get_qwen3, models.ASR.id: get_transcriber}.get(model_id)
    if engine is not None and not engine().try_unload():
        raise VoiceError("model_busy", f"{spec.name} is in use.", "Try again when it has finished.", status=409)
    models.uninstall(spec)


def apply_model_manifest(manifest: ModelManifest) -> list[ModelInfo]:
    """v0.6 (S3 P9): take newer pins from a model manifest the server has verified, then list the models (versions,
    update_available). Only revisions of the same repos move; install_model() downloads them and re-checks file names
    and license with the Hub first."""
    models.apply_manifest(manifest)
    return list_models()


# -- personas -------------------------------------------------------------------------------------
def _candidate_source(audio24: np.ndarray, req: PersonaDesignRequest) -> Source:
    x = resample(audio24, QWEN3_SR, SR)
    bounds = speech_bounds(x, SR, rel_db=-50.0, pad_start_s=0.01, pad_end_s=0.08)
    if bounds:
        x = fade(x[bounds[0]:bounds[1]], SR, 0.002, 0.01)
    x, _ = normalize_speech(x, SR)
    audio = x.reshape(1, -1)
    dur = round(audio.shape[-1] / ENGINE_SR, 6)
    info = SourceInfo(
        id="", kind="tts", name=req.description, script=req.sample_text, script_hash=script_hash(req.sample_text),
        sample_rate=ENGINE_SR, duration_s=dur, segments=[Segment(index=0, text=req.sample_text, start_s=0.0, end_s=dur)],
        peaks=peaks(audio, ENGINE_SR), audio_id="", created_at=_now(),
    )
    return Source(info=info, audio=audio)


def design_persona(req: PersonaDesignRequest) -> Iterator[Source]:
    """req.candidates readings of req.sample_text in the described voice, yielded one by one as each finishes
    (about 3 s apart), so a server that consumes them lazily can show each at once and stop between them on cancel.
    Each candidate's info.name is the description (the server shows it) and info.script is the transcript that
    save_persona() needs."""
    for audio in get_qwen3().design_iter(req.description, req.sample_text, req.candidates):
        yield _candidate_source(audio, req)


def save_persona(name: str, candidate: Source) -> Voice:
    """Keep a candidate as a persona: it becomes the clone reference for every line in that voice."""
    audio = np.asarray(candidate.audio, dtype=np.float32)
    mono = audio.mean(axis=0) if audio.ndim == 2 else audio.reshape(-1)
    if mono.size == 0:
        raise VoiceError("invalid_request", "The persona candidate has no audio.")
    ref = resample(mono, int(candidate.info.sample_rate), QWEN3_SR)
    persona = _personas().save(name, candidate.info.name or "", ref, candidate.info.script or SAMPLE_LINE)
    return _persona_voice(persona, get_qwen3().is_installed())


# -- ingest -----------------------------------------------------------------------------------------
def ingest(data: bytes, filename: str | None = None, kind: SourceKind = "import", *, denoise: float | None = None,
           with_words: bool = False) -> Source:
    """`denoise`: DeepFilterNet3 strength 0-1; None uses DEFAULT_DENOISE for the kind. `with_words` also runs
    transcribe() inline (the server runs it in the background instead)."""
    strength = DEFAULT_DENOISE.get(kind, 0.0) if denoise is None else float(np.clip(denoise, 0.0, 1.0))
    r = ingest_audio(data, filename, denoise=strength)
    audio = r.audio.reshape(1, -1).astype(np.float32, copy=False)
    segments = [Segment(index=i, text=None, start_s=round(s / ENGINE_SR, 6), end_s=round(e / ENGINE_SR, 6))
                for i, (s, e) in enumerate(r.regions)]
    info = SourceInfo(
        id="", kind=kind, name=filename or ("Recording" if kind == "recording" else "Import"),
        sample_rate=ENGINE_SR, duration_s=round(audio.shape[-1] / ENGINE_SR, 6), segments=segments,
        peaks=peaks(audio, ENGINE_SR), audio_id="", created_at=_now(), warnings=list(r.warnings),
        denoise=r.denoise,  # v0.3: the strength actually applied (0.0 when off or kept as recorded)
    )
    src = Source(info=info, audio=audio)
    return transcribe(src) if with_words else src


# -- recordings: transcript and word timings ----------------------------------------------------------------
def _mono(source: Source) -> np.ndarray:
    a = np.asarray(source.audio, dtype=np.float32)
    return a.mean(axis=0) if a.ndim == 2 else a.reshape(-1)


def _attach(segments: list[Segment], words: list[AlignedWord], duration: float) -> list[Segment]:
    """Put each aligned word into the segment holding its midpoint (else the nearest), clamped to that segment."""
    segs = segments or [Segment(index=0, text=None, start_s=0.0, end_s=round(duration, 6))]
    buckets: list[list[AlignedWord]] = [[] for _ in segs]
    for w in words:
        mid = (w.start_s + w.end_s) / 2
        k = min(range(len(segs)), key=lambda i: 0.0 if segs[i].start_s <= mid <= segs[i].end_s
                else min(abs(mid - segs[i].start_s), abs(mid - segs[i].end_s)))
        buckets[k].append(w)
    out = []
    for seg, ws in zip(segs, buckets):
        placed = []
        for w in ws:
            a, b = max(seg.start_s, w.start_s), min(seg.end_s, w.end_s)
            if b - a >= 0.01:
                placed.append(Word(text=w.text, start_s=round(a, 6), end_s=round(b, 6)))
        if placed:  # as for TTS, the segment's last word keeps its release (S2's throws and VOICE OUT use it)
            placed[-1] = placed[-1].model_copy(update={"end_s": round(seg.end_s, 6)})
        out.append(seg.model_copy(update={"words": placed, "text": " ".join(w.text for w in placed) or seg.text}))
    return out


def transcribe(source: Source) -> Source:
    """A recording or import with its transcript (info.script) and word timings (Segment.words), on the segments
    ingest found. TTS sources come back unchanged. Raises model_not_installed without the whisper-aligner model."""
    if source.info.kind == "tts":
        return source
    text, words = get_transcriber().transcribe(_mono(source))
    info = source.info.model_copy(update={
        "script": text or None, "script_hash": script_hash(text) if text else None,
        "segments": _attach(list(source.info.segments), words, source.info.duration_s),
        "transcript_state": "done",  # v0.3; the server sets queued/running/error around this call
    })
    return Source(info=info, audio=source.audio)


def realign(source: Source, script: str) -> Source:
    """Apply the user's edited transcript (markup allowed) to a recording: one segment per chunk with its flags,
    and words aligned to the audio with their *throw* marks, exactly like a TTS source. The audio is unchanged, so
    pauses in the markup become flags for ARRANGE rather than silence."""
    if source.info.kind == "tts":
        raise VoiceError("invalid_request", "A TTS line is edited by synthesizing it again.",
                         "Change the script and render again.")
    parsed = parse(script)
    if not parsed.chunks:
        raise VoiceError("script_empty", "The transcript has no words.", "Type what the recording says.")
    parts: list[str] = []
    owner: list[int] = []  # chunk index per word
    throws: list[bool] = []
    breaks: set[int] = set()
    for ci, chunk in enumerate(parsed.chunks):
        clean = chunk.clean_text
        spans, pos = [], 0
        for piece in chunk.pieces:
            spans.append((pos, pos + len(piece.text), piece.throw))
            pos += len(piece.text)
        for _word, off, _p in asr_tokens(clean):
            owner.append(ci)
            throws.append(any(a <= off < b and t for a, b, t in spans))
        if owner and owner[-1] == ci:
            breaks.add(len(owner) - 1)
        parts.append(clean)
    words = get_transcriber().align(_mono(source), " ".join(parts), breaks=breaks)
    if len(words) != len(owner):
        raise VoiceError("align_failed", "The transcript and the audio couldn't be matched word for word.",
                         "Check the transcript for words that aren't in the recording.", status=422)
    dur = source.info.duration_s
    segments: list[Segment] = []
    for ci, chunk in enumerate(parsed.chunks):
        idx = [i for i, c in enumerate(owner) if c == ci]
        start = max(0.0, words[idx[0]].start_s - 0.01)
        end = min(dur, words[idx[-1]].end_s + 0.06)
        if segments and segments[-1].end_s > start:  # neighbours meet in the middle of their overlap
            mid = round((segments[-1].end_s + start) / 2, 6)
            prev = segments[-1]
            last = prev.words[-1].model_copy(update={"end_s": mid}) if prev.words else None
            segments[-1] = prev.model_copy(update={"end_s": mid, "words": prev.words[:-1] + [last] if last else []})
            start = mid
        segments.append(Segment(
            index=ci, text=chunk.text, start_s=round(start, 6), end_s=round(max(end, start + 0.02), 6),
            flags=_flags(chunk),
            words=[Word(text=words[i].text, start_s=round(max(start, words[i].start_s), 6),
                        end_s=round(end if i == idx[-1] else min(end, words[i].end_s), 6), throw=throws[i])
                   for i in idx],  # the last word keeps the chunk's release, as for TTS
        ))
    info = source.info.model_copy(update={"script": script, "script_hash": script_hash(script), "segments": segments,
                                          "warnings": list(parsed.warnings), "transcript_state": "done"})
    return Source(info=info, audio=source.audio)
