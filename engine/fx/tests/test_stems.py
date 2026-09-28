"""v0.9 stem_features: shape and encoding, hits on the drums' clicks (snapped to the grid), a silent stem stays 0."""

import numpy as np

from fvwks_contracts.models import SongAnalysis
from fvwks_fx import api


def test_stem_features_shape_hits_and_silence():
    sr, secs, bpm = 48000, 8.0, 120.0
    n = int(sr * secs)
    t = np.arange(n) / sr
    drums = np.zeros(n, np.float32)
    beats = np.arange(0.5, secs, 60 / bpm)
    for b in beats:  # a click 8 ms late on every beat: snapping puts it back on the grid
        i = int((b + 0.008) * sr)
        drums[i : i + 400] += np.exp(-np.arange(400) / 60.0) * np.random.default_rng(int(b * 10)).standard_normal(400)
    bass = (0.5 * np.sin(2 * np.pi * 55 * t) * (t > 4)).astype(np.float32)
    stems = {"drums": drums[None, :], "bass": bass[None, :], "vocals": np.zeros((1, n), np.float32)}
    mix = (drums + bass)[None, :]
    out = api.stem_features(stems, sr, mix, analysis=SongAnalysis(bpm=bpm, downbeat_s=0.5))
    assert out.fps == 60.0 and out.tracks == ["drums", "bass", "vocals", "other", "mix"]
    assert out.data.dtype == np.uint8 and out.data.shape == (int(np.ceil(n / 800)), 5, 2)
    hits = np.nonzero(out.data[:, 0, 1] >= 64)[0]
    assert set(np.round(beats * 60).astype(int)) <= set(hits)  # every beat is a drum hit, on its grid frame
    assert out.data[:, 1, 0].max() == 255 and out.data[: int(3.5 * 60), 1, 0].max() == 0  # bass: in from 4 s
    assert not out.data[:, 2].any() and not out.data[:, 3].any()  # silent vocals, absent other
