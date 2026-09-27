"""SQLite library and content-addressed cache helpers."""
import os
import time

import numpy as np
import pytest
from pydantic import BaseModel

from fvwks_server.library import SCHEMA_VERSION, ArtifactCache, Library, audio_hash, canonical, request_hash


@pytest.fixture
def lib(tmp_path):
    library = Library(tmp_path / "library.sqlite3")
    yield library
    library.close()


def test_schema_created_once(tmp_path):
    path = tmp_path / "db.sqlite3"
    first = Library(path)
    first.insert("sources", kind="tts", audio_id="src_000000000001", info={"script": "hello"})
    first.close()
    again = Library(path)  # reopening must not re-run migrations or lose rows
    assert again.schema_version == SCHEMA_VERSION
    tables = {r[0] for r in again._conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"sources", "renders", "takes", "exports", "presets", "personas", "settings", "cache"} <= tables
    assert again.count("sources") == 1
    again.close()


def test_documents_round_trip(lib):
    src = lib.insert("sources", kind="tts", audio_id="src_1", request_hash="h1",
                     info={"segments": [{"text": "WE ARE", "start_s": 0.0, "end_s": 0.8}]})
    assert src["id"].startswith("src_") and src["info"]["segments"][0]["end_s"] == 0.8
    assert lib.find("sources", "request_hash", "h1")["id"] == src["id"]
    assert lib.find("sources", "request_hash", "nope") is None
    lib.update("sources", src["id"], analysis_state="done")
    assert lib.get("sources", src["id"])["analysis_state"] == "done"

    render = lib.insert("renders", source_id=src["id"], quality="final", request={"arrange": {"bpm": 140}},
                        info={"id": "x"}, audio={"wet": "rnd_1", "dry": "dry_1", "stems": {}})
    assert render["id"].startswith("rnd_") and render["audio"]["wet"] == "rnd_1"
    e1 = lib.insert("exports", render_id=render["id"], path="/x/a.aiff", info={"variant": "wet"})
    e2 = lib.insert("exports", render_id=render["id"], path="/x/b.aiff", info={"variant": "dry"})
    assert [e["id"] for e in lib.by_ids("exports", [e2["id"], "exp_missing", e1["id"]])] == [e2["id"], e1["id"]]
    assert lib.by_ids("exports", []) == []
    assert len(lib.select("exports", "render_id = ?", (render["id"],))) == 2

    with pytest.raises(KeyError):
        lib.insert("takes", render_id="r", title="t", bogus=1)
    with pytest.raises(KeyError):
        lib.find("takes", "title; DROP TABLE takes", "x")
    with pytest.raises(KeyError):
        lib.get("sqlite_master", "x")
    assert [r["id"] for r in lib.delete("exports", [e1["id"], "exp_missing"])] == [e1["id"]]


def test_take_queries(lib):
    t1 = lib.insert("takes", render_id="rnd_1", title="WE ARE 100%_done", script="WE ARE | *US*", preset_id="pact",
                    tags=["intro"], data={"source_kind": "tts"})
    time.sleep(0.002)
    t2 = lib.insert("takes", render_id="rnd_2", title="Other", script="hands up", preset_id="legion")
    assert t1["starred"] is False and t1["tags"] == ["intro"]
    lib.update("takes", t1["id"], starred=True)
    assert lib.get("takes", t1["id"])["starred"] is True

    def ids(**kw):
        rows, total = lib.query_takes(**kw)
        assert total == len(rows) or kw.get("limit")
        return [r["id"] for r in rows]

    assert ids() == [t2["id"], t1["id"]]  # newest first
    assert ids(starred=True) == [t1["id"]] and ids(starred=False) == [t2["id"]]
    assert ids(preset_id="legion") == [t2["id"]]
    assert ids(q="100%_") == [t1["id"]]  # LIKE wildcards are escaped
    assert ids(q="intro") == [t1["id"]] and ids(q="HANDS") == [t2["id"]]
    rows, total = lib.query_takes(limit=1, offset=1)
    assert [r["id"] for r in rows] == [t1["id"]] and total == 2


def test_settings(lib):
    assert lib.get_setting("settings") is None and lib.get_setting("x", {"a": 1}) == {"a": 1}
    lib.set_setting("lexicon", {"entries": [{"word": "FVWKS", "say": "Fawkes"}]})
    lib.set_setting("lexicon", {"entries": []})
    assert lib.get_setting("lexicon") == {"entries": []}


