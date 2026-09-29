"""1.6 REMIX in one call for the server's jobs: run(remix, sources, stage=) does BUILD, PREPARE and MIXDOWN up to
`stage`; the server only stores what comes back.

  build    arrange.build (a flip first reads the source's drum hits, cached per song). Runs when stage is "build"
           (the explicit rebuild) or the remix has no sections yet, so a later stage never undoes the user's edits.
           A mashup plays remix.mash (LINE IT UP's pick); without one, the best-scoring match between A and B (B's
           drop after A's build, or B's parts over A's drop), which the returned remix.mash records.
  prepare  prepare_clip for every clip that has no audio_id and isn't in `audio`, progressively: first the clips
           under the playhead's next 16 bars (from `play_from_bar`), then the first drop, then the rest in time order,
           on a few threads. `on_clip(clip_id, audio, PrepareProgress)` hands over each clip as it's ready (the
           server stores it and sets clip.audio_id; `progress.playable` turns true once the first 16 bars are all
           there, so playback can start while the rest streams in). clip_key is a content hash to cache clips by.
  mixdown  every clip's audio (`audio` from the server's store, plus what was just prepared) → the finished track.
`progress(fraction, message)` is called as it goes.
"""

from __future__ import annotations

import hashlib
import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Callable, Literal

import numpy as np

from fvwks_contracts.models import Master, Remix, RemixClip, Song
from fvwks_contracts.seam import MashFeatures

from ..master import LoudnessReport
from .arrange import build
from .flip import Hit, drum_hits
from .mash import features as mash_features, scan
from .mixdown import mixdown
from .prepare import ENGINE_PATCHES, SourceAudio, prepare_clip
from .styles import Choose

Stage = Literal["build", "prepare", "mixdown"]


@dataclass
class SongInput:
    song: Song  # with its analysis and structure
    stems: dict[str, np.ndarray]  # drums / bass / vocals / other, (channels, n) float32 at sr
    sr: int
    feats: dict[str, np.ndarray] | None = None  # the song's cached mash features (mash.features), for a mashup's pick


@dataclass
class RunResult:
    remix: Remix
    audio: dict[str, np.ndarray] = field(default_factory=dict)  # clip id → (2, n) float32, the clips prepared now
    mix: np.ndarray | None = None  # mixdown: (channels, n) at master.sample_rate
    report: LoudnessReport | None = None


@dataclass
class PrepareProgress:
    done: int  # clips ready so far (of this run's)
    total: int
    playable: bool  # every clip under the playhead's first 16 bars is ready
    drop_ready: bool  # every clip of the first drop is ready (true when there's none)


WINDOW_BEATS = 64  # 16 bars from the playhead
WORKERS = max(1, min(4, (os.cpu_count() or 2) - 1))


# ponytail: in-process, per song id + drum stem length (a re-split changes it); the server's own cache if it grows
_HITS: dict[tuple[str, int], list[Hit]] = {}


def song_drum_hits(src: SongInput) -> list[Hit]:
    """flip.drum_hits of the song's drum stem, read once per song."""
    key = (src.song.id, src.stems["drums"].shape[-1])
    if key not in _HITS:
        a = src.song.analysis
        grid = a.model_copy(update={"bpm": src.song.bpm_override or a.bpm,
                                    "downbeat_s": src.song.downbeat_override_s or a.downbeat_s})
        _HITS[key] = drum_hits(src.stems["drums"], src.sr, grid)
    return _HITS[key]


def _audio_source(src: SongInput) -> SourceAudio:
    a = src.song.analysis
    return SourceAudio(bpm=float(src.song.bpm_override or a.bpm), downbeat_s=float(src.song.downbeat_override_s or a.downbeat_s),
                       stems=src.stems, sr=src.sr)


def _pick_mash(sources: dict[str, SongInput]):
    """The best-scoring MashMatch between A and B, either way round: B's drop after A's build, or B's parts over A's
    drop."""
    def mf(s: SongInput) -> MashFeatures:
        a = s.song.analysis.model_copy(update={"bpm": s.song.bpm_override or s.song.analysis.bpm,
                                               "downbeat_s": s.song.downbeat_override_s or s.song.analysis.downbeat_s})
        feats = s.feats
        if feats is None:
            mix = sum(v for k, v in s.stems.items() if k in ("drums", "bass", "vocals", "other"))
            feats = mash_features(mix, s.sr, a, s.song.structure, vocals=s.stems.get("vocals"))
        return MashFeatures(s.song.id, a, s.song.structure, feats)

    a, b = mf(sources["A"]), mf(sources["B"])
    best = sorted(scan(a, "build", [b], top=1) + scan(a, "drop", [b], top=1), key=lambda m: -m.score)
    if not best:
        raise ValueError("A and B have no parts that mash (their tempos may be too far apart)")
    return best[0]


