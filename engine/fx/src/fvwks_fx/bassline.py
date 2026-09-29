"""v0.10.1 bass-line intelligence for bass music (deep / dub, trap, dubstep / riddim), from the bass stem.

Per frame (the stem-feature frame rate, 60 fps), encoded as StemFeatures.bass_b64 (4 bytes a frame):
  flags  bit0 a bass note is on (30-600 Hz amplitude within 18 dB of the song's loudest), bit1 a note starts here
         (low-band spectral flux peaks, and every on-edge: a held sub doesn't retrigger, riddim stabs each do)
  sub    < 60 Hz amplitude, 0-255, against the song's 30-600 Hz peak
  growl  100-600 Hz amplitude (the mid-bass growl), 0-255, on the same scale
  pitch  the bass's f0 (28-120 Hz) as MIDI x 2 (0 = none): autocorrelation of the < 150 Hz band over 100 ms (808s
         and glides)
Per section (SongSection.bass_style / half_time / note_beats / wobble_div / wobble_anchor_s):
  note_beats  the median note length in beats (from note starts to the next start or the note's end)
  wobble      the growl envelope's dominant LFO as a beat division, 1/4T down to 1/16T (the quarter-note sidechain
              pump nearly every track has is not a wobble), with an LFO peak as the phase anchor; growl-heavy only
  half_time   the snare / clap (150-2500 Hz hits of the drums) lands on beat 3 rather than on 2 and 4
  style       deep (sub-heavy, notes 1.5+ beats), dubstep (growl-heavy, a wobble or stabs), trap (a pitched sub that
              glides, or half-time over a sub), else other; None where the bass barely plays
Everything runs on the stems at 2.4 kHz (the bass) or 22.05 kHz (the drums): about a second for a whole song.
"""

from __future__ import annotations

import numpy as np
from scipy import ndimage, signal

from .dsp import EPS, as2d

LOW_SR = 2400
N_FFT = 256
ON_DB = -18.0
DIVISIONS = {"1/4T": 2 / 3, "1/8": 0.5, "1/8T": 1 / 3, "1/16": 0.25, "1/16T": 1 / 6}


def _mono(x: np.ndarray) -> np.ndarray:
    a = as2d(np.asarray(x, dtype=np.float32))
    return a.mean(axis=0) if a.shape[0] > 1 else a[0]