class Req(BaseModel):
    pitch: float
    mode: str


def test_request_hash_is_canonical():
    a = request_hash("render", {"b": 1, "a": {"pitch": -9, "x": [1.0, 2.5]}})
    b = request_hash("render", {"a": {"x": [1, 2.5000000000001], "pitch": -9.0}, "b": 1.0})
    assert a == b
    assert a != request_hash("render", {"b": 1, "a": {"pitch": -8, "x": [1, 2.5]}})
    assert a != request_hash("tts", {"b": 1, "a": {"pitch": -9, "x": [1.0, 2.5]}})
    assert a != request_hash("render", {"b": 1, "a": {"pitch": -9, "x": [1.0, 2.5]}}, salt="fx-0.2")
    assert canonical(Req(pitch=-9.0, mode="x")) == {"pitch": -9, "mode": "x"}
    assert canonical({"n": np.float32(0.5), "arr": np.arange(3), "flag": np.bool_(True)}) == \
        {"n": 0.5, "arr": [0, 1, 2], "flag": True}
    assert canonical(True) is True and canonical({3, 1}) == [1, 3]
    audio = np.ones((2, 100), np.float32)
    assert audio_hash(audio, 48000) == audio_hash(audio.astype(np.float64), 48000)
    assert audio_hash(audio, 48000) != audio_hash(audio, 44100)


def test_artifact_cache(lib, tmp_path):
    cache = ArtifactCache(lib, tmp_path / "cache", max_bytes=10_000)
    key = request_hash("analysis", {"audio": "abc"})
    assert cache.lookup(key) is None
    f0 = np.linspace(80, 120, 50)
    path = cache.put_arrays("analysis", key, {"f0": f0, "sp": np.ones((50, 4))}, meta={"frame_ms": 5})
    assert path.is_file() and path.parent.name == key[:2]
    back = cache.get_arrays(key)
    assert np.array_equal(back["f0"], f0) and back["sp"].shape == (50, 4)
    assert lib.cache_get(key, touch=False)["hits"] == 1  # get_arrays touched it once

    render_key = request_hash("render", {"x": 1})
    cache.remember("render", render_key, "rnd_123")
    assert cache.lookup(render_key)["artifact_id"] == "rnd_123"
    lib.cache_forget_artifact("rnd_123")
    assert cache.lookup(render_key) is None

    path.unlink()  # a vanished file is a miss and drops the stale entry
    assert cache.lookup(key) is None and lib.cache_get(key) is None


def test_prune_evicts_least_recently_used(lib, tmp_path):
    cache = ArtifactCache(lib, tmp_path / "cache", max_bytes=2500)
    keys = [request_hash("tts", {"i": i}) for i in range(4)]
    for k in keys:
        cache.put_bytes("tts", k, os.urandom(1000))
        time.sleep(0.002)
    cache.get_bytes(keys[0])  # most recently used now
    freed = cache.prune(keep=[keys[1]])
    assert freed == 2000
    assert [cache.lookup(k) is not None for k in keys] == [True, True, False, False]
    assert lib.cache_bytes() == 2000
    with pytest.raises(ValueError):
        cache.path_for("tts", "../evil")


def test_v2_library_migrates_to_transcript_state(tmp_path):
    """A library written by the v0.2 engine (schema 2) gains sources.transcript_state; its rows start at 'none'."""
    import sqlite3

    from fvwks_server import library as library_module

    path = tmp_path / "old.sqlite3"
    conn = sqlite3.connect(path)
    for version in (1, 2):
        conn.executescript(library_module._MIGRATIONS[version])
    conn.execute("PRAGMA user_version=2")
    conn.execute("INSERT INTO sources (id, kind, created_at, audio_id, info) "
                 "VALUES ('src_1', 'recording', 'x', 'a', '{}')")
    conn.commit()
    conn.close()
    lib = Library(path)
    try:
        assert lib.schema_version == SCHEMA_VERSION == 3
        assert lib.get("sources", "src_1")["transcript_state"] == "none"
        for state in ("queued", "running", "done", "error"):
            lib.insert("sources", id=f"src_{state}", kind="recording", created_at="x", audio_id="a", info={},
                       transcript_state=state)
        assert lib.reset_transcript_states() == 2  # only the unfinished ones start over
        assert {r["id"]: r["transcript_state"] for r in lib.select("sources")} == {
            "src_1": "none", "src_queued": "none", "src_running": "none", "src_done": "done", "src_error": "error"}
    finally:
        lib.close()
