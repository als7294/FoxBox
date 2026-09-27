"""LAYERS: STACK time alignment (segment-linear, or word by word when both segments carry the same words)."""

import numpy as np
import pytest

from fvwks_fx.modules import layers as L

FP_MS = 5.0
FP = FP_MS / 1000.0


def _seg(start, end, words):
    return {"start_s": start, "end_s": end,
            "words": [{"text": t, "start_s": a, "end_s": b} for t, a, b in words]}


PRIMARY = _seg(0.0, 1.2, [("We", 0.02, 0.2), ("are", 0.2, 0.5), ("Fawkes.", 0.5, 1.15)])
STACK = _seg(0.0, 1.5, [("we", 0.02, 0.5), ("are", 0.5, 0.7), ("Fawkes", 0.7, 1.45)])  # slow 'we', quick 'are'


def _map(primary, stack, n_frames=400, n_src=400):
    return L.align_frame_map(n_frames, FP_MS, L.spans_of([primary]), L.spans_of([stack]), n_src)


def _linear(primary, stack, n_frames=400):
    p0, p1 = round(primary["start_s"] / FP), round(primary["end_s"] / FP)
    j = np.arange(p0, p1)
    return j, stack["start_s"] / FP + (j - p0) * (stack["end_s"] - stack["start_s"]) / FP / (p1 - p0)


def test_word_boundaries_line_up():
    # Regression (S1 review): the segment-linear map left word boundaries of Kokoro stack voices a median 66 ms
    # (up to 165 ms) away from the primary's.
    idx = _map(PRIMARY, STACK)
    for tp, ts in ((0.2, 0.5), (0.5, 0.7)):  # primary gap middle -> stack gap middle
        assert idx[round(tp / FP)] * FP == pytest.approx(ts, abs=1e-9)
    assert idx[0] == pytest.approx(0.0) and idx[round(1.2 / FP) - 1] * FP == pytest.approx(1.5, abs=0.02)
    assert np.all(np.diff(idx[: round(1.2 / FP)]) > 0)  # monotonic: never plays a word backwards
    assert np.all(idx[round(1.2 / FP):] == -1)  # silence outside the segment


@pytest.mark.parametrize("stack", [
    _seg(0.0, 1.5, [("we", 0.02, 0.5), ("were", 0.5, 0.6), ("Fawkes", 0.6, 1.45)]),  # different words
    _seg(0.0, 1.5, [("we", 0.02, 0.5), ("Fawkes", 0.5, 1.45)]),  # different word count
    _seg(0.0, 1.5, []),  # no word timings (recordings, Qwen3 personas, pre-v0.1)
    _seg(0.0, 1.5, [("we", 0.02, 1.2), ("are", 1.2, 1.25), ("Fawkes", 1.25, 1.45)]),  # warps > 3x: bad timings
    _seg(0.0, 1.5, [("we", 0.02, 0.7), ("are", 0.6, 0.5), ("Fawkes", 0.5, 1.45)]),  # non-increasing boundaries
])
def test_falls_back_to_the_linear_map(stack):
    idx = _map(PRIMARY, stack)
    j, lin = _linear(PRIMARY, stack)
    np.testing.assert_allclose(idx[j], lin, atol=1e-9)


def test_identical_segments_map_to_themselves():
    idx = _map(PRIMARY, PRIMARY)
    j = np.arange(round(1.2 / FP))
    np.testing.assert_allclose(idx[j], j, atol=1e-9)
