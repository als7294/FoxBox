"""Library (owned by S3): SQLite for sources, renders, takes, exports, user presets, personas and settings, plus a
content-addressed artifact cache (hash of a request → the artifact it produced).

Rows hold the contract model as JSON (``info``/``data``) next to a few indexed columns used for lookups, so the
HTTP layer validates them straight back into ``SourceInfo``, ``RenderInfo``, ``ExportedFile`` and friends. One
connection guarded by a lock serves the API threads and the job runner.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Iterable, Iterator

import numpy as np

SCHEMA_VERSION = 3

_SCHEMA_V1 = """
CREATE TABLE sources (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,                -- tts | recording | import
  created_at     TEXT NOT NULL,
  request_hash   TEXT,                         -- content address of the TTS request (cache key)
  audio_hash     TEXT,                         -- content address of the audio (render cache, WORLD analysis)
  audio_id       TEXT NOT NULL,                -- key in the audio store
  analysis_state TEXT NOT NULL DEFAULT 'none', -- none | queued | running | done | error
  request        TEXT NOT NULL DEFAULT '{}',   -- the TTSRequest that made it (TTS sources)
  info           TEXT NOT NULL                 -- SourceInfo JSON
);
CREATE INDEX sources_request_hash ON sources(request_hash);
CREATE INDEX sources_created ON sources(created_at);

CREATE TABLE renders (                         -- every render; previews are pruned, finals are kept
  id             TEXT PRIMARY KEY,
  source_id      TEXT,                         -- renders outlive their source
  created_at     TEXT NOT NULL,
  quality        TEXT NOT NULL,                -- preview | final
  request_hash   TEXT,
  request        TEXT NOT NULL,                -- the filled RenderRequest fx.render received
  info           TEXT NOT NULL,                -- RenderInfo JSON
  audio          TEXT NOT NULL DEFAULT '{}',   -- {"wet": id, "dry": id, "stems": {name: id}}
  meta           TEXT NOT NULL DEFAULT '{}'    -- script, source name/kind, voice, preset name (for tags)
);
CREATE INDEX renders_request_hash ON renders(request_hash);
CREATE INDEX renders_created ON renders(created_at);

CREATE TABLE takes (                           -- the Vault: one per final render
  id             TEXT PRIMARY KEY,
  render_id      TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  title          TEXT NOT NULL,
  starred        INTEGER NOT NULL DEFAULT 0,
  tags           TEXT NOT NULL DEFAULT '[]',
  script         TEXT,
  preset_id      TEXT,
  data           TEXT NOT NULL DEFAULT '{}'    -- source_kind, voice_id, preset_name
);
CREATE INDEX takes_render ON takes(render_id);
CREATE INDEX takes_created ON takes(created_at);

CREATE TABLE exports (
  id             TEXT PRIMARY KEY,
  render_id      TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  path           TEXT NOT NULL,                -- absolute, inside the export root
  info           TEXT NOT NULL                 -- ExportedFile JSON
);
CREATE INDEX exports_render ON exports(render_id);

CREATE TABLE presets (                         -- user presets (factory presets ship with fvwks_fx)
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  data           TEXT NOT NULL                 -- Preset JSON
);

CREATE TABLE personas (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  data           TEXT NOT NULL                 -- Voice JSON plus the reference audio id
);

CREATE TABLE settings (
  key            TEXT PRIMARY KEY,
  value          TEXT NOT NULL                 -- JSON
);

