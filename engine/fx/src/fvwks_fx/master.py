"""MASTER: BS.1770 loudness (pyloudnorm's K-weighting filters), true peak, and the three modes.

- CLUB: short-term max (3 s windows) at the target (default -7 LUFS), true peak <= ceiling (-1 dBTP) via
  pedalboard.BrickwallLimiter(true_peak=True). pedalboard documents that its true-peak mode "does not
  guarantee" the ceiling, so we measure true peak ourselves (4x oversampling, BS.1770-4 Annex 2) and trim.
- BAKE-IN: sample peaks at -6 dBFS, no limiting (for mixing into songs).
- CUSTOM: integrated LUFS target with the same true-peak ceiling.

Resampling 48k -> 44.1k uses ``scipy.signal.resample_poly(x, 147, 160)`` and the result is cut to the exact
output length.
"""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from functools import lru_cache
from math import gcd

import numpy as np
import pedalboard
import pyloudnorm
from scipy import signal

from .dsp import EPS, as2d, db_to_lin, fade_edges, fit_length, lin_to_db, to_stereo

SHORT_TERM_S = 3.0
# loudness-search candidates run concurrently (pedalboard / scipy release the GIL); separate from the rack's
# pool so a dry-A/B master running inside it never waits on its own pool
EVAL_POOL = ThreadPoolExecutor(max_workers=6, thread_name_prefix="fvwks-master")
_HINTS: dict[str, tuple[float, float]] = {}  # hint_key -> (input gain dB, limiter ceiling) of the last master
_HINTS_LOCK = threading.Lock()  # renders may run concurrently (the server overlaps interactive and batch work)
SHORT_TERM_HOP_S = 0.1
_CH_GAINS = (1.0, 1.0, 1.0, 1.41, 1.41)


# --------------------------------------------------------------------------- measurement


@lru_cache(maxsize=8)
def _kw_filters(sr: int) -> tuple[tuple[np.ndarray, np.ndarray, float], ...]:
    meter = pyloudnorm.Meter(sr)
    return tuple((f.b, f.a, float(f.passband_gain)) for f in meter._filters.values())


def k_weight(x: np.ndarray, sr: int) -> np.ndarray:
    y = as2d(x).astype(np.float64)
    for b, a, g in _kw_filters(sr):
        y = g * signal.lfilter(b, a, y, axis=-1)
    return y


def short_term_loudness(x: np.ndarray, sr: int, window_s: float = SHORT_TERM_S, hop_s: float = SHORT_TERM_HOP_S,
                        kw: np.ndarray | None = None) -> np.ndarray:
    """Short-term loudness curve (LUFS) on sliding ``window_s`` windows every ``hop_s``.

    Signals shorter than one window are measured over their full length (a 1-bar drop is never diluted
    by imaginary silence)."""
    kw = k_weight(x, sr) if kw is None else kw
    n = kw.shape[1]
    w = int(round(window_s * sr))
    if n == 0:
        return np.array([-np.inf])
    if n <= w:
        z = np.mean(kw * kw, axis=1)
        tot = float(np.sum([_CH_GAINS[i] * z[i] for i in range(z.size)]))
        return np.array([-0.691 + 10 * np.log10(max(tot, 1e-20))])
    c = np.concatenate([np.zeros((kw.shape[0], 1)), np.cumsum(kw * kw, axis=1)], axis=1)
    hop = max(1, int(round(hop_s * sr)))
    starts = np.arange(0, n - w + 1, hop)
    if starts[-1] != n - w:
        starts = np.append(starts, n - w)
    z = (c[:, starts + w] - c[:, starts]) / w
    gains = np.array(_CH_GAINS[: z.shape[0]])[:, None]
    tot = np.sum(gains * z, axis=0)
    return -0.691 + 10 * np.log10(np.maximum(tot, 1e-20))


def short_term_max(x: np.ndarray, sr: int) -> float:
    return float(np.max(short_term_loudness(x, sr)))


