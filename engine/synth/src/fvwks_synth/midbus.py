"""The shared REMIX sound-design DSP (docs/REMIX_SOUND_BIBLE.md §1.1-§1.3), numpy/scipy only. Everyone's voices use it:
S3's tearout, S1's riddim / 808, S2's resample passes.

  lr4(x, hz, sr, kind)            Linkwitz-Riley 4th order (two cascaded 2nd-order Butterworths): the 120 Hz crossover
  distort(x, drive_db, mode)      tanh / hard / diode, 4x oversampled (plain tanh or clip at the base rate aliases)
  clip(x, reduction_db)           hard clip taking `reduction_db` off the peaks, 4x oversampled
  ott(x, sr, depth)               OTT, the Faust co.xfer_ott model with the §1.3 numbers (3 bands, up + down)
  phaser / flanger / freq_shift   the movement FX of the §1.2 chain
  midbus(x, sr, preset, bpm)      the §1.2 MID chain, level-matched after every stage (denser, not louder)
  resonance_notch(x, sr)          the tallest 2-4 kHz peak notched -4..-8 dB at Q 8, plus a 3.5 dB dynamic cut there
  chain_a / resample_chain        Marauda's tearout chain A (fingerprints §2 A2-A7), re-run 3-5 times, every generation
                                  kept, plus one mangle (a phase-vocoder stretch or a formant-free pitch shift)
  AXES / pick(rng, axis)          the choices research disagrees on ({axis id: {option: default weight}}, plan v2 §4):
                                  BUILD resolves them per take through choose() and passes them down; pick() is the
                                  seeded fallback when nothing was resolved (auditions)
  sub_hz(midi) / sub_voice(...)   the clean SUB: a sine with its root forced into C1-A1, gated, LR4 120 Hz

Signals are (n,) or (channels, n) float arrays; every function works along the last axis and keeps the shape.
"""

from __future__ import annotations

import math

import numpy as np
from scipy import signal

OS = 4
CROSSOVER_HZ = 120.0
EPS = 1e-12


def lr4(x: np.ndarray, hz: float, sr: int, kind: str) -> np.ndarray:
    sos = signal.butter(2, hz, kind, fs=sr, output="sos")
    return signal.sosfilt(sos, signal.sosfilt(sos, x, axis=-1), axis=-1)


def _rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(x)))) + EPS


def _match(y: np.ndarray, ref: np.ndarray) -> np.ndarray:
    """`y` at `ref`'s RMS: a stage makes the sound denser, never just louder."""
    return y * (_rms(ref) / _rms(y))


def _oversampled(fn, x: np.ndarray) -> np.ndarray:
    return signal.resample_poly(fn(signal.resample_poly(x, OS, 1, axis=-1)), 1, OS, axis=-1)[..., : x.shape[-1]]


def distort(x: np.ndarray, drive_db: float, mode: str = "tanh") -> np.ndarray:
    """`drive_db` of gain into a tanh (soft), hard clip, or diode (asymmetric) curve, at 4x the rate; level-matched."""
    g = 10 ** (drive_db / 20)
    curves = {
        "tanh": lambda y: np.tanh(g * y),
        "hard": lambda y: np.clip(g * y, -1.0, 1.0),
        "diode": lambda y: np.where(y > 0, 1 - np.exp(-g * y), -(1 - np.exp(0.6 * g * y)) / 0.6 * 0.8),
    }
    return _match(_oversampled(curves[mode], x), x)


def clip(x: np.ndarray, reduction_db: float) -> np.ndarray:
    """A hard clip taking `reduction_db` off the peaks (the §1.2 end stage: 1-3 dB on a bus), at 4x the rate."""
    ceiling = float(np.max(np.abs(x))) * 10 ** (-reduction_db / 20) + EPS
    return _oversampled(lambda y: np.clip(y, -ceiling, ceiling), x)


# ------------------------------------------------------------------------------------------------------------- OTT

# (downward threshold dB, downward ratio, upward threshold dB, attack s, release s, output gain dB) per band
OTT_BANDS = ((-33.8, 66.7, -40.8, 0.0478, 0.282, 10.3),  # low, below 88.3 Hz
             (-30.3, 66.7, -41.8, 0.0224, 0.282, 5.7),  # mid
             (-35.5, math.inf, -40.8, 0.0135, 0.132, 10.3))  # high, above 2.5 kHz
