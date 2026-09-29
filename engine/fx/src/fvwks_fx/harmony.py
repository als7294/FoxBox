"""Harmony: a song's chords, bar by bar (the user's "study chord progressions"). DSP only (numpy / scipy).

chords(stems, sr, bpm, downbeat_s, key=None) -> Harmony
  Per beat: the sustained chroma of the melodic stems (other + vocals; a time-median over the STFT keeps the held
  notes, not the hits) and the bass stem's pitch classes (55-250 Hz: the chord's root, usually). Each beat is scored
  against chord templates (12 roots x maj / min / sus4 / 7 / m7, and N: no chord) by cosine, plus the bass on the
  chord's root and a small prior for chords diatonic to the song's key; Viterbi smooths it (a chord holds; a change
  is cheap on a bar line, dear mid-bar). Each bar gets the chord covering most of its beats. The bass decides the
  roots (REMIX_HARMONY 6.5): each half-bar where the bass plays takes its BASS DNA root (note time per pitch class, a
  note on the half-bar's downbeat x2) with the quality the melodic stems score best on it; a half-bar that differs
  from its bar's first is the bar's root2 / quality2.

Harmony.bars[i] is bar i + 1 (the song's bar numbering): BarChord(root_pc or None, quality, confidence 0-1).
tones(chord) gives its pitch classes; Harmony.at(bar) the chord of a bar (the nearest known one past the ends).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage, signal

from .music import parse_key

QUALITIES: dict[str, tuple[int, ...]] = {"maj": (0, 4, 7), "min": (0, 3, 7), "sus4": (0, 5, 7), "7": (0, 4, 7, 10),
                                         "m7": (0, 3, 7, 10)}  # (the contract's power chord "5" is written by plans only)
AN_SR = 11025
BASS_W = 0.25  # the bass on the chord's root, added to the cosine
KEY_W = 0.05  # a chord whose tones all sit in the key
SEVENTH_W = -0.03  # a 7th chord only when its 7th is really there (4 tones match broad chroma more easily)
CHANGE_BAR, CHANGE_MID = 0.3, 1.5  # Viterbi: what a chord change costs on a bar line / mid-bar (score units x KAPPA)
KAPPA = 10.0
N_FLOOR = 0.45  # a beat whose best chord scores under this reads as no chord


@dataclass(frozen=True)
class BarChord:
    root: int | None  # pitch class, None for no chord
    quality: str  # a QUALITIES key, or "N"
    confidence: float = 0.0
    root2: int | None = None  # from beat 3, when the bass moves there (v0.15.1)
    quality2: str | None = None

    @property
    def name(self) -> str:
        from .music import _NAMES

        return "N" if self.root is None else _NAMES[self.root] + {"maj": "", "min": "m", "sus4": "sus4", "7": "7",
                                                                    "m7": "m7"}[self.quality]

    @property
    def minor(self) -> bool:
        return self.quality in ("min", "m7")


def tones(c: BarChord) -> tuple[int, ...]:
    """The chord's pitch classes (the root first), () for no chord."""
    return () if c.root is None else tuple((c.root + i) % 12 for i in QUALITIES[c.quality])


@dataclass
class Harmony:
    bars: list[BarChord] = field(default_factory=list)
    beats: list[BarChord] = field(default_factory=list)

    def at(self, bar: int) -> BarChord:
        """The chord of song bar `bar` (1-based); past the ends, or on a no-chord bar, the nearest known chord."""
        if not self.bars:
            return BarChord(None, "N")
        i = min(max(bar - 1, 0), len(self.bars) - 1)
        for k in sorted(range(len(self.bars)), key=lambda j: abs(j - i)):
            if self.bars[k].root is not None:
                return self.bars[k]
        return self.bars[i]


def to_contract(c: BarChord):
    """A BarChord as the v0.14 contract's Chord (root spelled as FoxBox spells keys; None / N for no chord)."""
    from fvwks_contracts.models import Chord

    from .music import _NAMES

    return Chord(root=None if c.root is None else _NAMES[c.root], quality="N" if c.root is None else c.quality,
                 confidence=float(np.clip(c.confidence, 0.0, 1.0)), root2=None if c.root2 is None else _NAMES[c.root2],
                 quality2=c.quality2 if c.root2 is not None else None)


def from_contract(c, beat: float = 0.0) -> tuple[int, int] | None:
    """A contract Chord at `beat` of its bar as (root pc, its third: 3 minor, 4 major, 5 sus4, 7 for a power chord),
    None for no chord; from beat 3 a bar that changes halfway (v0.15.1 root2 / quality2) is its second chord."""
    from .music import _NAMES

    root, quality = (c.root2, c.quality2 or "maj") if beat >= 2.0 and getattr(c, "root2", None) else (c.root, c.quality)
    if root is None or quality == "N":
        return None
    return _NAMES.index(root), {"min": 3, "m7": 3, "sus4": 5, "5": 7}.get(quality, 4)


