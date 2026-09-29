"""v0.10.1 bass-line intelligence on three synthetic 8-bar sections at 140 BPM: a deep held sub, a 1/8 dubstep wobble,
a gliding trap 808 over a half-time snare."""

import numpy as np
from scipy import signal

from fvwks_fx.bassline import BassFrames

SR, BPM = 22050, 140.0
BEAT = 60 / BPM
BAR = 4 * BEAT
SEC = 8 * BAR


def _tracks():
    n = int(3 * SEC * SR)
    t = np.arange(n) / SR
    bass, drums = np.zeros(n), np.zeros(n)
    rng = np.random.default_rng(3)
    # A: held subs, 4 beats each (45 / 41 Hz by bar)
    for k in range(8):
        a, b = int(k * BAR * SR), int((k + 1) * BAR * SR)
        env = np.minimum(1, np.minimum(np.arange(b - a) / 200, (b - a - np.arange(b - a)) / 200))
        bass[a:b] += 0.8 * env * np.sin(2 * np.pi * (45 if k % 2 == 0 else 41) * t[a:b])
    # B: a growl (a 55 Hz saw's 150-500 Hz band) wobbling on 1/8 notes, over a quieter sub
    a, b = int(SEC * SR), int(2 * SEC * SR)
    saw = signal.sawtooth(2 * np.pi * 55 * t[a:b])
    growl = signal.sosfilt(signal.butter(4, (150, 500), "band", fs=SR, output="sos"), saw)
    lfo = 0.5 + 0.5 * np.sin(2 * np.pi * (t[a:b] - t[a]) / (0.5 * BEAT))
    bass[a:b] += 1.5 * growl * lfo + 0.2 * np.sin(2 * np.pi * 55 * t[a:b])
    # C: an 808 every 2 beats that glides up 50 → 62 Hz, over a half-time snare (beat 3 only)
    for k in range(16):
        a = int((2 * SEC + k * 2 * BEAT) * SR)
        m = min(int(2 * BEAT * SR), n - a)
        tt = np.arange(m) / SR
        f = 50 + 12 * np.clip((tt - 0.25) / 0.15, 0, 1)
        bass[a : a + m] += 0.8 * np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / 1.5)
    for bar in range(24):
        for beat in (1, 3) if bar < 16 else (2,):  # snares on 2 and 4 (0-based 1, 3), then only on beat 3
            i = int((bar * BAR + beat * BEAT) * SR)
            drums[i : i + 2000] += signal.sosfilt(signal.butter(2, (200, 2000), "band", fs=SR, output="sos"), rng.standard_normal(2000)) * np.exp(-np.arange(2000) / 500)
    return bass[None, :].astype(np.float32), drums[None, :].astype(np.float32)


def test_bass_line_by_section():
    bass, drums = _tracks()
    frames = int(np.ceil(bass.shape[1] / SR * 60))
    bf = BassFrames(bass, SR, 60.0, frames)
    enc = bf.encode()
    assert enc.shape == (frames, 4) and enc.dtype == np.uint8
    mid = int(0.5 * BAR * 60)  # halfway through the first held note: on, a 45 Hz pitch (MIDI 29.8 → byte 60)
    assert enc[mid, 0] & 1 and abs(int(enc[mid, 3]) - 60) <= 2
    deep = bf.section(0, SEC, BEAT, drums, SR)
    wob = bf.section(SEC, 2 * SEC, BEAT, drums, SR)
    trap = bf.section(2 * SEC, 3 * SEC, BEAT, drums, SR)
    assert deep["bass_style"] == "deep" and 3 <= deep["note_beats"] <= 4.2 and not deep["half_time"]
    assert wob["wobble_div"] == "1/8" and wob["bass_style"] == "dubstep"
    assert trap["half_time"] and trap["bass_style"] == "trap" and 1.2 <= trap["note_beats"] <= 2.2
