"""The library wheel's sources (S3, contracts v1.1): what a music folder, a Rekordbox XML export or a Serato library
holds, read into plain records for the index (music_library.py). Read-only, always: nothing here writes near the
user's music or their DJ software's files (Serato 4's SQLite is read from a copy).

Only audio files are ever tracks: an audio extension and a regular file (``audio_file``), wherever a library says
they live (external drives are normal). Tags and artwork come from mutagen (GPL-2.0+, shipped in engine-code).

- Folder: every audio file under it (no symlinked folders, no hidden folders or bundles); each folder is a playlist
  of everything under it.
- Rekordbox: File → Export Collection in xml format. The collection, playlists and folders, BPM, key, the beat grid
  (TEMPO) and cues (POSITION_MARK). Not master.db (encrypted).
- Serato: ``_Serato_/database V2`` and ``Subcrates/*.crate`` (our own parser of their tagged binary format: 4-byte tag,
  4-byte big-endian length, payload; text is UTF-16BE; paths are relative to the drive the _Serato_ folder is on), or
  Serato DJ 4's ``master.sqlite`` when present, read by its community-documented layout (asset, connection,
  container type 1 = crate, location_container, container_asset) and refused when that layout isn't there.
"""
from __future__ import annotations

import base64
import os
import shutil
import sqlite3
import tempfile
import unicodedata
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Sequence
from urllib.parse import unquote, urlparse

AUDIO_EXTS = frozenset({".mp3", ".m4a", ".aac", ".wav", ".aif", ".aiff", ".flac", ".ogg", ".alac"})
SKIP_DIR_EXTS = frozenset({".app", ".bundle", ".framework", ".photoslibrary", ".musiclibrary", ".tvlibrary",
                           ".logicx", ".band", ".plugin", ".component", ".vst", ".vst3", ".aaxplugin"})
MAX_FOLDER_FILES = 200_000
MAX_XML_BYTES = 512 << 20
TEXT_MAX = 300

SERATO_DIR = Path.home() / "Music" / "_Serato_"
SERATO4_DB = Path.home() / "Library" / "Application Support" / "Serato" / "Library" / "master.sqlite"


@dataclass
class TrackRec:
    path: str  # absolute, NFC
    title: str | None = None
    artist: str | None = None
    album: str | None = None
    genre: str | None = None
    bpm: float | None = None
    key: str | None = None  # as the source spells it
    duration_s: float | None = None
    added_at: str | None = None  # ISO 8601, UTC
    has_art: bool | None = None  # None: not looked at yet (DB sources)
    mtime: float | None = None  # folder sources: for incremental rescans
    size: int | None = None
    tempo: list[dict[str, str]] = field(default_factory=list)  # Rekordbox TEMPO marks
    marks: list[dict[str, str]] = field(default_factory=list)  # Rekordbox POSITION_MARKs


@dataclass
class PlaylistRec:
    key: str  # unique within its source ("Folder/Sub/List")
    name: str
    parent: str | None
    kind: str  # folder | playlist | crate
    paths: list[str] = field(default_factory=list)  # its tracks, in order


@dataclass
class SourceRead:
    tracks: list[TrackRec]
    playlists: list[PlaylistRec]
    note: str | None = None  # shown with the source, e.g. which Serato library was read


def nfc(path: str) -> str:
    return unicodedata.normalize("NFC", path)


def audio_file(path: str | Path) -> Path | None:
    """The regular audio file at `path` (symlinks resolved, the target must still be one), else None."""
    raw = Path(path)
    if raw.suffix.lower() not in AUDIO_EXTS:
        return None
    try:
        real = raw.resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    return real if real.suffix.lower() in AUDIO_EXTS and real.is_file() else None


def _clean(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).replace("\x00", "").strip()
    return text[:TEXT_MAX] or None


def _float(value: Any) -> float | None:
    try:
        x = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    return x if x > 0 and x == x and x != float("inf") else None


def _iso(ts: float | None) -> str | None:
    if ts is None or not (0 < ts < 4e9):
        return None
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _unique(key: str, seen: set[str]) -> str:
    out, n = key, 2
    while out in seen:
        out, n = f"{key} #{n}", n + 1
    seen.add(out)
    return out


# ------------------------------------------------------------------------------------------------- tags (mutagen)

