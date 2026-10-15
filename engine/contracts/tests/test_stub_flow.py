"""End-to-end smoke of the HTTP flow FoxBox 2.0's REMIX uses (contracts v1.0): health → upload a song → its
analysis → settings → audio, behind the token."""
import io
import math
import time
import wave

from fastapi.testclient import TestClient

from fvwks_server.app import create_app
from fvwks_server.config import Config


def _client(tmp_path, token=None):
    return TestClient(create_app(Config.from_env(str(tmp_path / "data"), str(tmp_path / "exports"), token)))


def _wav(seconds=4.0, sr=44100, bpm=120.0) -> bytes:
    """A click on every beat over a low hum: a song the analysis can read."""
    n, beat = int(seconds * sr), int(sr * 60 / bpm)
    frames = bytearray()
    for i in range(n):
        v = 0.2 * math.sin(2 * math.pi * 55 * i / sr) + (0.8 if i % beat < 200 else 0.0)
        frames += int(max(-1, min(1, v)) * 30000).to_bytes(2, "little", signed=True)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(bytes(frames))
    return buf.getvalue()


def test_song_flow(tmp_path):
    with _client(tmp_path) as c:
        assert c.get("/api/health").json()["state"] in ("ready", "loading_model")
        song = c.post("/api/songs", files={"file": ("beat.wav", _wav(), "audio/wav")}, data={"name": "Beat"}).json()
        assert song["name"] == "Beat" and song["sample_rate"] == 44100 and song["stems_state"] == "none"
        deadline = time.monotonic() + 30
        while song["analysis_state"] in ("queued", "running") and time.monotonic() < deadline:
            time.sleep(0.1)
            song = c.get(f"/api/songs/{song['id']}").json()
        assert song["analysis_state"] == "done" and abs(song["analysis"]["bpm"] - 120) < 2
        assert [s["id"] for s in c.get("/api/songs").json()] == [song["id"]]
        patched = c.patch(f"/api/songs/{song['id']}", json={"bpm_override": 121.0}).json()
        assert patched["bpm_override"] == 121.0
        audio = c.get(f"/api/audio/{song['audio_id']}")
        assert audio.status_code == 200 and audio.headers["content-type"] == "audio/wav"
        settings = c.get("/api/settings").json()
        assert c.put("/api/settings", json=settings).status_code == 200
        models = c.get("/api/models").json()
        assert [m["id"] for m in models] == ["stems-htdemucs"] and not models[0]["required"]
        assert c.delete(f"/api/songs/{song['id']}").status_code == 204
        assert c.get(f"/api/songs/{song['id']}").status_code == 404


def test_token_required(tmp_path):
    c = _client(tmp_path, token="s3cret")
    assert c.get("/api/health").status_code == 401
    assert c.get("/api/health").json()["error"]["code"] == "unauthorized"
    assert c.get("/api/health", headers={"Authorization": "Bearer s3cret"}).status_code == 200


def test_removed_routes_are_gone(tmp_path):
    c = _client(tmp_path)
    for path in ("/api/voices", "/api/rack", "/api/presets", "/api/library", "/api/lexicon", "/api/remixes"):
        assert c.get(path).status_code == 404, path
