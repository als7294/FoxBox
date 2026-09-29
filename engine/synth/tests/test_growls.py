import numpy as np
import pytest
from scipy import signal

from fvwks_synth.growls import STYLES, TEAROUT_STATES, VARIANTS, qa, render_growl

SR, BPM = 48_000, 145.0


def test_every_growl_is_exact_finite_faded_and_moving():
    for style in STYLES:
        for v in range(VARIANTS):
            x = render_growl(style, 37, 2.0, BPM, SR, v)
            m = qa(x, SR)
            assert x.shape == (2, round(2 * 60 / BPM * SR)) and x.dtype == np.float32 and np.isfinite(x).all()
            assert m["peak_db"] <= 0 and m["edge"] < 1e-3, (style, v, m)  # raised-cosine fades at both ends
            dense = m["crest_db"] < (35 if style == "gun" else 25)  # a gun is ~100 ms of shot, then silence
            assert 4 < m["crest_db"] and dense and (style in ("808", "darkhit", "gunshot", "chomp") or m["centroid_move"] > 0.02), (style, v, m)
    assert np.array_equal(render_growl("tearout", 37, 1, BPM, SR, 2), render_growl("tearout", 37, 1, BPM, SR, 2))


def test_the_sub_is_a_clean_mono_layer():
    lp = signal.butter(4, 100, "lowpass", fs=SR, output="sos")
    sub = signal.sosfiltfilt(lp, render_growl("tearout", 47, 1, BPM, SR))
    assert np.corrcoef(sub[0], sub[1])[0, 1] > 0.99  # only the grit above 2.5 kHz is widened

    def band(y, lo, hi):  # MIDI 47 is 123 Hz: its sub is forced down into 30-60 Hz (61.7 → 30.9 Hz)
        spec, f = np.abs(np.fft.rfft(y.mean(axis=0))) ** 2, np.fft.rfftfreq(len(y[0]), 1 / SR)
        return spec[(f > lo) & (f < hi)].sum()
    with_sub, without = render_growl("tearout", 47, 1, BPM, SR), render_growl("tearout", 47, 1, BPM, SR, sub=False)
    assert band(without, 25, 40) < 0.05 * band(with_sub, 25, 40)


def test_tearout_hits_are_different_sounds_and_the_chops_are_click_free():
    specs = []
    for hit in range(8):  # growl / screech / dive / stab, twice, each hit its own state
        x = render_growl("tearout", 37, 0.5, BPM, SR, 0, hit=hit)
        spec = np.abs(np.fft.rfft(x.mean(axis=0), 8192))[:1400]
        specs.append(spec / np.linalg.norm(spec))
    sims = [float(a @ b) for i, a in enumerate(specs) for b in specs[i + 1:]]
    assert max(sims) < 0.99 and len(TEAROUT_STATES) == 4, sims
    # S2's use: MIDI 36-47 chops of 1/3 and 1/4 beat at 145, over its own sub: no click where a chop joins its neighbour
    for style in STYLES:
        for v in range(VARIANTS):
            for midi, beats in ((36, 1 / 3), (47, 0.25), (41, 1 / 3)):
                assert qa(render_growl(style, midi, beats, BPM, SR, v, sub=False), SR)["clicks"] == 0, (style, v, midi)


def test_the_click_check_hears_a_click_at_a_join():
    x = render_growl("chomp", 37, 1.0, BPM, SR, 0)
    assert qa(x[:, : -int(0.030 * SR)], SR)["clicks"] == 1  # cut dead 30 ms early: it clicks where the next chop joins
    with pytest.raises(KeyError):
        render_growl("dubstep", 36, 1, BPM)


def test_gun_shots_are_short_with_silence_after_and_the_machine_gun_steps_in_pitch():
    for v in range(VARIANTS):
        for hit in range(3):
            x = render_growl("gun", 37, 1.0, BPM, SR, v, hit=hit)
            e = np.abs(x).max(axis=0)
            sounding = np.flatnonzero(e > 1e-3 * e.max())[-1] / SR
            assert 0.06 <= sounding <= 0.25, (v, hit, sounding)  # an 80-200 ms shot (+ its fades), then real silence
    x = render_growl("mgun", 37, 1.0, BPM, SR, 1, sub=False).mean(axis=0)
    step = int(7.5 / BPM * SR)
    pitch = []
    for k in range(6):  # each 1/32 repeat's strongest partial moves the same way, 1-2 st a step
        seg = x[k * step:(k + 1) * step]
        spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), 1 << 16))
        pitch.append(np.argmax(spec[: int(2000 / SR * (1 << 16))]))
    d = np.diff(np.log2(np.array(pitch, float)) * 12)
    assert np.all(np.sign(d) == np.sign(d[0])) and 0.5 < abs(np.mean(d)) < 2.5, d


