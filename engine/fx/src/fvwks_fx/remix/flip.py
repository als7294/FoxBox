"""1.6 REMIX: GENRE FLIP's drum reading. DSP only (the idea of cukas/drumsep, MIT: HPSS, then band masks; our code,
no librosa).

split_drums(drums, sr)            the drum stem as kick / snare / hats audio under soft band masks (kick < 150 Hz,
                                  snare 150 Hz - 5 kHz, hats > 5 kHz). Snare and hats take only the percussive part
                                  (HPSS: a median along frequency beats a median along time), so ringing and cymbal
                                  wash stay out; the kick keeps all its band (its bins are too few for the median
                                  across frequency, and a drum stem has no bass line to leave out)
drum_hits(drums, sr, analysis)    each voice's hits on the song's grid (in its own narrower band): beat from bar 1
                                  (fractional: the feel stays), velocity 0-1 against the voice's loudest hit
reprogram(hits, style, bars)      the song's drums re-played as a FLIP_STYLES pattern, bar by bar: each voice at the
                                  original bar's loudness (silent where the whole kit is: breakdowns stay breakdowns),
                                  and a fill (a bar twice as busy as usual, like a build's snare roll) kept as played;
                                  in beats, so it re-times with the remix tempo; `swing` pushes the off 16ths late
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import ndimage, signal

from fvwks_contracts.models import SongAnalysis

from ..bassline import _mono
from ..dsp import EPS, as2d
from .styles import flip_styles, pattern

N_FFT, HOP = 2048, 512
MED = 17  # HPSS median lengths (frames, bins)
EDGE_HZ = {"kick": 150.0, "snare": 5000.0}  # soft edges: the masks cross over an octave around each
DETECT = {"kick": (30.0, 120.0), "snare": (1000.0, 5000.0), "hats": (6000.0, 16000.0)}  # hit-finding bands (Hz)


@dataclass
class Hit:
    kind: str  # kick | snare | hats
    beat: float  # from bar 1, beat 1 (the downbeat)
    vel: float  # 0-1


def _band_masks(f: np.ndarray) -> dict[str, np.ndarray]:
    """Soft per-bin weights summing to 1: logistic crossovers at 150 Hz and 5 kHz (an octave wide)."""
    lo = 1 / (1 + (f / EDGE_HZ["kick"]) ** 4)  # 1 below 150 Hz
    hi = 1 / (1 + (EDGE_HZ["snare"] / np.maximum(f, EPS)) ** 4)  # 1 above 5 kHz
    return {"kick": lo, "snare": np.clip(1 - lo - hi, 0, 1), "hats": hi}


def split_drums(drums: np.ndarray, sr: int) -> dict[str, np.ndarray]:
    """kick / snare / hats, each (channels, n) float32 like `drums`.
    ponytail: full-rate HPSS, ~28 s for a 2.4 min song at 48 kHz (the two median filters). Only a flip that samples
    the song's own drums needs it: cache it per song, or compute the masks at 22.05 kHz if that path gets hot."""
    x = as2d(np.asarray(drums, dtype=np.float32))
    f, _, Z = signal.stft(x, sr, nperseg=N_FFT, noverlap=N_FFT - HOP)
    mag = np.abs(Z).mean(axis=0)  # (bins, frames), one mask for all channels
    harm = ndimage.median_filter(mag, size=(1, MED), mode="nearest")
    perc = ndimage.median_filter(mag, size=(MED, 1), mode="nearest")
    p_mask = perc**2 / np.maximum(perc**2 + harm**2, EPS)
    out = {}
    for name, band in _band_masks(f).items():
        mask = band[:, None] if name == "kick" else p_mask * band[:, None]
        _, y = signal.istft(Z * mask[None], sr, nperseg=N_FFT, noverlap=N_FFT - HOP)
        out[name] = y[:, : x.shape[1]].astype(np.float32)
    return out


