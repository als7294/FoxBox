"""v0.10 song_structure on a synthetic bass-music arrangement: sections tile the song, drops land on their bar lines,
builds lead into them."""

import base64

import numpy as np

from fvwks_contracts.models import SongAnalysis
from fvwks_fx import api

SR, BPM = 22050, 140.0
BEAT = 60 / BPM
BAR = 4 * BEAT
# bars (1-based, inclusive): intro 1-8 hats, build 9-16 riser + snare roll, drop 17-32 kick + sub, breakdown 33-40
# pads, build 41-48, drop 49-64, outro 65-72 hats
LAYOUT = [("intro", 1, 8), ("build", 9, 16), ("drop", 17, 32), ("breakdown", 33, 40), ("build", 41, 48), ("drop", 49, 64), ("outro", 65, 72)]


def _song() -> np.ndarray:
    rng = np.random.default_rng(1)
    n = int(72 * BAR * SR)
    x = np.zeros(n)
    t = np.arange(n) / SR

    def at(bar: int, beat: float = 0.0) -> int:
        return int(((bar - 1) * BAR + beat * BEAT) * SR)

    def add(i: int, y: np.ndarray) -> None:
        j = min(n, i + y.size)
        x[i:j] += y[: j - i]

    hat = np.diff(rng.standard_normal(801)) * np.exp(-np.arange(800) / 150) * 0.05
    kick = np.sin(2 * np.pi * np.cumsum(45 + 120 * np.exp(-np.arange(4000) / 300)) / SR) * np.exp(-np.arange(4000) / 1500)
    for kind, a, b in LAYOUT:
        for bar in range(a, b + 1):
            for k in range(8):
                if kind != "breakdown":
                    add(at(bar, k / 2), hat)
            if kind == "drop":
                for k in range(4):
                    add(at(bar, k), 0.9 * kick)
                seg = slice(at(bar), at(bar + 1))
                x[seg] += 0.5 * np.sin(2 * np.pi * 50 * t[seg])
            elif kind == "build":
                p = (bar - a + 1) / (b - a + 1)  # a riser and a snare roll that speed up
                seg = slice(at(bar), at(bar + 1))
                x[seg] += 0.08 * p * rng.standard_normal(seg.stop - seg.start)
                for k in range(int(4 * 2 ** int(3 * p))):
                    add(at(bar, 4 * k / int(4 * 2 ** int(3 * p))), 0.2 * np.diff(rng.standard_normal(1201)) * np.exp(-np.arange(1200) / 300))
            elif kind == "breakdown":
                seg = slice(at(bar), at(bar + 1))
                x[seg] += 0.1 * (np.sin(2 * np.pi * 440 * t[seg]) + np.sin(2 * np.pi * 523 * t[seg]))
    return (x / np.abs(x).max()).astype(np.float32)[None, :]


def test_song_structure_on_a_synthetic_arrangement():
    x = _song()
    s = api.song_structure(x, SR, SongAnalysis(bpm=BPM, downbeat_s=0.0))
    kinds = [c.kind for c in s.sections]
    assert kinds[0] == "intro" and kinds[-1] == "outro" and kinds.count("drop") == 2
    assert s.sections[0].start_s == 0 and abs(s.sections[-1].end_s - x.shape[1] / SR) < 1e-3
    assert all(abs(a.end_s - b.start_s) < 1e-6 for a, b in zip(s.sections, s.sections[1:]))  # tiled, no gaps
    assert [c.start_bar for c in s.sections if c.kind == "drop"] == [17, 49]
    assert np.allclose(s.drops_s, [16 * BAR, 48 * BAR], atol=0.02)  # the hits: the drops' bar lines
    assert [round(d, 2) for _, d in s.builds] == [round(v, 2) for v in s.drops_s]  # each build leads into its drop
    assert all(b < d for b, d in s.builds)
    assert len(base64.b64decode(s.energy_b64)) == int(np.ceil(x.shape[1] / SR * s.energy_fps))
    drop_e = [c.energy for c in s.sections if c.kind == "drop"]
    assert min(drop_e) > max(c.energy for c in s.sections if c.kind in ("intro", "breakdown", "outro"))
