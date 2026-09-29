"""v0.7 songs: tempo, key and bar-1 analysis of an imported track (``analyze_song``), and the song + drop mix
(``mix_song``) behind the backing-track preview, baked exports and camera-clip soundtracks. numpy / scipy only.

Analysis runs on a mono mixdown at 22.05 kHz:
- tempo: a log spectral-flux onset envelope, its spectrum on a 0.01 BPM grid (chirp-z), scored with its 2nd and 4th
  harmonics and a mild prior, then folded by octaves into the 85-175 BPM dance range;
- beat phase: a sharp low-band + broadband attack function folded over one beat (≈4 ms bins); the same fold,
  kept sharpest over the whole song, refines the tempo to 0.005 BPM (snapping to a whole BPM when as sharp);
- bar phase: which of the 4 beats carries the low-end (kick / bass) accent and the harmonic change, with a small
  nudge towards the first beat the music starts on; bar 1 is the first downbeat once the music has started;
- key: harmonic chroma (time-median-filtered STFT) against the Krumhansl-Schmuckler major / minor profiles.
"""

from __future__ import annotations

import math

import numpy as np
from scipy import fft as sfft
from scipy import ndimage, signal

from fvwks_contracts.models import Loudness, Master, SongAnalysis, SongPlacement
from fvwks_contracts.seam import MixOutput

from .dsp import EPS, add_at, as2d, butter_sos, db_to_lin, envelope, fade_edges, lin_to_db, match_channels
from .master import _Chain, measure, resample, true_peak
from .music import _CAMELOT, _NAMES

AN_SR = 22050
FLUX_FFT, FLUX_HOP = 1024, 256  # onset envelope: 11.6 ms frames
FINE_HOP = 64  # attack function: 2.9 ms blocks
BPM_LO, BPM_HI = 60.0, 200.0  # tempo search
DANCE_LO, DANCE_HI = 85.0, 175.0  # half / double tempo resolves into this range
BPM_STEP = 0.01
BEATS_PER_BAR = 4
KEY_MIN_CONF = 0.1  # below this the key comes back None (key_confidence still reported)

KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


# --------------------------------------------------------------------------- analysis


def _mono_an(audio: np.ndarray, sr: int) -> np.ndarray:
    a = as2d(np.asarray(audio, dtype=np.float32))
    x = a.mean(axis=0) if a.shape[0] > 1 else a[0]
    x = resample(x[None, :], int(sr), AN_SR)[0].astype(np.float32)
    pk = float(np.max(np.abs(x))) if x.size else 0.0
    return x / pk if pk > EPS else x


