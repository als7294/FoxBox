"""1.6 REMIX MASH RADAR: how well one song's build, drop or vocals sit over another song's drop. DSP only, after
AutoMashUpper (Davies et al., ISMIR 2013), our own code.

Two steps, so a scan over the library never touches audio:
- `features(...)`: per-part arrays for one song (npz-ready, a few KB), cached next to the song and recomputed when
  its analysis or structure changes. A part is up to 8 bars from a section's first bar line, on the song's grid:
  build and drop sections of the mix, and (given the vocals stem) every section where the vocals are in;
- `scan(query, part, library)`: ranked `MashMatch`es for one part of the query song over the other songs.

A top part (build / vocals / drop) over a bottom part (a drop):
- tempo: bottom BPM over top BPM, or twice / half that (half / double time), within +-8 % (key-locked stretch),
  else no match;
- harmony: chroma per beat (from the power per semitone band, mean-centred: a correlation), the top rolled by
  -6..+6 st: half the mean per-beat cosine, half the cosine of the part profiles (a build's chords needn't change on
  the drop loop's beats), less 0.01 per semitone;
- rhythm: the onset pattern per 16th over a bar, averaged over the bars, cosine;
- spectrum: 1 - cosine of the power shares in sub / low / mid / high (vocals over a bass drop score high, two
  sub-heavy drops low);
- bass: S2's section fields (v0.10.1) when both songs have stems: same style 1, else 0.5, a half-time mismatch x0.7,
  another wobble division x0.8; 1 when the top brings no bass line; 0.75 when unknown (no stems).
score = 100 (0.45 harmony + 0.2 rhythm + 0.2 spectrum + 0.15 bass) - 5 |1 - stretch| / 0.08.
"""

from __future__ import annotations

import numpy as np
from scipy import ndimage, signal

from fvwks_contracts.models import MashMatch, MashScanRequest, SongAnalysis, SongStructure
from fvwks_contracts.seam import MashFeatures

from ..dsp import EPS
from ..music import _CAMELOT, _NAMES, parse_key
from ..song import AN_SR, FLUX_HOP, _mag_frames, _mono_an, _onset_envelope

PARTS = ("build", "drop", "vocals")
MAX_STRETCH = 0.08
STRETCH_POINTS = 5.0  # the cost of the full +-8 % (a key-locked stretch that far still sounds fine)
SHIFTS = [0] + [s for k in range(1, 7) for s in (-k, k)]  # smallest first; down before up
_SHIFTS = np.array(SHIFTS)
_K = np.arange(12)
_IDX = (_K[None, :] - _SHIFTS[:, None]) % 12  # (shifts, 12): row s holds (k - s) % 12
PART_BEATS = 32
MIN_BEATS = 16
VOCALS_IN = 0.1  # a vocals part: the stem's power over it is at least this share of its loudest part's
BANDS = ((0, 60), (60, 250), (250, 4000), (4000, AN_SR / 2))
BAND_FFT, BAND_HOP = 2048, 512
W_HARMONY, W_RHYTHM, W_SPECTRUM, W_BASS = 0.45, 0.2, 0.2, 0.15


MashSong = MashFeatures  # one type: the v0.11.3 seam dataclass (song_id, analysis, structure, feats)


def _chroma(x: np.ndarray, hop_s: float) -> tuple[np.ndarray, float]:
    """Harmonic chroma as song._chroma, but from the power per semitone band, so pink noise (drums, growls) is flat.
    song._chroma sums sqrt magnitudes per bin, which leaves a fixed ramp from the bins-per-semitone count that no
    transposition moves (it wins the key-shift search, and song-1's key comes back unclear)."""
    sr = AN_SR // 2
    hop = max(256, int(round(hop_s * sr)))
    f = np.fft.rfftfreq(4096, 1.0 / sr)
    use = (f >= 55.0) & (f <= 2000.0)
    mag = _mag_frames(signal.resample_poly(x, 1, 2).astype(np.float32), 4096, hop)[:, use]
    p = ndimage.median_filter(mag, size=(9, 1), mode="nearest") ** 2  # keep the sustained (harmonic) part
    pc = np.round(69.0 + 12.0 * np.log2(f[use] / 440.0)).astype(np.int64) % 12
    ch = np.stack([p[:, pc == k].sum(axis=1) for k in range(12)], axis=1) ** 0.25
    return ch / np.maximum(ch.sum(axis=1, keepdims=True), EPS), sr / hop


