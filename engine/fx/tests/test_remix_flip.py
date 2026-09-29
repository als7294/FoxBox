"""1.6 GENRE FLIP: a synthetic 140 BPM loop (kick on 1, the "and" of 2 and 3; snare on 2 and 4; hats on 8ths) split into
kick / snare / hats, and its hits read back on the grid."""

import numpy as np
from scipy import signal

from fvwks_contracts.models import SongAnalysis
from fvwks_fx.remix.flip import drum_hits, split_drums

SR, BPM, BARS = 44100, 140.0, 4
BEAT = 60 / BPM
PATTERN = {"kick": [0, 1.5, 2], "snare": [1, 3], "hats": [k / 2 for k in range(8)]}


def _loop() -> np.ndarray:
    rng = np.random.default_rng(1)
    n = int(BARS * 4 * BEAT * SR) + SR // 2
    x = np.zeros(n)
    t = np.arange(int(0.4 * SR)) / SR
    kick = np.sin(2 * np.pi * np.cumsum(45 + 75 * np.exp(-t / 0.03)) / SR) * np.exp(-t / 0.2)
    kick[:88] += 0.3 * signal.sosfilt(signal.butter(2, 2000, "high", fs=SR, output="sos"), rng.standard_normal(88))
    snare = (0.5 * np.sin(2 * np.pi * 180 * t) + signal.sosfilt(signal.butter(2, (1000, 8000), "band", fs=SR, output="sos"),
                                                               rng.standard_normal(t.size))) * np.exp(-t / 0.12)
    hat = signal.sosfilt(signal.butter(4, 7000, "high", fs=SR, output="sos"), rng.standard_normal(t.size)) * np.exp(-t / 0.03)
    for bar in range(BARS):
        for kind, sound, gain in (("kick", kick, 0.9), ("snare", snare, 0.6), ("hats", hat, 0.3)):
            for b in PATTERN[kind]:
                i = int((bar * 4 + b) * BEAT * SR)
                x[i : i + sound.size] += gain * sound[: n - i]
    return x[None, :].astype(np.float32)


def test_split_and_hits():
    loop = _loop()
    parts = split_drums(loop, SR)
    assert set(parts) == {"kick", "snare", "hats"} and all(p.shape == loop.shape for p in parts.values())
    hits = drum_hits(loop, SR, SongAnalysis(bpm=BPM, downbeat_s=0.0))
    for kind, beats in PATTERN.items():
        want = [bar * 4 + b for bar in range(BARS) for b in beats]
        got = [h.beat for h in hits if h.kind == kind]
        assert len(got) == len(want), (kind, got)
        assert max(abs(g - w) for g, w in zip(got, want)) * BEAT < 0.01, (kind, got)  # within 10 ms


def test_reprogram_keeps_the_arrangement():
    from fvwks_fx.remix.flip import Hit, reprogram

    # bar 1: a 4x4 groove; bar 2: silent (a breakdown); bar 3: a snare roll (16ths)
    hits = [Hit("kick", b, 1.0) for b in range(4)] + [Hit("snare", 1, 0.8), Hit("snare", 3, 0.8)]
    hits += [Hit("snare", 8 + k / 4, 0.5 + k / 32) for k in range(16)]
    out = reprogram(hits, "halftime", start_bar=1, bars=3, swing=0.5)
    assert [h.beat for h in out if h.kind == "snare" and h.beat < 4] == [2]  # half-time: the snare on 3
    assert not [h for h in out if 4 <= h.beat < 8]  # the silent bar stays silent
    assert len([h for h in out if h.kind == "snare" and h.beat >= 8]) == 16  # the roll is kept as played
    assert any(abs(h.beat - (1.75 + 0.5 / 12)) < 1e-3 for h in out if h.kind == "kick")  # swung off-16th


def test_a_drop_opening_on_a_gap_still_hits():
    from fvwks_fx.remix.flip import Hit, reprogram

    # bar 1: hats only (the kick and snare out for a low-end gap), then the full groove
    hits = [Hit("hats", k / 2, 0.5) for k in range(8)]
    hits += [Hit(v, 4 * b + x, 0.9) for b in range(1, 4) for v, x in (("kick", 0), ("snare", 2), ("kick", 2.5))]
    out = reprogram(hits, "dubstep140", start_bar=1, bars=4)
    assert any(h.kind == "kick" and h.beat == 0 for h in out)  # the drop's first beat has its kick


def test_riddim_drums_leave_space():
    from fvwks_fx.remix.flip import Hit, reprogram

    hits = [Hit(v, 4 * b + x, 0.9) for b in range(2) for v, x in (("kick", 0), ("snare", 2), ("hats", 1))]
    out = reprogram(hits, "riddim", start_bar=1, bars=2)
    bar1 = [(h.kind, h.beat) for h in out if h.beat < 4]
    assert ("kick", 2.0) in bar1 and ("snare", 2.0) in bar1  # the ghost kick under the snare
    assert len([h for h in out if h.kind == "hats" and h.beat < 4]) == 4  # offbeat 8ths, not a triplet carpet
    assert len([h for h in out if h.kind == "hats" and 7 <= h.beat < 8]) == 6  # bar 2's 1/16T roll on beat 4
