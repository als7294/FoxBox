"""1.6 REMIX: the drop rules on each bass clip (plan M1.14, "what you hear is what you export"). The app, the export
and the audition all play prepared clips, so a bass clip is prepared with its sidechains, the snare window and its
first hit already in it (Sound Bible 1.2 / 1.4 / 1.7), not given them only in the mixdown. The kick and snare times
come from the doc (kit clips' hits; under a drum-stem clip, the source's own hits, flip.drum_hits read once per song),
so they're known before any audio is mixed, and clip_key covers them (C14).

drum_times(remix, sources) -> (kicks, snares)       remix beats (vel >= 0.3)
gate_beats(remix, snares) -> [beat]                 the snare window's centres: step 9 of every drop bar, and every
                                                    snare in a drop more than 1/16 from one
bass_rules(y, clip, role, remix, sources, sr) -> y  a bass-lane clip (the source's 808 "bass", an engine "synth_bass")
                                                    split at 120 Hz (LR4): the sub ducked at the kicks (the 808 only
                                                    -2.5 dB, it plays with the kick), the mid through OTT in the drops,
                                                    ducked at kicks (-6) and snares (-4), gated around every snare in a
                                                    drop (the chequerboard) and limited to its crest; no duck on a
                                                    drop's first kick, +1.5 dB over its first beat; the drop's first-hit
                                                    carrier (carries_first) lifts its sub FIRST_BASS_DB over the whole
                                                    bass bus's loudest other beat (plan I3; `others`: run's 2nd pass)
"""

from __future__ import annotations

from collections import Counter

import numpy as np
from scipy import ndimage, signal

from fvwks_contracts.models import Remix, RemixClip, SongAnalysis

KICK_FIRST = 1 / 16  # a kick this close to a drop's downbeat is its first hit: no duck on it (Sound Bible 1.7)
FIRST_BASS_DB = 3.0  # the bass's first beat over its loudest other beat in the drop (plan I3: >= +1.5 on the stems)
MID_CREST_DB = 8.0  # the drop's mid bus crest, 150 Hz-4 kHz (Sound Bible 5)
MID_LIMIT_DB = 3.0  # the most the mid limiter takes off its peaks (the Bible's 1-3 dB on the bus: the originals'
# own bass stems run 15-23 dB crest, so more squash only made clicks)
_HITS: dict[tuple[int, int], list] = {}  # ponytail: in-process, per drum stem (id, length)


def _song_hits(s) -> list:
    from .flip import drum_hits

    key = (id(s.stems["drums"]), s.stems["drums"].shape[-1])
    if key not in _HITS:
        _HITS[key] = drum_hits(s.stems["drums"], s.sr, SongAnalysis(bpm=s.bpm, downbeat_s=s.downbeat_s))
    return _HITS[key]


def drum_times(remix: Remix, sources: dict | None) -> tuple[list[float], list[float]]:
    from .flip import FLIP_STYLES

    kicks, snares = [], []
    for lane in remix.lanes:
        if lane.role not in ("drums", "kit") or lane.id == "kit-fx":
            continue
        for c in lane.clips:
            src = c.src
            if src.kind == "kit":
                hits = [(h.beat, h.voice, h.vel) for h in src.hits]
                if not hits and src.pattern_id in FLIP_STYLES:  # a library loop, bar after bar
                    hits = [(4 * i + b, k, v) for i in range(int(np.ceil(c.beats / 4))) for b, k, v in FLIP_STYLES[src.pattern_id]["hits"]]
            elif src.kind == "stem" and src.stem == "drums" and sources and src.slot in sources:
                hits = [(h.beat - src.start_beat, h.kind, h.vel) for h in _song_hits(sources[src.slot])]
            else:
                continue
            for b, voice, vel in hits:
                if 0 <= b < c.beats and vel >= 0.3:
                    (kicks if voice == "kick" else snares if voice in ("snare", "clap") else []).append(c.at_beat + b)
    return sorted(kicks), sorted(snares)


def _drops(remix: Remix) -> list[tuple[float, float]]:
    return [((s.start_bar - 1) * 4.0, (s.start_bar - 1 + s.bars) * 4.0) for s in remix.sections if s.kind == "drop"]


