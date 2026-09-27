"""HTTP API against the voice and fx stubs: the full tts → render → export → rekordbox.xml flow, auth, library,
presets, settings, batch, jobs and audio streaming."""
import dataclasses
import io
import json
import math
import struct
import time
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient
from fvwks_contracts.audio import resolve_auto_bars
from fvwks_contracts.models import Segment, Word
from fvwks_contracts.seam import Source
from fvwks_fx import api as fx_api
from fvwks_voice import api as voice_api
from mutagen.aiff import AIFF

from fvwks_server.app import create_app
from fvwks_server.config import Config
from fvwks_server.rekordbox import parse_rekordbox_xml
from fvwks_server.writer import read_riff_info

TOKEN = "t0ken-s3"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
SCRIPT = "WE ARE GUY FVWKS | EXPECT *US*"


_CLIENTS: list = []


def open_client(config, token=TOKEN):
    """A TestClient with the app's lifespan entered; the autouse fixture closes it after the test."""
    client = TestClient(create_app(config))
    client.__enter__()
    _CLIENTS.append(client)
    client.headers.update(AUTH if token else {})
    return client


def make_client(tmp_path, token=TOKEN, **config_overrides):
    config = Config.from_env(str(tmp_path / "data"), str(tmp_path / "exports"), token)
    for k, v in config_overrides.items():
        setattr(config, k, v)
    return open_client(config, token)


@pytest.fixture(autouse=True)
def _close_engines():
    """Close every engine the test opened. Its background jobs (WORLD analysis, stack prefetch) and start-up work
    are cancelled and joined, so they never call into the next test's monkeypatched voice/fx functions and no
    worker is still in native code when the interpreter exits."""
    yield
    while _CLIENTS:
        client = _CLIENTS.pop()
        stopped = client.app.state.service.close(timeout=60)
        client.__exit__(None, None, None)  # the lifespan's own close() is then a no-op
        assert stopped, "background work was still running a minute after close()"


def speech_span(source) -> float:
    """The phrase's natural length: first word start to last word end (or the whole source without segments)."""
    segments = source.info.segments
    return segments[-1].end_s - segments[0].start_s if segments else source.info.duration_s


@pytest.fixture(autouse=True)
def _emulate_auto_bars(monkeypatch):
    """v0.2 makes Arrange.bars "auto" by default, and fx resolves it. Until the real rack does (fvwks_fx.api.AUTO_BARS),
    stand in for it as the contract describes: the shared resolver picks the count, fx renders that count, and
    RenderOutput.bars reports it. With the real implementation present this does nothing."""
    if getattr(fx_api, "AUTO_BARS", False):
        return
    real = fx_api.render

    def render(main, stack, req):
        if req.arrange.bars != "auto":
            return real(main, stack, req)
        a = req.arrange
        bars = resolve_auto_bars(speech_span(main), a.bpm, a.first_word_beat, a.tail_beats, a.max_stretch)
        out = real(main, stack, req.model_copy(update={"arrange": a.model_copy(update={"bars": bars})}))
        return dataclasses.replace(out, bars=bars)

    monkeypatch.setattr(fx_api, "render", render)


_REAL_TRANSCRIBE = getattr(voice_api, "transcribe", None)


@pytest.fixture(autouse=True)
def _no_background_transcripts(monkeypatch):
    """Uploads queue a background transcription when the voice package can do it (v0.3) and its model is installed,
    as it is on the dev Mac. Tests leave that off unless they install a fake or ask for real_transcriber."""
    monkeypatch.delattr(voice_api, "transcribe", raising=False)


@pytest.fixture
def real_transcriber(monkeypatch):
    if _REAL_TRANSCRIBE is None:
        pytest.skip("this voice package can't transcribe")
    monkeypatch.setattr(voice_api, "transcribe", _REAL_TRANSCRIBE, raising=False)


@pytest.fixture
def client(tmp_path):
    return make_client(tmp_path)


def ok(response, status=200):
    assert response.status_code == status, response.text
    return response.json() if response.content and status != 204 else None


def tts(client, script=SCRIPT, voice="kokoro:am_fenrir", **kw):
    return ok(client.post("/api/sources/tts", json={"script": script, "voice_id": voice, **kw}))


def render(client, source_id, **kw):
    body = {"source_id": source_id, "preset_id": "pact", "arrange": {"bpm": 140, "bars": 4, "key": "Am"}, **kw}
    return ok(client.post("/api/render", json=body))


def wait_job(client, job_id, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = ok(client.get(f"/api/jobs/{job_id}"))
        if job["state"] not in ("queued", "running"):
            return job
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} did not finish")


def inside(path, root):
    p, r = Path(path).resolve(), Path(root).resolve()
    return p == r or r in p.parents


# ------------------------------------------------------------------------------------------ the full flow


def test_full_flow_tts_render_export_rekordbox(client, tmp_path):
    export_root = ok(client.get("/api/settings"))["export_dir"]
    src = tts(client)
    assert len(src["segments"]) == 2 and src["segments"][1]["flags"]["throw"]

    r = render(client, src["id"], quality="final")
    assert r["n_samples"] == 302_400 and r["sample_rate"] == 44100 and r["bars"] == 4
    auto = r["export"]
    assert auto["filename"] == "GUYFVWKS_PACT_we-are-guy-fvwks_140bpm_4bar_Am_wet_v01.aiff"
    assert inside(auto["path"], export_root) and auto["n_samples"] == 302_400

    # AIFF: 24-bit 44.1 kHz stereo, exact length, ID3v2.3 tags read back.
    info = sf.info(auto["path"])
    assert (info.samplerate, info.channels, info.subtype, info.frames) == (44100, 2, "PCM_24", 302_400)
    tags = AIFF(auto["path"]).tags
    assert tags.version == (2, 3, 0)
    assert tags["TPE1"].text == ["GUY FVWKS"] and tags["TBPM"].text == ["140"] and tags["TKEY"].text == ["Am"]
    assert tags["TIT2"].text == [auto["title"]]
    assert SCRIPT in tags.getall("COMM")[0].text[0] and "PACT" in tags.getall("COMM")[0].text[0]
    params = json.loads(tags["TXXX:FVWKS_RENDER"].text[0])
    assert params["render"]["render_id"] == r["id"] and params["render"]["request"]["arrange"]["bpm"] == 140

    # WAV variants: integer PCM (fmt tag 0x0001 at bytes 20-21), RIFF INFO read back.
    files = ok(client.post("/api/exports", json={"render_ids": [r["id"]], "format": "wav",
                                                 "variants": ["wet", "dry", "alt:legion"]}))["files"]
    assert [f["variant"] for f in files] == ["wet", "dry", "alt:legion"]
    assert {f["filename"][-8:] for f in files} == {"_v02.wav"}  # one shared version per export
    assert files[2]["filename"] == "GUYFVWKS_PACT_we-are-guy-fvwks_140bpm_4bar_Am_alt-LEGION_v02.wav"
    for f in files:
        assert inside(f["path"], export_root)
        raw = Path(f["path"]).read_bytes()
        assert raw[20:22] == b"\x01\x00", "WAV must be integer PCM (0x0001), never WAVE_FORMAT_EXTENSIBLE"
        assert raw[12:16] == b"fmt " and raw[36:40] == b"data"
        assert struct.unpack_from("<HHIIHH", raw, 20)[5] == 24
        assert sf.info(f["path"]).frames == 302_400
        riff = read_riff_info(f["path"])
        assert riff["IART"] == "GUY FVWKS" and riff["INAM"] == f["title"] and "140 BPM, Am" in riff["ICMT"]
    assert "[LEGION]" in read_riff_info(files[2]["path"])["ICMT"]

    # rekordbox.xml: collection + playlist, grid at 0, hot cue A at the first word, locations = the files.
    ids = [auto["id"], *(f["id"] for f in files)]
    xml = ok(client.post("/api/exports/rekordbox", json={"export_ids": ids, "playlist": "Friday Drops"}))
    assert xml["tracks"] == 4 and xml["filename"] == "friday-drops_rekordbox.xml" and inside(xml["path"], export_root)
    parsed = parse_rekordbox_xml(Path(xml["path"]).read_bytes())
    assert parsed["entries"] == 4 and parsed["playlists"][0]["keys"] == ["1", "2", "3", "4"]
    assert [t["path"] for t in parsed["tracks"]] == [auto["path"], *(f["path"] for f in files)]
    first = parsed["tracks"][0]
    assert first["Kind"] == "AIFF File" and parsed["tracks"][1]["Kind"] == "WAV File"
    assert first["AverageBpm"] == "140.00" and first["Tonality"] == "Am" and first["Grouping"] == "PACT"
    assert first["tempo"] == [{"Inizio": "0.000", "Bpm": "140.00", "Metro": "4/4", "Battito": "1"}]
    hot = [m for m in first["marks"] if m["Num"] == "0"]
    assert hot and hot[0]["Start"] == f"{r['first_word_s']:.3f}"
    memory = [m for m in first["marks"] if m["Num"] == "-1"]  # VOICE OUT: the end of the last word
    voice_out = r["tail_s"] if r["tail_s"] is not None else max(s["end_s"] for s in r["segments"])
    assert memory and memory[0]["Start"] == f"{voice_out:.3f}" and memory[0]["Name"] == "VOICE OUT"

    # Retargeted XML for the DJ laptop.
    moved = ok(client.post("/api/exports/rekordbox", json={"export_ids": [auto["id"]], "playlist": "Laptop",
                                                           "target_path_root": "/Users/dj/Music/FoxBox"}))
    assert parse_rekordbox_xml(Path(moved["path"]).read_bytes())["tracks"][0]["path"] == \
        f"/Users/dj/Music/FoxBox/{auto['filename']}"

    # The Vault has the take with all four exports.
    lib = ok(client.get("/api/library"))
    assert lib["total"] == 1
    take = lib["items"][0]
    assert take["render_id"] == r["id"] and take["preset_id"] == "pact" and take["preset_name"] == "PACT"
    assert take["title"] == "WE ARE GUY FVWKS EXPECT US" and take["source_kind"] == "tts"
    assert [e["id"] for e in take["exports"]] == ids



def test_rekordbox_xml_reads_back_with_pyrekordbox(client):
    """The exported rekordbox.xml as the reference parser (pyrekordbox) sees it: the file, grid, cues, playlist."""
    rbxml = pytest.importorskip("pyrekordbox.rbxml")
    src = tts(client)
    r = render(client, src["id"], quality="final")
    auto = r["export"]
    res = ok(client.post("/api/exports/rekordbox", json={"export_ids": [auto["id"]], "playlist": "Friday Drops"}))
    xml = rbxml.RekordboxXml(res["path"])
    (t,) = xml.get_tracks()
    assert "/" + t.Location == auto["path"] and Path(auto["path"]).is_file()  # pyrekordbox drops the leading /
    assert (t.Name, t.Artist, t.Kind, t.AverageBpm, t.Tonality) == (auto["title"], "GUY FVWKS", "AIFF File", 140.0,
                                                                    "Am")
    assert t.TotalTime == 7 and t.Size == Path(auto["path"]).stat().st_size  # 302,400 samples = 6.86 s
    (tempo,) = t.tempos
    assert (tempo.Inizio, tempo.Bpm, tempo.Metro, tempo.Battito) == (0.0, 140.0, "4/4", 1)
    hot, memory = t.marks
    assert (hot.Name, hot.Num, hot.Start) == ("VOX", 0, float(f"{r['first_word_s']:.3f}"))
    voice_out = r["tail_s"] if r["tail_s"] is not None else max(s["end_s"] for s in r["segments"])
    assert (memory.Name, memory.Num, memory.Start) == ("VOICE OUT", -1, float(f"{voice_out:.3f}"))
    assert 0 <= hot.Start < memory.Start < t.TotalTime
    playlist = xml.get_playlist("Friday Drops")
    assert playlist.is_playlist and playlist.get_tracks() == [1]


def test_bake_16bit_and_custom_pattern(client):
    settings = ok(client.get("/api/settings"))
    settings.update(filename_pattern="{artist}-{slug}-{variant}-{version:03d}", artist="Guy Fvwks", bit_depth=16)
    ok(client.put("/api/settings", json=settings))
    src = tts(client)
    r = render(client, src["id"], quality="final", master={"mode": "bake"})
    assert r["export"]["filename"] == "GUYFVWKS-we-are-guy-fvwks-wet-001.aiff" and r["export"]["bit_depth"] == 16
    assert sf.info(r["export"]["path"]).subtype == "PCM_16"
    assert AIFF(r["export"]["path"]).tags["TPE1"].text == ["Guy Fvwks"]


# ------------------------------------------------------------------------------------------ auth & errors


