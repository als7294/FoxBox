"""v0.7 songs: ``analyze_song`` on synthetic tracks with a known tempo, bar phase and key, and ``mix_song``'s
placement, duck, true-peak ceiling and excerpts."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

from fvwks_contracts.models import Master, SongPlacement
from fvwks_fx import api
from fvwks_fx.master import true_peak
from fvwks_fx.song import duck_gain

sys.path.insert(0, str(Path(__file__).parent))
from songsynth import SR, song  # noqa: E402

TEMPOS = [90, 128, 174]


@pytest.mark.parametrize("bpm", TEMPOS)
def test_tempo_downbeat_and_minor_key(bpm):
    # the music starts on a pickup beat: bar 1 is the next beat, not the first sound
    down = 1.0 + 60.0 / bpm
    a = api.analyze_song(song(bpm, down, key="Am", seed=bpm), SR)
    assert abs(a.bpm - bpm) <= 0.5
    assert abs(a.downbeat_s - down) <= 0.020
    assert (a.key, a.camelot) == ("Am", "8A")
    assert a.beats_per_bar == 4 and a.bpm_confidence > 0.5


# --------------------------------------------------------------------------- mix


def _master(sr: int = SR, tp: float = -1.0) -> Master:
    return Master(sample_rate=sr, channels=2, true_peak_db=tp)


def _place(**kw) -> SongPlacement:
    return SongPlacement(song_id="song", **kw)


def _mix(song_x, drop_x, *, drop_start_s, excerpt_s=None, placement=None, master=None, drop_sr=SR):
    return api.mix_song(song_x, SR, drop_x, drop_sr, drop_start_s=drop_start_s, bpm=120.0,
                        placement=placement or _place(duck_db=0.0), excerpt_s=excerpt_s, master=master or _master(),
                        quality="preview")


def test_drop_placement_is_sample_exact():
    silent = np.zeros((2, SR * 10), np.float32)
    drop = np.zeros((2, SR), np.float32)
    drop[:, 0] = 0.5
    at = 2.345678
    out = _mix(silent, drop, drop_start_s=at)
    assert int(np.argmax(np.abs(out.audio[0]))) == round(at * SR)
    assert abs(out.drop_start_s - at) < 1.0 / SR and out.start_s == 0.0
    cut = _mix(silent, drop, drop_start_s=at, excerpt_s=(1.0, 6.0))
    assert int(np.argmax(np.abs(cut.audio[0]))) == round(at * SR) - SR
    assert abs(cut.drop_start_s - (at - 1.0)) < 1.0 / SR and cut.start_s == 1.0
    assert cut.audio.shape == (2, 5 * SR) and np.all(cut.audio[:, [0, -1]] == 0.0)  # 5 ms edge fades
    # a 48 kHz drop lands on the same instant (within a sample) after resampling
    d48 = np.zeros((2, 48000), np.float32)
    d48[:, 4800] = 0.5  # 100 ms in
    out48 = _mix(silent, d48, drop_start_s=at, drop_sr=48000)
    assert abs(int(np.argmax(np.abs(out48.audio[0]))) - round((at + 0.1) * SR)) <= 1


def test_song_ducks_under_the_drop_and_comes_back():
    n = SR * 10
    t = np.arange(n) / SR
    tone = (0.1 * np.sin(2 * np.pi * 1000 * t)).astype(np.float32)  # -20 dBFS peak
    song_x = np.stack([tone, tone])
    rng = np.random.default_rng(0)
    drop = np.zeros((2, SR * 2), np.float32)
    drop[:] = 0.1 * rng.standard_normal(SR * 2).astype(np.float32)
    out = _mix(song_x, drop, drop_start_s=4.0, placement=_place(duck_db=-9.0))
    placed = np.zeros_like(out.audio)
    placed[:, 4 * SR : 6 * SR] = drop
    ducked = (out.audio - placed)[0]
    lvl = lambda a, b: 20 * np.log10(np.sqrt(np.mean(ducked[int(a * SR) : int(b * SR)] ** 2)))
    assert abs(lvl(4.5, 5.5) - lvl(1.0, 2.0) + 9.0) < 0.3  # full depth while the drop plays
    assert abs(lvl(7.5, 8.5) - lvl(1.0, 2.0)) < 0.1  # back to unity after it
    g = duck_gain(placed, SR, -9.0, 120.0)
    assert g[int(4.05 * SR)] < 10 ** (-8.0 / 20)  # ~10 ms attack
    assert 10 ** (-8.0 / 20) < g[int(6.6 * SR)] and g[int(7.5 * SR)] > 0.99  # a beat-friendly release


def test_true_peak_ceiling_and_warnings():
    n = SR * 6
    t = np.arange(n) / SR
    loud = np.stack([0.98 * np.sign(np.sin(2 * np.pi * 110 * t))] * 2).astype(np.float32)  # a hot, clipped master
    rng = np.random.default_rng(1)
    drop = np.clip(0.7 * rng.standard_normal((2, SR * 2)), -1, 1).astype(np.float32)
    out = _mix(loud, drop, drop_start_s=2.0, placement=_place(duck_db=-3.0, song_gain_db=3.0, drop_gain_db=6.0),
               master=_master(tp=-1.0))
    assert true_peak(out.audio, SR) <= -1.0 + 1e-3
    assert out.loudness is not None and out.loudness.true_peak_db <= -1.0 + 1e-3
    assert np.all(np.isfinite(out.audio))
    past = _mix(loud, drop, drop_start_s=5.0)
    assert past.audio.shape[1] == 7 * SR and any("past the song's end" in w for w in past.warnings)  # never cut


def test_chroma_is_flat_for_pink_noise():
    # broadband sound must not lean toward any pitch class (the old per-bin sum ramped 0.77 -> 1.24 from C to B)
    from fvwks_fx.song import AN_SR, _chroma

    rng = np.random.default_rng(0)
    spec = np.fft.rfft(rng.standard_normal(AN_SR * 8))
    spec[1:] /= np.sqrt(np.arange(1, spec.size))  # 1/f power
    ch, _ = _chroma(np.fft.irfft(spec).astype(np.float32), 0.05)
    prof = ch.mean(axis=0) * 12
    assert prof.max() / prof.min() < 1.15


@pytest.mark.parametrize("rate", [44100, 48000])
def test_key_at_either_sample_rate(rate):
    # the key must not depend on the file's rate (a rate mix-up reads ~1.5 semitones off)
    from scipy import signal

    x = song(140, 1.0, key="D#m", seed=5)
    if rate != SR:
        x = signal.resample_poly(x, rate, SR, axis=1).astype(np.float32)
    a = api.analyze_song(x, rate)
    assert (a.key, a.camelot) == ("Ebm", "2A")  # D#m, spelled as the engine names keys