def read_tags(path: str | Path) -> dict[str, Any]:
    """Title, artist, album, genre, BPM, key, duration and whether there's artwork; {} when unreadable."""
    import mutagen
    from mutagen.id3 import ID3
    from mutagen.mp4 import MP4Tags

    try:
        f = mutagen.File(str(path))
    except Exception:  # noqa: BLE001  damaged or not what its extension says
        return {}
    if f is None:
        return {}
    out: dict[str, Any] = {"duration_s": _float(getattr(f.info, "length", None)), "has_art": False}
    tags = f.tags
    if isinstance(tags, ID3):
        def text(fid: str) -> str | None:
            frame = tags.get(fid)
            return _clean(frame.text[0]) if frame is not None and getattr(frame, "text", None) else None
        con = tags.get("TCON")
        out.update(title=text("TIT2"), artist=text("TPE1"), album=text("TALB"), bpm=_float(text("TBPM")),
                   key=text("TKEY"), genre=_clean(con.genres[0]) if con is not None and con.genres else None,
                   has_art=bool(tags.getall("APIC")))
    elif isinstance(tags, MP4Tags):
        def first(name: str) -> Any:
            v = tags.get(name)
            return v[0] if v else None
        key = first("----:com.apple.iTunes:initialkey") or first("----:com.apple.iTunes:KEY")
        out.update(title=_clean(first("\xa9nam")), artist=_clean(first("\xa9ART")), album=_clean(first("\xa9alb")),
                   genre=_clean(first("\xa9gen")), bpm=_float(first("tmpo")),
                   key=_clean(key.decode("utf-8", "replace") if isinstance(key, bytes) else key),
                   has_art=bool(tags.get("covr")))
    elif tags is not None and hasattr(tags, "get"):  # Vorbis comments (FLAC, Ogg)
        def first(*names: str) -> str | None:
            for name in names:
                v = tags.get(name)
                if v:
                    return _clean(v[0])
            return None
        out.update(title=first("title"), artist=first("artist"), album=first("album"), genre=first("genre"),
                   bpm=_float(first("bpm", "tempo")), key=first("initialkey", "key"),
                   has_art=bool(getattr(f, "pictures", None)) or bool(tags.get("metadata_block_picture")))
    return out


def read_art(path: str | Path) -> tuple[bytes, str] | None:
    """The embedded cover (the front cover when there are several): (bytes, MIME type), or None."""
    import mutagen
    from mutagen.flac import Picture
    from mutagen.id3 import ID3
    from mutagen.mp4 import MP4Cover, MP4Tags

    try:
        f = mutagen.File(str(path))
        tags = f.tags if f is not None else None
        if isinstance(tags, ID3):
            pics = sorted(tags.getall("APIC"), key=lambda p: p.type != 3)
            return (pics[0].data, pics[0].mime or "image/jpeg") if pics else None
        if isinstance(tags, MP4Tags):
            covers = tags.get("covr") or []
            if covers:
                c = covers[0]
                return bytes(c), "image/png" if getattr(c, "imageformat", None) == MP4Cover.FORMAT_PNG else "image/jpeg"
            return None
        pics = list(getattr(f, "pictures", None) or [])
        if not pics and tags is not None and hasattr(tags, "get"):
            pics = [Picture(base64.b64decode(b)) for b in tags.get("metadata_block_picture") or []]
        pics.sort(key=lambda p: p.type != 3)
        return (pics[0].data, pics[0].mime or "image/jpeg") if pics else None
    except Exception:  # noqa: BLE001  no art we can read
        return None


# ------------------------------------------------------------------------------------------------- a music folder

def read_folder(root: Path, known: dict[str, TrackRec] | None = None) -> SourceRead:
    """Every audio file under `root`. `known` (the last scan, by path): a file with the same mtime and size keeps its
    record (no tag read), so a rescan of a big unchanged folder only stats it."""
    known = known or {}
    tracks: list[TrackRec] = []
    under: dict[str, list[str]] = {}  # each folder (relative) → every track under it
    root = root.resolve()
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and Path(d).suffix.lower() not in SKIP_DIR_EXTS)
        rel = os.path.relpath(dirpath, root)
        for name in sorted(filenames):
            if name.startswith(".") or Path(name).suffix.lower() not in AUDIO_EXTS:
                continue
            path = os.path.join(dirpath, name)
            try:
                st = os.stat(path)  # follows a symlinked file; it must still be a regular file
            except OSError:
                continue
            if not os.path.isfile(path):
                continue
            path = nfc(path)
            old = known.get(path)
            if old is not None and old.mtime == st.st_mtime and old.size == st.st_size:
                rec = old
            else:
                tags = read_tags(path)
                rec = TrackRec(path=path, title=tags.get("title"), artist=tags.get("artist"), album=tags.get("album"),
                               genre=tags.get("genre"), bpm=tags.get("bpm"), key=tags.get("key"),
                               duration_s=tags.get("duration_s"), has_art=tags.get("has_art", False),
                               added_at=_iso(getattr(st, "st_birthtime", None) or st.st_mtime),
                               mtime=st.st_mtime, size=st.st_size)
            tracks.append(rec)
            parts = [] if rel == "." else rel.split(os.sep)
            for i in range(1, len(parts) + 1):
                under.setdefault("/".join(parts[:i]), []).append(path)
            if len(tracks) >= MAX_FOLDER_FILES:
                return SourceRead(tracks, _folder_playlists(under), f"Only the first {MAX_FOLDER_FILES:,} files are listed.")
    return SourceRead(tracks, _folder_playlists(under))