def integrated_lufs(x: np.ndarray, sr: int, kw: np.ndarray | None = None) -> float:
    """Gated integrated loudness (BS.1770-4: 400 ms blocks, 75 % overlap, -70 LUFS absolute and -10 LU
    relative gates) on pyloudnorm's K-weighting filters, vectorised with a cumulative sum."""
    kw = k_weight(x, sr) if kw is None else kw
    n = kw.shape[1]
    w = int(round(0.4 * sr))
    if n < w:
        kw = np.pad(kw, ((0, 0), (0, w - n)))
        n = w
    step = int(round(0.1 * sr))
    c = np.concatenate([np.zeros((kw.shape[0], 1)), np.cumsum(kw * kw, axis=1)], axis=1)
    starts = np.arange(0, n - w + 1, step)
    z = (c[:, starts + w] - c[:, starts]) / w
    gains = np.array(_CH_GAINS[: z.shape[0]])[:, None]
    power = np.sum(gains * z, axis=0)
    with np.errstate(divide="ignore"):
        lb = -0.691 + 10 * np.log10(np.maximum(power, 1e-20))
    keep = lb >= -70.0
    if not keep.any():
        return -70.0
    rel = -0.691 + 10 * np.log10(np.mean(power[keep])) - 10.0
    keep &= lb >= rel
    if not keep.any():
        return -70.0
    return float(-0.691 + 10 * np.log10(np.mean(power[keep])))


def true_peak(x: np.ndarray, sr: int) -> float:
    """True peak in dBTP: 4x oversampled (BS.1770-4 Annex 2) for rates below 176.4 kHz."""
    a = as2d(x).astype(np.float64)
    if a.size == 0:
        return -150.0
    over = 4 if sr < 176400 else 1
    up = signal.resample_poly(a, over, 1, axis=-1) if over > 1 else a
    return float(lin_to_db(max(float(np.max(np.abs(up))), float(np.max(np.abs(a))))))


def sample_peak(x: np.ndarray) -> float:
    a = as2d(x)
    return float(lin_to_db(float(np.max(np.abs(a))) if a.size else 0.0))


@dataclass
class LoudnessReport:
    integrated_lufs: float
    short_term_max_lufs: float
    true_peak_dbtp: float
    sample_peak_dbfs: float
    gain_db: float = 0.0
    limiter_ceiling_db: float | None = None
    mode: str = "club"
    target: float | None = None
    iterations: int = 0

    def as_dict(self) -> dict:
        return asdict(self)


def measure(x: np.ndarray, sr: int, tp: float | None = None) -> LoudnessReport:
    kw = k_weight(x, sr)
    return LoudnessReport(integrated_lufs(x, sr, kw), float(np.max(short_term_loudness(x, sr, kw=kw))),
                          true_peak(x, sr) if tp is None else tp, sample_peak(x))


# --------------------------------------------------------------------------- resampling / length