def gate_beats(remix: Remix, snares: list[float]) -> list[float]:
    """The drops' snare windows: beat 3 of every drop bar, and a found snare / clap only where its 1/16 recurs in
    >= 3/4 of that drop's bars (the pattern's own snare; ncs-01's claps and percs landed 6 a bar and carved the held
    bass out under each)."""
    spans = _drops(remix)
    at = {a + 4 * k + 2.0 for a, b in spans for k in range(int((b - a) // 4))}
    slot = lambda t, a: round(((t - a) % 4) * 4) / 4 % 4  # noqa: E731
    for a, b in spans:
        inside = [t for t in snares if a <= t < b]
        n = Counter(slot(t, a) for t in inside)
        at |= {round(t, 3) for t in inside if n[slot(t, a)] >= 0.75 * int((b - a) // 4)
               and min((abs(t - u) for u in at), default=1) > 0.25}
    return sorted(at)


def duck(times: list[float], bpm: float, sr: int, n: int, depth_db: float, attack_s: float, hold_s: float,
         release_s: float) -> np.ndarray:
    """A sidechain as a volume envelope (we know every hit): down `depth_db` over `attack_s` into each hit (a
    look-ahead), held `hold_s`, back up exponentially over `release_s`. Times in beats from the buffer's start."""
    g = np.ones(n, np.float32)
    floor = 10 ** (depth_db / 20)
    att, hold, rel = max(1, int(attack_s * sr)), int(hold_s * sr), max(1, int(release_s * sr))
    curve = np.r_[np.linspace(1, floor, att), np.full(hold, floor),
                  1 - (1 - floor) * np.exp(-np.arange(rel) / (rel / 5))].astype(np.float32)
    for t in times:
        a = int(t * 60.0 / bpm * sr) - att
        lo, hi = max(0, a), min(n, a + curve.size)
        if hi > lo:
            g[lo:hi] = np.minimum(g[lo:hi], curve[lo - a : hi - a])
    return g


def level(y: np.ndarray, ref: np.ndarray) -> np.ndarray:
    """`y` at `ref`'s RMS."""
    r = float(np.sqrt(np.mean(np.square(ref, dtype=np.float64))))
    g = r / max(float(np.sqrt(np.mean(np.square(y, dtype=np.float64)))), 1e-12)
    return (y * g).astype(np.float32) if r > 1e-9 else y


def crest_limit(x: np.ndarray, sr: int, crest_db: float) -> np.ndarray:
    """A look-ahead peak limiter, its threshold found by bisection so the 150 Hz-4 kHz crest (peak over RMS) is at most
    `crest_db`, taking at most MID_LIMIT_DB off. Its gain moves over 5 ms (a peak's whole neighbourhood, never a single
    sample), so it thins the peaks without the HF a clipper makes of a growl's sharp onset (a click)."""
    if x.shape[-1] < sr // 10:
        return x
    band = lambda z: signal.sosfiltfilt(signal.butter(4, (150, 4000), "band", fs=sr, output="sos"), z, axis=-1).mean(axis=0)  # noqa: E731
    crest = lambda z: 20 * np.log10(np.abs(z).max() + 1e-12) - 10 * np.log10(np.mean(z ** 2) + 1e-24)  # noqa: E731
    if crest(band(x)) <= crest_db:
        return x
    la = max(1, int(0.005 * sr))
    env = ndimage.maximum_filter1d(np.abs(x).max(axis=0), 2 * la + 1)
    peak = max(float(env.max()), 1e-9)

    def run(thr_db: float) -> np.ndarray:
        g = np.minimum(1.0, peak * 10 ** (thr_db / 20) / np.maximum(env, 1e-12))
        g = ndimage.uniform_filter1d(ndimage.minimum_filter1d(g, la), la)  # held, then ramped over 5 ms
        return (x * g).astype(np.float32)

    lo, hi = -MID_LIMIT_DB, 0.0
    if crest(band(run(lo))) > crest_db:  # a sparse bus (rests, the chequerboard) can't get there: as far as allowed
        return run(lo)
    for _ in range(8):
        mid = 0.5 * (lo + hi)
        if crest(band(run(mid))) > crest_db:
            hi = mid
        else:
            lo = mid
    return run(lo)


def lift_first(y: np.ndarray, measure: np.ndarray, starts: list[tuple[int, int]], beat_n: int, sr: int, db: float) -> None:
    """The first hit is the hardest (Sound Bible 1.7): each (drop start, drop end) in samples, the drop's first beat (its
    first 100 ms, 30 Hz-4 kHz, as the QA reads it, of `measure`) brought `db` over its loudest other beat: `y` lifted,
    easing back over the beat's last 1/8 (in place)."""
    band = signal.sosfilt(signal.butter(2, (30, 4000), "band", fs=sr, output="sos"), measure.mean(axis=0))
    w = int(0.1 * sr)
    rms = lambda i: 10 * np.log10(np.mean(band[i : i + w] ** 2) + 1e-20)  # noqa: E731
    for a, b in starts:
        if a < 0 or a + w > band.size:
            continue
        others = [rms(i) for i in range(a + beat_n, min(b, band.size - w), beat_n)]
        need = db - (rms(a) - max(others)) if others else 0.0
        if need > 0:
            g = np.full(beat_n, 10 ** (min(need, 9.0) / 20), np.float32)
            r = beat_n // 8
            g[-r:] = np.linspace(g[0], 1, r)
            y[:, a : a + beat_n] *= g[: max(0, min(beat_n, y.shape[1] - a))]


def _drive(x: np.ndarray, drive_db: float) -> np.ndarray:
    up = signal.resample_poly(x.astype(np.float64), 4, 1, axis=-1)
    pk = max(float(np.abs(up).max()), 1e-9)
    return signal.resample_poly(np.tanh(10 ** (drive_db / 20) * up / pk) * pk, 1, 4, axis=-1)[:, : x.shape[1]].astype(np.float32)


def _wobble(x: np.ndarray, sr: int, bpm: float, depth: float) -> np.ndarray:
    """A 1/8-note filter movement: the mid crossfaded toward its 400 Hz low-pass as a cosine LFO closes (open on the
    clip's downbeats), `depth` 0-1."""
    t = np.arange(x.shape[1]) / sr
    shut = depth * (0.5 - 0.5 * np.cos(2 * np.pi * (2 * bpm / 60.0) * t))
    lp = signal.sosfilt(signal.butter(2, 400, fs=sr, output="sos"), x, axis=-1)
    return (x + shut * (lp - x)).astype(np.float32)


def _lr4(x: np.ndarray, sr: int, kind: str) -> np.ndarray:
    sos = signal.butter(2, 120, kind, fs=sr, output="sos")
    return signal.sosfilt(sos, signal.sosfilt(sos, x, axis=-1), axis=-1)


def carries_first(clip: RemixClip, remix: Remix) -> bool:
    """Does this clip carry its drop's first hit (the one bass clip that lifts it): a synth_bass clip starting on a drop's
    downbeat, the first-hit lane's (808:dark) where there is one."""
    lane = next((lane for lane in remix.lanes if any(c.id == clip.id for c in lane.clips)), None)
    if lane is None or lane.role != "synth_bass" or not any(abs(clip.at_beat - d) < 1e-6 for d, _ in _drops(remix)):
        return False
    if lane.id.startswith("first_hit"):
        return True
    return not any(abs(c.at_beat - clip.at_beat) < 1e-6 for l in remix.lanes if l.id.startswith("first_hit") for c in l.clips)


def bass_rules(y: np.ndarray, clip: RemixClip, role: str, remix: Remix, sources: dict | None, sr: int,
               others: np.ndarray | None = None) -> np.ndarray:
    """See the module doc. `others`: the drop's other bass lanes summed from its downbeat (prepared audio, run's second
    pass), which a first-hit carrier measures its lift against: the bass bus, as the ear (and the QA) hears it."""
    try:  # S3's OTT (the Faust model's; plan C13: the one OTT), else this package's
        from fvwks_synth.midbus import ott
    except ImportError:
        from .resample import ott

    n = y.shape[1]
    bpm, a0 = remix.bpm, clip.at_beat
    beat_n = int(60.0 / bpm * sr)
    at = lambda b: int(round((b - a0) * 60.0 / bpm * sr))  # noqa: E731  a remix beat's sample in this clip
    kicks, snares = drum_times(remix, sources)
    drops = _drops(remix)
    near = lambda ts: [t - a0 for t in ts if -2 <= t - a0 <= clip.beats + 2]  # noqa: E731
    ducked = near([k for k in kicks if not any(abs(k - d) <= KICK_FIRST for d, _ in drops)])
    first = np.ones(n, np.float32)
    for d, _ in drops:
        a, r = at(d), beat_n // 8
        if -beat_n < a < n:
            env = np.full(beat_n, 10 ** (1.5 / 20), np.float32)
            env[-r:] = np.linspace(env[0], 1, r)
            lo = max(0, a)
            first[lo : min(n, a + beat_n)] = env[lo - a : min(n, a + beat_n) - a]
    m = remix.bass_macros if role == "synth_bass" and remix.bass_macros is not None else None  # the engine bass's knobs
    grit, wobble, sub = (m.grit, m.wobble, m.sub) if m else (0.5, 0.5, 0.5)
    low, mid = _lr4(y, sr, "low"), _lr4(y, sr, "high")
    low *= duck(ducked, bpm, sr, n, -2.5 if role == "bass" else -10.0, 0.002, 0.02, 0.13) * first
    low *= np.float32(10 ** ((sub - 0.5) * 12 / 20))  # SUB: +-6 dB
    if grit > 0.5:  # GRIT: a drive stage on the mid (up to 12 dB), 4x oversampled, level-matched
        mid = level(_drive(mid, 24.0 * (grit - 0.5)), mid)
    if wobble > 0.5:  # WOBBLE: a 1/8-note filter movement over the mid (the voices' own below 0.5, AX by patch)
        mid = _wobble(mid, sr, bpm, 2.0 * (wobble - 0.5))
    spans = [(max(0, at(d)), min(n, at(e))) for d, e in drops if at(e) > 0 and at(d) < n]
    for a, b in spans:  # the drop's mid denser, not louder (Sound Bible 1.2): OTT, GRIT sets its depth
        mid[:, a:b] = level(ott(mid[:, a:b], sr, 0.2 + 0.6 * grit), mid[:, a:b])
    # the ducks with a 3 ms look-ahead (the Bible's 0.5 ms drops a loud growl 6 dB in 24 samples: a click)
    mid *= duck(ducked, bpm, sr, n, -6.0, 0.003, 0.0, 0.1) * duck(near(snares), bpm, sr, n, -4.0, 0.003, 0.0, 0.1)
    # the chequerboard (Sound Bible 1.4): in a drop, no mid from 1/16 before each snare to 1/16 after it
    mid *= duck([t - 0.25 for t in near(gate_beats(remix, snares))], bpm, sr, n, -60.0, 0.01, 60.0 / bpm / 2, 0.06)
    for a, b in spans:  # limited to the Bible's crest, level-matched
        mid[:, a:b] = level(crest_limit(mid[:, a:b], sr, MID_CREST_DB), mid[:, a:b])
    mid *= first
    if carries_first(clip, remix):  # the drop's first hit, FIRST_BASS_DB over the whole bass bus's loudest other beat
        d, e = next((d, e) for d, e in drops if abs(d - a0) < 1e-6)
        bus = np.zeros((2, max(n, at(e))), np.float32)
        if others is not None:
            bus[:, : min(bus.shape[1], others.shape[1])] += others[:, : bus.shape[1]]
        bus[:, :n] += low + mid
        lift_first(low, bus, [(0, at(e))], beat_n, sr, FIRST_BASS_DB)
    if role == "synth_bass":  # 5.2: bar 9 a second first hit, FIRST_BASS_DB - 1 over bars 9-16 (the clip's own)
        bar9 = [(at(d + 32.0), at(e)) for d, e in drops if e - d >= 48 and 0 <= at(d + 32.0) < n]
        lift_first(low, low + mid, bar9, beat_n, sr, FIRST_BASS_DB - 1.0)
    return (low + mid).astype(np.float32)
