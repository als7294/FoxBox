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
from .dropfx import carries_first
from .prepare import ENGINE_PATCHES, SourceAudio, prepare_clip
from .styles import Choose

Stage = Literal["build", "prepare", "mixdown"]


@dataclass
class SongInput:
    song: Song  # with its analysis and structure
    stems: dict[str, np.ndarray]  # drums / bass / vocals / other, (channels, n) float32 at sr
    sr: int
    feats: dict[str, np.ndarray] | None = None  # the song's cached mash features (mash.features), for a mashup's pick
    words: list | None = None  # its lyrics' SongWords (v0.10, transcribed at import) when it has them: the vocal phrases


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


_PHRASES: dict[tuple[str, int, int], list] = {}


def vocal_phrases(src: SongInput) -> list:
    """vocals.phrases of the song's vocals stem (its words when it has them), read once per song."""
    if "vocals" not in src.stems:
        return []
    key = (src.song.id, src.stems["vocals"].shape[-1], len(src.words or []))
    if key not in _PHRASES:
        from .vocals import phrases

        a = src.song.analysis
        _PHRASES[key] = phrases(src.stems["vocals"], src.sr, float(src.song.bpm_override or a.bpm),
                                float(src.song.downbeat_override_s or a.downbeat_s), src.words,
                                float(getattr(a, "tuning_cents", None) or 0.0))
    return _PHRASES[key]


def own_gaps(src: SongInput, gap_beats: float = 1.0) -> set[int]:
    """The song's drop bars whose pre-drop is already quiet: its non-vocal stems (drums + bass + other) stay under
    -40 dBFS (50 ms RMS) over the half-beat before the last `gap_beats`. BUILD leaves their gap out: cut on top of the
    source's own, the silence would stack past the user's 1 beat (and lose the source's pickup into the drop)."""
    a = src.song.analysis
    beat = 60.0 / float(src.song.bpm_override or a.bpm)
    down = float(src.song.downbeat_override_s or a.downbeat_s)
    x = sum(np.asarray(src.stems[k], np.float64).mean(axis=0) for k in ("drums", "bass", "other") if k in src.stems)
    if np.ndim(x) == 0 or src.song.structure is None:
        return set()
    win = max(1, int(0.05 * src.sr))
    out = set()
    for sec in src.song.structure.sections:
        d = down + (sec.start_bar - 1) * 4 * beat
        seg = x[max(0, int((d - (gap_beats + 0.5) * beat) * src.sr)):max(0, int((d - gap_beats * beat) * src.sr))]
        if sec.kind == "drop" and len(seg) > win:
            env = np.convolve(seg ** 2, np.ones(win) / win, "valid")
            if 10 * np.log10(env.max() + 1e-12) < -40.0:
                out.add(sec.start_bar)
    return out


def _audio_source(src: SongInput) -> SourceAudio:
    a = src.song.analysis
    return SourceAudio(bpm=float(src.song.bpm_override or a.bpm), downbeat_s=float(src.song.downbeat_override_s or a.downbeat_s),
                       stems=src.stems, sr=src.sr, tuning_cents=float(getattr(a, "tuning_cents", None) or 0.0))


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


def _bass_sum(remix: Remix, audio: dict[str, np.ndarray], carrier: RemixClip, sr: int) -> np.ndarray:
    """The other bass lanes' prepared audio (lane gain, no mutes) summed over the carrier's drop, from its downbeat."""
    sec = next(s for s in remix.sections if s.kind == "drop" and abs((s.start_bar - 1) * 4.0 - carrier.at_beat) < 1e-6)
    per = 60.0 / remix.bpm * sr
    out = np.zeros((2, int(round(sec.bars * 4 * per))), np.float32)
    for lane in remix.lanes:
        if lane.role not in ("bass", "synth_bass") or lane.mute:
            continue
        g = np.float32(10 ** (lane.gain_db / 20))
        for c in lane.clips:
            x = audio.get(c.id)
            if c.id == carrier.id or x is None:
                continue
            o = int(round((c.at_beat - carrier.at_beat) * per))
            lo, hi = max(0, o), min(out.shape[1], o + x.shape[1])
            if hi > lo:
                out[:, lo:hi] += g * x[:, lo - o : hi - o]
    return out