def test_printed_banks_are_dense_one_shots_and_calls_never_repeat_back_to_back():
    from fvwks_synth.growls import printed_bank
    for seed in (0, 7):
        bank = printed_bank(37.0, BPM, SR, seed)
        (hero,), calls = bank["hero"], bank["calls"]
        assert 0.4 <= len(hero) / SR <= 0.7 and all(0.08 <= len(c) / SR <= 0.25 for c in calls) and len(calls) >= 4
        crest = [20 * np.log10(np.max(np.abs(y)) / np.sqrt(np.mean(y * y))) for y in (hero, *calls)]
        assert max(crest) <= 14, crest  # M1.3's accept
    a, b = (render_growl("call", 37, 0.25, BPM, SR, 0, sub=False, hit=h) for h in (4, 5))
    assert not np.allclose(a, b)
    from fvwks_synth.growls import render_hero
    hero = render_hero(37, 1.5, BPM, SR, 7)  # M1.2b: from the onset, then silence
    e = np.abs(hero).max(axis=0)
    assert e[: int(0.01 * SR)].max() > 0.3 * e.max() and 0.4 <= np.flatnonzero(e > 1e-3 * e.max())[-1] / SR <= 0.72


def test_a_takes_resolved_axes_reach_the_voices():
    from fvwks_synth.growls import AXES
    assert {"resample.passes", "resample.movement", "resample.mangle", "tearout.chomp_snap"} <= set(AXES)
    assert all(isinstance(o, str) for opts in AXES.values() for o in opts)  # TakeChoice.option is a string
    snap24 = render_growl("chomp", 37, 0.5, BPM, SR, 1)
    assert np.array_equal(snap24, render_growl("chomp", 37, 0.5, BPM, SR, 1, axes={"tearout.chomp_snap": "24"}))  # the default
    assert not np.allclose(snap24, render_growl("chomp", 37, 0.5, BPM, SR, 1, axes={"tearout.chomp_snap": "12"}))
    three = {"resample.passes": "3", "resample.movement": "comb", "resample.mangle": "pitch"}
    a = render_growl("hero", 37, 1.5, BPM, SR, 4, axes=three)
    assert not np.allclose(a, render_growl("hero", 37, 1.5, BPM, SR, 4, axes={**three, "resample.passes": "5"}))


def test_every_designed_patch_renders_and_previews(tmp_path, monkeypatch):
    from fvwks_synth import bass
    from fvwks_synth.growls import DESIGNED, designed_patches, designed_preview, render_designed
    import soundfile as sf
    monkeypatch.setattr(bass, "data_dir", lambda: tmp_path)
    cats = {p.category for p in designed_patches()}
    assert cats == {"tearout", "top", "riddim", "808", "wobble"} and len(designed_patches()) == len(DESIGNED)
    for pid in DESIGNED:
        y = render_designed(pid, 36, 0.5, BPM, SR)
        assert y.shape[0] == 2 and np.isfinite(y).all() and np.abs(y).max() > 0.01, pid
    path = designed_preview("voice:gun")
    x, sr = sf.read(path)
    assert sr == 48_000 and 1.6 < len(x) / sr < 2.1 and path == designed_preview("voice:gun")  # cached


def test_prints_are_cached_by_content_once_the_synth_is_configured(tmp_path, monkeypatch):
    from fvwks_synth import bass, growls
    monkeypatch.setattr(bass, "_data", None)
    render_growl("talker", 40, 0.25, BPM, SR, 1, sub=False, hit=3)
    assert not (tmp_path / "prints").exists()  # unconfigured (tests, scripts): nothing written
    monkeypatch.setattr(bass, "_data", tmp_path)
    a = render_growl("talker", 40, 0.25, BPM, SR, 1, sub=False, hit=np.int64(3))
    files = list((tmp_path / "prints").glob("*.npy"))
    assert len(files) == 1 and np.array_equal(a, render_growl("talker", 40, 0.25, BPM, SR, 1, sub=False, hit=3))
    assert len(list((tmp_path / "prints").glob("*.npy"))) == 1  # the second call read it back
    render_growl("talker", 40, 0.25, BPM, SR, 1, sub=False, hit=4)  # another state: another print
    monkeypatch.setattr(growls, "PRINT_CAP_BYTES", 1)
    growls._prune(tmp_path / "prints")
    assert not list((tmp_path / "prints").glob("*.npy"))  # over the cap: pruned, oldest first


def test_a_low_notes_two_period_buzz_is_not_clicks():
    from fvwks_synth.growls import clicks
    e, at, k = np.zeros(SR * 2), 0.1, 0  # HF power: an edge every 2 periods of C#1 (57.8 ms, +-5 % comb wobble)
    while at < 1.5:
        e[int(at * SR)] = 1.0
        at += 2 / 34.65 * (1 + 0.05 * np.sin(k))
        k += 1
    assert clicks(e, SR) == 0  # S1's R1 buzz (remix_qa._clicks is held to the same case)
    e[int(1.8 * SR)] = 1.0
    assert clicks(e, SR) == 1
