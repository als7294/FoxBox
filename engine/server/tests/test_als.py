from __future__ import annotations

import gzip
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import soundfile as sf

from fvwks_contracts.models import Remix, RemixClip, RemixLane, RemixSection, RemixSource, StemClipSrc
from fvwks_server.als import write_als

BPM = 140.0


def wav(path: Path, beats: float, level: float) -> Path:
    n = int(beats * 60 / BPM * 48_000)
    sf.write(path, np.zeros((n, 2), np.float32) + level, 48_000, subtype="PCM_24")
    return path


def clip(cid: str, at: float, beats: float, **kw) -> RemixClip:
    return RemixClip(id=cid, at_beat=at, beats=beats, src=StemClipSrc(slot="A", stem="drums", start_beat=0), **kw)


def remix() -> Remix:
    return Remix(
        id="r1", name="My Track VIP", recipe="vip", sources=[RemixSource(slot="A", song_id="s1"), RemixSource(slot="B", song_id="s2")],
        bpm=BPM, sections=[RemixSection(kind="intro", start_bar=1, bars=8), RemixSection(kind="drop", start_bar=9, bars=8),
                           RemixSection(kind="breakdown", start_bar=17, bars=8), RemixSection(kind="drop", start_bar=25, bars=8)],
        lanes=[
            RemixLane(id="l1", role="drums", slot="A", clips=[clip("d1", 0, 32), clip("d2", 32, 32, fade_out_beats=2)]),
            RemixLane(id="l2", role="drums", slot="B", gain_db=-3, clips=[clip("d3", 64, 32)]),
            RemixLane(id="l3", role="synth_bass", mute=True, clips=[clip("b1", 32, 32, gain_db=-6), clip("b2", 96, 32)]),
        ],
        created_at="2026-09-29T00:00:00Z", updated_at="2026-09-29T00:00:00Z",
    )


def test_live_set_has_the_remix(tmp_path):
    audio = {c: wav(tmp_path / f"{c}.wav", 32, 0.01 * (i + 1)) for i, c in enumerate(("d1", "d2", "d3", "b1"))}  # b2: not prepared
    audio["d1-again"] = audio["d1"]
    out = write_als(remix(), audio, tmp_path / "export", use_installed=False)
    assert out == tmp_path / "export" / "My Track VIP Project" / "My Track VIP.als"
    root = ET.fromstring(gzip.open(out).read())
    assert root.tag == "Ableton" and root.get("MinorVersion", "").startswith("11.0")
    ls = root.find("LiveSet")

    # Tempo: the knob and the envelope Live actually plays.
    mixer = ls.find("MasterTrack/DeviceChain/Mixer")
    assert mixer.find("Tempo/Manual").get("Value") == "140"
    tempo_id = mixer.find("Tempo/AutomationTarget").get("Id")
    env = [e for e in ls.findall("MasterTrack/AutomationEnvelopes/Envelopes/AutomationEnvelope") if e.find("EnvelopeTarget/PointeeId").get("Value") == tempo_id]
    assert env and {ev.get("Value") for ev in env[0].iter("FloatEvent")} == {"140"}
    assert mixer.find("TimeSignature/Manual").get("Value") == "201"

    tracks = ls.findall("Tracks/AudioTrack")
    assert [t.find("Name/EffectiveName").get("Value") for t in tracks] == ["DRUMS A", "DRUMS B", "SYNTH BASS"]
    assert abs(float(tracks[1].find("DeviceChain/Mixer/Volume/Manual").get("Value")) - 10 ** (-3 / 20)) < 1e-4
    assert tracks[2].find("DeviceChain/Mixer/Speaker/Manual").get("Value") == "false"  # muted

    clips = tracks[0].findall("DeviceChain/MainSequencer/Sample/ArrangerAutomation/Events/AudioClip")
    assert [(c.get("Time"), c.find("CurrentEnd").get("Value")) for c in clips] == [("0", "32"), ("32", "64")]
    assert clips[1].find("Fades/FadeOutLength").get("Value") == "2"
    marks = [(float(m.get("SecTime")), float(m.get("BeatTime"))) for m in clips[0].iter("WarpMarker")]
    assert marks[0] == (0, 0) and abs(marks[1][1] - 32) < 1e-3 and abs(marks[1][0] - 32 * 60 / BPM) < 1e-3
    bass = tracks[2].findall(".//ArrangerAutomation/Events/AudioClip")
    assert len(bass) == 1 and abs(float(bass[0].find("SampleVolume").get("Value")) - 0.5012) < 1e-3

    # The audio lives in the project, referenced relative to it.
    fr = clips[0].find("SampleRef/FileRef")
    rel = fr.find("RelativePath").get("Value")
    assert rel.startswith("Samples/Imported/") and (out.parent / rel).is_file()
    assert len(list((out.parent / "Samples" / "Imported").iterdir())) == 4  # one file per distinct audio

    # Locators at the sections: numbered where a kind repeats.
    locs = [(l.find("Time").get("Value"), l.find("Name").get("Value")) for l in ls.findall("Locators/Locators/Locator")]
    assert locs == [("0", "INTRO"), ("32", "DROP 1"), ("64", "BREAKDOWN"), ("96", "DROP 2")]

    # What Live checks on open: unique automation ids, NextPointeeId above every id, a clip slot per scene.
    targets = [e.get("Id") for e in root.iter() if e.tag in ("AutomationTarget", "ModulationTarget", "Pointee")]
    assert len(targets) == len(set(targets))
    ids = [int(v) for e in root.iter() if (v := e.get("Id")) is not None and v.lstrip("-").isdigit()]
    assert int(ls.find("NextPointeeId").get("Value")) > max(ids)
    scenes = len(ls.findall("Scenes/Scene"))
    assert all(len(t.findall("DeviceChain/MainSequencer/ClipSlotList/ClipSlot")) == scenes for t in tracks)
