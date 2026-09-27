"""ARRANGE: bar-exact placement of the voice on the grid (1 bar = 240 / BPM s, 4/4).

- ``plan_placement`` (before the time-based FX) cuts the processed voice into chunks at segment boundaries,
  fits them into N bars (pad, or Rubber Band R3 stretch of at most ``max_stretch``), applies Beat-Lock
  (a chunk after a ``|`` starts on the next beat), [Nb] pauses at the render tempo, pre-roll
  (``first_word_beat``) and stutter. The first word's onset lands exactly on the pre-roll point.
- v0.8 CHOP (``Arrange.chop`` not 'off'): the line is cut at word boundaries (or '|' chunks) and each piece's onset
  lands exactly on its slot: every beat / 2 beats / bar from the first downbeat, or custom beats. A piece is only
  squeezed (R3, within ``max_stretch``) when its speech would run into the next slot; past that, the next slot slides
  to the next free grid step. Speech is never cut; a word keeps its natural release where there is room.
- ``apply_placement`` renders any buffer (wet or dry) with the same plan, so A/B stays sample-aligned.
- ``tape_stop`` and ``finish`` run after STEREO.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Sequence

import numpy as np
import pedalboard

from fvwks_contracts.audio import resolve_auto_bars

from .dsp import add_at, as2d, envelope, fade_edges, fit_length, to_mono
from .music import bar_seconds, beat_seconds, note_seconds

STANDARD_BARS = (1, 2, 4, 8, 16)
MAX_STRETCH = 0.08
PRE_PAD_S = 0.010
POST_PAD_S = 0.060
THROW_LEAD_S = 0.030  # thrown words open this early: TTS word starts can lag the audible onset
SNAP_NEAR_S = 0.025  # snap_end: when no exact grid landing is in reach, a closest approach this near counts
TAIL_FLEX = 0.8  # snap_end: the reserved tail may shrink to this share to land on the grid within the bars
CHOP_STEP_BEATS = {"beat": 1.0, "2beats": 2.0, "bar": 4.0}
CHOP_FADE_S = 0.005  # chop: fades at every piece edge (cuts fall mid-speech)
CHOP_RELEASE_S = 0.15  # chop: a word's natural release kept after its end, as far as the next piece allows


# --------------------------------------------------------------------------- inputs


@dataclass
class SegIn:
    """Duck-typed view of a source segment (contract ``Segment`` or a dict)."""

    index: int
    text: str
    start_s: float
    end_s: float
    throw: bool = False
    beat_break: bool = False  # chunk ended with "|": next chunk starts on the next beat (Beat-Lock)
    pause_after_s: float = 0.0  # [0.5] markup (already present as silence in the source audio)
    pause_after_beats: float = 0.0  # [2b] markup (re-sized at the render tempo)
    words: tuple["WordIn", ...] = ()  # v0.1 word timings (absolute source time), TTS only
    raw: Any = None

    def throw_spans_src(self) -> list[tuple[float, float]]:
        """Source-time spans that feed the throw send: exactly the ``throw`` words when word timings exist,
        else the whole segment when it is flagged (v0.1 ruling). Word starts from the TTS duration predictor can
        lag the audible onset by up to ~40 ms (measured, S1 review), so a thrown word's span opens
        ``THROW_LEAD_S`` early (never before its segment) to keep the attack in the send. A flagged segment whose
        words carry no ``throw`` flag (inconsistent input) throws whole rather than not at all."""
        if self.words and any(w.throw for w in self.words):
            return [(max(self.start_s, w.start_s - THROW_LEAD_S), w.end_s)
                    for w in self.words if w.throw and w.end_s > w.start_s]
        return [(self.start_s, self.end_s)] if self.throw else []


@dataclass(frozen=True)
class WordIn:
    text: str
    start_s: float
    end_s: float
    throw: bool = False


def _getter(obj: Any):
    return (lambda k, d=None: obj.get(k, d)) if isinstance(obj, dict) else (lambda k, d=None: getattr(obj, k, d))


def seg_from(obj: Any, i: int = 0) -> SegIn:
    g = _getter(obj)
    fl = g("flags", None)
    if fl is None:
        fl = {}
    fg = _getter(fl)
    idx = g("index", i)
    words = []
    for w in g("words", None) or []:
        wg = _getter(w)
        words.append(WordIn(str(wg("text", "") or ""), float(wg("start_s", 0.0)), float(wg("end_s", 0.0)),
                            bool(wg("throw", False))))
    return SegIn(
        index=int(i if idx is None else idx), text=str(g("text", "") or ""), start_s=float(g("start_s", 0.0)),
        end_s=float(g("end_s", 0.0)), throw=bool(fg("throw", False)), beat_break=bool(fg("beat_break", False)),
        pause_after_s=float(fg("pause_after_s", 0.0) or 0.0), pause_after_beats=float(fg("pause_after_beats", 0.0) or 0.0),
        words=tuple(words), raw=obj,
    )


# --------------------------------------------------------------------------- outputs


@dataclass
class Placed:
    index: int
    text: str
    start_s: float  # output timeline
    end_s: float
    throw: bool = False
    raw: Any = None
    words: list[WordIn] = field(default_factory=list)  # on the output timeline
    throw_spans: list[tuple[float, float]] = field(default_factory=list)  # output-timeline seconds


@dataclass
class Fit:
    status: str  # fits | stretched | extended | free ('overflow' is legacy: v0.4 never cuts speech)
    bars: float
    bpm: float
    speech_s: float  # natural arranged speech length (incl. stutter / tape-stop growth, beat-lock gaps)
    available_s: float
    total_s: float
    stretch_ratio: float  # output/input duration of the speech (0.95 = sped up 5 %)
    suggested_bars: int | None
    message: str
    reserved_tail_s: float = 0.0  # v0.4 auto_tail: room kept after the last word for its release + FX tail


@dataclass
class _Chunk:
    src0: int  # source samples (plan rate)
    src1: int
    speech_end: int  # source sample where this chunk's speech ends (before the post pad)
    seg_idx: list[int]
    lock: bool  # starts on the next beat
    pause_beats: float  # extra beats before this chunk
    pause_s: float  # extra seconds before this chunk (only when it is its own chunk)
    gap_s: float  # natural source gap before this chunk


@dataclass
class PlacementPlan:
    sr: int
    chunks: list[_Chunk]
    starts_s: list[float]
    factor: float  # speed factor (>1 = faster)
    first_word_s: float
    stutter: tuple[float, float, int] | None  # (at_s, slice_s, repeats)
    n_samples: int  # timeline length at ``sr``
    length_s: float  # musical length (bars) in seconds
    speech_end_s: float
    placed: list[Placed]
    fit: Fit
    notes: list[str] = field(default_factory=list)
    word_stutter: tuple[float, int, float] | None = None  # (slice_s, lead-in repeats, share of words)
    factors: list[float] | None = None  # v0.8 chop: speed factor per chunk (else ``factor`` for all)
    chop: list[tuple[int, float]] | None = None  # v0.8 chop: (piece index, landed beat) per piece

    def chunk_factor(self, i: int) -> float:
        return self.factors[i] if self.factors else self.factor


# --------------------------------------------------------------------------- helpers


def onset_sample(x: np.ndarray, sr: int, rel_db: float = -32.0, abs_db: float = -55.0) -> int:
    """First sample where the voice envelope crosses a threshold (1 ms early, so the attack survives)."""
    m = to_mono(x)[0]
    if m.size == 0:
        return 0
    env = envelope(m, sr, 0.0005, 0.005)
    thr = max(float(env.max()) * 10 ** (rel_db / 20.0), 10 ** (abs_db / 20.0))
    idx = np.flatnonzero(env >= thr)
    return max(0, int(idx[0]) - int(0.001 * sr)) if idx.size else 0


def offset_sample(x: np.ndarray, sr: int, rel_db: float = -45.0) -> int:
    m = to_mono(x)[0]
    if m.size == 0:
        return 0
    env = envelope(m, sr, 0.001, 0.02)
    thr = float(env.max()) * 10 ** (rel_db / 20.0)
    idx = np.flatnonzero(env >= thr)
    return int(idx[-1]) + 1 if idx.size else m.size


def next_beat(t: float, beat: float, origin: float = 0.0, tol: float = 1e-6) -> float:
    return origin + max(math.ceil((t - origin) / beat - tol), 0) * beat


def stretch(x: np.ndarray, sr: int, factor: float, high_quality: bool = True) -> np.ndarray:
    """Rubber Band R3 time-stretch (``factor`` > 1 = faster/shorter), exact output length."""
    a = as2d(x)
    if abs(factor - 1.0) < 1e-4 or a.shape[1] < 512:
        return a
    y = pedalboard.time_stretch(a, float(sr), stretch_factor=float(factor), high_quality=high_quality)
    return fit_length(y, int(round(a.shape[1] / factor)))


# --------------------------------------------------------------------------- planning


def _chunks(segs: list[SegIn], x: np.ndarray, sr: int, beat_lock: bool) -> list[_Chunk]:
    n = x.shape[1]
    if not segs:
        s0 = onset_sample(x, sr)
        e = max(s0 + 1, offset_sample(x, sr))
        return [_Chunk(s0, min(n, e + int(POST_PAD_S * sr)), e, [], False, 0.0, 0.0, 0.0)]
    chunks: list[_Chunk] = []
    for i, s in enumerate(segs):
        gap_before = s.start_s - segs[i - 1].end_s if i > 0 else PRE_PAD_S
        gap_after = segs[i + 1].start_s - s.end_s if i + 1 < len(segs) else POST_PAD_S
        pre = min(PRE_PAD_S, max(gap_before, 0.0) / 2)
        post = min(POST_PAD_S, max(gap_after, 0.0) / 2) if i + 1 < len(segs) else POST_PAD_S
        a = int(max(0.0, s.start_s - pre) * sr)
        b = int(min(n / sr, s.end_s + post) * sr)
        e = int(min(n / sr, s.end_s) * sr)
        prev = segs[i - 1] if i > 0 else None
        lock = bool(beat_lock and prev is not None and prev.beat_break)
        pause_beats = prev.pause_after_beats if prev is not None else 0.0
        new = i == 0 or lock or pause_beats > 0
        if new:
            # a chunk after a beat pause replaces the source gap (sized at the TTS tempo) with the render tempo
            chunks.append(_Chunk(a, b, e, [i], lock, pause_beats,
                                 prev.pause_after_s if (prev is not None and (lock or pause_beats > 0)) else 0.0,
                                 max(0.0, gap_before) if i > 0 else 0.0))
        else:
            c = chunks[-1]
            c.seg_idx.append(i)
            c.src1 = max(c.src1, b)
            c.speech_end = max(c.speech_end, e)
    # Every chunk starts at its first sound, not at its segment's lead-in (pre-pad, TTS pad, soft-consonant rise),
    # so the grid point it is laid out on is its onset: the first word on the pre-roll point, a Beat-Locked chunk
    # on its beat, a chunk after [Nb] exactly N beats after the previous speech.
    for c in chunks:
        if c.speech_end - c.src0 > 1:
            on = onset_sample(x[:, c.src0 : c.speech_end], sr)
            c.src0 = min(c.src0 + on, c.speech_end - 1)
    return chunks


def _layout(chunks: list[_Chunk], sr: int, bpm: float, factor: float, first_s: float,
            stutter_extra_s: float) -> tuple[list[float], float]:
    """Timeline start of each chunk and the end of the last one's speech."""
    beat = beat_seconds(bpm)
    starts: list[float] = []
    speech_end = first_s
    for i, c in enumerate(chunks):
        if i == 0:
            start = first_s + stutter_extra_s
        else:
            earliest = speech_end + c.pause_s
            if c.lock:
                start = next_beat(earliest, beat, first_s) + c.pause_beats * beat
            elif c.pause_beats > 0:
                start = earliest + c.pause_beats * beat
            else:
                start = earliest + c.gap_s / factor
            # the chunk's own pre-pad must not start before the previous speech ended
        starts.append(start)
        speech_end = start + (c.speech_end - c.src0) / sr / factor
    return starts, speech_end


