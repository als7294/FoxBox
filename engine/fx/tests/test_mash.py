import os
import sys
import time

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(__file__))
import songsynth  # noqa: E402
from fvwks_contracts.models import SongAnalysis, SongSection, SongStructure  # noqa: E402
from fvwks_fx.remix.mash import MashSong, features, scan  # noqa: E402

songsynth.PROGRESSIONS.setdefault("F#m", [tuple(m - 3 for m in c) for c in songsynth.PROGRESSIONS["Am"]])


def _song(song_id: str, bpm: float, key: str) -> MashSong:
    bar, down = 240.0 / bpm, 0.5
    st = SongStructure(sections=[SongSection(kind="build", start_s=0, end_s=down + 8 * bar, start_bar=1, energy=0.5),
                                 SongSection(kind="drop", start_s=down + 8 * bar, end_s=down + 16 * bar, start_bar=9, energy=1)])
    an = SongAnalysis(bpm=bpm, key=key, downbeat_s=down)
    return MashSong(song_id, an, st, features(songsynth.song(bpm, down, down + 16 * bar + 1, key), songsynth.SR, an, st))


def test_mash_scan_finds_the_key_shift_and_the_stretch_fast():
    # query a's build (F#m, 132); b: the same progression 3 st up at 140; c: another progression at 140
    a, b, c = _song("a", 132, "F#m"), _song("b", 140, "Am"), _song("c", 140, "C")
    ms = scan(a, "build", [a, b, c])
    assert (ms[0].song_id, ms[0].part, ms[0].start_bar, ms[0].bars, ms[0].shift_st) == ("b", "drop", 9, 8, -3)
    assert ms[0].tempo_ratio == pytest.approx(132 / 140, abs=1e-3)
    assert ms[0].score > max(m.score for m in ms if m.song_id == "c")
    # the cached features scan 200 songs well inside the 3 s target
    lib = [MashSong(f"s{k}", b.analysis, b.structure, {n: np.copy(v) for n, v in b.feats.items()}) for k in range(200)]
    t0 = time.perf_counter()
    assert len(scan(a, "build", lib, top=500)) == 200
    assert time.perf_counter() - t0 < 1.0


def test_mash_scan_filters_before_pairing():
    from fvwks_contracts.models import MashScanRequest
    from fvwks_fx.remix.mash import mash_scan

    a, b, c = _song("a", 132, "F#m"), _song("b", 140, "Am"), _song("c", 140, "C")
    assert not scan(a, "build", [b, c], key_compatible_only=True)  # F#m (11A) vs Am (8A), C (8B): not neighbours
    assert not scan(a, "build", [b, c], bpm_max=135)
    assert not scan(a, "build", [b, c], bass_styles=["dubstep"])  # no stems: no bass style on record
    ms = mash_scan(MashScanRequest(song_id="a", part="build", top=1), a, [b, c])
    assert len(ms) == 1 and ms[0].song_id == "b" and 0 <= ms[0].score <= 100


def test_borrow_narrows_the_matched_part():
    a, b = _song("a", 132, "F#m"), _song("b", 140, "Am")
    everything = scan(a, "drop", [b])
    assert {m.part for m in everything} == {"build", "drop"}  # a drop query takes their builds and drops on top
    assert {m.part for m in scan(a, "drop", [b], borrow="build")} == {"build"}
