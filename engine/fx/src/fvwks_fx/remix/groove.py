"""1.6 REMIX: BASS DNA. How a track's bass moves (its groove), to re-play with another sound. DSP only.

extract_groove(bass, sr, analysis, start_bar=, bars=) reads the bass stem through bassline.BassFrames (the same
frames as StemFeatures.bass_b64) into a v0.11.1 BassGroove:
  notes      beat / beats from the groove's first bar line, fractional (the push and swing stay); midi (the settled
             median, fractional: the track's tuning; an unpitched note holds the pitch before it), vel, glide_to and
             bend (beats into the note, MIDI) when it slides; a legato re-articulation under 60 ms at the same pitch
             stays part of its note
  wobble     per growl-heavy bar: the LFO's division, depth, shape (square / saw / sine) and phase at the bar line
             (0 = its peak)
  curves     PER_BEAT a beat, 0-1 as uint8 base64: level (the bounce: sidechain pumps and stabs, a volume CC) and
             growl (the growl share, a filter / drive CC)
Everything is in beats, so a groove re-times by rendering at another bpm. render_groove re-plays it on a numpy
saw + sub (the proof; S1's Surge XT replaces the synth).
"""

from __future__ import annotations

import base64
import numpy as np
from scipy import signal

from fvwks_contracts.models import BassGroove, GrooveNote, GrooveWobble, SongAnalysis

from ..bassline import DIVISIONS, BassFrames, _mono
from ..dsp import EPS

FPS = 60.0
PER_BEAT = 24  # curve samples a beat (1/96 notes: 58 a second at 145 BPM)
SETTLE_S = 0.1  # a note's pitch is read after its attack (the 100 ms pitch window straddles the note start)
# ponytail: a calibrated constant, only for a legato start with no level rise and no pitch change (a re-articulation
# at the same pitch). Log spectral flux peaks as the new note enters the 107 ms window (19-31 ms early on the
# synthetic test). Re-measure if BassFrames' window changes.
FLUX_LAG_S = 0.025
MERGE_S = 0.06  # a legato note this short at the same pitch continues the one before (the level keeps its dip)


def curve(g: BassGroove, name: str) -> np.ndarray:
    """A groove's `level` or `growl` curve, 0-1, g.per_beat samples a beat."""
    return np.frombuffer(base64.b64decode(getattr(g, f"{name}_b64")), np.uint8) / 255.0


def _b64(x: np.ndarray) -> str:
    return base64.b64encode(np.clip(np.round(x * 255), 0, 255).astype(np.uint8).tobytes()).decode()


