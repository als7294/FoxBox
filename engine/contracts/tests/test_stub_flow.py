"""End-to-end smoke of the HTTP flow the app uses: tts → render(final) → export → rekordbox.xml → audio."""
import wave
import xml.etree.ElementTree as ET

from fastapi.testclient import TestClient

from fvwks_server.app import create_app
from fvwks_server.config import Config


def _client(tmp_path, token=None):
    return TestClient(create_app(Config.from_env(str(tmp_path / "data"), str(tmp_path / "exports"), token)))


def test_full_flow(tmp_path):
    c = _client(tmp_path)
    assert c.get("/api/health").json()["state"] == "ready"
    assert len(c.get("/api/rack").json()["modules"]) >= 10
    src = c.post("/api/sources/tts", json={"script": "WE ARE GUY FVWKS | EXPECT *US*", "voice_id": "kokoro:am_fenrir"}).json()
    assert len(src["segments"]) == 2 and src["segments"][1]["flags"]["throw"]
    r = c.post("/api/render", json={"source_id": src["id"], "preset_id": "pact", "quality": "final",
                                    "arrange": {"bpm": 140, "bars": 4, "key": "Am"}}).json()
    assert r["n_samples"] == 302400 and r["sample_rate"] == 44100 and r["export"]["filename"].endswith(".aiff")
    assert r["mask"]["level"] == "synthetic"
    wav = c.post("/api/exports", json={"render_ids": [r["id"]], "format": "wav", "variants": ["wet", "dry"]}).json()["files"]
    assert len(wav) == 2
    with open(wav[0]["path"], "rb") as fh:
        head = fh.read(22)
    assert head[20:22] == b"\x01\x00", "WAV must be integer PCM (fmt tag 1), not WAVE_FORMAT_EXTENSIBLE"
    xml = c.post("/api/exports/rekordbox", json={"export_ids": [r["export"]["id"], wav[0]["id"]]}).json()
    root = ET.parse(xml["path"]).getroot()
    assert len(root.find("COLLECTION")) == 2
    audio = c.get(f"/api/audio/{r['audio_id']}")
    assert audio.headers["content-type"] == "audio/wav"
    lib = c.get("/api/library").json()
    assert lib["total"] == 1


def test_token_required(tmp_path):
    c = _client(tmp_path, token="s3cret")
    assert c.get("/api/health").status_code == 401
    assert c.get("/api/health").json()["error"]["code"] == "unauthorized"
    assert c.get("/api/health", headers={"Authorization": "Bearer s3cret"}).status_code == 200


def test_upload_recording(tmp_path):
    c = _client(tmp_path)
    with open(tmp_path / "x.wav", "wb") as fh:
        w = wave.open(fh, "wb")
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100)
        import math, struct
        w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(i / 20))) for i in range(44100)))
        w.close()
    with open(tmp_path / "x.wav", "rb") as fh:
        src = c.post("/api/sources/upload", files={"file": ("x.wav", fh, "audio/wav")}, data={"kind": "recording"}).json()
    assert src["kind"] == "recording" and src["sample_rate"] == 48000
    r = c.post("/api/render", json={"source_id": src["id"], "preset_id": "raw", "arrange": {"bars": 4}}).json()
    assert r["mask"]["level"] in ("weak", "medium", "strong")


def test_v01_routes(tmp_path):
    c = _client(tmp_path)
    prev = c.post("/api/script/preview", json={"script": "WE ARE GUY FVWKS | EXPECT *US*", "bpm": 140})
    assert prev.status_code == 200, prev.text
    body = prev.json()
    assert len(body["segments"]) == 2 and body["segments"][1]["flags"]["throw"]
    missing = c.get("/api/personas/candidates/cand_000000000000")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "not_found"
    lex = c.get("/api/lexicon").json()["entries"]
    assert any(e["word"] == "DJ" and e["acronym"] for e in lex)
