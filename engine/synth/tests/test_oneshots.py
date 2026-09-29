import numpy as np
import soundfile as sf

from fvwks_synth.oneshots import _by_name, scan

SR = 44100


def _t(s):
    return np.arange(int(s * SR)) / SR


def test_the_scanner_names_one_shots_and_leaves_loops_out(tmp_path):
    rng = np.random.default_rng(0)
    t = _t(0.4)
    kick = np.sin(2 * np.pi * np.cumsum(50 + 100 * np.exp(-t / 0.03)) / SR) * np.exp(-t / 0.08)
    hat = np.diff(np.diff(rng.standard_normal(int(0.08 * SR))), prepend=[0, 0]) * np.exp(-_t(0.08) / 0.015)
    swell = rng.standard_normal(SR) * np.linspace(0, 1, SR) ** 2
    loop = np.tile(np.pad(kick, (0, int(0.1 * SR))), 10)  # 5 s: not a one-shot
    two = np.concatenate([kick, np.zeros(int(0.2 * SR)), kick])  # two hits
    files = {"Big Kick 01.wav": hat, "snr_tight.wav": hat, "OH open.wav": hat, "Clap-Room.aiff": hat,
             "AnvilHit.flac": hat, "a1.wav": kick, "a2.wav": hat, "a3.wav": swell, "loop.wav": loop, "twohits.wav": two}
    sub = tmp_path / "Pack" / "Drums"
    sub.mkdir(parents=True)
    for name, x in files.items():
        sf.write(sub / name, (0.8 * x / np.abs(x).max()).astype(np.float32), SR)
    (sub / "notes.txt").write_text("not audio")
    (sub / "fake.wav").write_text("not audio either")
    got = {s.name: s.role for s in scan(tmp_path / "Pack")}
    assert got == {"Big Kick 01": "kick", "snr_tight": "snare", "OH open": "open_hat", "Clap-Room": "clap",
                   "AnvilHit": "perc", "a1": "kick", "a2": "hat", "a3": "reverse"}, got  # the name first, then the sound
    assert _by_name("SD_Crack") == "snare" and _by_name("808 Snare Hit") == "snare" and _by_name("CrashReverse") == "reverse"
    assert _by_name("BD909") == "kick" and _by_name("ride_bell") == "cymbal" and _by_name("Loop 128bpm") is None