CREATE TABLE cache (
  key            TEXT PRIMARY KEY,             -- request_hash(kind, payload, salt)
  kind           TEXT NOT NULL,                -- tts | stack | render | analysis | ...
  artifact_id    TEXT,                         -- id of the row/audio the request produced, if any
  path           TEXT,                         -- artifact file relative to the cache root, if any
  bytes          INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  last_used_at   TEXT NOT NULL,
  hits           INTEGER NOT NULL DEFAULT 0,
  meta           TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX cache_lru ON cache(last_used_at);
"""

_SCHEMA_V2 = """
ALTER TABLE sources ADD COLUMN used_at TEXT;    -- last TTS cache hit or render; GC keeps the recently used
CREATE INDEX sources_used ON sources(used_at);
CREATE INDEX renders_source ON renders(source_id);
"""

_SCHEMA_V3 = """
ALTER TABLE sources ADD COLUMN transcript_state TEXT NOT NULL DEFAULT 'none';  -- none | queued | running | done | error
"""

_MIGRATIONS = {1: _SCHEMA_V1, 2: _SCHEMA_V2, 3: _SCHEMA_V3}

# Columns stored as JSON text, per table, with their empty value.
_JSON_COLUMNS: dict[str, dict[str, Any]] = {
    "sources": {"request": {}, "info": {}},
    "renders": {"request": {}, "info": {}, "audio": {}, "meta": {}},
    "takes": {"tags": [], "data": {}},
    "exports": {"info": {}},
    "presets": {"data": {}},
    "personas": {"data": {}},
    "cache": {"meta": {}},
}
_BOOL_COLUMNS = {"takes": {"starred"}}
_ID_PREFIX = {"sources": "src", "renders": "rnd", "takes": "tak", "exports": "exp", "presets": "pre",
              "personas": "per", "cache": "cch"}
TABLES = tuple(_JSON_COLUMNS)


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


# ------------------------------------------------------------------------------------------- hashing


def canonical(obj: Any) -> Any:
    """Normalise a request for hashing: pydantic/dataclass → dict, numpy → Python, and float noise removed
    (integral floats become ints, others keep 12 significant digits), so ``-9`` and ``-9.0`` hash alike."""
    if hasattr(obj, "model_dump"):
        return canonical(obj.model_dump(mode="json"))
    if is_dataclass(obj) and not isinstance(obj, type):
        return canonical(asdict(obj))
    if isinstance(obj, Enum):
        return canonical(obj.value)
    if isinstance(obj, dict):
        return {str(k): canonical(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set, frozenset)):
        items = [canonical(v) for v in obj]
        return sorted(items, key=json.dumps) if isinstance(obj, (set, frozenset)) else items
    if isinstance(obj, np.ndarray):
        return canonical(obj.tolist())
    if isinstance(obj, np.generic):
        return canonical(obj.item())
    if isinstance(obj, bool) or obj is None or isinstance(obj, str):
        return obj
    if isinstance(obj, int):
        return obj
    if isinstance(obj, float):
        if not math.isfinite(obj):
            return repr(obj)
        if obj.is_integer():
            return int(obj)
        return float(f"{obj:.12g}")
    if isinstance(obj, Path):
        return obj.as_posix()
    return str(obj)


def request_hash(kind: str, payload: Any, salt: str = "") -> str:
    """Content address of a request. ``salt`` carries engine/model versions so upgrades miss the cache."""
    blob = json.dumps({"kind": kind, "salt": salt, "payload": canonical(payload)},
                      sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def audio_hash(audio: np.ndarray, sample_rate: int) -> str:
    """Content address of an audio buffer (float32 samples, shape and rate)."""
    a = np.ascontiguousarray(audio, dtype=np.float32)
    h = hashlib.sha256()
    h.update(f"{a.shape}|{int(sample_rate)}|".encode())
    h.update(a.tobytes())
    return h.hexdigest()


# ------------------------------------------------------------------------------------------- library


class Library:
    def __init__(self, db_path: Path | str):
        memory = str(db_path) == ":memory:"
        self.db_path = Path(db_path)
        if not memory:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            if not memory:
                self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA foreign_keys=ON")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.execute("PRAGMA busy_timeout=5000")
            self._migrate()
            self._columns = {t: {r["name"] for r in self._conn.execute(f"PRAGMA table_info({t})")}
                             for t in (*TABLES, "settings")}

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def _migrate(self) -> None:
        current = self._conn.execute("PRAGMA user_version").fetchone()[0]
        if current > SCHEMA_VERSION:
            raise RuntimeError(f"library schema v{current} is newer than this engine (v{SCHEMA_VERSION})")
        for version in range(current + 1, SCHEMA_VERSION + 1):
            with self.transaction():
                self._exec_script(_MIGRATIONS[version])
                self._conn.execute(f"PRAGMA user_version={version}")

    def _exec_script(self, script: str) -> None:
        # executescript() would COMMIT the open transaction; run the statements one by one instead.
        statement = ""
        for line in script.splitlines(keepends=True):
            statement += line
            if sqlite3.complete_statement(statement):
                self._conn.execute(statement)
                statement = ""
        if statement.strip():
            raise ValueError(f"incomplete SQL statement in migration: {statement.strip()[:60]}")

    @property
    def schema_version(self) -> int:
        with self._lock:
            return self._conn.execute("PRAGMA user_version").fetchone()[0]

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            self._conn.execute("COMMIT")

    # -- rows ---------------------------------------------------------------------------------------

    def _check_table(self, table: str) -> None:
        if table not in _JSON_COLUMNS:
            raise KeyError(f"unknown table {table!r}")

    def _encode(self, table: str, row: dict[str, Any]) -> dict[str, Any]:
        unknown = set(row) - self._columns[table]
        if unknown:
            raise KeyError(f"unknown {table} column(s): {sorted(unknown)}")
        out = dict(row)
        for col, empty in _JSON_COLUMNS.get(table, {}).items():
            if col in out:
                out[col] = json.dumps(canonical(out[col] if out[col] is not None else empty), ensure_ascii=False)
        for col in _BOOL_COLUMNS.get(table, ()):
            if col in out:
                out[col] = int(bool(out[col]))
        return out

    def _decode(self, table: str, row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        out = dict(row)
        for col, empty in _JSON_COLUMNS.get(table, {}).items():
            if col in out:
                out[col] = json.loads(out[col]) if out[col] else empty
        for col in _BOOL_COLUMNS.get(table, ()):
            if col in out:
                out[col] = bool(out[col])
        return out

    def insert(self, table: str, **fields: Any) -> dict[str, Any]:
        """Insert a row; ``id`` and ``created_at`` default to a fresh id and now."""
        self._check_table(table)
        fields.setdefault("id", new_id(_ID_PREFIX[table]))
        if "created_at" in self._columns[table]:
            fields.setdefault("created_at", utcnow())
        enc = self._encode(table, fields)
        with self._lock:
            self._conn.execute(f"INSERT INTO {table} ({', '.join(enc)}) VALUES ({', '.join('?' * len(enc))})",
                               list(enc.values()))
        return self.get(table, fields["id"])

    def get(self, table: str, row_id: str) -> dict[str, Any] | None:
        self._check_table(table)
        with self._lock:
            row = self._conn.execute(f"SELECT * FROM {table} WHERE id = ?", (row_id,)).fetchone()
        return self._decode(table, row)

    def update(self, table: str, row_id: str, **patch: Any) -> dict[str, Any] | None:
        self._check_table(table)
        if patch:
            enc = self._encode(table, patch)
            with self._lock:
                self._conn.execute(f"UPDATE {table} SET {', '.join(f'{c} = ?' for c in enc)} WHERE id = ?",
                                   [*enc.values(), row_id])
        return self.get(table, row_id)

    def delete(self, table: str, ids: Iterable[str]) -> list[dict[str, Any]]:
        """Delete rows by id and return them (so the caller can drop their files)."""
        self._check_table(table)
        removed = []
        with self.transaction():
            for row_id in ids:
                row = self.get(table, row_id)
                if row is not None:
                    self._conn.execute(f"DELETE FROM {table} WHERE id = ?", (row_id,))
                    removed.append(row)
        return removed

    def select(self, table: str, where: str = "", params: Iterable[Any] = (), order: str = "created_at DESC, rowid DESC",
               limit: int | None = None, offset: int = 0) -> list[dict[str, Any]]:
        """Rows matching a parameterised ``where`` (column names come from code, never from requests)."""
        self._check_table(table)
        sql = f"SELECT * FROM {table}" + (f" WHERE {where}" if where else "") + (f" ORDER BY {order}" if order else "")
        if limit is not None:
            sql += f" LIMIT {int(limit)} OFFSET {int(offset)}"
        with self._lock:
            rows = self._conn.execute(sql, list(params)).fetchall()
        return [self._decode(table, r) for r in rows]

    def count(self, table: str, where: str = "", params: Iterable[Any] = ()) -> int:
        self._check_table(table)
        with self._lock:
            return self._conn.execute(f"SELECT COUNT(*) FROM {table}" + (f" WHERE {where}" if where else ""),
                                      list(params)).fetchone()[0]

    def by_ids(self, table: str, ids: Iterable[str]) -> list[dict[str, Any]]:
        """Rows in the order of ``ids``; missing ids are skipped."""
        ids = list(ids)
        if not ids:
            return []
        rows = {r["id"]: r for r in self.select(table, f"id IN ({', '.join('?' * len(ids))})", ids, order="")}
        return [rows[i] for i in ids if i in rows]

    def find(self, table: str, column: str, value: Any) -> dict[str, Any] | None:
        """Newest row whose ``column`` equals ``value``."""
        if column not in self._columns.get(table, ()):
            raise KeyError(f"unknown {table} column {column!r}")
        rows = self.select(table, f"{column} = ?", (value,), limit=1)
        return rows[0] if rows else None

    # -- takes (the Vault) --------------------------------------------------------------------------

    def query_takes(self, *, q: str | None = None, starred: bool | None = None, preset_id: str | None = None,
                    limit: int = 50, offset: int = 0) -> tuple[list[dict[str, Any]], int]:
        where, params = [], []
        if q:
            like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            where.append("(title LIKE ? ESCAPE '\\' OR script LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')")
            params += [like, like, like]
        if starred is not None:
            where.append("starred = ?")
            params.append(int(starred))
        if preset_id:
            where.append("preset_id = ?")
            params.append(preset_id)
        clause = " AND ".join(where)
        return self.select("takes", clause, params, limit=limit, offset=offset), self.count("takes", clause, params)

    # -- housekeeping -------------------------------------------------------------------------------

    def reset_analysis_states(self) -> int:
        """Mark every source unanalysed (the analyses live in the fx process's memory). Returns rows changed."""
        with self._lock:
            return self._conn.execute("UPDATE sources SET analysis_state = 'none' WHERE analysis_state != 'none'").rowcount

    def reset_transcript_states(self) -> int:
        """Transcripts are stored, so only a transcription the last process never finished starts over."""
        with self._lock:
            return self._conn.execute(
                "UPDATE sources SET transcript_state = 'none' WHERE transcript_state IN ('queued', 'running')").rowcount

    def stale_tts_sources(self, keep: int) -> list[tuple[str, str]]:
        """(id, audio_id) of TTS sources outside the ``keep`` most recently used that no render references.

        Recordings and imports are never returned: they can't be re-created, so only the user deletes them.
        """
        sql = """
            SELECT id, audio_id FROM sources
            WHERE kind = 'tts'
              AND NOT EXISTS (SELECT 1 FROM renders WHERE renders.source_id = sources.id)
              AND id NOT IN (SELECT id FROM sources WHERE kind = 'tts'
                             ORDER BY COALESCE(used_at, created_at) DESC, rowid DESC LIMIT ?)
        """
        with self._lock:
            return [(r["id"], r["audio_id"]) for r in self._conn.execute(sql, (int(keep),)).fetchall()]

    # -- settings -----------------------------------------------------------------------------------

    def get_setting(self, key: str, default: Any = None) -> Any:
        with self._lock:
            row = self._conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def set_setting(self, key: str, value: Any) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, json.dumps(canonical(value), ensure_ascii=False)),
            )

    # -- cache index --------------------------------------------------------------------------------

    def cache_get(self, key: str, touch: bool = True) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM cache WHERE key = ?", (key,)).fetchone()
            if row is not None and touch:
                self._conn.execute("UPDATE cache SET last_used_at = ?, hits = hits + 1 WHERE key = ?",
                                   (utcnow(), key))
        return self._decode("cache", row)

    def cache_put(self, key: str, kind: str, *, artifact_id: str | None = None, path: str | None = None,
                  size: int = 0, meta: dict[str, Any] | None = None) -> dict[str, Any]:
        now = utcnow()
        with self._lock:
            self._conn.execute(
                "INSERT INTO cache (key, kind, artifact_id, path, bytes, created_at, last_used_at, meta) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, "
                "artifact_id = excluded.artifact_id, path = excluded.path, bytes = excluded.bytes, "
                "last_used_at = excluded.last_used_at, meta = excluded.meta",
                (key, kind, artifact_id, path, int(size), now, now, json.dumps(canonical(meta or {}))),
            )
        return self.cache_get(key, touch=False)

    def cache_delete(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            row = self.cache_get(key, touch=False)
            self._conn.execute("DELETE FROM cache WHERE key = ?", (key,))
        return row

    def cache_forget_artifact(self, artifact_id: str) -> None:
        """Drop index entries that point at a deleted row (e.g. a pruned preview render)."""
        with self._lock:
            self._conn.execute("DELETE FROM cache WHERE artifact_id = ?", (artifact_id,))

    def cache_entries(self, kind: str | None = None) -> list[dict[str, Any]]:
        """Entries oldest-used first (eviction order)."""
        sql, params = "SELECT * FROM cache", []
        if kind:
            sql, params = sql + " WHERE kind = ?", [kind]
        with self._lock:
            rows = self._conn.execute(sql + " ORDER BY last_used_at, key", params).fetchall()
        return [self._decode("cache", r) for r in rows]

    def cache_bytes(self) -> int:
        with self._lock:
            return int(self._conn.execute("SELECT COALESCE(SUM(bytes), 0) FROM cache").fetchone()[0])


# ------------------------------------------------------------------------------------------- artifacts


class ArtifactCache:
    """Content-addressed artifact files under ``root/<kind>/<key[:2]>/<key><suffix>``, indexed in the library.

    ``lookup`` returns None for misses and for entries whose file has vanished. ``prune`` evicts
    least-recently-used entries until the cache fits its byte budget.
    """

    def __init__(self, library: Library, root: Path, max_bytes: int = 1 << 30):
        self.library = library
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.max_bytes = max_bytes

    def path_for(self, kind: str, key: str, suffix: str = "") -> Path:
        if not key.isalnum() or not kind.replace("-", "").replace("_", "").isalnum():
            raise ValueError("cache kind/key must be alphanumeric")
        return self.root / kind / key[:2] / f"{key}{suffix}"

    def lookup(self, key: str) -> dict[str, Any] | None:
        entry = self.library.cache_get(key)
        if entry is None:
            return None
        if entry["path"] and not (self.root / entry["path"]).is_file():
            self.library.cache_delete(key)
            return None
        return entry

    def remember(self, kind: str, key: str, artifact_id: str, meta: dict[str, Any] | None = None) -> dict[str, Any]:
        """Index a request → artifact id mapping that has no file of its own (e.g. a render row)."""
        return self.library.cache_put(key, kind, artifact_id=artifact_id, meta=meta)

    def put_bytes(self, kind: str, key: str, data: bytes, suffix: str = ".bin", *,
                  artifact_id: str | None = None, meta: dict[str, Any] | None = None) -> Path:
        path = self.path_for(kind, key, suffix)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.part")
        tmp.write_bytes(data)
        os.replace(tmp, path)
        self.library.cache_put(key, kind, artifact_id=artifact_id, path=path.relative_to(self.root).as_posix(),
                               size=len(data), meta=meta)
        return path

    def get_bytes(self, key: str) -> bytes | None:
        entry = self.lookup(key)
        return (self.root / entry["path"]).read_bytes() if entry and entry["path"] else None

    def put_arrays(self, kind: str, key: str, arrays: dict[str, np.ndarray], *,
                   artifact_id: str | None = None, meta: dict[str, Any] | None = None) -> Path:
        """Store named numpy arrays (e.g. audio, or WORLD f0/sp/ap) as one .npz."""
        buf = io.BytesIO()
        np.savez(buf, **arrays)
        return self.put_bytes(kind, key, buf.getvalue(), ".npz", artifact_id=artifact_id, meta=meta)

    def get_arrays(self, key: str) -> dict[str, np.ndarray] | None:
        entry = self.lookup(key)
        if not entry or not entry["path"]:
            return None
        with np.load(self.root / entry["path"], allow_pickle=False) as data:
            return {name: data[name] for name in data.files}

    def evict(self, key: str) -> None:
        entry = self.library.cache_delete(key)
        if entry and entry["path"]:
            (self.root / entry["path"]).unlink(missing_ok=True)

    def prune(self, max_bytes: int | None = None, keep: Iterable[str] = ()) -> int:
        """Evict least-recently-used entries until the total fits; returns bytes freed."""
        budget = self.max_bytes if max_bytes is None else max_bytes
        total, freed, keep = self.library.cache_bytes(), 0, set(keep)
        for entry in self.library.cache_entries():
            if total <= budget:
                break
            if entry["key"] in keep or not entry["bytes"]:
                continue
            self.evict(entry["key"])
            total -= entry["bytes"]
            freed += entry["bytes"]
        return freed
