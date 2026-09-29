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
    assert bar1 == [0.0, 1.0, 1.333, 2.25, 2.667, 3.333]  # a call, 1/8T repeats, a response off the snare's 1/16
    assert all(round(m) % 12 in (9, 0) for m, b, _ in hits if b < 4)  # on the root (A), the response's third (C)
    sub = sub_line(hits, BPM, SR, bus.shape[1])
    spec = np.abs(np.fft.rfft(sub))
    f0 = np.fft.rfftfreq(sub.size, 1 / SR)[np.argmax(spec)]
    assert 28 <= f0 < 56  # the sub octave
    out = drop_chain(bus, SR)
    assert np.isfinite(out).all()
    low = lambda x: np.abs(np.fft.rfft(x.mean(0)))[: int(60 * x.shape[1] / SR)].sum()
    assert low(out) < 0.1 * low(bus)  # hi-passed: the sub owns the low end
