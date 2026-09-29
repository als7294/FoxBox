"""Harmony: a known progression, synthesised, comes back bar by bar."""

import numpy as np

from fvwks_fx.harmony import chords, tones

SR = 22050
NOTE = {"A": 57, "F": 53, "C": 48, "G": 55, "D": 50, "E": 52}


def _progression(prog: list[tuple[str, str]], bpm: float = 120.0, reps: int = 2) -> dict[str, np.ndarray]:
    """Each chord a bar: its tones as sustained harmonic tones (the 'other' stem), its root an octave down in the bass."""
    bar = int(240 / bpm * SR)
    t = np.arange(bar) / SR
    other, bass = [], []
    for _ in range(reps):
        for root, q in prog:
            m = NOTE[root]
            ivs = (0, 3, 7) if q == "min" else (0, 4, 7)
            tone = sum(np.sin(2 * np.pi * 440 * 2 ** ((m + i + 12 * o - 69) / 12) * t) / (1 + o) for i in ivs for o in (0, 1))
            other.append(0.2 * tone)
            bass.append(0.5 * np.sin(2 * np.pi * 440 * 2 ** ((m - 12 - 69) / 12) * t))
    o, b = np.concatenate(other), np.concatenate(bass)
    return {"other": np.stack([o, o]), "bass": np.stack([b, b]), "vocals": np.zeros((2, o.size))}


def test_a_progression_comes_back():
    prog = [("A", "min"), ("F", "maj"), ("C", "maj"), ("G", "maj")]
    h = chords(_progression(prog), SR, 120.0, 0.0, key="Am")
    assert [c.name for c in h.bars] == ["Am", "F", "C", "G"] * 2
    assert tones(h.bars[0]) == (9, 0, 4) and h.at(99).name == "G"  # past the end: the last known chord


def test_tuning_and_tuned_chords():  # REMIX_HARMONY 6.1: a 432 Hz track reads -31.8 c, its chords still come back
    from fvwks_fx.song import AN_SR, _tuning

    t = np.arange(10 * AN_SR) / AN_SR
    x = sum(np.sin(2 * np.pi * 432 * 2 ** ((m - 69) / 12) * t) for m in (57, 60, 64))
    assert abs(_tuning(x.astype(np.float32)) + 31.8) < 1.0
    stems = _progression([("A", "min"), ("F", "maj")])
    assert [c.name for c in chords(stems, SR, 120.0, 0.0, key="Am", tuning_cents=0.0).bars] == ["Am", "F"] * 2


def test_the_bass_decides_the_roots_per_half_bar():  # REMIX_HARMONY 6.5: BASS DNA roots, a mid-bar move is root2
    st = _progression([("A", "min"), ("F", "maj")])
    bar = 2 * SR
    t = np.arange(bar // 2) / SR
    for b in (1, 3):  # the F bars' bass steps to G at beat 3
        st["bass"][:, b * bar + bar // 2 : (b + 1) * bar] = 0.5 * np.sin(2 * np.pi * 440 * 2 ** ((55 - 12 - 69) / 12) * t)
    h = chords(st, SR, 120.0, 0.0, key="Am")
    assert [c.root for c in h.bars] == [9, 5, 9, 5] and h.bars[1].root2 == 7 and h.bars[0].root2 is None
