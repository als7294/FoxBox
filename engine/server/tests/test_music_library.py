"""The library wheel (contracts v1.1) on synthetic libraries: a tagged music folder (WAV, FLAC, MP3, M4A through
afconvert), a generated rekordbox.xml, a Serato database V2 with crates and a Serato DJ 4 SQLite. Neither Rekordbox
nor Serato is needed."""
import io
import os
import sqlite3
import struct
import subprocess
import sys
import time
import zlib
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from mutagen.flac import FLAC, Picture
from mutagen.id3 import APIC, ID3, TBPM, TIT2, TKEY, TPE1
from mutagen.mp4 import MP4, MP4Cover

from fvwks_server import music_sources as ms

sys.path.insert(0, str(Path(__file__).parent))
from test_api import TOKEN, _close_engines, make_client, ok  # noqa: E402,F401  (its autouse fixture closes our engines)

MAIN = {"X-FoxBox-Main": TOKEN}


def png(rgb=(255, 120, 0), size=8) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    rows = b"".join(b"\0" + bytes(rgb) * size for _ in range(size))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def tone(path: Path, seconds=30.0, sr=44100, **kw) -> Path:
    t = np.arange(int(seconds * sr)) / sr
    x = (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), np.stack([x, x], 1), sr, **kw)
    return path


def music_folder(root: Path) -> dict[str, Path]:
    f = {"wav": tone(root / "House" / "a plain.wav"), "flac": tone(root / "House" / "Deep" / "b.flac"),
         "mp3": tone(root / "c.mp3", format="MP3")}
    fl = FLAC(f["flac"])
    fl.update({"title": "Deep One", "artist": "Fox", "bpm": "124", "initialkey": "Am", "genre": "House"})
    pic = Picture()
    pic.type, pic.mime, pic.data = 3, "image/png", png()
    fl.add_picture(pic)
    fl.save()
    id3 = ID3()
    id3.add(TIT2(encoding=3, text="Riddim Tool"))
    id3.add(TPE1(encoding=3, text="Guy"))
    id3.add(TBPM(encoding=3, text="140"))
    id3.add(TKEY(encoding=3, text="F#m"))
    id3.add(APIC(encoding=3, mime="image/png", type=3, desc="", data=png((0, 90, 255))))
    id3.save(f["mp3"])
    f["m4a"] = root / "d.m4a"
    subprocess.run(["/usr/bin/afconvert", "-f", "m4af", "-d", "aac", str(tone(root / "src.tmp.wav")), str(f["m4a"])],
                   check=True, capture_output=True)
    (root / "src.tmp.wav").unlink()
    m4 = MP4(f["m4a"])
    m4["\xa9nam"], m4["\xa9ART"], m4["covr"] = ["Apple Way"], ["Fox"], [MP4Cover(png(), MP4Cover.FORMAT_PNG)]
    m4.save()
    tone(root / ".hidden" / "e.wav")  # hidden folders, bundles and other files: never tracks
    tone(root / "Plugin.vst3" / "f.wav")
    (root / "notes.txt").write_text("not audio")
    return f