def test_token_on_every_route(tmp_path):
    c = make_client(tmp_path)
    anon = TestClient(c.app)
    for method, path in [("get", "/api/health"), ("get", "/api/library"), ("post", "/api/render"),
                         ("get", "/api/settings"), ("get", "/api/jobs/job_x"), ("delete", "/api/sources/src_x")]:
        res = getattr(anon, method)(path)
        assert res.status_code == 401 and res.json()["error"]["code"] == "unauthorized", path
    assert anon.get("/api/health", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert anon.get("/api/health", headers={"Authorization": TOKEN}).status_code == 401
    assert anon.get(f"/api/health?token={TOKEN}").status_code == 401  # ?token= only for audio
    assert anon.post(f"/api/sources/tts?token={TOKEN}", json={"script": "x"}).status_code == 401
    src = tts(c)
    assert anon.get(f"/api/audio/{src['audio_id']}?token={TOKEN}").status_code == 200
    assert anon.get(f"/api/audio/{src['audio_id']}?token=nope").status_code == 401
    assert anon.get(f"/api/audio/{src['audio_id']}").status_code == 401


def test_every_api_route_requires_the_token(tmp_path):
    c = make_client(tmp_path)
    anon = TestClient(c.app)
    routes = [(m.upper(), path) for path, ops in c.app.openapi()["paths"].items() for m in ops]  # the contract
    assert len(routes) >= 30
    for method, path in routes:
        url = path.replace("{", "").replace("}", "_x")  # any value: auth runs before the route body
        res = anon.request(method, url)
        assert res.status_code == 401, (method, path, res.status_code)
        res = anon.request(method, url + f"?token={TOKEN}")
        expected_ok = method == "GET" and path.startswith("/api/audio/")
        assert (res.status_code != 401) == expected_ok, (method, path, res.status_code)


def test_cors_only_for_dev_origins(tmp_path):
    preflight = {"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"}
    closed = make_client(tmp_path / "a")
    assert "access-control-allow-origin" not in closed.options("/api/health", headers=preflight).headers
    dev = make_client(tmp_path / "b", allow_origins=["http://localhost:5173"])
    res = dev.options("/api/health", headers=preflight)
    assert res.headers.get("access-control-allow-origin") == "http://localhost:5173"
    other = dev.options("/api/health", headers={**preflight, "Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in other.headers


def test_error_envelopes(client):
    assert client.get("/api/sources/src_000000000000").json()["error"]["code"] == "not_found"
    bad = client.post("/api/sources/tts", json={"script": ""})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "invalid_request"
    assert client.get("/api/nope").json() == {"error": {"code": "not_found", "message": "Not Found", "hint": None,
                                                        "retryable": False, "model_id": None}}
    voice = client.post("/api/sources/tts", json={"script": "hi", "voice_id": "kokoro:nobody"})
    assert voice.status_code == 404 and "voices" in voice.json()["error"]["hint"]
    assert client.post("/api/render", json={"source_id": "src_000000000000"}).status_code == 404
    src = tts(client)
    assert client.post("/api/render", json={"source_id": src["id"], "preset_id": "nope"}).status_code == 404
    assert client.post("/api/exports/rekordbox", json={"export_ids": ["exp_missing"]}).status_code == 404
    bad_key = client.post("/api/render", json={"source_id": src["id"], "arrange": {"key": "Hm"}})
    assert bad_key.status_code == 422 and "key" in bad_key.json()["error"]["message"]


# ------------------------------------------------------------------------------------------ render details


def test_memory_cue_marks_voice_out(client):
    """Ruling (v0.1): tail_s is the end of the last word on the output timeline → memory cue "VOICE OUT"."""
    src = tts(client)
    r = render(client, src["id"], quality="final", arrange={"bpm": 140, "bars": 4, "key": "Am", "tail_beats": 4})
    voice_out = r["tail_s"] if r["tail_s"] is not None else max(seg["end_s"] for seg in r["segments"])
    assert r["first_word_s"] < voice_out <= r["duration_s"]
    xml = ok(client.post("/api/exports/rekordbox", json={"export_ids": [r["export"]["id"]]}))
    marks = parse_rekordbox_xml(Path(xml["path"]).read_bytes())["tracks"][0]["marks"]
    assert [(m["Name"], m["Start"]) for m in marks if m["Num"] == "-1"] == [("VOICE OUT", f"{voice_out:.3f}")]
    assert [m["Start"] for m in marks if m["Num"] == "0"] == [f"{r['first_word_s']:.3f}"]


def wait_analysed(client, source_id, timeout=20):
    deadline = time.time() + timeout
    while ok(client.get(f"/api/sources/{source_id}"))["analysis_state"] in ("none", "queued", "running"):
        assert time.time() < deadline, "analysis never finished"
        time.sleep(0.02)


def test_preview_cache_and_preset_hints(client):
    src = tts(client)
    wait_analysed(client, src["id"])  # preview keys include whether the analysis has landed
    a = render(client, src["id"])
    assert render(client, src["id"])["id"] == a["id"]  # identical request → cached render
    b = render(client, src["id"], macros={"depth": 0.9, "grit": 0.5, "machine": 0.5, "space": 0.5})
    assert b["id"] != a["id"] and b["macros"]["depth"] == 0.9
    # GHOST's arrange_hint (first_word_beat 4) applies when the client leaves the field unset...
    ghost = render(client, src["id"], preset_id="ghost")
    assert ghost["first_word_s"] == pytest.approx(4 * 60 / 140, abs=1e-4)
    # ...and never overrides an explicit value.
    explicit = render(client, src["id"], preset_id="ghost",
                      arrange={"bpm": 140, "bars": 4, "key": "Am", "first_word_beat": 0})
    assert explicit["first_word_s"] == 0.0
    audio = client.get(f"/api/audio/{a['audio_id']}")
    assert audio.status_code == 200 and audio.headers["content-type"] == "audio/wav"
    assert audio.content[20:22] == b"\x01\x00"
    data, sr = sf.read(io.BytesIO(audio.content))
    assert sr == 44100 and data.shape == (302_400, 2)
    part = client.get(f"/api/audio/{a['audio_id']}", headers={"Range": "bytes=0-99"})
    assert part.status_code == 206 and len(part.content) == 100


def test_stack_voices_synthesized_once_and_passed_to_fx(client, monkeypatch):
    calls, seen = [], []
    real_synth, real_render = voice_api.synthesize, fx_api.render

    def synth(req, lexicon=None):
        calls.append(req.voice_id)
        return real_synth(req, lexicon)

    def fx_render(main, stack, req):
        seen.append([s.info.voice_id if s is not None else None for s in stack])
        return real_render(main, stack, req)

    monkeypatch.setattr(voice_api, "synthesize", synth)
    monkeypatch.setattr(fx_api, "render", fx_render)
    src = tts(client)
    render(client, src["id"])  # PACT stacks am_michael and bm_george
    render(client, src["id"], macros={"depth": 0.1, "grit": 0.5, "machine": 0.5, "space": 0.5})
    # Stack voices are synthesized once (the background prefetch may add LEGION's am_puck).
    assert [c for c in calls if c != "kokoro:am_puck"] == ["kokoro:am_fenrir", "kokoro:am_michael", "kokoro:bm_george"]
    assert len(calls) == len(set(calls))
    assert seen == [["kokoro:am_michael", "kokoro:bm_george"]] * 2
    render(client, src["id"], preset_id="abyss")  # pseudo-stack voices (voice_id None)
    assert seen[-1] == [None, None]


def test_world_analysis_runs_in_background(client, monkeypatch):
    analyzed = []
    monkeypatch.setattr(fx_api, "analyze", lambda source: analyzed.append(source.info.id))
    src = tts(client)
    service = client.app.state.service
    deadline = time.time() + 5
    while service.analysis_state(src["id"]) != "done" and time.time() < deadline:
        time.sleep(0.01)
    sources_analyzed = lambda: [a for a in analyzed if a.startswith("src_")]  # noqa: E731 (stack voices: stack_…)
    assert sources_analyzed() == [src["id"]] and service.analysis_state(src["id"]) == "done"
    assert tts(client)["id"] == src["id"]  # TTS cache: same request, same source, no new analysis
    assert sources_analyzed() == [src["id"]]


def test_default_preset_stack_voices_are_prefetched(client, monkeypatch):
    synthesized, analyzed = [], []
    real_synth = voice_api.synthesize

    def synth(req, lexicon=None):
        synthesized.append(req.voice_id)
        return real_synth(req, lexicon)

    monkeypatch.setattr(voice_api, "synthesize", synth)
    monkeypatch.setattr(fx_api, "analyze", lambda source: analyzed.append(source.info.voice_id))
    tts(client)  # default preset PACT stacks am_michael + bm_george; LEGION adds am_puck
    deadline = time.time() + 10
    while len(analyzed) < 4 and time.time() < deadline:
        time.sleep(0.01)
    assert synthesized == ["kokoro:am_fenrir", "kokoro:am_michael", "kokoro:bm_george", "kokoro:am_puck"]
    assert analyzed == ["kokoro:am_fenrir", "kokoro:am_michael", "kokoro:bm_george", "kokoro:am_puck"]
    source_id = ok(client.get("/api/sources"))["items"][0]["id"]
    render(client, source_id)  # PACT preview
    render(client, source_id, preset_id="legion")
    assert len(synthesized) == 4  # no further synthesis: every stack voice was warm


def test_interactive_voice_work_goes_first():
    import threading

    from fvwks_server.service import PriorityLock

    gate, order, hold = PriorityLock(), [], threading.Event()

    def worker(name, background, started):
        started.set()
        with gate.hold(background):
            order.append(name)
            if name == "first":
                hold.wait(5)

    def start(name, background):
        started = threading.Event()
        t = threading.Thread(target=worker, args=(name, background, started))
        t.start()
        started.wait(5)
        time.sleep(0.05)  # let it reach the gate
        return t

    threads = [start("first", True), start("bg", True), start("fg", False)]
    hold.set()
    for t in threads:
        t.join(5)
    assert order == ["first", "fg", "bg"]  # the request jumped the queued background job
    with gate.hold(False):
        with gate.hold(False):  # reentrant
            pass


def test_preview_gc_keeps_newest(tmp_path):
    c = make_client(tmp_path, preview_keep=2)
    src = tts(c)
    ids = [render(c, src["id"], macros={"depth": d, "grit": 0, "machine": 0, "space": 0})["id"]
           for d in (0.1, 0.2, 0.3, 0.4)]
    alive = [c.get(f"/api/renders/{i}").status_code for i in ids]
    assert alive == [404, 404, 200, 200]


# ------------------------------------------------------------------------------------------ exports


def test_export_variants_errors_and_stems(client):
    src = tts(client)
    r = render(client, src["id"], quality="final", auto_export=False)
    assert r["export"] is None
    bad = client.post("/api/exports", json={"render_ids": [r["id"]], "variants": ["sideways"]})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "invalid_request"
    assert client.post("/api/exports", json={"render_ids": [r["id"]], "variants": ["alt:nope"]}).status_code == 404
    assert client.post("/api/exports", json={"render_ids": ["rnd_000000000000"]}).status_code == 404
    result = ok(client.post("/api/exports", json={"render_ids": [r["id"]], "variants": ["wet"], "stems": True,
                                                  "title": "Intro Drop"}))
    files = result["files"]
    assert files[0]["variant"] == "wet" and files[0]["filename"].startswith("GUYFVWKS_PACT_intro-drop_")
    assert files[0]["title"].startswith("Intro Drop")
    stems = files[1:]
    if stems:  # the real rack renders stems on request (stem:voice, stem:layers, stem:fx, stem:dry)
        assert {f["variant"] for f in stems} <= {"stem:dry", "stem:voice", "stem:layers", "stem:fx"}
        assert all(f["n_samples"] == files[0]["n_samples"] for f in stems) and result["warnings"] == []
        assert {f["filename"].split("_")[-2] for f in files} == {"wet", *(f["variant"].replace(":", "-") for f in stems)}
    else:  # the v0 fx stub renders none
        assert result["warnings"] == ["No stems: the sound engine doesn't produce them yet."]
    Path(files[0]["path"]).unlink()
    gone = client.post("/api/exports/rekordbox", json={"export_ids": [files[0]["id"]]})
    assert gone.status_code == 409 and gone.json()["error"]["code"] == "file_missing"


def test_no_stems_warning_when_fx_returns_none(client, monkeypatch):
    real_render = fx_api.render

    def without_stems(main, stack, req):
        out = real_render(main, stack, req)
        out.stems = {}
        return out

    monkeypatch.setattr(fx_api, "render", without_stems)
    r = render(client, tts(client)["id"], quality="final", auto_export=False)
    result = ok(client.post("/api/exports", json={"render_ids": [r["id"]], "variants": ["wet"], "stems": True}))
    assert [f["variant"] for f in result["files"]] == ["wet"]
    assert result["warnings"] == ["No stems: the sound engine doesn't produce them yet."]


def test_stems_are_exported_when_fx_provides_them(client, monkeypatch):
    real_render = fx_api.render

    def with_stems(main, stack, req):
        out = real_render(main, stack, req)
        if req.stems:
            out.stems = {"voice": out.audio * 0.5, "fx": out.audio * 0.25, "bogus": out.audio}
        return out

    monkeypatch.setattr(fx_api, "render", with_stems)
    src = tts(client)
    r = render(client, src["id"], quality="final", stems=True, auto_export=False)
    assert [s["name"] for s in r["stems"]] == ["voice", "fx"] and any("bogus" in w for w in r["warnings"])
    files = ok(client.post("/api/exports", json={"render_ids": [r["id"]], "variants": ["wet"], "stems": True}))
    assert [f["variant"] for f in files["files"]] == ["wet", "stem:voice", "stem:fx"]
    assert files["files"][1]["filename"].endswith("_stem-voice_v01.aiff")


def test_final_render_is_idempotent(client):
    src = tts(client)
    a = render(client, src["id"], quality="final")
    b = render(client, src["id"], quality="final")
    assert b["id"] == a["id"] and b["export"]["id"] == a["export"]["id"]
    assert ok(client.get("/api/library"))["total"] == 1
    Path(a["export"]["path"]).unlink()  # the file went missing: the next final render re-exports it
    c = render(client, src["id"], quality="final")
    assert c["id"] == a["id"] and c["export"]["filename"].endswith("_v01.aiff") and Path(c["export"]["path"]).is_file()


# ------------------------------------------------------------------------------------------ library & sources


def test_library_patch_filter_delete(client):
    src = tts(client)
    pact = render(client, src["id"], quality="final")
    raw = render(client, src["id"], preset_id="raw", quality="final")
    takes = ok(client.get("/api/library"))["items"]
    assert [t["preset_id"] for t in takes] == ["raw", "pact"]  # newest first
    tid = takes[1]["id"]
    patched = ok(client.patch(f"/api/library/{tid}", json={"title": "Opener", "starred": True, "tags": ["intro"]}))
    assert patched["title"] == "Opener" and patched["starred"] and patched["tags"] == ["intro"]
    assert [t["id"] for t in ok(client.get("/api/library?starred=true"))["items"]] == [tid]
    assert [t["id"] for t in ok(client.get("/api/library?q=open"))["items"]] == [tid]
    assert ok(client.get("/api/library?preset_id=raw"))["items"][0]["render_id"] == raw["id"]
    assert client.patch(f"/api/library/{tid}", json={"title": " "}).status_code == 422
    ok(client.delete(f"/api/library/{tid}"), 204)
    assert client.get(f"/api/library/{tid}").status_code == 404
    assert client.get(f"/api/renders/{pact['id']}").status_code == 404  # its render audio went with it
    xml = ok(client.post("/api/exports/rekordbox", json={"export_ids": [pact["export"]["id"]]}))
    assert xml["tracks"] == 1  # the exported file lives on


def test_sources_list_get_delete_and_upload(client, tmp_path):
    a = tts(client)
    wav = tmp_path / "rec.wav"
    t = np.arange(44100) / 44100
    sf.write(wav, 0.3 * np.sin(2 * np.pi * 150 * t), 44100, subtype="PCM_16")
    with open(wav, "rb") as fh:
        b = ok(client.post("/api/sources/upload", files={"file": ("../../etc/rec.wav", fh, "audio/wav")},
                           data={"kind": "recording", "name": "Take 1"}))
    assert b["kind"] == "recording" and b["sample_rate"] == 48000 and b["name"] == "Take 1"
    listing = ok(client.get("/api/sources"))
    assert listing["total"] == 2 and [s["id"] for s in listing["items"]] == [b["id"], a["id"]]
    assert [s["id"] for s in ok(client.get("/api/sources?kind=recording"))["items"]] == [b["id"]]
    assert ok(client.get(f"/api/sources/{a['id']}"))["script"] == SCRIPT
    ok(client.delete(f"/api/sources/{a['id']}"), 204)
    assert client.get(f"/api/sources/{a['id']}").status_code == 404
    empty = client.post("/api/sources/upload", files={"file": ("x.wav", b"", "audio/wav")})
    assert empty.status_code == 400 and empty.json()["error"]["code"] == "unsupported_audio"
    junk = client.post("/api/sources/upload", files={"file": ("x.wav", b"not audio", "audio/wav")})
    assert junk.status_code in (400, 415)  # the real voice engine reports 415 Unsupported Media Type


def test_voices_have_audition_audio(client):
    voices = ok(client.get("/api/voices"))
    fenrir = next(v for v in voices if v["id"] == "kokoro:am_fenrir")
    assert fenrir["sample_audio_id"].startswith("smp_")
    res = client.get(f"/api/audio/{fenrir['sample_audio_id']}")
    assert res.status_code == 200 and res.content[:4] == b"RIFF"
    assert client.get("/api/audio/smp_000000000000").status_code == 404
    assert client.get("/api/audio/..%2F..%2Fetc").status_code == 404


# ------------------------------------------------------------------------------------------ presets & settings


def test_presets_crud(client):
    presets = ok(client.get("/api/presets"))
    assert [p["id"] for p in presets][:7] == ["pact", "legion", "abyss", "unit", "ghost", "signal", "raw"]
    assert all(p["factory"] for p in presets)
    mine = {**presets[0], "id": "my-pact", "name": "My Pact", "factory": True}
    created = ok(client.post("/api/presets", json=mine))
    assert created["factory"] is False
    assert client.post("/api/presets", json=mine).json()["error"]["code"] == "exists"
    assert client.put("/api/presets/pact", json=presets[0]).json()["error"]["code"] == "read_only"
    assert client.delete("/api/presets/pact").status_code == 409
    renamed = ok(client.put("/api/presets/my-pact", json={**mine, "name": "Pact 2"}))
    assert renamed["name"] == "Pact 2" and renamed["id"] == "my-pact"
    assert ok(client.get("/api/presets"))[-1]["name"] == "Pact 2"
    broken = {**mine, "id": "broken", "chain": {"modules": [{"id": "warp-drive", "params": {}}]}}
    assert client.post("/api/presets", json=broken).json()["error"]["code"] == "invalid_preset"
    src = tts(client)
    user_render = render(client, src["id"], preset_id="my-pact", quality="final")
    assert user_render["export"]["filename"].startswith("GUYFVWKS_PACT-2_")
    ok(client.delete("/api/presets/my-pact"), 204)
    assert client.delete("/api/presets/my-pact").status_code == 404


def test_settings_and_lexicon_persist(tmp_path):
    c = make_client(tmp_path)
    s = ok(c.get("/api/settings"))
    assert s["export_dir"] == str((tmp_path / "exports").resolve()) and s["format"] == "aiff"
    new_root = tmp_path / "Music" / "Drops"
    s.update(export_dir=str(new_root), format="wav", rekordbox={**s["rekordbox"], "memory_cue_tail": False})
    saved = ok(c.put("/api/settings", json=s))
    assert saved["export_dir"] == str(new_root.resolve()) and new_root.is_dir()
    lex = {"entries": [{"word": "FVWKS", "say": "Fawkes", "acronym": False}]}
    ok(c.put("/api/lexicon", json=lex))

    again = make_client(tmp_path)  # a restarted engine reads the same library
    assert ok(again.get("/api/settings"))["format"] == "wav"
    assert ok(again.get("/api/lexicon")) == lex
    assert ok(again.get("/api/health"))["export_dir"] == str(new_root.resolve())
    r = render(again, tts(again)["id"], quality="final")
    assert r["export"]["path"].startswith(str(new_root.resolve())) and r["export"]["format"] == "wav"

    for bad_dir in ("relative/path", "/System/Library/x", "/usr/local/fvwks", "/", str(Path.home()), "/Users",
                    "/Volumes", str(Path.home() / ".ssh"), str(tmp_path / ".hidden" / "drops")):
        res = again.put("/api/settings", json={**s, "export_dir": bad_dir})
        assert res.status_code == 400 and res.json()["error"]["code"] == "invalid_settings", bad_dir
    res = again.put("/api/settings", json={**s, "filename_pattern": "{slug}"})
    assert res.status_code == 400 and "variant" in res.json()["error"]["message"]
    assert again.put("/api/settings", json={**s, "default_key": "H minor"}).status_code == 400


def test_lexicon_change_misses_the_tts_cache(client):
    a = tts(client)
    assert tts(client)["id"] == a["id"]
    ok(client.put("/api/lexicon", json={"entries": [{"word": "FVWKS", "say": "Fox"}]}))
    assert tts(client)["id"] != a["id"]


# ------------------------------------------------------------------------------------------ batch & jobs


def test_batch_setlist_with_playlist(client):
    lines = [{"script": SCRIPT, "title": "Opener"},
             {"script": "REMEMBER, REMEMBER [0.5] THE SIGNAL NEVER DIES | WE DO NOT FORGIVE | *EXPECT US*", "voice_id": "kokoro:bm_george", "bars": 8},
             {"script": "PUT YOUR HANDS UP", "voice_id": "kokoro:nobody"},
             {"script": "Expect us", "preset_id": "unit", "key": "F#m"}]
    job = ok(client.post("/api/batch", json={"lines": lines, "playlist": "Warehouse", "arrange": {"bpm": 140},
                                              "export": {"variants": ["wet", "dry"]}}))
    assert job["kind"] == "batch" and len(job["items"]) == 4
    done = wait_job(client, job["id"])
    assert done["state"] == "done" and done["progress"] == 1.0
    assert [i["state"] for i in done["items"]] == ["done", "done", "error", "done"]
    assert done["items"][2]["error"]["code"] == "voice_not_found"
    assert len(done["result_ids"]) == 6 and all(len(done["items"][i]["result_ids"]) == 2 for i in (0, 1, 3))
    xml_path = Path(done["message"])
    export_root = Path(ok(client.get("/api/settings"))["export_dir"])
    assert xml_path.parent == export_root / "Warehouse" and xml_path.name == "warehouse_rekordbox.xml"
    parsed = parse_rekordbox_xml(xml_path.read_bytes())
    assert parsed["playlists"][0]["name"] == "Warehouse" and parsed["entries"] == 6
    assert all(Path(t["path"]).parent == export_root / "Warehouse" for t in parsed["tracks"])
    assert {t["Tonality"] for t in parsed["tracks"]} == {"Am", "F#m"}
    assert "8bar" in parsed["tracks"][2]["path"]
    assert ok(client.get("/api/library"))["total"] == 3


def test_batch_all_lines_failing_is_an_error(client):
    job = ok(client.post("/api/batch", json={"lines": [{"script": "x", "voice_id": "kokoro:nobody"}]}))
    done = wait_job(client, job["id"])
    assert done["state"] == "error" and done["error"]["code"] == "batch_failed"


def test_jobs_models_personas_without_voice_hooks(client, monkeypatch):
    # The v0 fallbacks, whatever the installed voice package provides (S1's real hooks are tested with fakes below).
    for hook in ("list_models", "install_model", "design_persona", "save_persona"):
        monkeypatch.delattr(voice_api, hook, raising=False)
    assert client.get("/api/jobs/job_000000000000").status_code == 404
    models = ok(client.get("/api/models"))
    assert {m["id"] for m in models} >= {"kokoro-82m", "qwen3-tts-voicedesign"}
    done = ok(client.post("/api/models/kokoro-82m/install"))
    assert done["state"] == "done" and "already installed" in done["message"]
    qwen = ok(client.post("/api/models/qwen3-tts-voicedesign/install"))
    assert qwen["state"] == "error" and qwen["error"]["code"] in ("not_available", "disk_full")
    assert client.post("/api/models/nope/install").status_code == 404
    persona = ok(client.post("/api/personas/design", json={"description": "deep gravelly menacing narrator"}))
    assert persona["state"] == "error" and persona["error"]["code"] == "model_missing"
    assert client.post("/api/personas", json={"candidate_id": "cand_000000000000", "name": "X"}).status_code == 404
    cancelled = ok(client.post(f"/api/jobs/{qwen['id']}/cancel"))
    assert cancelled["state"] == "error"  # finished jobs stay as they were


def test_health(client):
    h = ok(client.get("/api/health"))
    # Engine-agnostic: "stub" before integration, "kokoro-mlx"/"fvwks-rack" once S1/S2 are merged.
    assert h["state"] == "ready" and h["voice_engine"] and h["fx_engine"]
    assert h["disk_free_bytes"] > 0 and Path(h["data_dir"]).is_dir()


# ------------------------------------------------------------------------------------------ opt-in models (S1 hooks)

QWEN = "qwen3-tts-voicedesign"


class FakeVoiceModels:
    """Stands in for S1's list_models/install_model hooks."""

    def __init__(self, size=1_000_000_000):
        from fvwks_contracts.models import ModelInfo

        self.info = {m: ModelInfo(id=m, name=n, engine=e, size_bytes=sz, installed=inst, required=req,
                                  license="Apache-2.0", description="")
                     for m, n, e, sz, inst, req in [("kokoro-82m", "Kokoro 82M", "kokoro", 330_000_000, True, True),
                                                    (QWEN, "Qwen3-TTS VoiceDesign", "qwen3", size, False, False)]}
        self.release = __import__("threading").Event()
        self.calls = []

    def list_models(self):
        return list(self.info.values())

    def install_model(self, model_id, progress):
        self.calls.append(model_id)
        for i in range(1, 5):
            progress(i / 5, f"shard {i}/4")
            if not self.release.wait(5):
                raise TimeoutError("test never released the download")
        self.info[model_id] = self.info[model_id].model_copy(update={"installed": True})


@pytest.fixture
def models(monkeypatch):
    fake = FakeVoiceModels()
    monkeypatch.setattr(voice_api, "list_models", fake.list_models, raising=False)
    monkeypatch.setattr(voice_api, "install_model", fake.install_model, raising=False)
    return fake


def test_model_install_job_with_progress(client, models):
    assert [m["installed"] for m in ok(client.get("/api/models"))] == [True, False]
    job = ok(client.post(f"/api/models/{QWEN}/install"))
    assert job["kind"] == "model_install" and job["state"] in ("queued", "running")
    assert ok(client.post(f"/api/models/{QWEN}/install"))["id"] == job["id"]  # one download per model
    deadline = time.time() + 5
    while ok(client.get(f"/api/jobs/{job['id']}"))["progress"] < 0.2 and time.time() < deadline:
        time.sleep(0.01)
    running = ok(client.get(f"/api/jobs/{job['id']}"))
    assert running["state"] == "running" and running["message"] == "shard 1/4"
    models.release.set()
    done = wait_job(client, job["id"])
    assert done["state"] == "done" and done["progress"] == 1.0 and done["message"] == "Qwen3-TTS VoiceDesign installed."
    assert models.calls == [QWEN] and ok(client.get("/api/models"))[1]["installed"] is True
    again = ok(client.post(f"/api/models/{QWEN}/install"))
    assert again["state"] == "done" and "already installed" in again["message"]


def test_model_install_can_be_cancelled(client, models):
    job = ok(client.post(f"/api/models/{QWEN}/install"))
    deadline = time.time() + 5
    while ok(client.get(f"/api/jobs/{job['id']}"))["state"] != "running" and time.time() < deadline:
        time.sleep(0.01)
    ok(client.post(f"/api/jobs/{job['id']}/cancel"))
    models.release.set()  # the next progress() call raises
    assert wait_job(client, job["id"])["state"] == "cancelled"
    assert ok(client.get("/api/models"))[1]["installed"] is False


def test_model_install_keeps_5gb_free(client, models, monkeypatch):
    from collections import namedtuple

    from fvwks_server import service as service_module

    usage = namedtuple("usage", "total used free")
    monkeypatch.setattr(service_module.shutil, "disk_usage", lambda path: usage(100e9, 94e9, 5.5e9))
    job = ok(client.post(f"/api/models/{QWEN}/install"))  # 1 GB model + 5 GB reserve > 5.5 GB free
    assert job["state"] == "error" and job["error"]["code"] == "disk_full"
    assert "0.5 GB" in job["error"]["hint"] and models.calls == []


def test_voice_errors_keep_their_shape(client, monkeypatch):
    class VoiceError(Exception):  # the shape of fvwks_voice.errors.VoiceError
        def __init__(self, code, message, hint=None, status=400):
            super().__init__(message)
            self.code, self.message, self.hint, self.status = code, message, hint, status

    def broken(req, lexicon=None):
        raise VoiceError("script_empty", "Nothing to say after markup.", "Type some words.", status=422)

    monkeypatch.setattr(voice_api, "synthesize", broken)
    res = client.post("/api/sources/tts", json={"script": "[2b]"})
    assert res.status_code == 422
    assert res.json()["error"] == {"code": "script_empty", "message": "Nothing to say after markup.",
                                   "hint": "Type some words.", "retryable": False, "model_id": None}
    monkeypatch.setattr(voice_api, "synthesize", lambda req, lexicon=None: 1 / 0)
    crash = client.post("/api/sources/tts", json={"script": "hi"})
    assert crash.status_code == 500 and crash.json()["error"]["code"] == "tts_failed"
    persona = client.post("/api/sources/tts", json={"script": "hi", "voice_id": "persona:abc"})
    assert persona.json()["error"]["code"] == "voice_not_found" and "Qwen3" in persona.json()["error"]["hint"]


def test_voice_configure_hook(tmp_path, monkeypatch):
    seen = []
    monkeypatch.setattr(voice_api, "configure", lambda data_dir: seen.append(data_dir), raising=False)
    make_client(tmp_path)
    assert seen == [(tmp_path / "data").resolve() / "voice"] and seen[0].is_dir()


# ------------------------------------------------------------------------------------------ v0.1 contract fields


def test_v01_source_fields_and_take_source_id(client, monkeypatch):
    stack_bpms = []
    real_synth = voice_api.synthesize

    def synth(req, lexicon=None):
        if req.voice_id != "kokoro:am_fenrir":
            stack_bpms.append(req.bpm)
        return real_synth(req, lexicon)

    monkeypatch.setattr(voice_api, "synthesize", synth)
    src = tts(client, bpm=128)
    assert src["bpm"] == 128 and src["analysis_state"] in ("queued", "running", "done") and src["warnings"] == []
    deadline = time.time() + 5
    while ok(client.get(f"/api/sources/{src['id']}"))["analysis_state"] != "done" and time.time() < deadline:
        time.sleep(0.01)
    assert ok(client.get(f"/api/sources/{src['id']}"))["analysis_state"] == "done"
    assert ok(client.get("/api/sources"))["items"][0]["analysis_state"] == "done"
    r = render(client, src["id"], quality="final")  # PACT stacks two TTS voices
    assert len(stack_bpms) >= 2 and set(stack_bpms) == {128}  # stack voices size [Nb] pauses like the main voice
    take = ok(client.get("/api/library"))["items"][0]
    assert take["source_id"] == src["id"] and take["render_id"] == r["id"]


def test_v01_export_warns_about_clipping(client, monkeypatch):
    real_render = fx_api.render

    def hot(main, stack, req):
        out = real_render(main, stack, req)
        out.audio = out.audio * 0 + 1.5  # way over full scale
        return out

    monkeypatch.setattr(fx_api, "render", hot)
    r = render(client, tts(client)["id"], quality="final", auto_export=False)
    result = ok(client.post("/api/exports", json={"render_ids": [r["id"]], "variants": ["wet"]}))
    assert len(result["warnings"]) == 1 and "samples clipped at 24-bit" in result["warnings"][0]


def test_v01_script_preview_hooks(client, monkeypatch):
    stub = ok(client.post("/api/script/preview", json={"script": SCRIPT, "bpm": 140}))
    assert [seg["flags"]["throw"] for seg in stub["segments"]] == [False, True]  # warnings only from the stub parse
    seen = []

    def old_hook(script, lexicon=None):  # S1's pre-v0.1 signature (no bpm)
        seen.append(("old", script, len(lexicon.entries)))
        return {"segments": [{"text": script, "say": "we are guy fawkes", "flags": {}}], "warnings": []}

    monkeypatch.setattr(voice_api, "preview_script", old_hook, raising=False)
    out = ok(client.post("/api/script/preview", json={"script": "WE ARE GUY FVWKS", "bpm": 140}))
    assert out["segments"][0]["say"] == "we are guy fawkes" and seen[-1][0] == "old" and seen[-1][2] >= 13

    def new_hook(script, lexicon=None, bpm=None):
        seen.append(("new", bpm))
        return {"segments": [], "warnings": [f"bpm={bpm}"]}

    monkeypatch.setattr(voice_api, "preview_script", new_hook, raising=False)
    assert ok(client.post("/api/script/preview", json={"script": "x", "bpm": 150}))["warnings"] == ["bpm=150.0"]

    class VoiceError(Exception):
        def __init__(self):
            super().__init__("Unmatched '*'.")
            self.code, self.message, self.hint, self.status = "markup_invalid", "Unmatched '*'.", "Close it.", 422

    def broken(script, lexicon=None, bpm=None):
        raise VoiceError()

    monkeypatch.setattr(voice_api, "preview_script", broken, raising=False)
    res = client.post("/api/script/preview", json={"script": "*oops"})
    assert res.status_code == 422 and res.json()["error"]["code"] == "markup_invalid"


def test_v01_prerender_recommended_auditions(client):
    service = client.app.state.service
    voices = ok(client.get("/api/voices"))
    recommended = [v for v in voices if v["recommended"]]
    assert recommended and all(v["sample_audio_id"] for v in voices)
    assert service.prerender_samples() == len(recommended)
    assert all(service.audio.exists(v["sample_audio_id"]) for v in recommended)
    assert not any(service.audio.exists(v["sample_audio_id"]) for v in voices if not v["recommended"])
    assert service.prerender_samples() == 0  # already on disk


def test_v01_persona_design_candidates_and_save(client, monkeypatch):
    from fvwks_contracts.models import Voice

    real_synth = voice_api.synthesize

    def design(req):
        return [real_synth(voice_api.TTSRequest(script=req.sample_text, voice_id=v), None)
                for v in ("kokoro:am_fenrir", "kokoro:am_michael", "kokoro:bm_george")[: req.candidates]]

    saved = []

    def save(name, candidate):
        saved.append((name, candidate.audio.shape))
        return Voice(id="persona:entity", engine="persona", name=name, language="en-US", gender="male")

    monkeypatch.setattr(voice_api, "design_persona", design, raising=False)
    monkeypatch.setattr(voice_api, "save_persona", save, raising=False)
    job = wait_job(client, ok(client.post("/api/personas/design",
                                          json={"description": "deep gravelly narrator", "candidates": 2}))["id"])
    assert job["state"] == "done" and len(job["result_ids"]) == 2
    cand = ok(client.get(f"/api/personas/candidates/{job['result_ids'][0]}"))
    assert cand["id"] == cand["audio_id"] == job["result_ids"][0]
    assert client.get(f"/api/audio/{cand['audio_id']}").status_code == 200
    persona = ok(client.post("/api/personas", json={"candidate_id": cand["id"], "name": "Entity"}))
    assert persona["id"] == "persona:entity" and persona["sample_audio_id"] == cand["audio_id"]
    assert saved and saved[0][0] == "Entity"
    assert [v["id"] for v in ok(client.get("/api/voices"))].count("persona:entity") == 1


# ------------------------------------------------------------------------------------------ review regressions


def test_gc_never_drops_recordings_or_sources_in_use(tmp_path, monkeypatch):
    c = make_client(tmp_path, source_keep=2)
    wav = tmp_path / "me.wav"
    sf.write(wav, 0.3 * np.sin(np.arange(44100) / 20), 44100, subtype="PCM_16")
    with open(wav, "rb") as fh:
        rec = ok(c.post("/api/sources/upload", files={"file": ("me.wav", fh, "audio/wav")}, data={"kind": "recording"}))
    a = tts(c, script="line a")
    render(c, a["id"])  # a render references A
    b, cc, d = (tts(c, script=f"line {x}") for x in "bcd")
    alive = {s["id"]: c.get(f"/api/sources/{s['id']}").status_code for s in (rec, a, b, cc, d)}
    assert alive == {rec["id"]: 200, a["id"]: 200, b["id"]: 404, cc["id"]: 200, d["id"]: 200}

    real = voice_api.synthesize

    def stale_clock(req, lexicon=None):  # a voice package that stamps an old created_at
        src = real(req, lexicon)
        src.info.created_at = "2000-01-01T00:00:00+00:00"
        return src

    monkeypatch.setattr(voice_api, "synthesize", stale_clock)
    e = tts(c, script="line e")
    assert not e["created_at"].startswith("2000") and c.get(f"/api/sources/{e['id']}").status_code == 200


def test_final_render_follows_export_settings(client, tmp_path):
    src = tts(client)
    first = render(client, src["id"], quality="final")["export"]
    settings = ok(client.get("/api/settings"))
    root2 = tmp_path / "second-root"
    ok(client.put("/api/settings", json={**settings, "export_dir": str(root2)}))
    moved = render(client, src["id"], quality="final")
    assert moved["export"]["path"].startswith(str(root2.resolve())) and moved["export"]["id"] != first["id"]
    ok(client.put("/api/settings", json={**settings, "export_dir": str(root2), "format": "wav"}))
    wav = render(client, src["id"], quality="final")["export"]
    assert wav["format"] == "wav" and wav["path"].endswith(".wav")
    take = ok(client.get("/api/library"))["items"][0]
    assert {e["id"] for e in take["exports"]} == {moved["export"]["id"], wav["id"]}  # root1's file isn't returned
    assert ok(client.get(f"/api/renders/{moved['id']}"))["export"]["id"] == wav["id"]


def test_target_path_root_is_validated(client):
    settings = ok(client.get("/api/settings"))
    for bad in ("~/Music/FoxBox", "Music/FoxBox"):
        res = client.put("/api/settings", json={**settings, "rekordbox": {**settings["rekordbox"],
                                                                         "target_path_root": bad}})
        assert res.status_code == 400 and res.json()["error"]["code"] == "invalid_settings", bad
    good = ok(client.put("/api/settings", json={**settings, "rekordbox": {**settings["rekordbox"],
                                                                          "target_path_root": "C:\\Music"}}))
    assert good["rekordbox"]["target_path_root"] == "C:\\Music"
    r = render(client, tts(client)["id"], quality="final")
    xml = ok(client.post("/api/exports/rekordbox", json={"export_ids": [r["export"]["id"]]}))
    assert parse_rekordbox_xml(Path(xml["path"]).read_bytes())["tracks"][0]["path"].startswith("C:/Music/")
    res = client.post("/api/exports/rekordbox", json={"export_ids": [r["export"]["id"]], "target_path_root": "x/y"})
    assert res.status_code == 422 and res.json()["error"]["code"] == "invalid_request"


def test_token_checked_before_the_body_and_no_docs(client):
    anon = TestClient(client.app)
    bad_json = anon.post("/api/render", content=b"{not json" * 1000, headers={"content-type": "application/json"})
    assert bad_json.status_code == 401 and bad_json.json()["error"]["code"] == "unauthorized"
    upload = anon.post("/api/sources/upload", files={"file": ("x.wav", b"\0" * 100_000, "audio/wav")})
    assert upload.status_code == 401
    for path in ("/openapi.json", "/docs", "/redoc"):
        assert anon.get(path).status_code == 401
        assert client.get(path).status_code == 404
    assert client.app.openapi()["paths"]  # the contract export still works


def test_final_render_is_idempotent_across_restart_and_concurrency(tmp_path):
    import threading

    first = make_client(tmp_path)
    src = tts(first)
    a = render(first, src["id"], quality="final")
    again = make_client(tmp_path)  # engine restarted: the in-memory cache is gone
    b = render(again, tts(again)["id"], quality="final")
    assert b["id"] == a["id"] and b["export"]["id"] == a["export"]["id"]
    assert ok(again.get("/api/library"))["total"] == 1
    assert sorted(p.name for p in (tmp_path / "exports").iterdir()) == [a["export"]["filename"]]

    results = []
    body = {"source_id": src["id"], "preset_id": "unit", "quality": "final",
            "arrange": {"bpm": 140, "bars": 4, "key": "Am"}}
    threads = [threading.Thread(target=lambda: results.append(again.post("/api/render", json=body).json()))
               for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len({r["id"] for r in results}) == 1 and len({r["export"]["id"] for r in results}) == 1
    assert ok(again.get("/api/library"))["total"] == 2


def test_voices_answer_during_warm_up(client, monkeypatch):
    import threading

    release = threading.Event()
    monkeypatch.setattr(voice_api, "warm_up", lambda: release.wait(5), raising=False)
    service = client.app.state.service
    service.start()
    try:
        assert ok(client.get("/api/health"))["state"] == "loading_model"
        t0 = time.perf_counter()
        assert ok(client.get("/api/voices"))
        assert time.perf_counter() - t0 < 1.0  # metadata never waits for the model lock
    finally:
        release.set()
    deadline = time.time() + 5
    while ok(client.get("/api/health"))["state"] != "ready" and time.time() < deadline:
        time.sleep(0.02)
    assert ok(client.get("/api/health"))["state"] == "ready"


# ------------------------------------------------------------------------------------------ robustness pass 2


def test_unplugged_export_drive_keeps_the_vault_working(client, tmp_path):
    usb = tmp_path / "USB"
    settings = ok(client.get("/api/settings"))
    ok(client.put("/api/settings", json={**settings, "export_dir": str(usb / "Drops")}))
    src = tts(client)
    first = render(client, src["id"], quality="final")
    assert first["export"] is not None
    usb.rename(tmp_path / "USB-ejected")
    usb.write_bytes(b"")  # the mount point is gone: the export folder can't be created
    lib = ok(client.get("/api/library"))
    assert lib["total"] == 1 and lib["items"][0]["exports"] == []  # the take is listed, its file isn't
    assert ok(client.get(f"/api/renders/{first['id']}"))["export"] is None
    assert ok(client.get("/api/health"))["state"] == "ready"
    again = render(client, src["id"], preset_id="unit", quality="final")  # renders still work...
    assert again["export"] is None and any(w.startswith("Not exported") for w in again["warnings"])
    assert ok(client.get("/api/library"))["total"] == 2  # ...and become takes
    res = client.post("/api/exports", json={"render_ids": [again["id"]]})
    assert res.status_code == 409 and res.json()["error"]["code"] == "export_dir_unavailable"


def test_broken_voice_configure_hook_does_not_stop_the_engine(tmp_path, monkeypatch):
    def broken(data_dir):
        raise RuntimeError("espeak data missing")

    monkeypatch.setattr(voice_api, "configure", broken, raising=False)
    c = make_client(tmp_path)
    health = ok(c.get("/api/health"))
    assert health["state"] == "ready" and "Voice setup failed: espeak data missing" in health["message"]
    assert tts(c)["id"]


def test_fast_peaks_match_the_contract_helper():
    from fvwks_contracts.audio import peaks as contract_peaks

    from fvwks_server.audio_io import peaks

    rng = np.random.default_rng(3)
    for shape in [(2, 604_800), (1, 1_000), (700,), (2, 801), (1, 5)]:
        x = (rng.standard_normal(shape) * 0.7).astype(np.float32)
        assert peaks(x, 44100) == contract_peaks(x, 44100)
    assert peaks(np.zeros((2, 0), np.float32), 44100) == contract_peaks(np.zeros((2, 0), np.float32), 44100)


def test_settings_are_cached_but_updates_are_seen(client):
    service = client.app.state.service
    first = ok(client.get("/api/settings"))
    service.library.get_setting = None  # a cached read never touches the library again
    assert ok(client.get("/api/settings")) == first
    del service.library.get_setting
    ok(client.put("/api/settings", json={**first, "artist": "GUY FVWKS LIVE"}))
    assert ok(client.get("/api/settings"))["artist"] == "GUY FVWKS LIVE"
    got = service.settings()
    got.artist = "mutated by a caller"
    assert service.settings().artist == "GUY FVWKS LIVE"  # callers get copies


def test_startup_sweeps_stale_temp_files_only(client, tmp_path):
    import os

    service = client.app.state.service
    export_root = Path(ok(client.get("/api/settings"))["export_dir"])
    old = time.time() - 7200
    stale = [export_root / ".GUYFVWKS_PACT_x_wet_v01.aiff.0123abcd.part",
             export_root / "Warehouse" / ".warehouse_rekordbox.xml.89abcdef.part",
             service.audio.dir / ".rnd_000000000001.wav.fedcba98.part",
             service.config.cache_dir / "stack" / "ab" / ".abcd.npz.00000000.part"]
    fresh = export_root / ".GUYFVWKS_PACT_x_dry_v01.aiff.11112222.part"  # maybe being written right now
    user_files = [export_root / ".DS_Store", export_root / "notes.part", export_root / "mix.aiff"]
    for path in [*stale, fresh, *user_files]:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x")
    for path in [*stale, *user_files]:
        os.utime(path, (old, old))
    assert service.housekeeping() == len(stale)
    assert not any(p.exists() for p in stale)
    assert fresh.exists() and all(p.exists() for p in user_files)


def test_stream_copies_stay_within_budget(client):
    service = client.app.state.service
    service.audio.stream_budget = 1  # keep only the one just made
    src = tts(client)
    a = render(client, src["id"])
    assert client.get(f"/api/audio/{a['audio_id']}").status_code == 200
    assert client.get(f"/api/audio/{a['dry_audio_id']}").status_code == 200
    streams = sorted(p.name for p in service.audio.stream_dir.glob("*.wav"))
    assert streams == [f"{a['dry_audio_id']}.wav"]  # the older copy was pruned; masters untouched
    assert service.audio.exists(a["audio_id"])
    assert client.get(f"/api/audio/{a['audio_id']}").status_code == 200  # and re-created on demand


def test_persona_work_does_not_hold_up_kokoro_tts(client, monkeypatch):
    import threading

    started, release = threading.Event(), threading.Event()

    def slow_design(req):  # the persona model is busy for a long time
        started.set()
        release.wait(5)
        return []

    monkeypatch.setattr(voice_api, "design_persona", slow_design, raising=False)
    job = ok(client.post("/api/personas/design", json={"description": "deep gravelly narrator"}))
    assert started.wait(5)
    t0 = time.perf_counter()
    try:
        tts(client, script="kokoro keeps talking")  # a different model: no waiting
        assert time.perf_counter() - t0 < 4.0
    finally:
        release.set()
    assert wait_job(client, job["id"])["state"] == "done"


def test_models_and_preview_with_the_real_voice_hooks(client):
    """Only the cheap real-hook paths: never downloads (installs only run for models that are already installed)."""
    if not callable(getattr(voice_api, "list_models", None)):
        pytest.skip("this voice package has no model hooks yet (S1's VoiceHooks land with session/s1-voice)")
    models = ok(client.get("/api/models"))
    assert models and all(m["size_bytes"] > 0 and isinstance(m["installed"], bool) for m in models)
    assert any(m["installed"] and m["required"] for m in models)  # the default TTS model ships installed
    for model in (m for m in models if m["installed"]):
        job = ok(client.post(f"/api/models/{model['id']}/install"))
        assert job["state"] == "done" and "already installed" in job["message"]
    if callable(getattr(voice_api, "preview_script", None)):
        preview = ok(client.post("/api/script/preview", json={"script": "WE ARE GUY FVWKS | EXPECT *US*",
                                                              "bpm": 140}))
        assert [seg["flags"]["throw"] for seg in preview["segments"]] == [False, True]
        assert "fawkes" in preview["segments"][0]["say"].lower()  # the lexicon applied by the real voice package


def test_dev_export_folder_in_a_hidden_path_keeps_working(tmp_path):
    config = Config.from_env(str(tmp_path / ".devdata" / "data"), None, TOKEN)  # dev default: <.devdata>/exports
    assert config.export_dir == (tmp_path / ".devdata" / "exports").resolve()
    c = open_client(config)
    settings = ok(c.get("/api/settings"))
    saved = ok(c.put("/api/settings", json={**settings, "format": "wav"}))  # unchanged folder: accepted
    assert saved["format"] == "wav" and saved["export_dir"] == settings["export_dir"]
    other = c.put("/api/settings", json={**settings, "export_dir": str(tmp_path / ".other" / "x")})
    assert other.status_code == 400  # but a *new* hidden folder isn't


# ------------------------------------------------------------------------------------------ review pass 3


def test_export_write_failures_map_to_clear_errors(client, monkeypatch):
    import soundfile

    from fvwks_server import writer

    src = tts(client)
    real = writer.write_track

    def disk_full(*args, **kwargs):  # what libsndfile raises when the disk fills mid-write
        raise soundfile.LibsndfileError(0, "Error : System error : No space left on device")

    monkeypatch.setattr(writer, "write_track", disk_full)
    final = render(client, src["id"], quality="final")  # the render and its take survive
    assert final["export"] is None and any("disk is full" in w for w in final["warnings"])
    res = client.post("/api/exports", json={"render_ids": [final["id"]]})
    assert res.status_code == 500 and res.json()["error"]["code"] == "disk_full"

    def other_failure(*args, **kwargs):
        from mutagen.aiff import error as AIFFError

        raise AIFFError("unexpected end of file")

    monkeypatch.setattr(writer, "write_track", other_failure)
    res = client.post("/api/exports", json={"render_ids": [final["id"]]})
    assert res.status_code == 500 and res.json()["error"]["code"] == "export_failed"
    monkeypatch.setattr(writer, "write_track", real)
    assert ok(client.post("/api/exports", json={"render_ids": [final["id"]]}))["files"]
    export_root = Path(ok(client.get("/api/settings"))["export_dir"])
    assert not [p for p in export_root.iterdir() if p.name.endswith(".part")]


def test_failed_render_store_leaves_no_orphans(client, monkeypatch):
    service = client.app.state.service
    src = tts(client)
    wait_analysed(client, src["id"])
    before = {p.name for p in service.audio.dir.iterdir() if p.is_file()}
    real_put = service.audio.put

    def put(audio, sr, prefix="aud", **kw):
        if prefix == "dry":
            raise OSError(28, "No space left on device")
        return real_put(audio, sr, prefix, **kw)

    monkeypatch.setattr(service.audio, "put", put)
    res = client.post("/api/render", json={"source_id": src["id"], "preset_id": "raw"})
    assert res.status_code == 500 and res.json()["error"]["code"] == "disk_full"
    after = {p.name for p in service.audio.dir.iterdir() if p.is_file()}
    assert after == before  # the wet master written before the failure was removed


def test_analysis_restarts_cleanly_after_an_engine_restart(tmp_path):
    first = make_client(tmp_path)
    src = tts(first)
    wait_analysed(first, src["id"])
    first.app.state.service.library.update("sources", src["id"], analysis_state="running")  # killed mid-analysis
    first.app.state.service.jobs.shutdown(cancel=True, wait=True)
    again = make_client(tmp_path)
    assert ok(again.get(f"/api/sources/{src['id']}"))["analysis_state"] == "none"  # not stuck, not falsely "done"
    render(again, src["id"], preset_id="raw")  # first use in this process re-queues the analysis
    wait_analysed(again, src["id"])
    assert ok(again.get(f"/api/sources/{src['id']}"))["analysis_state"] == "done"


def test_previews_are_re_rendered_once_the_analysis_lands(client, monkeypatch):
    import threading

    gate = threading.Event()
    real_analyze = fx_api.analyze
    monkeypatch.setattr(fx_api, "analyze", lambda source: (gate.wait(10), real_analyze(source)))
    src = tts(client)
    early = render(client, src["id"], preset_id="raw")  # quick-analysis preview
    assert render(client, src["id"], preset_id="raw")["id"] == early["id"]  # still cached meanwhile
    gate.set()
    wait_analysed(client, src["id"])
    late = render(client, src["id"], preset_id="raw")
    assert late["id"] != early["id"]  # rendered again with the full analysis


def test_setlist_keeps_its_folder_when_settings_change(client, tmp_path, monkeypatch):
    import threading

    started, release = threading.Event(), threading.Event()
    real_render = fx_api.render

    def slow_first(main, stack, req):
        if not started.is_set():
            started.set()
            release.wait(10)
        return real_render(main, stack, req)

    monkeypatch.setattr(fx_api, "render", slow_first)
    old_root = Path(ok(client.get("/api/settings"))["export_dir"])
    job = ok(client.post("/api/batch", json={"lines": [{"script": s} for s in ("one line", "two line", "three")],
                                              "playlist": "Friday", "preset_id": "raw"}))
    assert started.wait(10)
    settings = ok(client.get("/api/settings"))
    ok(client.put("/api/settings", json={**settings, "export_dir": str(tmp_path / "Elsewhere")}))
    release.set()
    done = wait_job(client, job["id"])
    assert done["state"] == "done" and [i["state"] for i in done["items"]] == ["done"] * 3
    assert Path(done["message"]).parent == old_root / "Friday"
    assert len(list((old_root / "Friday").glob("*.aiff"))) == 3


def test_settings_save_with_the_export_drive_unplugged(client, tmp_path):
    usb = tmp_path / "USB"
    settings = ok(client.get("/api/settings"))
    saved = ok(client.put("/api/settings", json={**settings, "export_dir": str(usb / "Drops")}))
    usb.rename(tmp_path / "gone")
    usb.write_bytes(b"")  # can't be created now
    again = ok(client.put("/api/settings", json={**saved, "artist": "GUY FVWKS LIVE"}))  # unchanged folder: no probing
    assert again["artist"] == "GUY FVWKS LIVE"


def test_preview_gc_keeps_a_preview_just_reused(tmp_path):
    c = make_client(tmp_path, preview_keep=2)
    src = tts(c)
    wait_analysed(c, src["id"])
    body = lambda d: {"macros": {"depth": d, "grit": 0, "machine": 0, "space": 0}}  # noqa: E731
    a = render(c, src["id"], **body(0.1))
    b = render(c, src["id"], **body(0.2))
    assert render(c, src["id"], **body(0.1))["id"] == a["id"]  # back to A: served from the cache
    render(c, src["id"], **body(0.3))
    assert c.get(f"/api/renders/{a['id']}").status_code == 200
    assert c.get(f"/api/renders/{b['id']}").status_code == 404


def test_key_locks_are_exact(client):
    import threading

    service = client.app.state.service
    inside, release = threading.Event(), threading.Event()

    def hold(key):
        with service._keyed(key):
            inside.set()
            release.wait(5)

    t = threading.Thread(target=hold, args=("a" * 64,))
    t.start()
    assert inside.wait(5)
    t0 = time.perf_counter()
    with service._keyed("b" * 64):  # a different key never waits
        assert time.perf_counter() - t0 < 0.5
    release.set()
    t.join(5)
    assert service._key_locks == {}  # nothing left behind


def test_superseded_previews_are_dropped(client, monkeypatch):
    import threading

    src = tts(client)
    wait_analysed(client, src["id"])
    started, release = threading.Event(), threading.Event()
    real_render = fx_api.render

    def slow(main, stack, req):
        if not started.is_set():
            started.set()
            release.wait(10)
        return real_render(main, stack, req)

    monkeypatch.setattr(fx_api, "render", slow)
    results = {}

    def preview(name, depth):
        results[name] = client.post("/api/render", json={"source_id": src["id"], "preset_id": "raw",
                                                         "macros": {"depth": depth, "grit": 0, "machine": 0,
                                                                    "space": 0}})

    first = threading.Thread(target=preview, args=("p1", 0.1))
    first.start()
    assert started.wait(5)
    second = threading.Thread(target=preview, args=("p2", 0.2))
    second.start()
    time.sleep(0.3)  # p2 is waiting for the render lane
    third = threading.Thread(target=preview, args=("p3", 0.3))
    third.start()
    time.sleep(0.3)
    release.set()
    for t in (first, second, third):
        t.join(10)
    assert results["p1"].status_code == 200 and results["p3"].status_code == 200
    assert results["p2"].status_code == 409 and results["p2"].json()["error"]["code"] == "superseded"


def test_saved_master_and_arrange_settings_reach_renders(client):
    service = client.app.state.service
    settings = ok(client.get("/api/settings"))
    settings["master"].update(sample_rate=48000, true_peak_db=-2.0, target_lufs=-9.0)
    settings.update(default_bpm=128.0, default_key="F#m")
    ok(client.put("/api/settings", json=settings))
    src = tts(client)
    r = ok(client.post("/api/render", json={"source_id": src["id"], "preset_id": "raw", "master": {"mode": "club"},
                                            "arrange": {"bars": 4}}))
    assert r["sample_rate"] == 48000 and r["bpm"] == 128 and r["key"] == "F#m"
    stored = service.library.get("renders", r["id"])["request"]
    assert stored["master"]["true_peak_db"] == -2 and stored["master"]["target_lufs"] == -9
    explicit = ok(client.post("/api/render", json={"source_id": src["id"], "preset_id": "raw",
                                                   "master": {"mode": "club", "sample_rate": 44100},
                                                   "arrange": {"bpm": 140, "bars": 4, "key": "Am"}}))
    assert explicit["sample_rate"] == 44100 and explicit["bpm"] == 140 and explicit["key"] == "Am"  # client wins


def test_stack_prefetch_does_not_wait_for_the_main_analysis(client, monkeypatch):
    import threading

    gate, synthesized = threading.Event(), []
    real_synth, real_analyze = voice_api.synthesize, fx_api.analyze
    monkeypatch.setattr(fx_api, "analyze", lambda source: (gate.wait(10) if source.info.voice_id == "kokoro:am_fenrir"
                                                          else None, real_analyze(source)))

    def synth(req, lexicon=None):
        synthesized.append(req.voice_id)
        return real_synth(req, lexicon)

    monkeypatch.setattr(voice_api, "synthesize", synth)
    tts(client)  # its main analysis is stuck...
    deadline = time.time() + 10
    while "kokoro:bm_george" not in synthesized and time.time() < deadline:
        time.sleep(0.02)
    assert "kokoro:bm_george" in synthesized  # ...but the stack voices were prefetched anyway
    gate.set()


def test_health_error_clears_after_a_successful_line(client):
    service = client.app.state.service
    service._state = ("error", None, "Voice model failed to load: boom")
    assert ok(client.get("/api/health"))["state"] == "error"
    tts(client, script="it works after all")
    assert ok(client.get("/api/health"))["state"] == "ready"


def test_persona_auditions_use_the_saved_clip(client, monkeypatch):
    from fvwks_contracts.models import Voice

    real_list, real_synth = voice_api.list_voices, voice_api.synthesize
    persona = Voice(id="persona:entity", engine="persona", name="Entity", language="en-US", gender="male")
    monkeypatch.setattr(voice_api, "design_persona",
                        lambda req: [real_synth(voice_api.TTSRequest(script=req.sample_text,
                                                                     voice_id="kokoro:am_fenrir"), None)],
                        raising=False)
    monkeypatch.setattr(voice_api, "save_persona", lambda name, candidate: persona, raising=False)
    monkeypatch.setattr(voice_api, "list_voices", lambda: [*real_list(), persona])  # S1 lists its personas
    job = wait_job(client, ok(client.post("/api/personas/design", json={"description": "deep narrator"}))["id"])
    cid = job["result_ids"][0]
    ok(client.post("/api/personas", json={"candidate_id": cid, "name": "Entity"}))
    listed = [v for v in ok(client.get("/api/voices")) if v["id"] == "persona:entity"]
    assert len(listed) == 1 and listed[0]["sample_audio_id"] == cid


def test_audio_etag_is_stable_and_uploads_dedupe(client, tmp_path):
    src = tts(client)
    first = client.get(f"/api/audio/{src['audio_id']}").headers.get("etag")
    time.sleep(0.02)
    assert client.get(f"/api/audio/{src['audio_id']}").headers.get("etag") == first
    wav = tmp_path / "take.wav"
    sf.write(wav, 0.3 * np.sin(np.arange(48000) / 15), 48000, subtype="PCM_16")
    ids = []
    for _ in range(2):  # the app re-sends a recording after a relaunch
        with open(wav, "rb") as fh:
            ids.append(ok(client.post("/api/sources/upload", files={"file": ("take.wav", fh, "audio/wav")},
                                      data={"kind": "recording"}))["id"])
    assert ids[0] == ids[1] and ok(client.get("/api/sources?kind=recording"))["total"] == 1


def test_start_up_survives_a_failing_clean_up(client, monkeypatch):
    service = client.app.state.service

    def boom():
        raise PermissionError("export folder on a hung network share")

    monkeypatch.setattr(service, "housekeeping", boom)
    service.start()
    deadline = time.time() + 10
    while ok(client.get("/api/health"))["state"] != "ready" and time.time() < deadline:
        time.sleep(0.02)
    assert ok(client.get("/api/health"))["state"] == "ready"


# ------------------------------------------------------------------------------------------ v0.2 AUTO bars

BAR = 240 / 140 * 44100  # samples per bar at 140 BPM


def resolving_fx(monkeypatch, auto_to=8):
    """fx that resolves "auto" to `auto_to` bars; records the bars every render asked for. The rack's own reported
    count wins, since from v0.4 it grows the bars rather than cut speech (so tests pick a count with room)."""
    real, asked = fx_api.render, []

    def render(main, stack, req):
        asked.append(req.arrange.bars)
        if req.arrange.bars != "auto":
            return real(main, stack, req)
        out = real(main, stack, req.model_copy(update={"arrange": req.arrange.model_copy(update={"bars": auto_to})}))
        return dataclasses.replace(out, bars=getattr(out, "bars", None) or auto_to)

    monkeypatch.setattr(fx_api, "render", render)
    return asked


def test_v02_auto_bars_resolve_in_files_takes_tags_and_variants(client, monkeypatch):
    asked = resolving_fx(monkeypatch, auto_to=8)
    src = tts(client)
    r = ok(client.post("/api/render", json={"source_id": src["id"], "preset_id": "pact", "quality": "final",
                                            "arrange": {"bpm": 140, "key": "Am"}}))  # bars unset: Settings' "auto"
    assert asked == ["auto"] and r["bars"] == 8 and r["n_samples"] == round(8 * BAR)
    auto = r["export"]
    assert auto["bars"] == 8 and auto["filename"] == "GUYFVWKS_PACT_we-are-guy-fvwks_140bpm_8bar_Am_wet_v01.aiff"
    params = json.loads(AIFF(auto["path"]).tags["TXXX:FVWKS_RENDER"].text[0])
    assert params["render"]["request"]["arrange"]["bars"] == "auto" and params["render"]["bars"] == 8  # reproducible
    take = ok(client.get("/api/library"))["items"][0]
    assert take["bars"] == 8

    # An alt preset re-renders on this render's grid, not on a fresh "auto" that another chain could move.
    files = ok(client.post("/api/exports", json={"render_ids": [r["id"]], "variants": ["alt:legion"]}))["files"]
    assert asked[-1] == 8 and files[0]["bars"] == 8 and "_8bar_" in files[0]["filename"]
    assert sf.info(files[0]["path"]).frames == round(8 * BAR)

    xml = ok(client.post("/api/exports/rekordbox", json={"export_ids": [auto["id"], files[0]["id"]]}))
    assert [Path(t["path"]).name for t in parse_rekordbox_xml(Path(xml["path"]).read_bytes())["tracks"]] == \
        [auto["filename"], files[0]["filename"]]


def test_v02_stems_re_render_on_the_resolved_grid(client, monkeypatch):
    asked = resolving_fx(monkeypatch, auto_to=8)
    real = fx_api.render

    def with_stems(main, stack, req):
        out = real(main, stack, req)
        stems = {"dry": out.dry, "voice": out.audio} if req.stems else {}
        return dataclasses.replace(out, stems=stems)

    monkeypatch.setattr(fx_api, "render", with_stems)
    src = tts(client)
    r = ok(client.post("/api/render", json={"source_id": src["id"], "preset_id": "pact", "quality": "final",
                                            "auto_export": False}))
    assert r["bars"] == 8 and asked == ["auto"]
    files = ok(client.post("/api/exports", json={"render_ids": [r["id"]], "variants": ["wet"], "stems": True}))["files"]
    assert asked[-1] == 8  # the stems pass asked for the resolved count
    assert {f["variant"] for f in files} >= {"stem:dry", "stem:voice"}
    assert {sf.info(f["path"]).frames for f in files} == {round(8 * BAR)}


def test_v02_settings_default_bars(client, monkeypatch):
    asked = resolving_fx(monkeypatch, auto_to=8)
    settings = ok(client.get("/api/settings"))
    assert settings["default_bars"] == "auto"
    src = tts(client)

    def bars_of(**arrange):
        body = {"source_id": src["id"], "preset_id": "raw", "arrange": {"bpm": 140, **arrange}}
        return ok(client.post("/api/render", json=body))["bars"]

    assert bars_of() == 8 and asked[-1] == "auto"
    ok(client.put("/api/settings", json={**settings, "default_bars": 4}))
    assert bars_of() == 4 and asked[-1] == 4  # a saved count fills an unset field...
    assert bars_of(bars=16) == 16 and asked[-1] == 16  # ...but what the client sends wins
    assert bars_of(bars=None) is None and asked[-1] is None  # FREE stays free
    ok(client.put("/api/settings", json={**settings, "default_bars": "auto"}))
    assert bars_of(key="F#m") == 8 and asked[-1] == "auto"  # a new request, so fx sees it (no cache hit)


def test_v02_settings_saved_before_auto_still_load(tmp_path):
    first = make_client(tmp_path)
    settings = ok(first.get("/api/settings"))
    first.app.state.service.library.set_setting("settings", {**settings, "default_bars": 4})  # a v0.1 row
    again = make_client(tmp_path)
    assert ok(again.get("/api/settings"))["default_bars"] == 4


def test_v02_batch_lines_with_auto_bars(client, monkeypatch):
    asked = resolving_fx(monkeypatch, auto_to=2)
    lines = [{"script": "WE ARE GUY FVWKS", "bars": "auto"}, {"script": "EXPECT US", "bars": 8},
             {"script": "REMEMBER REMEMBER"}]
    job = ok(client.post("/api/batch", json={"lines": lines, "playlist": "Auto", "arrange": {"bpm": 140}}))
    done = wait_job(client, job["id"], timeout=60)
    assert done["state"] == "done" and asked == ["auto", 8, "auto"]
    parsed = parse_rekordbox_xml(Path(done["message"]).read_bytes())
    assert [Path(t["path"]).name.split("_")[4] for t in parsed["tracks"]] == ["2bar", "8bar", "2bar"]
    job = ok(client.post("/api/batch", json={"lines": [{"script": "ONE MORE TIME"}],
                                             "arrange": {"bpm": 140, "bars": "auto"}}))
    assert wait_job(client, job["id"], timeout=60)["state"] == "done" and asked[-1] == "auto"


def test_v02_renderinfo_bars_from_a_rack_that_does_not_report_them(client, monkeypatch):
    real = fx_api.render

    def old_rack(main, stack, req):  # pre-v0.2: resolves nothing itself and never sets RenderOutput.bars
        bars = 4 if req.arrange.bars == "auto" else req.arrange.bars
        out = real(main, stack, req.model_copy(update={"arrange": req.arrange.model_copy(update={"bars": bars})}))
        return dataclasses.replace(out, bars=None)

    monkeypatch.setattr(fx_api, "render", old_rack)
    src = tts(client)
    assert render(client, src["id"], arrange={"bpm": 140, "bars": 8})["bars"] == 8  # the request's own count
    assert render(client, src["id"], arrange={"bpm": 140, "bars": None})["bars"] is None  # FREE
    assert render(client, src["id"], arrange={"bpm": 140})["bars"] == 4  # "auto": read off the exact length


def test_v02_real_rack_resolves_auto_bars_into_filenames(client):
    if not getattr(fx_api, "AUTO_BARS", False):
        pytest.skip("fx has not implemented v0.2 AUTO bars yet (fvwks_fx.api.AUTO_BARS)")
    src = tts(client)
    r = ok(client.post("/api/render", json={"source_id": src["id"], "preset_id": "pact", "quality": "final",
                                            "arrange": {"bpm": 140}}))
    assert r["bars"] in (1, 2, 4, 8, 16) and r["n_samples"] == round(r["bars"] * BAR)
    assert f"_{r['bars']}bar_" in r["export"]["filename"] and r["export"]["bars"] == r["bars"]


# ------------------------------------------------------------------------------------------ v0.3 recordings


def noisy(tmp_path, name="take.wav", seconds=1.5, sr=48000):
    """A tone under hiss: what a phone recording looks like to the denoiser."""
    t = np.arange(int(sr * seconds)) / sr
    x = 0.3 * np.sin(2 * np.pi * 220 * t) + 0.05 * np.random.default_rng(7).standard_normal(t.size)
    path = tmp_path / name
    sf.write(path, x.astype(np.float32), sr, subtype="PCM_16")
    return path


def upload(client, path, kind="recording", **form):
    with open(path, "rb") as fh:
        return client.post("/api/sources/upload", files={"file": (path.name, fh, "audio/wav")},
                           data={"kind": kind, **form})


def transcript_of(source, script, words):
    """What transcribe/realign hand back: the source with a script and timed words. Its id and audio id are blanked,
    so the tests see the server keep its own."""
    step = source.info.duration_s / len(words)
    timed = [Word(text=w, start_s=round(i * step, 6), end_s=round((i + 1) * step, 6)) for i, w in enumerate(words)]
    segment = Segment(index=0, text=script, start_s=0.0, end_s=source.info.duration_s, words=timed)
    return Source(info=source.info.model_copy(update={"id": "", "audio_id": "", "script": script,
                                                      "segments": [segment]}), audio=source.audio)


def wait_transcribed(client, source_id, timeout=20):
    deadline = time.time() + timeout
    while (info := ok(client.get(f"/api/sources/{source_id}")))["transcript_state"] in ("queued", "running"):
        assert time.time() < deadline, "transcription never finished"
        time.sleep(0.02)
    return info


def test_v03_upload_denoise_reaches_ingest(client, monkeypatch, tmp_path):
    real, asked = voice_api.ingest, []

    def ingest(data, filename=None, kind="import", *, denoise=None):
        asked.append(denoise)
        return real(data, filename, kind, denoise=denoise)

    monkeypatch.setattr(voice_api, "ingest", ingest)
    wav = noisy(tmp_path)
    soft = ok(upload(client, wav, denoise="0.25"))
    assert asked == [0.25] and soft["denoise"] == 0.25 and soft["transcript_state"] == "none"
    full = ok(upload(client, wav, denoise="1"))
    assert asked[-1] == 1.0 and full["denoise"] == 1.0 and full["id"] != soft["id"]  # another strength, another take
    ok(upload(client, wav))
    assert asked[-1] is None  # the voice package's default for recordings
    res = upload(client, wav, denoise="1.5")
    assert res.status_code == 422 and res.json()["error"]["code"] == "invalid_request"


def test_v03_denoise_with_a_voice_package_that_cannot(client, monkeypatch, tmp_path):
    real = voice_api.ingest
    monkeypatch.setattr(voice_api, "ingest", lambda data, filename=None, kind="import": real(data, filename, kind))
    info = ok(upload(client, noisy(tmp_path), denoise="0.5"))
    assert any("can't denoise" in w for w in info["warnings"])


def test_v03_recordings_get_a_transcript_in_the_background(client, monkeypatch, tmp_path):
    import threading

    gate, calls = threading.Event(), []

    def transcribe(source):
        calls.append(source.info.id)
        gate.wait(10)
        return transcript_of(source, "WE ARE GUY FVWKS", ["WE", "ARE", "GUY", "FVWKS"])

    monkeypatch.setattr(voice_api, "transcribe", transcribe, raising=False)
    rec = ok(upload(client, noisy(tmp_path), denoise="0.5"))
    assert rec["transcript_state"] in ("queued", "running") and rec["script"] is None
    before = render(client, rec["id"], preset_id="raw")  # previewed before the words exist
    gate.set()
    info = wait_transcribed(client, rec["id"])
    assert info["transcript_state"] == "done" and info["script"] == "WE ARE GUY FVWKS"
    assert (info["id"], info["audio_id"], info["denoise"]) == (rec["id"], rec["audio_id"], 0.5) and calls == [rec["id"]]
    assert [w["text"] for w in info["segments"][0]["words"]] == ["WE", "ARE", "GUY", "FVWKS"]
    assert render(client, rec["id"], preset_id="raw")["id"] != before["id"]  # the words re-render (no stale cache)
    assert ok(client.get(f"/api/sources/{tts(client)['id']}"))["transcript_state"] == "none" and len(calls) == 1


def test_v03_transcription_failures(client, monkeypatch, tmp_path):
    class Missing(Exception):
        code, status, message, hint = "model_not_installed", 503, "Install the Whisper aligner.", None

    monkeypatch.setattr(voice_api, "transcribe", lambda source: (_ for _ in ()).throw(Missing()), raising=False)
    first = ok(upload(client, noisy(tmp_path, "a.wav")))
    assert wait_transcribed(client, first["id"])["transcript_state"] == "none"  # waits for the model, no error
    monkeypatch.setattr(voice_api, "transcribe", lambda source: 1 / 0, raising=False)
    second = ok(upload(client, noisy(tmp_path, "b.wav", seconds=2.0)))
    assert wait_transcribed(client, second["id"])["transcript_state"] == "error"
    render(client, second["id"], preset_id="raw")  # a failed transcript isn't retried behind the user's back
    assert ok(client.get(f"/api/sources/{second['id']}"))["transcript_state"] == "error"


def test_v03_transcripts_wait_for_the_model_and_restart_cleanly(tmp_path, monkeypatch):
    installed, calls = {"now": False}, []
    real_models = voice_api.list_models

    def list_models():
        return [m.model_copy(update={"installed": installed["now"]}) if m.id == "whisper-aligner" else m
                for m in real_models()]

    def transcribe(source):
        calls.append(source.info.id)
        return transcript_of(source, "EXPECT US", ["EXPECT", "US"])

    monkeypatch.setattr(voice_api, "list_models", list_models)
    monkeypatch.setattr(voice_api, "transcribe", transcribe, raising=False)
    client = make_client(tmp_path)
    rec = ok(upload(client, noisy(tmp_path)))
    assert rec["transcript_state"] == "none" and calls == []  # no model yet: nothing queued
    installed["now"] = True
    ok(client.post("/api/models/whisper-aligner/install"))  # already there: the waiting recordings go now
    assert wait_transcribed(client, rec["id"])["script"] == "EXPECT US" and calls == [rec["id"]]

    # A transcript the last process never finished starts over on first use; a finished one is kept.
    client.app.state.service.library.update("sources", rec["id"], transcript_state="running")
    again = make_client(tmp_path)
    assert ok(again.get(f"/api/sources/{rec['id']}"))["transcript_state"] == "none"
    render(again, rec["id"], preset_id="raw")
    assert wait_transcribed(again, rec["id"])["transcript_state"] == "done" and calls == [rec["id"], rec["id"]]


def test_v03_edit_a_recording_transcript(client, monkeypatch, tmp_path):
    seen = []

    def realign(source, script):
        seen.append(script)
        if script == "NOT IN IT":
            raise type("VoiceError", (Exception,), {"code": "align_failed", "status": 422, "hint": "Check the words.",
                                                    "message": "The transcript and the audio don't match."})()
        return transcript_of(source, script, script.replace("*", "").replace("|", " ").split())

    rec = ok(upload(client, noisy(tmp_path)))
    body = {"script": "WE ARE | EXPECT *US*"}
    monkeypatch.delattr(voice_api, "realign", raising=False)
    res = client.put(f"/api/sources/{rec['id']}/transcript", json=body)
    assert res.status_code == 501 and res.json()["error"]["code"] == "not_implemented"  # no realign hook
    monkeypatch.setattr(voice_api, "realign", realign, raising=False)
    info = ok(client.put(f"/api/sources/{rec['id']}/transcript", json=body))
    assert info["script"] == "WE ARE | EXPECT *US*" and info["transcript_state"] == "done"
    assert (info["id"], info["audio_id"]) == (rec["id"], rec["audio_id"]) and seen == [body["script"]]
    assert ok(client.get(f"/api/sources/{rec['id']}"))["script"] == body["script"]

    res = client.put(f"/api/sources/{rec['id']}/transcript", json={"script": "NOT IN IT"})
    assert res.status_code == 422 and res.json()["error"]["code"] == "align_failed"
    assert res.json()["error"]["hint"] == "Check the words."
    assert client.put(f"/api/sources/{rec['id']}/transcript", json={"script": ""}).status_code == 422
    res = client.put(f"/api/sources/{tts(client)['id']}/transcript", json=body)
    assert res.status_code == 400 and res.json()["error"]["code"] == "invalid_request"
    assert client.put("/api/sources/src_000000000000/transcript", json=body).status_code == 404


def test_v03_an_edited_transcript_wins_over_the_background_one(client, monkeypatch, tmp_path):
    import threading

    gate, calls = threading.Event(), []

    def transcribe(source):
        calls.append(source.info.id)
        gate.wait(10)
        return transcript_of(source, "WHISPER HEARD THIS", ["WHISPER", "HEARD", "THIS"])

    monkeypatch.setattr(voice_api, "transcribe", transcribe, raising=False)
    monkeypatch.setattr(voice_api, "realign", lambda source, script: transcript_of(source, script, script.split()),
                        raising=False)
    # Edited while transcribing: the edit waits for the model, then replaces what the transcriber heard.
    running = ok(upload(client, noisy(tmp_path, "a.wav")))
    deadline = time.time() + 10
    while ok(client.get(f"/api/sources/{running['id']}"))["transcript_state"] != "running":
        assert time.time() < deadline
        time.sleep(0.02)
    threading.Timer(0.3, gate.set).start()
    edit = client.put(f"/api/sources/{running['id']}/transcript", json={"script": "MY WORDS"})
    assert ok(edit)["script"] == "MY WORDS" and wait_transcribed(client, running["id"])["script"] == "MY WORDS"

    # Edited while still queued: the transcriber never runs for it.
    busy = threading.Event()
    client.app.state.service.jobs.submit("hold", lambda ctx: busy.wait(10), lane="transcribe", retain=False)
    queued = ok(upload(client, noisy(tmp_path, "b.wav", seconds=2.0)))
    assert queued["transcript_state"] == "queued"
    assert ok(client.put(f"/api/sources/{queued['id']}/transcript", json={"script": "MINE TOO"}))["script"] == \
        "MINE TOO"
    busy.set()
    time.sleep(0.2)
    assert wait_transcribed(client, queued["id"])["script"] == "MINE TOO" and calls == [running["id"]]


def test_v03_real_transcriber_and_aligner(client, real_transcriber, tmp_path):
    """The voice package's own transcriber and aligner on a spoken line, over HTTP."""
    speech = tts(client, script="WE ARE GUY FVWKS. EXPECT US.")
    audio, sr = sf.read(io.BytesIO(client.get(f"/api/audio/{speech['audio_id']}").content))
    wav = tmp_path / "line.wav"
    sf.write(wav, audio, sr, subtype="PCM_16")
    rec = ok(upload(client, wav))
    info = wait_transcribed(client, rec["id"], timeout=120)
    assert info["transcript_state"] == "done" and "expect" in (info["script"] or "").lower()
    assert sum(len(s["words"]) for s in info["segments"]) >= 4
    edited = ok(client.put(f"/api/sources/{rec['id']}/transcript", json={"script": "WE ARE GUY FAWKES | EXPECT *US*"}))
    assert [s["flags"]["throw"] for s in edited["segments"]] == [False, True]
    assert [w["throw"] for w in edited["segments"][1]["words"]] == [False, True]


def test_persona_candidates_arrive_one_by_one_and_a_cancel_stops_the_design(client, monkeypatch):
    import threading

    real_synth = voice_api.synthesize
    steps, closed = [threading.Event() for _ in range(3)], []

    def design(req):  # S1's generator: one candidate every few seconds
        try:
            voices = ("kokoro:am_fenrir", "kokoro:am_michael", "kokoro:bm_george")[: req.candidates]
            for i, voice_id in enumerate(voices):
                steps[i].wait(10)
                yield real_synth(voice_api.TTSRequest(script=req.sample_text, voice_id=voice_id), None)
        finally:
            closed.append(True)

    monkeypatch.setattr(voice_api, "design_persona", design, raising=False)

    def job_after(job_id, n):
        deadline = time.time() + 10
        while len((job := ok(client.get(f"/api/jobs/{job_id}")))["result_ids"]) < n and job["state"] == "running":
            assert time.time() < deadline
            time.sleep(0.02)
        return job

    job_id = ok(client.post("/api/personas/design", json={"description": "deep gravelly narrator"}))["id"]
    steps[0].set()
    first = job_after(job_id, 1)
    assert first["state"] == "running" and len(first["result_ids"]) == 1  # the first voice is playable already
    assert client.get(f"/api/personas/candidates/{first['result_ids'][0]}").status_code == 200
    steps[1].set()
    assert len(job_after(job_id, 2)["result_ids"]) == 2
    ok(client.post(f"/api/jobs/{job_id}/cancel"))
    steps[2].set()
    done = wait_job(client, job_id)
    assert done["state"] == "cancelled" and len(done["result_ids"]) == 2 and closed == [True]


def test_signal_with_auto_bars_stays_finite(client):
    """S1's "NaN in SIGNAL with AUTO bars" was display math in the app (fixed in S4's Phase 2.1). The engine side
    stays clean: SIGNAL at AUTO, with its stutters and tape stop squeezed into AUTO's shortest layouts at the tempo
    extremes, renders finite audio (the server refuses anything else) and finite numbers."""
    def numbers(obj):
        if isinstance(obj, float):
            yield obj
        elif isinstance(obj, dict):
            for v in obj.values():
                yield from numbers(v)
        elif isinstance(obj, list):
            for v in obj:
                yield from numbers(v)

    src = tts(client, script="US")
    for bpm, quality in ((60, "preview"), (200, "final"), (140, "preview")):
        r = ok(client.post("/api/render", json={"source_id": src["id"], "preset_id": "signal", "quality": quality,
                                                "auto_export": False, "arrange": {"bpm": bpm},
                                                "macros": {"depth": 1, "grit": 1, "machine": 1, "space": 1}}))
        assert r["bars"] in (1, 2, 4, 8, 16) and r["n_samples"] == round(r["bars"] * 240 / bpm * r["sample_rate"])
        assert all(math.isfinite(v) for v in numbers(r))


# ------------------------------------------------------------------------------------------ first-run models


class FakeRegistry:
    """A fresh Mac: the voice package's models, none downloaded. install() steps its progress on cue."""

    def __init__(self, fail=()):
        from fvwks_contracts.models import ModelInfo

        self.installed: dict[str, bool] = {"kokoro-82m": False, "deepfilternet3": False, "whisper-aligner": False,
                                           "qwen3-tts-voicedesign": False}
        self.sizes = {"kokoro-82m": 356_000_000, "deepfilternet3": 8_700_000, "whisper-aligner": 2_900_000_000,
                      "qwen3-tts-voicedesign": 9_000_000_000}
        self.required = {"kokoro-82m", "deepfilternet3"}
        self.fail, self.order, self.warmed = set(fail), [], []
        self.step = __import__("threading").Semaphore(0)
        self._info = ModelInfo

    def list_models(self):
        return [self._info(id=i, name=i.upper(), engine="x", size_bytes=self.sizes[i], installed=done,
                           required=i in self.required, license="MIT", description="") for i, done in
                self.installed.items()]

    def install_model(self, model_id, progress):
        self.order.append(model_id)
        for fraction in (0.25, 0.5):
            self.step.acquire(timeout=10)
            progress(fraction, f"Downloading {model_id.upper()}: {fraction:.0%}")
        if model_id in self.fail:
            raise type("VoiceError", (Exception,), {"code": "install_failed", "status": 502,
                                                    "message": f"Downloading {model_id} failed: offline",
                                                    "hint": "Check the network connection, then try again."})()
        self.installed[model_id] = True

    def warm_up(self):
        if not self.installed["kokoro-82m"]:
            raise RuntimeError("model_not_installed")
        self.warmed.append(True)


def install_registry(monkeypatch, registry):
    for name in ("list_models", "install_model", "warm_up"):
        monkeypatch.setattr(voice_api, name, getattr(registry, name), raising=False)


def health_while(client, registry, steps):
    """Health as each download step is released: [(state, progress, message)]."""
    seen = []
    for _ in range(steps):
        deadline = time.time() + 10
        while (h := ok(client.get("/api/health")))["state"] == "loading_model" and h["progress"] is None \
                and time.time() < deadline:
            time.sleep(0.01)
        seen.append((h["state"], h["progress"], h["message"]))
        registry.step.release()
        time.sleep(0.05)
    return seen


def wait_state(client, *states, timeout=20):
    deadline = time.time() + timeout
    while (h := ok(client.get("/api/health")))["state"] not in states:
        assert time.time() < deadline, h
        time.sleep(0.02)
    return h


def test_first_launch_installs_the_required_models_with_progress(client, monkeypatch):
    registry = FakeRegistry()
    install_registry(monkeypatch, registry)
    client.app.state.service.start()
    seen = health_while(client, registry, steps=4)
    assert all(state == "loading_model" for state, _, _ in seen)
    progress = [p for _, p, _ in seen]
    assert progress == sorted(progress) and 0 <= progress[0] < progress[-1] < 1  # one bar over both downloads
    assert "KOKORO-82M" in seen[0][2] and "DEEPFILTERNET3" in seen[-1][2]
    health = wait_state(client, "ready")
    assert health["message"] is None and registry.warmed == [True]
    assert registry.order == ["kokoro-82m", "deepfilternet3"]  # the opt-in models stay opt-in
    assert not registry.installed["whisper-aligner"] and not registry.installed["qwen3-tts-voicedesign"]


def test_first_launch_without_the_denoiser_still_works(client, monkeypatch):
    registry = FakeRegistry(fail={"deepfilternet3"})
    install_registry(monkeypatch, registry)
    client.app.state.service.start()
    for _ in range(4):  # two steps per download
        registry.step.release()
    health = wait_state(client, "ready", "error")
    assert health["state"] == "ready" and registry.warmed == [True]
    assert health["message"] == "Not installed: DEEPFILTERNET3 (VOICES → Models)."
    registry.fail.clear()  # back online: the retry from the models screen...
    ok(client.post("/api/models/deepfilternet3/install"))
    for _ in range(2):
        registry.step.release()
    deadline = time.time() + 10
    while ok(client.get("/api/health"))["message"] and time.time() < deadline:
        time.sleep(0.02)
    assert ok(client.get("/api/health"))["message"] is None  # ...clears the note


def test_first_launch_without_the_voice_model_says_why(client, monkeypatch):
    registry = FakeRegistry(fail={"kokoro-82m"})
    install_registry(monkeypatch, registry)
    client.app.state.service.start()
    for _ in range(4):
        registry.step.release()
    health = wait_state(client, "error", "ready")
    assert health["state"] == "error" and registry.warmed == []
    assert health["message"] == ("Couldn't install KOKORO-82M: Downloading kokoro-82m failed: offline. "
                                 "Check the network connection, then try again.")


def test_upload_without_the_denoiser_model_is_kept_as_recorded(client, monkeypatch, tmp_path):
    from fvwks_voice import denoise

    monkeypatch.setattr(denoise.Denoiser, "is_installed", lambda self: False)
    info = ok(upload(client, noisy(tmp_path), denoise="1"))
    assert info["denoise"] == 0.0 and any("denoiser isn't installed" in w for w in info["warnings"])


def test_v05_motion_passes_through_to_renders(client, monkeypatch):
    from fvwks_contracts.models import Motion, MotionEvent

    real = fx_api.render
    motion = Motion(fps=50, events=[MotionEvent(t=0.25, dur=0.1, kind="stutter")], returns="AAEC", f0="AAIE")
    monkeypatch.setattr(fx_api, "render", lambda main, stack, req: dataclasses.replace(real(main, stack, req),
                                                                                      motion=motion))
    r = render(client, tts(client)["id"])
    assert r["motion"] == motion.model_dump(mode="json")
    assert ok(client.get(f"/api/renders/{r['id']}"))["motion"] == r["motion"]  # stored with the render


# ------------------------------------------------------------------------------------------ v0.4/v0.5 installer fields


def one_model_registry(monkeypatch, *, installer, needs=None, size=2_900_000_000, required=False):
    """A voice package with one model (not installed) whose install() is `installer(progress)`."""
    from fvwks_contracts.models import ModelInfo

    state = {"installed": False}

    def list_models():
        return [ModelInfo(id="asr", name="Transcripts", engine="asr", size_bytes=size, installed=state["installed"],
                          required=required, license="MIT", description="", install_needs_bytes=needs)]

    def install_model(model_id, progress):
        installer(progress)
        state["installed"] = True

    monkeypatch.setattr(voice_api, "list_models", list_models, raising=False)
    monkeypatch.setattr(voice_api, "install_model", install_model, raising=False)
    return state


def test_v04_install_jobs_report_bytes_rate_and_time_left(client, monkeypatch):
    import threading

    gate = threading.Event()

    def installer(progress):  # today's installer: a fraction and a message, no bytes
        progress(0.25, "Downloading Transcripts: 0.7 of 2.9 GB")
        time.sleep(0.6)
        progress(0.5, "Downloading Transcripts: 1.5 of 2.9 GB")
        gate.wait(10)

    one_model_registry(monkeypatch, installer=installer)
    job = ok(client.post("/api/models/asr/install"))
    deadline = time.time() + 10
    while (job := ok(client.get(f"/api/jobs/{job['id']}")))["bytes_done"] != 1_450_000_000:
        assert time.time() < deadline, job
        time.sleep(0.02)
    assert job["bytes_total"] == 2_900_000_000 and job["current_item"] == "Transcripts"
    assert job["rate_bps"] > 0 and job["eta_s"] > 0  # "1.5 of 2.9 GB · 2.4 GB/s · 0:01 left"
    model = ok(client.get("/api/models"))[0]
    assert model["install_job_id"] == job["id"] and model["install_needs_bytes"] == 2_900_000_000 + 5_000_000_000
    gate.set()
    done = wait_job(client, job["id"])
    assert done["state"] == "done" and done["bytes_done"] == done["bytes_total"] and done["eta_s"] == 0
    model = ok(client.get("/api/models"))[0]
    assert model["installed"] and model["install_job_id"] is None and model["install_needs_bytes"] is None


def test_v04_install_jobs_take_the_installers_own_bytes(client, monkeypatch):
    def installer(progress):
        progress(0.1, "Downloading", bytes_done=12_345, bytes_total=99_999, current_item="kokoro-v1_0.safetensors")

    one_model_registry(monkeypatch, installer=installer, size=100_000)
    seen = []
    real_transfer = __import__("fvwks_server.jobs", fromlist=["JobRunner"]).JobRunner._transfer

    def spy(self, job, done, total, item):
        seen.append((done, total, item))
        return real_transfer(self, job, done, total, item)

    monkeypatch.setattr("fvwks_server.jobs.JobRunner._transfer", spy)
    wait_job(client, ok(client.post("/api/models/asr/install"))["id"])
    assert (12_345, 99_999, "kokoro-v1_0.safetensors") in seen


def test_v05_install_needs_bytes_drives_the_disk_guard(client, monkeypatch):
    import collections

    import fvwks_server.service as service_module

    one_model_registry(monkeypatch, installer=lambda progress: None, size=9_000_000_000,
                       needs=6_000_000_000)  # a resumed download: 1 GB to go plus the 5 GB reserve
    usage = collections.namedtuple("usage", "total used free")
    monkeypatch.setattr(service_module.shutil, "disk_usage", lambda path: usage(0, 0, 7_000_000_000))
    assert ok(client.get("/api/models"))[0]["install_needs_bytes"] == 6_000_000_000
    assert wait_job(client, ok(client.post("/api/models/asr/install"))["id"])["state"] == "done"


def test_v04_health_lists_required_models_that_are_missing(client, monkeypatch):
    one_model_registry(monkeypatch, installer=lambda progress: None, required=True)
    monkeypatch.delattr(voice_api, "install_model")  # nothing can fetch it: health still says it's missing
    client.app.state.service._models_seen = None
    assert ok(client.get("/api/health"))["required_missing"] == ["asr"]


def test_the_model_cache_the_app_points_at_is_created(tmp_path, monkeypatch):
    """The bundled app sets HF_HOME=<data dir>/models, which doesn't exist on a fresh Mac; the installer measures
    free space on it before the first download (found by the packaged-layout smoke test)."""
    monkeypatch.setenv("HF_HOME", str(tmp_path / "fresh" / "models"))
    make_client(tmp_path)
    assert (tmp_path / "fresh" / "models").is_dir()


def test_v06_model_not_installed_names_the_model(client, monkeypatch):
    """P7: the app's "Install" link deep-links to the model card named in the error."""
    class VoiceError(Exception):
        code, status, message, hint, model_id = ("model_not_installed", 503, "Kokoro 82M isn't installed.",
                                                 "Install it from VOICES → Models.", "kokoro-82m")

    def missing(req, lexicon=None):
        raise VoiceError()

    monkeypatch.setattr(voice_api, "synthesize", missing)
    res = client.post("/api/sources/tts", json={"script": "WE ARE"})
    assert res.status_code == 503 and res.json()["error"] == {
        "code": "model_not_installed", "message": "Kokoro 82M isn't installed.",
        "hint": "Install it from VOICES → Models.", "retryable": False, "model_id": "kokoro-82m"}
