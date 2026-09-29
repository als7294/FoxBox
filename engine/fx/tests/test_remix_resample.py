"""1.6 RESAMPLE: the bass stem sliced into one-shots and re-sequenced on a riddim grid over a clean sub."""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from test_bassline import BPM, SR, _tracks  # noqa: E402

from fvwks_contracts.models import SongAnalysis  # noqa: E402
from fvwks_fx.remix.resample import drop_chain, sequence, slice_bass, sub_line  # noqa: E402


def test_slice_sequence_sub_chain():
    bass, _ = _tracks()
    a = SongAnalysis(bpm=BPM, downbeat_s=0.0)
    shots = slice_bass(bass, SR, a, 9, 8)  # the wobble section: growls
    assert len(shots) >= 8 and all(s.audio.shape[0] == 2 and s.bright > 0 for s in shots)
    bus, hits = sequence(shots, "riddim", 4, BPM, SR, root_pc=9)
    assert bus.shape == (2, round(4 * 4 * 60 / BPM * SR)) and np.abs(bus).max() > 0.05
    bar1 = sorted(round(b, 3) for _, b, _ in hits if b < 4)
    assert bar1 == [0.0, 1.0, 1.333, 2.25, 2.667, 3.5]  # RIDDIM_H: a call, 1/8T repeats, a response off the snare's 1/16
    assert {round(m) % 12 for m, b, _ in hits if b < 4} == {9}  # RIDDIM_H bar 1: the root (A) and its octave (the user's set3)
    sub = sub_line(hits, BPM, SR, bus.shape[1])
    spec = np.abs(np.fft.rfft(sub))
    f0 = np.fft.rfftfreq(sub.size, 1 / SR)[np.argmax(spec)]
    assert 28 <= f0 < 56  # the sub octave
    out = drop_chain(bus, SR)
    assert np.isfinite(out).all()
    low = lambda x: np.abs(np.fft.rfft(x.mean(0)))[: int(60 * x.shape[1] / SR)].sum()
    assert low(out) < 0.1 * low(bus)  # hi-passed: the sub owns the low end


def test_sequence_follows_the_chords():  # the degree templates (REMIX_HARMONY 2.5) on each bar's chord
    from fvwks_fx.remix.resample import OneShot, sequence

    sr, bpm = 22050, 140.0
    tone = lambda m: np.stack([np.sin(2 * np.pi * 440 * 2 ** ((m - 69) / 12) * np.arange(sr // 4) / sr)] * 2).astype(np.float32)  # noqa: E731
    shots = [OneShot(tone(45), 45.0, 0.25, 1000.0, 0.5), OneShot(tone(45), 45.0, 0.25, 900.0, 0.4)]
    prog = {0: (9, 3), 1: (5, 4), 2: (0, 4), 3: (7, 4)}  # Am, F, C, G
    _, hits = sequence(shots, "riddim", 3, bpm, sr, 9, 4, lambda b, beat=0.0: prog[b])
    for bar, (root, third) in list(prog.items())[:3]:
        pcs = {int(round(m)) % 12 for m, b, _ in hits if 4 * bar <= b < 4 * bar + 4}
        assert root in pcs and pcs <= {(root + d) % 12 for d in (0, 1, 6, 7, 10, third)}, (bar, pcs)  # the degrees


def test_the_sub_plays_roots_in_b0_b1():  # REMIX_HARMONY 2.1 / 2.6
    from fvwks_fx.remix.resample import _fold_sub, root_line

    assert _fold_sub(6, None) == 30  # F#1 (46.2 Hz) for i
    assert _fold_sub(2, 30) == 26  # VI after F#1: D1 (36.7 Hz), not D2
    assert all(23 <= _fold_sub(pc, 30) <= 35.99 for pc in range(12))
    sr, bpm = 8000, 120.0
    n = 4 * 2 * sr  # 4 bars at 120
    y = root_line(lambda bar, beat: 9 if bar < 2 else 5, 4, bpm, sr, n)  # A for 2 bars, then F
    f = lambda a, b: sr / (2 * np.mean(np.diff(np.flatnonzero(np.diff(np.signbit(y[a:b]).astype(int)) != 0))))  # noqa: E731
    assert abs(f(sr // 2, sr) - 55.0) < 1.5 and abs(f(5 * sr, 5 * sr + sr // 2) - 43.65) < 1.5  # A1, then F1 (nearest)


def test_a_shot_keeps_only_its_own_hit():  # S3's trace: song-1's snare shot carried a louder hit 137 ms in
    from fvwks_fx.remix.resample import _own_hit

    sr = 22050
    t = np.arange(int(0.3 * sr)) / sr
    hit = lambda at, g: g * np.exp(-np.maximum(t - at, 0) / 0.02) * (t >= at) * np.sin(2 * np.pi * 200 * t)  # noqa: E731
    y = np.stack([hit(0.005, 0.6) + hit(0.137, 1.0)] * 2)
    cut = _own_hit(y, sr)
    assert 0.03 < cut.shape[1] / sr < 0.137 and np.abs(cut).max() < 0.7  # the flam's hit is gone
    clean = np.stack([hit(0.005, 1.0)] * 2)
    assert _own_hit(clean, sr).shape == clean.shape  # a clean shot is untouched