def wait_ready(client, source_id, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        src = next(s for s in ok(client.get("/api/library/sources")) if s["id"] == source_id)
        if src["state"] != "scanning":
            return src
        time.sleep(0.05)
    raise AssertionError("scan never finished")


def add(client, kind, path, status=200):
    return ok(client.post("/api/library/sources", json={"kind": kind, "path": str(path)}, headers=MAIN), status)


def tracks(client, **q):
    return ok(client.get("/api/library/tracks", params=q))


def test_only_main_adds_a_library_and_bad_picks_are_refused(tmp_path):
    client = make_client(tmp_path)
    folder = tmp_path / "Music"
    folder.mkdir()
    r = client.post("/api/library/sources", json={"kind": "folder", "path": str(folder)})  # the renderer's way in
    assert r.status_code == 403 and r.json()["error"]["code"] == "main_only"
    r = client.post("/api/library/sources", json={"kind": "folder", "path": str(folder)}, headers={"X-FoxBox-Main": "x"})
    assert r.status_code == 403
    assert add(client, "folder", "/", 400)["error"]["code"] == "invalid_library"
    assert add(client, "folder", "relative/path", 400)["error"]["code"] == "invalid_library"
    (tmp_path / "other.xml").write_text("<plist/>")
    assert add(client, "rekordbox", tmp_path / "other.xml", 400)["error"]["code"] == "invalid_library"
    assert add(client, "serato", folder, 400)["error"]["code"] == "invalid_library"


def test_a_music_folder_tags_art_previews_and_loading(tmp_path):
    client = make_client(tmp_path)
    files = music_folder(tmp_path / "Music")
    src = add(client, "folder", tmp_path / "Music")
    assert src["name"] == "Music" and add(client, "folder", tmp_path / "Music")["id"] == src["id"]  # the same one again
    src = wait_ready(client, src["id"])
    assert (src["state"], src["tracks"], src["playlists"]) == ("ready", 4, 2)
    page = tracks(client, source_id=src["id"], sort="title")
    assert str(tmp_path) not in client.get("/api/library/tracks").text  # no paths ever leave the engine
    by = {t["format"]: t for t in page["items"]}
    assert [t["title"] for t in page["items"]] == ["a plain", "Apple Way", "Deep One", "Riddim Tool"]
    assert (by["flac"]["artist"], by["flac"]["bpm"], by["flac"]["key"], by["flac"]["camelot"]) == ("Fox", 124, "Am", "8A")
    assert (by["mp3"]["bpm"], by["mp3"]["key"], by["mp3"]["camelot"]) == (140, "F#m", "11A")
    assert by["mp3"]["has_art"] and not by["wav"]["has_art"] and by["wav"]["file_name"] == "a plain.wav"
    assert abs(by["flac"]["duration_s"] - 30) < 0.1
    pls = {p["name"]: p for p in ok(client.get(f"/api/library/sources/{src['id']}/playlists"))}
    assert (pls["House"]["track_count"], pls["Deep"]["track_count"], pls["Deep"]["parent_id"]) == (2, 1, pls["House"]["id"])
    assert [t["title"] for t in tracks(client, playlist_id=pls["House"]["id"])["items"]] == ["a plain", "Deep One"]
    assert [t["title"] for t in tracks(client, q="fox APPLE")["items"]] == ["Apple Way"]
    assert tracks(client, q="100%_")["total"] == 0
    assert tracks(client, limit=2, offset=3, sort="title")["items"][0]["title"] == "Riddim Tool"

    for fmt in ("mp3", "flac", "m4a"):  # art: a ≤ 512 px JPEG through sips
        r = client.get(f"/api/library/tracks/{by[fmt]['id']}/art")
        assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg" and r.content[:2] == b"\xff\xd8", fmt
    r = client.get(f"/api/library/tracks/{by['wav']['id']}/art")
    assert r.status_code == 404 and r.json()["error"]["code"] == "no_art"

    for fmt in ("mp3", "m4a"):  # the m4a through afconvert
        r = client.get(f"/api/library/tracks/{by[fmt]['id']}/preview")
        assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
        info = sf.info(io.BytesIO(r.content))
        assert abs(info.duration - 20) < 0.2 and info.subtype == "PCM_16", fmt

    song = ok(client.post(f"/api/library/tracks/{by['m4a']['id']}/song"))
    assert song["name"] == "Fox - Apple Way" and abs(song["duration_s"] - 30) < 0.2 and song["analysis"] is None
    again = ok(client.post(f"/api/library/tracks/{by['m4a']['id']}/song"))
    assert again["id"] == song["id"]  # the same audio: the song it already is
    assert ok(client.get(f"/api/songs/{song['id']}"))["id"] == song["id"]

    # A rescan reads tags again only for changed files; a vanished file is a 404 (track_missing), never a crash.
    service = client.app.state.service
    reads = []
    real = ms.read_tags
    ms_read = lambda p: (reads.append(p), real(p))[1]  # noqa: E731
    try:
        ms.read_tags = ms_read
        os.utime(files["wav"], (1, 1))
        service.music.scan(src["id"])
    finally:
        ms.read_tags = real
    assert reads == [str(files["wav"])]
    files["mp3"].unlink()
    r = client.get(f"/api/library/tracks/{by['mp3']['id']}/preview")
    assert r.status_code == 404 and r.json()["error"]["code"] == "track_missing"
    ok(client.delete(f"/api/library/sources/{src['id']}"), 204)
    assert tracks(client)["total"] == 0 and files["flac"].is_file()  # forgotten, never touched


def rekordbox_xml(path: Path, tracks_: list[tuple[str, str, dict]]) -> Path:
    from urllib.parse import quote
    items = []
    for tid, loc, attrs in tracks_:
        kids = "".join(f"<{k} {' '.join(f'{a}={chr(34)}{v}{chr(34)}' for a, v in d.items())}/>" for k, d in attrs.pop("_kids", []))
        a = " ".join(f'{k}="{v}"' for k, v in attrs.items())
        items.append(f'<TRACK TrackID="{tid}" Location="{loc if loc.startswith("file") else "file://localhost" + quote(loc)}" {a}>{kids}</TRACK>')
    path.write_text(f"""<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0"><PRODUCT Name="rekordbox" Version="7.0.0" Company="AlphaTheta"/>
<COLLECTION Entries="{len(items)}">{''.join(items)}</COLLECTION>
<PLAYLISTS><NODE Type="0" Name="ROOT" Count="2">
  <NODE Type="0" Name="Sets" Count="2">
    <NODE Name="Friday" Type="1" KeyType="0" Entries="2"><TRACK Key="2"/><TRACK Key="1"/></NODE>
    <NODE Name="By location" Type="1" KeyType="1" Entries="1"><TRACK Key="{items and tracks_[0][1]}"/></NODE>
  </NODE>
  <NODE Name="Empty" Type="1" KeyType="0" Entries="0"/>
</NODE></PLAYLISTS></DJ_PLAYLISTS>""", encoding="utf-8")
    return path


def test_a_rekordbox_export_with_its_grid_and_cues(tmp_path):
    client = make_client(tmp_path)
    mp3 = tone(tmp_path / "Tunes" / "rb track.mp3", format="MP3")
    xml = rekordbox_xml(tmp_path / "rekordbox.xml", [
        ("1", f"file://localhost{mp3.as_posix().replace(' ', '%20')}",
         {"Name": "Grid Tune", "Artist": "Guy", "AverageBpm": "128.00", "Tonality": "Am", "TotalTime": "30",
          "DateAdded": "2026-10-01",
          "_kids": [("TEMPO", {"Inizio": "0.500", "Bpm": "128.00", "Metro": "4/4", "Battito": "1"}),
                    ("POSITION_MARK", {"Name": "Drop", "Type": "0", "Start": "8.0", "Num": "0", "Red": "255", "Green": "0", "Blue": "0"}),
                    ("POSITION_MARK", {"Name": "", "Type": "0", "Start": "99.0", "Num": "1"})]}),  # past the end: dropped
        ("2", str(tmp_path / "gone.mp3"), {"Name": "Gone"}),
        ("3", "/etc/hosts", {"Name": "Not audio"}),  # never a track, wherever a library points
        ("4", "http://example.com/x.mp3", {"Name": "Streaming"}),
    ])
    src = wait_ready(client, add(client, "rekordbox", xml)["id"])
    assert (src["name"], src["state"], src["tracks"]) == ("Rekordbox", "ready", 2)
    items = {t["title"]: t for t in tracks(client, source_id=src["id"])["items"]}
    assert set(items) == {"Grid Tune", "Gone"} and items["Gone"]["missing"] and not items["Grid Tune"]["missing"]
    assert items["Grid Tune"]["added_at"] == "2026-10-01T00:00:00Z" and items["Grid Tune"]["has_art"] is None
    pls = {p["name"]: p for p in ok(client.get(f"/api/library/sources/{src['id']}/playlists"))}
    assert pls["Sets"]["kind"] == "folder" and pls["Friday"]["parent_id"] == pls["Sets"]["id"]
    assert [t["title"] for t in tracks(client, playlist_id=pls["Friday"]["id"])["items"]] == ["Gone", "Grid Tune"]
    assert pls["By location"]["track_count"] == 1 and pls["Sets"]["track_count"] == 2 and pls["Empty"]["track_count"] == 0
    song = ok(client.post(f"/api/library/tracks/{items['Grid Tune']['id']}/song"))
    assert song["analysis"]["source"] == "rekordbox" and song["analysis"]["bpm"] == 128
    assert song["analysis"]["downbeat_s"] == 0.5 and song["analysis"]["camelot"] == "8A"
    assert [(c["name"], c["kind"], c["num"], c["color"]) for c in song["cues"]] == [("Drop", "hot", 0, "#FF0000")]
    r = client.post(f"/api/library/tracks/{items['Gone']['id']}/song")
    assert r.status_code == 404 and r.json()["error"]["code"] == "track_missing"


def serato_field(tag: str, payload: bytes) -> bytes:
    return tag.encode("latin-1") + len(payload).to_bytes(4, "big") + payload


def u16(s: str) -> bytes:
    return s.encode("utf-16-be")


def serato_library(root: Path, files: list[Path]) -> Path:
    d = root / "_Serato_"
    (d / "Subcrates").mkdir(parents=True)
    rel = lambda p: str(p)[1:]  # noqa: E731  relative to the drive (/ here)
    db = serato_field("vrsn", u16("2.0/Serato Scratch LIVE Database"))
    for p, title, extra in zip(files, ["One", "Two"], [{"tbpm": "174.00", "tkey": "Gm"}, {}]):
        body = serato_field("ttyp", u16("mp3")) + serato_field("pfil", u16(rel(p))) + serato_field("tsng", u16(title))
        body += b"".join(serato_field(k, u16(v)) for k, v in {"tart": "Guy", "tlen": "00:30.00", **extra}.items())
        body += serato_field("uadd", (1_760_000_000).to_bytes(4, "big"))
        db += serato_field("otrk", body)
    db += serato_field("otrk", serato_field("pfil", u16("etc/hosts")))  # not audio: skipped
    (d / "database V2").write_bytes(db)
    crate = lambda paths: serato_field("vrsn", u16("1.0/Serato ScratchLive Crate")) + b"".join(  # noqa: E731
        serato_field("otrk", serato_field("ptrk", u16(rel(p)))) for p in paths)
    (d / "Subcrates" / "Warmup.crate").write_bytes(crate([files[1], files[0]]))
    (d / "Subcrates" / "Warmup%%Deeper.crate").write_bytes(crate([files[0]]))
    (d / "Subcrates" / "Bass%%Halftime.crate").write_bytes(crate([files[1]]))  # its parent has no file of its own
    return d


def serato4_db(path: Path, files: list[Path], supported=True) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.executescript(f"""
      CREATE TABLE space (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE connection (location_id INTEGER, database_uri TEXT);
      CREATE TABLE asset (id INTEGER PRIMARY KEY, location_id INTEGER, portable_id TEXT, name TEXT, artist TEXT,
        album TEXT, genre TEXT, bpm REAL, key TEXT {', length_ms INTEGER' if supported else ''}, time_added INTEGER);
      CREATE TABLE container (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, type INTEGER, space_id INTEGER);
      CREATE TABLE location_container (id INTEGER PRIMARY KEY, container_id INTEGER);
      CREATE TABLE container_asset (id INTEGER PRIMARY KEY, asset_id INTEGER, location_container_id INTEGER, list_order INTEGER);
      INSERT INTO space VALUES (1, 'Serato Library');
      INSERT INTO connection VALUES (1, '/Users/someone/Library/Application Support/Serato/Library/root.sqlite');
      INSERT INTO container VALUES (0, NULL, 'root', 0, NULL), (10, 0, 'gen-root', 0, 1), (11, 10, 'Peak', 1, 1),
                                   (12, 11, 'Later', 1, 1);
      INSERT INTO location_container VALUES (100, 11), (101, 12);
    """)
    for i, p in enumerate(files, 1):
        con.execute(f"INSERT INTO asset VALUES (?, 1, ?, ?, 'Guy', NULL, 'Bass', 150.0, '4A'{', 30000' if supported else ''}, 1760000000)",
                    (i, str(p)[1:], f"S4 {i}"))
        con.execute("INSERT INTO container_asset (asset_id, location_container_id, list_order) VALUES (?, 100, ?)", (i, -i))
    con.execute("INSERT INTO asset (id, location_id, portable_id, name) VALUES (9, 1, 'streaming://tidal/123', 'Stream')")
    con.execute("INSERT INTO container_asset (asset_id, location_container_id, list_order) VALUES (1, 101, 0)")
    con.commit()
    con.close()
    return path


def test_serato_database_v2_crates_and_serato_4(tmp_path, monkeypatch):
    client = make_client(tmp_path)
    files = [tone(tmp_path / "Music" / n, format="MP3") for n in ("one.mp3", "two.mp3")]
    monkeypatch.setattr(ms, "SERATO_DIR", tmp_path / "nowhere" / "_Serato_")
    monkeypatch.setattr(ms, "SERATO4_DB", tmp_path / "nowhere" / "master.sqlite")
    r = client.post("/api/library/sources/serato")
    assert r.status_code == 404 and r.json()["error"]["code"] == "serato_not_found"

    monkeypatch.setattr(ms, "SERATO_DIR", serato_library(tmp_path / "Music", files))
    src = wait_ready(client, ok(client.post("/api/library/sources/serato"))["id"])
    assert (src["name"], src["tracks"], src["message"]) == ("Serato", 2, None)
    items = {t["title"]: t for t in tracks(client, source_id=src["id"])["items"]}
    assert (items["One"]["bpm"], items["One"]["camelot"], items["One"]["duration_s"]) == (174, "6A", 30)
    assert items["One"]["added_at"] == "2025-10-09T08:53:20Z"
    pls = {p["name"]: p for p in ok(client.get(f"/api/library/sources/{src['id']}/playlists"))}
    assert pls["Deeper"]["parent_id"] == pls["Warmup"]["id"] and pls["Bass"]["track_count"] == 0
    assert [t["title"] for t in tracks(client, playlist_id=pls["Warmup"]["id"])["items"]] == ["Two", "One"]
    preview = client.get(f"/api/library/tracks/{items['Two']['id']}/preview")
    assert preview.status_code == 200
    ok(client.delete(f"/api/library/sources/{src['id']}"), 204)

    # Serato DJ 4's library, when there; an unknown layout falls back to database V2 with a note.
    monkeypatch.setattr(ms, "SERATO4_DB", serato4_db(tmp_path / "S4" / "master.sqlite", files))
    src = wait_ready(client, ok(client.post("/api/library/sources/serato"))["id"])
    assert (src["tracks"], src["message"]) == (2, None)
    pls = {p["name"]: p for p in ok(client.get(f"/api/library/sources/{src['id']}/playlists"))}
    assert pls["Later"]["parent_id"] == pls["Peak"]["id"]
    assert [t["title"] for t in tracks(client, playlist_id=pls["Peak"]["id"])["items"]] == ["S4 2", "S4 1"]
    ok(client.delete(f"/api/library/sources/{src['id']}"), 204)
    monkeypatch.setattr(ms, "SERATO4_DB", serato4_db(tmp_path / "S4old" / "master.sqlite", files, supported=False))
    src = wait_ready(client, ok(client.post("/api/library/sources/serato"))["id"])
    assert src["tracks"] == 2 and "database V2" in src["message"]


def test_ten_thousand_tracks_open_fast_after_the_first_scan(tmp_path):
    client = make_client(tmp_path)
    xml = rekordbox_xml(tmp_path / "rekordbox.xml", [
        (str(i), f"/Volumes/USB/Music/{i:05d} track.mp3", {"Name": f"Track {i}", "Artist": f"Artist {i % 300}",
                                                           "AverageBpm": f"{120 + i % 50}.00", "Tonality": "Am"})
        for i in range(1, 10_001)])
    service = client.app.state.service
    src = add(client, "rekordbox", xml)
    wait_ready(client, src["id"], timeout=60)
    t0 = time.perf_counter()
    page = tracks(client, source_id=src["id"], limit=40)
    found = tracks(client, q="artist 7 track 9")
    sources = ok(client.get("/api/library/sources"))
    took = time.perf_counter() - t0
    assert page["total"] == 10_000 and len(page["items"]) == 40 and found["total"] > 0 and sources
    assert took < 1.0, took
    t0 = time.perf_counter()
    service.music.scan(src["id"], force=False)  # unchanged: the engine's start skips re-reading it
    assert time.perf_counter() - t0 < 0.1


@pytest.mark.parametrize("tlen,want", [("05:12.34", 312.34), ("1:02:03", 3723.0), ("245.5", 245.5), ("", None)])
def test_serato_lengths(tlen, want):
    got = ms._duration(tlen)
    assert (got is None and want is None) or abs(got - want) < 1e-6


def test_a_symlink_to_something_else_is_never_a_track(tmp_path):
    (tmp_path / "secret.txt").write_text("x")
    os.symlink(tmp_path / "secret.txt", tmp_path / "evil.mp3")
    assert ms.audio_file(tmp_path / "evil.mp3") is None
    assert ms.audio_file(tmp_path) is None and ms.audio_file(tone(tmp_path / "ok.wav")) is not None
