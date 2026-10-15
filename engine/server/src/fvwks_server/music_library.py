"""The library wheel's index (S3, contracts v1.1): the user's libraries (a music folder, a rekordbox.xml, Serato)
indexed in the engine's SQLite, so a 10k-track library pages and searches instantly after its first scan; their art
and ~20 s previews made on demand and cached. music_sources.py reads the libraries.

Paths stay inside: the app sees ids, names and file names only. A source's location comes from main (the user's pick
in the native dialog) or is Serato's standard folder. Scans run on a background thread each (a source shows
``scanning`` the first time; later rescans keep serving the old index until the new one is in). On engine start every
source refreshes in the background: a folder re-stats its files (tags are read again only for changed ones), a
Rekordbox or Serato library re-reads when its files changed.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from fvwks_contracts.models import LibraryPlaylist, LibrarySource, LibraryTrack, LibraryTrackPage

from .errors import ApiException, NotFound
from .library import Library, new_id, utcnow
from .music import parse_key
from . import music_sources as ms

log = logging.getLogger("fvwks.engine")

SF_EXTS = frozenset({".wav", ".aif", ".aiff", ".flac", ".mp3", ".ogg"})  # libsndfile; the rest go through afconvert
AFCONVERT = "/usr/bin/afconvert"  # macOS's own: AAC, M4A, ALAC
SIPS = "/usr/bin/sips"  # macOS's own: the art thumbnails
ART_PX = 512
PREVIEW_S = 20.0
PREVIEW_AT = 0.4  # of the way in: usually near the drop
PREVIEW_KEEP = 40
ART_BUDGET = 256 << 20
SORTS = {
    "added": "t.added_at IS NULL, t.added_at DESC, t.seq",
    "title": "t.title COLLATE NOCASE, t.seq",
    "artist": "t.artist IS NULL, t.artist COLLATE NOCASE, t.title COLLATE NOCASE, t.seq",
    "bpm": "t.bpm IS NULL, t.bpm, t.title COLLATE NOCASE, t.seq",
}
REFUSED_FOLDERS = {Path("/"), Path("/System"), Path("/Users"), Path("/Volumes"), Path("/Library"), Path("/Applications")}


def _stable(prefix: str, *parts: str) -> str:
    """An id that survives rescans (its source and its path or playlist key)."""
    return f"{prefix}_" + hashlib.sha1("\0".join(parts).encode("utf-8", "surrogatepass")).hexdigest()[:16]


def _stamp(paths: list[Path]) -> list[float | None]:
    out = []
    for p in paths:
        try:
            out.append(p.stat().st_mtime)
        except OSError:
            out.append(None)
    return out


def afconvert_wav(src: Path, dst: Path, bits: int = 24) -> None:
    """Decode what libsndfile can't (AAC, M4A, ALAC) with macOS's afconvert into a WAV."""
    try:
        subprocess.run([AFCONVERT, "-f", "WAVE", "-d", f"LEI{bits}", str(src), str(dst)], check=True,
                       stdin=subprocess.DEVNULL, capture_output=True, timeout=180)
    except (OSError, subprocess.SubprocessError) as exc:
        raise ApiException(400, "unsupported_format", f"Couldn't read {src.name} as audio.",
                           hint="Use WAV, AIFF, FLAC, MP3 or M4A.") from exc


class MusicLibrary:
    def __init__(self, library: Library, data_dir: Path):
        self.library = library
        self.root = data_dir / "library"
        self.art_dir = self.root / "art"
        self.preview_dir = self.root / "previews"
        for d in (self.art_dir, self.preview_dir):
            d.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._scanning: set[str] = set()
        self._closing = threading.Event()

    # ------------------------------------------------------------------ sources
    def _source(self, source_id: str) -> tuple[LibrarySource, dict[str, Any]]:
        rows = self.library.query("SELECT info, config FROM lib_sources WHERE id = ?", (source_id,))
        if not rows:
            raise NotFound("library source", source_id)
        return LibrarySource.model_validate_json(rows[0]["info"]), json.loads(rows[0]["config"])

    def _save(self, src: LibrarySource, config: dict[str, Any] | None = None) -> LibrarySource:
        with self.library.transaction() as c:
            if config is None:
                c.execute("UPDATE lib_sources SET info = ? WHERE id = ?", (src.model_dump_json(), src.id))
            elif not c.execute("UPDATE lib_sources SET info = ?, config = ? WHERE id = ?",
                               (src.model_dump_json(), json.dumps(config), src.id)).rowcount:
                # a plain INSERT (never INSERT OR REPLACE: its delete would cascade to the source's index)
                c.execute("INSERT INTO lib_sources (id, kind, created_at, config, info) VALUES (?, ?, ?, ?, ?)",
                          (src.id, src.kind, src.created_at, json.dumps(config), src.model_dump_json()))
        return src

    def sources(self) -> list[LibrarySource]:
        return [LibrarySource.model_validate_json(r["info"])
                for r in self.library.query("SELECT info FROM lib_sources ORDER BY created_at, id")]

    def _existing(self, kind: str, config: dict[str, Any]) -> LibrarySource | None:
        for r in self.library.query("SELECT info, config FROM lib_sources WHERE kind = ?", (kind,)):
            if {k: v for k, v in json.loads(r["config"]).items() if k != "stamp"} == config:
                return LibrarySource.model_validate_json(r["info"])
        return None

    def add(self, kind: str, path: str) -> LibrarySource:
        """A library the user picked in main's native dialog (main only: the route checks)."""
        bad = lambda msg, hint=None: ApiException(400, "invalid_library", msg, hint=hint)  # noqa: E731
        raw = Path(path).expanduser()
        if not raw.is_absolute():
            raise bad("That isn't a full path.")
        try:
            p = raw.resolve(strict=True)
        except (OSError, RuntimeError):
            raise bad("That folder or file isn't there.") from None
        if kind == "folder":
            if not p.is_dir() or p in REFUSED_FOLDERS:
                raise bad("Pick a music folder, e.g. Music.")
            config, name = {"path": str(p)}, p.name or str(p)
        elif kind == "rekordbox":
            if not p.is_file() or p.suffix.lower() != ".xml" or p.stat().st_size > ms.MAX_XML_BYTES:
                raise bad("Pick the rekordbox.xml you exported.", "In Rekordbox: File → Export Collection in xml format.")
            with p.open("rb") as f:
                if b"<DJ_PLAYLISTS" not in f.read(1 << 16):
                    raise bad("That XML isn't a Rekordbox collection.", "In Rekordbox: File → Export Collection in xml format.")
            config, name = {"path": str(p)}, "Rekordbox" if p.stem.lower() == "rekordbox" else f"Rekordbox · {p.stem}"
        else:
            if not p.is_dir() or not (p / "database V2").is_file():
                raise bad("That isn't a Serato library.", "Pick the _Serato_ folder on the drive.")
            root = ms.serato_volume_root(p)
            config, name = {"serato_dir": str(p), "serato4_db": None}, "Serato" if root == Path("/") else f"Serato · {root.name}"
        return self._create(kind, config, name)

    def add_serato(self) -> LibrarySource:
        """Serato's standard library on this Mac (~/Music/_Serato_, Serato DJ 4's master.sqlite): no path from the app."""
        serato_dir = ms.SERATO_DIR if (ms.SERATO_DIR / "database V2").is_file() else None
        serato4 = ms.SERATO4_DB if ms.SERATO4_DB.is_file() else None
        if serato_dir is None and serato4 is None:
            raise ApiException(404, "serato_not_found", "No Serato library on this Mac.",
                               hint="On an external drive? Add its _Serato_ folder in Settings → Library.")
        config = {"serato_dir": str(serato_dir) if serato_dir else None, "serato4_db": str(serato4) if serato4 else None}
        return self._create("serato", config, "Serato")

    def _create(self, kind: str, config: dict[str, Any], name: str) -> LibrarySource:
        found = self._existing(kind, config)
        if found is not None:
            return found
        src = LibrarySource(id=new_id("lsrc"), kind=kind, name=name, state="scanning", created_at=utcnow())
        self._save(src, config)
        self._scan_later(src.id)
        return src

    def remove(self, source_id: str) -> None:
        self._source(source_id)
        with self.library.transaction() as c:  # the index only: the user's files are never touched
            c.execute("DELETE FROM lib_sources WHERE id = ?", (source_id,))

    def rescan(self, source_id: str) -> LibrarySource:
        src, _ = self._source(source_id)
        self._scan_later(source_id, force=True)
        return src

    def start(self) -> None:
        """Every source refreshes in the background (an interrupted first scan runs again)."""
        for src in self.sources():
            self._scan_later(src.id)

    def close(self) -> None:
        self._closing.set()

    # ------------------------------------------------------------------ scanning
    def _scan_later(self, source_id: str, force: bool = False) -> None:
        with self._lock:
            if source_id in self._scanning:
                return
            self._scanning.add(source_id)
        threading.Thread(target=self._scan_guarded, args=(source_id, force), name=f"library-scan-{source_id}",
                         daemon=True).start()

    def _scan_guarded(self, source_id: str, force: bool) -> None:
        try:
            self.scan(source_id, force)
        except NotFound:
            pass  # removed meanwhile
        except Exception:  # noqa: BLE001  a scan must never take the engine down
            log.exception("library scan failed")
        finally:
            with self._lock:
                self._scanning.discard(source_id)

    def scan(self, source_id: str, force: bool = True) -> LibrarySource:
        """Read the source and replace its index (synchronously: the background thread and the tests call this)."""
        src, config = self._source(source_id)
        files = self._watched(src.kind, config)
        stamp = _stamp(files)
        if not force and src.kind != "folder" and src.state == "ready" and config.get("stamp") == stamp:
            return src
        try:
            if src.kind == "folder":
                read = ms.read_folder(Path(config["path"]), self._known(source_id))
            elif src.kind == "rekordbox":
                read = ms.read_rekordbox(Path(config["path"]))
            else:
                read = ms.read_serato(Path(config["serato_dir"]) if config.get("serato_dir") else None,
                                      Path(config["serato4_db"]) if config.get("serato4_db") else None)
        except (OSError, ValueError) as exc:
            log.warning("library %s (%s) unreadable: %s", source_id, src.kind, exc)
            src = src.model_copy(update={"state": "error", "message": str(exc) if isinstance(exc, ValueError)
                                         else "Couldn't read it (moved, or its drive is unplugged?)."})
            return self._save(src)
        if self._closing.is_set():
            return src
        tracks, playlists = self._store(source_id, src.kind, read)
        src = src.model_copy(update={"state": "ready", "tracks": tracks, "playlists": playlists,
                                     "scanned_at": utcnow(), "message": read.note})
        self._source(source_id)  # still there?
        return self._save(src, {**config, "stamp": stamp})

    @staticmethod
    def _watched(kind: str, config: dict[str, Any]) -> list[Path]:
        if kind == "rekordbox":
            return [Path(config["path"])]
        if kind == "serato":
            out = []
            if config.get("serato_dir"):
                d = Path(config["serato_dir"])
                out += [d / "database V2", d / "Subcrates"]
            if config.get("serato4_db"):
                db = Path(config["serato4_db"])
                out += [db, db.with_name(db.name + "-wal")]
            return out
        return []

    def _known(self, source_id: str) -> dict[str, ms.TrackRec]:
        rows = self.library.query("SELECT * FROM lib_tracks WHERE source_id = ?", (source_id,))
        return {r["path"]: ms.TrackRec(path=r["path"], title=r["title"], artist=r["artist"], album=r["album"],
                                       genre=r["genre"], bpm=r["bpm"], key=r["key"], duration_s=r["duration_s"],
                                       added_at=r["added_at"], has_art=None if r["has_art"] is None else bool(r["has_art"]),
                                       mtime=r["mtime"], size=r["size"]) for r in rows}

    def _store(self, source_id: str, kind: str, read: ms.SourceRead) -> tuple[int, int]:
        art_known = {r["path"]: r["has_art"] for r in self.library.query(
            "SELECT path, has_art FROM lib_tracks WHERE source_id = ? AND has_art IS NOT NULL", (source_id,))}
        ids: dict[str, str] = {}
        rows = []
        for t in read.tracks:
            if t.path in ids:
                continue
            tid = ids[t.path] = _stable("lt", source_id, t.path)
            name = os.path.basename(t.path)
            title = t.title or os.path.splitext(name)[0]  # untitled: its file name, for sorting and showing
            search = " ".join(x for x in (title, t.artist, t.album, t.genre, name) if x).casefold()
            missing = kind != "folder" and not os.path.isfile(t.path)
            has_art = t.has_art if t.has_art is not None else art_known.get(t.path)
            extra = json.dumps({"tempo": t.tempo, "marks": t.marks}) if (t.tempo or t.marks) else None
            rows.append((tid, source_id, len(rows), t.path, title, t.artist, t.album, t.genre, t.bpm, t.key,
                         t.duration_s, t.added_at, has_art, int(missing), t.mtime, t.size, search, extra))
        pls, members = [], []
        keys = {p.key: _stable("lpl", source_id, p.key) for p in read.playlists}
        for i, p in enumerate(read.playlists):
            pid = keys[p.key]
            order = list(dict.fromkeys(ids[x] for x in p.paths if x in ids))
            pls.append((pid, source_id, i, p.name, keys.get(p.parent) if p.parent else None, p.kind, len(order)))
            members += [(pid, pos, tid) for pos, tid in enumerate(order)]
        with self.library.transaction() as c:
            c.execute("DELETE FROM lib_tracks WHERE source_id = ?", (source_id,))
            c.execute("DELETE FROM lib_playlists WHERE source_id = ?", (source_id,))  # their members cascade
            c.executemany("INSERT INTO lib_tracks (id, source_id, seq, path, title, artist, album, genre, bpm, key, "
                          "duration_s, added_at, has_art, missing, mtime, size, search, extra) "
                          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
            c.executemany("INSERT INTO lib_playlists (id, source_id, seq, name, parent_id, kind, track_count) "
                          "VALUES (?, ?, ?, ?, ?, ?, ?)", pls)
            c.executemany("INSERT INTO lib_playlist_tracks (playlist_id, pos, track_id) VALUES (?, ?, ?)", members)
        return len(rows), len(pls)

    # ------------------------------------------------------------------ browsing
    def playlists(self, source_id: str) -> list[LibraryPlaylist]:
        self._source(source_id)
        return [LibraryPlaylist(id=r["id"], source_id=source_id, name=r["name"], parent_id=r["parent_id"],
                                kind=r["kind"], track_count=r["track_count"])
                for r in self.library.query("SELECT * FROM lib_playlists WHERE source_id = ? ORDER BY seq", (source_id,))]

    def tracks(self, source_id: str | None = None, playlist_id: str | None = None, q: str | None = None,
               sort: str | None = None, offset: int = 0, limit: int = 100) -> LibraryTrackPage:
        where, params, frm = [], [], "lib_tracks t"
        if playlist_id:
            rows = self.library.query("SELECT source_id FROM lib_playlists WHERE id = ?", (playlist_id,))
            if not rows:
                raise NotFound("playlist", playlist_id)
            frm = "lib_playlist_tracks pt JOIN lib_tracks t ON t.id = pt.track_id"
            where.append("pt.playlist_id = ?")
            params.append(playlist_id)
        if source_id:
            self._source(source_id)
            where.append("t.source_id = ?")
            params.append(source_id)
        for word in (q or "").casefold().split()[:8]:
            where.append("t.search LIKE ? ESCAPE '\\'")
            params.append("%" + word.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
        cond = f" WHERE {' AND '.join(where)}" if where else ""
        order = SORTS[sort] if sort in SORTS else ("pt.pos" if playlist_id else SORTS["added"])
        total = self.library.query(f"SELECT COUNT(*) AS n FROM {frm}{cond}", params)[0]["n"]
        rows = self.library.query(f"SELECT t.* FROM {frm}{cond} ORDER BY {order} LIMIT ? OFFSET ?",
                                  [*params, max(1, min(10_000, limit)), max(0, offset)])
        return LibraryTrackPage(total=total, offset=max(0, offset), items=[self._track(r) for r in rows])

    @staticmethod
    def _track(r: Any) -> LibraryTrack:
        name = os.path.basename(r["path"])
        try:
            key = parse_key(r["key"]) if r["key"] else None
        except ValueError:
            key = None
        return LibraryTrack(
            id=r["id"], source_id=r["source_id"], title=r["title"] or os.path.splitext(name)[0], artist=r["artist"],
            album=r["album"], genre=r["genre"], bpm=round(r["bpm"], 2) if r["bpm"] else None,
            key=key.name if key else r["key"], camelot=key.camelot if key else None,
            duration_s=round(r["duration_s"], 3) if r["duration_s"] else None, file_name=name,
            format=os.path.splitext(name)[1].lstrip(".").lower(), missing=bool(r["missing"]),
            has_art=None if r["has_art"] is None else bool(r["has_art"]), added_at=r["added_at"])

    def track_row(self, track_id: str) -> Any:
        rows = self.library.query("SELECT * FROM lib_tracks WHERE id = ?", (track_id,))
        if not rows:
            raise NotFound("library track", track_id)
        return rows[0]

    def track_file(self, track_id: str) -> tuple[Any, Path]:
        """The track's row and its audio file (a regular audio file, wherever it lives), or 404 track_missing."""
        row = self.track_row(track_id)
        f = ms.audio_file(row["path"])
        if f is None:
            raise ApiException(404, "track_missing", f"{os.path.basename(row['path'])} isn't there any more.",
                               hint="Moved, or its drive is unplugged? Rescan the library once it's back.")
        return row, f

    def _set_art(self, track_id: str, has: bool) -> None:
        with self.library.transaction() as c:
            c.execute("UPDATE lib_tracks SET has_art = ? WHERE id = ?", (int(has), track_id))

    # ------------------------------------------------------------------ art and previews
    def art(self, track_id: str) -> tuple[Path, str]:
        """The cover as a ≤ 512 px JPEG (sips), cached; 404 no_art for the neutral card."""
        row, f = self.track_file(track_id)
        st = f.stat()
        key = hashlib.sha1(f"art|{f}|{st.st_mtime}|{st.st_size}".encode("utf-8", "surrogatepass")).hexdigest()[:24]
        none = self.art_dir / f"{key}.none"
        for out, mime in ((self.art_dir / f"{key}.jpg", "image/jpeg"), (self.art_dir / f"{key}.png", "image/png")):
            if out.is_file():
                return out, mime
        if none.is_file():
            raise ApiException(404, "no_art", "This track has no artwork.")
        got = ms.read_art(f)
        if got is None:
            none.touch()
            self._set_art(track_id, False)
            raise ApiException(404, "no_art", "This track has no artwork.")
        data, mime = got
        out = self.art_dir / f"{key}.jpg"
        with tempfile.TemporaryDirectory(dir=self.root) as tmp:
            src = Path(tmp) / ("cover.png" if mime == "image/png" else "cover.jpg")
            src.write_bytes(data)
            try:
                subprocess.run([SIPS, "-Z", str(ART_PX), "-s", "format", "jpeg", str(src), "--out", str(out)], check=True,
                               stdin=subprocess.DEVNULL, capture_output=True, timeout=20)
            except (OSError, subprocess.SubprocessError):  # sips missing or the image odd: the original then
                out = self.art_dir / f"{key}{'.png' if mime == 'image/png' else '.jpg'}"
                shutil.copyfile(src, out)
                mime = "image/png" if mime == "image/png" else "image/jpeg"
            else:
                mime = "image/jpeg"
        self._set_art(track_id, True)
        self._prune(self.art_dir, budget=ART_BUDGET)
        return out, mime

    def preview(self, track_id: str) -> Path:
        """~20 s of the track from 40% in (earlier on a short one) as a 16-bit WAV, with 30 ms fades; cached."""
        _, f = self.track_file(track_id)
        st = f.stat()
        key = hashlib.sha1(f"preview|{f}|{st.st_mtime}|{st.st_size}".encode("utf-8", "surrogatepass")).hexdigest()[:24]
        out = self.preview_dir / f"{key}.wav"
        if out.is_file():
            return out
        audio, sr = decode(f, start_frac=PREVIEW_AT, seconds=PREVIEW_S)
        fade = min(audio.shape[-1] // 2, int(0.03 * sr))
        if fade > 0:
            ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
            audio[:, :fade] *= ramp
            audio[:, -fade:] *= ramp[::-1]
        part = out.with_suffix(".part.wav")
        sf.write(str(part), audio.T, sr, subtype="PCM_16")
        part.replace(out)
        self._prune(self.preview_dir, keep=PREVIEW_KEEP)
        return out

    @staticmethod
    def _prune(folder: Path, keep: int | None = None, budget: int | None = None) -> None:
        """Oldest first, past `keep` files or `budget` bytes. ponytail: a full listing each time; fine at these sizes."""
        files = sorted((p for p in folder.iterdir() if p.is_file()), key=lambda p: p.stat().st_mtime, reverse=True)
        total = 0
        for i, p in enumerate(files):
            total += p.stat().st_size
            if (keep is not None and i >= keep) or (budget is not None and total > budget):
                p.unlink(missing_ok=True)


def decode(path: Path, start_frac: float | None = None, seconds: float | None = None) -> tuple[np.ndarray, int]:
    """(channels-first float32, rate) of an audio file, or the `seconds` from `start_frac` of the way in (pulled
    earlier so it ends by the end); mono or stereo (the first two channels of more)."""
    def excerpt(p: Path) -> tuple[np.ndarray, int]:
        with sf.SoundFile(str(p)) as f:
            sr, n = f.samplerate, f.frames
            if seconds is not None and n > 0:
                want = int(seconds * sr)
                start = max(0, min(int((start_frac or 0.0) * n), n - want))
                f.seek(start)
                data = f.read(min(want, n - start), dtype="float32", always_2d=True)
            else:
                data = f.read(dtype="float32", always_2d=True)
        return np.ascontiguousarray(data.T[:2]), int(sr)

    if path.suffix.lower() in SF_EXTS:
        try:
            return excerpt(path)
        except Exception:  # noqa: BLE001  libsndfile couldn't: afconvert may
            pass
    with tempfile.TemporaryDirectory(prefix="fvwks-decode-") as tmp:
        wav = Path(tmp) / "decoded.wav"
        afconvert_wav(path, wav, bits=16 if seconds is not None else 24)
        try:
            return excerpt(wav)
        except Exception as exc:  # noqa: BLE001
            raise ApiException(400, "unsupported_format", f"Couldn't read {path.name} as audio.") from exc
