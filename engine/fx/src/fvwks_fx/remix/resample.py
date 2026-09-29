"""1.6 REMIX: RESAMPLE, the way this scene makes drops: the track's own bass stem already holds pro-designed growls,
so they are cut into one-shots and re-sequenced, not re-synthesised from MIDI. DSP only.

slice_bass(bass, sr, analysis, start_bar, bars)   one-shots at the BASS DNA note starts, tagged by pitch, length,
                                                  brightness (spectral centroid) and level
drum_shots(drums, sr, analysis, start_bar, bars)  the song's own kick and snare (the loudest hits with nothing else on
                                                  them) and a hat
sequence(shots, style, bars, bpm, sr, root)       the one-shots on a genre grid, repitched to the key sampler-style:
                                                  riddim (a sparse call on 1, 1/8T wub repeats, a response with 1/4T
                                                  repeats every half bar, a rising stutter switch-up every 4th bar)
                                                  or halftime (bouncy hits with space); the one-shots rotate every 4
                                                  bars. Returns the growl bus and the (pitch, start, beats) hits.
sub_line(hits, ...)                               a clean mono sine under every hit, at the root's sub octave
print_shot(shot, sr)                              a one-shot printed before it's chopped: hi-pass 100 Hz, parallel
                                                  distortion
drop_chain(bus, sr)                               the growl bus's drop processing: hi-pass 100 Hz, 3-band upward /
                                                  downward compression (an OTT-style squash)
resample_bass / hybrid_growls / riddim_bass       one engine bass clip each (prepare dispatches them by patch_id);
eight08, source_kit                               the 808 hits, a kit clip on the song's own drums
"""

from __future__ import annotations

import threading
from contextlib import contextmanager
from dataclasses import dataclass

import numpy as np
from pedalboard import Compressor
from scipy import ndimage, signal

from fvwks_contracts.models import SongAnalysis

from ..dsp import EPS, as2d, fade_edges
from .flip import drum_hits
from .groove import extract_groove

MIN_SHOT_S = 0.08
# the drop's balance (peak-normalised parts): the growls lead, the sub under them, the drums punching through
GROWL, SUB, DRUMS, EXTRA = 1.25, 0.45, 0.9, 0.3
NOTES: list[dict] | None = None  # set to [] to trace every note the engine voices place (auditions, harmonic QA)
_TRACE = threading.local()  # the clip being prepared: its remix beat and id (prepare's trace())


@contextmanager
def trace(clip_id: str, at_beat: float):
    """Notes placed inside are traced at the clip's remix beats (when NOTES is a list)."""
    _TRACE.clip, _TRACE.at = clip_id, at_beat
    try:
        yield
    finally:
        _TRACE.clip, _TRACE.at = "", 0.0


def _note(beat: float, beats: float, midi: float, degree: str, lane: str) -> None:
    if NOTES is not None:
        NOTES.append({"beat": round(getattr(_TRACE, "at", 0.0) + beat, 4), "beats": round(float(beats), 4),
                      "midi": round(float(midi), 2), "degree": degree, "lane": lane, "clip": getattr(_TRACE, "clip", "")})


MID_HP = 150.0  # a designed mid's high-pass (Sound Bible 1.1: 100-150): its lows off the sub bus (sub purity)
RIDDIM_MID_DB = -1.0  # riddim's mid bus re its sub, RMS over the clip (Sound Bible 5: -4..+2)


@dataclass
class OneShot:
    audio: np.ndarray  # (2, n) float32
    midi: float | None
    seconds: float
    bright: float  # spectral centroid, Hz
    level: float  # RMS


def _stereo(x: np.ndarray) -> np.ndarray:
    x = as2d(np.asarray(x, np.float32))
    return x if x.shape[0] == 2 else np.repeat(x[:1], 2, axis=0)


def _fade(x: np.ndarray, sr: int, fin: float = 0.004, fout: float = 0.008) -> np.ndarray:
    """Raised-cosine edges on a slice (a hard edge on a loud low note is a broadband click, which the drop chain's
    distortion would only sharpen)."""
    return fade_edges(x, int(fin * sr), int(fout * sr)).astype(np.float32)


def _zc(m: np.ndarray, i: int, reach: int) -> int:
    """The zero crossing of `m` nearest sample `i` (within `reach` samples), else `i`."""
    a, b = max(1, i - reach), min(m.size - 1, i + reach)
    z = np.nonzero(np.signbit(m[a - 1 : b - 1]) != np.signbit(m[a:b]))[0]
    return int(a + z[np.argmin(np.abs(a + z - i))]) if z.size else i


def _slice(x: np.ndarray, a: int, b: int, sr: int) -> np.ndarray:
    """x[:, a:b] with both ends moved to the nearest zero crossing (within 5 ms) and faded."""
    m = x.mean(axis=0)
    reach = int(0.005 * sr)
    a, b = _zc(m, max(0, a), reach), _zc(m, min(m.size - 1, b), reach)
    return _fade(x[:, a:b], sr)


