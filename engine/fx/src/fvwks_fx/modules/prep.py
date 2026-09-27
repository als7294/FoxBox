"""PREP: high-pass, gate, de-ess, normalize (mostly for recorded voice)."""

from __future__ import annotations

import numpy as np
import pedalboard

from ..dsp import EPS, as2d, butter_sos, db_to_lin, envelope, highpass, sos


def deess(x: np.ndarray, sr: int, *, amount_db: float = 6.0, freq_hz: float = 5500.0) -> np.ndarray:
    """Split-band de-esser: attenuate the band above ``freq_hz`` where it dominates the full band."""
    a = as2d(x)
    if amount_db <= 0:
        return a
    hf = sos(a, butter_sos("highpass", freq_hz, sr, 2), zero_phase=True)
    low = a - hf
    env_hf = envelope(hf.mean(axis=0), sr, 0.002, 0.04)
    env_all = envelope(a.mean(axis=0), sr, 0.002, 0.04)
    ratio = env_hf / (env_all + EPS)
    # sibilant when HF carries more than ~45 % of the envelope; scale reduction by how far past that
    over = np.clip((ratio - 0.45) / 0.35, 0.0, 1.0)
    gain = db_to_lin(-amount_db * over).astype(np.float32)
    return (low + hf * gain[None, :]).astype(np.float32)


def frame_levels_db(x: np.ndarray, sr: int, n_frames: int, frame_period_ms: float, win_s: float = 0.012) -> np.ndarray:
    """RMS level (dBFS) of ``x`` around each WORLD frame centre."""
    m = as2d(x).mean(axis=0).astype(np.float64)
    c = np.concatenate([[0.0], np.cumsum(m * m)])
    centers = (np.arange(n_frames) * frame_period_ms / 1000.0 * sr).astype(np.int64)
    h = max(1, int(win_s * sr / 2))
    a = np.clip(centers - h, 0, m.size)
    b = np.clip(centers + h, 0, m.size)
    p = (c[b] - c[a]) / np.maximum(b - a, 1)
    return 10.0 * np.log10(np.maximum(p, 1e-15))


def prep_envelope(sp: np.ndarray, f0: np.ndarray, sr: int, levels_db: np.ndarray | None, *, hpf_hz: float | None,
                  gate_db: float | None, deess: float, fft_size: int | None = None) -> tuple[np.ndarray, np.ndarray]:
    """PREP applied in the WORLD domain (so one cached analysis serves every PREP setting):
    4th-order high-pass power response, frame gate, and split-band de-ess on the envelope."""
    n_bins = sp.shape[1]
    f = np.arange(n_bins) * sr / (fft_size or (n_bins - 1) * 2)
    out = sp
    if hpf_hz and hpf_hz > 10:
        out = out / (1.0 + (float(hpf_hz) / np.maximum(f, 1.0)) ** 8)[None, :]
    f0_out = f0
    if gate_db is not None and gate_db > -79.9 and levels_db is not None:
        closed = levels_db < gate_db
        # hold the gate open for 20 ms around anything above threshold (keeps word edges)
        open_ = ~closed
        k = 4
        held = np.convolve(open_.astype(np.float64), np.ones(2 * k + 1), mode="same") > 0
        closed = ~held
        if closed.any():
            out = out.copy() if out is sp else out
            out[closed] *= 1e-4
            f0_out = f0.copy()
            f0_out[closed] = 0.0
    if deess and deess > 0:
        hf = f >= 5500.0
        ratio = out[:, hf].sum(axis=1) / (out.sum(axis=1) + 1e-20)
        over = np.clip((ratio - 0.35) / 0.3, 0.0, 1.0)
        if over.any():
            gain = 10.0 ** (-(float(deess) * 10.0 * over) / 10.0)
            out = out.copy() if out is sp else out
            out[:, hf] *= gain[:, None]
    return out, f0_out


def prep(
    x: np.ndarray,
    sr: int,
    *,
    hpf_hz: float | None = 80.0,
    gate_db: float | None = None,
    deess_db: float = 0.0,
    normalize_db: float | None = -1.0,
) -> np.ndarray:
    a = as2d(x)
    if hpf_hz:
        a = highpass(a, sr, hpf_hz, order=4)
    if gate_db is not None:
        a = pedalboard.NoiseGate(threshold_db=float(gate_db), ratio=8.0, attack_ms=1.0, release_ms=120.0)(a, sr)
    if deess_db > 0:
        a = deess(a, sr, amount_db=deess_db)
    if normalize_db is not None:
        pk = float(np.max(np.abs(a))) if a.size else 0.0
        if pk > EPS:
            a = a * (db_to_lin(normalize_db) / pk)
    return as2d(a)
