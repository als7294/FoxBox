"""1.6 PREPARE: clips come out exactly clip.beats long at the remix tempo; a stem stretches and shifts in one pass."""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from test_bassline import SR, _tracks  # noqa: E402

from fvwks_contracts.models import Remix, RemixClip  # noqa: E402
from fvwks_fx.remix.prepare import SourceAudio, prepare_clip  # noqa: E402

REMIX = Remix(id="r", name="r", recipe="vip", sources=[{"slot": "A", "song_id": "a"}], bpm=150.0, created_at="",
              updated_at="")


def _f0(x: np.ndarray, sr: int) -> float:
    spec = np.abs(np.fft.rfft(x[0] * np.hanning(x.shape[1])))
    return float(np.fft.rfftfreq(x.shape[1], 1 / sr)[np.argmax(spec)])


def test_stem_groove_and_kit_clips():
    t = np.arange(SR * 20) / SR
    tone = (0.5 * np.sin(2 * np.pi * 220 * t))[None].astype(np.float32)  # a 120 BPM source: 220 Hz
    src = {"A": SourceAudio(bpm=120.0, downbeat_s=0.5, stems={"other": tone, "bass": _tracks()[0]}, sr=SR)}
    clip = RemixClip(id="c", at_beat=0, beats=8, src={"kind": "stem", "slot": "A", "stem": "other", "start_beat": 4},
                     shift_st=2, fade_in_beats=1)
    y = prepare_clip(clip, REMIX, src, SR)
    assert y.shape == (2, round(8 * 60 / 150 * SR))  # 8 beats at 150 BPM: 3.2 s
    assert abs(_f0(y[:, SR // 2 :], SR) - 220 * 2 ** (2 / 12)) < 3  # +2 semitones, tempo changed independently
    assert np.abs(y[:, :50]).max() < 0.05 < np.abs(y[:, -SR // 4 :]).max()  # faded in
    groove = RemixClip(id="g", at_beat=0, beats=16, src={"kind": "groove", "slot": "A", "start_bar": 1, "bars": 4,
                                                          "patch_id": "default"})
    g = prepare_clip(groove, REMIX.model_copy(update={"bpm": 140.0}), src, SR)
    assert g.shape[1] == round(16 * 60 / 140 * SR) and np.abs(g).max() > 0.1
    kit = RemixClip(id="k", at_beat=0, beats=4, src={"kind": "kit", "kit_id": "foxbox", "hits": [
        {"beat": 0, "voice": "kick", "vel": 1}, {"beat": 2, "voice": "snare", "vel": 0.8}, {"beat": 1.5, "voice": "hats", "vel": 0.5}]})
    k = prepare_clip(kit, REMIX, src, SR)
    beat = int(60 / 150 * SR)
    rms = lambda a, b: float(np.sqrt((k[0, a:b] ** 2).mean()))
    # any kit (S1's sampler or the fallback): a hit on 1, and the snare's rise on beat 3
    assert np.abs(k).max() < 1.5 and rms(0, beat // 8) > 0.1
    assert rms(2 * beat, 2 * beat + beat // 8) > 1.5 * rms(2 * beat - beat // 8, 2 * beat)

    loop = RemixClip(id="l", at_beat=0, beats=8, src={"kind": "kit", "kit_id": "foxbox", "pattern_id": "fourfloor"})
    assert prepare_clip(loop, REMIX, src, SR).shape[1] == round(8 * 60 / 150 * SR)  # a library loop, no hits


def test_groove_clips_play_their_own_bars():
    # held notes a semitone up each bar (bar b = MIDI 30 + b): bars 5-7 must come back as 35, 36, 37 (was one bar late)
    from fvwks_contracts.models import SongAnalysis
    from fvwks_fx.remix.groove import extract_groove

    bar = 240 / 120
    t = np.arange(int(10 * bar * SR)) / SR
    midi = 30 + 1 + np.floor(t / bar)
    x = (0.8 * np.sin(2 * np.pi * np.cumsum(440 * 2 ** ((midi - 69) / 12)) / SR))[None].astype(np.float32)
    src = {"A": SourceAudio(bpm=120.0, downbeat_s=0.0, stems={"bass": x}, sr=SR)}
    clip = RemixClip(id="g", at_beat=0, beats=12, src={"kind": "groove", "slot": "A", "start_bar": 5, "bars": 3,
                                                        "patch_id": "no-such-patch"})
    y = prepare_clip(clip, REMIX.model_copy(update={"bpm": 120.0}), src, SR)
    notes = extract_groove(y, SR, SongAnalysis(bpm=120.0, downbeat_s=0.0), start_bar=1, bars=3).notes
    # the notes' pitch classes, a semitone apart, from beat 0 (the clean sub may sit an octave under the note)
    assert [round(n.midi) % 12 for n in notes] == [11, 0, 1] and notes[0].beat < 0.1


def test_engine_bass_paths_and_seeds():
    bass, drums = _tracks()  # 140 BPM
    src = {"A": SourceAudio(bpm=140.0, downbeat_s=0.0, stems={"bass": bass, "drums": drums}, sr=SR)}
    rmx = REMIX.model_copy(update={"bpm": 140.0, "seed": 3})
    clip = lambda pid, beats=8, start=9: RemixClip(id=f"c-{pid}", at_beat=0, beats=beats, src={
        "kind": "groove", "slot": "A", "start_bar": start, "bars": int(np.ceil(beats / 4)), "patch_id": pid})
    # the dark first hit: at the root, no glide in from above (the user heard a whiny first hit)
    y = prepare_clip(clip("808:dark", beats=2, start=1), rmx, src, SR)
    t = int(0.05 * SR)
    seg = y[0, t : t + SR // 4]
    f0 = SR / np.mean(np.diff(np.flatnonzero((seg[:-1] < 0) & (seg[1:] >= 0))))
    assert 32.0 <= f0 <= 66.0  # the root in C1-B1, settled by 50 ms
    a = prepare_clip(clip("hybrid:tearout"), rmx, src, SR)
    b = prepare_clip(clip("hybrid:tearout"), rmx, src, SR)
    c = prepare_clip(clip("hybrid:tearout"), rmx.model_copy(update={"seed": 4}), src, SR)
    assert np.array_equal(a, b) and not np.array_equal(a, c)  # the same seed, the same take; a new seed, a new one
    for pid in ("resample:trap_hybrid", "riddim:wub"):
        y = prepare_clip(clip(pid), rmx, src, SR)
        assert y.shape == (2, round(8 * 60 / 140 * SR)) and np.isfinite(y).all() and np.abs(y).max() > 0.01
    kit = RemixClip(id="k", at_beat=0, beats=4, src={"kind": "kit", "kit_id": "source", "hits": [
        {"beat": 0, "voice": "kick", "vel": 1}, {"beat": 2, "voice": "snare", "vel": 1}]})
    assert np.abs(prepare_clip(kit, rmx, src, SR)).max() > 0.01  # the song's own drums
