"""REMIX audition QA, "the awful detector": an objective scorecard per clip, so a bad render is caught before anyone
hears it. Each clip is `--bars` bars (default 16): `--build-bars` of build (default 4), then the drop. A clip named
original-drop.* in the folder is the reference (the untouched bars): its column is printed first and the bass lag is
measured against it.

Per clip (the drop unless noted):
  st_max_lufs    short-term (3 s) max loudness, LUFS         int_lufs      integrated loudness, LUFS
  true_peak      4x-oversampled peak, whole clip, dBTP        sub_corr      L/R correlation below 100 Hz (mono sub)
  sub_mid_db     sub (<100 Hz) over mid-bass (100 Hz-1 kHz)   midbass_crest mid-bass crest factor, dB
  onsets_bar     onsets per bar
  bass_in_db     the drop's first bar vs its mean, sustained 30-250 Hz (kicks median-filtered out): a bass line a bar
                 late leaves that bar empty
  bass_lag_bars  where the drop's bass envelope lines up best with the reference's, in bars (0 = in place)
  gap_db         the last beat before the drop vs the drop       drop_attack_db  the drop's first beat vs its mean (fade-in)
  centroid_move  spectral centroid movement, octaves per 16th (is anything moving?)
  clicks_min     clicks per minute, whole clip: >4 kHz energy packed into ~0.3 ms (not a buzzy bass's own edges)
Each is PASS inside its TARGETS range, WARN within the margin outside it, FAIL beyond.

A clip's stems, when a <clip>.stems/ folder sits next to it (S2's remix_audition: float WAVs aligned with the clip,
pre-master, so only ratios and shapes are graded, and drums against source_drums at the same gain):
  mid.wav     mid_crest_db from the mid bus (on a mixdown alone it's informational, "i": the drums inflate it)
  sub.wav     sub_purity_db (energy from 2.5 f0 up vs the fundamental) and sub_corr from the sub bus
  drums.wav + source_drums.wav   drums_lu: the kit vs the original's drum stem over the same bars
  drums.wav + mid/sub.wav        snare_top_pct and snare_clear again, from the kit's peaks and the bass buses' onsets;
                                 snare_duck_db: the bass buses in the 60 ms after each snare / clap vs their level
Harmony (docs/REMIX_HARMONY.md 6.6), from the stems and grid.json's key, tuning_cents, chords [[t_s, root pc,
quality]], notes [[t_s, dur_s, midi, degree, tension]] and kicks_s (clip seconds; a missing field skips its check),
over the drop: drop_s to drop_end_s (when given):
  tuning_dev_c    the sub's cents off the equal-tempered grid moved by the source's tuning (median over half-bars):
                  sub.wav is a sine on the plan's roots and the voices share its tuning. (6.1's circular mean reads a
                  distorted mid 2-4 c flat: a harmonic tone's partials 3, 5, 7 aren't on the grid.)
  sub_root_pct    half-bars whose sub (sub.wav's held note: the median of its periods) is the chord's root +-50 c
  chord_tone_pct  the notes' time on their chord's tones (tension slots left out; a power chord takes the key's 3rd)
  kick_beats      kicks 0.3-1.0 st from the sub (drums.wav vs sub.wav, 80-140 ms after the kick: 1-3 Hz beating)
                  still within 30 dB of their peak at 150 ms: what the kit's tail rule is there to stop

Plan v2 §8, where stems exist the checks read the right bus: onsets_bar and first_hit_db the bass (sub + mid);
predrop_dbfs, predrop_gap_beats and beat_pauses_16 the non-vocal stems (a vocal cue may sit in the gap); whine_* the
low-end owner (sub.wav); hit_states_bar, silence_16_pct (tearout) and motif_sim (riddim) the mid. take_sim compares
seeds of one song / recipe / style (files named <...>-s<seed>.*). A trap_hybrid render (its grid.json style, or
--style trap_hybrid) grades the switch-up (switch_db) instead of the gap. S2's <clip>.stems/grid.json also gives the
grid, the snare / clap times (snares_s) and the one gain the 16-bit stems were written at (stem_gain, undone here).

  cd engine && uv run --all-packages python ../scripts/remix_qa.py ../out/remix-audition
  cd engine && uv run --all-packages python ../scripts/remix_qa.py --selftest
numpy / scipy / pyloudnorm / pedalboard only. Reads audio, never writes it.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
import pyloudnorm as pyln
from scipy import ndimage, signal

# metric: (pass_lo, pass_hi, warn_margin). Placeholders anchored so the untouched original-drop passes, until the PM's
# sound-bible numbers land (the audition pack sits ~4 dB under club loudness).
TARGETS: dict[str, tuple[float, float, float]] = {
    "st_max_lufs": (-7.5, -6.5, 1.0),  # Q01 / I5: -7.0 ± 0.5 ✅ user
    "int_lufs": (-99.0, 0.0, 0.0),  # Q03: info
    "true_peak": (-99.0, -1.0, 0.3),  # Q02 / I5 ✅
    "sub_corr": (0.95, 1.0, 0.05),  # Q14 / I9 ✅
    "sub_mid_db": (5.0, 18.0, 3.0),
    "midbass_crest": (10.0, 21.0, 2.0),
    # Q23, the bass stems' (sub + mid) flux onsets per drop bar. Calibrated on the corpus originals' own bass stems
    # (Demucs, first drop): 13.0-19.0, median ~17. The detector counts movement inside notes (a wub, a growl's motion),
    # so the Bible's 3-9 notes per bar can't be its target ~
    "onsets_bar": (10.0, 20.0, 2.0),
    "bass_in_db": (-4.0, 6.0, 4.0),
    "bass_lag_bars": (0.0, 0.0, 0.0),
    "gap_db": (-999.0, 0.0, 3.0),  # a silent gap has no floor
    "drop_attack_db": (-8.0, 6.0, 3.0),
    "centroid_move": (0.08, 2.0, 0.04),
    "clicks_min": (0.0, 2.0, 4.0),
    # Sound Bible §5 (docs/REMIX_SOUND_BIBLE.md); ✅ sourced, the rest to calibrate against the original and verdicts
    "build_vs_drop_lu": (4.0, 6.0, 2.0),  # drop over the last 4 build bars (short-term mean) ✅
    "predrop_dbfs": (-999.0, -40.0, 6.0),  # Q07 / I2: the quietest 1/2 beat in the last beat (non-vocal stems) ✅ user
    "predrop_gap_beats": (0.5, 1.1, 0.25),  # Q09 / I2: how long it stays under -40 dBFS into the drop (<= 1 beat) ✅ user
    # Q09 with source_nonvocal.wav: the gap we added over the source's own (its pre-drop may already be vocal-only);
    # predrop_gap_beats is then informational ✅ user
    "gap_added_beats": (-99.0, 1.1, 0.25),
    "switch_db": (-20.0, 6.0, 3.0),  # Q08, trap-hybrid (instead of the gap): the last 2 beats hold the switch-up vs the drop
    "first_hit_db": (1.5, 30.0, 1.0),  # Q12 / I3: drop beat 1's 100 ms RMS over every later beat's, bass stems ✅ user
    "sub_mid_rel_db": (-4.0, 2.0, 2.0),  # mid (150 Hz-4 kHz) re sub (30-120 Hz): growl bars
    "sub_vs_ref_db": (-1.0, 1.0, 1.0),  # 30-90 Hz RMS vs the original drop's
    # Q18 150 Hz-4 kHz peak over RMS on the mid stem's sounding frames. The Bible's 6-10 sits under every released
    # track: the corpus originals' own bass stems read 13.5-20 dB (S2), so <= 16 until L-gates say otherwise ~
    "mid_crest_db": (6.0, 16.0, 2.0),
    "mid_corr": (0.5, 1.0, 0.2),  # L/R, 150 Hz-1 kHz
    "whistle_db": (0.0, 6.0, 2.0),  # the worst 1/3-octave band (1-5 kHz) over its neighbours ✅
    "snare_top_pct": (0.75, 1.0, 0.15),  # bars whose loudest peak is in the snare window
    "snare_clear": (0.0, 0.0, 2.0),  # mid onsets within ±1/16 of a snare (not the snare itself) ✅
    "centroid_std_hz": (300.0, 20000.0, 100.0),  # the mid's centroid in 1/16 frames: std within each beat
    "centroid_clusters": (3.0, 99.0, 1.0),  # distinct centroid regions per 4 bars (the fewest)
    "novelty_max": (0.0, 0.97, 0.02),  # cosine of consecutive 4-bar blocks (chroma + MFCC)
    "held_bars": (1.0, 99.0, 0.5),  # the longest held sub per 4-bar phrase (the shortest phrase's) ✅ user
    "beat_pauses_16": (0.0, 1.0, 0.5),  # Q28 / I11: >= 1/2-beat windows <= -30 dBFS in the drop per 16 bars ("occasionally") ✅ user
    "whine_st": (-99.0, 7.0, 2.0),  # Q13 / I4: the low-end owner's first period over its settled pitch (a whine slides down)
    "whine_settle_ms": (0.0, 30.0, 10.0),  # Q13 / I4: when it's within ±0.5 st of that pitch for good
    "whine_centroid_x": (0.0, 3.0, 0.5),  # Q13: its first 50 ms centroid over the settled f0
    "hit_states_bar": (0.0, 99.0, 0.0),  # M2.4: distinct mid hit states per bar, bars 1-4 (the fewest); tearout >= 3
    "silence_16_pct": (0.0, 1.0, 0.0),  # M2.4: 1/16 slots of bars 1-2 at least 30 dB down; tearout >= 30 %
    "motif_sim": (0.0, 1.0, 0.0),  # M2.4: bar-to-bar similarity of the mid, bars 1-4 (the least); riddim >= 0.8
    "take_sim": (0.0, 0.95, 0.02),  # M2.4: the most similar other seed of the same song / recipe / style
    "snare_duck_db": (-60.0, -6.0, 2.0),  # stems, M2.4: the bass buses in the 60 ms after each snare / clap
    "sub_purity_db": (-120.0, -25.0, 5.0),  # stems: the sub bus's harmonics from 2.5 f0 up vs its fundamental
    "drums_lu": (-1.0, 1.0, 1.0),  # stems: the kit vs the original drum stem, integrated over the drop ✅ (review)
    # REMIX_HARMONY 6.6 (grid.json's harmony + the stems)
    "tuning_dev_c": (-5.0, 5.0, 3.0),
    "sub_root_pct": (1.0, 1.0, 0.05),
    "chord_tone_pct": (0.85, 1.0, 0.05),
    "kick_beats": (0.0, 0.0, 0.0),
}
# graded on the stems only: from a mixdown they read the drums as much as the bass (on the corpus originals the silence
# share is 0 and the whine tracks the kick), so there they're informational
INFO_ON_MIX = {"mid_crest_db", "whine_st", "whine_settle_ms", "whine_centroid_x", "hit_states_bar", "silence_16_pct",
               "motif_sim"}
INFO = {"int_lufs"}
ALIASES = {"trap_hybrid": "hybrid"}  # trap_hybrid grades on the hybrid targets, with the switch-up in place of the gap (C8)
STYLE_TARGETS: dict[str, dict[str, tuple[float, float, float]]] = {
    "tearout": {"hit_states_bar": (3.0, 99.0, 1.0), "silence_16_pct": (0.3, 1.0, 0.1)},
    "riddim": {"centroid_std_hz": (150.0, 20000.0, 50.0), "motif_sim": (0.8, 1.0, 0.05)},
    "hybrid": {"sub_mid_rel_db": (-10.0, -6.0, 2.0),
               "centroid_std_hz": (100.0, 20000.0, 50.0)},
}
EPS = 1e-12


def _db(p: float) -> float:
    return 10.0 * np.log10(max(p, EPS))


def load(path: Path) -> tuple[np.ndarray, int]:
    from pedalboard.io import AudioFile

    with AudioFile(str(path)) as f:
        x = f.read(f.frames)
        sr = int(f.samplerate)
    return (np.repeat(x, 2, axis=0) if x.shape[0] == 1 else x[:2]).astype(np.float64), sr


def _band(x: np.ndarray, sr: int, lo: float | None, hi: float | None) -> np.ndarray:
    kind, freq = ("bandpass", (lo, hi)) if lo and hi else ("lowpass", hi) if hi else ("highpass", lo)
    return signal.sosfiltfilt(signal.butter(4, freq, kind, fs=sr, output="sos"), x, axis=-1)


def _flux(mono: np.ndarray, sr: int, f_max: float | None = None) -> tuple[np.ndarray, float]:
    f, _, z = signal.stft(mono, sr, nperseg=1024, noverlap=768)
    mag = np.log1p(100 * np.abs(z[f <= f_max] if f_max else z))
    return np.concatenate([[0.0], np.maximum(np.diff(mag, axis=1), 0).sum(axis=0)]), sr / 256


def _onsets(env: np.ndarray, fps: float) -> np.ndarray:
    thr = ndimage.uniform_filter1d(env, max(3, int(0.5 * fps)), mode="nearest") * 1.5 + 1e-9
    peaks, _ = signal.find_peaks(env, height=thr, distance=max(1, int(0.05 * fps)))
    return peaks / fps


def onsets_per_bar(mono: np.ndarray, sr: int, bars: float) -> float:
    """Q23: spectral-flux onsets per bar (the bass stems' when there are stems: not the drums)."""
    return len(_onsets(*_flux(mono, sr))) / max(bars, 1e-9)


def grid(x: np.ndarray, sr: int, bars: int, bpm: float | None) -> tuple[float, float]:
    """(bpm, offset s): the clip is `bars` bars (its MP3 padding shaves the tempo a hair, so a near-whole BPM snaps);
    the offset is where its low-end hits fold onto the beat."""
    b = bpm or 240.0 * bars / (x.shape[-1] / sr)
    b = float(round(b)) if bpm is None and abs(b - round(b)) < 0.25 else b
    env, fps = _flux(x.mean(axis=0), sr, 200.0)
    beat = 60.0 / b
    phases = np.arange(0.0, beat, 0.002)
    score = [np.interp(p + beat * np.arange(int(len(env) / fps / beat)), np.arange(len(env)) / fps, env).sum() for p in phases]
    off = float(phases[int(np.argmax(score))])
    return b, (off if off < beat / 2 else off - beat)


def bass_spec(x: np.ndarray, sr: int) -> tuple[np.ndarray, float]:
    """The sustained low end, 30-250 Hz (frames x bins, ~86 fps): a time-median over 0.2 s drops the kicks' transients
    and keeps the bass notes (a median keeps a note's start edge where it is)."""
    f, _, z = signal.stft(x.mean(axis=0), sr, nperseg=4096, noverlap=4096 - 512)
    use = (f >= 30) & (f <= 250)
    return ndimage.median_filter(np.abs(z[use]).T, size=(int(0.2 * sr / 512) | 1, 1), mode="nearest"), sr / 512


def bass_bars(spec: np.ndarray, fps: float, t0: float, bpm: float, n_bars: int) -> np.ndarray:
    """Per bar from t0, the unit-norm sustained low-end spectrum: the bass notes, not just their level."""
    bar = 240.0 / bpm
    rows = [spec[int((t0 + b * bar) * fps):max(int((t0 + b * bar) * fps) + 1, int((t0 + (b + 1) * bar) * fps))].mean(axis=0)
            for b in range(n_bars)]
    return np.array([v / (np.linalg.norm(v) + EPS) for v in rows])


def measure(x: np.ndarray, sr: int, *, bars: int, build_bars: int, bpm: float | None = None,
            ref_bass: np.ndarray | None = None, ref_sub_db: float | None = None,
            stems: dict[str, np.ndarray] | None = None, known: dict | None = None) -> dict[str, float]:
    """`known`: the render's own grid.json {bpm, offset_s, drop_s} (S2's audition): read, not guessed."""
    if known:
        bpm, off = float(known["bpm"]), float(known["offset_s"])
    else:
        bpm, off = grid(x, sr, bars, bpm)
    bar, beat = 240.0 / bpm, 60.0 / bpm
    t_drop = float(known["drop_s"]) if known and "drop_s" in known else off + build_bars * bar
    i_drop = int(max(0.0, t_drop) * sr)
    drop = x[:, i_drop:]
    mono = drop.mean(axis=0)
    out: dict[str, float] = {"bpm": bpm, "grid_off_ms": 1000 * off}

    meter = pyln.Meter(sr)
    k = drop.T.copy()
    for stage in meter._filters.values():  # BS.1770 K-weighting (pyloudnorm's own filters)
        k = stage.apply_filter(k.T).T
    blk, hop = int(3 * sr), int(0.1 * sr)
    st = [-0.691 + _db(float(np.mean(k[i:i + blk] ** 2, axis=0).sum())) for i in range(0, max(1, len(k) - blk), hop)]
    out["st_max_lufs"] = max(st)
    out["int_lufs"] = float(meter.integrated_loudness(drop.T))
    out["true_peak"] = 20 * np.log10(np.max(np.abs(signal.resample_poly(x, 4, 1, axis=1))) + EPS)

    sub = _band(drop, sr, None, 100.0)
    mid = _band(mono, sr, 100.0, 1000.0)
    out["sub_corr"] = float(np.corrcoef(sub[0], sub[1])[0, 1]) if np.std(sub[1]) > EPS else 1.0
    out["sub_mid_db"] = _db(float(np.mean(sub.mean(axis=0) ** 2))) - _db(float(np.mean(mid ** 2)))
    out["midbass_crest"] = 20 * np.log10(np.max(np.abs(mid)) / (np.sqrt(np.mean(mid ** 2)) + EPS) + EPS)

    drop_bars = (drop.shape[-1] / sr) / bar
    bass_x = sum(stems[k] for k in ("sub", "mid") if k in stems) if stems and ({"sub", "mid"} & set(stems)) else None
    nonvocal = sum(stems[k] for k in ("drums", "sub", "mid", "top") if k in stems) if stems and "drums" in stems else None
    out["onsets_bar"] = onsets_per_bar(mono if bass_x is None else bass_x[:, i_drop:].mean(axis=0), sr, drop_bars)
    six = 15.0 / bpm
    spec, sfps = bass_spec(x, sr)
    lo, hi = int(t_drop * sfps), len(spec)
    power = spec[lo:hi].sum(axis=1) ** 2
    # ponytail: no beat-level bass-vs-kick timing: from a mixdown it read ~25 ms (chance) even on the original;
    # the bar-level checks below catch a groove a bar out (the bug that happened)
    first = int(bar * sfps)
    out["bass_in_db"] = 10 * np.log10(power[:first].mean() / (power.mean() + EPS) + EPS)
    mine = bass_bars(spec, sfps, t_drop, bpm, int(drop_bars))
    out["_bass_bars"] = mine  # the reference's, for the others' lag
    if ref_bass is not None:  # the drop's bar b + lag against the reference's bar b, by their bass notes
        n = min(len(mine), len(ref_bass)) - 2
        sim = {lag: float(np.mean(np.sum(mine[1 + lag:1 + lag + n] * ref_bass[1:1 + n], axis=1))) for lag in (-1, 0, 1)}
        best = max(sim, key=sim.get)
        out["bass_lag_bars"] = float(best if sim[best] > sim[0] + 0.05 else 0)  # a looping groove is ambiguous: 0 wins ties

    rms = lambda a, b: np.sqrt(np.mean(x[:, int(max(0.0, a) * sr):int(max(0.0, b) * sr)] ** 2) + EPS)  # noqa: E731
    level = np.sqrt(np.mean(drop ** 2) + EPS)
    out["gap_db"] = 20 * np.log10(rms(t_drop - beat, t_drop) / level)
    out["drop_attack_db"] = 20 * np.log10(rms(t_drop, t_drop + beat) / level)

    f, _, z = signal.stft(mono, sr, nperseg=2048, noverlap=1536)
    p = np.abs(z) ** 2
    cen = (f[:, None] * p).sum(axis=0) / (p.sum(axis=0) + EPS)
    per = int(round(six * sr / 512))
    c16 = np.log2(np.maximum(cen[: len(cen) // per * per].reshape(-1, per).mean(axis=1), 20.0))
    out["centroid_move"] = float(np.mean(np.abs(np.diff(c16)))) if len(c16) > 1 else 0.0

    clicks = _clicks(_band(x.mean(axis=0), sr, 4000.0, None) ** 2, sr)
    out["clicks_min"] = clicks / (x.shape[-1] / sr / 60.0)
    out.update(bible_checks(x, sr, bpm, off, t_drop, build_bars, ref_sub_db, bass=bass_x, quiet=nonvocal,
                            source_quiet=(stems or {}).get("source_nonvocal")))
    out.update(low_checks((stems["sub"] if stems and "sub" in stems else x).mean(axis=0), sr, t_drop))
    if stems:
        out.update(stem_checks(stems, sr, t_drop, bpm, (known or {}).get("snares_s")), _stems=1.0)
        out.update(harmony_checks(stems, sr, t_drop, bpm, known or {}))
    out.update(mid_checks((stems["mid"] if stems and "mid" in stems else x).mean(axis=0), sr, bpm, t_drop))
    out["_take"] = take_features(x, sr, bpm, t_drop)
    return out


BUZZ_GAP_S = 0.065  # two periods of the lowest riddim note (C1, 61 ms) and the comb's few % of wobble: S1's R1 buzz


def _clicks(e: np.ndarray, sr: int) -> int:
    """Clicks in `e` (power above 4 kHz): events packing their energy into ~0.3 ms (25x their 10 ms surround; 0 on the
    reference, MP3 smears a click to ~30x) over -45 dB (audible in a loud mix), not counting a buzzy bass's own edges.
    Buzz is local regularity: three or more events in a row with gaps under BUZZ_GAP_S that match (+-12 %, or 2x where
    an edge dipped under) are a note's pitch period, whatever the note (a line changes pitch), and a lone event 1-6
    local periods (+-5 %) from such a train is its too, as is an isolated pair under 30 ms apart within 1 dB (S1: a
    masked yoi saw's edges). The rest, merged within 30 ms, are clicks. (fvwks_synth.growls.
    clicks is the same rule.) BUZZ_GAP_S is 65 ms: R1's 0.5-ratio FM repeats every two periods, 61 ms on C1.
    Blind spot: a click at every 1/32 retrigger (50-54 ms at 140-150 BPM) is as regular as that buzz."""
    short = ndimage.uniform_filter1d(e, max(3, int(0.0003 * sr)), mode="nearest")
    wide = ndimage.uniform_filter1d(e, int(0.010 * sr), mode="nearest")
    hits = np.flatnonzero((short > 25 * wide) & (short > 10 ** (-45 / 10)))
    if not len(hits):
        return 0
    first = hits[np.concatenate([[True], np.diff(hits) > int(0.005 * sr)])]
    ev, db = first / sr, 10 * np.log10(short[first] + 1e-30)
    buzz = np.zeros(len(ev), bool)
    period = np.full(len(ev), np.nan)
    gaps = np.diff(ev)
    for i in range(1, len(ev) - 1):
        a, b = gaps[i - 1], gaps[i]
        if a < BUZZ_GAP_S and b < BUZZ_GAP_S:
            r = max(a, b) / min(a, b)
            if round(r) <= 2 and abs(r - round(r)) <= 0.12 * round(r):
                buzz[i - 1:i + 2] = True
                period[i - 1:i + 2] = min(a, b)
    trains = np.flatnonzero(buzz)
    for i in np.flatnonzero(~buzz) if len(trains) else []:
        j = trains[np.argmin(np.abs(ev[trains] - ev[i]))]
        k = abs(ev[i] - ev[j]) / period[j]
        if round(k) <= 6 and abs(k - round(k)) <= 0.05:
            buzz[i] = True
    for i in np.flatnonzero(~buzz)[:-1]:  # an isolated pair under 30 ms apart, level within 1 dB: a buzz's two edges
        j = i + 1  # (S1: a masked yoi saw's), not two clicks
        if (not buzz[j] and ev[j] - ev[i] < 0.030 and abs(db[i] - db[j]) <= 1.0
                and (i == 0 or ev[i] - ev[i - 1] >= 0.030) and (j + 1 == len(ev) or ev[j + 1] - ev[j] >= 0.030)):
            buzz[i] = buzz[j] = True
    lone = ev[~buzz]
    return int(len(lone) and 1 + np.sum(np.diff(lone) >= 0.030))


def _short_term(x: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
    """(window start s, LUFS) of 3 s windows every 0.1 s, BS.1770 K-weighted (pyloudnorm's filters)."""
    k = x.T.copy()
    for stage in pyln.Meter(sr)._filters.values():
        k = stage.apply_filter(k.T).T
    blk, hop = int(3 * sr), int(0.1 * sr)
    starts = np.arange(0, max(1, len(k) - blk), hop)
    return starts / sr, np.array([-0.691 + _db(float(np.mean(k[i:i + blk] ** 2, axis=0).sum())) for i in starts])


def _mfcc_chroma(mono: np.ndarray, sr: int) -> np.ndarray:
    """One vector per call: the mean chroma (12) and MFCCs 1-12 (26 mel bands, 30 Hz-8 kHz), each unit-norm."""
    from scipy.fft import dct

    f, _, z = signal.stft(mono, sr, nperseg=4096, noverlap=3072)
    p = np.abs(z) ** 2
    use = (f >= 55) & (f <= 2000)
    pc = np.round(69 + 12 * np.log2(f[use] / 440)).astype(int) % 12
    chroma = np.array([p[use][pc == c].sum() for c in range(12)])
    mel = lambda hz: 2595 * np.log10(1 + hz / 700)  # noqa: E731
    edges = 700 * (10 ** (np.linspace(mel(30), mel(8000), 28) / 2595) - 1)
    bands = np.array([np.interp(f, [a, b, c], [0, 1, 0], left=0, right=0) for a, b, c in zip(edges, edges[1:], edges[2:])])
    mfcc = dct(np.log(bands @ p.mean(axis=1) + EPS), norm="ortho")[1:13]
    return np.concatenate([chroma / (np.linalg.norm(chroma) + EPS), mfcc / (np.linalg.norm(mfcc) + EPS)])


def _pitch(y: np.ndarray, sr: int) -> float:
    """The strongest autocorrelation period in 30-500 Hz, as Hz (0 when there's nothing periodic)."""
    y = y - y.mean()
    ac = np.correlate(y, y, "full")[len(y) - 1:]
    lo, hi = int(sr / 500), min(len(ac) - 1, int(sr / 30))
    if hi <= lo or ac[0] <= EPS:
        return 0.0
    return sr / (lo + int(np.argmax(ac[lo:hi])))


def mid_checks(mid: np.ndarray, sr: int, bpm: float, t_drop: float) -> dict[str, float]:
    """M2.4 on the mid bass (the mid stem, or a mixdown's 150 Hz-4 kHz): the first hit's whine, tearout's hit states and
    silence, riddim's repeated motif. `mid` is mono."""
    bar, six = 240.0 / bpm, 15.0 / bpm
    m = _band(mid[int(max(0.0, t_drop) * sr):], sr, 150.0, 4000.0)
    n_bars = int(len(m) / sr // bar)
    out: dict[str, float] = {}

    slot = np.array([np.sqrt(np.mean(m[int(i * six * sr):int((i + 1) * six * sr)] ** 2) + EPS) for i in range(n_bars * 16)])
    if len(slot) >= 32:  # 1/16 slots in bars 1-2 at least 30 dB under the drop's loudest slot
        out["silence_16_pct"] = float(np.mean(20 * np.log10(slot[:32] / slot.max()) < -30.0))

    on = _onsets(*_flux(m, sr))
    states = []
    for b in range(min(4, n_bars)):  # distinct hit states per bar: the hits' spectra, greedily clustered at cos 0.9
        seen: list[np.ndarray] = []
        for t in on[(on >= b * bar) & (on < (b + 1) * bar)]:
            seg = m[int(t * sr):int((t + 0.06) * sr)]
            if len(seg) < int(0.03 * sr):
                continue
            fs, ps = signal.welch(seg, sr, nperseg=len(seg))
            edges = np.geomspace(150, 6000, 25)
            v = np.log(np.array([ps[(fs >= a) & (fs < z)].sum() for a, z in zip(edges, edges[1:])]) + EPS)
            v = (v - v.mean()) / (np.linalg.norm(v - v.mean()) + EPS)
            if all(v @ w < 0.9 for w in seen):
                seen.append(v)
        states.append(len(seen))
    if states:
        out["hit_states_bar"] = float(min(states))
    feats = [_mfcc_chroma(m[int(b * bar * sr):int((b + 1) * bar * sr)], sr) for b in range(min(4, n_bars))]
    if len(feats) > 1:  # riddim: one motif, bar after bar
        out["motif_sim"] = float(min(a @ b / 2 for a, b in zip(feats, feats[1:])))
    return out


def low_checks(low: np.ndarray, sr: int, t_drop: float) -> dict[str, float]:
    """Q13 / I4 on the low-end owner (sub.wav, else a mixdown's < 250 Hz): its first note's periods from zero crossings.
    whine_st: the first period's pitch over the settled one (80-150 ms); whine_settle_ms: when it stays within ±0.5 st;
    whine_centroid_x: the first 50 ms centroid (full band) over the settled f0. `low` is mono."""
    y = low[int(max(0.0, t_drop) * sr):int(max(0.0, t_drop) * sr) + int(0.2 * sr)]
    if len(y) < int(0.15 * sr) or np.max(np.abs(y)) < 1e-4:
        return {}
    b = _band(y, sr, 20.0, 250.0)
    up = np.flatnonzero((b[:-1] <= 0) & (b[1:] > 0) & (np.abs(b[1:]) + np.abs(b[:-1]) > 1e-4 * np.max(np.abs(b))))
    if len(up) < 4:
        return {}
    t = up[1:] / sr
    st = 12 * np.log2(sr / np.diff(up))
    t, st = t[t <= 0.15], st[t <= 0.15]  # past that, the window's own filter edge
    late = t >= 0.08
    if not late.any():
        return {}
    settled = float(np.median(st[late]))
    off = np.flatnonzero(np.abs(st - settled) > 0.5)
    f, pw = signal.welch(y[: int(0.05 * sr)], sr, nperseg=int(0.05 * sr))
    return {"whine_st": float(st[0] - settled), "whine_settle_ms": float(1000 * t[off[-1]]) if len(off) else 0.0,
            "whine_centroid_x": float((f * pw).sum() / (pw.sum() + EPS)) / (440 * 2 ** ((settled - 12 * np.log2(440)) / 12))}


def take_features(x: np.ndarray, sr: int, bpm: float, t_drop: float, bars: int = 8) -> np.ndarray:
    """A take's fingerprint for distinctness: chroma + MFCC per drop bar, concatenated and unit-norm."""
    bar = 240.0 / bpm
    mono = x.mean(axis=0)[int(max(0.0, t_drop) * sr):]
    v = np.concatenate([_mfcc_chroma(mono[int(b * bar * sr):int((b + 1) * bar * sr)], sr)
                        for b in range(min(bars, int(len(mono) / sr // bar)))])
    return v / (np.linalg.norm(v) + EPS)


def _snare(peaks: np.ndarray, bass: np.ndarray, sr: int, bpm: float, n_bars: int, claps: list[float] | None = None
           ) -> dict[str, float]:
    """snare_top_pct: bars whose loudest peak (of `peaks`) is the snare on step 9; snare_clear: `bass` onsets
    (150 Hz-1 kHz) within ±1/16 of it, or of every clap / snare found on the drums stem (`claps`, Q22). From a mixdown
    both read everything; from stems, the kit and the bass buses."""
    bar, beat, six = 240.0 / bpm, 60.0 / bpm, 15.0 / bpm
    top, clear = 0, 0
    on = _onsets(*_flux(_band(bass.mean(axis=0), sr, 150.0, 1000.0), sr))
    for b in range(n_bars):
        seg = np.abs(peaks[:, int(b * bar * sr):int((b + 1) * bar * sr)]).max(axis=0)
        snare = b * bar + 2 * beat  # step 9
        top += abs(int(np.argmax(seg)) / sr + b * bar - snare) <= six
    for snare in claps if claps is not None else [b * bar + 2 * beat for b in range(n_bars)]:
        rel = on - snare  # the snare's own clap bursts and body sit in -10 ms .. +35 ms: those aren't the bass
        # the mid may re-enter on step 10 (SB): the window's edge is out, with 5 ms for onset jitter
        clear += int(np.sum((np.abs(rel) < six - 0.005) & ((rel < -0.010) | (rel > 0.035))))
    return {"snare_top_pct": top / n_bars, "snare_clear": float(clear)} if n_bars else {}


def _gap_beats(q: np.ndarray, sr: int, i_drop: int, beat: float) -> float:
    """How long `q` (mono) stays under -40 dBFS into the drop, in beats (the last 2 bars looked at)."""
    pre = q[int(max(0, i_drop - 8 * beat * sr)):i_drop]
    win = max(1, int(0.05 * sr))
    env = 10 * np.log10(ndimage.uniform_filter1d(pre ** 2, win) + EPS)
    loud = np.flatnonzero(env[: len(env) - win // 2] > -40.0)  # from the last loud moment to the drop
    return float((len(pre) - (loud[-1] if len(loud) else 0)) / sr / beat)


def bible_checks(x: np.ndarray, sr: int, bpm: float, off: float, t_drop: float, build_bars: int,
                 ref_sub_db: float | None, bass: np.ndarray | None = None, quiet: np.ndarray | None = None,
                 source_quiet: np.ndarray | None = None) -> dict[str, float]:
    """The Sound Bible §5 checks on the mixdown, or where given on the stems: `bass` (sub + mid) for the first hit,
    `quiet` (the non-vocal stems) for the gap and the pauses (a vocal cue may sit in the gap, C3/C9)."""
    bar, beat, six = 240.0 / bpm, 60.0 / bpm, 15.0 / bpm
    i_drop = int(max(0.0, t_drop) * sr)
    drop = x[:, i_drop:]
    mono = x.mean(axis=0)
    n_bars = int((drop.shape[-1] / sr) // bar)
    out: dict[str, float] = {}
    rms_db = lambda y: 20 * np.log10(np.sqrt(np.mean(np.square(y))) + EPS)  # noqa: E731

    t_st, st = _short_term(x, sr)
    in_drop, in_build = t_st >= t_drop, (t_st >= t_drop - 4 * bar) & (t_st + 3 <= t_drop + 1e-6)
    if in_drop.any() and in_build.any():
        out["build_vs_drop_lu"] = float(np.mean(st[in_drop]) - np.mean(st[in_build]))
    q = (x if quiet is None else quiet).mean(axis=0)
    last = q[int(max(0.0, t_drop - beat) * sr):i_drop]
    half = max(1, int(beat / 2 * sr))
    if len(last) >= half:
        out["predrop_dbfs"] = float(min(rms_db(last[i:i + half]) for i in range(0, len(last) - half + 1, max(1, half // 8))))
        out["predrop_gap_beats"] = _gap_beats(q, sr, i_drop, beat)
        if source_quiet is not None:  # the source's own pre-drop may already be vocal-only: grade what we added
            out["gap_added_beats"] = out["predrop_gap_beats"] - _gap_beats(source_quiet.mean(axis=0), sr, i_drop, beat)
    out["switch_db"] = rms_db(mono[int(max(0.0, t_drop - 2 * beat) * sr):i_drop]) - rms_db(drop)

    low = _band(drop.mean(axis=0), sr, 30.0, 4000.0) if bass is None else bass[:, i_drop:].mean(axis=0)
    beats = [rms_db(low[int(b * beat * sr):int((b * beat + 0.1) * sr)]) for b in range(int(n_bars * 4))]
    if len(beats) > 1:
        out["first_hit_db"] = float(beats[0] - max(beats[1:]))

    sub = _band(drop, sr, 30.0, 120.0)
    mid = _band(drop, sr, 150.0, 4000.0)
    out["sub_mid_rel_db"] = rms_db(mid) - rms_db(sub)
    sub_db = rms_db(_band(drop, sr, 30.0, 90.0))
    out["_sub_db"] = sub_db
    if ref_sub_db is not None:
        out["sub_vs_ref_db"] = sub_db - ref_sub_db
    mid_m = mid.mean(axis=0)
    out["mid_crest_db"] = 20 * np.log10(np.max(np.abs(mid_m)) + EPS) - rms_db(mid_m)
    m1k = _band(drop, sr, 150.0, 1000.0)
    out["mid_corr"] = float(np.corrcoef(m1k[0], m1k[1])[0, 1]) if np.std(m1k[1]) > EPS else 1.0

    f, pw = signal.welch(drop.mean(axis=0), sr, nperseg=8192)
    centres = 1000 * 2 ** (np.arange(0, 7.5) / 3)
    lvl = np.array([10 * np.log10(pw[(f >= c / 2 ** (1 / 6)) & (f < c * 2 ** (1 / 6))].mean() + EPS) for c in centres])
    out["whistle_db"] = float(max(lvl[i] - (lvl[i - 1] + lvl[i + 1]) / 2 for i in range(1, len(lvl) - 1)))

    out.update(_snare(drop, drop, sr, bpm, n_bars))

    fs, _, zs = signal.stft(mid_m, sr, nperseg=2048, noverlap=2048 - int(six * sr / 4))
    ps = np.abs(zs) ** 2
    cen = (fs[:, None] * ps).sum(axis=0) / (ps.sum(axis=0) + EPS)
    per_beat = max(1, int(round(beat / (six / 4))))
    beats_c = cen[: len(cen) // per_beat * per_beat].reshape(-1, per_beat)
    out["centroid_std_hz"] = float(np.mean(beats_c.std(axis=1))) if len(beats_c) else 0.0
    per_4 = per_beat * 16
    blocks = [cen[i:i + per_4] for i in range(0, len(cen) - per_4 + 1, per_4)] or [cen]
    counts = []
    for blk in blocks:
        bins = np.round(3 * np.log2(np.maximum(blk, 50.0) / 50.0))  # 1/3-octave regions
        _, c = np.unique(bins, return_counts=True)
        counts.append(int(np.sum(c >= 0.05 * len(blk))))
    out["centroid_clusters"] = float(min(counts))

    feats = [_mfcc_chroma(drop.mean(axis=0)[int(i * 4 * bar * sr):int((i + 1) * 4 * bar * sr)], sr) for i in range(n_bars // 4)]
    if len(feats) > 1:
        out["novelty_max"] = float(max(a @ b / 2 for a, b in zip(feats, feats[1:])))

    env = np.sqrt(np.maximum(ndimage.uniform_filter1d(_band(drop.mean(axis=0), sr, 30.0, 90.0) ** 2, int(0.05 * sr)), 0))
    held = env > np.max(env) * 10 ** (-15 / 20)
    held = ndimage.binary_closing(held, np.ones(max(1, int(beat / 8 * sr))))  # bridge kick-duck dips
    phrases = []
    for ph in range(max(1, n_bars // 4)):
        seg = held[int(ph * 4 * bar * sr):int((ph + 1) * 4 * bar * sr)]
        runs = np.diff(np.flatnonzero(np.diff(np.concatenate([[0], seg.astype(int), [0]]))))[::2]
        phrases.append((runs.max() if len(runs) else 0) / sr / bar)
    out["held_bars"] = float(min(phrases))

    silent = np.sqrt(np.maximum(ndimage.uniform_filter1d(q[i_drop:] ** 2, max(1, int(beat / 2 * sr))), 0)) < 10 ** (-30 / 20)
    pauses = int(np.sum(np.diff(np.concatenate([[0], silent.astype(int)])) == 1))
    out["beat_pauses_16"] = pauses * 16 / max(1, n_bars)
    return out


def stem_checks(stems: dict[str, np.ndarray], sr: int, t_drop: float, bpm: float | None = None,
                snares: list[float] | None = None) -> dict[str, float]:
    """The Sound Bible §5 checks that need the buses (over the drop): mid crest, sub purity and mono, drum loudness,
    and the snare window again on the kit (its peak) and the bass buses (their onsets). `snares`: the render's own
    snare / clap times (grid.json snares_s, clip seconds); else they're found on drums.wav."""
    i = int(max(0.0, t_drop) * sr)
    drop = {k: v[:, i:] for k, v in stems.items()}
    out: dict[str, float] = {}
    if bpm and "drums" in drop and "mid" in drop:
        bass = drop["mid"]  # the rule is the mid's (SB 1.4, I6): the sub holds (I1) and a source 808's residue isn't a hit
        top = _band(drop["drums"].mean(axis=0), sr, 1000.0, None)  # snares and claps: bright and loud (hats are quieter)
        hits = _onsets(*_flux(top, sr))
        rms = lambda y: float(np.sqrt(np.mean(y ** 2)) + EPS)  # noqa: E731
        loud = [t for t in hits if rms(top[int(t * sr):int((t + 0.06) * sr)]) > 0.5 * max(rms(top[int(u * sr):int((u + 0.06) * sr)]) for u in hits)]
        if snares is not None:  # the found ones take a flip's source kick clicks for claps
            loud = [t - t_drop for t in snares if t >= t_drop]
        out.update(_snare(drop["drums"], bass, sr, bpm, int(drop["drums"].shape[-1] / sr // (240.0 / bpm)), loud))
        b = bass.mean(axis=0)
        if loud:
            out["snare_duck_db"] = 20 * np.log10(np.median([rms(b[int(t * sr):int((t + 0.06) * sr)]) for t in loud]) / rms(b))
    if "mid" in drop:
        m = _band(drop["mid"], sr, 150.0, 4000.0).mean(axis=0)
        f = int(0.01 * sr)  # on its sounding 10 ms frames: a gun-shot drop's silences aren't crest
        frames = np.mean(m[: len(m) // f * f].reshape(-1, f) ** 2, axis=1)
        live = frames > frames.max() * 1e-3
        if live.any():
            out["mid_crest_db"] = 20 * np.log10(np.max(np.abs(m)) + EPS) - 10 * np.log10(frames[live].mean() + EPS)
    if "sub" in drop:
        s = drop["sub"]
        out["sub_corr"] = float(np.corrcoef(s[0], s[1])[0, 1]) if np.std(s[1]) > EPS else 1.0
        f, _, z = signal.stft(s.mean(axis=0), sr, nperseg=sr // 4)  # 4 Hz bins: the sub's notes sit 30-60 Hz
        p = np.abs(z) ** 2
        low = (f >= 25) & (f <= 70)
        f0 = f[low][np.argmax(p[low], axis=0)]
        live = p[low].max(axis=0) > 1e-4 * p[low].max()  # frames where the sub sounds
        fund = sum(p[np.abs(f - f0[j]) <= 6, j].sum() for j in np.flatnonzero(live))
        harm = sum(p[f >= 2.5 * f0[j], j].sum() for j in np.flatnonzero(live))  # the 3rd harmonic up (clipping's)
        out["sub_purity_db"] = _db(harm) - _db(fund)
    if "drums" in drop and "source_drums" in drop:
        meter = pyln.Meter(sr)
        out["drums_lu"] = float(meter.integrated_loudness(drop["drums"].T) - meter.integrated_loudness(drop["source_drums"].T))
    return out


CHORD_TONES = {"m": (0, 3, 7), "M": (0, 4, 7), "5": (0, 7), "dim": (0, 3, 6), "aug": (0, 4, 8), "sus2": (0, 2, 7),
               "sus4": (0, 5, 7), "7": (0, 4, 7, 10), "m7": (0, 3, 7, 10), "maj7": (0, 4, 7, 11)}


def _key_scale(key: str | None) -> set[int] | None:
    m = re.fullmatch(r"([A-G])([#b]?)\s*(m|min|minor)?", (key or "").strip())
    if not m:
        return None
    tonic = ({"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[m.group(1)] + {"#": 1, "b": -1}.get(m.group(2), 0)) % 12
    return {(tonic + i) % 12 for i in ((0, 2, 3, 5, 7, 8, 10) if m.group(3) else (0, 2, 4, 5, 7, 9, 11))}


def held_hz(seg: np.ndarray, sr: int, lo: float = 25.0, hi: float = 120.0) -> float:
    """The note a sub holds: the median of its periods (rising zero crossings, interpolated) in lo-hi Hz, so a glide
    or a pickup is outvoted by the held note (a spectrum peak over a D -> E slide read the D# between). 0 when silent."""
    i = np.flatnonzero((seg[:-1] < 0) & (seg[1:] >= 0))
    if len(i) < 4:
        return 0.0
    per = np.diff(i + seg[i] / (seg[i] - seg[i + 1]))
    amp = np.maximum.reduceat(np.abs(seg), i)[:-1]  # each period's peak: a pause's noise crossings don't vote
    per = per[(per > sr / hi) & (per < sr / lo) & (amp >= 0.1 * np.abs(seg).max())]
    return float(sr / np.median(per)) if len(per) else 0.0


def _zc_hz(y: np.ndarray, sr: int) -> float:
    """A low sine's frequency from its rising zero crossings (interpolated); 0 with fewer than two periods."""
    i = np.flatnonzero((y[:-1] < 0) & (y[1:] >= 0))
    if len(i) < 3:
        return 0.0
    zc = i + y[i] / (y[i] - y[i + 1])
    return sr / float(np.mean(np.diff(zc)))


def harmony_checks(stems: dict[str, np.ndarray], sr: int, t_drop: float, bpm: float, known: dict) -> dict[str, float]:
    """REMIX_HARMONY 6.6 over the drop (see the module doc): the render's own plan (grid.json) against its buses."""
    out: dict[str, float] = {}
    theta = float(known.get("tuning_cents") or 0.0)
    t_end = float(known.get("drop_end_s") or np.inf)  # the drop only (S2's 8-bar drops: bars 9-16 are the source's verse)
    stems = {k: v[:, : int(min(v.shape[-1], t_end * sr))] for k, v in stems.items()}
    i0 = int(max(0.0, t_drop) * sr)
    chords = sorted(known.get("chords") or [])
    chord_at = lambda t: next((c for c in reversed(chords) if c[0] <= t + 1e-6), None)  # noqa: E731
    if "sub" in stems and (chords or "tuning_cents" in known):
        s = stems["sub"].mean(axis=0)
        half = 120.0 / bpm
        live = np.max(np.abs(s[i0:])) if len(s) > i0 else 0.0
        ok, cents = [], []
        for a in np.arange(t_drop, len(s) / sr - half + 1e-9, half):
            seg = s[int(a * sr):int((a + half) * sr)]
            if np.max(np.abs(seg)) < 0.05 * live:
                continue
            hz = held_hz(seg, sr)
            if not hz:
                continue
            note = 69 + 12 * np.log2(hz / 440.0) - theta / 100
            cents.append(100 * ((note + 0.5) % 1 - 0.5))
            if (c := chord_at(a + half / 2)) is not None:
                ok.append(abs((note - int(c[1]) + 6) % 12 - 6) <= 0.5)
        if ok:
            out["sub_root_pct"] = float(np.mean(ok))
        if cents and "tuning_cents" in known:
            out["tuning_dev_c"] = float(np.median(cents))
    notes = [n for n in known.get("notes") or [] if t_drop - 1e-6 <= n[0] < t_end and not (len(n) > 4 and n[4])]
    if notes and chords:
        scale = _key_scale(known.get("key"))
        on = total = 0.0
        for t, dur, midi, *_ in notes:
            c = chord_at(t)
            if c is None:
                continue
            root, quality = int(c[1]), str(c[2]) if len(c) > 2 else "5"
            tones = set(CHORD_TONES.get(quality, (0, 7)))
            if quality == "5" and scale:  # a power chord: the key's own 3rd on that root is a chord tone
                tones |= {k for k in (3, 4) if (root + k) % 12 in scale}
            total += dur
            on += dur * ((round(midi) - root) % 12 in tones)
        if total > 0:
            out["chord_tone_pct"] = on / total
    kicks = [k for k in known.get("kicks_s") or [] if t_drop <= k < t_end]
    if kicks and "drums" in stems and "sub" in stems:
        low = _band(stems["drums"].mean(axis=0), sr, None, 100.0)
        sub = _band(stems["sub"].mean(axis=0), sr, None, 100.0)
        sub_live = np.max(np.abs(sub[i0:])) if len(sub) > i0 else 0.0
        beats = 0
        for j, k in enumerate(kicks):
            if j + 1 < len(kicks) and kicks[j + 1] - k < 0.2:  # the next kick lands on its tail
                continue
            a = int(k * sr)
            w = slice(a + int(0.08 * sr), a + int(0.14 * sr))
            if a + int(0.17 * sr) > len(low) or np.max(np.abs(sub[w])) < 0.05 * sub_live:
                continue
            fk, fs = _zc_hz(low[w], sr), _zc_hz(sub[w], sr)
            peak = np.max(np.abs(low[a:a + int(0.1 * sr)])) + EPS
            ringing = np.max(np.abs(low[a + int(0.15 * sr):a + int(0.17 * sr)])) > peak * 10 ** (-30 / 20)
            beats += bool(fk and fs and 0.3 <= abs(12 * np.log2(fk / fs)) <= 1.0 and ringing)
        out["kick_beats"] = float(beats)
    return out


def load_stems(clip: Path, sr: int) -> dict[str, np.ndarray]:
    """<clip>.stems/{sub,mid,drums,source_drums}.wav, where present, at the clip's rate."""
    out = {}
    for name in ("sub", "mid", "drums", "top", "source_drums", "source_nonvocal"):
        f = clip.with_suffix(".stems") / f"{name}.wav"
        if f.exists():
            y, r = load(f)
            if r != sr:
                raise SystemExit(f"{f}: {r} Hz, the clip is {sr} Hz")
            out[name] = y
    return out


def grade(name: str, v: float, style: str = "tearout") -> str:
    lo, hi, margin = STYLE_TARGETS.get(style, {}).get(name, TARGETS[name])
    if lo <= v <= hi:
        return "PASS"
    return "WARN" if lo - margin <= v <= hi + margin else "FAIL"


def scorecard(folder: Path, bars: int, build_bars: int, bpm: float | None, style: str = "tearout") -> int:
    files = sorted(p for p in folder.iterdir() if p.suffix.lower() in (".mp3", ".wav", ".aif", ".aiff", ".flac"))
    ref = next((p for p in files if p.stem == "original-drop"), None)
    files = ([ref] if ref else []) + [p for p in files if p != ref]
    ref_bass = ref_sub = None
    rows: dict[str, dict[str, float]] = {}
    with_stems, takes, styles, raw = set(), {}, {}, {}
    for p in files:
        x, sr = load(p)
        known_f = p.with_suffix(".stems") / "grid.json"  # S2's: the grid and the style, per render
        known = json.loads(known_f.read_text()) if known_f.exists() else None
        raw[p.stem] = (known or {}).get("style") or style
        s = ALIASES.get(raw[p.stem], raw[p.stem])
        styles[p.stem] = s if s in STYLE_TARGETS else ALIASES.get(style, style)
        stems = {k: v / float((known or {}).get("stem_gain", 1.0)) for k, v in load_stems(p, sr).items()}  # 16-bit stems
        m = measure(x, sr, bars=bars, build_bars=build_bars, bpm=bpm, ref_bass=ref_bass, ref_sub_db=ref_sub,
                    stems=stems, known=known)
        mine, sub_db = m.pop("_bass_bars"), m.pop("_sub_db")
        takes[p.stem] = m.pop("_take")
        if m.pop("_stems", 0):
            with_stems.add(p.stem)
        if p == ref:
            ref_bass, ref_sub, m["bass_lag_bars"], m["sub_vs_ref_db"] = mine, sub_db, 0.0, 0.0
        rows[p.stem] = m
    names = list(rows)
    family = lambda n: re.sub(r"-s\d+$", "", n)  # noqa: E731
    for n in names:  # take distinctness: against the other seeds of the same song / recipe / style
        sib = [takes[o] for o in names if o != n and family(o) == family(n) and len(takes[o]) == len(takes[n])]
        if sib:
            rows[n]["take_sim"] = float(max(takes[n] @ v for v in sib))
    w = max(12, *(len(n) for n in names))
    print(f"{'metric':<15}" + "".join(f"{n[:w]:>{w + 2}}" for n in names))
    for key in ("bpm", "grid_off_ms"):
        print(f"{key:<15}" + "".join(f"{rows[n].get(key, float('nan')):>{w + 2}.1f}" for n in names))
    fails = 0
    print(f"{'style':<15}" + "".join(f"{styles[n]:>{w + 2}}" for n in names))
    for key in TARGETS:
        cells = []
        for n in names:
            v = rows[n].get(key)
            if v is None:
                cells.append(f"{'-':>{w + 2}}")
                continue
            # trap-hybrid has a switch-up where the others have the gap (C8)
            if key in ({"predrop_dbfs", "predrop_gap_beats", "gap_added_beats", "gap_db"} if raw[n] == "trap_hybrid"
                       else {"switch_db"}):
                cells.append(f"{'n/a':>{w + 2}}")
                continue
            info = key in INFO or (key in INFO_ON_MIX and n not in with_stems) or (key == "predrop_gap_beats"
                                                                                   and "gap_added_beats" in rows[n])
            g = "info" if info else grade(key, v, styles[n])
            fails += g == "FAIL" and n != "original-drop"
            cells.append(f"{v:>{w - 3}.2f} {g[0]}")
        print(f"{key:<15}" + "".join(f"{c:>{w + 2}}" for c in cells))
    targets = {**TARGETS, **STYLE_TARGETS.get(style, {})}
    lo_hi = "  ".join(f"{k} [{a:g}, {b:g}]±{c:g}" for k, (a, b, c) in targets.items())
    print(f"\nP/W/F = PASS / WARN / FAIL (i = informational, no stems); a render's grid.json sets its style, else --style "
          f"{style}: {lo_hi}")
    return 1 if fails else 0


def selftest() -> None:
    """Synthetic 16-bar clips at 140 BPM: the detector must flag a bass a bar late, a faded-in drop and clicks."""
    sr, bpm = 44100, 140.0
    beat = 60.0 / bpm
    n = int(16 * 4 * beat * sr)
    t = np.arange(n) / sr

    def song(bass_delay_bars: int = 0, fade: bool = False, clicks: bool = False) -> np.ndarray:
        rng = np.random.default_rng(1)
        x = np.zeros(n)
        for b in range(64):
            i = int(b * beat * sr)
            k = np.arange(min(int(0.15 * sr), n - i)) / sr
            x[i:i + len(k)] += 0.8 * np.sin(2 * np.pi * (50 + 80 * np.exp(-k / 0.02)) * k) * np.exp(-k / 0.08) * (1 - k / k[-1])
            if b % 2:
                h = min(int(0.03 * sr), n - i - int(beat / 2 * sr))
                x[i + int(beat / 2 * sr):][:h] += 0.1 * rng.standard_normal(h) * np.exp(-np.arange(h) / (0.005 * sr))
        notes = [41, 41, 44, 39]  # a 4-bar bass phrase that changes every bar
        drop0 = int(4 * 4 * beat * sr)
        for bar in range(12):
            src = bar - bass_delay_bars
            if src < 0:
                continue
            f = 440 * 2 ** ((notes[src % 4] - 69) / 12)
            a, z = drop0 + int(bar * 4 * beat * sr), drop0 + int((bar + 1) * 4 * beat * sr)
            wob = 0.5 + 0.5 * np.sin(2 * np.pi * t[a:z] / (beat / 2))
            edge = np.minimum(1.0, np.minimum(np.arange(z - a), np.arange(z - a)[::-1]) / (0.005 * sr))  # 5 ms fades
            x[a:z] += edge * (0.5 * np.sin(2 * np.pi * f * t[a:z]) + 0.15 * wob * np.sin(2 * np.pi * 2 * f * t[a:z]))
        if fade:
            x[drop0:drop0 + int(4 * beat * sr)] *= np.linspace(0, 1, int(4 * beat * sr))
        if clicks:
            for c in range(12):
                x[drop0 + int(c * 1.7 * sr) % (n - drop0)] += 0.6
        x = 0.5 * x / np.max(np.abs(x))
        return np.stack([x, x])

    ref = song()
    base = measure(ref, sr, bars=16, build_bars=4)
    rb = base.pop("_bass_bars")
    late = measure(song(bass_delay_bars=1), sr, bars=16, build_bars=4, ref_bass=rb)
    faded = measure(song(fade=True), sr, bars=16, build_bars=4, ref_bass=rb)
    clicky = measure(song(clicks=True), sr, bars=16, build_bars=4, ref_bass=rb)
    assert abs(base["bpm"] - bpm) < 0.01 and abs(base["grid_off_ms"]) < 5, base
    assert grade("bass_in_db", base["bass_in_db"]) == "PASS" and grade("clicks_min", base["clicks_min"]) == "PASS", base
    assert grade("bass_in_db", late["bass_in_db"]) == "FAIL" and late["bass_lag_bars"] == 1.0, late
    assert grade("drop_attack_db", faded["drop_attack_db"]) != "PASS", faded
    assert grade("clicks_min", clicky["clicks_min"]) == "FAIL", clicky
    buzz_e = np.zeros(sr * 2)  # HF power: an edge every 2 periods of C#1 (57.8 ms, wobbling +-5 %), then one click
    at, k = 0.1, 0
    while at < 1.5:
        buzz_e[int(at * sr)] = 1.0
        at += 2 / 34.65 * (1 + 0.05 * np.sin(k))
        k += 1
    assert _clicks(buzz_e, sr) == 0, "a low R1's two-period buzz read as clicks"
    buzz_e[int(1.8 * sr)] = 1.0
    assert _clicks(buzz_e, sr) == 1
    gap, bleed = ref.copy(), ref.copy()
    gap[:, int(15.5 * beat * sr):int(16 * beat * sr)] = 0  # silence into the drop (the kick before it decays first)
    bleed[:, int(15 * beat * sr):int(16 * beat * sr)] += 0.3 * np.sin(2 * np.pi * 55 * t[int(15 * beat * sr):int(16 * beat * sr)])
    gapped, bled = (measure(y, sr, bars=16, build_bars=4, bpm=bpm) for y in (gap, bleed))  # a build tail into beat 1
    assert grade("predrop_dbfs", bled["predrop_dbfs"]) == "FAIL" and grade("predrop_gap_beats", bled["predrop_gap_beats"]) == "FAIL", bled
    assert grade("predrop_dbfs", gapped["predrop_dbfs"]) == "PASS" and grade("predrop_gap_beats", gapped["predrop_gap_beats"]) == "PASS", gapped
    assert grade("gap_db", gapped["gap_db"]) == "PASS", gapped  # digital silence has no floor
    # stems: a clean sub vs one clipped hard, a squashed mid bus vs a spiky one, a kit 3 LU over the source's drums
    sine = np.sin(2 * np.pi * 43.65 * t)
    clean, dirty = stem_checks({"sub": np.stack([sine, sine])}, sr, 0), stem_checks({"sub": np.stack([np.clip(3 * sine, -1, 1)] * 2)}, sr, 0)
    assert grade("sub_purity_db", clean["sub_purity_db"]) == "PASS" and grade("sub_purity_db", dirty["sub_purity_db"]) == "FAIL", (clean, dirty)
    fm = np.tanh(3 * np.sin(2 * np.pi * 110 * t + 4 * np.sin(2 * np.pi * 110 * t)))  # a held, driven FM growl
    spikes = np.where(np.arange(len(t)) % int(beat * sr) == 0, 1.0, 0.0)  # sharp transients far over a quiet bed
    dense, spiky = stem_checks({"mid": np.stack([fm] * 2)}, sr, 0), stem_checks({"mid": np.stack([0.05 * fm + spikes] * 2)}, sr, 0)
    assert grade("mid_crest_db", dense["mid_crest_db"]) != "FAIL" and grade("mid_crest_db", spiky["mid_crest_db"]) == "FAIL", (dense, spiky)
    kit = stem_checks({"drums": ref * 10 ** (3 / 20), "source_drums": ref}, sr, 0)
    assert abs(kit["drums_lu"] - 3) < 0.1 and grade("drums_lu", kit["drums_lu"]) == "FAIL", kit
    # M2.4 on a mid stem at 145: a whining first hit, tearout without states or silence, riddim without a motif
    sr2, bpm2 = 48000, 145.0
    bar2, six2 = 240.0 / bpm2, 15.0 / bpm2
    tt = np.arange(int(4 * bar2 * sr2)) / sr2
    held = np.sin(2 * np.pi * 110 * tt) + 0.5 * np.sin(2 * np.pi * 330 * tt)
    whiny = low_checks(np.sin(2 * np.pi * np.cumsum(55 * 2 ** (24 / 12 * np.exp(-tt / 0.04))) / sr2), sr2, 0)
    clean = low_checks(np.sin(2 * np.pi * 55 * tt), sr2, 0)  # the low-end owner's first note: gliding down 2 octaves vs not
    assert grade("whine_st", whiny["whine_st"]) == "FAIL" and grade("whine_settle_ms", whiny["whine_settle_ms"]) == "FAIL", whiny
    assert all(grade(k, clean[k]) == "PASS" for k in ("whine_st", "whine_settle_ms", "whine_centroid_x")), clean
    shots = np.zeros_like(tt)
    for k, step in enumerate([0, 3, 5, 8, 10, 15] * 4):  # six shots a bar, each its own FM ratio, silence between
        i = int(((k // 6) * 16 + step) * six2 * sr2)
        ts = tt[: int(0.08 * sr2)]
        shots[i:i + len(ts)] = np.sin(2 * np.pi * 220 * ts + (2 + k % 6) * np.sin(2 * np.pi * 220 * (1.41 + 0.4 * (k % 6)) * ts)) * np.exp(-ts / 0.03)
    good, mush = mid_checks(shots, sr2, bpm2, 0), mid_checks(held * (0.6 + 0.4 * np.sin(2 * np.pi * tt / (bar2 / 8))), sr2, bpm2, 0)
    assert grade("hit_states_bar", good["hit_states_bar"], "tearout") == "PASS" and grade("silence_16_pct", good["silence_16_pct"], "tearout") == "PASS", good
    assert grade("silence_16_pct", mush["silence_16_pct"], "tearout") == "FAIL", mush
    rng = np.random.default_rng(3)
    random_bars = np.concatenate([np.sin(2 * np.pi * rng.uniform(80, 400) * tt[: int(bar2 * sr2)]) for _ in range(4)])
    assert grade("motif_sim", mid_checks(held, sr2, bpm2, 0)["motif_sim"], "riddim") == "PASS"
    assert grade("motif_sim", mid_checks(random_bars, sr2, bpm2, 0)["motif_sim"], "riddim") == "FAIL"
    # the bass under the snares: ducked 12 dB for 80 ms vs not at all
    snares = np.zeros_like(tt)
    for b in range(4):
        i = int((b * bar2 + 2 * 60 / bpm2) * sr2)
        snares[i:i + int(0.05 * sr2)] = rng.standard_normal(int(0.05 * sr2)) * np.exp(-np.arange(int(0.05 * sr2)) / (0.01 * sr2))
    duck = np.where(np.convolve(np.abs(snares) > 0, np.ones(int(0.08 * sr2)), "full")[: len(tt)] > 0, 0.25, 1.0)
    stems = lambda bass: {"drums": np.stack([snares] * 2), "mid": np.stack([bass] * 2)}  # noqa: E731
    assert grade("snare_duck_db", stem_checks(stems(held * duck), sr2, 0, bpm2)["snare_duck_db"]) == "PASS"
    assert grade("snare_duck_db", stem_checks(stems(held), sr2, 0, bpm2)["snare_duck_db"]) == "FAIL"
    one = take_features(np.stack([shots] * 2), sr2, bpm2, 0, 4)
    assert grade("take_sim", float(one @ one)) == "FAIL" and grade("take_sim", float(one @ take_features(np.stack([random_bars] * 2), sr2, bpm2, 0, 4))) == "PASS"
    # S2's calibration asks: a held sub doesn't hide the mid's duck (the snare checks read mid.wav only); onsets per bar
    # flag a static drone and a 1/32 mush but pass a 1/16 line; the gap is graded over the source's own
    sub_held = 0.8 * np.sin(2 * np.pi * 45 * tt)
    assert grade("snare_duck_db", stem_checks({**stems(held * duck), "sub": np.stack([sub_held] * 2)}, sr2, 0, bpm2)["snare_duck_db"]) == "PASS"
    notes = lambda div: np.sin(2 * np.pi * 110 * tt) * (np.mod(tt, 240.0 / bpm2 / div) < 0.6 * 240.0 / bpm2 / div)  # noqa: E731
    assert grade("onsets_bar", onsets_per_bar(notes(16), sr2, 4)) == "PASS", onsets_per_bar(notes(16), sr2, 4)
    assert grade("onsets_bar", onsets_per_bar(held, sr2, 4)) == "FAIL" and grade("onsets_bar", onsets_per_bar(notes(32), sr2, 4)) == "FAIL"
    beat2 = 60.0 / bpm2
    bed = np.stack([np.sin(2 * np.pi * 220 * np.arange(int(8 * bar2 * sr2)) / sr2)] * 2) * 0.3  # 4 bars in, 4 of drop
    def cut(y, beats):
        y = y.copy()
        y[:, int((4 * bar2 - beats * beat2) * sr2):int(4 * bar2 * sr2)] = 0
        return y
    src35, ours35, ours5 = cut(bed, 3.5), cut(bed, 3.5), cut(bed, 5.0)  # the drop at bar 4
    kept = bible_checks(bed, sr2, bpm2, 0.0, 4 * bar2, 4, None, quiet=ours35, source_quiet=src35)
    grown = bible_checks(bed, sr2, bpm2, 0.0, 4 * bar2, 4, None, quiet=ours5, source_quiet=src35)
    assert grade("gap_added_beats", kept["gap_added_beats"]) == "PASS" and grade("predrop_gap_beats", kept["predrop_gap_beats"]) == "FAIL", kept
    assert grade("gap_added_beats", grown["gap_added_beats"]) == "FAIL", grown
    # REMIX_HARMONY 6.6: a sub at 432 Hz on its roots vs one on A=440 and off its root; notes off the chord; a kick
    # ringing 0.5 st from the sub vs one that's 30 dB down by 150 ms
    fs_ = 46.25 * 2 ** (-31.7 / 1200)  # F#1 at 432
    harm = {"tuning_cents": -31.7, "key": "F#m", "chords": [[0.0, 6, "m"], [2 * bar2, 2, "M"]]}
    sub_ok = np.where(tt < 2 * bar2, np.sin(2 * np.pi * fs_ * tt), np.sin(2 * np.pi * fs_ * 2 ** (-4 / 12) * tt))
    half = int(120 / bpm2 * sr2)  # bar 3's first half: D for 90 %, then a slide up to E (a kept 808's)
    slide = 2 * np.pi * np.cumsum(np.where(np.arange(half) < 0.9 * half, 36.71, 36.71 * 2 ** (2 / 12 * np.clip((np.arange(half) - 0.9 * half) / (0.1 * half), 0, 1)))) / sr2
    a2 = int(2 * bar2 * sr2)
    sub_ok[a2:a2 + half] = np.sin(slide) * 1.0
    good = harmony_checks({"sub": np.stack([sub_ok] * 2)}, sr2, 0, bpm2, {**harm, "tuning_cents": 0.0,
                          "chords": [[0.0, 6, "m"], [2 * bar2, 2, "M"]]})
    assert good["sub_root_pct"] == 1.0, good  # the slide's half-bar reads its held D
    good = harmony_checks({"sub": np.stack([np.where(tt < 2 * bar2, np.sin(2 * np.pi * fs_ * tt), np.sin(2 * np.pi * fs_ * 2 ** (-4 / 12) * tt))] * 2)},
                          sr2, 0, bpm2, harm)
    bad = harmony_checks({"sub": np.stack([np.sin(2 * np.pi * 46.25 * tt)] * 2)}, sr2, 0, bpm2, harm)
    assert abs(good["tuning_dev_c"]) < 1.0 and grade("sub_root_pct", good["sub_root_pct"]) == "PASS", good
    assert grade("tuning_dev_c", bad["tuning_dev_c"]) == "FAIL" and grade("sub_root_pct", bad["sub_root_pct"]) == "FAIL", bad
    notes_in = [[b * 0.2, 0.2, m, None, False] for b, m in enumerate([42, 45, 49, 42, 45, 49])]  # F#, A, C#
    notes_out = notes_in + [[1.4, 0.4, 44, None, False], [1.8, 0.4, 47, None, False], [2.2, 1.0, 43, None, True]]
    assert harmony_checks({}, sr2, 0, bpm2, {**harm, "notes": notes_in})["chord_tone_pct"] == 1.0
    assert grade("chord_tone_pct", harmony_checks({}, sr2, 0, bpm2, {**harm, "notes": notes_out})["chord_tone_pct"]) == "FAIL"
    k_t = tt[: int(0.3 * sr2)]
    kick = lambda tail: np.sin(2 * np.pi * np.cumsum(49.0 + 100 * np.exp(-k_t / 0.025)) / sr2) * np.exp(-k_t / 0.09) * tail  # noqa: E731
    gate = np.clip((0.15 - k_t) / 0.05, 10 ** (-40 / 20), 1)
    for tail, want in ((1.0, 1.0), (gate, 0.0)):
        drums = np.zeros_like(tt)
        drums[: len(k_t)] = kick(tail)
        kb = harmony_checks({"drums": np.stack([drums] * 2), "sub": np.stack([np.sin(2 * np.pi * 47.6 * tt)] * 2)}, sr2, 0,
                            bpm2, {"kicks_s": [0.0]})
        assert kb["kick_beats"] == want, (kb, want)
    print("selftest ok: a bar-late bass, a faded-in drop, no pre-drop gap, a grown gap, clicks, a dirty sub, a spiky mid bus, loud drums, a whine, a "
          "stateless or gapless tearout, a motif-less riddim, an unducked snare (a held sub no alibi), a drone or a 1/32 mush of onsets and a repeated take, a sub off its tuning or its root, notes off their chords and a beating kick are all flagged")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("folder", nargs="?", type=Path)
    ap.add_argument("--bars", type=int, default=16)
    ap.add_argument("--build-bars", type=int, default=4)
    ap.add_argument("--bpm", type=float, default=None, help="all clips' tempo (default: from each clip's length)")
    ap.add_argument("--style", choices=sorted([*STYLE_TARGETS, *ALIASES]), default="tearout",
                    help="which §5 targets to grade against when a render has no grid.json (trap_hybrid: the switch-up, no gap)")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest or a.folder is None:
        selftest()
    else:
        sys.exit(scorecard(a.folder, a.bars, a.build_bars, a.bpm, a.style))
