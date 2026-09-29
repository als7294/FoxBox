"""rekordbox.xml generator (owned by S3).

Structure (Pioneer's "rekordbox xml format list")::

    DJ_PLAYLISTS Version=1.0.0
      PRODUCT Name Version Company
      COLLECTION Entries=N
        TRACK TrackID Name Artist ... Kind Size TotalTime AverageBpm ... Location Tonality ...
          TEMPO Inizio="0.000" Bpm Metro="4/4" Battito="1"      beatgrid from the file start
          POSITION_MARK Type=0 Num=0  Start=<first word>          hot cue A
          POSITION_MARK Type=0 Num=-1 Start=<tail_s>              memory cue "VOICE OUT" (end of the last word)
      PLAYLISTS
        NODE Type=0 Name=ROOT
          NODE Type=1 KeyType=0 Name=<playlist> Entries=N
            TRACK Key=<TrackID>

Import in Rekordbox under Preferences → Advanced → rekordbox xml. ``target_path_root`` rewrites locations so
the same XML works on another Mac (e.g. the DJ laptop) once the export folder is copied there.
"""
from __future__ import annotations

import os
import re
import uuid
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path, PurePosixPath
from typing import Any, Sequence
from urllib.parse import quote, unquote, urlparse

from .music import key_name

LOCATION_PREFIX = "file://localhost"
_KIND_BY_SUFFIX = {".aiff": "AIFF File", ".aif": "AIFF File", ".wav": "WAV File", ".mp3": "MP3 File"}
# Rekordbox's red hot-cue colour.
HOT_CUE_RGB = (230, 40, 40)
# XML 1.0 forbids most control characters, even escaped; one pasted \x0b would make Rekordbox reject the file.
_XML_INVALID = re.compile("[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\U00010000-\U0010ffff]")


def _xml_text(text: str) -> str:
    return _XML_INVALID.sub("", text)


@dataclass
class RekordboxTrack:
    path: Path  # absolute path of the exported file on this Mac
    name: str
    duration_s: float
    size: int
    bpm: float | None = None
    key: str | None = None  # any spelling parse_key accepts; written as Tonality ("Am")
    artist: str = "GUY FVWKS"
    album: str = ""
    genre: str = ""
    grouping: str = ""  # preset
    mix: str = ""  # variant
    comments: str = ""
    label: str = ""
    sample_rate: int = 44100
    bit_depth: int = 24
    channels: int = 2
    first_word_s: float | None = 0.0  # hot cue A
    tail_s: float | None = None  # memory cue: where the voice ends (end of the last word)
    cues: list[tuple[str, float, int]] = field(default_factory=list)  # more marks: (name, s, Num 0.. = hot cue A.., -1 = memory)
    date_added: date | None = None


@dataclass
class RekordboxOptions:
    local_root: Path | None = None  # export root on this Mac
    target_path_root: str | None = None  # the same folder on the target machine
    hot_cue_first_word: bool = True
    memory_cue_tail: bool = True
    product_name: str = "FoxBox"
    product_version: str = "0.1.0"
    company: str = "SmittyTech"


def location_uri(path: Path | str, local_root: Path | None = None, target_root: str | None = None) -> str:
    """``file://localhost`` + the percent-encoded absolute path, re-rooted onto ``target_root`` if given.

    A file under ``local_root`` keeps its relative path below ``target_root``; any other file lands directly
    in it. Windows roots (``C:\\Music``) become ``file://localhost/C:/Music/...``.
    """
    posix = os.path.normpath(Path(path).as_posix())
    if target_root:
        rel = PurePosixPath(Path(posix).name)
        if local_root is not None:
            inside = os.path.relpath(posix, os.path.normpath(Path(local_root).as_posix()))
            if not inside.startswith(".."):
                rel = PurePosixPath(inside)
        posix = f"{target_root.replace(chr(92), '/').rstrip('/')}/{rel}"
    drive = re.match(r"^/?([A-Za-z]:)(/.*)$", posix)
    if drive:
        return f"{LOCATION_PREFIX}/{drive[1]}{quote(drive[2], safe='/')}"
    if not posix.startswith("/"):
        raise ValueError(f"location must be absolute: {posix!r}")
    return LOCATION_PREFIX + quote(posix, safe="/")


def path_from_location(uri: str) -> str:
    parsed = urlparse(uri)
    if parsed.scheme != "file":
        raise ValueError(f"not a file URI: {uri!r}")
    path = unquote(parsed.path)
    return path[1:] if re.match(r"^/[A-Za-z]:/", path) else path


def _seconds(value: float) -> str:
    return f"{max(0.0, float(value)):.3f}"


def kind_for(path: Path | str) -> str:
    return _KIND_BY_SUFFIX.get(Path(path).suffix.lower(), "WAV File")


