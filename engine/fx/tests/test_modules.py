"""Unit checks for the MACHINE / DRIVE / CRUSH / TONE / MOTION / DYNAMICS / SPACE / STEREO / PREP modules."""

import numpy as np
import pytest

from fvwks_fx import dsp
from fvwks_fx.modules import crush, drive, dynamics, machine, motion, prep, space, stereo, tone
from fvwks_fx.music import note_seconds, parse_key, root_hz_octave

SR = 48000


def sine(hz, secs=1.0, amp=0.3, sr=SR):
    t = np.arange(int(secs * sr)) / sr
    return (amp * np.sin(2 * np.pi * hz * t)).astype(np.float32)[None, :]


def peak_hz(x, sr=SR, lo=20.0, hi=None):
    spec = np.abs(np.fft.rfft(dsp.to_mono(x)[0] * np.hanning(x.shape[1])))
    f = np.fft.rfftfreq(x.shape[1], 1 / sr)
    band = (f >= lo) & (f <= (hi or sr / 2))
    return float(f[band][np.argmax(spec[band])])


def band_db(x, lo, hi, sr=SR):
    spec = np.abs(np.fft.rfft(dsp.to_mono(x)[0])) ** 2
    f = np.fft.rfftfreq(x.shape[1], 1 / sr)
    return 10 * np.log10(spec[(f >= lo) & (f < hi)].sum() / spec.sum() + 1e-20)


def test_keys_parse():
    assert parse_key("Am").root_pc == 9 and parse_key("Am").minor
    assert parse_key("F#m").root_pc == 6 and parse_key("C").minor is False
    assert parse_key("8A") == parse_key("Am") and parse_key("8B") == parse_key("C")
    assert parse_key("Bb minor").root_pc == 10
    assert root_hz_octave(parse_key("Am"), 2) == pytest.approx(110.0)


def test_note_values():
    assert note_seconds("1/4", 120) == pytest.approx(0.5)
    assert note_seconds("1/8d", 120) == pytest.approx(0.375)
    assert note_seconds("1/16", 140) == pytest.approx(60 / 140 / 4)
    assert note_seconds("1bar", 140) == pytest.approx(240 / 140)


def test_vocoder_imposes_voice_envelope_on_key_carrier(we_are):
    y = machine.vocoder(we_are.audio, SR, bands=32, carrier="saw", key="Am", octave=2, mix=1.0)
    assert y.shape == we_are.audio.shape and np.all(np.isfinite(y))
    # the output pitch is the carrier (A2 = 110 Hz), not the voice (measured, voiced frames)
    import pyworld as pw
    from scipy.signal import resample_poly

    f0, _ = pw.harvest(resample_poly(y[0].astype(np.float64), 1, 3), 16000, f0_floor=60.0, f0_ceil=500.0)
    assert np.median(f0[f0 > 0]) == pytest.approx(110.0, rel=0.03)
    # silence stays silent (the envelope follows the voice)
    env_in = dsp.envelope(we_are.audio[0], SR, 0.005, 0.05)
    env_out = dsp.envelope(y[0], SR, 0.005, 0.05)
    assert np.corrcoef(env_in, env_out)[0, 1] > 0.8


def _envelope_corr(a, b, sr=SR, n_fft=1024, hop=256, keep=30, hi_hz=5000.0):
    """Mean per-frame correlation of cepstrally smoothed log spectra up to ``hi_hz`` (formant similarity)."""
    A, B = np.abs(dsp.stft(a, n_fft, hop)), np.abs(dsp.stft(b, n_fft, hop))
    k = int(hi_hz / sr * n_fft)

    def smooth(S):
        c = np.fft.irfft(np.log(S + 1e-9), axis=1)
        c[:, keep:-keep] = 0.0
        return np.fft.rfft(c, axis=1).real[:, :k]

    la, lb = smooth(A), smooth(B)
    e = (A**2).sum(axis=1)
    return float(np.mean([np.corrcoef(la[i], lb[i])[0, 1] for i in np.flatnonzero(e > e.max() * 1e-3)]))