def _folder_playlists(under: dict[str, list[str]]) -> list[PlaylistRec]:
    return [PlaylistRec(key=k, name=k.rsplit("/", 1)[-1], parent=k.rsplit("/", 1)[0] if "/" in k else None,
                        kind="folder", paths=paths) for k, paths in sorted(under.items())]


# ------------------------------------------------------------------------------------------------- Rekordbox XML

def path_from_location(location: str) -> str | None:
    """A Location's local path (file://localhost/... or file:///...), or None for anything else."""
    parsed = urlparse(location or "")
    if parsed.scheme != "file" or parsed.netloc not in ("", "localhost") or not parsed.path.startswith("/"):
        return None
    return nfc(unquote(parsed.path))


def grid_of(tempo: Sequence[dict[str, str]]) -> tuple[str, float | None, float | None]:
    """(fixed | variable | none, bpm, bar 1 in s) from a track's TEMPO marks: Inizio is a beat numbered Battito 1-4,
    so bar 1 sits (Battito - 1) beats before it (a bar later when that's before 0)."""
    marks = [(float(t.get("Inizio", "0")), float(t.get("Bpm", "0")), int(float(t.get("Battito", "1") or 1)))
             for t in tempo if (_float(t.get("Bpm")) or 0) > 0]
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


def read_rekordbox(xml_path: Path) -> SourceRead:
    """A rekordbox.xml (File → Export Collection in xml format). Raises ValueError when it isn't one. (expat has
    billion-laughs protection and ElementTree resolves no external entities.)"""
    if xml_path.stat().st_size > MAX_XML_BYTES:
        raise ValueError("That rekordbox.xml is too big to read.")
    try:
        root = ET.parse(xml_path).getroot()
    except ET.ParseError as exc:
        raise ValueError(f"Not a readable XML file ({exc}).") from None
    if root.tag != "DJ_PLAYLISTS":
        raise ValueError("Not a Rekordbox collection: in Rekordbox, choose File → Export Collection in xml format.")
    tracks: list[TrackRec] = []
    by_id: dict[str, str] = {}
    by_location: dict[str, str] = {}
    collection = root.find("COLLECTION")
    for el in collection.findall("TRACK") if collection is not None else []:
        location = el.get("Location", "")
        path = path_from_location(location)
        if path is None or Path(path).suffix.lower() not in AUDIO_EXTS:
            continue
        added = el.get("DateAdded")
        tracks.append(TrackRec(
            path=path, title=_clean(el.get("Name")), artist=_clean(el.get("Artist")), album=_clean(el.get("Album")),
            genre=_clean(el.get("Genre")), bpm=_float(el.get("AverageBpm")), key=_clean(el.get("Tonality")),
            duration_s=_float(el.get("TotalTime")), added_at=f"{added}T00:00:00Z" if added and len(added) == 10 else None,
            tempo=[dict(x.attrib) for x in el.findall("TEMPO")], marks=[dict(x.attrib) for x in el.findall("POSITION_MARK")]))
        by_id[el.get("TrackID", "")] = path
        by_location[location] = path
    playlists: list[PlaylistRec] = []
    seen: set[str] = set()

    def walk(node: ET.Element, parent: str | None) -> None:
        for child in node.findall("NODE"):
            name = _clean(child.get("Name")) or "Untitled"
            key = _unique(f"{parent}/{name}" if parent else name, seen)
            if child.get("Type") == "1":
                by_loc = child.get("KeyType") == "1"
                paths = [(by_location if by_loc else by_id).get(k.get("Key", "")) for k in child.findall("TRACK")]
                playlists.append(PlaylistRec(key, name, parent, "playlist", [p for p in paths if p]))
            else:
                playlists.append(PlaylistRec(key, name, parent, "folder"))
                walk(child, key)

    top = root.find("PLAYLISTS")
    rootnode = top.find("NODE") if top is not None else None
    if rootnode is not None:
        walk(rootnode, None)
    return SourceRead(tracks, _fill_folders(playlists))


