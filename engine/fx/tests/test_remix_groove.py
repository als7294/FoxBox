"""1.6 BASS DNA: the groove of the bass-line test's three sections (held subs, a 1/8 wobble, gliding 808s), re-played
on the saw + sub and read back, and re-timed."""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from test_bassline import BPM, SR, _tracks  # noqa: E402

from fvwks_contracts.models import SongAnalysis  # noqa: E402
from fvwks_fx.remix.groove import curve, extract_groove, render_groove  # noqa: E402

A = SongAnalysis(bpm=BPM, downbeat_s=0.0)


def test_groove_extract_and_replay():
    bass, _ = _tracks()
    held = extract_groove(bass, SR, A, start_bar=1, bars=8)
    # on each 1: legato changes (no level rise) land within ~20 ms (FLUX_LAG_S), attacks within ~5
    assert len(held.notes) == 8 and all(abs(n.beat - 4 * k) < 0.05 for k, n in enumerate(held.notes))
    assert abs(held.notes[0].midi - 29.8) < 0.5 and abs(held.notes[1].midi - 28.2) < 0.5  # 45 / 41 Hz
    assert curve(held, "level").size == 8 * 4 * held.per_beat and not held.wobble

    wob = extract_groove(bass, SR, A, start_bar=9, bars=8)
    assert sum(w.div == "1/8" for w in wob.wobble) >= 6 and all(w.depth > 0.3 for w in wob.wobble)
    assert curve(wob, "growl").mean() > curve(held, "growl").mean() + 0.3
    # the LFO peaks every half beat from the section start (sin from 0: its peak a quarter period in)
    assert all(min(abs(w.phase - 0.75), 1 - abs(w.phase - 0.75)) < 0.15 for w in wob.wobble if w.div == "1/8")

    trap = extract_groove(bass, SR, A, start_bar=17, bars=8)
    slides = [n for n in trap.notes if n.bend]
    assert len(slides) >= 12 and all(n.glide_to - n.bend[0][1] > 3 for n in slides)  # 50 → 62 Hz: +3.7 st

    # re-played, the groove reads back the same; at another tempo, the notes move with the beat
    y = render_groove(held, SR)
    back = extract_groove(y, SR, A, start_bar=1, bars=8)
    assert [round(n.beat) for n in back.notes] == [round(n.beat) for n in held.notes]
    assert np.corrcoef(curve(held, "level"), curve(back, "level"))[0, 1] > 0.85  # the same bounce
    slow = render_groove(held, SR, bpm=BPM / 2)
    assert abs(slow.size - 2 * y.size) <= 2


def test_legato_pitch_changes_are_timed_by_the_pitch():
    # no gap and no level change between notes: the start is where the pitch crosses halfway (was a +25 ms guess)
    sr, bpm = 48000, 140.0
    beat = 60 / bpm
    t = np.arange(int(16 * beat * sr)) / sr
    f = np.where((t // (2 * beat)) % 2 == 0, 45.0, 55.0)
    x = (0.8 * np.sin(2 * np.pi * np.cumsum(f) / sr))[None].astype(np.float32)
    g = extract_groove(x, sr, SongAnalysis(bpm=bpm, downbeat_s=0.0), start_bar=1, bars=4)
    err = [abs(n.beat - round(n.beat / 2) * 2) * beat * 1000 for n in g.notes]
    assert len(g.notes) == 8 and max(err) < 10 and np.median(err) < 5


def test_wobble_shapes():
    from scipy import signal

    sr, bpm = 22050, 140.0
    beat = 60 / bpm
    t = np.arange(int(8 * 4 * beat * sr)) / sr
    growl = signal.sosfilt(signal.butter(4, (150, 500), "band", fs=sr, output="sos"), signal.sawtooth(2 * np.pi * 55 * t))
    ph = (t / (0.5 * beat)) % 1  # 1/8
    for want, lfo in (("sine", 0.5 + 0.5 * np.cos(2 * np.pi * ph)), ("square", (ph < 0.5) * 1.0), ("saw", 1 - ph)):
        x = (1.5 * growl * lfo + 0.2 * np.sin(2 * np.pi * 55 * t))[None].astype(np.float32)
        g = extract_groove(x, sr, SongAnalysis(bpm=bpm, downbeat_s=0.0), start_bar=1, bars=6)
        shapes = [w.shape for w in g.wobble if w.div == "1/8"]
        assert shapes and np.mean([s == want for s in shapes]) >= 0.8, (want, shapes)