def test_talkbox_plays_the_voice_formants_on_the_key_carrier(we_are):
    x = we_are.audio
    y = machine.talkbox(x, SR, carrier="saw", key="Am", octave=2, chord="root", mix=1.0)
    assert y.shape == x.shape and np.all(np.isfinite(y))
    assert 20 * np.log10(dsp.active_rms(y, SR) / dsp.active_rms(x, SR)) == pytest.approx(0.0, abs=0.1)
    import pyworld as pw
    from scipy.signal import resample_poly

    f0, _ = pw.harvest(resample_poly(y[0].astype(np.float64), 1, 3), 16000, f0_floor=60.0, f0_ceil=500.0)
    assert np.median(f0[f0 > 0]) == pytest.approx(110.0, rel=0.03)  # the carrier's pitch (A2), not the voice's
    assert _envelope_corr(x[0].astype(np.float64), y[0].astype(np.float64)) > 0.85  # measured 0.92
    env_in = dsp.envelope(x[0], SR, 0.005, 0.05)
    env_out = dsp.envelope(y[0], SR, 0.005, 0.05)
    assert np.corrcoef(env_in, env_out)[0, 1] > 0.8


def test_lpc_recovers_a_known_vocal_tract():
    from scipy import linalg, signal

    poles = []
    for f, bw in ((700.0, 80.0), (1200.0, 90.0), (2600.0, 120.0)):  # an 'ah'-like formant set
        r = np.exp(-np.pi * bw / SR)
        poles += [r * np.exp(2j * np.pi * f / SR), r * np.exp(-2j * np.pi * f / SR)]
    a_true = np.real(np.poly(poles))
    x = signal.lfilter([1.0], a_true, np.random.default_rng(3).standard_normal(SR))
    frame = x[:4096] * np.hanning(4096)
    a, err = machine.lpc_frames(frame[None, :], 6, SR, lag_hz=0.0, floor=0.0)
    assert err[0] > 0 and np.all(np.abs(np.roots(a[0])) < 1.0)  # a stable filter
    w, h = signal.freqz([1.0], a[0], worN=8192, fs=SR)
    peaks = w[signal.find_peaks(20 * np.log10(np.abs(h)), prominence=6)[0]]
    assert len(peaks) == 3 and np.allclose(peaks, [700, 1200, 2600], atol=60)
    # the batched recursion is Levinson-Durbin: same solution as a Toeplitz solve on the same (floored) lags
    rng = np.random.default_rng(4)
    frames = signal.lfilter([1.0], a_true, rng.standard_normal((8, 960)), axis=1) * np.hanning(960)
    a, _ = machine.lpc_frames(frames, 12, SR, lag_hz=0.0)
    for fr, row in zip(frames, a):
        r = np.correlate(fr, fr, "full")[959 : 959 + 13].copy()
        r[0] *= 1.0 + 1e-6
        np.testing.assert_allclose(row[1:], linalg.solve_toeplitz(r[:12], -r[1:13]), rtol=1e-5, atol=1e-6)
    # frames of any level give stable filters at the talkbox order
    frames = rng.standard_normal((64, 960)) * np.hanning(960) * rng.uniform(1e-6, 1.0, (64, 1))
    a, _ = machine.lpc_frames(frames, 32, SR)
    assert all(np.all(np.abs(np.roots(row)) < 1.0) for row in a)


