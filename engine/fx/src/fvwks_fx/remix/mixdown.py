"""1.6 REMIX: MIXDOWN. The arrangement's prepared clips summed to the finished track, so the export is exactly what the
app plays (the same clips, placements, lane gains, mutes and solos).

mixdown(remix, audio, sr, master=Master()) -> ((2, n) float32 at master.sample_rate, LoudnessReport):
  every clip (`audio`: clip id → prepare_clip's audio) at its at_beat on the remix grid, lane gain, mute and solo; a
  mashup's B sections brought to the loudness of A's sections of the same kind (within ±6 dB, 10 ms ramps); then
  master.master (club / bake / custom, true-peak ceiling), the sub in mono below 120 Hz. n = the sections' bars exactly.
"""

from __future__ import annotations

import numpy as np

from fvwks_contracts.models import Master, Remix

from scipy import ndimage, signal

from ..master import LoudnessReport, integrated_lufs, master, output_samples, short_term_loudness, short_term_max, true_peak

RAMP_S = 0.01
OTHER_LU = -8.0  # intros, verses and breakdowns under the drops' mean (Sound Bible 1.5: 8-10 LU)
BUILD_LU = -5.0  # what leads into a drop, its last 4 bars under the drop (Sound Bible 1.5: builds 4-6 LU)
FIRST_BASS_DB = 3.0  # the bass buses' first beat over their loudest other beat (plan I3: >= +1.5 on the stems)
FIRST_DB = 5.0  # the drop's first beat over its loudest other beat, before the clipper (QA: +0.5 after it)
MID_CREST_DB = 8.0  # the drop's mid bus crest, 150 Hz-4 kHz (Sound Bible 5: 6-10 dB, <= 8 tearout / riddim)
MID_LIMIT_DB = 3.0  # the most the mid bus limiter takes off its peaks (the Bible's 1-3 dB on the bus: the originals'
# own bass stems run 15-23 dB crest over a drop, so the 6-10 target is uncalibrated; more squash only made clicks)
REV_BEATS = 0.25  # the reverse swell's longest rise into a gap (plan AX-02 <= 1/4 beat; the gap's first half silent)


def mixdown(remix: Remix, audio: dict[str, np.ndarray], sr: int, cfg: Master | None = None,
            buses: dict[str, np.ndarray] | None = None) -> tuple[np.ndarray, LoudnessReport]:
    """`buses`, when given, is filled with the pre-master sub, mid and drums buses (the audition's stems)."""
    cfg = cfg or Master()
    bars = sum(s.bars for s in remix.sections)
    n = int(round(bars * 4 * 60.0 / remix.bpm * sr))
    solo = any(lane.solo for lane in remix.lanes)
    bufs: list[tuple] = []
    for lane in remix.lanes:
        if lane.mute or (solo and not lane.solo):
            continue
        g = np.float32(10 ** (lane.gain_db / 20))
        buf = np.zeros((2, n), np.float32)
        for c in lane.clips:
            x = audio.get(c.id)
            if x is None:
                raise ValueError(f"clip {c.id} isn't prepared")
            a = int(round(c.at_beat * 60.0 / remix.bpm * sr))
            m = min(x.shape[1], n - a)
            if m > 0:
                buf[:, a : a + m] += g * x[:, :m]
        bufs.append((lane, buf))
    y = _drop_mix(remix, bufs, sr, n, buses)
    _match_b(remix, y, sr)
    if cfg.mode == "club":  # the loudness from a smooth clipper, all of it: the master's gain stays ~0 (the last 0.5 LU
        # through its limiter took ~3 dB of gain: the drop limited, everything quieter raised the whole 3 dB)
        bar = 240.0 / remix.bpm * sr
        spans = [(int((d.start_bar - 1) * bar), int((d.start_bar - 1 + d.bars) * bar)) for d in remix.sections if d.kind == "drop"]
        _level_drops(y, sr, spans, int(bar))
        y = loud(y, sr, cfg.target_lufs, cfg.true_peak_db, spans or None)
    _contrast(remix, y, sr)
    out, report = master(y, sr, mode=cfg.mode, target_lufs=cfg.target_lufs, ceiling_dbtp=cfg.true_peak_db,
                         bake_peak_dbfs=cfg.bake_peak_db, sr_out=cfg.sample_rate,
                         n_out=output_samples(bars, remix.bpm, cfg.sample_rate), channels=cfg.channels, mono_below_hz=120.0)
    return out, report


