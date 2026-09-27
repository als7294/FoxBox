"""Airwindows effects (MIT; Chris Johnson, packaged by airwin2rack) through the native ``fvwks_fx._airwin`` module.

- COLOR (DRIVE): ToTape9 tape or Tube2 tube saturation, level-matched, for a warmer, less fizzy grit.
- DEREZ (CRUSH): DeRez4 retro-digital rate reduction, on hold lengths that exist at every rack rate.
- GALACTIC (SPACE): the Galactic3 super-reverb with a calibrated decay time (SPACE matches its level and width).

Everything is rate-compensated so a 24 kHz preview sounds like the 48 kHz final. Without the native module (a
build without a C++ compiler) ``AVAILABLE`` is False and callers skip these stages with a warning.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Sequence

import numpy as np

from ..dsp import EPS, active_rms, as2d

try:
    from .. import _airwin
except ImportError:  # pragma: no cover - only without the native build
    _airwin = None

AVAILABLE = _airwin is not None
CORE_SR = 24000.0  # Galactic3's reverb core rate at every host rate (its delay lengths are in core samples)

# Galactic3 decay model, measured on impulse responses (48 kHz host, core at CORE_SR): RT60 = c(sr) * (0.56 + 9.87 *
# Bigness) * g(Replace), with g below (Replace 0 lets nothing in). c(sr) is calibrated per host rate: the 24 kHz
# preview rings ~1.33x longer at the same settings.
_REPLACE = np.array([0.4, 0.6, 0.8, 0.9, 1.0])
_G = np.array([2.95, 1.87, 1.32, 1.15, 1.0])
_RT_BASE_S, _RT_PER_BIG_S = 0.56, 9.87


def _stereo(x: np.ndarray) -> tuple[np.ndarray, bool]:
    a = as2d(x)
    mono = a.shape[0] == 1
    return np.ascontiguousarray(np.vstack([a, a]) if mono else a[:2], dtype=np.float32), mono


def run(name: str, x: np.ndarray, sr: int, params: Sequence[float | None], seed: int = 0) -> np.ndarray:
    """One fresh plugin instance over ``x`` (``[ch, n]``; mono is processed as dual mono and returned mono).
    ``params`` are the plugin's own normalized values by index (None = the plugin default)."""
    if _airwin is None:
        raise RuntimeError("the Airwindows native module is not built")
    st, mono = _stereo(x)
    fx = _airwin.Effect(name, float(sr), int(seed) & 0xFFFFFFFF)
    for i, v in enumerate(params):
        if v is not None:
            fx.set(i, float(v))
    y = fx.process(st)
    return y[:1] if mono else y


def _level_match(y: np.ndarray, ref: np.ndarray, sr: int) -> np.ndarray:
    r, c = active_rms(ref, sr), active_rms(y, sr)
    return (y * (r / c)).astype(np.float32) if c > EPS and r > EPS else y.astype(np.float32)


def color(x: np.ndarray, sr: int, kind: str, amount: float = 0.5, seed: int = 0) -> np.ndarray:
    """Tape (ToTape9) or tube (Tube2) saturation, level-matched to the input. ``amount`` 0..1 drives it from 6 dB
    under to 12 dB over the plugin's unity input."""
    a = as2d(x)
    if kind not in ("tape", "tube"):
        return a
    amt = float(np.clip(amount, 0.0, 1.0))
    gain_db = -6.0 + 18.0 * amt
    if kind == "tape":
        # Input (2A)^2 = the gain; light flutter, a gentle head bump, the rest at the plugin defaults
        y = run("ToTape9", a, sr, [0.5 * 10 ** (gain_db / 40.0), None, None, 0.3, None, None, 0.35, None, None], seed)
    else:
        # Tube2 only pads its input: drive it by gain here; more drive, more tube
        y = run("Tube2", a * np.float32(10 ** (gain_db / 20.0)), sr, [1.0, 0.3 + 0.6 * amt], seed)
    return _level_match(y, a, sr)


def derez_steps(amount: float, sr: int) -> int:
    """Hold length in samples for DEREZ ``amount`` (0..1): the effective rate falls from 24 kHz toward 2 kHz on
    24000 / k steps, which both the 48 kHz final (2k samples) and the 24 kHz preview (k samples) hit exactly."""
    target = 24000.0 * (2000.0 / 24000.0) ** float(np.clip(amount, 0.0, 1.0))
    k = max(1, int(round(24000.0 / target)))
    return max(1, int(round(k * sr / 24000.0)))


