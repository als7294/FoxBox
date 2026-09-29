"""REMIX_HARMONY 4.2: the kit in the key (kick, snare, perc), the kick's tail under another root, round-robin, velocity."""

from __future__ import annotations

import numpy as np
from scipy import signal

from fvwks_synth.kit import _velocity, key_tonic, kick_tuning, render_kit, snare_tuning

SR = 48_000


def _hz(x: np.ndarray, t0: float, t1: float) -> float:
    """The low body's frequency from its rising zero crossings (interpolated) between t0 and t1 s."""
    y = signal.sosfiltfilt(signal.butter(4, 150, "lowpass", fs=SR, output="sos"), x)[int(t0 * SR) : int(t1 * SR)]
    i = np.flatnonzero((y[:-1] < 0) & (y[1:] >= 0))
    z = i + y[i] / (y[i] - y[i + 1])
    return SR / float(np.mean(np.diff(z)))


def test_kit_plays_in_the_key():
    assert [key_tonic(k) for k in ("Am", "F#", "Bbm", "C# minor", "8A", "8B", "?")] == \
        [(9, True), (6, False), (10, True), (1, True), (9, True), (0, False), None]
    for pc, hz in ((4, 41.2), (6, 46.2), (9, 55.0), (11, 61.7), (0, 49.0), (2, 55.0)):  # E F# A B; C -> G1, D -> A1
        assert abs(kick_tuning(pc)[0] - hz) < 0.1
    for pc, hz in ((5, 174.6), (4, 164.8), (7, 196.0), (2, 220.0)):
        assert abs(snare_tuning(pc) - hz) < 0.1
    # The kick ends on F#1 in F# minor (it was 52 Hz in every key), and the source's tuning moves it.
    kick = [{"beat": 0, "voice": "kick", "vel": 1}]
    for cents in (0, -31.7):
        x = render_kit("foxbox", kick, bpm=120, beats=1, sr=SR, key="F#m", tuning_cents=cents).mean(0)
        assert abs(1200 * np.log2(_hz(x, 0.12, 0.26) / (46.25 * 2 ** (cents / 1200)))) < 25  # +-15 c hit jitter
    # A TR-808 kit's kick (G1 +21 c, kits.json) is repitched onto the key's: F#1 in F# minor, A1 in A.
    for key, hz in (("F#m", 46.25), ("A", 55.0)):
        x = render_kit("tr808-punch", kick, bpm=120, beats=1, sr=SR, key=key).mean(0)
        assert abs(1200 * np.log2(_hz(x, 0.1, 0.4) / hz)) < 20, (key, _hz(x, 0.1, 0.4))
    # Under another root (bar 2: D) the kick is 30 dB down by 150 ms; on its own root it rings on.
    hits = [{"beat": 0, "voice": "kick", "vel": 1}, {"beat": 4, "voice": "kick", "vel": 1}]
    for kit in ("foxbox", "tr808-punch"):
        x = render_kit(kit, hits, bpm=120, beats=8, sr=SR, key="F#m", roots=[(0, 6), (4, 2)]).mean(0)
        for beat, gated in ((0, False), (4, True)):
            a = beat * SR // 2
            late = np.abs(x[a + int(0.15 * SR) : a + int(0.2 * SR)]).max() / np.abs(x[a : a + int(0.15 * SR)]).max()
            assert (late <= 10 ** (-30 / 20)) == gated, (kit, beat, 20 * np.log10(late))


def test_round_robin_and_velocity():
    shape = lambda y: y / np.abs(y).max()  # noqa: E731 (the level jitters +-0.5 dB per hit)
    for voice, cycle in (("snare", 5), ("hats", 7)):
        hits = [{"beat": 4 * b, "voice": voice, "vel": 1} for b in range(cycle + 1)]  # 2 s apart: the clap's room is gone
        x = render_kit("foxbox", hits, bpm=120, beats=4 * (cycle + 1), sr=SR, key="Fm").mean(0)
        seg = [shape(x[2 * b * SR : 2 * b * SR + SR // 10]) for b in range(cycle + 1)]
        assert all(not np.allclose(seg[b], seg[b + 1], atol=1e-3) for b in range(cycle))  # never the same twice running
        assert np.allclose(seg[0], seg[cycle], atol=1e-3)  # the cycle comes round
    # +1.5 dB above 3 kHz per +0.25 of velocity; the lows untouched.
    noise = np.random.default_rng(0).standard_normal((2, SR)).astype(np.float32)
    band = lambda y, lo, hi: 10 * np.log10(np.mean(signal.sosfiltfilt(signal.butter(4, (lo, hi), "bandpass", fs=SR, output="sos"), y[0]) ** 2))  # noqa: E731
    soft = _velocity(noise, 0.75, SR)
    assert abs(band(soft, 6000, 12000) - band(noise, 6000, 12000) + 1.5) < 0.3
    assert abs(band(soft, 100, 1000) - band(noise, 100, 1000)) < 0.1