def slice_bass(bass: np.ndarray, sr: int, analysis: SongAnalysis, start_bar: int, bars: int) -> list[OneShot]:
    """The bass notes of those bars as one-shots (each up to 2 beats long)."""
    x = _stereo(bass)
    beat = 60.0 / analysis.bpm
    t0 = analysis.downbeat_s + (start_bar - 1) * 4 * beat
    shots = []
    for n in extract_groove(bass, sr, analysis, start_bar=start_bar, bars=bars).notes:
        secs = min(n.beats, 2.0) * beat
        if secs < MIN_SHOT_S:
            continue
        a = int(round((t0 + n.beat * beat) * sr))
        seg = _slice(x, a, a + int(secs * sr), sr)
        if seg.shape[1] < int(MIN_SHOT_S * sr):
            continue
        m = seg.mean(axis=0)
        spec = np.abs(np.fft.rfft(m * np.hanning(m.size)))
        f = np.fft.rfftfreq(m.size, 1 / sr)
        shots.append(OneShot(seg, n.midi, secs, float((spec * f).sum() / max(spec.sum(), EPS)),
                             float(np.sqrt((m**2).mean()))))
    return shots


def drum_shots(drums: np.ndarray, sr: int, analysis: SongAnalysis, start_bar: int, bars: int) -> dict[str, np.ndarray]:
    """The song's kick, snare and hat as one-shots: in those bars, the loudest hit of each voice with no other voice
    within 60 ms and no second transient in its window (so the slice is clean; else the loudest, cut before it)."""
    x = _stereo(drums)
    beat = 60.0 / analysis.bpm
    b0, b1 = (start_bar - 1) * 4, (start_bar - 1 + bars) * 4
    hits = [h for h in drum_hits(drums, sr, analysis) if b0 <= h.beat < b1]
    out = {}
    for kind, secs in (("kick", 0.35), ("snare", 0.3), ("hats", 0.08)):
        mine = [h for h in hits if h.kind == kind]
        clean = [h for h in mine if not any(o.kind != kind and abs(o.beat - h.beat) * beat < 0.06 for o in hits)] or mine
        if not clean:
            continue
        cut = []  # the loudest few, each cut at a second transient: the loudest that keeps 4/5 of its window, else the loudest
        for h in sorted(clean, key=lambda h: -h.vel)[:12]:
            a = int(round((analysis.downbeat_s + h.beat * beat) * sr)) - int(0.005 * sr)  # keep the hit's own onset
            cut.append(_own_hit(x[:, max(0, a) : max(0, a) + int(secs * sr)], sr))
        whole = [y for y in cut if y.shape[1] >= 0.8 * secs * sr]
        out[kind] = _fade((whole or cut)[0], sr, 0.003, 0.03)
    return out


def _own_hit(y: np.ndarray, sr: int) -> np.ndarray:
    """A shot cut before a second transient in its window (a flam, the next hat, bleed): its own peak is in its first
    30 ms, and anything back within 3 dB of it past 40 ms is another hit; cut at the quietest point between (song-1's
    snare shot carried a louder hit 137 ms in, which became the kit's snare peak)."""
    env = ndimage.uniform_filter1d(np.abs(y).max(axis=0), max(1, int(0.005 * sr)))
    p = int(np.argmax(env[: int(0.03 * sr)]))
    late = np.flatnonzero(env[p + int(0.04 * sr):] > env[p] * 10 ** (-3 / 20))
    if not len(late):
        return y
    q = p + int(0.04 * sr) + int(late[0])
    return y[:, : p + int(np.argmin(env[p:q]))]


def _pitched(s: OneShot, target: float | None, max_beats: float, beat: float, sr: int) -> np.ndarray:
    """A one-shot repitched to `target` (sampler-style: faster is higher), cut to `max_beats`."""
    y = s.audio
    if target is not None and s.midi is not None:
        r = 2 ** ((target - s.midi) / 12)
        n = int(y.shape[1] / r)
        pos = np.arange(n) * r
        y = np.stack([np.interp(pos, np.arange(y.shape[1]), ch) for ch in y]).astype(np.float32)
    return _fade(y[:, : max(1, int(max_beats * beat * sr))], sr)


def _near(root_pc: int, midi: float | None, tune: float = 0.0) -> float | None:
    """The root in the one-shot's own octave (the smallest repitch), on the track's tuning (`tune` semitones: its
    offset from A=440; a snap to whole semitones threw that away)."""
    if midi is None:
        return None
    return midi + ((root_pc + tune - midi + 6) % 12 - 6)