def build_rekordbox_xml(
    tracks: Sequence[RekordboxTrack], playlist_name: str, options: RekordboxOptions | None = None
) -> bytes:
    opts = options or RekordboxOptions()
    root = ET.Element("DJ_PLAYLISTS", Version="1.0.0")
    ET.SubElement(root, "PRODUCT", Name=opts.product_name, Version=opts.product_version, Company=opts.company)
    collection = ET.SubElement(root, "COLLECTION", Entries=str(len(tracks)))
    today = date.today()
    for track_id, t in enumerate(tracks, start=1):
        added = t.date_added or today
        el = ET.SubElement(collection, "TRACK", {k: _xml_text(v) for k, v in {
            "TrackID": str(track_id),
            "Name": t.name,
            "Artist": t.artist,
            "Composer": "",
            "Album": t.album,
            "Grouping": t.grouping,
            "Genre": t.genre,
            "Kind": kind_for(t.path),
            "Size": str(int(t.size)),
            "TotalTime": str(max(1, round(t.duration_s))),
            "DiscNumber": "0",
            "TrackNumber": "0",
            "Year": str(added.year),
            "AverageBpm": f"{t.bpm:.2f}" if t.bpm else "0.00",
            "DateAdded": added.isoformat(),
            "BitRate": str(int(t.sample_rate * t.bit_depth * t.channels / 1000)),
            "SampleRate": str(int(t.sample_rate)),
            "Comments": t.comments,
            "PlayCount": "0",
            "Rating": "0",
            "Location": location_uri(t.path, opts.local_root, opts.target_path_root),
            "Remixer": "",
            "Tonality": key_name(t.key) or "",
            "Label": t.label,
            "Mix": t.mix,
        }.items()})
        if t.bpm:
            ET.SubElement(el, "TEMPO", Inizio="0.000", Bpm=f"{t.bpm:.2f}", Metro="4/4", Battito="1")
        if opts.hot_cue_first_word and t.first_word_s is not None:
            r, g, b = HOT_CUE_RGB
            ET.SubElement(el, "POSITION_MARK", Name="VOX", Type="0", Start=_seconds(t.first_word_s), Num="0",
                          Red=str(r), Green=str(g), Blue=str(b))
        if opts.memory_cue_tail and t.tail_s is not None:
            tail = min(float(t.tail_s), max(0.0, t.duration_s - 0.001))
            ET.SubElement(el, "POSITION_MARK", Name="VOICE OUT", Type="0", Start=_seconds(tail), Num="-1")
        for name, start, num in t.cues:
            mark = {"Name": _xml_text(name), "Type": "0", "Start": _seconds(min(start, max(0.0, t.duration_s - 0.001))),
                    "Num": str(num)}
            if num >= 0:
                mark.update(zip(("Red", "Green", "Blue"), map(str, HOT_CUE_RGB)))
            ET.SubElement(el, "POSITION_MARK", mark)
    playlists = ET.SubElement(root, "PLAYLISTS")
    node_root = ET.SubElement(playlists, "NODE", Type="0", Name="ROOT", Count="1")
    playlist = ET.SubElement(node_root, "NODE", Name=_xml_text(playlist_name) or "GUY FVWKS", Type="1", KeyType="0",
                             Entries=str(len(tracks)))
    for track_id in range(1, len(tracks) + 1):
        ET.SubElement(playlist, "TRACK", Key=str(track_id))
    ET.indent(root, space="  ")
    # Same declaration Rekordbox itself writes (ElementTree would use single quotes).
    return ('<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="unicode") + "\n").encode()


def write_rekordbox_xml(
    path: Path, tracks: Sequence[RekordboxTrack], playlist_name: str, options: RekordboxOptions | None = None
) -> Path:
    path = Path(path)
    data = build_rekordbox_xml(tracks, playlist_name, options)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.part")  # unique: a double-click writes twice
    try:
        tmp.write_bytes(data)
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)
    return path


def parse_rekordbox_xml(data: bytes | str) -> dict[str, Any]:
    """Read a rekordbox.xml back into plain dicts (tracks with tempo and cues, playlists)."""
    root = ET.fromstring(data)
    if root.tag != "DJ_PLAYLISTS":
        raise ValueError(f"root element is {root.tag}, expected DJ_PLAYLISTS")
    product = root.find("PRODUCT")
    collection = root.find("COLLECTION")
    tracks = []
    for el in collection.findall("TRACK") if collection is not None else []:
        track = dict(el.attrib)
        track["path"] = path_from_location(el.get("Location", ""))
        track["tempo"] = [dict(t.attrib) for t in el.findall("TEMPO")]
        track["marks"] = [dict(m.attrib) for m in el.findall("POSITION_MARK")]
        tracks.append(track)
    playlists = []
    for node in root.iter("NODE"):
        if node.get("Type") == "1":
            playlists.append({"name": node.get("Name"), "entries": int(node.get("Entries", "0")),
                              "keys": [t.get("Key") for t in node.findall("TRACK")]})
    return {
        "version": root.get("Version"),
        "product": dict(product.attrib) if product is not None else {},
        "entries": int(collection.get("Entries", "0")) if collection is not None else 0,
        "tracks": tracks,
        "playlists": playlists,
    }


# --------------------------------------------------------------------------------------------- import (v0.12)

