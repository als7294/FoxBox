"""rekordbox.xml: structure, beatgrid, cues, locations and target path root, parsed back."""
import os
import xml.dom.minidom
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import pytest

from fvwks_server.rekordbox import (
    RekordboxOptions,
    RekordboxTrack,
    build_rekordbox_xml,
    location_uri,
    parse_rekordbox_xml,
    path_from_location,
    write_rekordbox_xml,
)
from fvwks_server.music import key_name
from fvwks_server.writer import ExportItem, ExportMeta, export_files

ROOT = Path("/Users/guy/Music/FoxBox")


def track(filename="drop.aiff", **kw):
    base = dict(path=ROOT / filename, name="WE ARE (PACT v01)", duration_s=6.857, size=1_816_202, bpm=140, key="Am",
                first_word_s=0.0, tail_s=5.9, grouping="PACT", mix="wet", comments="[PACT] WE ARE")
    base.update(kw)
    return RekordboxTrack(**base)


def test_structure_parses_back(tmp_path):
    tracks = [track("a.aiff"), track("b #2.wav", bpm=128.5, key="F# minor", first_word_s=0.4687, tail_s=7.1),
              track("c.aiff", bpm=174, key=None)]
    out = write_rekordbox_xml(tmp_path / "rekordbox.xml", tracks, "GUY FVWKS — Friday")
    data = out.read_bytes()
    assert data.startswith(b'<?xml version="1.0" encoding="UTF-8"?>\n<DJ_PLAYLISTS Version="1.0.0">')
    xml.dom.minidom.parseString(data)  # well-formed for a second, stricter parser too

    root = ET.fromstring(data)
    assert [child.tag for child in root] == ["PRODUCT", "COLLECTION", "PLAYLISTS"]
    collection = root.find("COLLECTION")
    assert collection.get("Entries") == "3" and len(collection.findall("TRACK")) == 3

    parsed = parse_rekordbox_xml(data)
    a, b, c = parsed["tracks"]
    assert a["TrackID"] == "1" and a["Kind"] == "AIFF File" and b["Kind"] == "WAV File"
    assert a["AverageBpm"] == "140.00" and b["AverageBpm"] == "128.50"
    assert a["Tonality"] == "Am" and b["Tonality"] == "F#m" and c["Tonality"] == ""
    assert a["TotalTime"] == "7" and a["Size"] == "1816202" and a["SampleRate"] == "44100"
    assert a["BitRate"] == "2116" and a["Artist"] == "GUY FVWKS"
    assert b["Location"] == "file://localhost/Users/guy/Music/FoxBox/b%20%232.wav"
    assert b["path"] == str(ROOT / "b #2.wav")
    # Beatgrid from the file start, 4/4, first beat of the bar.
    assert a["tempo"] == [{"Inizio": "0.000", "Bpm": "140.00", "Metro": "4/4", "Battito": "1"}]
    # Hot cue A at the first word, memory cue at the tail.
    hot = [m for m in b["marks"] if m["Num"] == "0"]
    memory = [m for m in b["marks"] if m["Num"] == "-1"]
    assert hot[0]["Type"] == "0" and hot[0]["Start"] == "0.469"
    assert memory[0]["Type"] == "0" and memory[0]["Start"] == "6.856"  # clamped inside the file
    assert memory[0]["Name"] == "VOICE OUT"
    assert parsed["playlists"] == [{"name": "GUY FVWKS — Friday", "entries": 3, "keys": ["1", "2", "3"]}]
    node_root = root.find("PLAYLISTS/NODE")
    assert (node_root.get("Type"), node_root.get("Name"), node_root.get("Count")) == ("0", "ROOT", "1")
    assert node_root.find("NODE").get("KeyType") == "0"


def test_target_path_root_rewrites_locations():
    opts = RekordboxOptions(local_root=ROOT, target_path_root="/Volumes/DJ USB/FoxBox/")
    parsed = parse_rekordbox_xml(build_rekordbox_xml([track("Friday/x.aiff"), track("../elsewhere.aiff")], "P",
                                                     opts))
    assert parsed["tracks"][0]["path"] == "/Volumes/DJ USB/FoxBox/Friday/x.aiff"
    assert parsed["tracks"][1]["path"] == "/Volumes/DJ USB/FoxBox/elsewhere.aiff"
    win = location_uri(ROOT / "x.aiff", ROOT, "C:\\Users\\dj\\Music\\FoxBox")
    assert win == "file://localhost/C:/Users/dj/Music/FoxBox/x.aiff"
    assert path_from_location(win) == "C:/Users/dj/Music/FoxBox/x.aiff"


def test_escaping_and_unicode_round_trip():
    name = 'Ünïcode & <tags> "quoted"'
    parsed = parse_rekordbox_xml(build_rekordbox_xml([track("dröp & co.aiff", name=name, comments=name)], "Ω"))
    t = parsed["tracks"][0]
    assert t["Name"] == name and t["Comments"] == name and t["path"] == str(ROOT / "dröp & co.aiff")
    assert "%C3%B6" in t["Location"] and "%26" in t["Location"]
    assert parsed["playlists"][0]["name"] == "Ω"


def test_cue_options_and_no_bpm():
    opts = RekordboxOptions(hot_cue_first_word=False, memory_cue_tail=False)
    parsed = parse_rekordbox_xml(build_rekordbox_xml([track(bpm=None)], "P", opts))
    assert parsed["tracks"][0]["marks"] == [] and parsed["tracks"][0]["tempo"] == []
    assert parsed["tracks"][0]["AverageBpm"] == "0.00"