def test_talkbox_hiss_excites_noise_not_the_carrier():
    rng = np.random.default_rng(5)
    hiss = (0.1 * rng.standard_normal(SR)).astype(np.float32)[None, :]  # an 's': no periodicity
    y = machine.talkbox(hiss, SR, carrier="saw", key="Am", octave=2, chord="root", mix=1.0, carrier_noise=0.0)
    spec = np.abs(np.fft.rfft(y[0])) ** 2
    f = np.fft.rfftfreq(y.shape[1], 1 / SR)
    harm = np.zeros_like(f, bool)
    for k in range(1, 40):
        harm |= np.abs(f - 110.0 * k) < 1.5
    # harmonics of the 110 Hz carrier would carry most of the energy; noise spreads evenly
    assert spec[harm].mean() < 3.0 * spec[(f > 50) & (f < 4500) & ~harm].mean()


def test_supersaw_carrier_is_level_matched_and_dense():
    k = parse_key("Am")
    s = machine.make_carrier(SR, SR, "saw", k, 2, "root", noise=0.0)
    ss = machine.make_carrier(SR, SR, "supersaw", k, 2, "root", noise=0.0)
    # same level on average; slow beating of the detuned fundamentals makes one render vary by a few dB (the
    # vocoder and talkbox normalize the carrier anyway)
    assert np.all(np.isfinite(ss)) and 20 * np.log10(dsp.rms(ss) / dsp.rms(s)) == pytest.approx(0.0, abs=6.0)
    near = (np.fft.rfftfreq(SR, 1 / SR) > 1000) & (np.fft.rfftfreq(SR, 1 / SR) < 1300)

    def busy_bins(c):  # detuned partials spread each harmonic into a cluster
        spec = np.abs(np.fft.rfft(c * np.hanning(SR)))[near]
        return int(np.sum(spec > spec.max() * 0.1))

    assert busy_bins(ss) > 3 * busy_bins(s)
    assert machine.make_carrier(SR, SR, "supersaw", k, 2, "root", noise=0.0) is ss  # cached


@pytest.mark.parametrize("chord,notes", [("root", 1), ("fifth", 2), ("minor", 3), ("octaves", 3), ("key", 3)])
def test_vocoder_chords(chord, notes):
    k = parse_key("Am")
    assert len(machine.chord_notes(chord, k)) == notes
    c = machine.make_carrier(SR, SR, "saw", k, 2, chord, noise=0.0)
    assert np.all(np.isfinite(c)) and np.abs(c).max() > 0.1


def test_ring_mod_makes_sidebands():
    y = machine.ring_mod(sine(1000), SR, freq_hz=100, mix=1.0)
    spec = np.abs(np.fft.rfft(y[0]))
    f = np.fft.rfftfreq(y.shape[1], 1 / SR)
    top = sorted(f[np.argsort(spec)[-2:]])
    assert top == pytest.approx([900.0, 1100.0], abs=2.0)


@pytest.mark.parametrize("shift", [200.0, -150.0])
def test_frequency_shifter_moves_every_partial(shift):
    y = machine.freq_shift(sine(1000), SR, shift_hz=shift, mix=1.0)
    assert peak_hz(y) == pytest.approx(1000 + shift, abs=2.0)


@pytest.mark.parametrize("mode", ["tanh", "tube", "fold", "hard", "tube>hard"])
def test_drive_curves_are_level_matched_and_finite(mode):
    x = sine(220, amp=0.1)
    y = drive.drive(x, SR, mode=mode, drive_db=24, mix=1.0, oversample=4)
    assert np.all(np.isfinite(y))
    assert dsp.rms(y) == pytest.approx(dsp.rms(x), rel=0.05)
    assert band_db(y, 600, 20000) > band_db(x, 600, 20000) + 20  # harmonics appeared


def test_drive_oversampling_reduces_aliasing():
    x = sine(5000, amp=0.3)
    def alias(y):  # energy away from the odd harmonics of 5 kHz below Nyquist
        spec = np.abs(np.fft.rfft(y[0])) ** 2
        f = np.fft.rfftfreq(y.shape[1], 1 / SR)
        harm = np.zeros_like(f, bool)
        for k in range(1, 5):
            harm |= np.abs(f - 5000 * k) < 30
        return spec[~harm].sum() / spec.sum()
    assert alias(drive.drive(x, SR, mode="hard", drive_db=20, oversample=4)) < 0.5 * alias(
        drive.drive(x, SR, mode="hard", drive_db=20, oversample=1))