def drum_hits(drums: np.ndarray, sr: int, analysis: SongAnalysis) -> list[Hit]:
    """Each voice's hits in the drum stem, found in its own detection band (narrower than the split's, so a kick's
    body and click don't read as a snare): log-energy rises of a trailing 5 ms RMS of the band (zero-phase filtered),
    peak-picked (a voice's hits at least 60 ms apart), over a threshold from the band's own level (the median rise
    + 3 spreads, at least 6 dB up) and at least 20 % of the voice's strong hits, timed to the millisecond. A snare
    (or clap) also rings on: 20 % of its peak 30-80 ms in."""
    beat = 60.0 / analysis.bpm
    m = _mono(drums).astype(np.float64)
    hop = max(1, sr // 1000)
    hits: list[Hit] = []
    for kind, (lo, hi) in DETECT.items():
        y = signal.sosfiltfilt(signal.butter(4, (lo, min(hi, 0.45 * sr)), "band", fs=sr, output="sos"), m)
        e = np.sqrt((y[: y.size // hop * hop].reshape(-1, hop) ** 2).mean(axis=1))  # 1 ms RMS
        e = np.sqrt(np.maximum(ndimage.uniform_filter1d(e**2, 5, origin=2, mode="nearest"), 0))  # trailing 5 ms
        floor = np.log(1e-4 * max(float(e.max()), EPS))
        le = np.log(e + np.exp(floor))
        rise = le - np.concatenate([np.full(10, floor), le[:-10]])  # over 10 ms (silence before the start)
        med = float(np.median(rise))
        spread = float(np.median(np.abs(rise - med))) + EPS
        peaks, _ = signal.find_peaks(rise, height=max(med + 3 * spread * 1.4826, np.log(2.0)), distance=60)
        if not peaks.size:
            continue
        # the hit starts at the steepest 1 ms step of its rise (the peak of a 10 ms rise sits up to 10 ms after it)
        starts = np.array([max(0, p - 10) + int(np.argmax(np.diff(np.concatenate([[floor], le])[max(0, p - 10) : p + 2])))
                           for p in peaks])
        level = np.array([e[p : p + 30].max() for p in starts])
        # a real hit reaches 20 % of the voice's strong hits (the top quarter); quieter rises are leaks from the others
        strong = float(np.median(level[level >= np.percentile(level, 75)]))
        keep = level >= 0.2 * strong
        if kind == "snare":  # a snare or clap rings on (30-80 ms in: 20 %+ of its peak); kick clicks and hats don't
            tail = np.array([e[p + 30 : p + 80].mean() if p + 80 <= e.size else 0.0 for p in starts])
            keep &= tail >= 0.2 * level
        if not keep.any():
            continue
        starts, level = starts[keep], level[keep]
        for t, v in zip(starts * hop / sr, level / max(float(level.max()), EPS)):
            hits.append(Hit(kind, round((t - analysis.downbeat_s) / beat, 4), round(float(v), 3)))
    return sorted(hits, key=lambda h: h.beat)


# GENRE FLIP styles, as data (styles/<id>.json): name, bpm, half_time and the default drums option's pattern, (beat in
# the bar, voice, velocity) rows ("alt": a 2-bar style's second bar). Half-time styles put the snare on beat 3.
FLIP_STYLES: dict[str, dict] = {k: {"name": v["name"], "bpm": v["bpm"], "half_time": v["half_time"], **pattern(k)}
                                for k, v in flip_styles().items()}


def reprogram(hits: list[Hit], style: str, start_bar: int = 1, bars: int = 1, swing: float = 0.0,
              drums: str | None = None) -> list[Hit]:
    """Bars [start_bar, start_bar + bars) of `hits` (drum_hits) re-played as the style's pattern (its `drums` option,
    the take's choice; default the first); beats from the first of those bars (see the module doc)."""
    st = pattern(style, drums)
    pat_for = lambda i: st["alt"] if "alt" in st and i % 2 == 1 else st["hits"]  # a 2-bar style's second bar
    b0 = (start_bar - 1) * 4
    per_bar = {k: [[h for h in hits if h.kind == k and b0 + 4 * i <= h.beat < b0 + 4 * i + 4] for i in range(bars)]
               for k in ("kick", "snare", "hats")}
    out: list[Hit] = []
    silent = [not any(per_bar[k][i] for k in per_bar) for i in range(bars)]  # the whole kit out: a breakdown bar
    for kind, bar_hits in per_bar.items():
        usual = float(np.percentile([len(b) for b in bar_hits if b], 25)) if any(bar_hits) else 0.0  # the groove, not its fills
        typical = float(np.median([h.vel for b in bar_hits for h in b])) if any(bar_hits) else 0.8
        for i, played in enumerate(bar_hits):
            if silent[i]:
                continue  # the kit is silent in the original: silent here
            if len(played) >= max(4, 2 * usual):  # a fill: keep it as played
                out += [Hit(kind, round(h.beat - b0, 4), h.vel) for h in played]
                continue
            # a voice out of an otherwise played bar (a drop's first bar opening on a low-end gap) plays anyway, at its
            # usual loudness: the drop has to hit
            loud = float(np.mean([h.vel for h in played])) if played else typical
            for beat, k, vel in pat_for(i):
                if k == kind:
                    off16 = round(beat * 4) % 2 == 1 and abs(beat * 4 - round(beat * 4)) < 1e-6
                    at = 4 * i + beat + (swing / 12 if off16 else 0.0)  # up to a triplet's push
                    out.append(Hit(kind, round(at, 4), round(min(1.0, vel * loud / 0.8), 3)))
    return sorted(out, key=lambda h: h.beat)
