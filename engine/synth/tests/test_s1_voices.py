"""S1's REMIX voices: RIDDIM R1/R2 (through render_growl), the 808 line and the dark first hit."""

from __future__ import annotations

import numpy as np

from fvwks_synth import bass808, growls
from fvwks_synth.riddim import saw_down

SR = 48_000
BPM = 145.0


def test_riddim_voices_restart_their_lfo_and_never_click():
    lfo = saw_down(np.arange(SR // 2) / SR, "1/8", 150.0)  # 200 ms cycles
    assert lfo[0] == 1.0 and lfo[int(0.141 * SR)] == 0.0 and lfo[int(0.2 * SR) + 1] > 0.9  # shut for the last 30 %
    for style in ("riddim", "yoi"):
        for v in range(4):
            for midi, beats in ((32, 1 / 3), (44, 2.0)):
                x = growls.render_growl(style, midi, beats, BPM, variant=v, sub=False)
                assert x.shape == (2, round(beats * 60 / BPM * SR)) and np.isfinite(x).all()
                assert growls.qa(x, SR)["clicks"] == 0, (style, v, midi, beats)


def test_yoi_loop_has_no_grit_ticks():
    """The growl post's grit folded yoi's formant swells into HF ticks (32 in this loop at drive 2): a 4-bar loop, the
    voice alone, counted the way the loop QA does (clicks() on the power above 4 kHz)."""
    from scipy import signal

    n = round(16 * 60 / BPM * SR)
    bus = growls._loop("yoi", 1, SR, BPM, 37, n).mean(axis=0)
    hf = signal.sosfiltfilt(signal.butter(4, 4000, "highpass", fs=SR, output="sos"), bus) ** 2
    assert growls.clicks(hf, SR) == 0


def test_808_starts_near_the_note_and_glides_only_on_overlaps():
    line = [(0, 1.5, 33), (1.25, 1.0, 40), (2.5, 0.5, 28), (3.0, 1.0, 45)]  # 1-2 overlap; 3 and 4 don't
    segs = bass808.pitch_line(line, BPM, SR)
    assert len(segs) == 3
    a, p = segs[0]
    assert p[0] <= 33 + 7 and abs(p[int(0.03 * SR)] - 33) < 0.2  # a small drop, settled by 30 ms (no whine)
    k = int(1.25 * 60 / BPM * SR)
    assert 33 < p[k + int(0.04 * SR)] < 40 and abs(p[k + int(0.09 * SR)] - 40) < 0.01  # an 80 ms glide to +7
    assert abs(segs[2][1][int(0.03 * SR)] - 45) < 0.2  # no glide into a note that doesn't overlap
    for v in range(4):
        x = bass808.render_808_line(line, BPM, variant=v)
        assert growls.qa(x, SR)["clicks"] == 0 and np.allclose(x[0], x[1])  # mono


def test_dark_first_hit_is_on_pitch_from_the_start():
    for v in range(4):
        x = bass808.render_darkhit(33, 2.0, BPM, variant=v)[0].astype(float)
        first = x[: int(0.12 * SR)]
        ups = np.flatnonzero((first[:-1] <= 0) & (first[1:] > 0))
        assert abs(SR / np.median(np.diff(ups)) - 55.0) < 2.0  # A1 from the first cycles
        assert growls.qa(bass808.render_darkhit(33, 4.0, BPM, variant=v), SR)["clicks"] == 0


def test_candy_is_in_key_exact_and_click_free():
    from fvwks_synth.candy import KINDS, render_candy

    for kind in KINDS:
        for v in range(4):
            x = render_candy(kind, 37, 1.0, BPM, variant=v)
            assert x.shape == (2, round(60 / BPM * SR)) and growls.qa(x, SR)["clicks"] == 0, (kind, v)
    last = render_candy("powerup", 37, 1.0, BPM)[0, -int(0.012 * SR):].astype(float)  # the top step
    ups = np.flatnonzero((last[:-1] <= 0) & (last[1:] > 0))
    assert abs(SR / np.mean(np.diff(ups)) - 440 * 2 ** ((37 + 36 + 24 - 69) / 12)) < 30  # +24 st by the end


def test_drums_are_click_free_seeded_and_on_their_marks():
    from fvwks_synth.drums import VOICES, render_drum

    for voice in VOICES:
        for variant in (0, 1):
            x = render_drum(voice, SR, 1.0, seed=variant, variant=variant, root_hz=49.0)
            assert x.shape[0] == 2 and np.isfinite(x).all() and growls.qa(x, SR)["clicks"] == 0, (voice, variant)
    a, b = render_drum("snare", SR, seed=1), render_drum("snare", SR, seed=2)
    assert np.array_equal(a, render_drum("snare", SR, seed=1)) and not np.allclose(a, b)  # repeatable, not identical
    body = render_drum("kick", SR, root_hz=49.0)[0, int(0.12 * SR):int(0.2 * SR)].astype(float)
    ups = np.flatnonzero((body[:-1] <= 0) & (body[1:] > 0))
    assert abs(SR / np.mean(np.diff(ups)) - 49.0) < 3  # the kick lands on the root
    rev = np.abs(render_drum("reverse_cymbal", SR, length_s=1.0)[0])
    assert np.argmax(rev) > 0.9 * len(rev)  # it swells into its last moments
    ghost = render_drum("kick", SR, vel=0.35)
    assert abs(20 * np.log10(np.max(np.abs(ghost)) / np.max(np.abs(render_drum("kick", SR)))) + 9.1) < 0.2


def test_squeak_and_late_delay():
    from fvwks_synth.riddim import late_with_delay, render_squeak

    sq = render_squeak(37, 1.0, BPM)
    assert growls.qa(sq, SR)["clicks"] == 0
    hit = growls.render_growl("riddim", 37, 0.5, BPM, sub=False)
    d = late_with_delay(hit, SR, BPM)
    late = round(60 / BPM * SR / 8)
    assert not d[:, :late].any() and np.allclose(d[:, late:late + 100], hit[:, :100])  # 1/32 late, then the hit
    assert growls.qa(d, SR)["clicks"] == 0


def test_riddim_and_808_choices_come_from_the_take():
    from fvwks_synth import riddim

    assert riddim.option(None, "riddim.r1_throat") == "1"  # nothing resolved: the likeliest option
    assert riddim.option({"riddim.r1_throat": "0.5"}, "riddim.r1_throat") == "0.5"  # the take's choice wins
    rng = np.random.default_rng(3)
    assert {riddim.option(None, "riddim.r2_blend", rng=rng) for _ in range(40)} == {"0.3", "0.4", "0.5"}  # auditions
    assert riddim.rate_variants({"riddim.r1_rates": "triplet"}) == (1, 3) and riddim.r2_blend({"riddim.r2_blend": "0.5"}) == 0.5
    # The axes reach the sound through render_growl.
    plain = growls.render_growl("riddim", 40, 1.0, BPM, sub=False)
    throat = growls.render_growl("riddim", 40, 1.0, BPM, sub=False, axes={"riddim.r1_throat": "0.5", "riddim.r1_comb_hz": "600"})
    assert not np.allclose(plain, throat) and growls.qa(throat, SR)["clicks"] == 0
    # 808: a lazier glide and a smaller drop, by the take.
    line = [(0, 1.5, 33), (1.25, 1.0, 40)]
    k = int(1.25 * 60 / BPM * SR) + int(0.085 * SR)
    bible = bass808.pitch_line(line, BPM, SR)[0][1]
    lazy = bass808.pitch_line(line, BPM, SR, axes={"808.glide": "lazy", "808.drop_st": "3"})[0][1]
    mid = k - int(0.035 * SR)  # 50 ms into the glide
    assert abs(bible[k] - 40) < 0.05 and lazy[mid] < bible[mid] - 0.8  # 80 ms is done by 85 ms; the lazy one lags
    assert abs(lazy[0] - 36) < 0.01


def beat_movement(x: np.ndarray, bpm: float = BPM) -> float:
    """The Sound Bible §5 timbre-movement check: the spectral centroid in 1/16 frames, its std within each beat (Hz,
    the median over beats). Riddim's bar is 150 Hz, tearout's 300."""
    mono = x.mean(axis=0).astype(float)
    hop = int(round(60 / bpm / 4 * SR))
    f = np.fft.rfftfreq(hop, 1 / SR)
    c = []
    for i in range(0, len(mono) - hop + 1, hop):
        p = np.abs(np.fft.rfft(mono[i:i + hop] * np.hanning(hop))) ** 2
        c.append((f * p).sum() / (p.sum() + 1e-20))
    return float(np.median([np.std(c[k:k + 4]) for k in range(0, len(c) - 3, 4)]))


def test_trap_hybrid_voices_move_and_never_click():
    from fvwks_synth.hybrid import rise_fall, steps

    lfo = rise_fall(np.arange(SR) / SR, "1/4", 150.0)  # 400 ms cycles
    assert lfo[0] == 0 and lfo[int(0.3 * SR)] > 0.9 and lfo[int(0.39 * SR)] < 0.2  # slow rise, fast fall
    st = steps(np.arange(SR) / SR, (1.0, 0.2), 150.0, SR)
    assert np.max(np.abs(np.diff(st))) < 0.01  # the steps are slewed: no jump to click
    for style in ("wobble", "dswub"):
        moves = []
        for v in range(4):
            x = growls.render_growl(style, 37, 4.0, BPM, variant=v, sub=False, axes={"hybrid.ds_rate_hz": "6000"})
            assert growls.qa(x, SR)["clicks"] == 0, (style, v)
            moves.append(beat_movement(x))
        # The fast takes clear riddim's bar; the slowest (1/4T: a cycle every ~1.5 beats) still moves; none drones.
        assert max(moves) >= 150 and min(moves) >= 40, (style, moves)


def test_riddim_r1_moves_within_a_beat():
    moves = [beat_movement(growls.render_growl("riddim", 44, 4.0, BPM, variant=v, sub=False)) for v in range(4)]
    assert np.median(moves) >= 100, moves  # the default takes: a real sweep, not just the amp wub (was 6-14 Hz)