def resample(x: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    a = as2d(x)
    if sr_in == sr_out:
        return a
    if sr_in == 48000 and sr_out == 44100:
        return signal.resample_poly(a, 147, 160, axis=-1).astype(np.float32)
    g = gcd(int(sr_in), int(sr_out))
    return signal.resample_poly(a, sr_out // g, sr_in // g, axis=-1).astype(np.float32)


def output_samples(bars: float, bpm: float, sr: int) -> int:
    """Exact output length for ``bars`` of 4/4 at ``bpm``: 1 bar = 240/BPM s."""
    return int(round(bars * 240.0 / bpm * sr))


# --------------------------------------------------------------------------- dither


def tpdf_dither(x: np.ndarray, bits: int = 16, seed: int = 0) -> np.ndarray:
    """Triangular (TPDF) dither at +-1 LSB for a ``bits``-bit target; quantisation is the writer's job."""
    lsb = 2.0 ** -(bits - 1)
    rng = np.random.default_rng(seed)
    a = as2d(x)
    d = (rng.random(a.shape) - rng.random(a.shape)) * lsb
    return (a + d).astype(np.float32)


# --------------------------------------------------------------------------- modes


def _secant(g0: float, l0: float, g1: float, l1: float, target: float) -> float:
    slope = (l1 - l0) / (g1 - g0) if abs(g1 - g0) > 1e-6 else 0.6
    slope = float(np.clip(slope, 0.08, 1.0))  # a limiter only ever gives back part of the added gain
    return g1 + (target - l1) / slope


class _Chain:
    """gain -> tanh soft clip -> brick-wall limiter, all in a 2x-oversampled domain, then back down.

    Running the limiter on the 2x signal makes its sample-peak detection see (nearly all) inter-sample peaks,
    at a fraction of the cost of pedalboard's internal 4x true-peak sidechain; the upsampling happens once."""

    def __init__(self, y: np.ndarray, sr: int, ceiling_db: float, soft_clip: bool, mono_below_hz: float | None = None):
        self.sr, self.n = sr, y.shape[1]
        self.up = signal.resample_poly(y.astype(np.float64), 2, 1, axis=-1).astype(np.float32)
        self.ceiling_db = ceiling_db
        self.soft_clip = soft_clip
        self.mono_below_hz = mono_below_hz if y.shape[0] == 2 else None

    def __call__(self, gain_db: float) -> np.ndarray:
        pre = self.up * np.float32(db_to_lin(gain_db))
        if self.soft_clip:
            c = np.float32(db_to_lin(self.ceiling_db + 1.5))
            pre = c * np.tanh(pre / c)
        lim = pedalboard.BrickwallLimiter(ceiling_db=float(self.ceiling_db), release_ms=60.0, lookahead_ms=5.0,
                                          true_peak=False)
        z = lim(np.ascontiguousarray(pre, dtype=np.float32), float(2 * self.sr))
        z = signal.resample_poly(z, 1, 2, axis=-1)[:, : self.n].astype(np.float32)
        if self.mono_below_hz:
            # per-channel clipping/limiting re-creates some low side content: fold it back to mono here, so the
            # loudness search measures exactly what ships
            z = _fold_low_side(z, self.sr, self.mono_below_hz)
        return z


def _fold_low_side(z: np.ndarray, sr: int, hz: float) -> np.ndarray:
    from .modules.stereo import side_highpass

    mid, side = 0.5 * (z[0] + z[1]), side_highpass(0.5 * (z[0] - z[1]), sr, float(hz))
    return np.stack([mid + side, mid - side]).astype(np.float32)


def _estimate(points: list[tuple[float, float]], target: float) -> float:
    """Next gain from (gain, loudness) samples: interpolate across the pair that brackets ``target``
    (loudness rises monotonically and smoothly with gain), else extrapolate with a clamped local slope."""
    pts = sorted(points)
    lo = [q for q in pts if q[1] <= target]
    hi = [q for q in pts if q[1] > target]
    if lo and hi:
        (g0, l0), (g1, l1) = max(lo), min(hi)
        return g0 + (target - l0) * (g1 - g0) / max(l1 - l0, 1e-9)
    near = sorted(pts, key=lambda q: abs(target - q[1]))[:2]
    if len(near) == 2 and abs(near[0][0] - near[1][0]) > 1e-6:
        slope = float(np.clip((near[0][1] - near[1][1]) / (near[0][0] - near[1][0]), 0.08, 1.0))
    else:
        slope = 0.5
    return near[0][0] + (target - near[0][1]) / slope


def _loudness_to_target(y: np.ndarray, sr: int, target: float, ceiling_db: float, meter, final: bool,
                        soft_clip: bool, hint: tuple[float, float] | None = None,
                        mono_below_hz: float | None = None) -> tuple[np.ndarray, float, float, int]:
    """Find the input gain of gain -> soft clip -> limiter (2x-oversampled domain) -> measured BS.1770 true-peak
    trim so that ``meter`` lands on ``target`` for the signal that is actually delivered.

    Each round evaluates three gains concurrently (the chain releases the GIL) and interpolates across the
    bracket; ``hint`` = (gain, ceiling) of the last render on this grid, so tweaks usually finish in one round."""
    cur = meter(y, sr)
    if not np.isfinite(cur) or cur < -69.0:
        return y, 0.0, ceiling_db, 0
    chain = _Chain(y, sr, ceiling_db - 0.25, soft_clip, mono_below_hz)
    margin = 0.02 if final else 0.12  # previews are resampled afterwards: keep a little headroom
    tol = 0.05 if final else 0.25
    trim_to = ceiling_db - margin

    def evaluate(g: float) -> tuple[float, float, np.ndarray]:
        z = chain(g)
        tp = true_peak(z, sr)
        if tp > trim_to:
            z = z * db_to_lin(trim_to - tp)
        return g, meter(z, sr), z

    if hint:
        gains = [hint[0], hint[0] - 0.4, hint[0] + 0.4]
    else:
        g0 = target - cur  # loudness before limiting; limiting eats some of it back
        gains = [g0, g0 + 3.0, g0 + 7.0]
    results: list[tuple[float, float, np.ndarray]] = []
    rounds = 0
    spread = 0.4 if hint else 1.0
    for rounds in range(1, (4 if final else 3) + 1):
        results += list(EVAL_POOL.map(evaluate, gains))
        best = min(results, key=lambda r: abs(target - r[1]))
        if abs(target - best[1]) <= tol:
            break
        est = _estimate([(g, lv) for g, lv, _ in results], target)
        spread *= 0.35
        gains = [est, est - spread, est + spread]
    g, _, z = min(results, key=lambda r: abs(target - r[1]))
    return z, g, chain.ceiling_db, rounds


def master(
    x: np.ndarray,
    sr_in: int,
    *,
    mode: str = "club",
    target_lufs: float | None = None,
    ceiling_dbtp: float = -1.0,
    bake_peak_dbfs: float = -6.0,
    sr_out: int = 44100,
    n_out: int | None = None,
    fade_in_ms: float = 0.0,
    fade_out_ms: float = 4.0,
    channels: int = 2,
    quality: str = "final",
    hint_key: str | None = None,
    mono_below_hz: float | None = None,
) -> tuple[np.ndarray, LoudnessReport]:
    """Resample to ``sr_out``, cut to ``n_out`` samples, fade, then apply the loudness mode.

    Previews whose rack ran below ``sr_out`` are mastered at the rack rate (no soft clip, fewer passes) and
    resampled afterwards; the band-limited result keeps its loudness and true peak."""
    final = quality == "final"
    work_sr = sr_in if (not final and sr_in < sr_out) else sr_out
    src = to_stereo(x) if channels == 2 else as2d(x).mean(axis=0, keepdims=True)
    y = resample(src, sr_in, work_sr)
    n_work = None if n_out is None else int(round(n_out * work_sr / sr_out))
    if n_work is not None:
        y = fit_length(y, n_work)
    y = fade_edges(y, int(fade_in_ms * work_sr / 1000.0), int(fade_out_ms * work_sr / 1000.0))
    mode = (mode or "club").lower().replace("-", "_")
    with _HINTS_LOCK:
        hint = _HINTS.get(hint_key) if hint_key else None
    if mode in ("club",):
        tgt = -7.0 if target_lufs is None else float(target_lufs)
        z, g, lc, it = _loudness_to_target(y, work_sr, tgt, ceiling_dbtp, short_term_max, final, soft_clip=True, hint=hint,
                                           mono_below_hz=mono_below_hz)
    elif mode in ("custom",):
        tgt = -14.0 if target_lufs is None else float(target_lufs)
        z, g, lc, it = _loudness_to_target(y, work_sr, tgt, ceiling_dbtp, integrated_lufs, final, soft_clip=tgt > -10,
                                           hint=hint, mono_below_hz=mono_below_hz)
    elif mode in ("bake_in", "bakein", "bake"):
        tgt = bake_peak_dbfs
        if mono_below_hz and y.shape[0] == 2:
            y = _fold_low_side(y, work_sr, mono_below_hz)
        pk = float(np.max(np.abs(y))) if y.size else 0.0
        gl = db_to_lin(bake_peak_dbfs) / pk if pk > EPS else 1.0
        z, g, lc, it = (y * gl).astype(np.float32), float(lin_to_db(gl)), None, 0
    else:
        raise ValueError(f"unknown master mode {mode!r}")
    tp_final = None
    if hint_key and mode != "bake" and lc is not None:
        with _HINTS_LOCK:
            _HINTS[hint_key] = (g, lc)
            while len(_HINTS) > 256:
                _HINTS.pop(next(iter(_HINTS)))
    z_work = z
    if work_sr != sr_out:
        z = resample(z, work_sr, sr_out)
        if n_out is not None:
            z = fit_length(z, n_out)
    # The chain's oversampled clip, limiter and resampler ring a little energy back onto the edges: fade them
    # again at the output and pin the first and last samples to exactly 0, so a drop never starts or ends
    # on a click (fades only lower levels: true peak and loudness hold).
    z = fade_edges(z, max(1, int(fade_in_ms * sr_out / 1000.0)), max(1, int(max(fade_out_ms, 1.0) * sr_out / 1000.0)))
    if z.shape[-1]:
        z[:, 0] = 0.0
        z[:, -1] = 0.0
    rep = measure(z, sr_out, tp_final) if work_sr == sr_out else measure(z_work, work_sr, tp_final)
    rep.gain_db, rep.limiter_ceiling_db, rep.target, rep.iterations = g, lc, tgt, it
    rep.mode = {"club": "club", "custom": "custom"}.get(mode, "bake")
    return np.ascontiguousarray(z, dtype=np.float32), rep