def auto_bars(natural_s: float, shortest_s: float, bpm: float, first_word_beat: float, tail_beats: float,
              max_stretch: float, tail_room_s: float = 0.0) -> int:
    """v0.2 AUTO bars: the contract's resolver (nearest standard count that fits) on the arranged natural length,
    then the first count from its pick upward whose layout really fits. ``shortest_s`` is the layout at the
    largest allowed speed-up; Beat-Lock layouts shrink in whole beats, not in proportion. ``tail_room_s`` (v0.4)
    is kept free after the last word for its release and the FX tail."""
    pick = resolve_auto_bars(natural_s, bpm, first_word_beat, tail_beats, max_stretch, tail_s=tail_room_s)
    reserved = (max(0.0, first_word_beat) + max(0.0, tail_beats)) * beat_seconds(bpm) + max(0.0, tail_room_s)
    for b in (o for o in STANDARD_BARS if o >= pick):
        if shortest_s <= b * bar_seconds(bpm) - reserved + 1e-6:
            return b
    return pick


def plan_placement(
    x: np.ndarray,
    sr: int,
    segments: Sequence[Any] | None,
    *,
    bpm: float,
    bars: float | str | None,
    fit_mode: str = "auto",
    max_stretch: float = MAX_STRETCH,
    beat_lock: bool = False,
    first_word_beat: float = 0.0,
    tail_beats: float = 0.0,
    stutter_div: str | None = None,
    stutter_repeats: int = 0,
    tape_stop_beats: float = 0.0,
    tail_room_s: float = 0.0,
    snap_end: str = "off",
    stutter_words: float = 0.0,
    chop: str = "off",
    chop_unit: str = "word",
    chop_slots: Sequence[Any] | None = None,
) -> PlacementPlan:
    a = as2d(x)
    segs = [seg_from(s, i) for i, s in enumerate(segments or [])]
    segs = sorted([s for s in segs if s.end_s > s.start_s], key=lambda s: s.start_s)
    if chop != "off" and segs:
        return _plan_chop(a, sr, segs, bpm=bpm, bars=bars, fit_mode=fit_mode, max_stretch=max_stretch,
                          tail_beats=tail_beats, tail_room_s=tail_room_s, chop=chop, unit=chop_unit,
                          slots=chop_slots, stutter_words=stutter_words)
    beat = beat_seconds(bpm)
    first_s = max(0.0, first_word_beat) * beat
    tail_s = max(0.0, tail_beats) * beat
    chunks = _chunks(segs, a, sr, beat_lock)
    stut_len = note_seconds(stutter_div, bpm) if stutter_div and stutter_div != "off" and stutter_repeats > 1 else 0.0
    stut_extra = stut_len * (stutter_repeats - 1) if stut_len else 0.0
    tape_extra = max(0.0, tape_stop_beats) * beat

    def needed(f: float) -> float:
        _, end = _layout(chunks, sr, bpm, f, first_s, stut_extra / f)
        return end - first_s + tape_extra / f

    natural = needed(1.0)
    room = max(0.0, tail_room_s)
    reserved = first_s + tail_s + room  # the speech must fit in the length minus this

    def fit_in(available: float) -> tuple[float, str] | None:
        """(speed factor, status) that fits the phrase in ``available`` seconds, or None."""
        if available <= 0:
            return None
        if fit_mode == "stretch" and natural > 0:
            f0 = float(np.clip(natural / available, 1.0 / (1.0 + max_stretch), 1.0 + max_stretch))
            for f in (f0, *np.linspace(f0, 1.0 + max_stretch, 17)):
                if needed(float(f)) <= available + 1e-6:
                    return float(f), "stretched" if abs(float(f) - 1.0) > 1e-4 else "fits"
            return None
        if natural <= available + 1e-6:
            return 1.0, "fits"
        if fit_mode != "pad":
            for f in np.linspace(1.0, 1.0 + max_stretch, 33)[1:]:
                if needed(float(f)) <= available + 1e-6:
                    return float(f), "stretched"
        return None

    # v0.4.1 snap_end: the last word's end (VOICE OUT, as _voice_out defines it) per segment, source time + chunk
    seg_chunk = {si: ci for ci, c in enumerate(chunks) for si in c.seg_idx}
    ends_src = [(seg_chunk[i], max(w.end_s for w in sg.words) if sg.words else sg.end_s)
                for i, sg in enumerate(segs) if i in seg_chunk]
    f_lo, f_hi = 1.0 / (1.0 + max_stretch), 1.0 + max_stretch

    def end_at(f: float) -> float:
        """The last word's end on the output timeline at speed ``f`` (never later as ``f`` grows)."""
        st_f, _ = _layout(chunks, sr, bpm, f, first_s, stut_extra / f)
        return max(st_f[ci] + max(0.0, e * sr - chunks[ci].src0) / sr / f for ci, e in ends_src)

    def solve(g: float) -> float | None:
        """Speed factor that ends the last word exactly at ``g`` (bisection; None inside a Beat-Lock jump)."""
        lo, hi = f_lo, f_hi
        if end_at(lo) < g - 1e-9 or end_at(hi) > g + 1e-9:
            return None
        for _ in range(48):
            mid = 0.5 * (lo + hi)
            lo, hi = (mid, hi) if end_at(mid) > g else (lo, mid)
        f = 0.5 * (lo + hi)
        return f if abs(end_at(f) - g) <= 2e-4 else None

    def fits(f: float, g: float, length: float | None) -> bool:
        """The whole speech fits, and the tail gets at least TAIL_FLEX of its room: its last echoes are near the
        -30 dB floor, so landing on the grid inside the requested bars beats doubling the length for them."""
        speech_end_f = _layout(chunks, sr, bpm, f, first_s, stut_extra / f)[1]
        return length is None or max(g + TAIL_FLEX * room, speech_end_f) + tape_extra / f + tail_s <= length + 1e-6

    def snap_to(length: float | None):
        """(factor, grid point, 'bar'|'beat', miss s): the last word ends on the grid point nearest its natural end
        that the stretch limit reaches and that leaves the tail (and the whole speech) inside ``length`` (None =
        any); 'bar' falls back to the nearest reachable beat. When Beat-Lock leaves no exact landing in reach,
        the closest approach within SNAP_NEAR_S counts (``miss`` is what is left). None if landings exist but
        none fits the length; "unreachable" if the stretch limit reaches no grid point."""
        e_nat, e_early, e_late = end_at(1.0), end_at(f_hi), end_at(f_lo)
        names = ("bar", "beat") if snap_end == "bar" else ("beat",)
        landed = False
        for name in names:
            grid = beat * (4 if name == "bar" else 1)
            ks = range(math.ceil(e_early / grid - 1e-9), math.floor(e_late / grid + 1e-9) + 1)
            for g in sorted((k * grid for k in ks if k * grid > first_s + 1e-6), key=lambda g: (abs(g - e_nat), -g)):
                f = solve(g)
                if f is None:
                    continue
                landed = True
                if fits(f, g, length):
                    return f, g, name, 0.0
        if landed:
            return None
        # Beat-Lock ends move in whole-beat jumps: settle for the closest approach to the grid, if it is close
        best = None
        for f in np.unique(np.concatenate([np.linspace(f_lo, f_hi, 161), [1.0]])):
            e = end_at(float(f))
            for name in names:
                grid = beat * (4 if name == "bar" else 1)
                g = round(e / grid) * grid
                miss = abs(e - g)
                if g > first_s and miss <= SNAP_NEAR_S and fits(float(f), e, length):
                    key = (names.index(name), miss, abs(float(f) - 1.0))
                    if best is None or key < best[0]:
                        best = (key, (float(f), g, name, round(e - g, 5)))
        return best[1] if best else "unreachable"

    snapping = snap_end in ("beat", "bar") and fit_mode == "auto" and max_stretch > 0 and bool(ends_src)
    snapped = None
    auto = bars == "auto"
    if auto:  # pad mode may not squeeze, so it only fits what fits unstretched
        ms = max_stretch if fit_mode != "pad" else 0.0
        bars = auto_bars(natural, needed(1.0 + ms), bpm, first_word_beat, tail_beats, ms, room)
    factor, status, suggestion = 1.0, "fits", None
    requested = None if bars is None else float(bars)
    bar = bar_seconds(bpm)
    if requested is None:
        got = snap_to(None) if snapping else None
        if isinstance(got, tuple):
            snapped, factor = got, got[0]
        total_beats = max(1, math.ceil((reserved + needed(factor)) / beat - 1e-9))
        length_s = total_beats * beat
        bars_eff = total_beats / 4.0
        status = "free"
    else:
        bars_eff = requested
        length_s = bars_eff * bar
        got = snap_to(length_s) if snapping else "unreachable"
        if isinstance(got, tuple):  # warped: the last word ends on the grid inside the requested bars
            snapped, factor = got, got[0]
            status = "stretched" if abs(factor - 1.0) > 1e-4 else "fits"
        elif got is None:  # on the grid only in a longer render: grow (v0.4: never cut)
            grown = next(((o, g) for o in STANDARD_BARS if o > requested
                          for g in [snap_to(o * bar)] if isinstance(g, tuple)), None)
            if grown is None:  # past the standard counts: whole bars
                g = snap_to(None)
                f = g[0] if isinstance(g, tuple) else 1.0
                need = max(end_at(f) + room, _layout(chunks, sr, bpm, f, first_s, stut_extra / f)[1]) + tape_extra / f
                grown = (max(requested, math.ceil((need + tail_s) / bar - 1e-9)), g if isinstance(g, tuple) else None)
            bars_eff, snapped = float(grown[0]), grown[1]
            factor, length_s = (snapped[0] if snapped else 1.0), bars_eff * bar
            status, suggestion = "extended", int(bars_eff)
        else:  # no grid point in reach (or snapping off): fit as is
            got = fit_in(length_s - reserved)
            if got is not None:
                factor, status = got
            else:  # v0.4: never cut speech -- grow to the next bar count that holds the phrase + tail (same fit rules)
                grown = next(((o, g[0]) for o in STANDARD_BARS if o > requested
                              for g in [fit_in(o * bar - reserved)] if g is not None), None)
                if grown is None:  # past the standard counts: whole bars, unstretched
                    grown = (max(requested, math.ceil((reserved + natural) / bar - 1e-9)), 1.0)
                bars_eff, factor = float(grown[0]), grown[1]
                length_s = bars_eff * bar
                status, suggestion = "extended", int(bars_eff)
    available = length_s - reserved
    starts, speech_end = _layout(chunks, sr, bpm, factor, first_s, stut_extra / factor)
    n_tl = int(math.ceil(length_s * sr)) + 16

    placed: list[Placed] = []
    for c, st in zip(chunks, starts):

        def to_tl(t_src: float, c=c, st=st) -> float:
            return st + max(0.0, (t_src * sr - c.src0) / sr / factor)

        for si in c.seg_idx:
            s = segs[si]
            words = [WordIn(w.text, to_tl(w.start_s), to_tl(w.end_s), w.throw) for w in s.words]
            spans = [(to_tl(a), to_tl(b)) for a, b in s.throw_spans_src()]
            placed.append(Placed(s.index, s.text, to_tl(s.start_s), to_tl(s.end_s), s.throw, s.raw, words, spans))
    if not segs:
        c = chunks[0]
        placed.append(Placed(0, "", starts[0], starts[0] + (c.speech_end - c.src0) / sr / factor))
    if placed:
        placed[0].start_s = first_s
    stutter = (first_s, stut_len, int(stutter_repeats)) if stut_len else None
    ratio = 1.0 / factor
    tail = f" + {room:.2f}s tail" if room > 0 else ""
    msgs = {
        "fits": f"Fits: speech {natural:.2f}s{tail} in {available + room:.2f}s ({bars_eff:g} bars @ {bpm:g})",
        "free": f"Free length: {bars_eff:g} bars @ {bpm:g}",
        "stretched": f"Stretched {ratio:.3f}x (R3) to fit {bars_eff:g} bars",
        "extended": f"Extended to {bars_eff:g} bars: speech {natural:.2f}s{tail} doesn't fit {requested or 0:g} bars @ {bpm:g}",
    }
    message = (f"AUTO → {bars_eff:g} bars · " if auto else "") + msgs[status]
    if snapped is not None:
        miss = f" ({abs(snapped[3]) * 1000:.0f} ms {'early' if snapped[3] < 0 else 'late'}: the nearest Beat-Lock allows)" \
            if snapped[3] else ""
        message += f" · last word on the {snapped[2]} at {snapped[1]:.2f}s{miss}"
    elif snapping:  # asked to snap, but no grid point is within the stretch limit (Beat-Lock fixes the last start)
        e = end_at(factor)
        name = "bar" if snap_end == "bar" else "beat"
        grid = beat * (4 if name == "bar" else 1)
        off = e - round(e / grid) * grid
        message += f" · last word {abs(off) * 1000:.0f} ms {'before' if off < 0 else 'after'} the {name} (out of stretch reach)"
    fit = Fit(status, bars_eff, float(bpm), natural, available, length_s, ratio, suggestion, message, room)
    notes = []
    if stutter:
        notes.append(f"stutter {stutter_div} x{stutter_repeats}")
    word_stut = (note_seconds("1/32", bpm), 2, min(1.0, stutter_words)) if stutter_words > 0 else None
    if word_stut:
        notes.append(f"stutter on {round(word_stut[2] * 100)}% of words")
    return PlacementPlan(sr, chunks, starts, factor, first_s, stutter, n_tl, length_s, speech_end, placed, fit, notes,
                         word_stut)