def clip_key(clip: RemixClip, remix: Remix, sources: dict[str, SongInput]) -> str:
    """A content hash of what a clip sounds like: its source, shift, length, fades and gain, the remix tempo, and the
    source songs' grids (not its place in the remix or its audio_id). A seeded clip (an engine bass patch, a kit) adds
    the remix's seed, its id (its variation is drawn from them, prepare._rng) and the take's choices (the cadence, the
    voices' axes), so a new take is a new sound. A bass-lane clip adds the context its drop rules read (its place, the
    drum and bass lanes, the sections: C14), so editing the drums re-prepares it."""
    songs = {slot: [s.song.id, s.song.bpm_override or s.song.analysis.bpm, s.song.downbeat_override_s or s.song.analysis.downbeat_s,
                    s.stems[next(iter(s.stems))].shape[-1]] for slot, s in sources.items()}
    body = clip.model_dump(mode="json", exclude={"id", "at_beat", "audio_id"})
    seeded = clip.src.kind == "kit" or (clip.src.kind == "groove" and clip.src.patch_id.startswith(ENGINE_PATCHES))
    take = next(([c.model_dump() for c in t.choices] for t in remix.takes if t.seed == remix.seed), [])
    role = next((lane.role for lane in remix.lanes if any(c.id == clip.id for c in lane.clips)), None)
    ctx = []
    if role in ("bass", "synth_bass"):  # its drop rules (dropfx) read its place, the drums, the sections, the bass lanes
        macros = remix.bass_macros.model_dump() if role == "synth_bass" and remix.bass_macros else None  # its knobs
        ctx = [clip.at_beat, macros, [s.model_dump(mode="json") for s in remix.sections],
               [[c.model_dump(mode="json", exclude={"audio_id"}) for c in lane.clips] for lane in remix.lanes
                if lane.role in ("drums", "kit", "bass", "synth_bass")]]
    if role == "top":  # the candy follows its sections' chords (v0.14): a re-voiced bar re-prepares it
        ctx = [[s.model_dump(mode="json") for s in remix.sections]]
    if clip.src.kind == "kit":  # the harmony kit (S3's VERSION 2): its key, tuning and the plan's roots re-render it
        try:
            from fvwks_synth.kit import VERSION as kit_version
        except ImportError:
            kit_version = 0
        a = sources.get("A")
        ctx = ctx + [kit_version, remix.key, getattr(a.song.analysis, "tuning_cents", None) if a else None,
                     [s.model_dump(mode="json") for s in remix.sections]]
    if clip.src.kind == "kit" and next((c.option for t in remix.takes if t.seed == remix.seed for c in t.choices
                                         if c.axis == "kit.layer"), "synth") != "synth":
        try:  # the sample bank under the kit (v0.15 packs): a changed pack re-prepares its kit clips
            from fvwks_synth.layers import bank_version

            ctx = ctx + [bank_version()]
        except ImportError:
            pass
    blob = json.dumps([body, remix.bpm, songs] + ([remix.seed, clip.id, take] if seeded else []) + ctx, sort_keys=True,
                      default=str)
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
                      choose=choose, own_gaps=own_gaps(sources["A"]), vocal_phrases=vocal_phrases(sources["A"]))
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
    # a drop's first-hit carrier goes second: it lifts itself against the other bass lanes, prepared (dropfx)
    carriers = [c for c in todo if carries_first(c, remix)]
    for batch in ([c for c in todo if c not in carriers], carriers):
        with ThreadPoolExecutor(WORKERS) as pool:
            futures = {pool.submit(prepare_clip, c, remix, srcs, sr, _bass_sum(remix, {**have, **made}, c, sr)
                                   if c in carriers else None): c for c in batch}
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
    mix, report = mixdown(remix, {**have, **made}, sr, master, buses, srcs)
    say(1.0, "Done")
    return RunResult(remix, made, mix, report)