def derez(x: np.ndarray, sr: int, amount: float, seed: int = 0) -> np.ndarray:
    """DeRez4, level-matched. Its DownRez holds every ``1 / A**(2 + sr/44100)`` samples: A is solved for the
    hold length of ``derez_steps`` so the effective rate is the same at every host rate."""
    a = as2d(x)
    if amount <= 0:
        return a
    steps = derez_steps(amount, sr)
    down = (1.0 / (steps + 0.5)) ** (1.0 / (2.0 + sr / 44100.0)) if steps > 1 else 1.0
    return _level_match(run("DeRez4", a, sr, [down, None, None, 1.0], seed), a, sr)


def _galactic_params(replace: float, big: float, bright: float, sr: int) -> list[float]:
    n = max(1, int(round(sr / CORE_SR)))  # core = host / n
    return [replace, bright, 0.5, (sr / 44100.0) / (n + 0.5), big, 1.0]


def _rt60_and_energy(h: np.ndarray, sr: int) -> tuple[float, float]:
    e = np.sum(h.astype(np.float64) ** 2, axis=0)
    edc = np.cumsum(e[::-1])[::-1]
    edc_db = 10 * np.log10(edc / max(edc[0], 1e-30) + 1e-30)
    i5, i35 = int(np.argmax(edc_db <= -5.0)), int(np.argmax(edc_db <= -35.0))
    rt = -60.0 * (i35 - i5) / sr / (edc_db[i35] - edc_db[i5]) if i35 > i5 else float("nan")
    return rt, float(np.sum(e))


def _impulse(sr: int, replace: float, big: float, bright: float, secs: float) -> np.ndarray:
    x = np.zeros((2, int(secs * sr)), np.float32)
    x[:, 0] = 1.0
    return run("Galactic3", x, sr, _galactic_params(replace, big, bright, sr), seed=3)


@lru_cache(maxsize=4)
def _galactic_rate_factor(sr: int) -> float:
    """c(sr) from one impulse at Replace 1, Bigness 0.2 (deterministic)."""
    rt, _ = _rt60_and_energy(_impulse(sr, 1.0, 0.2, 0.5, 4.0), sr)
    return rt / (_RT_BASE_S + _RT_PER_BIG_S * 0.2)


def galactic_settings(decay_s: float, sr: int) -> tuple[float, float]:
    """(Replace, Bigness) giving an RT60 of ``decay_s`` at this host rate. The size follows the 48 kHz solution at
    Replace 0.8 so preview and final share it; Replace then trims the decay per rate (0.56 s .. ~30 s)."""
    c, c48 = _galactic_rate_factor(int(sr)), _galactic_rate_factor(48000)
    t = max(float(decay_s), 0.05)
    big = float(np.clip((t / (c48 * float(np.interp(0.8, _REPLACE, _G))) - _RT_BASE_S) / _RT_PER_BIG_S, 0.0, 1.0))
    g = t / (c * (_RT_BASE_S + _RT_PER_BIG_S * big))
    replace = float(np.interp(-g, -_G, _REPLACE))  # g falls as Replace rises
    return replace, big


def galactic(x: np.ndarray, sr: int, *, decay_s: float = 4.0, damping: float = 0.5, predelay_ms: float = 20.0,
             seed: int = 0) -> np.ndarray:
    """Raw Galactic3 wet (stereo ``[2, n]``) from the mono sum, ringing with an RT60 of ``decay_s`` at any host rate.
    ``damping`` 0..1 darkens it (7 kHz .. 1.5 kHz corner). SPACE matches its level and width to the other reverbs."""
    st, _ = _stereo(x)
    st = np.repeat(0.5 * (st[0:1] + st[1:2]), 2, axis=0)  # mono in, stereo out
    n = st.shape[1]
    replace, big = (round(v, 3) for v in galactic_settings(decay_s, sr))
    corner = 7000.0 * (1500.0 / 7000.0) ** float(np.clip(damping, 0.0, 1.0))
    # its two one-pole low-passes use coefficient B^2 / sqrt(sr/44.1k) at the host rate
    bright = round(float(np.clip(np.sqrt(corner * 2 * np.pi * np.sqrt(sr / 44100.0) / sr), 0.0, 1.0)), 3)
    pre = int(round(max(0.0, predelay_ms) / 1000.0 * sr))
    src = np.concatenate([np.zeros((2, pre), np.float32), st], axis=1)[:, :n] if pre else st
    return run("Galactic3", src, sr, _galactic_params(replace, big, bright, sr), seed)