def _fill_folders(playlists: list[PlaylistRec]) -> list[PlaylistRec]:
    """A folder node lists everything in the playlists under it (once each, in order)."""
    children: dict[str | None, list[PlaylistRec]] = {}
    for p in playlists:
        children.setdefault(p.parent, []).append(p)

    def fill(p: PlaylistRec) -> list[str]:
        if p.kind != "folder":
            return p.paths
        got: dict[str, None] = {}
        for c in children.get(p.key, []):
            got.update(dict.fromkeys(fill(c)))
        p.paths = list(got)
        return p.paths

    for p in playlists:
        if p.parent is None:
            fill(p)
    return playlists


# ------------------------------------------------------------------------------------------------- Serato

def _fields(buf: bytes, start: int = 0, end: int | None = None) -> Iterator[tuple[str, bytes]]:
    """Serato's tagged records: 4-byte ASCII tag, 4-byte big-endian length, payload (nested for o… tags)."""
    end = len(buf) if end is None else end
    pos = start
    while pos + 8 <= end:
        tag = buf[pos:pos + 4].decode("latin-1")
        n = int.from_bytes(buf[pos + 4:pos + 8], "big")
        body = buf[pos + 8:min(pos + 8 + n, end)]
        yield tag, body
        pos += 8 + n


def _utf16(b: bytes) -> str:
    return b.decode("utf-16-be", errors="replace").replace("\x00", "")


def serato_volume_root(serato_dir: Path) -> Path:
    """The drive a _Serato_ folder's paths are relative to: /Volumes/<drive> for an external one, else /."""
    parts = serato_dir.resolve().parts
    return Path(*parts[:3]) if len(parts) > 3 and parts[1] == "Volumes" else Path("/")


def _serato_path(volume: Path, rel: str) -> str:
    return nfc(rel if rel.startswith("/") else str(volume / rel))


def _duration(text: str | None) -> float | None:
    """Serato's tlen: "mm:ss.cc", "h:mm:ss" or seconds."""
    if not text:
        return None
    try:
        total = 0.0
        for part in text.strip().split(":"):
            total = total * 60 + float(part)
        return total or None
    except ValueError:
        return None


def read_serato_v2(serato_dir: Path) -> SourceRead:
    """``database V2`` and the crates in ``Subcrates`` (``Parent%%Child.crate`` nests). Raises ValueError if absent."""
    db = serato_dir / "database V2"
    if not db.is_file():
        raise ValueError("No Serato library here (no database V2).")
    volume = serato_volume_root(serato_dir)
    tracks: list[TrackRec] = []
    for tag, body in _fields(db.read_bytes()):
        if tag != "otrk":
            continue
        f = dict(_fields(body))
        rel = _utf16(f.get("pfil", b""))
        if not rel:
            continue
        path = _serato_path(volume, rel)
        if Path(path).suffix.lower() not in AUDIO_EXTS:
            continue
        text = lambda k: _clean(_utf16(f[k])) if k in f else None  # noqa: E731
        added = int.from_bytes(f["uadd"], "big") if len(f.get("uadd", b"")) == 4 else None
        tracks.append(TrackRec(path=path, title=text("tsng"), artist=text("tart"), album=text("talb"),
                               genre=text("tgen"), bpm=_float(text("tbpm")), key=text("tkey"),
                               duration_s=_duration(text("tlen")), added_at=_iso(added)))
    playlists: list[PlaylistRec] = []
    keys: set[str] = set()
    for crate in sorted((serato_dir / "Subcrates").glob("*.crate")):
        parts = [p for p in crate.stem.split("%%") if p]
        if not parts:
            continue
        for i in range(1, len(parts)):  # parents a crate file names but that have no file of their own
            k = "/".join(parts[:i])
            if k not in keys:
                keys.add(k)
                playlists.append(PlaylistRec(k, parts[i - 1], "/".join(parts[:i - 1]) or None, "crate"))
        paths = []
        for tag, body in _fields(crate.read_bytes()):
            if tag == "otrk":
                rel = _utf16(dict(_fields(body)).get("ptrk", b""))
                if rel:
                    paths.append(_serato_path(volume, rel))
        key = "/".join(parts)
        existing = next((p for p in playlists if p.key == key), None)
        if existing is not None:
            existing.paths = paths
        else:
            keys.add(key)
            playlists.append(PlaylistRec(key, parts[-1], "/".join(parts[:-1]) or None, "crate", paths))
    return SourceRead(tracks, playlists)


