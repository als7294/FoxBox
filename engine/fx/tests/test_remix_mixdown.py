"""1.6 MIXDOWN: clips land on the grid, mute and solo hold, the length is exact, a mashup's B section meets A's level."""

import numpy as np

from fvwks_contracts.models import Master, Remix, RemixLane
from fvwks_fx.master import integrated_lufs
from fvwks_fx.remix.mixdown import _match_b, mixdown

SR = 48000


def _remix(lanes) -> Remix:
    return Remix(id="r", name="r", recipe="mashup", sources=[{"slot": "A", "song_id": "a"}], bpm=120, created_at="",
                 updated_at="", lanes=lanes, sections=[
                     {"kind": "drop", "start_bar": 1, "bars": 2}, {"kind": "drop", "start_bar": 3, "bars": 2, "from_slot": "B"}])


def _clip(cid: str, at: float) -> dict:
    return {"id": cid, "at_beat": at, "beats": 8, "src": {"kind": "stem", "slot": "A", "stem": "other", "start_beat": 0}}


def test_mixdown():
    t = np.arange(4 * SR) / SR
    tone = lambda f, g: np.stack([g * np.sin(2 * np.pi * f * t)] * 2).astype(np.float32)
    lanes = [RemixLane(id="a", role="other", clips=[_clip("a1", 0)]), RemixLane(id="b", role="other", clips=[_clip("b1", 8)]),
             RemixLane(id="m", role="drums", mute=True, clips=[_clip("m1", 0)])]
    audio = {"a1": tone(440, 0.5), "b1": tone(660, 0.3), "m1": tone(1000, 0.9)}  # B ~4 dB down (the match is capped at 6)
    y, _ = mixdown(_remix(lanes), audio, SR, Master(sample_rate=48000))
    assert y.shape == (2, 8 * SR)  # 4 bars at 120 BPM
    spec = np.abs(np.fft.rfft(y[0, : 4 * SR]))
    assert spec[4 * 1000] < 0.01 * spec[4 * 440]  # the muted lane is out
    raw = np.zeros((2, 8 * SR), np.float32)
    raw[:, : 4 * SR] += audio["a1"]
    raw[:, 4 * SR :] += audio["b1"]
    _match_b(_remix(lanes), raw, SR)
    assert abs(integrated_lufs(raw[:, 4 * SR :], SR) - integrated_lufs(raw[:, : 4 * SR], SR)) < 1.5  # B up to A's level