AUDIO_EXTS = {".wav", ".aif", ".aiff", ".flac", ".mp3", ".m4a", ".aac", ".ogg"}


def entry_id(location: str) -> str:
    """An imported track's opaque id: a hash of its Location (the path never crosses the API)."""
    import hashlib

    return "rbe_" + hashlib.sha1(location.encode("utf-8", "surrogatepass")).hexdigest()[:16]


def local_audio_path(location: str) -> tuple[Path | None, str]:
    """(the regular audio file a Location names on this Mac, "") or (None, why: 'unsupported' | 'missing'). Only local
    file:// URIs; symlinks resolved, then the resolved file must still be a regular file with an audio extension."""
    parsed = urlparse(location or "")
    if parsed.scheme != "file" or parsed.netloc not in ("", "localhost") or not parsed.path.startswith("/"):
        return None, "unsupported"  # network shares, relative or non-file Locations
    raw = Path(unquote(parsed.path))
    if raw.suffix.lower() not in AUDIO_EXTS:
        return None, "unsupported"
    try:
        path = raw.resolve(strict=True)
    except (OSError, RuntimeError):
        return None, "missing"
    if path.suffix.lower() not in AUDIO_EXTS or not path.is_file():  # a symlink to something else
        return None, "unsupported"
    return path, ""


def grid_of(tempo: Sequence[dict[str, str]]) -> tuple[str, float | None, float | None]:
    """(fixed | variable | none, bpm, bar 1 in s) from a track's TEMPO marks: Inizio is a beat numbered Battito 1-4,
    so bar 1 sits (Battito - 1) beats before it (a bar later when that's before 0)."""
    marks = [(float(t.get("Inizio", "0")), float(t.get("Bpm", "0")), int(float(t.get("Battito", "1") or 1)))
             for t in tempo if float(t.get("Bpm", "0") or 0) > 0]
    if not marks:
        return "none", None, None
    start, bpm, beat = marks[0]
    down = start - (beat - 1) * 60.0 / bpm
    while down < 0:
        down += 240.0 / bpm
    bpms = [b for _, b, _ in marks]
    return ("fixed" if max(bpms) - min(bpms) <= 0.01 else "variable"), bpm, round(down, 6)


def cues_of(marks: Sequence[dict[str, str]]) -> list[dict[str, Any]]:
    """SongCue dicts from POSITION_MARKs: Type 0 a cue (Num -1 memory, 0-7 hot), 4 a loop; fades and load marks skipped."""
    out = []
    for m in marks:
        kind, num = m.get("Type", "0"), int(float(m.get("Num", "-1") or -1))
        if kind not in ("0", "4"):
            continue
        cue: dict[str, Any] = {"name": (m.get("Name") or "")[:200], "start_s": max(0.0, float(m.get("Start", "0") or 0)),
                               "kind": "loop" if kind == "4" else ("hot" if 0 <= num <= 7 else "memory"),
                               "num": num if 0 <= num <= 7 else None}
        if kind == "4" and m.get("End"):
            cue["end_s"] = max(0.0, float(m["End"]))
        rgb = [m.get(c) for c in ("Red", "Green", "Blue")]
        if all(v is not None and v.isdigit() and int(v) < 256 for v in rgb):
            cue["color"] = "#" + "".join(f"{int(v):02X}" for v in rgb)
        out.append(cue)
    return out


def read_library(data: bytes) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(tracks, playlists) of a rekordbox.xml for the import: every TRACK with its attributes, TEMPO and POSITION_MARKs
    (whatever its Location), and every playlist with its folder breadcrumbs and track Locations. Raises ValueError when
    it isn't one. (expat has billion-laughs protection and ElementTree resolves no external entities.)"""
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise ValueError(str(exc)) from None
    if root.tag != "DJ_PLAYLISTS":
        raise ValueError(f"root element is {root.tag}, expected DJ_PLAYLISTS")
    collection = root.find("COLLECTION")
    tracks, by_id = [], {}
    for el in collection.findall("TRACK") if collection is not None else []:
        t = {**el.attrib, "tempo": [dict(x.attrib) for x in el.findall("TEMPO")],
             "marks": [dict(x.attrib) for x in el.findall("POSITION_MARK")]}
        tracks.append(t)
        by_id[t.get("TrackID")] = t.get("Location", "")
    playlists = []

    def walk(node: ET.Element, folders: list[str]) -> None:
        for child in node.findall("NODE"):
            if child.get("Type") == "1":
                by_location = child.get("KeyType") == "1"
                locations = [k.get("Key", "") if by_location else by_id.get(k.get("Key"), "") for k in child.findall("TRACK")]
                playlists.append({"name": child.get("Name", ""), "folders": list(folders),
                                  "locations": [loc for loc in locations if loc]})
            else:
                walk(child, folders + ([child.get("Name", "")] if child.get("Name") != "ROOT" else []))

    pl = root.find("PLAYLISTS")
    if pl is not None:
        walk(pl, [])
    return tracks, playlists
