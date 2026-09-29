"""1.6 REMIX: MIXDOWN. The arrangement's prepared clips summed to the finished track, so the export is exactly what the
app plays (the same clips, placements, lane gains, mutes and solos).

mixdown(remix, audio, sr, master=Master()) -> ((2, n) float32 at master.sample_rate, LoudnessReport):
  every clip (`audio`: clip id → prepare_clip's audio, the drop rules already in its bass clips and the impact on its
  kit-fx lane, M1.14) at its at_beat on the remix grid, lane gain, mute and solo; a mashup's B sections brought to the
  loudness of A's sections of the same kind (within ±6 dB, 10 ms ramps); in club mode the drops levelled, loud() and
  the section contrast; then master.master (club / bake / custom, true-peak ceiling), the sub in mono below 120 Hz.
  n = the sections' bars exactly.
"""

from __future__ import annotations

import numpy as np

from fvwks_contracts.models import Master, Remix

from scipy import ndimage, signal

from ..master import LoudnessReport, integrated_lufs, master, output_samples, short_term_loudness, short_term_max, true_peak

RAMP_S = 0.01
OTHER_LU = -8.0  # intros, verses and breakdowns under the drops' mean (Sound Bible 1.5: 8-10 LU)
BUILD_LU = -5.0  # what leads into a drop, its last 4 bars under the drop (Sound Bible 1.5: builds 4-6 LU)
DROP_LIFT_DB = 3.0  # the most a drop comes up to the loudest drop after the clipper (the master's limiter takes it)


def mixdown(remix: Remix, audio: dict[str, np.ndarray], sr: int, cfg: Master | None = None,
            buses: dict[str, np.ndarray] | None = None, sources: dict | None = None) -> tuple[np.ndarray, LoudnessReport]:
    """`buses`, when given, is filled with the pre-master stems (the audition's; `sources`, prepare's SourceAudio, for
    the drum-stem hits behind the snare window's centres)."""
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
    y = _drop_mix(remix, bufs, sr, n, buses, sources)
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
    """Section contrast (Sound Bible 1.5): what leads into a drop BUILD_LU under it (its last 4 bars' short-term mean
    vs the drop's), every other non-drop section OTHER_LU under the drops' mean, and nothing's short-term max over the
    loudest drop's: the club master normalises the loudest moment, so anything louder would turn every drop down.
    A drop the clipper squeezed under the loudest comes back up to it (at most DROP_LIFT_DB), so each drop lands on
    the master's target; everything else only ever turns down. Levels ease over a section's first bar, but a drop
    lands at full level out of its gap. In place, after the clipper (which squeezes the drops' contrast)."""
    bar = int(round(240.0 / remix.bpm * sr))
    st = lambda x: float(np.mean(short_term_loudness(x, sr)))  # noqa: E731
    secs = remix.sections
    span = lambda s: ((s.start_bar - 1) * bar, min(y.shape[1], (s.start_bar - 1 + s.bars) * bar))  # noqa: E731
    peak = {id(s): short_term_max(y[:, slice(*span(s))], sr) for s in secs if span(s)[1] > span(s)[0]}
    drops = [s for s in secs if s.kind == "drop" and id(s) in peak]
    if not drops:
        return
    top = max(peak[id(s)] for s in drops)
    lift = {id(s): min(DROP_LIFT_DB, max(0.0, top - peak[id(s)])) for s in drops}
    drop_db = {id(s): st(y[:, slice(*span(s))]) + lift[id(s)] for s in drops}
    ref = float(np.mean(list(drop_db.values())))
    curve = np.ones(y.shape[1], np.float32)
    prev = 1.0
    for k, s in enumerate(secs):
        a, b = span(s)
        if b <= a:
            continue
        nxt = secs[k + 1] if k + 1 < len(secs) else None
        cap = 10 ** (min(0.0, top - peak[id(s)]) / 20)  # never over the loudest drop, its first bar's ease too
        if s.kind == "drop":
            g = 10 ** (lift[id(s)] / 20)
        elif nxt is not None and id(nxt) in drop_db:
            g = min(cap, 10 ** (min(0.0, drop_db[id(nxt)] + BUILD_LU - st(y[:, max(a, b - 4 * bar) : b])) / 20))
        else:
            g = min(cap, 10 ** (min(0.0, ref + OTHER_LU - st(y[:, a:b])) / 20))
        curve[a:b] = g
        if s.kind != "drop":
            r = min(bar, b - a)
            curve[a : a + r] = np.linspace(min(prev, cap), g, r)
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
        if os == 1:  # the search: the clipper's aliasing hardly moves the loudness
            return (c * np.tanh(z * (g * lim) / c)).astype(np.float32)
        up = signal.resample_poly((z * (g * lim)).astype(np.float64), os, 1, axis=-1)
        return signal.resample_poly(c * np.tanh(up / c), 1, os, axis=-1)[:, : z.shape[1]].astype(np.float32)

    # the search runs on the measured spans only, each padded 50 ms (the look-ahead, the gain's ease, the resampler's
    # taps), measured inside the padding; then one full-length pass (S3's M2.5 profile: 14 whole-song passes were 16 s).
    # It bisects at 1x, then one secant step at 2x for the clipper's last hundredths (M2.5 again: bisecting at 2x was
    # 86 resamples, 16 s of a 41 s mixdown)
    pad = int(0.05 * sr)
    cuts = [(max(0, a - pad), min(x.shape[1], b + pad), a, b) for a, b in (spans or [(0, x.shape[1])])]

    def level(g_db: float, os: int) -> float:
        return max(short_term_max(run(x[:, s0:s1], env[s0:s1], g_db, os)[:, a - s0 : b - s0], sr) for s0, s1, a, b in cuts)

    lo, hi = -40.0, 40.0
    for _ in range(14):
        mid = 0.5 * (lo + hi)
        if level(mid, 1) < target_st_lufs:
            lo = mid
        else:
            hi = mid
    g, lv = hi, level(hi, 2)
    if abs(lv - target_st_lufs) > 0.02:
        g2 = g + target_st_lufs - lv
        lv2 = level(g2, 2)
        g = g2 if abs(lv2 - lv) < 1e-6 else g + (target_st_lufs - lv) * (g2 - g) / (lv2 - lv)
    y = run(x, env, g, os=4)  # the one pass that's heard: 4x oversampled, like every nonlinear stage (SB fault #1)
    tp = true_peak(y, sr)
    return (y * np.float32(10 ** ((ceiling_db - tp) / 20))) if tp > ceiling_db else y


