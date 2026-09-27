"""SPACE: generated dark IRs into pedalboard Convolution, tempo-synced (ping-pong) delay, throws on
flagged segments, and a reverse-reverb swell into the first word.

IRs are synthesized in the STFT domain: stereo noise whose per-bin decay time falls with frequency
(``damping`` = how much darker the tail gets), with plate / hall / room attack shapes and pre-delay.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Sequence

import numpy as np
import pedalboard
from scipy import signal

from ..dsp import (
    EPS, active_rms, add_at, as2d, butter_sos, db_to_lin, fade_edges, highpass, istft, lowpass, pink_noise, sos,
    to_mono, to_stereo,
)
from . import airwin as AW

IR_NFFT = 1024
IR_HOP = 256
# pedalboard (JUCE) Convolution normalises an IR to an energy of 0.125**2; undo that so the IR we pass
# acts with the unit energy we generated it with.
_CONV_NORM_UNDO = 8.0


@lru_cache(maxsize=24)
def make_ir(sr: int, decay_s: float, predelay_ms: float = 10.0, damping: float = 0.6, kind: str = "plate",
            seed: int = 7) -> np.ndarray:
    """Stereo reverb IR ``[2, n]`` (unit energy per channel). ``decay_s`` is RT60 at 500 Hz."""
    decay_s = float(np.clip(decay_s, 0.1, 12.0))
    # lows ring ~12 % longer than the nominal RT60: size the IR so every band is ~-75 dB before it ends
    n_tail = int(decay_s * 1.12 * 1.3 * sr) + IR_NFFT
    rng = np.random.default_rng(seed)
    n_frames = n_tail // IR_HOP + 1
    k = IR_NFFT // 2 + 1
    f = np.arange(k) * sr / IR_NFFT
    t = np.arange(n_frames) * IR_HOP / sr
    # frequency-dependent RT60: lows ring slightly longer, highs die faster with damping
    oct_above = np.log2(np.maximum(f, 20.0) / 500.0)
    rt = np.where(
        oct_above > 0,
        decay_s * (1.0 - float(np.clip(damping, 0.0, 1.0)) * 0.88 * np.clip(oct_above / 5.0, 0.0, 1.0)),
        decay_s * (1.0 + 0.12 * np.clip(-oct_above / 2.0, 0.0, 1.0)),
    )
    rt = np.maximum(rt, 0.05)
    env = np.exp(-6.9078 * t[:, None] / rt[None, :])
    if kind == "hall":
        attack = np.clip(t / 0.035, 0.0, 1.0) ** 1.5
    elif kind == "room":
        attack = np.clip(t / 0.004, 0.0, 1.0)
    else:  # plate: instant, dense
        attack = np.clip(t / 0.002, 0.0, 1.0)
    env *= attack[:, None]
    chans = []
    for _ in range(2):
        spec = (rng.standard_normal((n_frames, k)) + 1j * rng.standard_normal((n_frames, k))) * env
        chans.append(istft(spec, n_tail, IR_NFFT, IR_HOP))
    ir = np.stack(chans)
    if kind in ("hall", "room"):
        # a handful of early reflections, different per side
        span = 0.06 if kind == "hall" else 0.025
        for ch in range(2):
            taps = rng.uniform(0.004, span, 6)
            for i, tap in enumerate(sorted(taps)):
                idx = int(tap * sr)
                if idx < ir.shape[1]:
                    ir[ch, idx] += (0.9 ** i) * np.sqrt(np.sum(ir[ch] ** 2)) * 0.08
    ir = highpass(ir, sr, 60.0, order=2).astype(np.float64)
    ir = fade_edges(ir, 0, int(0.05 * sr)).astype(np.float64)
    ir /= np.sqrt(np.sum(ir**2, axis=1, keepdims=True)) + EPS
    pre = int(max(predelay_ms, 0.0) * sr / 1000.0)
    if pre:
        ir = np.concatenate([np.zeros((2, pre)), ir], axis=1)
    return ir.astype(np.float32)


def convolve(x: np.ndarray, ir: np.ndarray, sr: int, full: bool = False, backend: str = "fft") -> np.ndarray:
    """Convolve ``[2, n]`` with a stereo IR. ``full`` keeps the tail (output length n + len(ir) - 1).

    ``backend="fft"`` (default) is scipy overlap-add FFT convolution: identical output to pedalboard's
    Convolution (rel. error ~1e-4) at 2-3x the speed for these IR lengths. ``backend="pedalboard"`` uses
    pedalboard.Convolution with JUCE's IR normalisation undone."""
    s = to_stereo(x)
    if backend == "pedalboard":
        if full:
            s = np.concatenate([s, np.zeros((2, ir.shape[1] - 1), np.float32)], axis=1)
        conv = pedalboard.Convolution(np.ascontiguousarray(ir), mix=1.0, sample_rate=float(sr))
        return (conv(s, float(sr)) * _CONV_NORM_UNDO).astype(np.float32)
    y = signal.oaconvolve(s, ir, axes=-1)
    return (y if full else y[:, : s.shape[1]]).astype(np.float32)