# The bass grids as degree templates (REMIX_HARMONY 2.5): (beat in the bar, beats long, degree, "call" or "resp"), two
# bars each, every degree resolved against the bar's chord (_deg: "3" is its own third; a power chord's falls back to the
# 5th). Nothing starts between beats 1.75 and 2.25 (the snare window). Gestures ("8>R-12", "R>next") play their start
# degree on the one-shot path (it can't glide yet). The switch bars keep their rhythm on R R 5 8 b7 R.
RIDDIM_H = [[(0.0, .75, "R", "call"), (1.0, 1 / 3, "R", "call"), (4 / 3, 1 / 3, "8", "call"),
             (2.25, 5 / 12, "R", "resp"), (2 + 2 / 3, .5, "8", "resp"), (3.5, .25, "R", "resp")],
            [(0.0, .75, "R", "call"), (1.0, .5, "b7", "call"),
             (2.25, .5, "R", "resp"), (2.75, .5, "8", "resp"), (3.5, .25, "b2", "resp")]]
TEAROUT_H = [[(0.0, .5, "R", "call"), (.75, .25, "R", "call"), (1.0, .5, "5", "call"), (1.5, .25, "8", "call"),
              (2.5, .25, "R", "resp"), (2.75, .25, "b2", "resp"), (3.0, .5, "R", "resp"), (3.5, .5, "8>R-12", "resp")],
             [(0.0, .25, "R", "call"), (.25, .25, "R", "call"), (.5, .25, "b5", "call"), (.75, .25, "8", "call"),
              (1.0, .75, "R", "call"), (2.25, .25, "8", "resp"), (2.5, .25, "b7", "resp"), (2.75, .25, "8", "resp"),
              (3.0, 1.0, "R", "resp")]]
HALFTIME_H = [[(0.0, 1.0, "R", "call"), (1.5, .25, "R", "call"), (1.75 - 1 / 16, 1 / 16, "5", "call"),
               (2.5, .5, "8", "resp"), (3.25, .5, "b7", "resp")],
              [(0.0, .5, "R", "call"), (.75, .5, "8", "call"), (2.5, .5, "8", "resp"), (3.0, 1.0, "R>next", "resp")]]
EIGHT08_H = [[(0.0, 1.75, "R", "call"), (2.5, .5, "R", "resp"), (3.0, .5, "5", "resp"), (3.5, .5, "8>R", "resp")]]
_SW = ("R", "R", "5", "8", "b7", "R")
RIDDIM_SWITCH = [[(k / 3, 1 / 3, _SW[k], "call") for k in range(6)] + [(3.0, 1.0, "R", "resp")]]
HALFTIME_SWITCH = [[(0.0, 0.5, "R", "call"), (0.75, 0.5, "R", "call"), (1.5, 0.25, "5", "resp"), (2.5, 1.5, "8", "resp")]]
TEAROUT_SWITCH = [[(k / 4, 0.25, _SW[min(k, 5)], "call") for k in range(8)] + [(3.0, 1.0, "R", "resp")]]
DEG = {"R": 0, "5": 7, "8": 12, "b7": 10, "b2": 1, "b5": 6, "R-12": -12}
TENSION = {"b2": "R", "b5": "R", "b7": "8"}  # the take's drop.tension off (the default): the root and octave instead


def _plain(degree: str, tension: bool) -> str:
    """A template degree as played: without drop.tension the tension slots fall to the root / octave (the user's set3:
    motion from rhythm and sound, not notes)."""
    if tension:
        return degree
    d, sep, rest = degree.partition(">")
    return TENSION.get(d, d) + sep + rest


def _deg(degree: str, third: int) -> int:
    """A template degree in semitones over the bar's root: "3" is the chord's own third (3 / 4, 5 on sus4, 7 on a power
    chord); a gesture ("8>R-12") its start."""
    d = degree.split(">")[0]
    return third if d == "3" else DEG[d]


STYLES = {"riddim": (RIDDIM_H, RIDDIM_SWITCH), "halftime": (HALFTIME_H, HALFTIME_SWITCH), "tearout": (TEAROUT_H, TEAROUT_SWITCH),
          # the song's own 808 chopped on the 808 degrees (root, 5th, octave; REMIX_HARMONY 2.5 EIGHT08_H)
          "trap_hybrid": (EIGHT08_H, RIDDIM_SWITCH)}
DESIGN_FOR = {"riddim": "riddim", "tearout": "tearout", "halftime": "riddim", "trap_hybrid": "riddim", None: "growl"}  # growl.PATCHES