def _drop_mix(remix: Remix, bufs: list[tuple], sr: int, n: int, buses: dict[str, np.ndarray] | None = None,
              sources: dict | None = None) -> np.ndarray:
    """The lanes summed: the drop rules are already in the prepared clips (dropfx on every bass clip, the impact on the
    kit-fx lane: M1.14, so the app plays what the export does). `buses` gets the audition's stems: the bass lanes split
    at 120 Hz (sub, mid), the drums, the non-vocal rest (top) and the snare window's centres (snare_beats)."""
    y = np.zeros((2, n), np.float32)
    for _, buf in bufs:
        y += buf
    if buses is not None:
        from .dropfx import _lr4, drum_times, gate_beats

        zero = np.zeros((2, n), np.float32)
        bass = sum((b for l, b in bufs if l.role in ("bass", "synth_bass")), zero)
        buses.update(sub=_lr4(bass, sr, "low").astype(np.float32), mid=_lr4(bass, sr, "high").astype(np.float32),
                     drums=sum((b for l, b in bufs if l.role in ("drums", "kit") and l.id != "kit-fx"), zero),
                     top=sum((b for l, b in bufs if l.role not in ("bass", "synth_bass", "drums", "kit", "vocals")
                              or l.id == "kit-fx"), zero),  # the impact isn't the kit: top, not drums (drums_lu, snare_top)
                     snare_beats=np.array(gate_beats(remix, drum_times(remix, sources)[1]), float),
                     kick_beats=np.array(drum_times(remix, sources)[0], float))
    return y