_SERATO4_NEEDS = {
    "asset": {"id", "location_id", "portable_id", "name", "artist", "album", "genre", "bpm", "key", "length_ms"},
    "connection": {"location_id", "database_uri"},
    "container": {"id", "parent_id", "name", "type", "space_id"},
    "space": {"id", "name"},
    "location_container": {"id", "container_id"},
    "container_asset": {"asset_id", "location_container_id", "list_order"},
}


def read_serato4(db: Path) -> SourceRead | None:
    """Serato DJ 4's library (master.sqlite), read from a copy; None when its layout isn't the one we know."""
    with tempfile.TemporaryDirectory(prefix="fvwks-serato-") as tmp:
        copy = Path(tmp) / "master.sqlite"
        for suffix in ("", "-wal"):
            src = db.with_name(db.name + suffix)
            if src.is_file():
                shutil.copyfile(src, copy.with_name(copy.name + suffix))
        con = sqlite3.connect(str(copy))
        try:
            return _read_serato4(con)
        except sqlite3.DatabaseError:
            return None
        finally:
            con.close()


def _read_serato4(con: sqlite3.Connection) -> SourceRead | None:
    for table, need in _SERATO4_NEEDS.items():
        have = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
        if not need <= have:
            return None
    roots: dict[int, Path] = {}
    for location_id, uri in con.execute("SELECT location_id, database_uri FROM connection"):
        uri = str(uri or "")
        if uri.endswith("/_Serato_/Library/location.sqlite"):
            roots[location_id] = Path(uri[: -len("/_Serato_/Library/location.sqlite")] or "/")
        elif uri.endswith("/root.sqlite"):
            roots[location_id] = Path("/")
    has_added = "time_added" in {r[1] for r in con.execute("PRAGMA table_info(asset)")}
    tracks: list[TrackRec] = []
    by_asset: dict[int, str] = {}
    rows = con.execute("SELECT id, location_id, portable_id, name, artist, album, genre, bpm, key, length_ms"
                       + (", time_added" if has_added else ", NULL") + " FROM asset ORDER BY id")
    for aid, loc, portable, name, artist, album, genre, bpm, key, length_ms, added in rows:
        if loc not in roots or not portable or str(portable).startswith("streaming://"):
            continue
        path = nfc(str(roots[loc] / str(portable).lstrip("/")))
        if Path(path).suffix.lower() not in AUDIO_EXTS:
            continue
        added_s = float(added) / (1000.0 if added and float(added) > 1e11 else 1.0) if added else None
        tracks.append(TrackRec(path=path, title=_clean(name), artist=_clean(artist), album=_clean(album),
                               genre=_clean(genre), bpm=_float(bpm), key=_clean(key),
                               duration_s=_float(length_ms) / 1000.0 if _float(length_ms) else None,
                               added_at=_iso(added_s)))
        by_asset[aid] = path
    crates = con.execute("""
        WITH RECURSIVE chain(id, name, parent_id, type, path) AS (
          SELECT c.id, c.name, c.parent_id, c.type, NULL FROM container c JOIN space s ON s.id = c.space_id
            WHERE c.type = 0 AND s.name = 'Serato Library' COLLATE NOCASE
          UNION ALL
          SELECT c.id, c.name, c.parent_id, c.type, COALESCE(chain.path || '/', '') || c.name
            FROM container c JOIN chain ON c.parent_id = chain.id)
        SELECT id, name, path, parent_id FROM chain WHERE type = 1 ORDER BY path""").fetchall()
    key_of = {cid: path for cid, _, path, _ in crates}
    playlists = []
    for cid, name, path, parent in crates:
        members = con.execute("""SELECT ca.asset_id FROM container_asset ca
                                 JOIN location_container lc ON lc.id = ca.location_container_id
                                 WHERE lc.container_id = ? ORDER BY ca.list_order, ca.rowid""", (cid,))
        paths = list(dict.fromkeys(by_asset[a] for (a,) in members if a in by_asset))
        playlists.append(PlaylistRec(path, _clean(name) or "Untitled", key_of.get(parent), "crate", paths))
    return SourceRead(tracks, playlists)


def read_serato(serato_dir: Path | None, serato4_db: Path | None) -> SourceRead:
    """Serato DJ 4's library when it's there and readable, else database V2 (with a note saying why)."""
    if serato4_db is not None and serato4_db.is_file():
        got = read_serato4(serato4_db)
        if got is not None:
            return got
        if serato_dir is None or not (serato_dir / "database V2").is_file():
            raise ValueError("This Serato library version isn't supported yet.")
        got = read_serato_v2(serato_dir)
        got.note = "This Serato library version isn't supported yet: read from database V2 instead."
        return got
    if serato_dir is None:
        raise ValueError("No Serato library found.")
    return read_serato_v2(serato_dir)