def sequence(shots: list[OneShot], style: str, bars: int, bpm: float, sr: int, root_pc: int, switch_every: int = 4,
             chord=None, tune: float = 0.0, tension: bool = False) -> tuple[np.ndarray, list[tuple[float, float, float]]]:
    """The one-shots on the style's grid (see the module doc), the switch grid ending every `switch_every` bars (the
    take's drop.cadence), each bar on its chord (`chord(bar) -> (root pc, third)`, the source's harmony) else on
    `root_pc`: the growl bus (2, n) and the hits (midi, beat, beats)."""
    beat = 60.0 / bpm
    n = int(round(bars * 4 * beat * sr))
    bus = np.zeros((2, n), np.float32)
    hits: list[tuple[float, float, float]] = []
    if not shots:
        return bus, hits
    # the brightest, loudest shots are the growls; calls and responses rotate through them every 4 bars
    ranked = sorted(shots, key=lambda s: -(s.bright * s.level))[: max(2, min(8, len(shots)))]
    grid, switch = STYLES[style]
    for bar in range(bars):
        block = bar // 4
        tbl = switch if bar % switch_every == switch_every - 1 else grid
        pat = tbl[bar % len(tbl)]
        pick = {"call": ranked[(2 * block) % len(ranked)], "resp": ranked[(2 * block + 1) % len(ranked)]}
        for b, beats, step, role in pat:
            step = _plain(step, tension)
            rp, third = chord(bar, b) if chord else (root_pc, 3)
            s = pick[role]
            base = _near(rp, s.midi, tune)
            target = None if base is None else base + _deg(step, third) + (12 if bar % 8 == 6 else 0)  # 5.2: bar 7 escalates
            y = _pitched(s, target, beats, beat, sr)
            a = int(round((bar * 4 + b) * beat * sr))
            m = min(y.shape[1], n - a)
            if m > 0:
                bus[:, a : a + m] += y[:, :m]
            midi = (target if target is not None else rp + 36.0 + tune)
            hits.append((midi, bar * 4 + b, beats))
            _note(bar * 4 + b, beats, midi, step, "mid")
    return bus, hits


def _sub_hz(midi: float) -> float:
    hz = 440 * 2 ** ((midi - 69) / 12)
    while hz >= 56:
        hz /= 2
    while hz < 28:
        hz *= 2
    return hz


def sub_line(hits: list[tuple[float, float, float]], bpm: float, sr: int, n: int, fold: bool = True) -> np.ndarray:
    """A clean mono sine under every hit, the hit's note in the sub octave (28-56 Hz; `fold` False: as given), 5 ms
    in, 40 ms out."""
    beat = 60.0 / bpm
    freq = np.zeros(n)
    gate = np.zeros(n)
    for midi, b, beats in sorted(hits, key=lambda h: h[1]):
        a, e = int(b * beat * sr), min(n, int((b + beats) * beat * sr))
        freq[a:] = _sub_hz(midi) if fold else 440 * 2 ** ((midi - 69) / 12)  # held through the release
        gate[a:e] = 1.0
    env = signal.lfilter([1 - np.exp(-1 / (0.04 * sr))], [1, -np.exp(-1 / (0.04 * sr))], gate)
    env = np.maximum(env, signal.lfilter([1 - np.exp(-1 / (0.005 * sr))], [1, -np.exp(-1 / (0.005 * sr))], gate))
    return (np.sin(2 * np.pi * np.cumsum(freq) / sr) * env).astype(np.float32)


def _fold_sub(pc: float, prev: float | None) -> float:
    """A root (pitch class + tuning) as a sub note in B0-B1 (MIDI 23-35, 30.9-61.7 Hz; REMIX_HARMONY 2.6): the octave
    nearest the previous sub note, the first in C1-B1."""
    cands = [pc % 12 + 12 * k for k in range(1, 4) if 23 <= pc % 12 + 12 * k <= 35.99]
    if prev is None:
        return next(m for m in cands if m >= 24) if any(m >= 24 for m in cands) else cands[0]
    return min(cands, key=lambda m: abs(m - prev))


