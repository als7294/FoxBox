"""1.6 REMIX: PREPARE. Each clip's audio at the remix tempo and key, exactly clip.beats long, ready for the app to
schedule (only a new clip waits on the engine).

prepare_clip(clip, remix, sources, sr) -> (2, n) float32:
  stem    the source song's stem from src.start_beat (its own beats), time-stretched to the remix tempo and shifted
          clip.shift_st in one Rubber Band R3 pass (pedalboard; skipped at 1x and 0 st)
  groove  BASS DNA of the source bars (bass_groove), re-played at the remix tempo on src.patch_id through S1's
          fvwks_synth (Surge XT or a FoxBox patch; it rides the groove's level curve, the bounce); without fvwks_synth
          or a playable patch, the saw + sub here. shift_st moves the notes, not the audio; as loud (integrated LUFS)
          as the source's bass over those bars
  kit     src.hits (else the style pattern_id, a FLIP_STYLES id) on S1's kit sampler, else a small kit synthesised here
then the fades and gain. `sources`: slot → SourceAudio (the song's grid and its stems). The two fvwks_synth calls are
_synth_groove and _synth_hits: S1 swaps engines behind them.
"""

from __future__ import annotations

import zlib
from dataclasses import dataclass

import numpy as np
from pedalboard import time_stretch

from fvwks_contracts.models import BassGroove, KitHit, Remix, RemixClip, SongAnalysis

from ..dsp import as2d, fade_edges
from ..master import integrated_lufs
from .flip import FLIP_STYLES, Hit
from .styles import choice, synth_axes
from . import resample as R
from .groove import extract_groove, render_groove

PRE_ROLL_S = 0.25  # audio before the clip start fed to the stretcher (its first frames settle), then cut
EDGE_S = 0.004  # a DAW's clip-edge fade, on stretched or shifted clips only


@dataclass
class SourceAudio:
    bpm: float
    downbeat_s: float
    stems: dict[str, np.ndarray]  # drums / bass / vocals / other: (channels, n) float32 at sr
    sr: int


def _cut(x: np.ndarray, a: int, b: int) -> np.ndarray:
    """x[:, a:b] with silence where it runs off either end."""
    x = as2d(x)
    out = np.zeros((x.shape[0], b - a), np.float32)
    lo, hi = max(a, 0), min(b, x.shape[1])
    if hi > lo:
        out[:, lo - a : hi - a] = x[:, lo:hi]
    return out


def _fit(x: np.ndarray, n: int) -> np.ndarray:
    x = as2d(x)
    x = x if x.shape[0] == 2 else np.repeat(x[:1], 2, axis=0)
    return x[:, :n] if x.shape[1] >= n else np.pad(x, ((0, 0), (0, n - x.shape[1])))


def _stem(clip: RemixClip, remix: Remix, s: SourceAudio, sr: int, n: int) -> np.ndarray:
    beat = 60.0 / s.bpm
    t0 = s.downbeat_s + clip.src.start_beat * beat
    pre = int(PRE_ROLL_S * s.sr)
    a = int(round(t0 * s.sr))
    x = _cut(s.stems[clip.src.stem], a - pre, a + int(round(clip.beats * beat * s.sr)) + pre)
    ratio = remix.bpm / s.bpm
    stretched = abs(ratio - 1) > 1e-4 or bool(clip.shift_st)
    if stretched:
        # drums on Rubber Band's R2 engine (crisp transients, no smear); tonal stems on R3
        x = time_stretch(x, s.sr, stretch_factor=ratio, pitch_shift_in_semitones=float(clip.shift_st),
                         high_quality=clip.src.stem != "drums")
    x = x[:, int(round(pre / ratio)) :]
    if s.sr != sr:
        from scipy.signal import resample_poly

        x = resample_poly(x, sr, s.sr, axis=1).astype(np.float32)
    if not stretched:
        return _fit(x, n)  # bit-continuous with its neighbours
    e = int(EDGE_S * sr)  # a stretched clip never meets its neighbour sample-continuously: 4 ms edges
    return fade_edges(_fit(x, n), e, e)


