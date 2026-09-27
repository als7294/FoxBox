"""MASTER: loudness modes, true-peak ceiling, short-file measurement, resampling, exact length."""

import numpy as np
import pyloudnorm
import pytest
from scipy.signal import resample_poly

from fvwks_fx import master as MS
from fvwks_fx.dsp import to_stereo

SR = 48000


@pytest.fixture(scope="module")
def drop(ten_second_line):
    """A 10.9 s line placed on 8 bars at 140 BPM (rack rate), stereo."""
    n = int(np.ceil(604_800 * SR / 44100)) + 8
    x = np.zeros((2, n), np.float32)
    a = ten_second_line.audio[0]
    x[:, : a.size] = a * 0.5
    return x


def test_short_term_matches_pyloudnorm_filters():
    rng = np.random.default_rng(1)
    x = (rng.standard_normal((2, 5 * 44100)) * 0.1).astype(np.float32)
    st = MS.short_term_loudness(x, 44100)
    ref = pyloudnorm.Meter(44100, block_size=3.0).integrated_loudness(x[:, : 3 * 44100].T)  # one 3 s block
    assert st[0] == pytest.approx(ref, abs=0.05)


def test_short_file_uses_whole_file():
    t = np.arange(int(1.2 * 44100)) / 44100
    x = (0.3 * np.sin(2 * np.pi * 997 * t)).astype(np.float32)[None, :].repeat(2, axis=0)
    st = MS.short_term_loudness(x, 44100)
    assert st.size == 1
    assert st[0] == pytest.approx(pyloudnorm.Meter(44100, block_size=1.2).integrated_loudness(x.T), abs=0.05)


def test_true_peak_sees_inter_sample_peaks():
    sr = 44100
    n = np.arange(sr)
    x = np.sin(2 * np.pi * (sr / 4) * n / sr + np.pi / 4).astype(np.float32)[None, :]  # samples at +-0.707
    assert MS.sample_peak(x) == pytest.approx(-3.01, abs=0.05)
    assert MS.true_peak(x, sr) == pytest.approx(0.0, abs=0.3)


@pytest.mark.parametrize("quality", ["final", "preview"])
def test_club_hits_short_term_target_and_ceiling(drop, quality):
    x = drop if quality == "final" else resample_poly(drop, 1, 2, axis=-1).astype(np.float32)
    sr = SR if quality == "final" else 24000
    out, rep = MS.master(x, sr, mode="club", target_lufs=-7.0, ceiling_dbtp=-1.0, n_out=604_800, quality=quality)
    assert out.shape == (2, 604_800)
    assert np.all(np.isfinite(out))
    st = MS.short_term_max(out, 44100)
    assert st == pytest.approx(-7.0, abs=0.1 if quality == "final" else 0.5)
    assert MS.true_peak(out, 44100) <= -1.0 + 1e-6


@pytest.mark.parametrize("target", [-14.0, -9.0])
def test_custom_hits_integrated_target(drop, target):
    out, _ = MS.master(drop, SR, mode="custom", target_lufs=target, ceiling_dbtp=-1.0, n_out=604_800)
    assert MS.integrated_lufs(out, 44100) == pytest.approx(target, abs=0.5)
    assert MS.true_peak(out, 44100) <= -1.0 + 1e-6


def test_bake_in_peaks_at_minus_six_without_limiting(drop):
    out, rep = MS.master(drop, SR, mode="bake", bake_peak_dbfs=-6.0, n_out=604_800)
    assert MS.sample_peak(out) == pytest.approx(-6.0, abs=0.01)
    ref = MS.resample(to_stereo(drop), SR, 44100)[:, :604_800]
    body = slice(1000, 600_000)  # away from the edge fades
    assert np.corrcoef(out[0, body], ref[0, body])[0, 1] > 0.99999  # a pure gain, no dynamics


def test_resample_48k_to_441k_uses_147_160():
    x = np.zeros((2, 48000), np.float32)
    assert MS.resample(x, 48000, 44100).shape[1] == int(np.ceil(48000 * 147 / 160))


def test_mono_master(drop):
    out, _ = MS.master(drop, SR, mode="club", n_out=302_400, channels=1)
    assert out.shape == (1, 302_400)


def test_tpdf_dither_is_within_one_lsb():
    x = np.zeros((2, 10000), np.float32)
    d = MS.tpdf_dither(x, 16)
    assert np.max(np.abs(d)) <= 2.0**-15 + 1e-9 and np.std(d) > 0


def test_silence_is_left_alone():
    x = np.zeros((2, 44100), np.float32)
    out, rep = MS.master(x, 44100, mode="club", n_out=44100)
    assert np.all(out == 0) and np.all(np.isfinite(out))


@pytest.mark.parametrize("quality,mode", [("final", "club"), ("preview", "club"), ("final", "bake"), ("final", "custom")])
def test_output_starts_and_ends_on_exact_silence(quality, mode):
    # QA v1.0.0: a drop whose first word sits on sample 0 must not start (or end) on a click. The clip / limiter /
    # resampler ring energy back onto the edges after the pre-chain fades, so the output edges are faded again.
    sr = 48000
    t = np.arange(int(1.5 * sr)) / sr
    x = to_stereo((0.8 * np.sign(np.sin(2 * np.pi * 110 * t)) * np.exp(-t / 2.0)).astype(np.float32)[None, :])  # loud at t=0
    y, rep = MS.master(x, sr, mode=mode, sr_out=44100, n_out=int(1.5 * 44100), fade_in_ms=2.0, fade_out_ms=30.0,
                       quality=quality)
    assert np.all(y[:, 0] == 0.0) and np.all(y[:, -1] == 0.0)
    assert np.max(np.abs(y[:, :20])) < 0.01  # a 2 ms fade, not a step
    if mode == "club":
        assert MS.true_peak(y, 44100) <= -1.0 + 1e-6
