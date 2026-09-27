"""STEREO: mid/side width with everything below ``mono_below_hz`` folded to mono (club systems are mono)."""

from __future__ import annotations

import numpy as np
from scipy import fft as sfft

from ..dsp import to_stereo


def side_highpass(side: np.ndarray, sr: int, hz: float) -> np.ndarray:
    """Zero-phase FFT-domain high-pass on the side channel: exactly zero below 0.85 x ``hz`` and a
    raised-cosine ramp up to 1.1 x ``hz`` (IIR slopes leak audibly right under the corner)."""
    n = side.shape[-1]
    nf = sfft.next_fast_len(n, real=True)
    spec = sfft.rfft(side, n=nf)
    f = np.arange(spec.shape[-1]) * sr / nf
    lo, hi = 0.85 * hz, 1.1 * hz
    mask = np.clip((f - lo) / (hi - lo), 0.0, 1.0)
    mask = 0.5 - 0.5 * np.cos(np.pi * mask)
    return sfft.irfft(spec * mask, n=nf)[..., :n]


def stereo(x: np.ndarray, sr: int, *, width: float = 1.0, mono_below_hz: float = 150.0) -> np.ndarray:
    s = to_stereo(x).astype(np.float64)
    mid = 0.5 * (s[0] + s[1])
    side = 0.5 * (s[0] - s[1])
    if mono_below_hz and mono_below_hz > 0:
        side = side_highpass(side, sr, float(mono_below_hz))
    side *= float(np.clip(width, 0.0, 2.0))
    return np.stack([mid + side, mid - side]).astype(np.float32)


def mono_compat(x: np.ndarray) -> dict:
    """Correlation and mono fold-down loss (dB): used by tests and the render metrics."""
    s = to_stereo(x).astype(np.float64)
    l, r = s[0], s[1]
    denom = np.sqrt(np.sum(l * l) * np.sum(r * r))
    corr = float(np.sum(l * r) / denom) if denom > 0 else 1.0
    st = np.mean(l * l) + np.mean(r * r)
    mono = np.mean((0.5 * (l + r)) ** 2) * 2.0
    loss = float(10 * np.log10(max(st, 1e-20) / max(mono, 1e-20))) if st > 0 else 0.0
    return {"correlation": corr, "mono_loss_db": loss}
