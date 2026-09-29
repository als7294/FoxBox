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


def test_contrast_lifts_a_squeezed_drop_and_caps_the_rest():  # every drop lands on the master's target
    from fvwks_fx.master import short_term_max
    from fvwks_fx.remix.mixdown import BUILD_LU, _contrast

    bar = 2 * SR  # 120 BPM
    r = Remix(id="r", name="r", recipe="vip", sources=[{"slot": "A", "song_id": "a"}], bpm=120, created_at="", updated_at="",
              sections=[{"kind": "drop", "start_bar": 1, "bars": 4}, {"kind": "verse", "start_bar": 5, "bars": 4},
                        {"kind": "drop", "start_bar": 9, "bars": 4}])
    t = np.arange(4 * bar) / SR
    tone = lambda g: np.stack([g * np.sin(2 * np.pi * 220 * t)] * 2).astype(np.float32)  # noqa: E731
    y = np.concatenate([tone(0.5), tone(0.7), tone(0.4)], axis=1)  # the verse outshouts both drops; drop 2 is 1.9 dB under
    _contrast(r, y, SR)
    d1, v, d2 = (short_term_max(y[:, k * 4 * bar : (k + 1) * 4 * bar], SR) for k in range(3))
    tail = short_term_max(y[:, 6 * bar : 8 * bar], SR)  # the verse (it leads into drop 2) past its first bar's ease
    assert abs(d2 - d1) < 0.2 and v <= d1 + 0.1 and abs(tail - (d2 + BUILD_LU)) < 1.0, (d1, v, d2, tail)