def _parts(analysis: SongAnalysis, structure: SongStructure, kinds: tuple[str, ...]):
    beat = 60.0 / float(analysis.bpm)
    for s in structure.sections:
        if s.kind in kinds:
            t0 = float(analysis.downbeat_s) + (s.start_bar - 1) * analysis.beats_per_bar * beat
            beats = min(PART_BEATS, int((s.end_s - t0) / beat) // 4 * 4)
            if beats >= MIN_BEATS:
                yield s.start_bar, t0, beats


def _part_rows(part, kinds, analysis, structure, beat, ch, ch_fps, on, bands) -> list:
    """features()' rows for one kind of part of one signal."""
    mine = []
    for bar, t0, beats in _parts(analysis, structure, kinds):
        fr = (t0 + beat / 2 * np.arange(2 * beats + 1)) * ch_fps
        c8 = np.zeros((2 * PART_BEATS, 12), np.float32)
        c8[: 2 * beats] = [ch[int(a) : max(int(a) + 1, int(b))].mean(axis=0) if int(a) < len(ch) else np.zeros(12)
                           for a, b in zip(fr[:-1], fr[1:])]
        pos = (t0 + beat / 4 * np.arange(4 * beats)) * (AN_SR / FLUX_HOP)
        rh = np.interp(pos, np.arange(len(on)), on, right=0.0).reshape(-1, 16).mean(axis=0)
        bd = bands[int(t0 * AN_SR / BAND_HOP) : int((t0 + beats * beat) * AN_SR / BAND_HOP)].sum(axis=0)
        mine.append([PARTS.index(part), bar, beats, c8, rh, bd])
    if part == "vocals" and mine:  # only where the vocals are in
        loud = max(float(r[5].sum()) for r in mine)
        mine = [r for r in mine if r[5].sum() >= VOCALS_IN * loud]
    return mine


def features(audio: np.ndarray, sr: int, analysis: SongAnalysis, structure: SongStructure,
             vocals: np.ndarray | None = None) -> dict[str, np.ndarray]:
    """Per-part arrays: kind (index in PARTS), start_bar, beats, chroma per 8th (P, 64, 12, zero past 2 x beats),
    rhythm (P, 16) and band shares (P, 4). ``audio`` / ``vocals`` are (channels, n) at ``sr``."""
    beat = 60.0 / float(analysis.bpm)
    rows = []
    every = ("intro", "verse", "build", "drop", "breakdown", "outro")
    for sig, wanted in ((audio, (("build", ("build",)), ("drop", ("drop",)))), (vocals, (("vocals", every),))):
        if sig is None:
            continue
        x = _mono_an(sig, sr)  # each signal is read once, for all its parts
        ch, ch_fps = _chroma(x, 0.05)
        on = _onset_envelope(x)
        p = _mag_frames(x, BAND_FFT, BAND_HOP) ** 2
        f = np.fft.rfftfreq(BAND_FFT, 1.0 / AN_SR)
        bands = np.stack([p[:, (f >= lo) & (f < hi)].sum(axis=1) for lo, hi in BANDS], axis=1)
        for part, kinds in wanted:
            rows += _part_rows(part, kinds, analysis, structure, beat, ch, ch_fps, on, bands)
    cols = list(zip(*rows)) if rows else [[]] * 6
    return {"kind": np.array(cols[0], np.int8), "start_bar": np.array(cols[1], np.int32),
            "beats": np.array(cols[2], np.int32), "chroma": np.array(cols[3], np.float32).reshape(-1, 2 * PART_BEATS, 12),
            "rhythm": np.array(cols[4], np.float32).reshape(-1, 16),
            "bands": (np.array(cols[5], np.float64).reshape(-1, 4) / np.maximum(np.array(cols[5]).reshape(-1, 4).sum(axis=1, keepdims=True), EPS)).astype(np.float32)}


def _unit(v: np.ndarray) -> np.ndarray:
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), EPS)


def _pool(v: np.ndarray, k: int) -> np.ndarray:
    n = len(v) // k * k
    return v[:n].reshape(-1, k, *v.shape[1:]).mean(axis=1)


def _tempo(top: float, bottom: float) -> tuple[float, int] | None:
    """The top's stretch and m: after it, one top beat is m bottom beats (2 = the top in half time)."""
    r = bottom / top
    stretch, m = min(((r / m, m) for m in (1, 2, 0.5)), key=lambda c: abs(c[0] - 1))
    return (stretch, m) if abs(stretch - 1) <= MAX_STRETCH else None