OTT_UP_RATIO, OTT_UP_MAX_DB, OTT_INPUT_DB = 4.0, 36.0, 5.2
CONTROL = 16  # the detector runs every 16 samples (3 kHz at 48 kHz) and the gain is interpolated back


def _follow(power: np.ndarray, sr: int, attack: float, release: float) -> np.ndarray:
    """A one-pole attack / release follower on the (stereo-linked) power, at the control rate, looking ahead by the
    attack time: the level (and so the gain) moves with a sudden band change, not `attack` after it. (Without it, a band
    that fills up again after a quiet moment comes through at up to +36 dB of upward gain for ~13 ms: a burst.)"""
    blocks = power[: len(power) // CONTROL * CONTROL].reshape(-1, CONTROL).mean(axis=1)
    if len(power) % CONTROL:
        blocks = np.append(blocks, power[len(power) // CONTROL * CONTROL:].mean())
    rate = sr / CONTROL
    a, r = math.exp(-1 / (attack * rate)), math.exp(-1 / (release * rate))
    env = np.empty_like(blocks)
    e = float(blocks[: max(1, int(attack * rate))].mean())  # ponytail: starts settled (a live OTT pops a note's onset)
    for i, p in enumerate(blocks):
        e = (a if p > e else r) * e + (1 - (a if p > e else r)) * p
        env[i] = e
    ahead = max(1, int(attack * rate))
    env = np.concatenate([env[ahead:], np.full(ahead, env[-1])])  # ponytail: look-ahead = attack (the Faust model has none)
    return np.interp(np.arange(len(power)), (np.arange(len(env)) + 0.5) * CONTROL, env)


def ott(x: np.ndarray, sr: int, depth: float = 0.5, time: float = 1.0) -> np.ndarray:
    """OTT: LR4 bands at 88.3 Hz / 2.5 kHz, each pulled down above its downward threshold and up (4:1, at most +36 dB)
    below its upward one, with the Faust model's thresholds, ratios, attack / release (`time` scales the release),
    input +5.2 dB and output gains. `depth` 0-1 is the wet / dry blend. The detector is stereo-linked."""
    stereo = x.ndim == 2
    y = x * 10 ** (OTT_INPUT_DB / 20)
    low = lr4(y, 88.3, sr, "lowpass")
    high = lr4(y, 2500.0, sr, "highpass")
    wet = np.zeros_like(y)
    for band, (dt, dr, ut, att, rel, out_db) in zip((low, y - low - high, high), OTT_BANDS):
        power = np.mean(np.square(band), axis=0) if stereo else np.square(band)
        level = 10 * np.log10(_follow(power, sr, att, rel * time) + EPS)
        down = np.where(level > dt, (dt + (level - dt) / dr) - level, 0.0)
        up = np.where(level < ut, np.minimum((ut - level) * (1 - 1 / OTT_UP_RATIO), OTT_UP_MAX_DB), 0.0)
        up = np.where(level < -90, 0.0, up)  # silence stays silent (no +36 dB noise floor)
        wet += band * 10 ** ((down + up + out_db) / 20)
    return x * (1 - depth) + wet * depth


# --------------------------------------------------------------------------------------------------- movement FX


def phaser(x: np.ndarray, sr: int, rate_hz: float, feedback: float = 0.6, mix: float = 0.5, stages: int = 4) -> np.ndarray:
    """`stages` 2nd-order allpasses swept 300 Hz - 3 kHz by a sine LFO (spread a fifth apart), their Q standing in for the
    feedback (sharper notches), updated every 32 samples with their state carried: no feedback loop, so no block steps
    (the old one fed the last sample back into a whole block and zippered)."""
    n = x.shape[-1]
    t = np.arange(n) / sr
    fc = 300 * 10 ** (0.5 + 0.5 * np.sin(2 * np.pi * rate_hz * t))
    q = 0.5 + 2.0 * feedback
    flat = x.reshape(-1, n)
    out = np.empty_like(flat)
    for c, ch in enumerate(flat):
        zs = [np.zeros(2) for _ in range(stages)]
        y = np.empty(n)
        for i in range(0, n, 32):
            blk = ch[i:i + 32]
            for s_ in range(stages):
                w = 2 * math.pi * min(float(fc[i]) * 1.5 ** s_, 0.45 * sr) / sr
                alpha, cw = math.sin(w) / (2 * q), math.cos(w)
                b = np.array([1 - alpha, -2 * cw, 1 + alpha]) / (1 + alpha)
                a = np.array([1.0, -2 * cw / (1 + alpha), (1 - alpha) / (1 + alpha)])
                blk, zs[s_] = signal.lfilter(b, a, blk, zi=zs[s_])
            y[i:i + 32] = blk
        out[c] = (1 - mix) * ch + mix * y
    return out.reshape(x.shape)


def flanger(x: np.ndarray, sr: int, delay_ms: float = 2.0, depth_ms: float = 1.0, rate_hz: float = 0.5,
            feedback: float = 0.7, mix: float = 0.5) -> np.ndarray:
    """A modulated delay (delay_ms ± depth_ms) with feedback, mixed in. Computed in chunks shorter than the shortest
    delay, so the feedback stays vectorised."""
    n = x.shape[-1]
    t = np.arange(n) / sr
    d = (delay_ms + depth_ms * np.sin(2 * np.pi * rate_hz * t)) * sr / 1000
    step = max(1, int((delay_ms - depth_ms) * sr / 1000) - 1)
    flat = x.reshape(-1, n)
    out = np.empty_like(flat)
    idx = np.arange(n)
    for c, ch in enumerate(flat):
        y = np.zeros(n)
        for i in range(0, n, step):
            j = idx[i:i + step]
            src = j - d[i:i + step]
            y[i:i + step] = ch[i:i + step] + feedback * np.interp(src, idx[:i] if i else [0.0], y[:i] if i else [0.0],
                                                                   left=0.0)
        out[c] = (1 - mix) * ch + mix * _match(y, ch)
    return out.reshape(x.shape)


def moving_comb(x: np.ndarray, hz: np.ndarray, fb: float, sr: int) -> np.ndarray:
    """A feedback comb (Comb+; riddim R1, the growls' comb, chain A) whose delay (1/hz, interpolated) moves, run in blocks shorter than the delay."""
    n = len(x)
    d = sr / np.clip(hz, 50.0, sr / 4)
    step = max(1, int(d.min()) - 1)  # every read in a block lands before it
    y = np.zeros(n)
    idx = np.arange(n)
    for i in range(0, n, step):
        r = idx[i:i + step] - d[i:i + step]
        k = np.floor(r).astype(int)
        a = r - k
        past = np.where(k >= 0, (1 - a) * y[np.maximum(k, 0)] + a * y[np.maximum(k + 1, 0)], 0.0)
        y[i:i + step] = x[i:i + step] + fb * past
    return y * (1 - fb)


def octave_of(hz: float, f0: float) -> float:
    """f0 times the power of 2 nearest `hz` (k = 1, 2, 4 ...): a comb's pitch on the note (REMIX_HARMONY 1.4)."""
    return f0 * 2.0 ** max(0, round(np.log2(hz / f0)))


def harmonic_of(hz, f0: float):
    """The harmonic of f0 nearest `hz` (per sample too): where a high-Q resonator may ring (REMIX_HARMONY 1.4)."""
    return np.maximum(1, np.round(np.asarray(hz) / f0)) * f0


def harmonic_shift(hz: float, f0: float) -> float:
    """The shift nearest `hz` (its sign kept) that keeps a held note harmonic: m f0 / 2 (REMIX_HARMONY 1.4)."""
    return float(np.sign(hz) * max(1, round(abs(hz) / (f0 / 2))) * f0 / 2)


def freq_shift(x: np.ndarray, sr: int, shift_hz: np.ndarray | float) -> np.ndarray:
    """Single-sideband frequency shift (every partial moved by `shift_hz`, per sample or constant): inharmonic."""
    t = np.arange(x.shape[-1]) / sr
    phase = 2 * np.pi * (np.cumsum(np.broadcast_to(shift_hz, t.shape)) / sr)
    return np.real(signal.hilbert(x, axis=-1) * np.exp(1j * phase))


# --------------------------------------------------------------------------------------------------------- EQ


def _peak(x: np.ndarray, sr: int, hz: float, gain_db: float, q: float) -> np.ndarray:
    """An RBJ peaking EQ."""
    a = 10 ** (gain_db / 40)
    w = 2 * math.pi * hz / sr
    alpha = math.sin(w) / (2 * q)
    b = [1 + alpha * a, -2 * math.cos(w), 1 - alpha * a]
    den = [1 + alpha / a, -2 * math.cos(w), 1 - alpha / a]
    return signal.lfilter(np.array(b) / den[0], np.array(den) / den[0], x, axis=-1)


def notch_whistles(x: np.ndarray, sr: int, max_notches: int = 2, cut_db: float = -6.0) -> np.ndarray:
    """Find the 1-2 resonance whistles (1-5 kHz, 1/3-octave bands > 6 dB over their neighbours' mean) and notch them."""
    mono = x.reshape(-1, x.shape[-1]).mean(axis=0)
    f, p = signal.welch(mono, sr, nperseg=4096)
    centres = 1000 * 2 ** (np.arange(0, 7.5) / 3)
    level = np.array([10 * np.log10(p[(f >= c / 2 ** (1 / 6)) & (f < c * 2 ** (1 / 6))].mean() + EPS) for c in centres])
    over = [(level[i] - (level[i - 1] + level[i + 1]) / 2, c) for i, c in enumerate(centres) if 0 < i < len(centres) - 1]
    for excess, c in sorted(over, reverse=True)[:max_notches]:
        if excess > 6.0:
            x = _peak(x, sr, c, cut_db, 8.0)
    return x


def resonance_notch(x: np.ndarray, sr: int, q: float = 8.0, cut_db: float = 3.5) -> np.ndarray:
    """Chain A step 10 (fingerprints §2, §4.3), on every growl and gun: the tallest peak in 2-4 kHz notched by how far it
    stands over the band's median (-4..-8 dB) at Q `q`, then the 2-4 kHz band cut by up to `cut_db` on the loudest
    frames (within 6 dB of its peak; zero-phase, so the cut subtracts cleanly)."""
    mono = x.reshape(-1, x.shape[-1]).mean(axis=0)
    if len(mono) < 2048:
        return x
    f, p = signal.welch(mono, sr, nperseg=min(8192, len(mono)))
    band = (f >= 2000.0) & (f <= 4000.0)
    db = 10 * np.log10(p[band] + EPS)
    i = int(np.argmax(db))
    x = _peak(x, sr, float(f[band][i]), -float(np.clip(db[i] - np.median(db), 4.0, 8.0)), q)
    hot = signal.sosfiltfilt(signal.butter(2, (2000.0, 4000.0), "bandpass", fs=sr, output="sos"), x, axis=-1)
    env = 10 * np.log10(np.convolve(np.square(hot.reshape(-1, hot.shape[-1])).mean(axis=0), np.ones(int(0.005 * sr)) / int(0.005 * sr), "same") + EPS)
    amount = np.clip((env - (env.max() - 6.0)) / 6.0, 0.0, 1.0)
    return x - hot * amount * (1 - 10 ** (-cut_db / 20))


# ------------------------------------------------------------------------------------------------------ the chain

PRESETS: dict[str, dict] = {
    # §1.2 on a design print (tearout / riddim prints: total drive 24-30 dB is in style)
    "print": {"dist1_db": 20.0, "dist1_mode": "hard", "fx": "flanger", "dist2_db": 8.0, "ott": 0.8, "clip_db": 3.0},
    # §2.2 voice A: Distortion 24 dB → OTT 1.0 → clip → HP → OTT 0.5 → notch whistles
    "chomp": {"dist1_db": 24.0, "dist1_mode": "hard", "fx": None, "dist2_db": 6.0, "ott": 1.0, "clip_db": 3.0},
    # §2.2 voice B: Distortion 18-24 dB → Phaser 1/2, fb 0.6, mix 0.5
    "talker": {"dist1_db": 20.0, "dist1_mode": "diode", "fx": "phaser", "dist2_db": 8.0, "ott": 0.8, "clip_db": 2.0},
    # the mid bus itself: gentle
    "bus": {"dist1_db": 0.0, "dist1_mode": "tanh", "fx": None, "dist2_db": 0.0, "ott": 0.5, "clip_db": 1.5},
}


def midbus(x: np.ndarray, sr: int, preset: str | dict = "print", bpm: float = 145.0) -> np.ndarray:
    """The §1.2 MID chain: LR4 HP 120 → distortion #1 (4x) → movement FX → distortion #2 (tanh, 4x) → OTT → EQ (HP 120
    again, -3 dB @ 400 Hz Q 1, the whistles notched, -2 dB @ 3 kHz) → clip (4x) → raised-cosine edges (3 ms in, 10 ms
    out). Level-matched after every stage.
    The sidechain is the arrangement's (S2): it knows every hit."""
    p = PRESETS[preset] if isinstance(preset, str) else preset
    ref = x
    y = lr4(x, CROSSOVER_HZ, sr, "highpass")
    if p.get("dist1_db"):
        y = distort(y, p["dist1_db"], p.get("dist1_mode", "hard"))
    fx = p.get("fx")
    if fx == "flanger":
        y = flanger(y, sr, 2.0, 1.0, bpm / 60 / 4, 0.7, 0.5)
    elif fx == "phaser":
        y = _match(phaser(y, sr, bpm / 60 / 2, 0.6, 0.5), y)  # rate 1/2: a cycle every two beats
    if p.get("dist2_db"):
        y = distort(y, p["dist2_db"], "tanh")
    if p.get("ott"):
        y = _match(ott(y, sr, p["ott"]), y)
    y = lr4(y, CROSSOVER_HZ, sr, "highpass")
    y = notch_whistles(_peak(_peak(y, sr, 400.0, -3.0, 1.0), sr, 3000.0, -2.0, 0.8), sr)
    if p.get("clip_db"):
        y = clip(y, p["clip_db"])
    y = _match(y, ref)
    n = y.shape[-1]  # the filters ring past the note: raised-cosine edges, 3 ms in / 10 ms out (M1.16, S1's finding)
    a, r = min(n // 4, int(0.003 * sr)), min(n // 4, int(0.010 * sr))
    y[..., :a] *= 0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, a))
    y[..., n - r:] *= 0.5 + 0.5 * np.cos(np.linspace(0.0, np.pi, r))
    return y


# ------------------------------------------------------------------------------------- resampling (tearout chain A)

# "There isn't always a correct answer": where the research disagrees, each option is a seeded pick at a default weight
# (M4.3 learns the weights from the user's takes). QA must pass for every option.
AXES: dict[str, dict[str, float]] = {  # AX-25
    "resample.passes": {"3": 0.6, "5": 0.4},  # Marauda: "3-5 times"
    "resample.movement": {"shift": 0.4, "comb": 0.3, "phaser": 0.3},  # chain A step 4: Subtronics / comb / phaser
    "resample.mangle": {"stretch": 0.5, "pitch": 0.5},  # step 9: a phase-vocoder smear, or a pitch shift moving formants
}


def pick(rng: np.random.Generator, axis: str, weights: dict | None = None) -> str:
    w = weights or AXES[axis]
    keys = list(w)
    p = np.array([w[k] for k in keys], float)
    return keys[int(rng.choice(len(keys), p=p / p.sum()))]


def chain_a(x: np.ndarray, sr: int, rng: np.random.Generator, bpm: float = 145.0, movement: str | None = None,
            f0: float | None = None) -> np.ndarray:
    """One pass of tearout chain A, steps 2-7 (fingerprints §2): an asymmetric drive 12-18 dB (4x) → HP 90 Hz, +3 dB at
    1-1.5 kHz, -3 dB at 400 Hz → a movement stage (a frequency shift ±30-200 Hz, a 2-8 ms comb at feedback 0.7, or a
    1/2-rate phaser at 60 %, 50 % mix) → OTT 0.4 → a hard clip 6-12 dB into the ceiling (4x) → -1 dBFS. With the note's
    `f0` (a held print) the shift is m f0 / 2 and the comb on an octave of f0, so it stays in key; without (a shot of
    1/8 or less) they're free."""
    y = distort(x, float(rng.uniform(12, 18)), "diode")
    y = _peak(_peak(lr4(y, 90.0, sr, "highpass"), sr, float(rng.uniform(1000, 1500)), 3.0, 1.0), sr, 400.0, -3.0, 1.0)
    move = movement or pick(rng, "resample.movement")
    if move == "shift":
        hz = float(rng.choice([-1, 1]) * rng.uniform(30, 200))
        y = freq_shift(y, sr, harmonic_shift(hz, f0) if f0 else hz)
    elif move == "comb":
        d = int(rng.uniform(0.002, 0.008) * sr)
        if f0:
            hz = np.full(y.shape[-1], octave_of(sr / d, f0))
            y = _match(np.stack([moving_comb(c, hz, 0.7, sr) for c in y.reshape(-1, y.shape[-1])]).reshape(y.shape), y)
        else:
            y = _match(signal.lfilter([1.0], np.r_[1.0, np.zeros(d - 1), -0.7], y, axis=-1), y)
    else:
        y = _match(phaser(y, sr, bpm / 60 / 2, 0.6, 0.5), y)
    y = clip(_match(ott(y, sr, 0.4), y), float(rng.uniform(6, 12)))
    return y * 10 ** (-1 / 20) / (np.max(np.abs(y)) + EPS)


def stretch(x: np.ndarray, factor: float, n_fft: int = 2048, hop: int = 256) -> np.ndarray:
    """A phase-vocoder time stretch by `factor` (> 1 is longer): the metallic smear of Marauda's Ableton stretch."""
    _, _, z = signal.stft(x, nperseg=n_fft, noverlap=n_fft - hop, axis=-1)
    at = np.arange(0, z.shape[-1] - 1, 1 / factor)
    i, frac = at.astype(int), (at % 1)
    mag = (1 - frac) * np.abs(z[..., i]) + frac * np.abs(z[..., i + 1])
    expect = 2 * np.pi * hop * np.arange(z.shape[-2]) / n_fft
    dphi = np.angle(z[..., i + 1]) - np.angle(z[..., i]) - expect[:, None]
    phase = np.angle(z[..., :1]) + np.cumsum(expect[:, None] + (dphi + np.pi) % (2 * np.pi) - np.pi, axis=-1)
    _, y = signal.istft(mag * np.exp(1j * phase), nperseg=n_fft, noverlap=n_fft - hop)
    return y[..., : int(x.shape[-1] * factor)]


def resample_chain(x: np.ndarray, sr: int, seed: int = 0, passes: int | None = None, chain=chain_a,
                   mangle: str | None = None, bpm: float = 145.0, movement: str | None = None,
                   f0: float | None = None) -> list[np.ndarray]:
    """Marauda's resampling (chain A steps 2-9): `chain` run on its own output `passes` times (3 or 5 by the seed),
    returning EVERY generation (the variant family for bars 9-16), then one mangle of the last: a 2-4x phase-vocoder
    stretch (cut back to length) or a pitch shift by a just 4th or 5th, up or down, without formant correction
    (varispeed: a power interval, in key; `f0` goes to the chain). Each output is
    resonance-notched, HP 120 Hz and at -1 dBFS. Offline: print one-shot banks with it, not per note."""
    rng = np.random.default_rng(seed)
    gens, y = [], x
    for _ in range(passes or int(pick(rng, "resample.passes"))):
        y = chain(y, sr, rng, bpm, movement, f0)
        gens.append(y)
    if (mangle or pick(rng, "resample.mangle")) == "stretch":
        m = stretch(y, float(rng.uniform(2, 4)))[..., : y.shape[-1]]
    else:
        up, down = [(3, 2), (4, 3), (3, 4), (2, 3)][int(rng.integers(4))]  # the pitch times up / down
        m = signal.resample_poly(y, down, up, axis=-1)[..., : y.shape[-1]]  # higher = shorter, formants move with it
    gens.append(m)
    out = []
    for g in gens:
        g = lr4(resonance_notch(g, sr), CROSSOVER_HZ, sr, "highpass")
        out.append(g * 10 ** (-1 / 20) / (np.max(np.abs(g)) + EPS))
    return out


# -------------------------------------------------------------------------------------------------------- the sub


def sub_hz(midi: float) -> float:
    """The root folded into 30-60 Hz, an octave at a time: C1-A1 (32.7-55 Hz), and B0 / A#1 for B / A#."""
    hz = 440.0 * 2 ** ((midi - 69) / 12)
    while hz >= 60.0:
        hz /= 2
    while hz < 30.0:
        hz *= 2
    return hz


def sub_voice(hz: np.ndarray | float, n: int, sr: int, attack_s: float = 0.0025, release_s: float = 0.015) -> np.ndarray:
    """The clean SUB: a sine (continuous phase through any glide in `hz`), gated A 2-3 ms / R 10-20 ms, LR4 low-passed
    at 120 Hz. Mono (n,). Never OTT, clipped or wobbled."""
    f = np.broadcast_to(np.asarray(hz, float), (n,))
    y = lr4(np.sin(2 * np.pi * np.cumsum(f) / sr), CROSSOVER_HZ, sr, "lowpass")
    a, r = min(n // 2, int(attack_s * sr)), min(n // 2, int(release_s * sr))
    y[:a] *= 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, a))  # the gate after the filter: its delay can't outrun the fade
    y[n - r:] *= 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, r))
    return y
