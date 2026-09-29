"""The REMIX export as an Ableton Live set (BETA until someone opens one in Live): write_als().

A Live set is gzipped XML. We start from the Live that's installed on this Mac when there is one (its own
DefaultLiveSet.als: a set Live itself wrote, so it opens in that Live), else from als_live11.xml: Live 11's default
document structure (element names and default values, as a Live 11.3 set has them) with everything set-specific
removed, which Live 11 and 12 open. Into it go:

- the tempo (the master's Tempo, and its tempo envelope's first value, which Live reads over the knob), 4/4 or the
  remix's meter;
- one audio track per lane (named by role and slot, coloured, its gain and mute), cloned from the template track;
- one arrangement audio clip per prepared clip, at its beat, warped at the set tempo (two warp markers: the file is
  already at the remix tempo), with its gain and fades;
- locators at the sections (INTRO, BUILD 1, DROP 1, …);
- the audio copied into the Live project folder (<name> Project/Samples/Imported), referenced relative to it.

Every Id is unique (the template's, then ours from above them), NextPointeeId sits above them all, locators count from
0 in their own space, and every track has one clip slot per scene: what Live checks when it opens a set.
"""

from __future__ import annotations

import copy
import gzip
import hashlib
import math
import re
import shutil
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path

import soundfile as sf

from fvwks_contracts.models import Remix

SKELETON = Path(__file__).with_name("als_live11.xml")
LIVE_APPS = Path("/Applications")
MAX_VOLUME = 1.99526  # +6 dB, Live's fader top

ROLE_NAMES = {"drums": "DRUMS", "bass": "BASS", "vocals": "VOCALS", "other": "OTHER", "synth_bass": "SYNTH BASS", "kit": "KIT"}
# Live's clip/track colour indices, one per role.
ROLE_COLORS = {"drums": 3, "bass": 13, "vocals": 21, "other": 16, "synth_bass": 1, "kit": 24}
# Warp modes: 0 Beats (drums keep their transients), 4 Complex (everything else).
BEATS, COMPLEX = 0, 4


def installed_template() -> Path | None:
    """The newest installed Live's own DefaultLiveSet.als, or None."""
    found = []
    for app in LIVE_APPS.glob("Ableton Live 1[1-9]*.app"):
        t = app / "Contents/App-Resources/Builtin/Templates/DefaultLiveSet.als"
        if t.is_file() and (m := re.search(r"Live (\d+)", app.name)):
            found.append((int(m.group(1)), t))
    return max(found)[1] if found else None


def _load(template: Path | None) -> ET.Element:
    if template is not None:
        return ET.fromstring(gzip.open(template).read())
    return ET.parse(SKELETON).getroot()