def _section(structure: SongStructure, bar: int):
    return next((s for s in structure.sections if s.start_bar == bar), None)


def _bass(top: MashSong, t_bar: int, t_kind: str, bottom: MashSong, b_bar: int) -> tuple[float, str]:
    a, b = _section(top.structure, t_bar), _section(bottom.structure, b_bar)
    if t_kind == "vocals":
        return 1.0, "vocals: no bass line"
    if not (top.structure.from_stems and bottom.structure.from_stems) or a is None or b is None:
        return 0.75, "bass style unknown (no stems)"
    if a.bass_style is None or b.bass_style is None:
        return 1.0, "only one bass line"
    s, why = (1.0, f"both {a.bass_style}") if a.bass_style == b.bass_style else (0.5, f"{a.bass_style} over {b.bass_style}")
    if a.half_time != b.half_time:
        s, why = s * 0.7, why + ", half-time mismatch"
    if a.wobble_div and b.wobble_div and a.wobble_div != b.wobble_div:
        s, why = s * 0.8, why + f", wobble {a.wobble_div} vs {b.wobble_div}"
    return s, why


def _score(top: MashSong, i: int, bottom: MashSong, j: int, unshifted: bool = False):
    """(score, the top's shift and stretch, m, reasons bits) of top part i over bottom part j, or None."""
    tf, bf = top.feats, bottom.feats
    tempo = _tempo(float(top.analysis.bpm), float(bottom.analysis.bpm))
    if tempo is None:
        return None
    stretch, m = tempo
    c8a, c8b = tf["chroma"][i][: 2 * tf["beats"][i]], bf["chroma"][j][: 2 * bf["beats"][j]]
    ca = {1: _pool(c8a, 2), 2: c8a, 0.5: _pool(c8a, 4)}[m]  # the top per bottom beat
    cb = _pool(c8b, 2)
    n = min(len(ca), len(cb))
    ca, cb = _unit(ca[:n] - ca[:n].mean(axis=1, keepdims=True)), _unit(cb[:n] - cb[:n].mean(axis=1, keepdims=True))
    pa, pb = _unit(ca.sum(axis=0)), _unit(cb.sum(axis=0))
    # every shift at once: np.roll(ca, s, axis=1)[:, k] is ca[:, (k - s) % 12], so the per-beat term for shift s sums
    # the matrix ca.T @ cb along a wrapped diagonal (the first best shift wins, in SHIFTS' order)
    h = 0.5 * (ca.T @ cb)[_IDX, _K].sum(axis=1) / n + 0.5 * (pa[_IDX] * pb).sum(axis=1) - 0.01 * np.abs(_SHIFTS)
    best = 0 if unshifted else int(np.argmax(h))
    harm, shift = float(h[best]), SHIFTS[best]
    ra, rb = tf["rhythm"][i], bf["rhythm"][j]
    if m == 2:  # a top bar spans two bottom bars
        rb = np.tile(_pool(rb, 2), 2)
    elif m == 0.5:
        ra = np.tile(_pool(ra, 2), 2)
    rhythm = float(_unit(ra) @ _unit(rb))
    spectrum = 1.0 - float(_unit(tf["bands"][i]) @ _unit(bf["bands"][j]))
    t_kind = PARTS[tf["kind"][i]]
    bass, bass_why = _bass(top, int(tf["start_bar"][i]), t_kind, bottom, int(bf["start_bar"][j]))
    score = 100 * (W_HARMONY * max(harm, 0.0) + W_RHYTHM * rhythm + W_SPECTRUM * spectrum + W_BASS * bass) \
        - STRETCH_POINTS * abs(1 - stretch) / MAX_STRETCH
    sub = f"sub+low {tf['bands'][i][:2].sum():.0%} over {bf['bands'][j][:2].sum():.0%}"
    return score, shift, stretch, m, [f"harmony {harm:.0%}", f"rhythm {rhythm:.0%}", f"spectrum fit {spectrum:.0%} ({sub})", bass_why]


def _key_name(key: str | None, shift: int) -> str | None:
    if not key:
        return None
    k = parse_key(key)
    return _NAMES[(k.root_pc + shift) % 12] + ("m" if k.minor else "")


def _camelot(key: str | None) -> tuple[int, str] | None:
    if not key:
        return None
    k = parse_key(key)
    return next((num, "A" if k.minor else "B") for num, (mi, ma) in _CAMELOT.items() if (mi if k.minor else ma) == k.root_pc)