def extract_groove(bass: np.ndarray, sr: int, analysis: SongAnalysis, *, start_bar: int = 1, bars: int | None = None,
                   song_id: str = "", half_time: bool = False) -> BassGroove:
    """The groove of a bass stem ((channels, n) or (n,) at `sr`) over bars [start_bar, start_bar + bars) of the song's
    grid (all of it from start_bar when `bars` is None). `half_time` is carried from the section (SongSection)."""
    n = np.asarray(bass).shape[-1]
    frames = int(np.ceil(n / sr * FPS))
    bf = BassFrames(bass, sr, FPS, frames)
    beat = 60.0 / analysis.bpm
    t0 = analysis.downbeat_s + (start_bar - 1) * 4 * beat
    if bars is None:
        bars = max(1, int(np.ceil((n / sr - t0) / (4 * beat))))
    t1 = t0 + bars * 4 * beat
    share = np.where(bf.on, bf.growl / np.maximum(bf.sub + bf.growl, EPS), 0.0)

    # notes: each start to the next start or the note's end, in frames (the bend in absolute frames)
    raw: list[list] = []
    starts = np.nonzero(bf.note_on)[0]
    for i, s in enumerate(starts):
        nxt = starts[i + 1] if i + 1 < starts.size else frames
        off = np.nonzero(~bf.on[s:nxt])[0]
        e = s + (off[0] if off.size else nxt - s)
        m = bf.midi[s:e]
        settled = m[int(SETTLE_S * FPS):]
        voiced = settled[settled > 0] if (settled > 0).any() else m[m > 0]
        pitch = float(np.median(voiced)) if voiced.size else None
        bend = None
        if pitch is not None and (settled > 0).sum() >= 4 and np.ptp(settled[settled > 0]) >= 1.0:
            bend = [j for j in range(s + int(SETTLE_S * FPS), e, 2) if bf.midi[j] > 0]
        raw.append([s, e, pitch, bend])
    # a legato fragment under 60 ms at the same pitch belongs to the note after it (its attack) or before it
    same = lambda p, q: p is None or q is None or abs(p - q) < 0.5
    kept: list[list] = []
    for i, r in enumerate(raw):
        if r[1] - r[0] < MERGE_S * FPS:
            nx = raw[i + 1] if i + 1 < len(raw) else None
            if nx and nx[0] - r[1] <= 1 and same(r[2], nx[2]):
                nx[0] = r[0]
                continue
            if kept and r[0] - kept[-1][1] <= 1 and same(r[2], kept[-1][2]):
                kept[-1][1] = r[1]
                continue
        kept.append(r)
    # unpitched notes hold the pitch before them (the first ones, the first pitch)
    pitches = [r[2] for r in kept if r[2] is not None]
    last = pitches[0] if pitches else 33.0
    onset = _onset_refiner(bass, sr)
    times = [_legato(r[0], bf.midi) if (t := onset(r[0] / FPS)) is None else t for r in kept]
    notes: list[GrooveNote] = []
    for i, (s, e, pitch, bend) in enumerate(kept):
        last = pitch if pitch is not None else last
        t = times[i]
        # legato into the next note: it ends where that one (refined) starts
        end = times[i + 1] if i + 1 < len(kept) and kept[i + 1][0] <= e else e / FPS
        if not t0 - 1e-6 <= t < t1:
            continue
        b = [(round((j / FPS - t) / beat, 4), round(float(bf.midi[j]), 2)) for j in bend] if bend else None
        notes.append(GrooveNote(beat=max(0.0, round((t - t0) / beat, 4)), beats=max(1e-3, round((end - t) / beat, 4)),
                                midi=round(last, 2), vel=round(float(np.clip(bf.level[s:e].max(), 0, 1)), 3),
                                glide_to=b[-1][1] if b else None, bend=b))

    wobble: list[GrooveWobble] = []
    for k in range(bars):
        a0 = t0 + k * 4 * beat
        a, b = int(a0 * FPS), int((a0 + 4 * beat) * FPS)
        # the wobble over this bar and the next (an LFO needs a few cycles; 1/4T is only 6 in a bar)
        c = min(frames, b + (b - a))
        div, anchor = bf.wobble(a, c, beat)
        if div is None or anchor is None:
            continue
        g = bf.growl[a:b][bf.on[a:b]]
        hi, lo = (np.percentile(g, [95, 5]) if g.size else (0.0, 0.0))
        period = DIVISIONS[div] * beat
        wobble.append(GrooveWobble(bar=k, div=div, depth=round(float(np.clip((hi - lo) / max(hi, EPS), 0, 1)), 3),
                                   shape=_shape(bf, a, c, period), phase=round(float(((a0 - anchor) / period) % 1.0), 3) % 1.0))

    grid = t0 + np.arange(bars * 4 * PER_BEAT) * beat / PER_BEAT
    at = lambda x: np.interp(grid * FPS, np.arange(x.size), x, left=0.0, right=0.0)
    return BassGroove(song_id=song_id, start_bar=start_bar, bars=bars, bpm=analysis.bpm, half_time=half_time, notes=notes,
                      wobble=wobble, per_beat=PER_BEAT, level_b64=_b64(at(bf.level)), growl_b64=_b64(at(share)))


def _shape(bf: BassFrames, a: int, b: int, period: float) -> str:
    """The LFO's shape from its average cycle over frames [a, b): 12 phase bins of the growl, peak first. "square" when
    it sits at its extremes (5/6 of the cycle in the top or bottom quarter; a sine spends 2/3 there), "saw" when the
    fall from the peak takes 2/3 of the cycle or more (its lowest bin 8+; a sine's is 6-7), else "sine".
    ponytail: thresholds from synthetic 1/8 and 1/4T LFOs through the 107 ms growl window; a triangle reads as sine."""
    m = bf.on[a:b]
    if m.sum() < 24:
        return "sine"
    bins = np.floor((np.arange(a, b)[m] / FPS / period % 1.0) * 12).astype(int) % 12
    prof = np.bincount(bins, weights=bf.growl[a:b][m], minlength=12) / np.maximum(np.bincount(bins, minlength=12), 1)
    p = (prof - prof.min()) / max(float(prof.max() - prof.min()), EPS)
    p = np.roll(p, -int(np.argmax(p)))
    if np.mean((p > 0.75) | (p < 0.25)) >= 0.78:
        return "square"
    return "saw" if int(np.argmin(p)) >= 8 else "sine"


def _legato(s: int, midi: np.ndarray) -> float:
    """A legato note start with no level rise, found at frame `s` (a flux peak, early): where the pitch track crosses
    halfway from the old note to the new one (its window is centred, so the crossing sits on the change), else
    s + FLUX_LAG_S."""
    before, after = midi[max(0, s - 8) : max(0, s - 2)], midi[s + 6 : s + 13]
    before, after = before[before > 0], after[after > 0]
    if before.size >= 2 and after.size >= 2 and abs(np.median(after) - np.median(before)) >= 0.5:
        mid, up = 0.5 * (np.median(before) + np.median(after)), np.median(after) > np.median(before)
        for f in range(max(1, s - 3), min(midi.size, s + 8)):
            a, b = midi[f - 1], midi[f]
            if a > 0 and b > 0 and ((a < mid <= b) if up else (a > mid >= b)):
                return (f - 1 + (mid - a) / (b - a)) / FPS
    return s / FPS + FLUX_LAG_S


