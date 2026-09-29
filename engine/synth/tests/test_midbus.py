import numpy as np

from fvwks_synth import midbus as mb

SR = 48_000
T = np.arange(SR) / SR


def rms(y, a, b):
    return float(np.sqrt(np.mean(y[..., int(a * SR):int(b * SR)] ** 2)))


def test_ott_lifts_the_tail_and_depth_zero_is_dry():
    x = np.stack([np.sin(2 * np.pi * 220 * T) * np.exp(-T / 0.2)] * 2)
    body_to_tail = lambda y: 20 * np.log10(rms(y, 0.8, 1.0) / rms(y, 0.1, 0.2))  # noqa: E731
    assert body_to_tail(mb.ott(x, SR, 1.0)) > body_to_tail(x) + 6  # upward compression: quiet tails come up
    assert np.allclose(mb.ott(x, SR, 0.0), x)
    assert np.isfinite(mb.ott(np.zeros((2, SR)), SR, 1.0)).all() and not mb.ott(np.zeros(SR), SR, 1.0).any()


def test_distortion_is_oversampled_and_the_chain_is_level_matched():
    s = 0.9 * np.sin(2 * np.pi * 7000 * T)

    def alias_db(y):  # energy away from 7 / 14 / 21 kHz over the harmonics
        sp, f = np.abs(np.fft.rfft(y * np.hanning(len(y)))) ** 2, np.fft.rfftfreq(len(y), 1 / SR)
        harm = np.zeros_like(f, bool)
        for k in (1, 2, 3):
            harm |= np.abs(f - 7000 * k) < 30
        return 10 * np.log10(sp[~harm & (f > 100)].sum() / sp[harm].sum())
    assert alias_db(mb.distort(s, 20, "hard")) < alias_db(np.clip(10 * s, -1, 1)) - 25
    x = np.stack([np.sin(2 * np.pi * 110 * T), np.sin(2 * np.pi * 110 * T + 0.2)]) * np.exp(-T / 0.5)
    for preset in mb.PRESETS:
        y = mb.midbus(x, SR, preset)
        assert y.shape == x.shape and np.isfinite(y).all() and abs(rms(y, 0, 1) / rms(x, 0, 1) - 1) < 0.05, preset


def test_the_sub_is_a_pure_gated_sine_in_30_60_hz():
    assert all(30 <= mb.sub_hz(m) < 60 for m in range(20, 72))
    hz = mb.sub_hz(37)
    y = mb.sub_voice(hz, SR, SR)
    spec, f = np.abs(np.fft.rfft(y * np.hanning(SR))) ** 2, np.fft.rfftfreq(SR, 1 / SR)
    assert 10 * np.log10(spec[f > 3 * hz].sum() / spec[np.abs(f - hz) < 3].sum()) < -25  # §5 sub purity
    assert abs(y[0]) < 1e-6 and abs(y[-1]) < 1e-3


def test_resample_chain_keeps_every_generation_dense_and_without_aliasing():
    t = np.arange(int(1.5 * SR)) / SR
    src = np.sin(2 * np.pi * 164.8 * t + (2.5 + 1.5 * np.sin(2 * np.pi * t)) * np.sin(2 * np.pi * 329.6 * t))
    for seed in range(4):  # every option of every axis comes up across the seeds
        gens = mb.resample_chain(src, SR, seed)
        assert len(gens) in (4, 6) and all(np.isfinite(g).all() and abs(np.max(np.abs(g)) - 10 ** (-1 / 20)) < 1e-6 for g in gens)
        crest = [20 * np.log10(np.max(np.abs(g)) / np.sqrt(np.mean(g ** 2))) for g in gens]
        assert max(crest) <= 14, (seed, crest)  # printed shots are dense
    assert all(np.array_equal(a, b) for a, b in zip(mb.resample_chain(src, SR, 3), mb.resample_chain(src, SR, 3)))
    # a 3 kHz sine through the drive and the clip (the comb keeps it harmonic): nothing folds back between its harmonics
    y = mb.chain_a(0.8 * np.sin(2 * np.pi * 3000 * t), SR, np.random.default_rng(1), movement="comb")
    spec, f = np.abs(np.fft.rfft(y * np.hanning(len(y)))) ** 2, np.fft.rfftfreq(len(y), 1 / SR)
    harm = np.any([np.abs(f - k * 3000) < 30 for k in range(1, 9)], axis=0)
    assert 10 * np.log10(spec[~harm & (f > 100)].sum() / spec[harm].sum()) < -60


def test_a_held_print_stays_on_its_notes_harmonics():
    """REMIX_HARMONY 1.4: with the note's f0 chain A shifts by m f0 / 2 and combs on an octave of f0."""
    assert abs(mb.octave_of(440.0, 65.41) - 523.28) < 0.01 and mb.harmonic_shift(-60.0, 32.7) == -65.4
    assert list(mb.harmonic_of(np.array([900.0, 20.0]), 110.0)) == [880.0, 110.0]
    f0, t = 98.0, np.arange(SR) / SR
    for seed in range(3):
        y = mb.chain_a(0.8 * np.sin(2 * np.pi * 4 * f0 * t), SR, np.random.default_rng(seed), movement="shift", f0=f0)
        spec, f = np.abs(np.fft.rfft(y * np.hanning(len(y)))), np.fft.rfftfreq(len(y), 1 / SR)
        for peak in f[np.argsort(spec)[-5:]]:  # the loudest partials sit on the f0 / 2 grid
            assert abs(peak / (f0 / 2) - round(peak / (f0 / 2))) * f0 / 2 < 2.0, (seed, peak)


def test_the_resonance_notch_takes_down_the_tallest_2_4_khz_peak():
    rng = np.random.default_rng(0)
    x = rng.standard_normal(SR) * 0.1 + 0.3 * np.sin(2 * np.pi * 2900 * T)  # a whistle over a flat bed
    y = mb.resonance_notch(x, SR)
    level = lambda s, hz: np.abs(np.fft.rfft(s))[int(hz)]  # noqa: E731 (1 Hz bins)
    assert 20 * np.log10(level(y, 2900) / level(x, 2900)) < -6  # notched 8 dB (it stands far out), plus the dynamic cut
    assert abs(20 * np.log10(rms(mb.lr4(y, 500, SR, "lowpass"), 0, 1) / rms(mb.lr4(x, 500, SR, "lowpass"), 0, 1))) < 0.5


def test_a_print_ends_on_raised_cosine_edges_whatever_rang_on():
    y = mb.midbus(0.8 * np.sin(2 * np.pi * 110 * T[: SR // 4] + 1.0), SR, "print")  # cut mid-cycle at both ends
    assert abs(y[0]) < 1e-9 and np.max(np.abs(y[-int(0.001 * SR):])) < 0.01 * np.max(np.abs(y))