def _compatible(a: str | None, b: str | None) -> bool:
    """Neighbours on the Camelot wheel (the same key, its relative, a fifth either way); unknown keys pass."""
    ca, cb = _camelot(a), _camelot(b)
    if ca is None or cb is None:
        return True
    return ca[0] == cb[0] or (ca[1] == cb[1] and (ca[0] - cb[0]) % 12 in (1, 11))


def scan(query: MashSong, part: str, library: list[MashSong], *, start_bar: int | None = None, top: int = 50,
         bass_styles: list[str] | None = None, bpm_min: float | None = None, bpm_max: float | None = None,
         key_compatible_only: bool = False, borrow: str | None = None) -> list[MashMatch]:
    """Rank the other songs' parts against the query's `part` (every such part, or the one at `start_bar`).
    A build or vocals query sits over their drops; a drop query takes their builds, vocals and drops on top.
    Songs outside the tempo window (bpm_min / bpm_max, and the ±8 % stretch incl. half / double time) or, with
    key_compatible_only, off the query's Camelot neighbours (then unshifted) are dropped before any pairing;
    bass_styles keeps only parts whose section has one of those bass styles; `borrow` only that kind of their part."""
    qf = query.feats
    q_parts = [i for i in range(len(qf["kind"])) if PARTS[qf["kind"][i]] == part
               and (start_bar is None or qf["start_bar"][i] == start_bar)]
    q_on_top = part != "drop"
    q_bpm = float(query.analysis.bpm)
    best: dict[tuple[str, str, int], tuple] = {}
    for song in library:
        bpm = float(song.analysis.bpm)
        if song.song_id == query.song_id or (bpm_min and bpm < bpm_min) or (bpm_max and bpm > bpm_max):
            continue
        if _tempo(q_bpm, bpm) is None if q_on_top else _tempo(bpm, q_bpm) is None:
            continue
        if key_compatible_only and not _compatible(query.analysis.key, song.analysis.key):
            continue
        sf = song.feats
        for j in range(len(sf["kind"])):
            c_kind = PARTS[sf["kind"][j]]
            if (q_on_top and c_kind != "drop") or (borrow and c_kind != borrow):
                continue  # build / vocals queries take drops only
            if bass_styles is not None:
                sec = _section(song.structure, int(sf["start_bar"][j]))
                if sec is None or sec.bass_style not in bass_styles:
                    continue
            for i in q_parts:
                r = _score(query, i, song, j, key_compatible_only) if q_on_top else _score(song, j, query, i, key_compatible_only)
                if r is None:
                    continue
                k = (song.song_id, c_kind, int(sf["start_bar"][j]))
                if k not in best or r[0] > best[k][0]:
                    best[k] = (r[0], song, j, i, r)
    out = []
    for score, song, j, i, (_, shift, stretch, m, bits) in sorted(best.values(), key=lambda b: -b[0])[:top]:
        # the matched song moves: to the query's key and tempo
        c_shift, c_ratio = (-shift, 1 / stretch) if q_on_top else (shift, stretch)
        c_m = {1: "", 2: " (half time)", 0.5: " (double time)"}[m if not q_on_top else 1 / m]
        keys = (query.analysis.key, song.analysis.key)
        key = f" ({keys[1]} -> {_key_name(keys[1], c_shift)}, query in {keys[0]})" if all(keys) else ""
        sf = song.feats
        out.append(MashMatch(song_id=song.song_id, part=PARTS[sf["kind"][j]], start_bar=int(sf["start_bar"][j]),
                             bars=int(sf["beats"][j]) // 4, score=round(float(np.clip(score, 0, 100)), 1),
                             shift_st=int(c_shift), tempo_ratio=round(c_ratio, 4), from_start_bar=int(qf["start_bar"][i]),
                             reasons=[f"tempo {float(song.analysis.bpm):.1f} -> x{c_ratio:.3f}{c_m}", f"key {c_shift:+d} st{key}", *bits]))
    return out


def mash_scan(request: MashScanRequest, query: MashSong, library: list[MashSong]) -> list[MashMatch]:
    """FxAPI.mash_scan over the server's cached features: `query` is request.song_id's MashSong."""
    return scan(query, request.part, library, start_bar=request.start_bar, top=request.top, bass_styles=request.bass_styles,
                bpm_min=request.bpm_min, bpm_max=request.bpm_max, key_compatible_only=request.key_compatible_only,
                borrow=request.borrow)
