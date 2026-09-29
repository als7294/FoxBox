from __future__ import annotations

import base64

import numpy as np
import pytest

from fvwks_contracts.models import BassGroove, BassPatch, DrumKit, GrooveNote, GrooveWobble, KitHit
from fvwks_synth import surge
from fvwks_synth.bass import render_groove
from fvwks_synth.kit import kits, render_kit
from fvwks_synth.library import CATEGORIES, PATCHES_DIR, entries, patches

SR = 48_000
BPM = 140
SPB = 60 / BPM


def pitch(x: np.ndarray, t0: float, t1: float) -> float:
    """The strongest partial below 150 Hz between t0 and t1 (s): a bass note's fundamental (or a harmonic of it)."""
    seg = x[int(t0 * SR) : int(t1 * SR)]
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    f = np.fft.rfftfreq(len(seg), 1 / SR)
    m = (f > 20) & (f < 150)
    return float(f[m][np.argmax(spec[m])])


def semis(a: float, b: float) -> float:
    """b over a in semitones, octave-folded (the loudest partial may be a harmonic)."""
    return 12 * np.log2(b / a) % 12


def wobble_hz(x: np.ndarray, a: float, b: float) -> float:
    hp = np.diff(x)
    env = np.sqrt(np.convolve(hp**2, np.ones(480) / 480, "same"))[::480]
    e = env[int(a * 100) : int(b * 100)]
    f = np.fft.rfftfreq(8192, 0.01)
    m = (f > 1) & (f < 12)
    return float(f[m][np.argmax(np.abs(np.fft.rfft(e - e.mean(), 8192))[m])])


def groove(**extra) -> BassGroove:
    """Two bars from song bar 9: a held C1 sliding up a fifth into bar 2's G1; a 1/4 wobble in bar 1, 1/8 in bar 2."""
    return BassGroove(
        song_id="s", start_bar=9, bars=2, bpm=BPM,
        notes=[GrooveNote(beat=0, beats=4, midi=36, glide_to=43), GrooveNote(beat=4, beats=4, midi=43)],
        wobble=[GrooveWobble(bar=0, div="1/4", depth=0.8, phase=0), GrooveWobble(bar=1, div="1/8", depth=0.8, phase=0)],
        **extra,
    )


def test_library_is_cc0_and_typed():
    lib = entries()
    surge_ones = [p for p in lib if p["engine"] == "surge"]
    fox = [p for p in lib if p["engine"] == "foxbox"]
    assert len(surge_ones) == 12 and len(fox) == 5
    assert {p["category"] for p in surge_ones} == {p["category"] for p in fox} == set(CATEGORIES)
    for p in surge_ones:
        assert (PATCHES_DIR / p["file"]).is_file() and p["license"] == "CC0-1.0" and p["author"]
    assert all(isinstance(p, BassPatch) for p in patches()) and len(patches()) == 17


def test_kits_play_hits_on_the_grid():
    ks = kits()
    assert all(isinstance(k, DrumKit) for k in ks) and ks[0].id == "foxbox"
    assert {k.id for k in ks if k.source == "cc0"} == {"tr808-boom", "tr808-punch", "tr808-classic", "tr808-bright"}
    hits = [KitHit(beat=b, voice="kick", vel=1) for b in (0, 1, 2, 3)] + [KitHit(beat=1.5, voice="hats", vel=0.7)]
    for kit in ("foxbox", "tr808-punch"):
        x = render_kit(kit, hits, bpm=BPM, beats=4).mean(0)
        assert len(x) == round(4 * SPB * SR)
        for b in (1, 2, 3):  # silence just before each kick, sound right on it
            a = int(b * SPB * SR)
            assert np.abs(x[a : a + int(0.003 * SR)]).max() > 5 * np.abs(x[a - int(0.004 * SR) : a - 40]).max()
    # The 808 kit really is the samples, not FOXBOX's synth.
    fox = render_kit("foxbox", hits[:1], bpm=BPM, beats=1).mean(0)
    real = render_kit("tr808-boom", hits[:1], bpm=BPM, beats=1).mean(0)
    assert np.abs(fox - real).max() > 0.1
    with pytest.raises(KeyError):
        render_kit("nope", hits, bpm=BPM, beats=4)