def test_bitcrush_quantizes():
    y = crush.bitcrush(sine(100, amp=0.9), 4)
    assert len(np.unique(np.round(y * 8))) <= 16


def test_crush_rate_and_codecs(we_are):
    for kw in (dict(rate_hz=8000), dict(codec_kind="gsm"), dict(codec_kind="mp3", mp3_quality=9.5), dict(bits=6)):
        y = crush.crush(we_are.audio, SR, **kw)
        assert y.shape == we_are.audio.shape and np.all(np.isfinite(y))
    assert band_db(crush.crush(we_are.audio, SR, codec_kind="gsm"), 4500, 20000) < band_db(we_are.audio, 4500, 20000) - 15


def test_noise_bed_level_and_squelch():
    n = 3 * SR
    bed = crush.noise_bed(n, SR, -30.0, start=SR // 2, end=2 * SR, squelch=True)
    assert np.all(bed[:, : SR // 2] == 0) and np.all(bed[:, 2 * SR + 5 :] == 0)
    body = bed[:, SR : SR + SR // 2]
    assert dsp.lin_to_db(dsp.rms(body)) == pytest.approx(-30.0, abs=3.0)
    assert dsp.rms(bed[:, SR // 2 : SR // 2 + 2000]) > 3 * dsp.rms(body)  # squelch burst at the edge
    assert np.max(np.abs(body)) < dsp.db_to_lin(-30.0 + 16.0)  # crackle stays a tick, not a click


def test_tone_filters():
    lo, hi = sine(60), sine(9000)
    assert dsp.rms(tone.tone(lo, SR, hpf_hz=300)) < 0.05 * dsp.rms(lo)
    assert dsp.rms(tone.tone(hi, SR, lpf_hz=3000)) < 0.05 * dsp.rms(hi)
    mid = sine(1200)
    assert dsp.rms(tone.tone(mid, SR, peak_hz=1200, peak_db=6.0)) == pytest.approx(dsp.rms(mid) * 2.0, rel=0.1)


def test_motion_makes_stereo_movement():
    y = motion.motion(sine(440, secs=2.0), SR, phaser_mix=0.5, chorus_mix=0.4)
    assert y.shape[0] == 2 and not np.allclose(y[0], y[1])


def test_ott_compresses_up_and_down():
    quiet, loud = sine(300, 1.0, amp=0.003), sine(300, 1.0, amp=0.5)
    x = np.concatenate([quiet, loud], axis=1)
    y = dynamics.ott(x, SR, amount=1.0)
    ratio_in = dsp.rms(x[:, SR + 5000 :]) / dsp.rms(x[:, 5000:SR])
    ratio_out = dsp.rms(y[:, SR + 5000 :]) / dsp.rms(y[:, 5000:SR])
    assert ratio_out < 0.5 * ratio_in  # the gap between quiet and loud shrank
    silent = dynamics.ott(np.zeros((1, SR), np.float32), SR, amount=1.0)
    assert np.all(silent == 0)  # no noise-floor boost in silence


def test_compressor_reduces_peaks():
    x = sine(300, amp=0.9)
    y = dynamics.compressor(x, SR, threshold_db=-20, ratio=8)
    assert np.max(np.abs(y[:, SR // 2 :])) < 0.5 * np.max(np.abs(x))


def test_generated_ir_is_dark_and_decays():
    ir = space.make_ir(SR, 1.5, 0.0, 0.8, "hall", 3)
    assert ir.shape[0] == 2
    assert np.sum(ir[0] ** 2) == pytest.approx(1.0, rel=1e-3)
    early, late = ir[:, : int(0.2 * SR)], ir[:, int(0.8 * SR) : int(1.0 * SR)]
    assert dsp.rms(late) < 0.1 * dsp.rms(early)
    assert band_db(late, 4000, 24000) < band_db(early, 4000, 24000) - 6  # highs die first
    assert np.corrcoef(ir[0], ir[1])[0, 1] < 0.2  # decorrelated stereo


def test_convolution_backends_agree():
    x = np.random.default_rng(0).standard_normal((2, SR)).astype(np.float32) * 0.1
    ir = space.make_ir(SR, 0.5, 5.0, 0.5, "plate", 1)
    a = space.convolve(x, ir, SR, backend="fft")
    b = space.convolve(x, ir, SR, backend="pedalboard")
    assert np.max(np.abs(a - b)) < 1e-3 * np.max(np.abs(a))


def test_tempo_delay_and_pingpong():
    x = np.zeros((1, 2 * SR), np.float32)
    x[0, 100] = 1.0
    t = note_seconds("1/8", 120)
    wet = space.delay_wet(x, SR, time_s=t, feedback=0.5, pingpong=True, lpf_hz=None, hpf_hz=None)
    d = int(round(t * SR))
    assert abs(int(np.argmax(np.abs(wet[0]))) - (100 + d)) <= 2
    assert abs(int(np.argmax(np.abs(wet[1]))) - (100 + 2 * d)) <= 2  # second repeat on the other side


def test_throws_only_follow_flagged_spans():
    x = np.concatenate([sine(300, 0.5), np.zeros((1, 3 * SR), np.float32)], axis=1)
    wet = space.throws_wet(x, SR, [], time_s=0.3)
    assert np.all(wet == 0)
    wet = space.throws_wet(x, SR, [(0, SR // 2)], time_s=0.3)
    assert dsp.rms(wet[:, 2 * SR :]) > 1e-4  # still ringing long after the word


def test_reverse_swell_ends_at_the_onset():
    onset = SR
    x = np.zeros((1, 2 * SR), np.float32)
    x[:, onset : onset + SR // 2] = sine(200, 0.5)
    sw = space.reverse_swell(x, SR, onset, length_s=0.8)
    assert np.all(sw[:, onset:] == 0)
    pre = sw[:, onset - int(0.8 * SR) : onset]
    first, last = dsp.rms(pre[:, : pre.shape[1] // 3]), dsp.rms(pre[:, -pre.shape[1] // 3 :])
    assert last > 2 * first  # crescendo into the word


def test_stereo_width_keeps_lows_mono():
    rng = np.random.default_rng(3)
    x = rng.standard_normal((2, SR)).astype(np.float32) * 0.1
    y = stereo.stereo(x, SR, width=1.5, mono_below_hz=150)
    side = 0.5 * (y[0] - y[1])
    assert band_db(side[None, :], 0, 120) < -60
    assert stereo.mono_compat(stereo.stereo(sine(440), SR, width=2.0))["correlation"] == pytest.approx(1.0)


def test_prep_envelope_highpass_and_gate():
    sp = np.ones((10, 1025))
    f0 = np.full(10, 120.0)
    levels = np.array([-10.0] * 5 + [-90.0] * 5)
    out, f0o = prep.prep_envelope(sp, f0, SR, levels, hpf_hz=200, gate_db=-50, deess=0.0)
    f = np.arange(1025) * SR / 2048
    assert out[0, np.argmin(np.abs(f - 50))] < 0.01 and out[0, np.argmin(np.abs(f - 2000))] > 0.99
    assert np.all(f0o[:1] > 0) and out[-1].max() < 1e-3  # gated frames silenced


def test_deess_reduces_sibilance():
    rng = np.random.default_rng(1)
    hiss = dsp.highpass(rng.standard_normal((1, SR)).astype(np.float32) * 0.2, SR, 6000)
    y = prep.deess(hiss, SR, amount_db=10)
    assert dsp.rms(y) < 0.6 * dsp.rms(hiss)