def clip_key(clip: RemixClip, remix: Remix, sources: dict[str, SongInput]) -> str:
    """A content hash of what a clip sounds like: its source, shift, length, fades and gain, the remix tempo, and the
    source songs' grids (not its place in the remix or its audio_id). A seeded clip (an engine bass patch, a kit) adds
    the remix's seed, its id (its variation is drawn from them, prepare._rng) and the take's choices (the cadence, the
    voices' axes), so a new take is a new sound."""
    songs = {slot: [s.song.id, s.song.bpm_override or s.song.analysis.bpm, s.song.downbeat_override_s or s.song.analysis.downbeat_s,
                    s.stems[next(iter(s.stems))].shape[-1]] for slot, s in sources.items()}
    body = clip.model_dump(mode="json", exclude={"id", "at_beat", "audio_id"})
    seeded = clip.src.kind == "kit" or (clip.src.kind == "groove" and clip.src.patch_id.startswith(ENGINE_PATCHES))
    take = next(([c.model_dump() for c in t.choices] for t in remix.takes if t.seed == remix.seed), [])
    blob = json.dumps([body, remix.bpm, songs] + ([remix.seed, clip.id, take] if seeded else []), sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()[:32]


def run(remix: Remix, sources: dict[str, SongInput], *, stage: Stage = "mixdown", audio: dict[str, np.ndarray] | None = None,
        match=None, vip_drop: bool = False, master: Master | None = None, sr: int = 48000,
        progress: Callable[[float, str], None] | None = None,
        on_clip: Callable[[str, np.ndarray, PrepareProgress], None] | None = None, play_from_bar: int = 1,
        buses: dict[str, np.ndarray] | None = None, choose: Choose | None = None) -> RunResult:
    """See the module doc. `match` is a mashup's MashMatch; `sources` maps slot → SongInput; `buses` (a dict) gets
    the mixdown's pre-master sub / mid / drums / top buses; `choose(axis, {option: weight}) -> option` is the server's
    pick on each variation axis BUILD resolves (styles.resolve; None: a kept take replays, a new seed draws)."""
    say = progress or (lambda f, m: None)
    have = dict(audio or {})
    if stage == "build" or not remix.sections:
        say(0.0, "Building the arrangement")
        if remix.recipe == "mashup" and remix.mash is None and match is None:
            match = _pick_mash(sources)
            remix = remix.model_copy(update={"mash": match})
        hits = song_drum_hits(sources["A"]) if remix.recipe == "flip" else None
        remix = build(remix, {slot: s.song for slot, s in sources.items()}, match=match, vip_drop=vip_drop, drum_hits=hits,
                      choose=choose)
        remix = remix.model_copy(update={"build_state": "done"})
        if stage == "build":
            return RunResult(remix)
    todo = [c for lane in remix.lanes for c in lane.clips if c.audio_id is None and c.id not in have]
    srcs = {slot: _audio_source(s) for slot, s in sources.items()}
    made: dict[str, np.ndarray] = {}
    # what to play first: the playhead's next 16 bars, then the first drop
    w0 = (play_from_bar - 1) * 4.0
    drop = next((s for s in remix.sections if s.kind == "drop"), None)
    d0, d1 = ((drop.start_bar - 1) * 4.0, (drop.start_bar - 1 + drop.bars) * 4.0) if drop else (0.0, 0.0)
    over = lambda c, a, b: c.at_beat < b and c.at_beat + c.beats > a
    first = {c.id for lane in remix.lanes for c in lane.clips if over(c, w0, w0 + WINDOW_BEATS)}
    drops = {c.id for lane in remix.lanes for c in lane.clips if drop and over(c, d0, d1)}
    todo.sort(key=lambda c: (c.id not in first, c.id not in drops, c.at_beat))
    ready = set(have) | {c.id for lane in remix.lanes for c in lane.clips if c.audio_id is not None}
    with ThreadPoolExecutor(WORKERS) as pool:
        futures = {pool.submit(prepare_clip, c, remix, srcs, sr): c for c in todo}
        for fut in as_completed(futures):
            c = futures[fut]
            made[c.id] = fut.result()
            ready.add(c.id)
            info = PrepareProgress(len(made), len(todo), first <= ready, drops <= ready)
            say(0.1 + 0.8 * len(made) / max(1, len(todo)), f"Preparing clip {len(made)} of {len(todo)}")
            if on_clip:
                on_clip(c.id, made[c.id], info)
    if stage == "prepare":
        say(1.0, "Clips ready")
        return RunResult(remix, made)
    say(0.9, "Mixing down")
    mix, report = mixdown(remix, {**have, **made}, sr, master, buses)
    say(1.0, "Done")
    return RunResult(remix, made, mix, report)