def _num(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else f"{v:.6f}".rstrip("0").rstrip(".")


def _set(e: ET.Element, path: str, value) -> None:
    node = e.find(path)
    if node is not None:
        node.set("Value", value if isinstance(value, str) else _num(value) if not isinstance(value, bool) else str(value).lower())


class _Ids:
    """Hands out Ids above every Id already in the document."""

    def __init__(self, root: ET.Element) -> None:
        ids = [int(v) for e in root.iter() if (v := e.get("Id")) is not None and v.lstrip("-").isdigit()]
        npi = root.find("LiveSet/NextPointeeId")
        self.next = max([*ids, int(npi.get("Value")) if npi is not None else 0]) + 1

    def take(self) -> str:
        self.next += 1
        return str(self.next - 1)

    def renumber(self, e: ET.Element) -> None:
        for node in e.iter():
            if "Id" in node.attrib:
                node.set("Id", self.take())


def _safe(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", name).strip() or "FoxBox remix"


def _timesig(beats_per_bar: int) -> int:
    """Live's encoding of a meter over quarter notes: 99 × log2(denominator) + numerator − 1 (4/4 = 201)."""
    return 99 * 2 + beats_per_bar - 1


def _master(ls: ET.Element) -> ET.Element:
    """The master track: MasterTrack in Live 11, MainTrack in Live 12 (an installed Live 12's template)."""
    m = ls.find("MasterTrack")
    return m if m is not None else ls.find("MainTrack")


def _set_tempo(ls: ET.Element, bpm: float, beats_per_bar: int) -> None:
    master = _master(ls)
    mixer = master.find("DeviceChain/Mixer")
    _set(mixer, "Tempo/Manual", bpm)
    _set(mixer, "TimeSignature/Manual", _timesig(beats_per_bar))
    tempo_id = mixer.find("Tempo/AutomationTarget").get("Id")
    sig_id = mixer.find("TimeSignature/AutomationTarget").get("Id")
    # Live plays the master's envelopes over the knobs: their first (and only) events carry the values too.
    for env in master.findall("AutomationEnvelopes/Envelopes/AutomationEnvelope"):
        target = env.find("EnvelopeTarget/PointeeId").get("Value")
        for ev in env.iter():
            if ev.tag in ("FloatEvent", "EnumEvent") and "Value" in ev.attrib:
                if target == tempo_id:
                    ev.set("Value", _num(bpm))
                elif target == sig_id:
                    ev.set("Value", str(_timesig(beats_per_bar)))


def _locators(ls: ET.Element, remix: Remix) -> None:
    outer = ls.find("Locators/Locators")
    for old in list(outer):
        outer.remove(old)
    count: Counter[str] = Counter(s.kind for s in remix.sections)
    seen: Counter[str] = Counter()
    for i, sec in enumerate(sorted(remix.sections, key=lambda s: s.start_bar)):
        seen[sec.kind] += 1
        name = sec.kind.upper() + (f" {seen[sec.kind]}" if count[sec.kind] > 1 else "")
        loc = ET.SubElement(outer, "Locator", Id=str(i))  # locators count from 0 in their own space
        for tag, value in (("LomId", "0"), ("Time", _num((sec.start_bar - 1) * remix.beats_per_bar)), ("Name", name),
                           ("Annotation", ""), ("IsSongStart", "false")):
            ET.SubElement(loc, tag, Value=value)


def _copy_audio(src: Path, samples: Path, copied: dict[str, Path]) -> Path:
    """Into the project's Samples/Imported, once per distinct file (the same audio on two clips is one file)."""
    digest = hashlib.sha1(src.read_bytes()).hexdigest()
    if digest not in copied:
        samples.mkdir(parents=True, exist_ok=True)
        dst = samples / f"{src.stem}-{digest[:8]}{src.suffix}"
        shutil.copyfile(src, dst)
        copied[digest] = dst
    return copied[digest]


def _clip(tpl: ET.Element, ids: _Ids, *, clip, audio: Path, project: Path, bpm: float, color: int, warp: int) -> ET.Element:
    info = sf.info(str(audio))
    seconds = info.frames / info.samplerate
    beats = clip.beats
    c = copy.deepcopy(tpl)
    ids.renumber(c)
    c.set("Time", _num(clip.at_beat))
    _set(c, "CurrentStart", clip.at_beat)
    _set(c, "CurrentEnd", clip.at_beat + beats)
    for tag, v in (("LoopStart", 0), ("LoopEnd", beats), ("StartRelative", 0), ("OutMarker", beats),
                   ("HiddenLoopStart", 0), ("HiddenLoopEnd", beats)):
        _set(c, f"Loop/{tag}", v)
    _set(c, "Loop/LoopOn", False)
    _set(c, "Name", clip.id)
    _set(c, "Color", str(color))
    _set(c, "IsWarped", True)
    _set(c, "WarpMode", str(warp))
    _set(c, "SampleVolume", 10 ** (clip.gain_db / 20))
    # The prepared audio is already at the remix tempo: one warp marker at the start, one at the end.
    markers = c.find("WarpMarkers")
    for sec, beat in ((0.0, 0.0), (seconds, seconds * bpm / 60.0)):
        ET.SubElement(markers, "WarpMarker", Id=ids.take(), SecTime=_num(sec), BeatTime=_num(beat))
    # ponytail: arrangement fade lengths are written in beats; unconfirmed against Live until someone opens a set (BETA).
    _set(c, "Fades/FadeInLength", clip.fade_in_beats)
    _set(c, "Fades/FadeOutLength", clip.fade_out_beats)
    _set(c, "Fades/IsDefaultFadeIn", clip.fade_in_beats == 0)
    _set(c, "Fades/IsDefaultFadeOut", clip.fade_out_beats == 0)
    fr = c.find("SampleRef/FileRef")
    _set(fr, "RelativePathType", "1")  # relative to the project folder
    _set(fr, "RelativePath", audio.relative_to(project).as_posix())
    _set(fr, "Path", str(audio.resolve()))
    _set(fr, "Type", "1")
    _set(fr, "OriginalFileSize", str(audio.stat().st_size))
    _set(fr, "OriginalCrc", "0")
    _set(c, "SampleRef/LastModDate", str(int(audio.stat().st_mtime)))
    _set(c, "SampleRef/DefaultDuration", str(info.frames))
    _set(c, "SampleRef/DefaultSampleRate", str(info.samplerate))
    return c


def _clip_template(root: ET.Element) -> ET.Element:
    """Our skeleton's clip (a Live 11 arrangement AudioClip, emptied); an installed Live's template has none. In a
    Live 12 document its one renamed element follows Live 12 (the rest Live 12 reads as is)."""
    clip = next(ET.parse(SKELETON).getroot().iter("AudioClip"))
    if root.get("MinorVersion", "").startswith("12."):
        for e in clip.iter("IsSongTempoMaster"):
            e.tag = "IsSongTempoLeader"
    return clip


def write_als(remix: Remix, clip_audio: dict[str, Path], out_dir: Path, *, name: str | None = None,
              template: Path | None = None, use_installed: bool = True) -> Path:
    """Write `remix` as a Live set: <out_dir>/<name> Project/<name>.als, with every clip's audio (`clip_audio`:
    clip id → the prepared file, already at the remix tempo) copied into the project. Clips without audio are
    left out. Returns the .als path."""
    title = _safe(name or remix.name)
    project = Path(out_dir) / f"{title} Project"
    samples = project / "Samples" / "Imported"
    project.mkdir(parents=True, exist_ok=True)
    root = _load(template if template is not None else installed_template() if use_installed else None)
    clip_tpl = _clip_template(root)
    ls = root.find("LiveSet")
    ids = _Ids(root)

    tracks = ls.find("Tracks")
    track_tpl = copy.deepcopy(next(t for t in tracks if t.tag == "AudioTrack"))
    for ev in track_tpl.findall(".//ArrangerAutomation/Events"):
        for old in list(ev):
            ev.remove(old)
    returns = [t for t in tracks if t.tag == "ReturnTrack"]
    for t in list(tracks):
        tracks.remove(t)

    _set_tempo(ls, remix.bpm, remix.beats_per_bar)
    copied: dict[str, Path] = {}
    slots: Counter[str] = Counter(lane.role for lane in remix.lanes)
    for lane in remix.lanes:
        t = copy.deepcopy(track_tpl)
        ids.renumber(t)
        label = ROLE_NAMES[lane.role] + (f" {lane.slot}" if lane.slot and slots[lane.role] > 1 else "")
        _set(t, "Name/EffectiveName", label)
        _set(t, "Name/UserName", label)
        _set(t, "Color", str(ROLE_COLORS[lane.role]))
        mixer = t.find("DeviceChain/Mixer")
        _set(mixer, "Volume/Manual", min(MAX_VOLUME, 10 ** (lane.gain_db / 20)))
        _set(mixer, "Speaker/Manual", not lane.mute)
        events = t.find("DeviceChain/MainSequencer/Sample/ArrangerAutomation/Events")
        warp = BEATS if lane.role in ("drums", "kit") else COMPLEX
        for clip in sorted(lane.clips, key=lambda c: c.at_beat):
            src = clip_audio.get(clip.id)
            if src is None:
                continue
            audio = _copy_audio(Path(src), samples, copied)
            events.append(_clip(clip_tpl, ids, clip=clip, audio=audio, project=project, bpm=remix.bpm,
                                color=ROLE_COLORS[lane.role], warp=warp))
        tracks.append(t)
    for r in returns:  # an installed template's return tracks stay (the cloned tracks already send to them)
        tracks.append(r)

    _locators(ls, remix)
    last_beat = max((c.at_beat + c.beats for lane in remix.lanes for c in lane.clips), default=16.0)
    _set(ls, "Transport/LoopLength", max(4.0, math.ceil(last_beat / 4) * 4))
    ls.find("NextPointeeId").set("Value", ids.take())

    out = project / f"{title}.als"
    data = b'<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="utf-8")
    with gzip.open(out, "wb") as f:
        f.write(data)
    return out