def reverb_wet(x: np.ndarray, sr: int, *, decay_s: float = 1.2, predelay_ms: float = 12.0, damping: float = 0.7,
               kind: str = "plate", low_cut_hz: float = 180.0, high_cut_hz: float | None = None, seed: int = 7) -> np.ndarray:
    if kind == "galactic" and AW.AVAILABLE:  # Airwindows Galactic3, matched to the hall's level and a mono-safe width
        wet = galactic_wet(x, sr, decay_s=decay_s, predelay_ms=predelay_ms, damping=damping, seed=seed)
    else:
        kind = "hall" if kind == "galactic" else kind
        ir = make_ir(sr, round(float(decay_s), 3), round(float(predelay_ms), 2), round(float(damping), 3), kind, seed)
        wet = convolve(x, ir, sr)
    if low_cut_hz:
        wet = highpass(wet, sr, low_cut_hz, order=2)
    if high_cut_hz:
        wet = lowpass(wet, sr, high_cut_hz, order=2)
    return wet


GALACTIC_CORRELATION = 0.2  # L/R correlation of the Galactic tail: wide, but a club's mono sum keeps it


@lru_cache(maxsize=32)
def _galactic_match(sr: int, decay_s: float, damping: float) -> tuple[float, float]:
    """(gain, side gain) that make Galactic3 sit like the generated hall at the same decay and damping: the same wet
    level for a voice (a burst of band-limited pink noise, both after the reverb low cut) and an L/R correlation of
    ``GALACTIC_CORRELATION`` (it cross-feeds L and R, so its side can outweigh its mid and cancel in mono)."""
    rng = np.random.default_rng(11)
    n_burst, n = int(0.6 * sr), int(4.0 * sr)
    burst = np.zeros((2, n), np.float32)
    voice_band = signal.sosfilt(butter_sos("bandpass", (100.0, 5000.0), sr, 4), pink_noise(n_burst, rng))
    burst[:, :n_burst] = (voice_band * np.hanning(n_burst)).astype(np.float32)
    hall = highpass(convolve(burst, make_ir(sr, decay_s, 0.0, damping, "hall", 7), sr), sr, 180.0, order=2)
    gal = highpass(AW.galactic(burst, sr, decay_s=decay_s, damping=damping, predelay_ms=0.0, seed=7), sr, 180.0, order=2)
    em = float(np.sum((0.5 * (gal[0] + gal[1])) ** 2, dtype=np.float64))
    es = float(np.sum((0.5 * (gal[0] - gal[1])) ** 2, dtype=np.float64))
    c = GALACTIC_CORRELATION
    side = min(1.0, float(np.sqrt(em * (1.0 - c) / ((1.0 + c) * max(es, 1e-30)))))
    target = float(np.mean(np.sum(hall.astype(np.float64) ** 2, axis=1)))  # hall energy per channel
    return float(np.sqrt(target / max(em + side * side * es, 1e-30))), side


def galactic_wet(x: np.ndarray, sr: int, *, decay_s: float = 4.0, predelay_ms: float = 20.0, damping: float = 0.5,
                 seed: int = 7) -> np.ndarray:
    """Airwindows Galactic3 as a SPACE reverb: its decay, the hall's level and a mono-safe width."""
    wet = AW.galactic(x, sr, decay_s=decay_s, damping=damping, predelay_ms=predelay_ms, seed=seed)
    gain, side = _galactic_match(int(sr), round(float(decay_s), 3), round(float(damping), 3))
    mid, sd = 0.5 * (wet[0] + wet[1]), 0.5 * (wet[0] - wet[1]) * np.float32(side)
    return (np.stack([mid + sd, mid - sd]) * np.float32(gain)).astype(np.float32)


