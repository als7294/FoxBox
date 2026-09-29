"""v0.9 stem features for the visuals: per-stem envelopes and onsets of a whole song at 60 fps (StemFeatureData).

For each of the four stems and the mix, on frames centred every sr/fps samples:
- rms: the frame's RMS (a two-hop window), normalised per song: the track's loudest frame is 255.
- bass (v0.10.1, from the bass stem): per-frame note on / start, sub, growl and the sub's pitch (bassline.py).
- onset: log spectral flux (2048-point frames) over an adaptive threshold (the local mean + std over +-0.5 s, with a
  floor from the track's own flux level), peak-picked within +-50 ms; a hit is strength / threshold * 64 (>= 64),
  else 0. A near-silent stem has no hits. With the song's grid (analysis), a hit within 25 ms of a 1/16 note moves
  onto it, so the visuals land on the beat.
"""

from __future__ import annotations

import numpy as np
from scipy import ndimage

from fvwks_contracts.models import STEM_NAMES, SongAnalysis
from fvwks_contracts.seam import StemFeatureData

from .bassline import BassFrames
from .dsp import EPS, as2d
from .song import _mag_frames

N_FFT = 2048
THRESH_WIN_S = 1.0
PEAK_S = 0.05
SNAP_S = 0.025
SILENT = 0.02  # frames under 2 % of the track's peak RMS carry no hits


def _mono(x: np.ndarray | None, n: int) -> np.ndarray:
    if x is None:
        return np.zeros(n, np.float32)
    a = as2d(np.asarray(x, dtype=np.float32))
    m = a.mean(axis=0) if a.shape[0] > 1 else a[0]
    return m[:n] if m.size >= n else np.pad(m, (0, n - m.size))


def _rms(x: np.ndarray, hop: int, frames: int) -> np.ndarray:
    c = np.concatenate([[0.0], np.cumsum(x.astype(np.float64) ** 2)])
    centre = np.arange(frames) * hop
    a = np.clip(centre - hop, 0, x.size)
    b = np.clip(centre + hop, 0, x.size)
    return np.sqrt((c[b] - c[a]) / np.maximum(1, b - a))


def _onsets(x: np.ndarray, hop: int, frames: int, fps: float, rms: np.ndarray) -> np.ndarray:
    """Onset strength per frame: flux / threshold at picked peaks over 1, else 0."""
    if not np.any(x):
        return np.zeros(frames)
    mag = _mag_frames(x, N_FFT, hop)[:frames]
    lg = np.log1p(100.0 * mag / max(float(mag.max()), EPS))
    flux = np.zeros(frames)
    flux[1:] = np.maximum(lg[1:] - lg[:-1], 0.0).sum(axis=1)
    win = max(3, int(round(THRESH_WIN_S * fps)))
    mean = ndimage.uniform_filter1d(flux, win, mode="nearest")
    sd = np.sqrt(np.maximum(ndimage.uniform_filter1d(flux**2, win, mode="nearest") - mean**2, 0.0))
    floor = 0.1 * float(np.percentile(flux, 95)) + EPS
    thr = np.maximum(mean + sd, floor)
    peak = ndimage.maximum_filter1d(flux, 2 * int(round(PEAK_S * fps)) + 1, mode="nearest")
    hit = (flux >= peak) & (flux > thr) & (rms > SILENT * max(float(rms.max()), EPS))
    return np.where(hit, flux / thr, 0.0)


def _snap(strength: np.ndarray, fps: float, analysis: SongAnalysis | None) -> np.ndarray:
    """Hits within SNAP_S of a 1/16 note of the song's grid move onto it (the stronger hit wins a frame)."""
    if analysis is None or not analysis.bpm or analysis.bpm <= 0:
        return strength
    step = 60.0 / analysis.bpm / 4
    out = np.zeros_like(strength)
    for f in np.nonzero(strength)[0]:
        t = f / fps
        g = analysis.downbeat_s + round((t - analysis.downbeat_s) / step) * step
        to = int(round(g * fps)) if abs(t - g) <= SNAP_S and g >= 0 else f
        to = min(max(to, 0), strength.size - 1)
        out[to] = max(out[to], strength[f])
    return out


def stem_features(stems: dict[str, np.ndarray], sr: int, mix: np.ndarray, *, analysis: SongAnalysis | None = None,
                  fps: float = 60.0) -> StemFeatureData:
    """Per-stem envelopes and onsets for the visuals (see the module doc). `stems` maps each of STEM_NAMES to
    (channels, n) float32 at `sr` (a missing stem is silent); `mix` is the whole song at `sr`."""
    n = as2d(np.asarray(mix)).shape[1]
    hop = max(1, int(round(sr / fps)))
    fps = sr / hop  # the exact frame rate of the integer hop (60.0 at 44.1 / 48 kHz)
    frames = int(np.ceil(n / hop)) if n else 0
    tracks = [*STEM_NAMES, "mix"]
    data = np.zeros((frames, len(tracks), 2), np.uint8)
    for k, name in enumerate(tracks):
        x = _mono(mix if name == "mix" else stems.get(name), n)
        if not frames or not np.any(x):
            continue
        rms = _rms(x, hop, frames)
        data[:, k, 0] = np.clip(np.round(rms / max(float(rms.max()), EPS) * 255.0), 0, 255).astype(np.uint8)
        strength = _snap(_onsets(x, hop, frames, fps, rms), fps, analysis)
        data[:, k, 1] = np.clip(np.round(strength * 64.0), 0, 255).astype(np.uint8)
    bass = stems.get("bass")
    bass_bytes = BassFrames(bass, sr, fps, frames).encode() if bass is not None and frames and np.any(bass) else None
    return StemFeatureData(fps=float(fps), tracks=tracks, data=data, bass=bass_bytes)