def test_xml_for_real_exports(tmp_path):
    frames = 302_400
    audio = np.zeros((2, frames), np.float32)
    written = export_files(tmp_path, ExportMeta(script="WE ARE GUY FVWKS | EXPECT *US*", preset="PACT", bpm=140,
                                                bars=4, key="Am"), [ExportItem("wet", audio, 44100)])
    tracks = [RekordboxTrack(path=w.path, name=w.title, duration_s=w.duration_s, size=w.bytes, bpm=140, key="Am",
                             first_word_s=0.0, tail_s=6.2) for w in written]
    parsed = parse_rekordbox_xml(build_rekordbox_xml(tracks, "Drops"))
    assert Path(parsed["tracks"][0]["path"]) == written[0].path
    assert parsed["tracks"][0]["Size"] == str(written[0].path.stat().st_size)


def test_control_characters_never_break_the_xml(tmp_path):
    pasted = "WE ARE\x0bGUY\x00 FVWKS\x1f"  # e.g. line breaks pasted from Word
    data = build_rekordbox_xml([track(name=pasted, comments=pasted)], "Drops\x0c")
    t = parse_rekordbox_xml(data)["tracks"][0]
    assert t["Name"] == t["Comments"] == "WE AREGUY FVWKS"
    assert parse_rekordbox_xml(data)["playlists"][0]["name"] == "Drops"


def test_concurrent_writes_of_one_playlist(tmp_path):
    import threading

    errors = []

    def write():
        try:
            for _ in range(20):
                write_rekordbox_xml(tmp_path / "p_rekordbox.xml", [track()], "P")
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=write) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == [] and parse_rekordbox_xml((tmp_path / "p_rekordbox.xml").read_bytes())["entries"] == 1
    assert [p.name for p in tmp_path.iterdir()] == ["p_rekordbox.xml"]


# ------------------------------------------------------------------------------------------ pyrekordbox read-back
# pyrekordbox (MIT) is the reference parser behind most Rekordbox tooling. Tests only: it never touches
# Rekordbox's own databases here.


def test_pyrekordbox_reads_collection_grid_cues_and_playlist(tmp_path):
    rbxml = pytest.importorskip("pyrekordbox.rbxml")
    tracks = [track("GUYFVWKS_PACT_we-are_140bpm_4bar_Am_wet_v01.aiff", first_word_s=0.25, tail_s=5.9),
              track("Déjà vu & #2 (100%).wav", bpm=128.5, key="F# minor", first_word_s=0.4687, tail_s=6.5),
              track("no-grid.aiff", bpm=None, key=None, first_word_s=None, tail_s=None)]
    path = write_rekordbox_xml(tmp_path / "rekordbox.xml", tracks, "GUY FVWKS — Friday")
    xml = rbxml.RekordboxXml(path)
    assert (xml.product_name, xml.product_company) == ("FoxBox", "SmittyTech")
    assert xml.num_tracks == 3 and xml.get_track_ids() == [1, 2, 3]

    got = xml.get_tracks()
    for t, g in zip(tracks, got):
        # pyrekordbox strips "file://localhost/" including the slash, so a Mac path comes back without its root.
        assert "/" + g.Location == str(t.path)
        assert g._element.get("Location") == rbxml.encode_path(str(t.path).lstrip("/"))  # what it would write
        assert (g.Name, g.Artist, g.Grouping, g.Mix, g.Comments) == (t.name, "GUY FVWKS", t.grouping, t.mix,
                                                                      t.comments)
        assert (g.TotalTime, g.Size, g.SampleRate, g.BitRate) == (round(t.duration_s), t.size, 44100.0, 2116)
        assert g.AverageBpm == (t.bpm or 0.0) and g.Tonality == (key_name(t.key) or "")
    assert [g.Kind for g in got] == ["AIFF File", "WAV File", "AIFF File"]

    for t, g in zip(tracks[:2], got):
        (tempo,) = g.tempos  # one grid anchor: bar 1, beat 1 at the file's first sample
        assert (tempo.Inizio, tempo.Bpm, tempo.Metro, tempo.Battito) == (0.0, t.bpm, "4/4", 1)
        hot, memory = g.marks
        assert (hot.Name, hot.Type, hot.Num, hot.Start) == ("VOX", "cue", 0, float(f"{t.first_word_s:.3f}"))
        assert [hot._element.get(c) for c in ("Red", "Green", "Blue")] == ["230", "40", "40"]
        assert (memory.Name, memory.Type, memory.Num, memory.Start) == ("VOICE OUT", "cue", -1, t.tail_s)
    assert got[2].tempos == [] and got[2].marks == []

    playlist = xml.get_playlist("GUY FVWKS — Friday")
    assert playlist.is_playlist and playlist.key_type == "TrackID" and playlist.entries == 3
    assert playlist.get_tracks() == [1, 2, 3]
    assert [n.name for n in xml.get_playlist().get_playlists()] == ["GUY FVWKS — Friday"]


def test_pyrekordbox_reads_retargeted_locations(tmp_path):
    rbxml = pytest.importorskip("pyrekordbox.rbxml")
    t = track("Sets/Friday/drop 1.aiff")
    for target, expected in (("C:\\Music\\GUY FVWKS", "C:/Music/GUY FVWKS/Sets/Friday/drop 1.aiff"),
                             ("/Users/dj/Music/FoxBox", "Users/dj/Music/FoxBox/Sets/Friday/drop 1.aiff")):
        path = write_rekordbox_xml(tmp_path / "usb.xml", [t], "USB", RekordboxOptions(local_root=ROOT,
                                                                                      target_path_root=target))
        assert rbxml.RekordboxXml(path).get_track(TrackID=1).Location == os.path.normpath(expected)