def _synth_groove(g: BassGroove, patch_id: str, bpm: float, shift_st: float, sr: int) -> np.ndarray | None:
    """S1's fvwks_synth playing the groove (Surge XT or a FoxBox patch; the level curve rides on its output there), or
    None (not installed, an unknown patch, Surge not built)."""
    try:
        from fvwks_synth.bass import render_groove as synth, usable
    except ImportError:
        return None
    try:
        if not usable(patch_id):
            return None
        return synth(g, patch_id, start_bar=g.start_bar, bars=g.bars, bpm=bpm, shift_st=shift_st, sr=sr)
    except KeyError:
        return None


def _synth_hits(hits: list[KitHit], kit_id: str, bpm: float, beats: float, sr: int) -> np.ndarray | None:
    """S1's kit sampler playing the hits, or None (not installed, an unknown kit)."""
    try:
        from fvwks_synth.kit import render_kit
    except ImportError:
        return None
    try:
        return render_kit(kit_id, hits, bpm=bpm, beats=beats, sr=sr)
    except KeyError:
        return None


def _rng(remix: Remix, clip: RemixClip) -> np.random.Generator:
    """The clip's variation, from the remix's seed and the clip: the same seed gives the same take."""
    return np.random.default_rng([int(remix.seed), zlib.crc32(clip.id.encode())])


ENGINE_PATCHES = ("resample:", "hybrid:", "riddim:", "808:")


def _engine_bass(clip: RemixClip, remix: Remix, s: SourceAudio, sr: int, n: int) -> np.ndarray:
    """The remix engine's own bass paths (resample.py), by patch_id: resample:<style> (the source's one-shots
    re-sequenced), hybrid:<growl> (designed growls answering the held 808), riddim:wub, 808:dark (a darker, longer
    first hit at the root) and 808:dive (a switch-up's pitch dive)."""
    src = clip.src
    an = SongAnalysis(bpm=s.bpm, downbeat_s=s.downbeat_s)
    kind, _, arg = src.patch_id.partition(":")
    rng = _rng(remix, clip)
    every = {"8": 8}.get(choice(remix, "drop.cadence") or "", 4)  # the take's switch cadence (AX-06): 4+8, or 8 only
    axes = synth_axes(remix)  # the take's options on the voices' own axes
    bass = s.stems["bass"]
    root = R.root_pc(R.slice_bass(bass, s.sr, an, src.start_bar, max(4, src.bars)))
    if kind == "resample":
        d0, d1 = clip.at_beat, clip.at_beat + clip.beats
        held = any(c.src.kind == "stem" and c.src.stem == "bass" and c.at_beat < d1 and c.at_beat + c.beats > d0
                   for lane in remix.lanes for c in lane.clips)  # the source 808 owns the low end: no second sub
        y = R.resample_bass(bass, s.sr, an, src.start_bar, src.bars, arg or "trap_hybrid", remix.bpm, rng, with_sub=not held,
                            switch_every=every)
    elif kind == "hybrid":
        y = R.hybrid_growls(bass, s.sr, an, src.start_bar, src.bars, arg or "tearout", remix.bpm, rng, every, axes)
    elif kind == "riddim":
        y = R.riddim_bass(s.sr, remix.bpm, src.bars, root, rng, every, axes)
    else:
        y = None
        if arg == "dark":  # S1's dark first hit (on pitch from the first sample, a slow low-pass bloom) when installed
            try:
                from fvwks_synth.bass808 import render_darkhit

                y = render_darkhit(24 + root, clip.beats, remix.bpm, sr=s.sr, variant=int(rng.integers(4)))
                y = R._fade(y, s.sr, 0.003, 0.01)  # S1: re-faded after its chain (its filters ring past the note)
            except ImportError:
                y = None
        if y is None:
            y = R.eight08(36 + root, clip.beats, remix.bpm, s.sr, dark_hz=350.0 if arg == "dark" else None,
                          dive_st=-19.0 if arg == "dive" else 0.0)
    if s.sr != sr:
        from scipy.signal import resample_poly

        y = resample_poly(y, sr, s.sr, axis=1).astype(np.float32)
    y = _fit(y, n)
    if kind != "808":  # silent under the drop's darker first hit (808:dark): it starts after it
        per = sr * 60.0 / remix.bpm
        for c in (c for lane in remix.lanes for c in lane.clips
                  if c.src.kind == "groove" and c.src.patch_id == "808:dark"):
            a, b = int((c.at_beat - clip.at_beat) * per), int((c.at_beat + c.beats - clip.at_beat) * per)
            if b > 0 and a < n:
                g = np.ones(n, np.float32)
                g[max(0, a) : min(n, b)] = 0.0
                r = int(0.005 * sr)
                g[min(n, b) : min(n, b) + r] = np.linspace(0, 1, len(g[min(n, b) : min(n, b) + r]))
                y = y * g
    return y


