"""Per-chunk synthesis into one 48 kHz mono buffer with segment timings.

Each chunk is one TTS call, trimmed to its speech (10 ms before the onset, 60 ms after the release), then
placed on the timeline:
- `[0.5]` / `[2b]` insert exactly that much silence after the chunk (beats use the bpm, default 120);
- `|` leaves a short natural gap (S2's Beat-Lock re-places the chunk on the grid anyway);
- a newline leaves a slightly longer gap.
The first word lands on sample 0. The whole buffer then gets one gain so the speech level is consistent
across voices; relative levels between chunks are kept.

Word timings from the TTS locate `*throw*` words inside their chunk (`ChunkRender.throw_spans`). The v0
contract only carries a per-segment `throw` flag; see contracts/proposals/S1.md.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field

import numpy as np

from .dsp import SR, fade, find_pauses, frame_db, normalize_speech, resample, speech_bounds
from .engine import PhraseAudio, TTSEngine, WordTiming
from .errors import VoiceError
from .lexicon import Lexicon
from .markup import DEFAULT_BPM, Chunk, Script, speak_chunk

BEAT_GAP_S = 0.25
LINE_GAP_S = 0.35
TRIM_REL_DB = -50.0
PAD_START_S = 0.01
PAD_END_S = 0.06
# The release: a chunk ends where its decay falls below RELEASE_REL_DB of the loudest frame (at most RELEASE_MAX_S
# past the speech), then fades out over RELEASE_FADE_S. The mask's compression and drive bring a quiet tail up, so
# a breathy "us." cut at -50 dB could be heard as the voice being cut off. The pre-release sweep (28 voices) set
# these: some voices breathe out for ~0.5 s at -52 dB (af_alloy, af_nova), and a noisy tail's peaks sit a few dB
# over its RMS; every voice ends in digital silence after that.
RELEASE_REL_DB = -70.0
RELEASE_MAX_S = 0.6
RELEASE_FADE_S = 0.03
_MIN_CLIP_S = 0.02
_SPAN_JOIN_S = 0.05
_ALNUM_RE = re.compile(r"[^\W_]")
# Word-edge snapping (see _snap_words)
SNAP_REL_DB = -40.0
SNAP_WINDOW_S = 0.10
SNAP_MIN_SILENCE_S = 0.03
_MIN_WORD_S = 0.02
_PAUSE_PUNCT = tuple(".,;:!?…—-")
_EDGE_PUNCT = ".,;:!?…—-\"'“”‘’()[]"


@dataclass(frozen=True)
class PlacedWord:
    text: str  # as spoken ("Fawkes" for FVWKS)
    start_s: float  # absolute time in the output buffer
    end_s: float
    throw: bool = False  # inside *...*


@dataclass
class ChunkRender:
    chunk: Chunk
    say: str
    start_s: float
    end_s: float
    words: list[PlacedWord] = field(default_factory=list)
    throw_spans: list[tuple[float, float]] = field(default_factory=list)  # absolute; empty if no throw


@dataclass
class VoiceRender:
    audio: np.ndarray  # mono float32 at SR
    sample_rate: int
    chunks: list[ChunkRender]
    script: Script
    voice: str
    speed: float
    bpm: float
    gain_db: float = 0.0
    timings_ms: dict[str, float] = field(default_factory=dict)

    @property
    def duration_s(self) -> float:
        return len(self.audio) / self.sample_rate


def gap_after(chunk: Chunk, bpm: float, last: bool) -> float:
    if chunk.pause_after_s > 0 or chunk.pause_after_beats > 0:
        return chunk.pause_seconds(bpm)
    if last:
        return 0.0
    if chunk.line_break and not chunk.beat_break:
        return LINE_GAP_S
    return BEAT_GAP_S


def _release_end(x: np.ndarray, end: int) -> int:
    """Where the release of the speech that ends near sample `end` has decayed below RELEASE_REL_DB (never before
    `end`, never more than RELEASE_MAX_S after it)."""
    db, starts, win = frame_db(x, SR)
    limit = min(len(x), end + int(RELEASE_MAX_S * SR))
    above = np.flatnonzero((db > db.max() + RELEASE_REL_DB) & (starts + win <= limit))
    return max(end, int(starts[above[-1]] + win)) if len(above) else end


def _clip(pa: PhraseAudio) -> tuple[np.ndarray, float]:
    """48 kHz clip trimmed to the speech (its start exact, its end after the release), and the phrase time (s) where
    the clip starts."""
    x = resample(pa.audio, pa.sample_rate, SR) if len(pa.audio) else np.zeros(0, np.float32)
    bounds = speech_bounds(x, SR, rel_db=TRIM_REL_DB, pad_start_s=PAD_START_S, pad_end_s=PAD_END_S)
    if bounds is None:
        return np.zeros(int(_MIN_CLIP_S * SR), np.float32), 0.0
    s0, s1 = bounds
    return fade(x[s0:_release_end(x, s1)], SR, 0.002, RELEASE_FADE_S), s0 / SR


def _snap_words(tokens: list[WordTiming], clip: np.ndarray) -> list[WordTiming]:
    """Kokoro's timings tile the chunk, so the lead-in and every pause get counted inside the neighbouring words.
    Where Kokoro itself marks a pause (the chunk's first word, a punctuation token or a word ending in one), move
    the word edges onto the audible edges found within +-100 ms. Other boundaries stay as Kokoro reports them:
    snapping there would catch stop closures inside words ("ex_pect"). The last word keeps the chunk's release.
    Returns clip-relative words only (punctuation tokens dropped)."""
    idx = [i for i, t in enumerate(tokens) if _ALNUM_RE.search(t.text)]
    if not idx:
        return []
    pauses, onset = find_pauses(clip, SR, SNAP_REL_DB, SNAP_MIN_SILENCE_S)
    edges = {i: [tokens[i].start_s, tokens[i].end_s] for i in idx}
    first = idx[0]
    if onset is not None and abs(onset - edges[first][0]) <= SNAP_WINDOW_S:
        edges[first][0] = min(onset, edges[first][1] - _MIN_WORD_S)
    for a, b in zip(idx, idx[1:]):
        if b - a < 2 and not tokens[a].text.endswith(_PAUSE_PUNCT):
            continue
        lo, hi = tokens[a].end_s - SNAP_WINDOW_S, tokens[b].start_s + SNAP_WINDOW_S
        found = [(t1 - t0, t0, t1) for t0, t1 in pauses if lo <= (t0 + t1) / 2 <= hi]
        if not found:
            continue
        _, t0, t1 = max(found)
        if t0 - edges[a][0] >= _MIN_WORD_S and edges[b][1] - t1 >= _MIN_WORD_S:
            edges[a][1], edges[b][0] = t0, t1
    edges[idx[-1]][1] = max(edges[idx[-1]][1], len(clip) / SR)  # the release belongs to the last word
    return [WordTiming(tokens[i].text, edges[i][0], edges[i][1], tokens[i].char_start, tokens[i].char_end) for i in idx]


def _throw_spans(chunk: Chunk, spans: tuple[tuple[int, int], ...], words: list[WordTiming],
                 clip_s: float, plain_len: int) -> list[tuple[float, float]]:
    """Clip-relative time ranges of the chunk's throw pieces, from word timings (char offsets), falling back
    to the piece's share of the characters when a word couldn't be matched."""
    out: list[tuple[float, float]] = []
    timed = [w for w in words if w.char_start >= 0]
    speech_start = min((w.start_s for w in words), default=0.0)
    speech_end = max((w.end_s for w in words), default=clip_s)
    for k, piece in enumerate(chunk.pieces):
        if not piece.throw:
            continue
        a, b = spans[k]
        hit = [w for w in timed if a <= w.char_start < b]
        if hit:
            t0, t1 = min(w.start_s for w in hit), max(w.end_s for w in hit)
        else:
            frac0, frac1 = a / max(1, plain_len), b / max(1, plain_len)
            t0 = speech_start + frac0 * (speech_end - speech_start)
            t1 = speech_start + frac1 * (speech_end - speech_start)
        if k == len(chunk.pieces) - 1:
            t1 = clip_s  # a closing throw keeps its release
        t0, t1 = max(0.0, min(t0, clip_s)), max(0.0, min(t1, clip_s))
        if out and t0 - out[-1][1] < _SPAN_JOIN_S:
            out[-1] = (out[-1][0], max(out[-1][1], t1))
        elif t1 > t0:
            out.append((t0, t1))
    return out


def _is_throw(chunk: Chunk, spans: tuple[tuple[int, int], ...], w: WordTiming,
              throw_spans: list[tuple[float, float]]) -> bool:
    """A word throws when it starts inside a *...* piece; unmatched words fall back to the time spans."""
    if not chunk.throw:
        return False
    if w.char_start >= 0:
        return any(p.throw and a <= w.char_start < b for p, (a, b) in zip(chunk.pieces, spans))
    mid = (w.start_s + w.end_s) / 2
    return any(a <= mid < b for a, b in throw_spans)


def render_script(script: Script, voice: str, engine: TTSEngine, *, speed: float = 0.9,
                  bpm: float | None = None, lexicon: Lexicon | None = None) -> VoiceRender:
    """Synthesize every chunk with `voice` and assemble the Source buffer."""
    if not script.chunks:
        raise VoiceError("script_empty", "The script has no words to speak.",
                         "Type a line, e.g. WE ARE GUY FVWKS | EXPECT *US*")
    lexicon = lexicon if lexicon is not None else Lexicon()
    bpm = float(bpm or DEFAULT_BPM)
    t_start = time.perf_counter()
    tts_ms = 0.0
    parts: list[np.ndarray] = []
    renders: list[ChunkRender] = []
    pos = 0  # samples
    last = len(script.chunks) - 1
    for i, chunk in enumerate(script.chunks):
        sp = speak_chunk(chunk, lexicon)
        t0 = time.perf_counter()
        pa = engine.synthesize(sp.g2p, voice, speed, plain=sp.plain)
        tts_ms += (time.perf_counter() - t0) * 1000
        clip, clip_at = _clip(pa)
        clip_s = len(clip) / SR
        tokens = [WordTiming(w.text, min(clip_s, max(0.0, w.start_s - clip_at)),
                             min(clip_s, max(0.0, w.end_s - clip_at)), w.char_start, w.char_end) for w in pa.words]
        words = _snap_words(tokens, clip)  # clip-relative, words only
        spans = _throw_spans(chunk, sp.spans, words, clip_s, len(sp.plain)) if chunk.throw else []
        start_s = pos / SR
        renders.append(ChunkRender(
            chunk=chunk, say=sp.say, start_s=start_s, end_s=(pos + len(clip)) / SR,
            words=[PlacedWord(w.text.strip(_EDGE_PUNCT) or w.text, start_s + w.start_s, start_s + w.end_s,
                              _is_throw(chunk, sp.spans, w, spans)) for w in words],
            throw_spans=[(start_s + a, start_s + b) for a, b in spans],
        ))
        parts.append(clip)
        pos += len(clip)
        gap = int(round(gap_after(chunk, bpm, i == last) * SR))
        if gap:
            parts.append(np.zeros(gap, np.float32))
            pos += gap
    t1 = time.perf_counter()
    audio, gain_db = normalize_speech(np.concatenate(parts), SR)
    timings = {"tts": round(tts_ms, 1), "assemble": round((time.perf_counter() - t1) * 1000, 1),
               "total": round((time.perf_counter() - t_start) * 1000, 1)}
    return VoiceRender(audio=audio, sample_rate=SR, chunks=renders, script=script, voice=voice, speed=speed,
                       bpm=bpm, gain_db=gain_db, timings_ms=timings)
