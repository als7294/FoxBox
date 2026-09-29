"""RIDDIM's two voices (docs/REMIX_SOUND_BIBLE.md §2.1) as growl engines, (f, t, sr, bpm, v, f0) -> the MID layer,
for growls.render_growl ("riddim" = R1, "yoi" = R2). One note each, mono, the LFO restarted on the note.

  R1 "square-FM wub"  a 50 % square phase-modulated by a sine (FM 2>1): rasp
                      ~20 % at rest, swept to 45-90 % by the LFO (AXES); a +12 st click over the first ~30 ms; Comb+ (70 %
                      feedback, 60 % mix) on the note's octave nearest the take's 330 / 440 / 600 Hz (a comb is a
                      pitch: REMIX_HARMONY §1.4), swept by the LFO from an octave under to a 12th over (both in key); a 24 dB low-pass, the muffled top (5 kHz, or
                      following the LFO, 600 Hz - 6 kHz: AXES); as an option (riddim.shift), a +-20-80 Hz freq shift
                      with a 1/64 echo at 25 %; a flanger whose mix follows a second LFO at half the rate; drive (4x oversampled) and OTT; the amp
                      wubs 60-100 %. The LFO is an exponential saw-down: open at each cycle's start, shut for its last
                      30 %. The variant is the LFO rate: 1/4, 1/4T, 1/8, 1/8T, one per note from the take's pool
                      (rate_variants(axes): riddim's "wonky" rate switching).
  R2 "yoi"            a saw through two parallel band-passes (Q 9) on vowel formants F1/F2, sweeping u -> a -> i (or
                      i -> o -> i) once per LFO cycle (gliding back in its last 15 %), then drive and OTT. It sits
                      30-50 % under R1 (r2_blend(axes)).

  AXES / option(axes, axis)  the options research disagrees on (R1's rate pool, throat and comb, R2's blend), resolved
                      per take by BUILD and passed in as `axes`; r1 takes them through render_growl(..., axes=...)

  render_squeak(midi, beats, bpm, sr, variant, octaves=1)  the top squeak layer (fingerprints §1 step 10): R1 an
                      octave or two up, band-passed 2-5 kHz, 10 dB under the wub, a little wide
  late_with_delay(x, sr, bpm, late="1/32", time="1/16", feedback=0.4, repeats=3)  an off-grid "d" hit: pushed late,
                      with a short feedback tail, each echo darker
"""

from __future__ import annotations

import numpy as np
from scipy import ndimage, signal

from .foxsynth import sync_hz
from .midbus import freq_shift, harmonic_of, harmonic_shift, moving_comb, octave_of, pick

R1_RATES = ("1/4", "1/4T", "1/8", "1/8T")
# The choices sources disagree on (plan v2 §4: "there isn't always a correct answer"): BUILD resolves them per take
# through choose() and passes them down as `axes`; ratings move the weights.
AXES: dict[str, dict[str, float]] = {
    "riddim.r1_rates": {"all": 0.5, "straight": 0.25, "triplet": 0.25},  # the pool each note's LFO rate comes from
    "riddim.r1_throat": {"1": 0.6, "0.5": 0.4},  # R1's osc2 : osc1 (FM 2>1; 0.5 is throatier)
    "riddim.r1_comb_hz": {"330": 0.3, "440": 0.4, "600": 0.3},  # R1's Comb+ register (the Bible's 300-900 Hz): midbus.octave_of
    # R1's timbre movement per beat (the bible's §5 check wants >= 150 Hz on the riddim bus): the recipe's FM peak
    # (~40 %) and static top barely move the centroid (6-14 Hz a beat), so a stronger sweep and a top that follows
    # the LFO are the likelier takes; the recipe's own stays an option.
    "riddim.r1_fm_peak": {"0.45": 0.3, "0.7": 0.4, "0.9": 0.3},  # R1's FM depth at the LFO's peak (at rest 0.1-0.2)
    "riddim.r1_top": {"lfo": 0.6, "static": 0.4},  # R1's 24 dB top: follows the LFO (1.25 -> 5 kHz), or 5 kHz
    "riddim.r2_blend": {"0.3": 0.3, "0.4": 0.4, "0.5": 0.3},  # R2's gain under R1
    "riddim.shift": {"off": 0.5, "on": 0.5},  # R1 through FP's freq shift + a short delay (M1.4a); a tie keeps "off"
}
RATE_POOLS = {"all": (0, 1, 2, 3), "straight": (0, 2), "triplet": (1, 3)}  # variants (R1_RATES indices)


def option(axes: dict[str, str] | None, axis: str, table: dict[str, dict[str, float]] = AXES,
           rng: np.random.Generator | None = None) -> str:
    """The take's resolved option for `axis`; else a seeded pick with `rng` (auditions); else the likeliest one."""
    if axes and axis in axes:
        return axes[axis]
    if rng is not None:
        return pick(rng, axis, table[axis])
    return max(table[axis], key=table[axis].__getitem__)