@pytest.mark.parametrize("patch_id", ["foxbox.wobble", "foxbox.reese", "foxbox.808"])
def test_foxbox_grooves(patch_id):
    x = render_groove(groove(), patch_id, start_bar=9, bars=2, bpm=BPM).mean(0)
    assert len(x) == round(8 * SPB * SR) and np.isfinite(x).all() and 0.05 < np.abs(x).max() < 1.2
    assert abs(semis(pitch(x, 1 * SPB, 3 * SPB), pitch(x, 5 * SPB, 7 * SPB)) - 7) < 0.6
    if patch_id == "foxbox.wobble":
        assert wobble_hz(x, 4.2 * SPB, 8 * SPB) == pytest.approx(BPM / 60 * 2, rel=0.08)


def test_clip_cut_shift_and_bounce():
    # The second bar alone, up 2 semitones: G1 → A1.
    one = render_groove(groove(), "foxbox.reese", start_bar=10, bars=1, bpm=BPM, shift_st=2).mean(0)
    assert len(one) == round(4 * SPB * SR)
    ref = render_groove(groove(), "foxbox.reese", start_bar=10, bars=1, bpm=BPM).mean(0)
    assert abs(semis(pitch(ref, 1 * SPB, 3 * SPB), pitch(one, 1 * SPB, 3 * SPB)) - 2) < 0.6
    # The level curve: full in bar 1, silent in bar 2 (the bounce rides on the render).
    level = base64.b64encode(bytes([255] * 96 + [0] * 96)).decode()
    x = render_groove(groove(level_b64=level), "foxbox.reese", start_bar=9, bars=2, bpm=BPM).mean(0)
    assert np.abs(x[int(1 * SPB * SR) : int(3 * SPB * SR)]).max() > 0.05
    assert np.abs(x[int(5 * SPB * SR) :]).max() < 1e-3


@pytest.mark.skipif(not surge.available(), reason="surgepy isn't built (engine/synth/native/build_surgepy.sh)")
def test_surge_groove_glides_and_wobbles_on_tempo(tmp_path, monkeypatch):
    from fvwks_synth import bass

    monkeypatch.setattr(bass, "_data", tmp_path)
    x = render_groove(groove(), "surge.heavy-sub-sine", start_bar=9, bars=2, bpm=BPM).mean(0)
    assert len(x) == round(8 * SPB * SR) and np.isfinite(x).all() and np.abs(x).max() > 0.05
    assert abs(semis(pitch(x, 1 * SPB, 3 * SPB), pitch(x, 5 * SPB, 7 * SPB)) - 7) < 0.6
    assert wobble_hz(x, 4.2 * SPB, 8 * SPB) == pytest.approx(BPM / 60 * 2, rel=0.08)  # 1/8 at 140
    assert (tmp_path / "surge-home" / "Documents").is_dir()  # Surge's folders, in the given home only


def test_previews_are_cached_and_loudness_matched(tmp_path, monkeypatch):
    import soundfile as sf

    from fvwks_synth import bass
    from fvwks_synth.preview import kit_preview, preview

    monkeypatch.setattr(bass, "_data", tmp_path)
    ids = ["foxbox.wobble", "foxbox.808"] + (["surge.amen-polska"] if surge.available() else [])
    for pid in ids:
        path = preview(pid)
        x, sr = sf.read(path)
        assert sr == SR and abs(len(x) / sr - 4 * SPB) < 0.01
        assert abs(20 * np.log10(np.sqrt(np.mean(x**2))) + 16) < 1.5 and np.abs(x).max() <= 0.9
        mtime = path.stat().st_mtime_ns
        assert preview(pid) == path and path.stat().st_mtime_ns == mtime  # cached, not re-rendered
    assert kit_preview("tr808-boom").is_file()
