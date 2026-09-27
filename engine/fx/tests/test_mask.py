"""MASK: measured pitch, monotone / scale-lock, formant warp, McAdams (paper formula), breath, growl."""

import numpy as np
import pytest
import pyworld as pw
from scipy.signal import resample_poly

from fvwks_fx.modules import mask as M
from fvwks_fx.music import hz_to_midi, parse_key

SR = 48000


def f0_track(y: np.ndarray) -> np.ndarray:
    """Independent F0 measurement: Harvest on a 16 kHz copy."""
    lo = resample_poly(np.asarray(y, dtype=np.float64).reshape(-1), 1, 3)
    f0, _ = pw.harvest(lo, 16000, f0_floor=40.0, f0_ceil=700.0, frame_period=5.0)
    return f0


def median_f0(y: np.ndarray) -> float:
    f0 = f0_track(y)
    return float(np.median(f0[f0 > 0]))


def measured_shift(x: np.ndarray, y: np.ndarray) -> float:
    """Median per-frame pitch change (st), both sides measured with Harvest, frames voiced in both."""
    a, b = f0_track(x), f0_track(y)
    n = min(a.size, b.size)
    both = (a[:n] > 0) & (b[:n] > 0)
    return float(np.median(12 * np.log2(b[:n][both] / a[:n][both])))


@pytest.fixture(scope="module")
def analysis(we_are):
    return M.analyze_world(we_are.audio, SR, "harvest")


@pytest.mark.parametrize("st", [-12.0, -9.0, -5.0, -3.0, 0.0, 4.0])
def test_pitch_shift_measured_within_half_semitone(we_are, analysis, st):
    y, _ = M.mask_world(analysis, pitch_st=st)
    got = measured_shift(we_are.audio[0], y[0])
    assert abs(got - st) <= 0.5, f"asked {st} st, measured {got:.2f} st"


@pytest.mark.parametrize("st,formant", [(-9.0, -5.0), (-4.0, -4.0), (-12.0, -7.0)])
def test_pitch_independent_of_formant_and_mcadams(we_are, analysis, st, formant):
    y, _ = M.mask_world(analysis, pitch_st=st, formant_st=formant, mcadams=0.8)
    assert abs(measured_shift(we_are.audio[0], y[0]) - st) <= 0.5


def test_dio_analysis_pitch(we_are):
    y, _ = M.mask_world(M.analyze_world(we_are.audio, SR, "dio"), pitch_st=-9.0)
    assert abs(measured_shift(we_are.audio[0], y[0]) + 9.0) <= 0.5


def test_preview_path_pitch(we_are):
    y = M.mask_preview(we_are.audio, SR, pitch_st=-7.0, formant_st=-3.0)
    assert abs(measured_shift(we_are.audio[0], y[0]) + 7.0) <= 0.5
    assert np.all(np.isfinite(y))


def test_monotone_lands_flat_on_key_root(analysis):
    y, feat = M.mask_world(analysis, pitch_st=-3.0, pitch_mode="monotone", monotone=1.0, key="Am")
    v = feat.f0[feat.f0 > 0]
    assert np.std(12 * np.log2(v / np.median(v))) < 0.05  # dead flat in the synthesis contour
    measured = f0_track(y[0])
    midi = hz_to_midi(measured[measured > 0])
    assert abs(((np.median(midi) - 9) + 6) % 12 - 6) <= 0.5  # A (pitch class 9), measured
    # partial flatness shrinks the intonation range instead
    _, half = M.mask_world(analysis, pitch_mode="monotone", monotone=0.5, key="Am")
    r_nat = np.std(np.log2(analysis.f0[analysis.f0 > 0]))
    r_half = np.std(np.log2(half.f0[half.f0 > 0]))
    assert r_half == pytest.approx(0.5 * r_nat, rel=0.05)


def test_scale_lock_snaps_to_scale(analysis):
    _, feat = M.mask_world(analysis, pitch_mode="scale", monotone=0.0, key="F#m")
    v = feat.f0[feat.f0 > 0]
    pcs = np.round(hz_to_midi(v)) % 12
    assert set(pcs.astype(int)) <= set(parse_key("F#m").scale)
    assert np.max(np.abs(hz_to_midi(v) - np.round(hz_to_midi(v)))) < 1e-6


def _peak_hz(env: np.ndarray, sr: int = SR) -> float:
    f = np.arange(env.size) * sr / ((env.size - 1) * 2)
    band = f < 6000
    return float(f[band][np.argmax(env[band])])