def rate_variants(axes: dict[str, str] | None = None, rng: np.random.Generator | None = None) -> tuple[int, ...]:
    """The R1 variants (LFO rates) a take's notes pick from, one per note."""
    return RATE_POOLS[option(axes, "riddim.r1_rates", rng=rng)]


def r2_blend(axes: dict[str, str] | None = None, rng: np.random.Generator | None = None) -> float:
    """R2's gain under R1 for a take."""
    return float(option(axes, "riddim.r2_blend", rng=rng))
BEAT_SHARE = {"1/32": 1 / 8, "1/16": 1 / 4, "1/16T": 1 / 6, "1/8": 1 / 2, "1/8T": 1 / 3}
FORMANTS = {"u": (250, 595), "o": (360, 640), "a": (850, 1610), "e": (390, 2300), "i": (240, 2400)}
R2_TAKES = (("uai", "1/8T"), ("ioi", "1/8T"), ("uai", "1/4T"), ("ioi", "1/4"))


def saw_down(t: np.ndarray, div: str, bpm: float) -> np.ndarray:
    """The riddim LFO from t = 0: 1 at each cycle's start, falling exponentially to 0 by 70 % of it, then shut."""
    ph = (t * sync_hz(div, bpm)) % 1.0
    return np.where(ph < 0.7, (1 - ph / 0.7) ** 2, 0.0)


def eased(lfo: np.ndarray, sr: int, ms: float = 5.0) -> np.ndarray:
    """A riddim LFO whose restarts rise over ~`ms` (a one-pole from its own start): a timbre stepped in one sample at a
    restart mid-note is a click."""
    a = np.exp(-1 / (ms / 1000 * sr))
    return signal.lfilter([1 - a], [1, -a], lfo, zi=[a * lfo[0]])[0] if len(lfo) else lfo


def r1(f: np.ndarray, t: np.ndarray, sr: int, bpm: float, v: int, f0: float, axes: dict[str, str] | None = None) -> np.ndarray:
    from .growls import _lowpass, _os, _ott, _square  # at call time: growls routes to this module

    lfo = saw_down(t, R1_RATES[v], bpm)
    f = f * 2 ** np.exp(-t / 0.008)  # +12 st -> 0 in ~30 ms: the click
    peak = float(option(axes, "riddim.r1_fm_peak"))
    rasp = min(0.2, peak / 3) + (peak - min(0.2, peak / 3)) * lfo
    ratio = float(option(axes, "riddim.r1_throat"))
    ph = np.cumsum(f / sr) + 1.2 * rasp * np.sin(2 * np.pi * np.cumsum(f * ratio / sr))  # FM 2>1, in cycles
    # The 0.5 throat's FM swings the phase backward, where the polyBLEP square (which assumes it runs forward) leaves
    # hard steps: HF ticks (S2's riddim flip: 163 clicks/min). There, a soft square (tanh of the sine) that is smooth
    # whichever way the phase runs.
    if ratio < 1:
        x = np.tanh(5.0 * np.sin(2 * np.pi * ph))
    else:
        # The FM's peak (right after each restart) swings the phase back too, for a moment: the soft square there,
        # blended in as the phase slows below a third of the note's speed (S2's riddim flip: the rest of its clicks).
        step = np.gradient(ph)
        hard = _square(ph % 1.0, np.maximum(np.abs(step), 1e-6))  # polyBLEP on the real phase step
        w = np.clip((0.35 - step * sr / f) / 0.25, 0.0, 1.0)
        x = hard + w * (np.tanh(5.0 * np.sin(2 * np.pi * ph)) - hard)
    # The comb on the note (HARMONY 1.4): the option's centre moved to the nearest octave of f0, swept from an octave
    # under to a 12th over (x0.5 .. x3: both ends harmonics of f0)
    comb_hz = octave_of(float(option(axes, "riddim.r1_comb_hz")), f0)
    x = 0.4 * x + 0.6 * moving_comb(x, comb_hz * 0.5 * 6 ** lfo, 0.7, sr)  # -12 .. +19 st
    # The top follows the LFO, 600 Hz shut to 6 kHz open (the Bible's 4-6 kHz LP), opening over ~5 ms (a one-sample step at
    # a restart mid-note clicked; the wider range keeps the sweep the clean square no longer fakes with aliasing).
    top = 6000.0 * (0.1 + 0.9 * eased(lfo, sr)) if option(axes, "riddim.r1_top") == "lfo" else np.full(len(t), 5000.0)
    x = _lowpass(_lowpass(x, top, 0.8, sr), top, 0.8, sr)
    if option(axes, "riddim.shift") == "on":  # FP: a freq shift (+-20-80 Hz, by rate) at 25 %, with a 1/64 echo
        wet = freq_shift(x, sr, harmonic_shift((20.0, -40.0, 60.0, -80.0)[v], f0))  # m f0 / 2: a held wub stays harmonic
        d = int(round(15.0 / bpm / 4 * sr))
        x = x + 0.25 * (wet + 0.4 * np.concatenate([np.zeros(d), wet[:-d]]))
    # The flanger (2 ms +-1, feedback 0.7), its mix on a second LFO at half the rate. It never rests on a pitch (a
    # continuous 0.4 Hz sweep), so it isn't key-tracked like the Comb+ (HARMONY 1.4 is about a comb at rest).
    flange = moving_comb(x, 1 / (0.002 + 0.001 * np.sin(2 * np.pi * 0.4 * t)), 0.7, sr)
    x = x + 0.5 * eased(saw_down(t, R1_RATES[v], bpm / 2), sr) * (flange - x)  # eased: its restart stepped the mix
    x = _ott(_os(lambda y: np.tanh(1.2 * y), x), sr, 0.25)  # lighter than the growls: the sweep has to survive it
    # The wub, still hard: a 1.5 ms rise, not one sample (a 0.6 -> 1 step at a restart clicked on some roots, F2).
    return x * (0.6 + 0.4 * eased(lfo, sr, 1.5))


