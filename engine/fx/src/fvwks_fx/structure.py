"""v0.10 song structure for the SMART VISUALS (AUTO-VJ): sections, an energy curve, phrase boundaries, drops and
builds, from the mix on the song's own grid (SongAnalysis), leaning on the stems when they exist.

Per 4-bar block (on the grid from bar 1): loudness, low end (kick and bass, 30-150 Hz; the drums and bass stems when
given), brightness (the > 4 kHz share) and hit density. Then, on dance-music terms:
- the low end is "in" within 12 dB of its loud level (the 90th percentile);
- intro: before it first comes in; outro: after it last leaves;
- drop: low end in and loudness within 3 dB of the loud level; verse: low end in, quieter;
- breakdown: low end out mid-song;
- build: the block (or two, while it rises in brightness or hit density) just before each drop;
- each drop's hit: its first bar line when a low-end impact lands there (within 12 dB of the groove), else the first
  beat where the low end is back (a drop can land a beat or two in, after a pre-drop gap).
The energy curve is the mix loudness at 10 fps, mapped 0-255 between its 10th and 99th percentiles (energy_b64).
phrase_bars is 16 when every section starts on a 16-bar line, else 8. With a bass stem, each section also gets the
v0.10.1 bass fields (style, half-time, note length, wobble: bassline.py). Returns the v0.10 SongStructure.
"""

from __future__ import annotations

import base64

import numpy as np
from scipy import ndimage

from fvwks_contracts.models import SongAnalysis, SongSection, SongStructure

from .bassline import BassFrames
from .dsp import EPS, as2d
from .song import AN_SR, _mag_frames, _mono_an

HOP = 512  # 23 ms frames at 22.05 kHz
N_FFT = 2048
BLOCK_BARS = 4
PHRASE_BARS = 8
ENERGY_FPS = 10.0
HIT_DB = 12.0
LOW_IN_DB = 12.0
DROP_DB = 3.0


def _db(p: np.ndarray | float) -> np.ndarray | float:
    return 10.0 * np.log10(np.maximum(p, 1e-12))


def _mono(x: np.ndarray | None, sr: int) -> np.ndarray | None:
    return None if x is None else _mono_an(x, sr)


