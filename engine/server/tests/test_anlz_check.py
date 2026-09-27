"""scripts/rekordbox_anlz_check.py against synthetic Rekordbox analysis files (layouts as pyrekordbox parses them)."""
import importlib.util
import struct
import sys
from pathlib import Path

import pytest

from fvwks_server.rekordbox import RekordboxTrack, write_rekordbox_xml

pytest.importorskip("pyrekordbox")
_spec = importlib.util.spec_from_file_location(
    "rekordbox_anlz_check", Path(__file__).parents[1] / "scripts" / "rekordbox_anlz_check.py")
check = sys.modules[_spec.name] = importlib.util.module_from_spec(_spec)  # dataclasses look the module up
_spec.loader.exec_module(check)


def _tag(kind: bytes, len_header: int, header: bytes, body: bytes) -> bytes:
    return kind + struct.pack(">II", len_header, len_header + len(body)) + header + body


def ppth(path: str) -> bytes:
    raw = path.encode("utf-16-be") + b"\0\0"
    return _tag(b"PPTH", 16, struct.pack(">I", len(raw)), raw)


def pqtz(bpm: float, first_ms: int, first_beat: int = 1, beats: int = 8) -> bytes:
    step = 60_000 / bpm
    body = b"".join(struct.pack(">HHI", (first_beat - 1 + i) % 4 + 1, round(bpm * 100), round(first_ms + i * step))
                    for i in range(beats))
    return _tag(b"PQTZ", 24, struct.pack(">III", 0, 0x80000, beats), body)


def pcob(hot: bool, cues: list[tuple[int, int]]) -> bytes:
    """Cue list (.DAT/.EXT): (hot cue number, 0 for memory; time ms)."""
    body = b"".join(struct.pack(">4sIIIIIHHBxHII16x", b"PCPT", 28, 56, num, 4, 0x10000, 0xFFFF, 0xFFFF, 1, 1000, ms,
                                0xFFFFFFFF) for num, ms in cues)
    return _tag(b"PCOB", 24, struct.pack(">IHHi", int(hot), 0, len(cues), -1 if hot else len(cues)), body)


def pco2(hot: bool, cues: list[tuple[int, int]]) -> bytes:
    """Extended (nxs2) cue list, as current Rekordbox versions write in the .EXT."""
    body = b"".join(struct.pack(">4sIIIB3xIIB7xHHI", b"PCP2", 16, 48, num, 1, ms, 0xFFFFFFFF, 0, 0, 0, 0)
                    + bytes(4) for num, ms in cues)
    return _tag(b"PCO2", 20, struct.pack(">IHH", int(hot), len(cues), 0), body)


def anlz(path: Path, *tags: bytes) -> Path:
    body = b"".join(tags)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(struct.pack(">4sIIIIII", b"PMAI", 28, 28 + len(body), 1, 0x10000, 0x10000, 0) + body)
    return path


@pytest.fixture
def exported(tmp_path):
    root = tmp_path / "exports"
    tracks = [RekordboxTrack(path=root / "GUYFVWKS_PACT_we-are_140bpm_4bar_Am_wet_v01.aiff", name="WE ARE",
                             duration_s=6.857, size=1, bpm=140, key="Am", first_word_s=0.212, tail_s=6.102),
              RekordboxTrack(path=root / "GUYFVWKS_GHOST_expect-us_128bpm_8bar_Fm_wet_v01.aiff", name="EXPECT US",
                             duration_s=15.0, size=1, bpm=128, key="Fm", first_word_s=1.875, tail_s=13.4),
              RekordboxTrack(path=root / "not-analysed-yet.aiff", name="LATER", duration_s=3.0, size=1, bpm=140)]
    xml = write_rekordbox_xml(tmp_path / "friday_rekordbox.xml", tracks, "Friday")
    return xml, tracks


def test_matching_analysis_passes_and_mismatches_are_named(exported, tmp_path, capsys):
    xml, tracks = exported
    usbanlz = tmp_path / "USBANLZ"
    good, off = str(tracks[0].path), str(tracks[1].path)
    anlz(usbanlz / "a1" / "0001" / "ANLZ0000.DAT", ppth(good), pqtz(140, 0), pcob(True, []), pcob(False, []))
    anlz(usbanlz / "a1" / "0001" / "ANLZ0000.EXT", ppth(good), pco2(True, [(1, 212)]), pco2(False, [(0, 6102)]))
    # Re-analysed by Rekordbox: grid moved 12 ms and onto beat 2, hot cue A gone, memory cue only in the .DAT list.
    anlz(usbanlz / "b2" / "0002" / "ANLZ0000.DAT", ppth(off), pqtz(128, 12, first_beat=2),
         pcob(True, []), pcob(False, [(0, 13400)]))
    anlz(usbanlz / "c3" / "0003" / "ANLZ0000.DAT", ppth("/Users/guy/Music/someone-else.mp3"), pqtz(124, 0))
    before = {p: p.read_bytes() for p in usbanlz.rglob("*.*")}

    assert check.main([str(xml), "--anlz", str(usbanlz)]) == 1
    out = capsys.readouterr().out.splitlines()
    assert out[0].startswith("OK        GUYFVWKS_PACT") and "140.00 BPM from 0.000 s, 1 hot / 1 memory cues" in out[0]
    assert out[1].startswith("MISMATCH  GUYFVWKS_GHOST")
    assert "grid starts at 0.012 s, not 0.000 s" in out[1] and "grid starts on beat 2, not beat 1" in out[1]
    assert "hot cue A is missing" in out[1] and "no memory cue" not in out[1]
    assert out[2].startswith("MISSING   not-analysed-yet.aiff")
    assert {p: p.read_bytes() for p in usbanlz.rglob("*.*")} == before  # read-only


def test_usb_export_paths_match_by_file_name(exported, tmp_path, capsys):
    xml, tracks = exported
    usb = tmp_path / "USB" / "PIONEER" / "USBANLZ"
    name = tracks[0].path.name
    anlz(usb / "P01" / "0001" / "ANLZ0000.DAT", ppth(f"/Contents/GUY FVWKS/UnknownAlbum/{name}"), pqtz(140, 0),
         pcob(True, [(1, 212)]), pcob(False, [(0, 6102)]))
    assert check.main([str(xml), "--anlz", str(usb)]) == 0
    assert capsys.readouterr().out.startswith(f"OK        {name}")


def test_nothing_analysed_or_no_folder(exported, tmp_path, capsys):
    xml, _ = exported
    (tmp_path / "empty").mkdir()
    assert check.main([str(xml), "--anlz", str(tmp_path / "empty")]) == 2
    assert check.main([str(xml), "--anlz", str(tmp_path / "nope")]) == 2
    assert "no analysis folder" in capsys.readouterr().err


def test_analysis_without_cue_lists_checks_only_the_grid(exported, tmp_path, capsys):
    """A local collection's analysis may carry no cue lists (Rekordbox keeps those cues in its database)."""
    xml, tracks = exported
    root = tmp_path / "USBANLZ"
    anlz(root / "a1" / "0001" / "ANLZ0000.DAT", ppth(str(tracks[0].path)), pqtz(140, 0))
    assert check.main([str(xml), "--anlz", str(root)]) == 0
    assert "cues not in the analysis files" in capsys.readouterr().out.splitlines()[0]