def _resonance(f_hz: float, bw_hz: float = 80.0, n_bins: int = 1025, sr: int = SR) -> np.ndarray:
    """All-pole power envelope with one resonance (a conjugate pole pair) at ``f_hz``."""
    f = np.arange(n_bins) * sr / ((n_bins - 1) * 2)
    r = np.exp(-np.pi * bw_hz / sr)
    th = 2 * np.pi * f_hz / sr
    z = np.exp(-2j * np.pi * f / sr)
    a = (1 - r * np.exp(1j * th) * z) * (1 - r * np.exp(-1j * th) * z)
    return 1.0 / np.abs(a) ** 2


def test_formant_warp_moves_envelope_peak():
    env = _resonance(1000.0)[None, :]
    up = M.warp_envelope(env, 2.0 ** (12 / 12.0))[0]
    down = M.warp_envelope(env, 2.0 ** (-5 / 12.0))[0]
    assert _peak_hz(up) == pytest.approx(2000.0, abs=30.0)
    assert _peak_hz(down) == pytest.approx(1000.0 * 2 ** (-5 / 12), abs=30.0)


def test_mcadams_matches_paper_pole_angle_warp():
    """Patino et al. (arXiv 2011.01130): a pole at angle phi moves to phi**alpha. With the paper's 16 kHz
    reference, a 1000 Hz resonance at alpha 0.8 moves to 16000/(2 pi) * (2 pi 1000/16000)**0.8 ~ 1206 Hz."""
    env = _resonance(1000.0)[None, :].repeat(4, axis=0)
    out = M.mcadams_envelope(env, SR, 0.8)
    expected = 16000 / (2 * np.pi) * (2 * np.pi * 1000 / 16000) ** 0.8
    assert _peak_hz(out[0]) == pytest.approx(expected, abs=45.0)
    assert np.array_equal(M.mcadams_envelope(env, SR, 1.0), env)  # alpha 1 is the identity


def test_mcadams_on_band_sliced_envelope_matches_full():
    env = _resonance(1500.0)[None, :]
    full = M.mcadams_envelope(env, SR, 0.75)
    sliced = M.mcadams_envelope(env[:, :513], SR, 0.75, fft_size=2048)
    assert np.allclose(full[:, :400], sliced[:, :400], rtol=1e-6)


def test_breath_full_whisper_is_unvoiced(we_are, analysis):
    y, feat = M.mask_world(analysis, breath=1.0)
    assert not np.any(feat.f0 > 0)
    # Harvest finds a few false "voiced" frames in shaped noise; the real voicing is gone
    assert np.mean(f0_track(y[0]) > 0) < 0.4 * np.mean(f0_track(we_are.audio[0]) > 0)
    assert np.all(np.isfinite(y)) and np.sqrt(np.mean(y**2)) > 1e-3


def test_growl_alternates_pulses_and_adds_subharmonics(analysis):
    base, _ = M.mask_world(analysis, pitch_st=-5.0)
    grr, feat = M.mask_world(analysis, pitch_st=-5.0, growl=0.8)
    parity = M.pulse_parity(feat.f0, 48000, SR, feat.frame_period_ms)
    assert set(np.unique(parity)) == {-1.0, 1.0}
    # energy between harmonics (at k + 1/2 of f0) rises: compare a sub-harmonic band around f0/2
    f0 = float(np.median(feat.f0[feat.f0 > 0]))

    def band_energy(y, lo, hi):
        spec = np.abs(np.fft.rfft(y[0])) ** 2
        f = np.fft.rfftfreq(y.shape[1], 1 / SR)
        return spec[(f > lo) & (f < hi)].sum() / spec.sum()

    assert band_energy(grr, 0.35 * f0, 0.65 * f0) > 1.5 * band_energy(base, 0.35 * f0, 0.65 * f0)


@pytest.mark.parametrize("params", [
    dict(pitch_st=-24.0, formant_st=-12.0), dict(pitch_st=12.0, formant_st=12.0), dict(mcadams=0.5, growl=1.0),
    dict(breath=0.7, pitch_mode="scale", monotone=0.5), dict(pitch_mode="monotone", monotone=1.0, mcadams=0.6),
])
def test_extremes_stay_finite(analysis, params):
    y, _ = M.mask_world(analysis, **params)
    assert np.all(np.isfinite(y)) and y.shape == (1, analysis.n_samples)
    y24, _ = M.mask_world(analysis, out_sr=24000, **params)
    assert np.all(np.isfinite(y24)) and y24.shape[1] == analysis.n_samples // 2


def test_analysis_is_cached(we_are):
    M.ANALYSIS_CACHE.clear()
    a = M.analyze_world(we_are.audio, SR, "harvest")
    assert M.cached_analysis(we_are.audio, SR, "harvest") is a
    assert M.analyze_world(we_are.audio, SR, "harvest") is a