class BassFrames:
    """The per-frame bass line of a song (or of a stem): arrays of length `frames`."""

    def __init__(self, bass: np.ndarray, sr: int, fps: float, frames: int):
        self.fps = fps
        x = signal.resample_poly(_mono(bass).astype(np.float64), LOW_SR, int(sr))
        hop = LOW_SR / fps
        idx = np.round(np.arange(frames) * hop).astype(np.int64)
        # spectra on 107 ms frames centred on each feature frame
        xp = np.pad(x, (N_FFT // 2, N_FFT // 2 + N_FFT))
        win = np.hanning(N_FFT)
        spec = np.abs(np.fft.rfft(np.stack([xp[i : i + N_FFT] for i in idx]) * win, axis=1)) if frames else np.zeros((0, N_FFT // 2 + 1))
        f = np.fft.rfftfreq(N_FFT, 1.0 / LOW_SR)
        amp = lambda lo, hi: np.sqrt((spec[:, (f >= lo) & (f < hi)] ** 2).sum(axis=1))
        sub, growl, total, fund = amp(20, 60), amp(100, 600), amp(30, 600), amp(28, 150)
        peak = max(float(total.max()) if frames else 0.0, EPS)
        # one scale (the bass's peak), so sub and growl compare: a faint growl stays faint
        self.sub = np.minimum(sub / peak, 1.0)
        self.growl = np.minimum(growl / peak, 1.0)
        self.level = np.minimum(total / peak, 1.0)  # the 30-600 Hz level: the bounce (sidechain pumps, stabs)
        self.on = total >= peak * 10 ** (ON_DB / 20)
        # note starts: low-band flux peaks while on, plus every on-edge
        lg = np.log1p(50.0 * spec[:, (f >= 30) & (f < 600)] / peak)
        flux = np.concatenate([[0.0], np.maximum(lg[1:] - lg[:-1], 0.0).sum(axis=1)])
        mean = ndimage.uniform_filter1d(flux, max(3, int(fps)), mode="nearest")
        sd = np.sqrt(np.maximum(ndimage.uniform_filter1d(flux**2, max(3, int(fps)), mode="nearest") - mean**2, 0))
        pk = flux >= ndimage.maximum_filter1d(flux, 5, mode="nearest")
        edge = self.on & ~np.concatenate([[False], self.on[:-1]])
        flux_start = self.on & pk & (flux > mean + 1.5 * sd + 0.05)
        # the sub's pitch: autocorrelation of the < 150 Hz band over 100 ms
        lp = signal.sosfiltfilt(signal.butter(4, 150, "low", fs=LOW_SR, output="sos"), x) if x.size > 50 else x
        w = int(0.1 * LOW_SR)
        lpp = np.pad(lp, (w // 2, w))
        seg = np.stack([lpp[i : i + w] for i in idx]) if frames else np.zeros((0, w))
        seg = seg - seg.mean(axis=1, keepdims=True)
        spec2 = np.fft.rfft(seg, 2 * w, axis=1)
        ac = np.fft.irfft(np.abs(spec2) ** 2, axis=1)[:, :w]
        ac /= np.maximum(ac[:, :1], EPS)
        lo_lag, hi_lag = int(LOW_SR / 120), int(LOW_SR / 28)
        lag = lo_lag + np.argmax(ac[:, lo_lag:hi_lag], axis=1) if frames else np.zeros(0, int)
        rows = np.arange(frames)
        val = ac[rows, lag] if frames else np.zeros(0)
        a_, b_, c_ = ac[rows, lag - 1], val, ac[rows, np.minimum(lag + 1, w - 1)]
        with np.errstate(divide="ignore", invalid="ignore"):  # np.where computes both branches
            off = np.where(np.abs(a_ - 2 * b_ + c_) > 1e-9, 0.5 * (a_ - c_) / (a_ - 2 * b_ + c_), 0.0)
        f0 = LOW_SR / np.maximum(lag + np.clip(off, -0.5, 0.5), 1)
        voiced = self.on & (val >= 0.6) & (fund >= 0.2 * peak)  # a strong fundamental band (28-150 Hz), not just < 60
        self.midi = np.where(voiced, 69 + 12 * np.log2(f0 / 440.0), 0.0)
        # a legato start (a flux peak, not an on-edge) changes something: the pitch (0.5 st across it, or voicing) or
        # the level (up 20 %); a steady tone's window-phase leakage makes flux peaks too
        shift = lambda v, k: np.concatenate([np.zeros(k), v[:-k]]) if k > 0 else np.concatenate([v[-k:], np.zeros(-k)])
        mb, ma = shift(self.midi, 4), shift(self.midi, -4)
        moved = ((mb > 0) & (ma > 0) & (np.abs(ma - mb) >= 0.5)) | ((mb > 0) != (ma > 0))
        rose = shift(self.level, -3) >= 1.2 * shift(self.level, 2)
        self.note_on = edge | (flux_start & (moved | rose))

    def encode(self) -> np.ndarray:
        """StemFeatures.bass_b64 bytes: (frames, 4) uint8."""
        n = self.on.size
        out = np.zeros((n, 4), np.uint8)
        out[:, 0] = self.on.astype(np.uint8) | (self.note_on.astype(np.uint8) << 1)
        out[:, 1] = np.clip(np.round(self.sub * 255), 0, 255)
        out[:, 2] = np.clip(np.round(self.growl * 255), 0, 255)
        out[:, 3] = np.where(self.midi > 0, np.clip(np.round(self.midi * 2), 1, 255), 0)
        return out

    def wobble(self, a: int, b: int, beat: float) -> tuple[str | None, float | None]:
        """The growl envelope's LFO over frames [a, b) as a beat division and the time of an LFO peak; growl-heavy
        stretches of 4+ beats only, else (None, None)."""
        on, sub, growl = self.on[a:b], self.sub[a:b], self.growl[a:b]
        if not on.any() or growl[on].mean() < 0.8 * sub[on].mean() or on.size < 4 * beat * self.fps:
            return None, None
        g = (growl - ndimage.uniform_filter1d(growl, max(3, int(2 * beat * self.fps)), mode="nearest")) * on
        ac = np.correlate(g, g, "full")[g.size - 1 :]
        if ac[0] <= EPS:
            return None, None
        ac = ac / ac[0]
        scores = {d: float(np.interp(p * beat * self.fps, np.arange(ac.size), ac)) for d, p in DIVISIONS.items()}
        div, score = max(scores.items(), key=lambda kv: kv[1])
        if score < 0.35:
            return None, None
        period = int(round(DIVISIONS[div] * beat * self.fps))
        fold = np.array([g[k::period].mean() for k in range(max(1, period))])
        return div, round((a + int(np.argmax(fold))) / self.fps, 4)

    # ------------------------------------------------------------------------------------------ per section
    def section(self, t0: float, t1: float, beat: float, drums: np.ndarray | None = None, drums_sr: int = 0,
                downbeat: float = 0.0) -> dict:
        a, b = int(t0 * self.fps), max(int(t0 * self.fps) + 1, int(t1 * self.fps))
        on, sub, growl = self.on[a:b], self.sub[a:b], self.growl[a:b]
        out: dict = {"bass_style": None, "half_time": False, "note_beats": None, "wobble_div": None, "wobble_anchor_s": None}
        if drums is not None:
            out["half_time"] = _half_time(drums, drums_sr, t0, t1, beat, downbeat)
        if on.size == 0 or on.mean() < 0.2:
            return out
        # notes: each start to the next start or the end of the note
        starts = np.nonzero(self.note_on[a:b])[0]
        lengths = []
        for i, s in enumerate(starts):
            nxt = starts[i + 1] if i + 1 < starts.size else on.size
            off = np.nonzero(~on[s:nxt])[0]
            lengths.append(((off[0] if off.size else nxt - s)) / self.fps / beat)
        note_beats = float(np.median(lengths)) if lengths else None
        out["note_beats"] = round(max(note_beats, 1 / 16), 3) if note_beats else None
        ms, mg = float(sub[on].mean()), float(growl[on].mean())
        out["wobble_div"], out["wobble_anchor_s"] = self.wobble(a, b, beat)
        voiced = self.midi[a:b] > 0
        glides = 0
        if voiced.sum() > 8:
            m = self.midi[a:b]
            d = np.abs(np.diff(m)) * self.fps  # semitones per second
            # inside a note only: the pitch estimate slides across every note change (its 100 ms window), so the
            # first 150 ms after a start don't count, and a glide is a run of 4+ frames
            settled = ~ndimage.binary_dilation(self.note_on[a:b], np.ones(int(0.15 * self.fps) * 2 + 1, bool), origin=-int(0.15 * self.fps))
            moving = (d > 3) & (d < 60) & voiced[1:] & voiced[:-1] & settled[1:]
            runs, count = ndimage.label(moving)
            for r in range(1, count + 1):  # a slide travels (808 slides are 3-12 semitones; a step between notes isn't)
                idx = np.nonzero(runs == r)[0]
                if idx.size >= 4 and abs(m[idx[-1] + 1] - m[idx[0]]) >= 2.5:
                    glides += idx.size
        pitched = voiced.sum() >= 0.5 * on.sum()
        nb = out["note_beats"] or 1.0
        if pitched and (glides >= 0.03 * on.sum() or (out["half_time"] and ms > mg)):
            out["bass_style"] = "trap"
        elif mg > 1.2 * ms and (out["wobble_div"] or nb <= 0.5):
            out["bass_style"] = "dubstep"
        elif ms > 1.5 * mg and nb >= 1.5:
            out["bass_style"] = "deep"
        else:
            out["bass_style"] = "other"
        return out


def _half_time(drums: np.ndarray, sr: int, t0: float, t1: float, beat: float, downbeat: float) -> bool:
    """The snare / clap on beat 3 rather than on 2 and 4 (150-2500 Hz hits of the drums, summed per beat of the bar)."""
    a, b = int(max(0.0, t0) * sr), int(t1 * sr)
    x = _mono(drums)[a:b].astype(np.float64)
    if x.size < int(4 * 4 * beat * sr):
        return False
    y = signal.sosfilt(signal.butter(2, (150, 2500), "band", fs=sr, output="sos"), x)
    hop = max(1, int(sr / 200))
    e = np.sqrt((y[: y.size // hop * hop].reshape(-1, hop) ** 2).mean(axis=1))
    rise = np.maximum(np.diff(e, prepend=e[:1]), 0)
    t = t0 + np.arange(rise.size) * hop / sr
    pos = np.floor(((t - downbeat) / beat) % 4 + 0.15).astype(int) % 4  # which beat of the bar (a little early counts)
    near = np.abs(((t - downbeat) / beat) - np.round((t - downbeat) / beat)) < 0.15
    s = [float(rise[(pos == k) & near].sum()) for k in range(4)]
    return s[2] > 1.6 * max(s[1], s[3], EPS)