# --------------------------------------------------------------------------- chop (v0.8)


def _chop_spans(segs: list[SegIn], unit: str) -> list[tuple[float, float, list[int]]]:
    """(source start, source end, segment indices) per piece, in order: one per word (a segment without word
    timings counts as one piece), or one per '|' chunk."""
    spans: list[tuple[float, float, list[int]]] = []
    if unit == "chunk":
        cur: list[int] = []
        for i, sg in enumerate(segs):
            cur.append(i)
            if sg.beat_break or i == len(segs) - 1:
                spans.append((segs[cur[0]].start_s, segs[cur[-1]].end_s, cur))
                cur = []
        return spans
    for i, sg in enumerate(segs):
        words = [w for w in sg.words if w.end_s > w.start_s]
        spans += [(w.start_s, w.end_s, [i]) for w in words] if words else [(sg.start_s, sg.end_s, [i])]
    return spans


def _plan_chop(x: np.ndarray, sr: int, segs: list[SegIn], *, bpm: float, bars: float | str | None, fit_mode: str,
               max_stretch: float, tail_beats: float, tail_room_s: float, chop: str, unit: str,
               slots: Sequence[Any] | None, stutter_words: float) -> PlacementPlan:
    n = x.shape[1]
    beat, bar = beat_seconds(bpm), bar_seconds(bpm)
    spans = _chop_spans(segs, unit)
    pieces: list[_Chunk] = []
    for k, (t0, t1, seg_idx) in enumerate(spans):
        prev_end = spans[k - 1][1] if k else 0.0
        nxt = spans[k + 1][0] if k + 1 < len(spans) else n / sr
        lo = int(max(prev_end, t0 - THROW_LEAD_S, 0.0) * sr)  # TTS word starts can lag the audible onset
        e = max(lo + 1, int(min(n / sr, t1) * sr))
        src0 = min(lo + onset_sample(x[:, lo:e], sr), e - 1)
        src1 = max(e, int(min(n / sr, max(t1, min(nxt, t1 + CHOP_RELEASE_S))) * sr))
        pieces.append(_Chunk(src0, src1, e, seg_idx, True, 0.0, 0.0, 0.0))
    speech = [(c.speech_end - c.src0) / sr for c in pieces]
    step = CHOP_STEP_BEATS.get(chop)
    custom = {}
    for sl in slots or []:
        g = _getter(sl)
        custom[int(g("index", 0))] = max(0.0, float(g("beat", 0.0)))
    grid = (step or 1.0) * beat  # where a slid slot may land
    f_max = 1.0 if fit_mode == "pad" else 1.0 + max(0.0, max_stretch)
    starts: list[float] = []
    factors: list[float] = []
    slid = 0
    for k, c in enumerate(pieces):
        if step is not None:
            t = starts[-1] + step * beat if starts else 0.0
        elif k in custom:
            t = custom[k] * beat
        else:  # custom without a slot for this piece: it follows the previous one at the natural spacing
            t = starts[-1] + (c.src0 - pieces[k - 1].src0) / sr / factors[-1] if starts else 0.0
        if starts:  # the previous piece's speech must end by t: squeeze it, else slide t to the next grid step
            gap = t - starts[-1]
            if gap <= 0 or speech[k - 1] / gap > f_max + 1e-9:
                t = math.ceil((starts[-1] + speech[k - 1] / f_max) / grid - 1e-9) * grid
                slid += 1
            factors[-1] = max(1.0, speech[k - 1] / (t - starts[-1]))
        starts.append(t)
        factors.append(1.0)
    speech_end = max(st + sp / f for st, sp, f in zip(starts, speech, factors))
    need = speech_end + max(0.0, tail_room_s) + max(0.0, tail_beats) * beat
    squeezed = max(factors) > 1.0 + 1e-4
    status, suggestion = ("stretched" if squeezed else "fits"), None
    if bars is None:
        length_s = max(1, math.ceil(need / beat - 1e-9)) * beat
        status = "free"
    else:
        whole = max(1, math.ceil(need / bar - 1e-9))
        if bars == "auto":
            bars_eff = float(next((b for b in STANDARD_BARS if b >= whole), whole))
        elif whole > float(bars):  # never cut: grow to the next count that holds every piece
            bars_eff = float(next((b for b in STANDARD_BARS if b >= whole), whole))
            status, suggestion = "extended", int(bars_eff)
        else:
            bars_eff = float(bars)
        length_s = bars_eff * bar
    bars_eff = length_s / bar

    def piece_of(t_src: float, end: bool = False) -> int:
        at = t_src * sr
        return max((i for i, c in enumerate(pieces) if (c.src0 < at if end else c.src0 <= at + 1e-6)), default=0)

    def to_tl(t_src: float, end: bool = False, k: int | None = None) -> float:
        """Source seconds to the output timeline, through the piece that holds them (or piece ``k``)."""
        k = piece_of(t_src, end) if k is None else k
        c = pieces[k]
        at = t_src * sr
        return starts[k] + min(max(0.0, (at - c.src0) / sr / factors[k]), (c.src1 - c.src0) / sr / factors[k])

    placed = []
    for i, sg in enumerate(segs):
        words = [WordIn(w.text, to_tl(w.start_s), to_tl(w.end_s, True), w.throw) for w in sg.words]
        # a throw span opens a little before its word (THROW_LEAD_S): keep it in that word's piece
        spans_tl = [(to_tl(p, k=piece_of(q, True)), to_tl(q, True)) for p, q in sg.throw_spans_src()]
        start = min([w.start_s for w in words], default=to_tl(sg.start_s))
        placed.append(Placed(sg.index, sg.text, start, max([w.end_s for w in words], default=to_tl(sg.end_s, True)),
                             sg.throw, sg.raw, words, spans_tl))
    natural = sum(speech)
    word = "chunk" if unit == "chunk" else "word"
    msg = {"fits": f"Chopped: {len(pieces)} {word}s on the grid, {bars_eff:g} bars @ {bpm:g}",
           "stretched": f"Chopped: {len(pieces)} {word}s on the grid, {sum(f > 1.0 + 1e-4 for f in factors)} squeezed "
                        f"(max {max(factors):.3f}x), {bars_eff:g} bars @ {bpm:g}",
           "free": f"Chopped: {len(pieces)} {word}s on the grid, free length {bars_eff:g} bars @ {bpm:g}",
           "extended": f"Chopped: extended to {bars_eff:g} bars to hold every {word} @ {bpm:g}"}[status]
    if slid:
        msg += f" · {slid} slot{'s' if slid > 1 else ''} moved later (too long to squeeze)"
    fit = Fit(status, bars_eff, float(bpm), natural, length_s, length_s, 1.0 / max(factors), suggestion, msg,
              max(0.0, tail_room_s))
    notes = [f"chop {chop} per {word}"]
    word_stut = (note_seconds("1/32", bpm), 2, min(1.0, stutter_words)) if stutter_words > 0 else None
    return PlacementPlan(sr, pieces, starts, max(factors), starts[0], None, int(math.ceil(length_s * sr)) + 16,
                         length_s, speech_end, placed, fit, notes, word_stut, factors,
                         [(k, round(t / beat, 6)) for k, t in enumerate(starts)])


