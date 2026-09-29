import numpy as np
from scipy import signal

from fvwks_synth import layers
from fvwks_synth.kit import _foxbox, render_kit

SR = 48_000


def test_a_sample_layer_lands_on_the_synth_transient_and_leaves_it_the_sub(monkeypatch):
    t = np.arange(int(0.3 * SR)) / SR
    synth = (np.sin(2 * np.pi * 50 * t) * np.exp(-t / 0.1)).astype(np.float32)
    synth[int(0.005 * SR)] += 1.5  # its transient at 5 ms
    on = t >= 0.020  # a one-shot: silent, then its transient 15 ms later than the synth's, and a sub it mustn't bring
    sample = np.where(on, 0.8 * np.sin(2 * np.pi * 50 * (t - 0.02)) * np.exp(-(t - 0.02) / 0.1), 0.0)
    sample[int(0.020 * SR)] += 2.0
    monkeypatch.setattr(layers, "pick", lambda voice, seed, sr: sample.copy())
    alone = layers.layer(synth, "kick", SR, 0, "sample")
    assert abs(int(np.argmax(np.abs(alone))) - int(0.005 * SR)) <= int(0.0005 * SR)  # no flam: peak on peak
    both = layers.layer(synth, "kick", SR, 0, "both")
    added = both - synth  # the synth is left as it was: this is the sample layer
    assert both.shape == synth.shape and np.abs(added).max() > 0.01
    low = lambda y: np.sqrt(np.mean(signal.sosfiltfilt(signal.butter(4, 70, "lowpass", fs=SR, output="sos"), y) ** 2))  # noqa: E731
    assert low(added) < 0.05 * low(synth)  # high-passed: the synth kick keeps the sub
    assert abs(int(np.argmax(np.abs(added))) - int(0.005 * SR)) <= int(0.001 * SR)  # its crack on the synth's
    assert np.array_equal(layers.layer(synth, "kick", SR, 0, "synth"), synth)


def test_the_bundle_layers_every_role_and_the_kit_keeps_its_chokes():
    roles = {e["role"] for e in layers.manifest()}
    assert {"kick", "snare", "clap", "hat", "open_hat", "perc", "impact", "cymbal"} <= roles
    assert all(e["license"] == "CC0-1.0" and e["ai_generated"] is False and e["source_url"] for e in layers.manifest())
    for voice in ("kick", "snare", "clap", "hats", "open_hat", "perc"):
        x = _foxbox(voice, SR)
        y = layers.layer(x, voice, SR, 3, "both")
        assert y.shape == x.shape and np.isfinite(y).all() and not np.array_equal(x, y), voice
    hits = [{"beat": 0, "voice": "open_hat"}, {"beat": 0.5, "voice": "hats"}]  # the closed hat chokes the open one
    y = render_kit("foxbox", hits, bpm=120, beats=1, sr=SR, layer="both", seed=3)[0]
    cut = int(0.25 * SR)  # beat 0.5 at 120 BPM
    assert np.abs(y[cut - int(0.002 * SR):cut]).max() < 0.2 * np.abs(y[:cut]).max()  # faded out into the choke
