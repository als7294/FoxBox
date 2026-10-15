"""Songs: ``analyze_song`` on synthetic tracks with a known tempo, bar phase and key."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

from fvwks_fx import api

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