def _match_b(remix: Remix, y: np.ndarray, sr: int) -> None:
    """A mashup's B sections at the loudness of A's sections of the same kind (in place)."""
    span = lambda s: (int(round((s.start_bar - 1) * 4 * 60.0 / remix.bpm * sr)),
                      int(round((s.start_bar - 1 + s.bars) * 4 * 60.0 / remix.bpm * sr)))
    lufs = {id(s): integrated_lufs(y[:, slice(*span(s))], sr) for s in remix.sections}
    for s in remix.sections:
        if s.from_slot != "B":
            continue
        ref = [lufs[id(t)] for t in remix.sections if t.from_slot == "A" and t.kind == s.kind and lufs[id(t)] > -70]
        if not ref or lufs[id(s)] <= -70:
            continue
        a, b = span(s)
        env = np.full(b - a, 10 ** (np.clip(np.mean(ref) - lufs[id(s)], -6, 6) / 20), np.float32)
        r = min(int(RAMP_S * sr), (b - a) // 2)
        env[:r] = np.linspace(1, env[r], r)
        env[b - a - r :] = np.linspace(env[r], 1, r)
        y[:, a:b] *= env


def _contrast(remix: Remix, y: np.ndarray, sr: int) -> None:
    """Section contrast (Sound Bible 1.5), only ever turning down: what leads into a drop BUILD_LU under it (its last 4
    bars' short-term mean vs the drop's), every other non-drop section OTHER_LU under the drops' mean, so no breakdown
    outshouts a drop (the club master normalises the loudest moment). Levels ease over a section's first bar, but a
    drop lands at full level out of its gap. In place, after the clipper (which squeezes the drops' contrast)."""
    bar = int(round(240.0 / remix.bpm * sr))
    st = lambda x: float(np.mean(short_term_loudness(x, sr)))  # noqa: E731
    secs = remix.sections
    span = lambda s: ((s.start_bar - 1) * bar, min(y.shape[1], (s.start_bar - 1 + s.bars) * bar))  # noqa: E731
    drop_db = {id(s): st(y[:, slice(*span(s))]) for s in secs if s.kind == "drop"}
    if not drop_db:
        return
    ref = float(np.mean(list(drop_db.values())))
    curve = np.ones(y.shape[1], np.float32)
    prev = 1.0
    for k, s in enumerate(secs):
        a, b = span(s)
        if b <= a:
            continue
        nxt = secs[k + 1] if k + 1 < len(secs) else None
        if s.kind == "drop":
            g = 1.0
        elif nxt is not None and nxt.kind == "drop":
            g = 10 ** (min(0.0, drop_db[id(nxt)] + BUILD_LU - st(y[:, max(a, b - 4 * bar) : b])) / 20)
        else:
            g = 10 ** (min(0.0, ref + OTHER_LU - st(y[:, a:b])) / 20)
        curve[a:b] = g
        if s.kind != "drop":
            r = min(bar, b - a)
            curve[a : a + r] = np.linspace(prev, g, r)
        prev = g
    y *= curve


def _level_drops(y: np.ndarray, sr: int, spans: list[tuple[int, int]], bar: int) -> None:
    """Every drop as loud (short-term max) as the loudest (only up, at most +6 dB), easing back over the bar after it,
    so the clipper's target (the loudest drop) holds for each; a drop lands out of its gap, so it starts at level."""
    lv = [short_term_max(y[:, a:b], sr) for a, b in spans]
    top = max(lv, default=0.0)
    for (a, b), v in zip(spans, lv):
        g = 10 ** (min(6.0, top - v) / 20)
        if g > 1.0001:
            y[:, a:b] *= np.float32(g)
            e = min(y.shape[1], b + bar)
            y[:, b:e] *= np.linspace(g, 1, e - b, dtype=np.float32)


def loud(x: np.ndarray, sr: int, target_st_lufs: float, ceiling_db: float,
         spans: list[tuple[int, int]] | None = None) -> np.ndarray:
    """To `target_st_lufs` (short-term max) under `ceiling_db`: a gain (found by bisection) into a smooth look-ahead
    limiter (15 ms either side, its gain eased over 30 ms) that brings every peak to 1.2x the clip level, then a tanh
    clipper for the last ~3 dB (Sound Bible 1.5: soft clip 1-3 dB; the search 2x oversampled, the final pass 4x). A
    clipper doing it all took 6-8 dB off a sparse drop and turned its transients into clicks; a limiter's gain moving
    within a sample ticks.
    `spans` (sample ranges, the drops): the target is their loudness, not the loudest moment anywhere."""
    x = np.asarray(x, np.float32)
    c = 10 ** ((ceiling_db - 0.3) / 20)
    la = int(0.015 * sr)
    env = ndimage.maximum_filter1d(np.abs(x).max(axis=0), 2 * la + 1)

    def run(z: np.ndarray, e: np.ndarray, g_db: float, os: int = 2) -> np.ndarray:
        g = 10 ** (g_db / 20)
        lim = ndimage.uniform_filter1d(np.minimum(1.0, 1.2 * c / np.maximum(e * g, 1e-12)), 2 * la + 1)
        up = signal.resample_poly((z * (g * lim)).astype(np.float64), os, 1, axis=-1)
        return signal.resample_poly(c * np.tanh(up / c), 1, os, axis=-1)[:, : z.shape[1]].astype(np.float32)

    # the search runs on the measured spans only, each padded 50 ms (the look-ahead, the gain's ease, the resampler's
    # taps), measured inside the padding; then one full-length pass (S3's M2.5 profile: 14 whole-song passes were 16 s)
    pad = int(0.05 * sr)
    cuts = [(max(0, a - pad), min(x.shape[1], b + pad), a, b) for a, b in (spans or [(0, x.shape[1])])]
    lo, hi = -40.0, 40.0
    for _ in range(14):
        mid = 0.5 * (lo + hi)
        lv = max(short_term_max(run(x[:, s0:s1], env[s0:s1], mid)[:, a - s0 : b - s0], sr) for s0, s1, a, b in cuts)
        if lv < target_st_lufs:
            lo = mid
        else:
            hi = mid
    y = run(x, env, hi, os=4)  # the one pass that's heard: 4x oversampled, like every nonlinear stage (SB fault #1)
    tp = true_peak(y, sr)
    return (y * np.float32(10 ** ((ceiling_db - tp) / 20))) if tp > ceiling_db else y


KICK_FIRST = 1 / 16  # a kick this close to a drop's downbeat is its first hit: no duck on it (Sound Bible 1.7)


def _duck(times: list[float], bpm: float, sr: int, n: int, depth_db: float, attack_s: float, hold_s: float,
          release_s: float) -> np.ndarray:
    """A sidechain as a volume envelope (we know every hit): down `depth_db` over `attack_s` into each hit (a
    look-ahead), held `hold_s`, back up exponentially over `release_s`."""
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


def _impact(sr: int, beat_s: float, seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """The drop's impact stack (Sound Bible 1.7): a boom (sine 40 + 60 e^(-t/0.06) Hz, 0.35 s decay) with a crash from
    the downbeat; and the crash itself (for the reverse into it). Mono."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(0.9 * sr)) / sr
    boom = np.sin(2 * np.pi * np.cumsum(40 + 60 * np.exp(-t / 0.06)) / sr) * np.exp(-t / 0.35)
    tc = np.arange(int(2.5 * sr)) / sr
    crash = signal.sosfilt(signal.butter(2, 4000, "high", fs=sr, output="sos"), rng.standard_normal(tc.size))
    crash = crash / np.abs(crash).max() * np.exp(-tc / 0.9) * np.minimum(1, tc / 0.001)
    down = np.zeros(max(boom.size, crash.size))
    down[: boom.size] += boom
    down[: crash.size] += 0.35 * crash
    return down.astype(np.float32), crash.astype(np.float32)


def _drop_mix(remix: Remix, bufs: list[tuple], sr: int, n: int, buses: dict[str, np.ndarray] | None = None) -> np.ndarray:
    """The lanes summed with the drop rules (Sound Bible 1.4 / 1.7): every bass lane split at 120 Hz and ducked by
    envelopes at the kicks (the sub -10 dB, the source's 808 only -2.5) and the mid at kicks (-6) and snares (-4),
    a designed bass's mid also cleared around each snare (a 1/16 window); no duck on a drop's first kick, the bass +1.5
    dB over its first beat; the impact stack on every drop's downbeat (the take's gap.fill: a reverse cymbal rising into
    the gap, never into its first half beat); and the drop's first beat FIRST_DB over its loudest other beat."""
    from fvwks_contracts.models import SongAnalysis

    from .flip import drum_hits
    from .styles import choice
    try:  # S3's OTT (the Faust model's; plan C13: the one OTT), else this package's
        from fvwks_synth.midbus import ott
    except ImportError:
        from .resample import ott

    bpm = remix.bpm
    beat_s = 60.0 / bpm
    y = np.zeros((2, n), np.float32)
    drum = sum((b for l, b in bufs if l.role in ("drums", "kit")), np.zeros((2, n), np.float32))
    hits = drum_hits(drum, sr, SongAnalysis(bpm=bpm, downbeat_s=0.0)) if np.abs(drum).max() > 1e-6 else []
    drops = [(s.start_bar - 1) * 4.0 for s in remix.sections if s.kind == "drop"]
    kicks = [h.beat for h in hits if h.kind == "kick" and h.vel >= 0.3]
    snares = [h.beat for h in hits if h.kind == "snare" and h.vel >= 0.3]
    ducked = [k for k in kicks if not any(abs(k - d) <= KICK_FIRST for d in drops)]
    lr4 = lambda x, kind: signal.sosfilt(signal.butter(2, 120, kind, fs=sr, output="sos"),
                                         signal.sosfilt(signal.butter(2, 120, kind, fs=sr, output="sos"), x, axis=-1), axis=-1)
    first = np.ones(n, np.float32)
    beat_n = int(beat_s * sr)
    for d in drops:
        a = int(d * beat_s * sr)
        first[a : a + beat_n] = 10 ** (1.5 / 20)
        r = beat_n // 8
        first[a + beat_n - r : a + beat_n] = np.linspace(10 ** (1.5 / 20), 1, len(first[a + beat_n - r : a + beat_n]))
    sub_bus, mid_bus = np.zeros((2, n), np.float32), np.zeros((2, n), np.float32)
    top = np.zeros((2, n), np.float32)  # the non-vocal rest (the source's melodics, the impact): the stems' "top"
    for lane, buf in bufs:
        if lane.role not in ("bass", "synth_bass"):
            y += buf
            if lane.role not in ("drums", "kit", "vocals"):
                top += buf
            continue
        low = lr4(buf, "low")
        low_depth = -2.5 if lane.role == "bass" else -10.0  # the source's 808 plays with the kick; a sub makes room
        sub_bus += (low * _duck(ducked, bpm, sr, n, low_depth, 0.002, 0.02, 0.13) * first).astype(np.float32)
        mid_bus += lr4(buf, "high").astype(np.float32)
    spans = [(int(d * beat_s * sr), min(n, int((d + 4 * s.bars) * beat_s * sr)))
             for d, s in zip(drops, (s for s in remix.sections if s.kind == "drop"))]
    for a, b in spans:  # the drop's mid bus denser, not louder (Sound Bible 1.2): OTT on the bus
        mid_bus[:, a:b] = _level(ott(mid_bus[:, a:b], sr, 0.5), mid_bus[:, a:b])
    # the ducks with a 3 ms look-ahead (the Bible's 0.5 ms drops a loud growl 6 dB in 24 samples: a click)
    mid_bus *= _duck(ducked, bpm, sr, n, -6.0, 0.003, 0.0, 0.1) * _duck(snares, bpm, sr, n, -4.0, 0.003, 0.0, 0.1)
    # the chequerboard (Sound Bible 1.4): in a drop, no mid from 1/16 before each snare (the kit's, and step 9 of every
    # bar, where every style's snare sits, a paused bar's too) to 1/16 after it
    spans_b = [(d, d + 4 * s.bars) for d, s in zip(drops, (s for s in remix.sections if s.kind == "drop"))]
    at = {a + 4 * k + 2.0 for a, b in spans_b for k in range(int((b - a) // 4))}
    at |= {round(t, 3) for t in snares if any(a <= t < b for a, b in spans_b) and min(abs(t - u) for u in at) > 0.25}
    mid_bus *= _duck([t - 0.25 for t in sorted(at)], bpm, sr, n, -60.0, 0.01, beat_s / 2, 0.06)
    for a, b in spans:  # then limited to the Bible's crest (<= 8 dB, 150 Hz-4 kHz), level-matched
        mid_bus[:, a:b] = _level(_crest_limit(mid_bus[:, a:b], sr, MID_CREST_DB), mid_bus[:, a:b])
    mid_bus *= first
    if drops:  # the bass buses' own first hit (plan I3, graded on the stems): the sub carries it, the mid's crest kept
        _first_hit(sub_bus, drops, remix, beat_n, sr, FIRST_BASS_DB, measure=sub_bus + mid_bus)
    y += sub_bus + mid_bus
    if buses is not None:
        buses.update(sub=sub_bus, mid=mid_bus, drums=drum, top=top, snare_beats=np.array(sorted(at), float))
    if drops:
        peak = max(float(np.abs(y).max()), 1e-6)
        down, crash = _impact(sr, beat_s, int(remix.seed))
        live = np.abs(y).max(axis=0) > 1e-4  # before the impacts: what's sounding
        reverse = choice(remix, "drop.gap_fill") == "reverse"  # the take's AX-02
        fx = np.zeros((2, n), np.float32)
        for d in drops:
            a = int(d * beat_s * sr)
            m = min(down.size, n - a)
            if m > 0:
                fx[:, a : a + m] += 0.3 * peak * down[:m]
            on = np.flatnonzero(live[max(0, a - 2 * beat_n) : a])
            quiet = (a - max(0, a - 2 * beat_n) - on[-1] - 1) if on.size else min(a, 2 * beat_n)
            r = min(int(REV_BEATS * beat_n), quiet - beat_n // 2 - int(0.01 * sr))  # 1/2 beat (+10 ms) stays silent
            if reverse and r > beat_n // 10:  # the crash reversed, rising to end exactly on the downbeat
                fx[:, a - r : a] += 0.3 * peak * crash[:r][::-1] * np.linspace(0, 1, r, dtype=np.float32) ** 2
        y += fx
        top += fx
        _first_hit(y, drops, remix, beat_n, sr, FIRST_DB)
    return y


def _level(y: np.ndarray, ref: np.ndarray) -> np.ndarray:
    """`y` at `ref`'s RMS."""
    r = float(np.sqrt(np.mean(np.square(ref, dtype=np.float64))))
    g = r / max(float(np.sqrt(np.mean(np.square(y, dtype=np.float64)))), 1e-12)
    return (y * g).astype(np.float32) if r > 1e-9 else y


def _crest_limit(x: np.ndarray, sr: int, crest_db: float) -> np.ndarray:
    """A look-ahead peak limiter, its threshold found by bisection so the 150 Hz-4 kHz crest (peak over RMS) is at most
    `crest_db`. Its gain moves over 5 ms (a peak's whole neighbourhood, never a single sample), so it thins the peaks
    without the HF a clipper makes of a growl's sharp onset (a click)."""
    band = lambda z: signal.sosfiltfilt(signal.butter(4, (150, 4000), "band", fs=sr, output="sos"), z, axis=-1).mean(axis=0)  # noqa: E731
    crest = lambda z: 20 * np.log10(np.abs(z).max() + 1e-12) - 10 * np.log10(np.mean(z ** 2) + 1e-24)  # noqa: E731
    if crest(band(x)) <= crest_db:
        return x
    la = max(1, int(0.005 * sr))
    env = ndimage.maximum_filter1d(np.abs(x).max(axis=0), 2 * la + 1)  # every peak within 5 ms either side
    peak = max(float(env.max()), 1e-9)

    def run(thr_db: float) -> np.ndarray:
        g = np.minimum(1.0, peak * 10 ** (thr_db / 20) / np.maximum(env, 1e-12))
        g = ndimage.uniform_filter1d(ndimage.minimum_filter1d(g, la), la)  # held, then ramped over 5 ms
        return (x * g).astype(np.float32)

    lo, hi = -MID_LIMIT_DB, 0.0  # the threshold in dB re the peak: at most MID_LIMIT_DB off the peaks
    if crest(band(run(lo))) > crest_db:  # a sparse bus (rests, the chequerboard) can't get there: as far as allowed
        return run(lo)
    for _ in range(8):
        mid = 0.5 * (lo + hi)
        if crest(band(run(mid))) > crest_db:
            hi = mid
        else:
            lo = mid
    return run(lo)


def _first_hit(y: np.ndarray, drops: list[float], remix: Remix, beat_n: int, sr: int, db: float,
               measure: np.ndarray | None = None) -> None:
    """The first hit is the hardest (Sound Bible 1.7): each drop's first beat (its first 100 ms, 30 Hz-4 kHz, as the
    QA reads it, of `measure`, default `y`) brought `db` over the drop's loudest other beat, `y` lifted and easing back
    over the beat's last 1/8 (in place)."""
    band = signal.sosfilt(signal.butter(2, (30, 4000), "band", fs=sr, output="sos"), (y if measure is None else measure).mean(axis=0))
    w = int(0.1 * sr)
    rms = lambda i: 10 * np.log10(np.mean(band[i : i + w] ** 2) + 1e-20)  # noqa: E731
    for d in drops:
        a = int(d * beat_n)
        sec = next(s for s in remix.sections if (s.start_bar - 1) * 4.0 == d)
        others = [rms(a + k * beat_n) for k in range(1, int(sec.bars * 4)) if a + k * beat_n + w <= band.size]
        need = db - (rms(a) - max(others)) if others else 0.0
        if need > 0:
            g = np.full(beat_n, 10 ** (min(need, 9.0) / 20), np.float32)
            r = beat_n // 8
            g[-r:] = np.linspace(g[0], 1, r)
            y[:, a : a + beat_n] *= g[: y.shape[1] - a]