def delay_wet(x: np.ndarray, sr: int, *, time_s: float, feedback: float = 0.35, pingpong: bool = False,
              lpf_hz: float | None = 5000.0, hpf_hz: float | None = 200.0, max_repeats: int = 32) -> np.ndarray:
    """Feedback delay with filtering in the loop; ping-pong alternates repeats L/R. Wet only, ``[2, n]``.

    Repeats are computed on the source's active span only (plus a filter-ring margin), not the whole timeline."""
    s = to_stereo(x)
    n = s.shape[1]
    d = max(1, int(round(time_s * sr)))
    wet = np.zeros((2, n), np.float32)
    active = np.flatnonzero(np.max(np.abs(s), axis=0) > 1e-7)
    if active.size == 0:
        return wet
    a0 = int(active[0])
    a1 = min(n, int(active[-1]) + int(0.05 * sr))
    e = to_mono(s[:, a0:a1]) if pingpong else s[:, a0:a1].copy()
    if hpf_hz:
        e = highpass(e, sr, hpf_hz, order=2)
    lp = butter_sos("lowpass", lpf_hz, sr, 1) if lpf_hz else None
    fb = float(np.clip(feedback, 0.0, 0.95))
    g = 1.0
    for k in range(1, max_repeats + 1):
        off = a0 + k * d
        if off >= n or g < 1e-3:
            break
        if lp is not None:
            e = sos(e, lp)
        chunk = e * g
        if pingpong:
            ch = (k - 1) % 2
            add_at(wet[ch : ch + 1], chunk, off)
        else:
            add_at(wet, np.broadcast_to(chunk, (2, chunk.shape[1])), off)
        g *= fb
    return wet


def isolate_spans(x: np.ndarray, spans: Sequence[tuple[int, int]], sr: int, fade_ms: float = 8.0) -> np.ndarray:
    a = to_stereo(x)
    out = np.zeros_like(a)
    f = int(fade_ms * sr / 1000.0)
    for s0, s1 in spans:
        s0, s1 = max(0, int(s0)), min(a.shape[1], int(s1))
        if s1 - s0 > 2 * f:
            out[:, s0:s1] = fade_edges(a[:, s0:s1], f, f)
    return out


def throws_wet(x: np.ndarray, sr: int, spans: Sequence[tuple[int, int]], *, time_s: float, feedback: float = 0.55,
               level_db: float = -4.0, reverb_decay_s: float = 3.5, reverb_level: float = 0.6, damping: float = 0.6,
               seed: int = 11) -> np.ndarray:
    """Extra delay + reverb send fed only by the throw-flagged spans (sample ranges). Wet only."""
    if not spans:
        return np.zeros((2, as2d(x).shape[1]), np.float32)
    iso = isolate_spans(x, spans, sr)
    wet = delay_wet(iso, sr, time_s=time_s, feedback=feedback, pingpong=True, lpf_hz=4000.0, hpf_hz=300.0)
    if reverb_level > 0:
        wet = wet + reverb_level * reverb_wet(iso + 0.5 * wet, sr, decay_s=reverb_decay_s, damping=damping, kind="hall", seed=seed)
    return (wet * db_to_lin(level_db)).astype(np.float32)


def reverse_swell(x: np.ndarray, sr: int, onset: int, *, length_s: float, word_s: float = 0.35, damping: float = 0.5,
                  level_db: float = -3.0, seed: int = 13) -> np.ndarray:
    """Reverse-reverb swell that crescendos into the word at ``onset``; ends exactly at ``onset``.
    Anything that would start before sample 0 is cut. Wet only, ``[2, n]``."""
    s = to_stereo(x)
    out = np.zeros_like(s)
    L = int(length_s * sr)
    w_len = int(word_s * sr)
    if onset <= 0 or L <= 0 or w_len <= 0:
        return out
    word = fade_edges(s[:, onset : onset + w_len], 0, int(0.03 * sr))
    if active_rms(word, sr) <= EPS:
        return out
    ir = make_ir(sr, round(max(0.3, length_s * 0.8), 3), 0.0, round(float(damping), 3), "hall", seed)
    r = convolve(word[:, ::-1], ir, sr, full=True)[:, ::-1]
    swell = r[:, : r.shape[1] - word.shape[1]]
    swell = swell[:, -L:] if swell.shape[1] > L else swell
    swell = fade_edges(swell, int(0.3 * swell.shape[1]), int(0.004 * sr))
    swell = swell * (db_to_lin(level_db) * active_rms(word, sr) / max(float(np.max(np.abs(swell))), EPS)) * 2.5
    add_at(out, swell, onset - swell.shape[1])
    return out