def _groove(clip: RemixClip, remix: Remix, s: SourceAudio, sr: int, n: int) -> np.ndarray:
    src = clip.src
    if src.patch_id.startswith(ENGINE_PATCHES):
        y = _match(_engine_bass(clip, remix, s, sr, n), sr, s, src.start_bar, src.bars)
        # a riddim over the source's held 808: mid-forward (Sound Bible 5: -4..+2 dB re the sub), not LUFS-level with it
        return y * np.float32(10 ** (3 / 20)) if src.patch_id == "resample:riddim" else y
    bar = 4 * 60.0 / s.bpm
    # only those bars and one either side (not the whole song): the cut's bar 1 (a bar in) is the groove's first bar
    a0 = int(round((s.downbeat_s + (src.start_bar - 2) * bar) * s.sr))
    cut = _cut(s.stems["bass"], a0, a0 + int(round((src.bars + 2) * bar * s.sr)))
    g = extract_groove(cut, s.sr, SongAnalysis(bpm=s.bpm, downbeat_s=bar), start_bar=1, bars=src.bars)
    g = g.model_copy(update={"start_bar": src.start_bar})
    y = _synth_groove(g, src.patch_id, remix.bpm, clip.shift_st, sr)
    if y is None:
        y = render_groove(_shift(g, clip.shift_st) if clip.shift_st else g, sr, bpm=remix.bpm)
    return _match(_fit(y, n), sr, s, src.start_bar, src.bars)


def _match(y: np.ndarray, sr: int, s: SourceAudio, start_bar: int, bars: int, stem: str = "bass") -> np.ndarray:
    """As loud (integrated LUFS) as what it replaces: those bars of the source's `stem`."""
    beat = 60.0 / s.bpm
    a = int(round((s.downbeat_s + (start_bar - 1) * 4 * beat) * s.sr))
    ref = integrated_lufs(_cut(s.stems[stem], a, a + int(round(bars * 4 * beat * s.sr))), s.sr)
    got = integrated_lufs(y, sr)
    if np.isfinite(ref) and np.isfinite(got) and ref > -70 and got > -70:
        y = y * np.float32(10 ** (np.clip(ref - got, -24, 24) / 20))
    return y


def _shift(g: BassGroove, st: float) -> BassGroove:
    notes = [n.model_copy(update={"midi": n.midi + st, "glide_to": None if n.glide_to is None else n.glide_to + st,
                                  "bend": None if n.bend is None else [(b, m + st) for b, m in n.bend]}) for n in g.notes]
    return g.model_copy(update={"notes": notes})