def r2(f: np.ndarray, t: np.ndarray, sr: int, bpm: float, v: int, f0: float) -> np.ndarray:
    from .foxsynth import _phase, _saw
    from .growls import _bandpass, _os, _ott

    path, div = R2_TAKES[v]
    ph = (t * sync_hz(div, bpm)) % 1.0  # the vowel path once per LFO cycle, from the note's start
    pos = np.where(ph < 0.85, ph / 0.85, (1 - ph) / 0.15)  # and quickly back (a jump from i to u would click)
    k = pos * (len(path) - 1)
    lo = np.minimum(k.astype(int), len(path) - 2)
    frac = k - lo
    src = np.tanh(1.4 * _saw(_phase(f, sr), f / sr))
    x = np.zeros(len(t))
    for j, gain in enumerate((1.0, 0.8)):
        a = np.array([FORMANTS[path[i]][j] for i in lo], float)
        b = np.array([FORMANTS[path[i + 1]][j] for i in lo], float)
        fc = ndimage.uniform_filter1d(harmonic_of(a + (b - a) * frac, f0), int(0.003 * sr), mode="nearest")
        x += gain * _bandpass(src, fc, 9.0, sr)  # Q 9 rings a pitch: on the saw's harmonic nearest the formant, 3 ms glides
    # Half the plain saw under the vowels: a steady top, so the growl post's grit doesn't tick on the formant peaks.
    return _ott(_os(lambda y: np.tanh(3.0 * y), x + 0.5 * src), sr, 0.3)


def render_squeak(midi: float, beats: float, bpm: float, sr: int = 48_000, variant: int = 0, octaves: int = 1) -> np.ndarray:
    """The riddim top squeak: the wub's note 1-2 octaves up, band-passed 2-5 kHz, 10 dB under it, a little wide."""
    from .growls import render_growl

    x = render_growl("riddim", midi + 12 * octaves, beats, bpm, sr, variant, sub=False).astype(np.float64)
    ref = np.sqrt(np.mean(x ** 2))
    y = signal.sosfilt(signal.butter(2, (2000, 5000), "bandpass", fs=sr, output="sos"), x[0])
    side = 0.4 * np.roll(y, int(0.007 * sr))
    y = np.stack([y + side, y - side])
    y *= 10 ** (-10 / 20) * ref / (np.sqrt(np.mean(y ** 2)) + 1e-12)
    k, r = min(int(0.003 * sr), y.shape[1] // 4), min(int(0.010 * sr), y.shape[1] // 4)
    y[:, :k] *= 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, k))
    y[:, y.shape[1] - r:] *= 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, r))  # the band-pass rings past the note's fade
    return y.astype(np.float32)


def late_with_delay(x: np.ndarray, sr: int, bpm: float, late: str = "1/32", time: str = "1/16", feedback: float = 0.4,
                    repeats: int = 3) -> np.ndarray:
    """An off-grid "d" hit (fingerprints §1): `x` (2, n) pushed `late` behind its slot, then `repeats` echoes `time`
    apart at `feedback`^k, each a little darker. Place the result on the slot itself."""
    beat = 60.0 / bpm * sr
    d0, dt = int(round(BEAT_SHARE[late] * beat)), int(round(BEAT_SHARE[time] * beat))
    n = x.shape[-1]
    out = np.zeros((2, d0 + n + repeats * dt))
    out[:, d0:d0 + n] += x
    echo = np.asarray(x, np.float64)
    for k in range(1, repeats + 1):
        echo = signal.sosfilt(signal.butter(2, 7000 / 1.5 ** k, "lowpass", fs=sr, output="sos"), echo, axis=-1)
        out[:, d0 + k * dt:d0 + k * dt + n] += feedback ** k * echo
    return out.astype(np.float32)