def root_line(root_at, bars: int, bpm: float, sr: int, n: int, tune: float = 0.0, restrike: int = 2) -> np.ndarray:
    """The sub (REMIX_HARMONY 2.1): the current chord root only (`root_at(bar, beat) -> pc`, read per half-bar), never
    the mid's passing notes; held, re-struck on a change and every `restrike` bars (the held weight), a 1/16 breath
    before each re-strike; in B0-B1, nearest the previous note. (n,) mono."""
    segs: list[list] = []
    for h in range(2 * bars):
        pc = root_at(h // 2, 2.0 * (h % 2))
        if not segs or pc != segs[-1][0] or h - segs[-1][1] >= 2 * restrike:
            segs.append([pc, h])
    hits, prev = [], None
    for (pc, h), nxt in zip(segs, [s[1] for s in segs[1:]] + [2 * bars]):
        prev = _fold_sub(pc + tune, prev)
        hits.append((prev, 2.0 * h, 2.0 * (nxt - h) - 0.25))
        _note(2.0 * h, 2.0 * (nxt - h) - 0.25, prev, "R", "sub")
    return sub_line(hits, bpm, sr, n, fold=False)


def _upward(x: np.ndarray, sr: int, thr_db: float, ratio: float, max_db: float) -> np.ndarray:
    """Upward compression: quiet detail below `thr_db` lifted toward it (a peak follower with a 3 ms look-ahead,
    1 ms / 80 ms)."""
    m = np.abs(x).max(axis=0)
    # a 3 ms look-ahead: the gain is already down when a hit lands after a rest (else its first milliseconds get the
    # full lift, a spike that reads as a click)
    la = max(1, int(0.003 * sr))
    m2 = ndimage.maximum_filter1d(m**2, 2 * la + 1, origin=-la, mode="nearest")
    att, rel = np.exp(-1 / (0.001 * sr)), np.exp(-1 / (0.08 * sr))
    env = signal.lfilter([1 - rel], [1, -rel], m2)
    env = np.maximum(env, signal.lfilter([1 - att], [1, -att], m2))
    lvl = 10 * np.log10(env + 1e-10)
    gain = np.clip((thr_db - lvl) * (1 - 1 / ratio), 0, max_db)
    gain[lvl < -70] = 0  # silence stays silent
    return (x * 10 ** (gain / 20)).astype(np.float32)


def ott(x: np.ndarray, sr: int, depth: float = 0.7) -> np.ndarray:
    """A 3-band squash (after OTT): split at 120 Hz and 2.5 kHz; each band up-compressed below -38 dB and
    down-compressed above -24 dB (4:1, fast), then blended `depth` with the dry signal."""
    sos = lambda kind, f: signal.butter(2, f, kind, fs=sr, output="sos")
    lr = lambda y, kind, f: signal.sosfilt(sos(kind, f), signal.sosfilt(sos(kind, f), y, axis=-1), axis=-1)  # LR4
    low = lr(x, "low", 120.0)
    high = lr(x, "high", 2500.0)
    mid = x - low - high
    out = np.zeros_like(x)
    for band, makeup in ((low, 1.0), (mid, 1.4), (high, 1.6)):
        y = _upward(band.astype(np.float32), sr, -38.0, 3.0, 18.0)
        y = Compressor(threshold_db=-24, ratio=4, attack_ms=2, release_ms=60)(y, sr)
        out += makeup * y
    return (depth * out + (1 - depth) * x).astype(np.float32)


def print_shot(s: OneShot, sr: int) -> OneShot:
    """A one-shot "printed" the way a producer resamples: hi-passed at 100 Hz (the sub owns the low end) and driven
    through parallel distortion before it's chopped, so the chop's fades stay smooth (distorting after the chop turns a
    4 ms fade into a sub-millisecond edge: a click)."""
    x = signal.sosfiltfilt(signal.butter(4, MID_HP, "high", fs=sr, output="sos"), s.audio, axis=-1).astype(np.float32)
    peak = max(float(np.abs(x).max()), EPS)
    dist = np.tanh(6.0 * x / peak) * peak
    x = x + 0.6 * signal.sosfilt(signal.butter(2, 180, "high", fs=sr, output="sos"), dist, axis=-1).astype(np.float32)
    return OneShot(_fade(x, sr), s.midi, s.seconds, s.bright, s.level)


def drop_chain(bus: np.ndarray, sr: int) -> np.ndarray:
    """The growl bus's drop processing (its one-shots printed first, print_shot): hi-pass 100 Hz, the OTT squash."""
    x = signal.sosfiltfilt(signal.butter(4, MID_HP, "high", fs=sr, output="sos"), bus, axis=-1).astype(np.float32)
    return ott(x, sr)


def root_pc(shots: list[OneShot]) -> int:
    """The drop's root: the pitch class its bass notes spend the most time on."""
    w = np.zeros(12)
    for s in shots:
        if s.midi is not None:
            w[int(round(s.midi)) % 12] += s.seconds
    return int(np.argmax(w)) if w.any() else 1


# ---------------------------------------------------------------------------------------------- per-clip renders
# The engine path (prepare.py dispatches groove clips by patch_id prefix, kit clips by kit_id): each renders one lane's
# audio for one clip; drums, ducking, the impact and the loudness belong to the other lanes and to mixdown.


def _fold_c1(midi: float) -> float:
    """The note's pitch in C1-B1 (MIDI 24-35), where an 808 / sub root lives."""
    return 24 + (midi - 24) % 12


def eight08(midi: float, beats: float, bpm: float, sr: int, blip_st: float = 5.0, blip_ms: float = 30.0,
            dark_hz: float | None = None, dive_st: float = 0.0) -> np.ndarray:
    """A synthesized 808 at `midi` (folded into C1-B1): a clean sine with only a small pitch blip at the attack
    (+blip_st settling within blip_ms: a glide in from far above sounds whiny, the user said), a low-passed attack,
    parallel saturation (a phone speaker hears the harmonics), held `beats`; `dark_hz` low-passes it darker,
    `dive_st` bends it that far over its length (a switch-up dive). (2, n)."""
    n = int(round(beats * 60.0 / bpm * sr))
    t = np.arange(n) / sr
    st = blip_st * np.exp(-t / (blip_ms / 1000 / 3)) + dive_st * (t / max(t[-1], 1e-9)) ** 1.5
    f = 440 * 2 ** ((_fold_c1(midi) + st - 69) / 12)
    x = np.sin(2 * np.pi * np.cumsum(f) / sr)
    dirty = signal.sosfilt(signal.butter(2, 400, fs=sr, output="sos"), np.tanh(4.0 * x))
    y = x + 0.6 * dirty
    y = signal.sosfilt(signal.butter(2, dark_hz or 2500.0, fs=sr, output="sos"), y)  # the attack's edge off
    env = np.minimum(1.0, t / 0.002) * np.minimum(1.0, (n / sr - t) / 0.15)
    y = (y * env / max(float(np.abs(y).max()), EPS)).astype(np.float32)
    return np.stack([y, y])


def resample_bass(bass: np.ndarray, sr: int, analysis: SongAnalysis, start_bar: int, bars: int, style: str, bpm: float,
                  rng: np.random.Generator, with_sub: bool = True, switch_every: int = 4, chord=None,
                  tune: float = 0.0, mid_chord=None, tension: bool = False) -> np.ndarray:
    """The resample path for one clip: the source's one-shots from those bars (designed growls when it has none),
    re-sequenced on the style's grid (its switch bar every `switch_every`), printed and chained; the clean sub under
    them unless another lane owns the low end (`with_sub`). The seed turns which shots call and answer. (2, n), not
    ducked (mixdown does)."""
    from .growl import design_shots, has_growls

    beat = 60.0 / bpm
    n = int(round(bars * 4 * beat * sr))
    source = slice_bass(bass, sr, analysis, start_bar, max(8, bars))
    rp = root_pc(source)
    t0 = analysis.downbeat_s + (start_bar - 1) * 4 * 60.0 / analysis.bpm
    shots = source if has_growls(bass, sr, t0, max(8, bars) * 240.0 / analysis.bpm) else design_shots(DESIGN_FOR[style], rp, bpm, sr)
    k = int(rng.integers(len(shots))) if shots else 0
    shots = [print_shot(s, sr) for s in shots[k:] + shots[:k]]
    bus, hits = sequence(shots, style, bars, bpm, sr, rp, switch_every, mid_chord or chord, tune, tension)
    out = GROWL * drop_chain(bus, sr)
    if with_sub:  # the sub on the chord roots, not on the one-shots' notes (REMIX_HARMONY 2.1)
        sub = root_line((lambda b, beat: chord(b, beat)[0]) if chord else (lambda b, beat: rp), bars, bpm, sr, n, tune)
        out = out / max(float(np.abs(out).max()), EPS) + SUB * np.stack([sub, sub])
    return out.astype(np.float32)


def _hf_power(y: np.ndarray, sr: int) -> np.ndarray:
    m = y.mean(axis=0) if y.ndim > 1 else y
    return signal.sosfilt(signal.butter(4, 4000, "high", fs=sr, output="sos"), m / max(float(np.abs(m).max()), EPS) * 0.9) ** 2


def _clean_hit(render, style: str, midi: float, beats: float, bpm: float, sr: int, variant: int, hit: int,
               axes: dict[str, str] | None = None) -> np.ndarray:
    """One of S3's growl hits, re-rendered in another hit state (up to 3 more) if it fails either per-hit check:
    growls.qa's join clicks (the Sound Bible's "detector on the edges of every slice") or growls.clicks on the padded
    hit (its body, as the mix detector sees it)."""
    try:
        from fvwks_synth import growls
    except ImportError:
        growls = None
    qa = getattr(growls, "qa", None)
    clicks = getattr(growls, "clicks", None)

    def bad(y: np.ndarray) -> bool:  # its joins (qa) or its body (the mix detector's rule on the padded hit)
        if qa is not None and qa(y, sr).get("clicks", 0) > 0:
            return True
        if style == "chomp":  # its +24 st onset snap is the designed click: joins only
            return False
        return clicks is not None and clicks(_hf_power(np.pad(y, ((0, 0), (sr // 20, sr // 20))), sr), sr) > 0

    y = render(style, midi, beats, bpm, sr=sr, variant=variant, sub=False, hit=hit, axes=axes)
    for tries in range(1, 4):
        if not bad(y):
            break
        y = render(style, midi, beats, bpm, sr=sr, variant=variant, sub=False, hit=hit + 97 * tries, axes=axes)
    return y


def _voice(style: str):
    """S3's per-hit growl voice (fvwks_synth.growls: render_growl(style, midi, beats, bpm, sr, variant, sub, hit)) when
    it's installed and has `style`, else None."""
    try:
        from fvwks_synth import growls
    except ImportError:
        return None
    return growls.render_growl if style in getattr(growls, "STYLES", ()) else None


def hybrid_growls(bass: np.ndarray, sr: int, analysis: SongAnalysis, start_bar: int, bars: int, growl: str, bpm: float,
                  rng: np.random.Generator, switch_every: int = 4, axes: dict[str, str] | None = None,
                  chord=None, tune: float = 0.0, with_sub: bool = False, mid_chord=None, tension: bool = False) -> np.ndarray:
    """The headline hybrid's growls for one clip (Sound Bible 2.5): designed growls answering the source's held 808
    every half bar (the 808 calls on beats 1-2, the growls on 3-4; the whole second half of every 4th bar is the
    tearout switch-up), each hit on the 808's note of the moment. With S3's tearout voices each window opens with a
    chomp (the call) and talkers answer, every hit its own state (hit index, the seed's variant): never the same shot
    twice in a row. Else the growl.BANK palette, chopped. Hi-passed: the 808 keeps the low end. (2, n)."""
    beat = 60.0 / bpm
    n = int(round(bars * 4 * beat * sr))
    notes = extract_groove(bass, sr, analysis, start_bar=start_bar, bars=bars).notes
    rp = root_pc(slice_bass(bass, sr, analysis, start_bar, max(8, bars))) if not notes else int(round(notes[0].midi)) % 12
    pitch_at = lambda x: next((nt.midi for nt in reversed(notes) if nt.beat <= x), notes[0].midi if notes else 36.0 + rp)
    grow = lambda m: 36 + int(round(m)) % 12  # the growl octave, C2-B2
    call, answer = _voice("chomp"), _voice("talker")
    variant = int(rng.integers(4))
    shots, order = [], []
    if not (call and answer):
        from .growl import design_shots

        shots = [print_shot(s, sr) for s in design_shots(growl, rp, bpm, sr)]
        order = list(rng.permutation(len(shots)))
    bus = np.zeros((2, n), np.float32)
    k = 0
    for bar in range(bars):
        first = True
        for bb, beats, step, _ in (TEAROUT_SWITCH[0] if bar % switch_every == switch_every - 1 else TEAROUT_H[bar % 2]):
            if bb < 2.0:  # the 808's half
                continue
            step = _plain(step, tension)
            x = 4 * bar + bb
            if chord:  # the bar's chord (the source's harmony): its root in the growl octave, its own third
                rp_bar, third = (mid_chord or chord)(bar, bb)
                target = 36 + rp_bar + _deg(step, third) + tune
            else:
                target = grow(pitch_at(x)) + _deg(step, 3) + tune
            target += 12 if bar % 8 == 6 else 0  # 5.2: bar 7 escalates (an octave up)
            if call and answer:
                # 5.2: bars 9-16 a new patch family (S3's pwm calls, disperser answers), bars 1-8 chomp / talker
                pair = ("pwm", "disperser") if bar >= 8 and _voice("pwm") and _voice("disperser") else ("chomp", "talker")
                y = _clean_hit(call if first else answer, pair[0] if first else pair[1], target, beats, bpm, sr,
                               variant, k, axes)
            else:
                s = shots[order[k % len(order)]]
                t2 = s.midi + ((target - s.midi + 6) % 12 - 6) if s.midi is not None else None
                y = _pitched(s, t2, beats, beat, sr)
            y = _fade(y, sr, 0.004, 0.012)  # butted hits: a 4 ms rise (a loud growl rising in 2 ms reads as a click)
            first = False
            k += 1
            _note(x, beats, target, step, "mid")
            a = int(round(x * beat * sr))
            m = min(y.shape[1], n - a)
            if m > 0:
                bus[:, a : a + m] += y[:, :m]
    if call and answer:  # S3's voices come finished (distorted, OTT'd, hi-passed): only the low end kept clear
        out = signal.sosfilt(signal.butter(4, MID_HP, "high", fs=sr, output="sos"), bus, axis=-1).astype(np.float32)
    else:
        out = drop_chain(bus, sr)
    out = GROWL * out
    if with_sub:  # no source 808 under it (the plan moved off the source's roots): the sub on the plan's roots
        sub = root_line((lambda b, beat: chord(b, beat)[0]) if chord else (lambda b, beat: rp), bars, bpm, sr, n, tune)
        out = 0.5 * out / max(float(np.abs(out).max()), EPS) + 0.9 * np.stack([sub, sub])
    return out.astype(np.float32)


def riddim_bass(sr: int, bpm: float, bars: int, root: int, rng: np.random.Generator, switch_every: int = 4,
                axes: dict[str, str] | None = None, chord=None, tune: float = 0.0, mid_chord=None,
                tension: bool = False) -> np.ndarray:
    """Riddim's bass for one clip: RIDDIM_H's degrees on each bar's chord (REMIX_HARMONY 2.5), each hit its own LFO rate by
    its length (the seed picks which template bar leads), developing over every 4 bars (the filter opening) with an octave accent ending every
    `switch_every` bars (the take's drop.cadence), over a held sub. The voice: S1's R1 square-FM wub
    (render_growl("riddim"), its LFO rate by variant; the take's `axes`), the formant "yoi" R2 under it at the take's
    riddim.r2_blend, when installed, else this module's placeholder wub. (2, n)."""
    from .growl import wub

    beat = 60.0 / bpm
    n = int(round(bars * 4 * beat * sr))
    bus = np.zeros((2, n), np.float32)
    hits: list[tuple[float, float, float]] = []
    lead = int(rng.integers(2))
    r1, r2 = _voice("riddim"), _voice("yoi")
    try:
        from fvwks_synth.riddim import r2_blend

        blend = r2_blend(axes)
    except ImportError:
        blend = 0.4
    rate = {"1/4": 0, "1/4T": 1, "1/8": 2, "1/8T": 3}
    for bar in range(bars):
        k = bar % 4
        motif = RIDDIM_H[(bar + lead) % 2]  # the degree template (REMIX_HARMONY 2.5), each note on the bar's chord
        for j, (b, beats, degree, _) in enumerate(motif):
            degree = _plain(degree, tension)
            rp, third = (mid_chord or chord)(bar, b) if chord else (root, 3)
            accent = bar % switch_every == switch_every - 1 and j == len(motif) - 1  # the phrase end an octave up
            m = 36 + rp + tune + _deg(degree, third) + (12 if (accent and degree == "R") or bar % 8 == 6 else 0)
            div = "1/8T" if beats >= 0.75 else "1/4" if beats >= 0.5 else "1/4T" if beats > 1 / 3 else "1/8"  # by length
            if r1 is not None:
                y = r1("riddim", m, beats, bpm, sr=sr, variant=rate[div], sub=False, axes=axes)
                if r2 is not None and (accent or j == 0 or bar >= 8):  # 5.2: bars 9-16, the yoi under every note
                    y = y + blend * r2("yoi", m, beats, bpm, sr=sr, variant=(bar // 4) % 4, sub=False, axes=axes)[:, : y.shape[1]]
            else:
                y = wub(m, beats, bpm, sr, div, open_oct=2.4 + 0.35 * k, variant=(bar // 4) % 3)
            a = int(round((4 * bar + b) * beat * sr))
            mm = min(y.shape[1], n - a)
            if mm > 0:
                bus[:, a : a + mm] += y[:, :mm]
                hits.append((float(m), 4 * bar + b, beats))
                _note(4 * bar + b, beats, m, degree, "mid")
    # the sub holds (plan C6 / the user's held weight): the root re-struck on a chord change or every 2 bars, only
    # ducked (by mixdown)
    sub = np.stack([root_line((lambda b, beat: chord(b, beat)[0]) if chord else (lambda b, beat: root), bars, bpm, sr, n,
                              tune)] * 2)
    chained = bus if r1 is not None else drop_chain(bus, sr)  # S1's voices come chained
    lr4 = signal.butter(2, 180, "high", fs=sr, output="sos")  # off the sub's band: the wub's C2 fundamental too (LR4)
    chained = signal.sosfilt(lr4, signal.sosfilt(lr4, chained, axis=-1), axis=-1)
    rms = lambda z: float(np.sqrt(np.mean(np.square(z, dtype=np.float64)))) + EPS  # noqa: E731
    # riddim is mid-forward (Sound Bible 5: growl bars' mid -4..+2 dB re the sub): the wub RIDDIM_MID_DB re the sub
    return (0.9 * sub + chained * (0.9 * rms(sub) / rms(chained) * 10 ** (RIDDIM_MID_DB / 20))).astype(np.float32)


_SHOTS: dict[tuple[int, int], dict[str, np.ndarray]] = {}  # ponytail: in-process, per drum stem (id, length)


def source_kit(drums: np.ndarray, sr: int, analysis: SongAnalysis, hits: list, bpm: float, n: int) -> np.ndarray:
    """A kit clip on the song's own drums: its cleanest kick, snare and hat (drum_shots over the whole song, read once
    per stem) at the hits' beats and velocities. (2, n)."""
    key = (id(drums), np.asarray(drums).shape[-1])
    if key not in _SHOTS:
        bars = int(np.asarray(drums).shape[-1] / sr / (240.0 / analysis.bpm))
        _SHOTS[key] = {k: v / max(float(np.abs(v).max()), EPS) for k, v in drum_shots(drums, sr, analysis, 1, bars).items()}
    shots = _SHOTS[key]
    beat = 60.0 / bpm
    out = np.zeros((2, n), np.float32)
    level = {"kick": 0.84, "snare": 1.0, "hats": 0.3}  # the snare the drop's top peak (Sound Bible 3.2), the kick 1.5 dB under
    for h in hits:
        s = shots.get(h.voice)
        if s is None:
            continue
        a = int(round(h.beat * beat * sr))
        m = min(s.shape[1], n - a)
        if m > 0:
            out[:, a : a + m] += level[h.voice] * h.vel * s[:, :m]
    return out