def pitch_set(stems: dict[str, np.ndarray], sr: int, bpm: float, downbeat_s: float, bar0: int, bars: int, k: int = 5,
              tuning_cents: float | None = None) -> set[int]:
    """The `k` strongest sustained pitch classes of the melodic stems (other + vocals) over song bars [bar0, bar0 + bars):
    the source hook's pitch set (REMIX_HARMONY 3.2 "source first")."""
    melodic = sum(np.asarray(stems[s], np.float64).mean(axis=0) if np.ndim(stems[s]) > 1 else np.asarray(stems[s], np.float64)
                  for s in ("other", "vocals") if s in stems)
    if np.ndim(melodic) == 0:
        return set()
    bar = 240.0 / bpm
    a, b = int(max(0.0, downbeat_s + (bar0 - 1) * bar) * sr), int(max(0.0, downbeat_s + (bar0 - 1 + bars) * bar) * sr)
    if b - a < sr:
        return set()
    ch, _ = _pc_frames(_mono(melodic[a:b], sr), 150.0, 2000.0, 512, float(tuning_cents or 0.0))
    return {int(i) for i in np.argsort(ch.mean(axis=0))[-k:]}


def _pc_frames(x: np.ndarray, lo: float, hi: float, hop: int, cents: float = 0.0) -> tuple[np.ndarray, float]:
    """Sustained pitch-class power per frame (frames, 12), each frame L2-normalised; frames per second."""
    f, _, z = signal.stft(x, AN_SR, nperseg=4096, noverlap=4096 - hop)  # frames centred on k * hop, to the end
    use = (f >= lo) & (f <= hi)
    p = ndimage.median_filter(np.abs(z[use]).T, size=(9, 1), mode="nearest") ** 2  # the held notes, not the hits
    pc = np.round(69.0 + 12.0 * np.log2(f[use] / 440.0) - cents / 100.0).astype(np.int64) % 12  # bins on its tuning
    ch = np.stack([p[:, pc == k].sum(axis=1) for k in range(12)], axis=1) ** 0.25
    return ch / np.maximum(np.linalg.norm(ch, axis=1, keepdims=True), 1e-12), AN_SR / hop


def _mono(x: np.ndarray, sr: int) -> np.ndarray:
    m = np.asarray(x, np.float64)
    m = m.mean(axis=0) if m.ndim > 1 else m
    return signal.resample_poly(m, AN_SR, int(sr)) if int(sr) != AN_SR else m