def _onset_refiner(bass: np.ndarray, sr: int):
    """Note starts to the millisecond: the 60 fps frames see a note up to ~30 ms early (their 107 ms window). Within
    -60..+40 ms of a frame's start, the steepest rise of a trailing 20 ms RMS (1 ms steps), when the level climbs 3 dB
    or more there; None for a legato change with no rise."""
    x = _mono(bass).astype(np.float64)
    hop = max(1, sr // 1000)
    c = np.concatenate([[0.0], np.cumsum((x[: x.size // hop * hop].reshape(-1, hop) ** 2).mean(axis=1))])
    w = 20
    rms = np.sqrt(np.maximum(c[w:] - c[:-w], 0) / w)  # rms[i]: the 20 ms up to (i + w) ms
    le = np.log(rms + 1e-4 * max(float(rms.max()), EPS))
    d = np.diff(le, prepend=le[:1])

    def refine(t: float) -> float:
        if t <= 0:
            return 0.0  # sounding from the first sample
        ms = sr / hop  # blocks a second (1000 at 48 kHz; 1002.3 at 44.1)
        a, b = max(1, int((t - 0.06) * ms) - w), min(d.size - w, int((t + 0.04) * ms) - w)
        if b <= a:
            return None
        j = a + int(np.argmax(d[a:b]))
        return (j + w) / ms if le[min(le.size - 1, j + w)] - le[max(0, j - 5)] >= 0.35 else None

    return refine


def render_groove(g: BassGroove, sr: int = 48000, bpm: float | None = None) -> np.ndarray:
    """The groove on a clean sine sub + a saw mid (mono float32) at `bpm` (default: its own; another tempo re-times
    it): notes gate it, the pitch follows each note's bend, the level curve is the volume (the bounce), the growl
    share opens the mid's low-pass and drives it (the sub is never driven)."""
    beat = 60.0 / (bpm or g.bpm)
    n = int(np.ceil(g.bars * 4 * beat * sr))
    tb = np.arange(n) / sr / beat  # beats
    ctl = lambda x: np.interp(tb, np.arange(x.size) / g.per_beat, x)  # PER_BEAT curves at the sample rate
    gate = np.zeros(n, np.float32)
    midi = np.full(n, g.notes[0].midi if g.notes else 33.0)
    for note in g.notes:
        a, b = int(note.beat * beat * sr), min(n, int((note.beat + note.beats) * beat * sr))
        gate[max(0, a - int(0.004 * sr)):a] = 0.0  # every note retriggers (a synth's envelope restarts)
        gate[a:b] = 1.0
        midi[a:] = note.midi  # held into the gap after it
        if note.bend:
            bt, bm = np.array(note.bend).T
            midi[a:b] = np.interp(tb[a:b] - note.beat, bt, bm, left=bm[0])
    f0 = 440.0 * 2 ** ((midi - 69) / 12)
    # the sub: a clean sine, never driven, folded by octaves into C1-B1 (32.7-65.4 Hz) (Sound Bible 1.1)
    fsub = f0 * 2.0 ** np.floor(np.log2(65.4 / np.maximum(f0, 1e-3)))
    sub = np.sin(2 * np.pi * np.cumsum(fsub / sr))
    saw = 2.0 * (np.cumsum(f0 / sr) % 1.0) - 1.0
    # the gate with a 3 ms attack and 20 ms release (one-pole, up fast, down slow)
    env = signal.lfilter([1 - np.exp(-1 / (0.02 * sr))], [1, -np.exp(-1 / (0.02 * sr))], gate)
    env = np.maximum(env, signal.lfilter([1 - np.exp(-1 / (0.003 * sr))], [1, -np.exp(-1 / (0.003 * sr))], gate))
    growl = ctl(curve(g, "growl"))
    # the mid: the saw through a low-pass that the growl share opens (a morph across three fixed filters: switching a
    # running filter's coefficients ticks), hi-passed at 120 Hz (the sub owns the low end), then driven
    stops = [signal.sosfilt(signal.butter(2, min(hz, 0.45 * sr), fs=sr, output="sos"), saw) for hz in (150.0, 700.0, 4000.0)]
    p = 2.0 * np.clip(growl, 0.0, 1.0)
    mid = (np.clip(1 - p, 0, 1) * stops[0] + np.clip(1 - np.abs(p - 1), 0, 1) * stops[1] + np.clip(p - 1, 0, 1) * stops[2])
    mid = signal.sosfilt(signal.butter(4, 120, "high", fs=sr, output="sos"), mid)
    drive = 1 + 4 * growl
    mid = np.tanh(drive * mid / max(float(np.abs(mid).max()), 1e-9)) / np.tanh(drive)
    y = 0.8 * sub + 0.5 * mid
    return (0.8 * env * ctl(curve(g, "level")) * y).astype(np.float32)