# --------------------------------------------------------------------------- rendering a plan


def apply_placement(plan: PlacementPlan, x: np.ndarray, high_quality: bool = True) -> np.ndarray:
    """Render ``x`` (source timeline at ``plan.sr``) onto the plan's grid. ``[ch, n_samples]``."""
    a = as2d(x)
    sr = plan.sr
    out = np.zeros((a.shape[0], plan.n_samples), np.float32)
    fade = int(0.004 * sr)
    for i, (c, st) in enumerate(zip(plan.chunks, plan.starts_s)):
        piece = a[:, c.src0 : c.src1]
        if piece.shape[1] == 0:
            continue
        f = plan.chunk_factor(i)
        if f != 1.0:
            piece = stretch(piece, sr, f, high_quality)
        at = int(round(st * sr))
        if plan.factors:  # chop: the release only as far as the next piece's slot, 5 ms fades at both cuts
            if i + 1 < len(plan.starts_s):
                piece = piece[:, : max(1, int(round(plan.starts_s[i + 1] * sr)) - at)]
            e = min(int(CHOP_FADE_S * sr), piece.shape[1] // 2)
            piece = fade_edges(piece, e, e)
        else:  # chunks start 1 ms before their onset (see _chunks): a longer fade-in would soften the attack
            piece = fade_edges(piece, min(int(0.001 * sr), piece.shape[1] // 4), fade)
        add_at(out, piece, at)
    if plan.stutter:
        at_s, slice_s, repeats = plan.stutter
        out = stutter(out, sr, at_s, slice_s, repeats)
    if plan.word_stutter:
        out = word_stutter(out, sr, [w for p in plan.placed for w in p.words], *plan.word_stutter)
    return out


def word_stutter(x: np.ndarray, sr: int, words: list, slice_s: float, repeats: int, share: float) -> np.ndarray:
    """A quick retrigger of a word's first ``slice_s`` just before it ("g-g-GITHUB"), on ``share`` of the words
    after the first. The word itself is untouched, so the line stays legible; the lead-ins only overlap the tail
    of the previous word, quieter than the word."""
    ln = int(round(slice_s * sr))
    if ln <= 0 or share <= 0:
        return x
    f = int(0.002 * sr)
    for i in range(1, len(words)):
        if int(i * share) == int((i - 1) * share):  # evenly spread: every 1/share-th word
            continue
        on = int(round(words[i].start_s * sr))
        prev = words[i - 1]
        floor_ = int(round((prev.start_s + 0.6 * (prev.end_s - prev.start_s)) * sr))  # keep the previous word's body
        sl = x[:, on : on + ln].copy()
        if sl.shape[1] < ln:
            continue
        sl = fade_edges(sl, f, f)
        for k in range(1, repeats + 1):
            at = on - k * ln
            if at < max(0, floor_):
                break
            add_at(x, sl * (0.75 - 0.15 * (k - 1)), at)
    return x


def stutter(x: np.ndarray, sr: int, at_s: float, slice_s: float, repeats: int) -> np.ndarray:
    """Repeat the first ``slice_s`` of the phrase ``repeats`` times ("W-W-W-WE ARE").

    The phrase is laid out ``(repeats - 1) * slice_s`` late; the slices fill the gap in front of it."""
    at = int(round(at_s * sr))
    ln = int(round(slice_s * sr))
    src = at + ln * (repeats - 1)
    sl = x[:, src : src + ln].copy()
    if sl.shape[1] < ln or ln <= 0:
        return x
    f = int(0.002 * sr)
    sl = fade_edges(sl, f, f)
    for r in range(repeats - 1):
        add_at(x, sl if r else fade_edges(x[:, src : src + ln], int(0.001 * sr), f), at + r * ln)
    return x


# --------------------------------------------------------------------------- finish


def tape_stop(x: np.ndarray, sr: int, end_s: float, beats: float, bpm: float, curve: float = 1.0) -> np.ndarray:
    """Tape stop ending the speech: the last ``beats`` before ``end_s`` slow to zero speed over twice their
    length (linear ramp for ``curve`` = 1); everything afterwards is silence (the tape stopped)."""
    a = as2d(x)
    if beats <= 0:
        return a
    n = a.shape[1]
    region = beats * beat_seconds(bpm)
    r0 = int(max(0.0, end_s - region) * sr)
    consumed = int(min(n, end_s * sr)) - r0
    if consumed < 64:
        return a
    out_len = int(consumed * (curve + 1.0))
    t = np.arange(out_len) / out_len
    pos = r0 + consumed * (1.0 - (1.0 - t) ** (curve + 1.0))
    i0 = np.clip(np.floor(pos).astype(np.int64), 0, n - 2)
    w = (pos - i0).astype(np.float32)
    slowed = a[:, i0] * (1.0 - w) + a[:, i0 + 1] * w
    slowed = fade_edges(slowed, 0, int(0.03 * sr))
    y = np.zeros_like(a)
    y[:, :r0] = a[:, :r0]
    end = min(n, r0 + out_len)
    y[:, r0:end] = slowed[:, : end - r0]
    return y


def rack_samples_for(n_out: int, sr_out: int, sr: int) -> int:
    """Rack-rate length that resamples to at least ``n_out`` output samples."""
    return int(math.ceil(n_out * sr / sr_out)) + 8