def song_structure(audio: np.ndarray, sr: int, analysis: SongAnalysis, *, stems: dict[str, np.ndarray] | None = None) -> SongStructure:
    x = _mono_an(audio, sr)
    dur = x.size / AN_SR
    bpm = float(analysis.bpm) if analysis.bpm and analysis.bpm > 0 else 120.0
    bpb = int(analysis.beats_per_bar or 4)
    beat = 60.0 / bpm
    bar_s = beat * bpb
    down = float(analysis.downbeat_s or 0.0)
    n_bars = max(1, int(np.ceil((dur - down) / bar_s)))
    bar_t = down + bar_s * np.arange(n_bars + 1)

    # frame features at 22.05 kHz
    mag = _mag_frames(x, N_FFT, HOP) ** 2
    f = np.fft.rfftfreq(N_FFT, 1.0 / AN_SR)
    full = mag.sum(axis=1)
    low = mag[:, (f >= 30) & (f <= 150)].sum(axis=1)
    high = mag[:, f >= 4000].sum(axis=1)
    lg = np.log1p(100.0 * np.sqrt(mag) / max(float(np.sqrt(mag).max()), EPS))
    flux = np.concatenate([[0.0], np.maximum(lg[1:] - lg[:-1], 0.0).sum(axis=1)])
    fps = AN_SR / HOP
    thr = ndimage.uniform_filter1d(flux, int(fps), mode="nearest") * 1.5
    hits = (flux > thr) & (flux >= ndimage.maximum_filter1d(flux, 5, mode="nearest"))
    ft = np.arange(full.size) / fps

    # stems (optional): drums and bass power per frame on the same hop, in place of the mix's low end
    lows = low
    from_stems = False
    if stems:
        parts = [_mono(stems.get(k), sr) for k in ("drums", "bass")]
        parts = [p for p in parts if p is not None and np.any(p)]
        if parts:
            n = min(p.size for p in parts)
            s = np.sum([p[:n] ** 2 for p in parts], axis=0)
            frames = min(full.size, n // HOP)
            lows = np.zeros(full.size)
            lows[:frames] = s[: frames * HOP].reshape(frames, HOP).mean(axis=1)
            from_stems = True

    def per(values: np.ndarray, a: float, b: float, how: str = "mean") -> float:
        m = (ft >= a) & (ft < b)
        if not m.any():
            return 0.0
        return float(values[m].mean() if how == "mean" else values[m].sum())

    # 4-bar blocks from bar 1
    n_blocks = int(np.ceil(n_bars / BLOCK_BARS))
    edges = [bar_t[min(n_bars, b * BLOCK_BARS)] for b in range(n_blocks + 1)]
    E = np.array([_db(per(full, edges[b], edges[b + 1])) for b in range(n_blocks)])
    L = np.array([_db(per(lows, edges[b], edges[b + 1])) for b in range(n_blocks)])
    B = np.array([_db(per(high, edges[b], edges[b + 1]) / max(per(full, edges[b], edges[b + 1]), EPS)) for b in range(n_blocks)])
    D = np.array([per(hits.astype(float), edges[b], edges[b + 1], "sum") / BLOCK_BARS for b in range(n_blocks)])

    low_in = L >= np.percentile(L, 90) - LOW_IN_DB
    loud = low_in & (E >= np.percentile(E, 90) - DROP_DB)
    on = np.nonzero(low_in)[0]
    first_on, last_on = (int(on[0]), int(on[-1])) if on.size else (n_blocks, -1)
    kinds = []
    for b in range(n_blocks):
        kinds.append("intro" if b < first_on else "outro" if b > last_on else "drop" if loud[b] else "verse" if low_in[b] else "breakdown")
    # builds: the block before each drop run (and the one before that while it rises)
    for b in range(1, n_blocks):
        if kinds[b] == "drop" and kinds[b - 1] != "drop":
            kinds[b - 1] = "build"
            if b >= 2 and kinds[b - 2] in ("breakdown", "intro", "verse") and (B[b - 1] > B[b - 2] + 1.0 or D[b - 1] > D[b - 2] * 1.2):
                kinds[b - 2] = "build"

    # sections: merged runs (the pre-roll before bar 1 joins the first one)
    energy_t = np.arange(0.0, dur, 1.0 / ENERGY_FPS)
    fe = ndimage.uniform_filter1d(_db(full), max(1, int(fps / ENERGY_FPS)), mode="nearest")
    ev = np.interp(energy_t, ft, fe)
    lo, hi = np.percentile(ev, 10), np.percentile(ev, 99)
    energy = np.clip((ev - lo) / max(hi - lo, EPS), 0.0, 1.0)

    sections: list[SongSection] = []
    b = 0
    while b < n_blocks:
        e = b
        while e + 1 < n_blocks and kinds[e + 1] == kinds[b]:
            e += 1
        a_s = 0.0 if b == 0 else float(edges[b])
        z_s = dur if e == n_blocks - 1 else float(edges[e + 1])
        m = (energy_t >= a_s) & (energy_t < z_s)
        sections.append(SongSection(kind=kinds[b], start_s=round(a_s, 3), end_s=round(min(z_s, dur), 3),
                                    start_bar=b * BLOCK_BARS + 1, energy=round(float(energy[m].mean()) if m.any() else 0.0, 3)))
        b = e + 1

    # drops: the hit is the drop's bar line when a low-end impact lands on it, else the first beat the low end is back
    groove = _db(np.percentile(ndimage.uniform_filter1d(lows, max(1, int(fps / 4)), mode="nearest"), 90))
    drops: list[float] = []
    builds: list[tuple[float, float]] = []
    for i, sec in enumerate(sections):
        if sec.kind != "drop":
            continue
        start = float(bar_t[sec.start_bar - 1])
        hit = start
        for k in range(2 * bpb):
            t = start + k * beat
            if _db(per(lows, t, t + beat / 2)) >= groove - HIT_DB:
                hit = t
                break
        drops.append(round(hit, 3))
        if i and sections[i - 1].kind == "build":
            builds.append((sections[i - 1].start_s, round(hit, 3)))

    bass = (stems or {}).get("bass")
    if bass is not None and np.any(bass):
        frames = BassFrames(bass, sr, 60.0, int(np.ceil(as2d(np.asarray(bass)).shape[1] / sr * 60.0)))
        drums = (stems or {}).get("drums")
        for i, sec in enumerate(sections):
            fields = frames.section(sec.start_s, sec.end_s, beat, drums, sr, down)
            sections[i] = sec.model_copy(update=fields)

    starts = [sec.start_bar for sec in sections[1:]]
    phrase_bars = 16 if starts and all((sb - 1) % 16 == 0 for sb in starts) else PHRASE_BARS
    return SongStructure(sections=sections, drops_s=drops, builds=builds, phrase_bars=phrase_bars, energy_fps=ENERGY_FPS,
                         energy_b64=base64.b64encode(np.round(energy * 255).astype(np.uint8).tobytes()).decode("ascii"),
                         from_stems=from_stems)