def _kit(clip: RemixClip, remix: Remix, sr: int, n: int, sources: dict[str, SourceAudio] | None = None) -> np.ndarray:
    hits = list(clip.src.hits)
    if not hits and clip.src.pattern_id in FLIP_STYLES:  # a library loop: the style's pattern, bar after bar
        pat = FLIP_STYLES[clip.src.pattern_id]["hits"]
        hits = [KitHit(beat=4 * i + b, voice=k, vel=v) for i in range(int(np.ceil(clip.beats / 4))) for b, k, v in pat
                if 4 * i + b < clip.beats]
    if clip.src.kit_id == "source" and sources and "A" in sources:  # the song's own drums, re-sequenced
        s = sources["A"]
        y = R.source_kit(s.stems["drums"], s.sr, SongAnalysis(bpm=s.bpm, downbeat_s=s.downbeat_s), hits, remix.bpm,
                         int(round(clip.beats * 60.0 / remix.bpm * s.sr)))
        if s.sr != sr:
            from scipy.signal import resample_poly

            y = resample_poly(y, sr, s.sr, axis=1).astype(np.float32)
        return _drums_match(_fit(y, n), clip, remix, sr, sources)
    y = _synth_hits(hits, clip.src.kit_id, remix.bpm, clip.beats, sr)
    y = foxbox_kit([Hit(h.voice, h.beat, h.vel) for h in hits], remix.bpm, sr, n, int(remix.seed)) if y is None else y
    return _drums_match(_fit(y, n), clip, remix, sr, sources)


def _drums_match(y: np.ndarray, clip: RemixClip, remix: Remix, sr: int, sources: dict[str, SourceAudio] | None) -> np.ndarray:
    """A kit as loud as the source's drum stem over the bars it replaces (Sound Bible 1.5: loudness-matched before the
    bus stages): the source bars of the section the clip starts in."""
    if not sources or "A" not in sources:
        return y
    sec = next((x for x in remix.sections if (x.start_bar - 1) * 4 <= clip.at_beat < (x.start_bar - 1 + x.bars) * 4), None)
    if sec is None or sec.from_start_bar is None:
        return y
    start = sec.from_start_bar + int((clip.at_beat - (sec.start_bar - 1) * 4) // 4)
    return _match(y, sr, sources["A"], start, max(1, int(round(clip.beats / 4))), stem="drums")


def foxbox_kit(hits: list[Hit], bpm: float, sr: int, n: int, seed: int = 0) -> np.ndarray:
    """A small synthesised kit (the fallback without fvwks_synth): a pitch-swept sine kick, a tone + noise snare,
    noise hats."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(0.4 * sr)) / sr
    hp = lambda x: np.diff(x, prepend=0.0)
    sounds = {
        "kick": np.sin(2 * np.pi * np.cumsum(48 + 90 * np.exp(-t / 0.03)) / sr) * np.exp(-t / 0.18),
        "snare": (0.4 * np.sin(2 * np.pi * 190 * t) + 0.6 * hp(rng.standard_normal(t.size))) * np.exp(-t / 0.1),
        "hats": hp(hp(rng.standard_normal(t.size))) * np.exp(-t / 0.025),
    }
    level = {"kick": 1.0, "snare": 0.8, "hats": 0.35}
    sounds = {k: level[k] * v / np.abs(v).max() for k, v in sounds.items()}
    y = np.zeros(n)
    for h in hits:
        a = int(round(h.beat * 60.0 / bpm * sr))
        if 0 <= a < n:
            s = sounds[h.kind]
            y[a : a + s.size] += 0.8 * h.vel * s[: n - a]
    return y.astype(np.float32)


def prepare_clip(clip: RemixClip, remix: Remix, sources: dict[str, SourceAudio], sr: int = 48000) -> np.ndarray:
    """The clip's audio (see the module doc): (2, n) float32, n = clip.beats at remix.bpm."""
    n = int(round(clip.beats * 60.0 / remix.bpm * sr))
    kind = clip.src.kind
    if kind == "stem":
        y = _stem(clip, remix, sources[clip.src.slot], sr, n)
    elif kind == "groove":
        y = _groove(clip, remix, sources[clip.src.slot], sr, n)
    else:
        y = _kit(clip, remix, sr, n, sources)
    per_beat = sr * 60.0 / remix.bpm
    fi, fo = int(clip.fade_in_beats * per_beat), int(clip.fade_out_beats * per_beat)
    if fi:
        y[:, :fi] *= np.linspace(0, 1, fi, dtype=np.float32)
    if fo:
        y[:, n - fo :] *= np.linspace(1, 0, fo, dtype=np.float32)
    return (y * np.float32(10 ** (clip.gain_db / 20))).astype(np.float32)