def chords(stems: dict[str, np.ndarray], sr: int, bpm: float, downbeat_s: float, key: str | None = None,
           tuning_cents: float | None = None) -> Harmony:
    melodic = sum(np.asarray(stems[k], np.float64).mean(axis=0) if np.ndim(stems[k]) > 1 else np.asarray(stems[k], np.float64)
                  for k in ("other", "vocals") if k in stems)
    if np.ndim(melodic) == 0 or not np.any(melodic):
        return Harmony()
    hop = 512
    cents = float(tuning_cents or 0.0)
    mel, fps = _pc_frames(_mono(melodic, sr), 55.0, 2000.0, hop, cents)
    bass = _pc_frames(_mono(stems["bass"], sr), 55.0, 250.0, hop, cents)[0] if "bass" in stems else np.zeros_like(mel)
    beat = 60.0 / bpm
    n_beats = int((mel.shape[0] / fps - downbeat_s) // beat)
    if n_beats < 1:
        return Harmony()
    idx = lambda b: (int((downbeat_s + b * beat) * fps), max(int((downbeat_s + b * beat) * fps) + 1, int((downbeat_s + (b + 1) * beat) * fps)))  # noqa: E731
    B = np.array([mel[slice(*idx(b))].mean(axis=0) for b in range(n_beats)])
    L = np.array([bass[slice(*idx(b))].mean(axis=0) for b in range(n_beats)])
    energy = np.linalg.norm(B, axis=1)
    B = B / np.maximum(energy[:, None], 1e-12)
    states = [(r, q) for r in range(12) for q in QUALITIES]
    T = np.zeros((len(states), 12))
    for s, (r, q) in enumerate(states):
        for i, t in enumerate(QUALITIES[q]):
            T[s, (r + t) % 12] = 1.2 if i == 0 else 1.0
    T /= np.linalg.norm(T, axis=1, keepdims=True)
    k = parse_key(key) if key else None
    scale = set(k.scale) if k else set()
    prior = np.array([(KEY_W if scale and {(r + t) % 12 for t in QUALITIES[q]} <= scale else 0.0)
                      + (SEVENTH_W if len(QUALITIES[q]) > 3 else 0.0) for r, q in states])
    Lz = L - L.mean(axis=1, keepdims=True)
    score = B @ T.T + BASS_W * Lz[:, [r for r, _ in states]] + prior  # (beats, states)
    score = np.concatenate([score, np.full((n_beats, 1), N_FLOOR)], axis=1)  # the no-chord state
    em = KAPPA * score
    S = em.shape[1]
    back = np.zeros((n_beats, S), np.int64)
    v = em[0].copy()
    for b in range(1, n_beats):
        cost = KAPPA * (CHANGE_BAR if b % 4 == 0 else CHANGE_MID)
        stay, best = v, int(np.argmax(v))
        take = v[best] - cost
        back[b] = np.where(stay >= take, np.arange(S), best)
        v = np.maximum(stay, take) + em[b]
    path = np.zeros(n_beats, np.int64)
    path[-1] = int(np.argmax(v))
    for b in range(n_beats - 1, 0, -1):
        path[b - 1] = back[b, path[b]]
    lab = lambda s, b: (BarChord(None, "N", 0.0) if s == S - 1 else  # noqa: E731
                        BarChord(states[s][0], states[s][1], float(np.clip((score[b, s] - N_FLOOR) / (1 - N_FLOOR), 0, 1))))
    beats = [lab(int(s), b) for b, s in enumerate(path)]
    bars = []
    for i in range(n_beats // 4):
        bb = beats[4 * i : 4 * i + 4]
        names = [c.name for c in bb]
        top = max(set(names), key=lambda nm: (names.count(nm), -names.index(nm)))
        pick = next(c for c in bb if c.name == top)
        bars.append(BarChord(pick.root, pick.quality, round(float(np.mean([c.confidence for c in bb if c.name == top])), 3)))
    if "bass" in stems:
        bars = _bass_rooted(bars, score, states, _bass_roots(stems["bass"], sr, bpm, downbeat_s, cents, len(bars)))
    return Harmony(bars=bars, beats=beats)


def _bass_roots(bass: np.ndarray, sr: int, bpm: float, downbeat_s: float, cents: float, bars: int) -> list[int | None]:
    """Each half-bar's bass root from the BASS DNA notes: note time per pitch class, a note starting on the half-bar's
    downbeat x2 (REMIX_HARMONY 6.5); None where no pitch class gets half a beat (a slide's fragments, a lone blip).
    A bent or gliding note is an 808's ornament over its root, and a note starting in the half-bar's last beat is a
    pickup into the next: neither votes."""
    from fvwks_contracts.models import SongAnalysis

    from .remix.groove import extract_groove

    notes = extract_groove(bass, sr, SongAnalysis(bpm=bpm, downbeat_s=downbeat_s)).notes
    w = np.zeros((2 * bars, 12))
    for nt in notes:
        if nt.bend or nt.glide_to is not None:
            continue
        pc = round(nt.midi - cents / 100.0) % 12
        for h in range(max(0, int(nt.beat // 2)), min(2 * bars, math.ceil((nt.beat + nt.beats) / 2))):
            if nt.beat >= 2 * h + 1:  # a pickup
                continue
            o = min(2 * h + 2, nt.beat + nt.beats) - max(2 * h, nt.beat)
            w[h, pc] += max(o, 0.0) * (2.0 if abs(nt.beat - 2 * h) < 0.125 else 1.0)
    return [int(np.argmax(r)) if r.max() >= 0.5 else None for r in w]


def _bass_rooted(bars: list[BarChord], score: np.ndarray, states: list, roots: list[int | None]) -> list[BarChord]:
    """The bars re-rooted on the bass per half-bar, each root's quality the one the melodic stems score best over
    that half-bar's beats; a half-bar with no bass keeps the chroma's chord."""
    qs = list(QUALITIES)
    out = []
    for i, c in enumerate(bars):
        half = []
        for h in (2 * i, 2 * i + 1):
            r = roots[h] if h < len(roots) else None
            if r is None or 2 * h + 2 > len(score):
                half.append((c.root, c.quality, c.confidence))
                continue
            sc = score[2 * h : 2 * h + 2, [states.index((r, q)) for q in qs]].mean(axis=0)
            half.append((r, qs[int(np.argmax(sc))], float(np.clip((sc.max() - N_FLOOR) / (1 - N_FLOOR), 0, 1))))
        (r1, q1, c1), (r2, q2, _) = half
        two = r2 is not None and (r2, q2) != (r1, q1)
        out.append(BarChord(r1, q1, round(c1, 3), r2 if two else None, q2 if two else None))
    return out