def _mag_frames(x: np.ndarray, n_fft: int, hop: int, block: int = 4096) -> np.ndarray:
    """|STFT| of centred Hann frames (frame i centred on i * hop), shape (frames, bins), float32."""
    xp = np.pad(x, (n_fft // 2, n_fft // 2))
    frames = np.lib.stride_tricks.sliding_window_view(xp, n_fft)[::hop]
    win = np.hanning(n_fft).astype(np.float32)
    out = np.empty((frames.shape[0], n_fft // 2 + 1), np.float32)
    for s in range(0, frames.shape[0], block):
        out[s : s + block] = np.abs(sfft.rfft(frames[s : s + block] * win, axis=1, workers=-1))
    return out


def _onset_envelope(x: np.ndarray) -> np.ndarray:
    """Log spectral flux, local mean removed (tempo only: its latency doesn't matter there)."""
    mag = _mag_frames(x, FLUX_FFT, FLUX_HOP)
    lg = np.log1p(100.0 * mag)
    flux = np.maximum(lg[1:] - lg[:-1], 0.0).sum(axis=1)
    fps = AN_SR / FLUX_HOP
    local = ndimage.uniform_filter1d(flux, size=max(3, int(round(0.4 * fps))), mode="nearest")
    return np.maximum(flux - local, 0.0).astype(np.float64)


def _spectrum_on_grid(o: np.ndarray, fps: float, f_max: float, df: float) -> np.ndarray:
    """|DFT| of ``o`` at k * df for k = 0 .. f_max / df, normalized by sum(o) (a vector strength, 0..1)."""
    m = int(math.ceil(f_max / df)) + 1
    z = signal.zoom_fft(o - 0.0, [0.0, df * m], m=m, fs=fps, endpoint=False)
    return np.abs(z) / max(float(o.sum()), EPS)


def _tempo(o: np.ndarray, fps: float) -> tuple[float, float]:
    """(bpm, confidence) from the onset envelope's harmonic spectrum."""
    df = BPM_STEP / 60.0
    spec = _spectrum_on_grid(o, fps, 4.0 * BPM_HI / 60.0 + df, df)
    k = np.arange(int(round(BPM_LO / BPM_STEP)), int(round(BPM_HI / BPM_STEP)) + 1)

    def at(idx: np.ndarray) -> np.ndarray:
        return spec[np.minimum(idx, spec.size - 1)]

    score = at(k) + 0.5 * at(2 * k) + 0.25 * at(4 * k)
    bpms = k * BPM_STEP
    prior = np.exp(-0.5 * (np.log2(bpms / 120.0) / 1.0) ** 2)
    i = int(np.argmax(score * prior))

    def refine(j: int) -> float:
        if 0 < j < score.size - 1:
            a, b, c = score[j - 1], score[j], score[j + 1]
            den = a - 2 * b + c
            off = 0.5 * (a - c) / den if abs(den) > 1e-12 else 0.0
            return (k[j] + float(np.clip(off, -0.5, 0.5))) * BPM_STEP
        return float(bpms[j])

    def local_max(b: float) -> int:  # the score peak within ±1.5 % of b
        lo = int(np.searchsorted(bpms, b * 0.985))
        hi = int(np.searchsorted(bpms, b * 1.015))
        if hi <= lo:
            return int(np.clip(np.searchsorted(bpms, b), 0, bpms.size - 1))
        return lo + int(np.argmax(score[lo:hi]))

    best = refine(i)
    # half / double: resolve into the dance range, by harmonic score when two octaves both fit
    cands = []
    for mult in (0.5, 1.0, 2.0):
        b = best * mult
        if BPM_LO <= b <= BPM_HI:
            j = local_max(b)
            cands.append((refine(j), float(score[j])))
    inside = [c for c in cands if DANCE_LO <= c[0] <= DANCE_HI]
    pick = max(inside, key=lambda c: c[1]) if inside else (refine(i), float(score[i]))
    bpm = pick[0]
    j = local_max(bpm)
    strength = float(spec[min(int(k[j]), spec.size - 1)])  # vector strength of the beat frequency
    contrast = float(score[j] / max(float(np.median(score)), EPS))
    conf = float(np.clip(0.6 * min(1.0, strength / 0.35) + 0.4 * min(1.0, (contrast - 1.0) / 8.0), 0.0, 1.0))
    if len(inside) > 1 and min(c[1] for c in inside) > 0.8 * max(c[1] for c in inside):
        conf *= 0.7  # two octaves both plausible
    return bpm, conf


def _band_energy(x: np.ndarray, sos_coef: np.ndarray | None) -> np.ndarray:
    y = signal.sosfiltfilt(sos_coef, x) if sos_coef is not None else x  # zero-phase: no low-band delay
    n = y.size // FINE_HOP
    return (y[: n * FINE_HOP].astype(np.float64).reshape(n, FINE_HOP) ** 2).mean(axis=1)


def _attack(e: np.ndarray) -> np.ndarray:
    """Rise of the log energy per block: sharp at an attack, for kicks after silence or over a mix alike."""
    ref = float(np.percentile(e, 99)) if e.size else 1.0
    lg = 10 * np.log10(np.maximum(e, ref * 1e-8) + 1e-20)
    return np.maximum(np.diff(lg, prepend=lg[:1]), 0.0)


def _fold(att: np.ndarray, period_s: float) -> np.ndarray:
    """The attack function folded over one beat (≈4 ms bins, lightly smoothed)."""
    bins = max(32, int(period_s / 0.004))
    t = (np.arange(att.size) + 0.5) * FINE_HOP / AN_SR
    idx = ((t % period_s) / period_s * bins).astype(np.int64) % bins
    h = np.bincount(idx, weights=att, minlength=bins)
    return ndimage.convolve1d(h, np.array([0.25, 0.5, 0.25]), mode="wrap")


def _refine_bpm(att: np.ndarray, bpm: float) -> float:
    """The tempo whose beat grid stays sharpest over the whole song (±0.15 BPM, 0.005 steps): a grid that is off
    by 0.02 BPM drifts ~20 ms over 2.5 minutes. Whole BPMs win ties, as produced tracks usually sit on one."""
    def sharp(b: float) -> float:
        h = ndimage.convolve1d(_fold(att, 60.0 / b), np.array([1.0, 2.0, 3.0, 2.0, 1.0]) / 9.0, mode="wrap")
        return float(h.max() / max(float(h.sum()), EPS))  # smoothed: 4 ms binning jitter doesn't pick the tempo

    cands = bpm + np.arange(-0.15, 0.1501, 0.005)
    sc = np.array([sharp(b) for b in cands])
    best = float(cands[int(np.argmax(sc))])
    whole = float(round(best))
    if abs(whole - best) <= 0.06 and sharp(whole) >= 0.97 * float(sc.max()):
        return whole
    return best


def _beat_phase(att: np.ndarray, period_s: float) -> float:
    """Beat phase in [0, period): the peak of the attack function folded over one beat."""
    h = _fold(att, period_s)
    bins = h.size
    j = int(np.argmax(h))
    a, b, c = h[(j - 1) % bins], h[j], h[(j + 1) % bins]
    den = a - 2 * b + c
    off = 0.5 * (a - c) / den if abs(den) > 1e-12 else 0.0
    return ((j + 0.5 + float(np.clip(off, -0.5, 0.5))) / bins * period_s) % period_s


def _chroma(x: np.ndarray, hop_s: float) -> tuple[np.ndarray, float]:
    """Harmonic chroma frames (frames, 12), each frame L1-normalized, and the frame rate. 11.025 kHz, 4096 FFT.
    The power per pitch class, then compressed (^0.25): summing a compressed value per FFT bin instead would weight
    each class by its bins-per-semitone count, a fixed ramp from C to B that broadband sound (drums, growls) turns
    into a false key (S3's finding)."""
    sr = AN_SR // 2
    y = signal.resample_poly(x, 1, 2)
    hop = max(256, int(round(hop_s * sr)))
    f = np.fft.rfftfreq(4096, 1.0 / sr)
    use = (f >= 55.0) & (f <= 2000.0)
    mag = _mag_frames(y.astype(np.float32), 4096, hop)[:, use]
    pw = ndimage.median_filter(mag, size=(9, 1), mode="nearest") ** 2  # keep the sustained (harmonic) part
    pc = np.round(69.0 + 12.0 * np.log2(f[use] / 440.0)).astype(np.int64) % 12
    ch = np.stack([pw[:, pc == k].sum(axis=1) for k in range(12)], axis=1) ** 0.25
    tot = ch.sum(axis=1, keepdims=True)
    return ch / np.maximum(tot, EPS), sr / hop


def _key(ch: np.ndarray) -> tuple[str | None, str | None, float]:
    if ch.size == 0:
        return None, None, 0.0
    w = ch.sum(axis=1)
    keep = w > 0
    prof = ch[keep].mean(axis=0) if keep.any() else ch.mean(axis=0)
    best = (-2.0, 0, False)
    scores = []
    for root in range(12):
        for minor, tpl in ((False, KS_MAJOR), (True, KS_MINOR)):
            r = float(np.corrcoef(prof, np.roll(tpl, root))[0, 1])
            scores.append(r)
            if r > best[0]:
                best = (r, root, minor)
    r, root, minor = best
    # scores[2 * root + minor]; the relative key shares the notes, so it isn't a rival
    rel = 2 * ((root + 3) % 12) + 0 if minor else 2 * ((root - 3) % 12) + 1
    rivals = [s for i, s in enumerate(scores) if i not in (2 * root + int(minor), rel)]
    margin = r - max(rivals) if rivals else r
    conf = float(np.clip((r - 0.3) / 0.5, 0.0, 1.0) * np.clip(margin / 0.15, 0.0, 1.0))
    if r < 0.3 or conf < KEY_MIN_CONF:  # unclear: the app asks for the key rather than show a shaky guess
        return None, None, round(conf, 3)
    num = next(n for n, (mi, ma) in _CAMELOT.items() if (mi if minor else ma) == root)
    return _NAMES[root] + ("m" if minor else ""), f"{num}{'A' if minor else 'B'}", conf


def _zs(v: np.ndarray) -> np.ndarray:
    sd = float(np.std(v))
    return (v - float(np.mean(v))) / sd if sd > 1e-9 else np.zeros_like(v)


def _downbeat(x: np.ndarray, e_low: np.ndarray, e_full: np.ndarray, period: float, phase: float,
              ch: np.ndarray, ch_fps: float) -> float:
    dur = x.size / AN_SR
    thr = float(np.percentile(e_full, 99)) * 1e-4 if e_full.size else 0.0  # -40 dB under the loud part
    loud = np.nonzero(e_full > thr)[0]
    start = (loud[0] * FINE_HOP / AN_SR) if loud.size else 0.0
    beats = phase + period * np.arange(int(max(0.0, dur - phase) / period) + 1)
    beats = beats[beats < dur]
    if beats.size < BEATS_PER_BAR * 2:
        first = beats[beats >= start - 0.5 * period]
        return float(first[0]) if first.size else float(phase)
    fps_fine = AN_SR / FINE_HOP

    def seg_mean(v: np.ndarray, fps: float, a: float, b: float) -> float:
        i, j = int(a * fps), max(int(a * fps) + 1, int(b * fps))
        return float(v[i:j].mean()) if i < v.size else 0.0

    low = np.array([10 * math.log10(seg_mean(e_low, fps_fine, t, t + 0.35 * period) + 1e-12) for t in beats])
    cb = np.array([ch[int(t * ch_fps) : max(int(t * ch_fps) + 1, int((t + period) * ch_fps))].mean(axis=0)
                   if int(t * ch_fps) < ch.shape[0] else np.zeros(12) for t in beats])
    nb = np.linalg.norm(cb, axis=1) + EPS
    cos = np.einsum("ij,ij->i", cb[1:], cb[:-1]) / (nb[1:] * nb[:-1])
    nov = np.concatenate([[0.0], 1.0 - cos])
    live = np.array([seg_mean(e_full, fps_fine, t, t + period) > thr for t in beats])
    feat = _zs(low) + _zs(nov)
    score = np.zeros(BEATS_PER_BAR)
    for m in range(BEATS_PER_BAR):
        sel = (np.arange(beats.size) % BEATS_PER_BAR == m) & live
        score[m] = float(feat[sel].mean()) if sel.any() else -1e9
    first_live = int(np.argmax(live)) if live.any() else 0
    score[first_live % BEATS_PER_BAR] += 0.25  # tracks tend to start on bar 1
    m = int(np.argmax(score))
    downs = beats[np.arange(beats.size) % BEATS_PER_BAR == m]
    ok = downs[downs >= start - 0.5 * period]
    return float(ok[0]) if ok.size else float(downs[0])


def analyze_song(audio: np.ndarray, sr: int) -> SongAnalysis:
    """Tempo, key and bar-1 position of a song. ``audio`` is (channels, n) float32 at ``sr`` (the file's own rate)."""
    x = _mono_an(audio, sr)
    if x.size < AN_SR * 2 or float(np.max(np.abs(x))) < 1e-6:
        return SongAnalysis(bpm=120.0, bpm_confidence=0.0, key=None, camelot=None, key_confidence=0.0, downbeat_s=0.0,
                            beats_per_bar=BEATS_PER_BAR)
    o = _onset_envelope(x)
    bpm, bpm_conf = _tempo(o, AN_SR / FLUX_HOP)
    e_low = _band_energy(x, butter_sos("bandpass", (30.0, 150.0), AN_SR, 2))
    e_full = _band_energy(x, None)
    att = _attack(e_low) + 0.5 * _attack(e_full)
    bpm = _refine_bpm(att, bpm)
    period = 60.0 / bpm
    phase = _beat_phase(att, period)
    ch, ch_fps = _chroma(x, 0.09)
    key, camelot, key_conf = _key(ch)
    down = _downbeat(x, e_low, e_full, period, phase, ch, ch_fps)
    return SongAnalysis(bpm=round(bpm, 2), bpm_confidence=round(bpm_conf, 3), key=key, camelot=camelot,
                        key_confidence=round(key_conf, 3), downbeat_s=round(max(0.0, down), 4),
                        beats_per_bar=BEATS_PER_BAR)


# --------------------------------------------------------------------------- mix

CHUNK_S, OVERLAP_S = 20.0, 1.0  # whole-song mixes are limited and metered in chunks (bounded memory)
DUCK_ATTACK_S = 0.010
LIMIT_MARGIN_S = 0.5  # context kept around an excerpt for the duck release and the limiter
EDGE_FADE_S = 0.005


def duck_gain(drop: np.ndarray, sr: int, duck_db: float, bpm: float) -> np.ndarray:
    """Song gain (linear, per sample) under the drop: ``duck_db`` while the drop's voice is present. A ~10 ms
    attack and a release of half a beat (250 ms at 120 BPM, 150-350 ms), so the song swells back in time."""
    if duck_db >= -0.01 or drop.size == 0:
        return np.ones(as2d(drop).shape[1], np.float32)
    beat = 60.0 / bpm if bpm and bpm > 0 else 0.5
    release = float(np.clip(0.5 * beat, 0.15, 0.35))
    env = envelope(as2d(drop).mean(axis=0), sr, attack_s=DUCK_ATTACK_S, release_s=release)
    env_db = lin_to_db(env)
    active = env_db[env_db > -70.0]
    if active.size == 0:
        return np.ones(env.size, np.float32)
    ref = float(np.percentile(active, 95))
    amount = np.clip((env_db - (ref - 36.0)) / 24.0, 0.0, 1.0)  # full duck from 12 dB under the drop's level up
    return db_to_lin(duck_db * amount).astype(np.float32)


def _chunked(x: np.ndarray, sr: int, fn) -> np.ndarray:
    """``fn`` (length-preserving) over overlapping chunks, the middles stitched: with 1 s of shared context on
    each side a limiter's state has converged, so the seams are sample-identical in practice."""
    n = x.shape[1]
    step, ov = int(CHUNK_S * sr), int(OVERLAP_S * sr)
    if n <= step + 2 * ov:
        return fn(x)
    out = np.empty_like(x)
    for i in range(0, n, step):
        a, b = max(0, i - ov), min(n, i + step + ov)
        m = min(step, n - i)
        out[:, i : i + m] = fn(x[:, a:b])[:, i - a : i - a + m]
    return out


def _true_peak(x: np.ndarray, sr: int) -> float:
    n, step, pad = x.shape[1], int(CHUNK_S * sr), 512
    if n == 0:
        return -150.0
    return max(true_peak(x[:, max(0, i - pad) : min(n, i + step + pad)], sr) for i in range(0, n, step))


def _loudness(z: np.ndarray, sr: int) -> Loudness:
    rep = measure(z, sr, _true_peak(z, sr))
    return Loudness(integrated_lufs=round(float(rep.integrated_lufs), 3), short_term_max_lufs=round(float(rep.short_term_max_lufs), 3),
                    true_peak_db=round(float(rep.true_peak_dbtp), 3), sample_peak_db=round(float(rep.sample_peak_dbfs), 3))


def mix_song(song: np.ndarray, song_sr: int, drop: np.ndarray, drop_sr: int, *, drop_start_s: float, bpm: float,
             placement: SongPlacement, excerpt_s: tuple[float, float] | None, master: Master, quality: str) -> MixOutput:
    """Put the (already mastered) drop into the song at ``drop_start_s`` on the song's timeline: duck the song under
    it, apply the gains, keep true peak <= master.true_peak_db (no loudness normalization: the song is mastered),
    and return the excerpt [start, end) of the song timeline (None = the whole song) at master.sample_rate."""
    sr, chans = int(master.sample_rate), int(master.channels)
    warnings: list[str] = []
    s = match_channels(resample(np.asarray(song, dtype=np.float32), int(song_sr), sr), chans)
    d = match_channels(resample(np.asarray(drop, dtype=np.float32), int(drop_sr), sr), chans)
    n_song = s.shape[1]
    at = int(round(drop_start_s * sr))
    drop_end = at + d.shape[1]
    timeline = max(n_song, drop_end)
    if drop_end > n_song:
        warnings.append(f"the drop runs {(drop_end - n_song) / sr:.2f} s past the song's end")
    if at < 0:
        warnings.append(f"the drop starts {-at / sr:.2f} s before the song: its start is cut")

    a = 0 if excerpt_s is None else int(round(max(0.0, excerpt_s[0]) * sr))
    b = timeline if excerpt_s is None or excerpt_s[1] is None else int(round(excerpt_s[1] * sr))
    b = min(b, timeline)
    if b <= a:
        raise ValueError(f"empty excerpt: {a / sr:.3f}-{b / sr:.3f} s on a {timeline / sr:.3f} s timeline")
    if excerpt_s is not None and at < drop_end and (at < a < drop_end or at < b < drop_end):
        warnings.append("the excerpt cuts into the drop")

    # work on the excerpt plus a margin (the duck's release and the limiter's lookahead see real context)
    margin = int(LIMIT_MARGIN_S * sr)
    wa, wb = max(0, a - margin), min(timeline, b + margin)
    song_w = np.zeros((chans, wb - wa), np.float32)
    add_at(song_w, s, -wa)
    drop_w = np.zeros_like(song_w)
    add_at(drop_w, d, at - wa)
    g_song = np.float32(db_to_lin(placement.song_gain_db))
    g_drop = np.float32(db_to_lin(placement.drop_gain_db))
    mix = song_w * g_song * duck_gain(drop_w, sr, placement.duck_db, bpm)[None, :] + drop_w * g_drop

    ceiling = float(master.true_peak_db)
    tp = _true_peak(mix, sr)
    if tp > ceiling:
        mix = _chunked(mix, sr, lambda seg: _Chain(seg, sr, ceiling - 0.25, soft_clip=False)(0.0))
        tp = _true_peak(mix, sr)
        if tp > ceiling - 0.02:
            mix = mix * np.float32(db_to_lin(ceiling - 0.02 - tp))
    z = np.ascontiguousarray(mix[:, a - wa : b - wa], dtype=np.float32)
    fade = max(1, int(EDGE_FADE_S * sr))
    z = fade_edges(z, fade, fade).astype(np.float32)
    z[:, 0] = 0.0  # like the master: a clip never starts or ends on a click
    z[:, -1] = 0.0
    return MixOutput(audio=z, sample_rate=sr, start_s=round(a / sr, 6), drop_start_s=round((at - a) / sr, 6),
                     loudness=_loudness(z, sr), warnings=warnings)
