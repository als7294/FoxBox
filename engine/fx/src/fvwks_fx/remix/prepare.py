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
from scipy import signal
from pedalboard import time_stretch

from fvwks_contracts.models import BassGroove, KitHit, Remix, RemixClip, SongAnalysis

from ..dsp import as2d, fade_edges
from ..master import integrated_lufs
from .flip import FLIP_STYLES, Hit
from .dropfx import bass_rules
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
    tuning_cents: float = 0.0  # the source's offset from A=440 (SongAnalysis.tuning_cents): every voice follows it


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


def _synth_hits(hits: list[KitHit], kit_id: str, bpm: float, beats: float, sr: int, layer: str = "synth",
                seed: int = 0, key: str | None = None, tuning_cents: float = 0.0,
                roots: list[tuple[float, int]] | None = None) -> np.ndarray | None:
    """S1's kit sampler playing the hits, or None (not installed, an unknown kit). `layer`: the take's kit.layer; `key`,
    `tuning_cents` and `roots` ((beat from the clip's start, root pc) at each change) tune the kit to the harmony
    (REMIX_HARMONY 4.4: the kick on the tonic, its tail out of another root's way, the snare on R or 5)."""
    try:
        from fvwks_synth.kit import render_kit
    except ImportError:
        return None
    try:
        return render_kit(kit_id, hits, bpm=bpm, beats=beats, sr=sr, layer=layer, seed=seed, key=key,
                          tuning_cents=tuning_cents, roots=roots)
    except KeyError:
        return None


def _rng(remix: Remix, clip: RemixClip) -> np.random.Generator:
    """The clip's variation, from the remix's seed and the clip: the same seed gives the same take."""
    return np.random.default_rng([int(remix.seed), zlib.crc32(clip.id.encode())])


ENGINE_PATCHES = ("resample:", "hybrid:", "riddim:", "808:", "top:")


def _macro_axes(remix: Remix) -> dict[str, str]:
    """The BASS DNA knobs (v0.11.12) where a voice has an axis for them: WOBBLE -> riddim R1's FM depth and its moving
    top, GLIDE -> the 808's glide times (0.5, the default, leaves the take's own options)."""
    m = remix.bass_macros
    if m is None:
        return {}
    out = {}
    if m.wobble != 0.5:
        out["riddim.r1_fm_peak"] = "0.45" if m.wobble < 0.34 else "0.7" if m.wobble < 0.67 else "0.9"
        out["riddim.r1_top"] = "static" if m.wobble < 0.25 else "lfo"
    if m.glide != 0.5:
        out["808.glide"] = "tight" if m.glide < 0.34 else "bible" if m.glide < 0.67 else "lazy"
    return out


def _kit_roots(remix: Remix, clip: RemixClip) -> list[tuple[float, int]]:
    """The clip's chord roots from its sections' plan, per half-bar, at each change: (beat from the clip's start, pc)."""
    at0, out = int(clip.at_beat // 4) + 1, []
    for h in range(int(np.ceil(clip.beats / 2))):
        got = _section_chord(remix, at0 + h // 2, 2.0 * (h % 2))
        if got is not None and (not out or out[-1][1] != got[0]):
            out.append((2.0 * h, got[0]))
    return out


def _tune(s: SourceAudio) -> float:
    """The source's tuning in semitones for every voice (REMIX_HARMONY 6.1: under 5 cents, none)."""
    return s.tuning_cents / 100.0 if abs(s.tuning_cents) >= 5.0 else 0.0


def _section_chord(remix: Remix, bar: int, beat: float = 0.0) -> tuple[int, int] | None:
    """Remix bar `bar`'s chord at `beat` from its section (v0.14 RemixSection.chords: BUILD's plan, or the user's
    re-voicing; v0.15.1 root2 from beat 3) as (root pc, third), None when the section has none for it (the source's then)."""
    from ..harmony import from_contract

    sec = next((x for x in remix.sections if x.start_bar <= bar < x.start_bar + x.bars), None)
    i = bar - sec.start_bar if sec is not None else -1
    return from_contract(sec.chords[i], beat) if sec is not None and i < len(sec.chords) else None


_HARM: dict[tuple, object] = {}  # ponytail: in-process, per source (its bass stem's id and length) and key


def _harmony(s: SourceAudio, key: str | None):
    """The source's chords (fvwks_fx.harmony), read once per source."""
    from ..harmony import chords

    k = (id(s.stems["bass"]), s.stems["bass"].shape[-1], key)
    if k not in _HARM:
        _HARM[k] = chords(s.stems, s.sr, s.bpm, s.downbeat_s, key, s.tuning_cents)
    return _HARM[k]


def _engine_bass(clip: RemixClip, remix: Remix, s: SourceAudio, sr: int, n: int) -> np.ndarray:
    """The remix engine's own bass paths (resample.py), by patch_id: resample:<style> (the source's one-shots
    re-sequenced), hybrid:<growl> (designed growls answering the held 808), riddim:wub, 808:dark (a darker, longer
    first hit at the root) and 808:dive (a switch-up's pitch dive)."""
    src = clip.src
    an = SongAnalysis(bpm=s.bpm, downbeat_s=s.downbeat_s)
    kind, _, arg = src.patch_id.partition(":")
    rng = _rng(remix, clip)
    tune = _tune(s)
    every = {"8": 8}.get(choice(remix, "drop.cadence") or "", 4)  # the take's switch cadence (AX-06): 4+8, or 8 only
    axes = {**synth_axes(remix), **_macro_axes(remix)}  # the take's options on the voices' own axes, the knobs over them
    bass = s.stems["bass"]
    root = R.root_pc(R.slice_bass(bass, s.sr, an, src.start_bar, max(4, src.bars)))
    harm = _harmony(s, remix.key)  # the source's chords, bar by bar: every engine voice's notes follow them
    at0 = int(clip.at_beat // 4) + 1

    def chord(bar: int, beat: float = 0.0) -> tuple[int, int]:  # the clip's bar (and beat) -> (root pc, third): its
        got = _section_chord(remix, at0 + bar, beat)  # section's chord, else the source's
        if got is not None:
            return got
        c = harm.at(src.start_bar + bar)
        return (root, 3) if c.root is None else (c.root, {"min": 3, "m7": 3, "sus4": 5}.get(c.quality, 4))

    follow = bool(harm.bars) or any(sec.chords for sec in remix.sections)
    if follow:
        root = chord(0)[0]
    tension = choice(remix, "drop.tension") == "on"

    def pedal(bar: int, beat: float = 0.0) -> tuple[int, int]:  # the user's set3: the growls hold the drop's tonic, the
        return chord(bar, beat) if bar % 8 >= 6 else chord(0)  # plan's chords only in its turnarounds (7-8, 15-16);
    mid = pedal if follow else None  # the sub and a kept 808 move under it (a pedal point)
    if kind == "resample":
        d0, d1 = clip.at_beat, clip.at_beat + clip.beats
        held = any(c.src.kind == "stem" and c.src.stem == "bass" and c.at_beat < d1 and c.at_beat + c.beats > d0
                   for lane in remix.lanes for c in lane.clips)  # the source 808 owns the low end: no second sub
        y = R.resample_bass(bass, s.sr, an, src.start_bar, src.bars, arg or "trap_hybrid", remix.bpm, rng, with_sub=not held,
                            switch_every=every, chord=chord if follow else None, tune=tune,
                            mid_chord=None if (arg or "trap_hybrid") == "trap_hybrid" else mid, tension=tension)  # the 808 line follows
    elif kind == "hybrid":
        held = any(c.src.kind == "stem" and c.src.stem == "bass" and c.at_beat < clip.at_beat + clip.beats
                   and c.at_beat + c.beats > clip.at_beat for lane in remix.lanes for c in lane.clips)  # a source 808
        y = R.hybrid_growls(bass, s.sr, an, src.start_bar, src.bars, arg or "tearout", remix.bpm, rng, every, axes,
                            chord if follow else None, tune,
                            with_sub=not held, mid_chord=mid, tension=tension)
    elif kind == "riddim":
        y = R.riddim_bass(s.sr, remix.bpm, src.bars, root, rng, every, axes, chord if follow else None, tune, mid, tension)
    else:
        y = None
        if arg == "dark":  # S1's dark first hit (on pitch from the first sample, a slow low-pass bloom) when installed
            try:
                from fvwks_synth.bass808 import render_darkhit

                y = render_darkhit(24 + root + tune, clip.beats, remix.bpm, sr=s.sr, variant=int(rng.integers(4)))
                y = R._fade(y, s.sr, 0.003, 0.01)  # S1: re-faded after its chain (its filters ring past the note)
            except ImportError:
                y = None
        R._note(0.0, clip.beats, (24 if arg == "dark" else 36) + root + tune, "R", "sub")  # the 808 hit's root
        if y is None:
            y = R.eight08(36 + root + tune, clip.beats, remix.bpm, s.sr, dark_hz=350.0 if arg == "dark" else None,
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


def _top(clip: RemixClip, remix: Remix, s: SourceAudio, sr: int, n: int) -> np.ndarray:
    """The ear candy on the TOP lane (v0.11.12 Remix.top_layers: top:arp / top:powerup / top:coin): S1's candy on the
    source's chords (three octaves over each bar's root; an arp re-voiced bar by bar), the remix's key where no chord
    reads, 6 dB down (it never masks the bass). Silent without the synth."""
    from ..music import parse_key

    if clip.src.patch_id in ("top:hook", "top:squeak"):
        return _hook(clip, remix, s, sr, n)
    try:
        from fvwks_synth.candy import render_candy
    except ImportError:
        return np.zeros((2, n), np.float32)
    k, harm = parse_key(remix.key), _harmony(s, remix.key)
    variant = int(_rng(remix, clip).integers(4))
    bars = [(clip.beats, clip.src.start_bar)] if clip.beats <= 4 else [
        (min(4.0, clip.beats - 4 * i), clip.src.start_bar + i) for i in range(int(np.ceil(clip.beats / 4)))]
    parts = []
    at0 = int(clip.at_beat // 4) + 1
    for i, (beats, bar) in enumerate(bars):
        got, c = _section_chord(remix, at0 + i), harm.at(bar) if harm.bars else None
        if got is not None:
            root, minor = got[0], got[1] == 3
        else:
            root, minor = (c.root, c.minor) if c is not None and c.root is not None else (k.root_pc, k.minor)
        v = (2, 3, 0, 1)[(i // 4 + variant) % 4] if clip.src.patch_id == "top:arp" else variant  # 3.3: 0-1-2-3-2-1 first,
        parts.append(np.asarray(render_candy(clip.src.patch_id[4:], 36 + root + _tune(s), beats, remix.bpm, sr, variant=v,  # the pattern every 4 bars
                                             minor=minor), np.float32))
    return np.concatenate(parts, axis=1) * np.float32(10 ** (-6 / 20))


def _hook(clip: RemixClip, remix: Remix, s: SourceAudio, sr: int, n: int) -> np.ndarray:
    """The drop's hook (REMIX_HARMONY 3): hook.motif (A A' A B on the plan's chords, the source hook's pitch set first)
    or hook.squeak (riddim: R and 5 on the wub's responses), each note on S1's squeak voice (R1 two octaves up,
    band-passed 2-5 kHz), tuned. Silent without the synth."""
    from ..harmony import pitch_set
    from ..music import parse_key
    from . import hook as H

    try:
        from fvwks_synth.riddim import render_squeak
    except ImportError:
        return np.zeros((2, n), np.float32)
    at0, harm = int(clip.at_beat // 4) + 1, _harmony(s, remix.key)

    def chord_at(bar: int, beat: float) -> tuple[int, int]:
        got = _section_chord(remix, at0 + bar, beat)
        if got is not None:
            return got
        c = harm.at(clip.src.start_bar + bar)
        return (parse_key(remix.key).root_pc, 3) if c.root is None else (c.root, {"min": 3, "m7": 3, "sus4": 5}.get(c.quality, 4))

    bars = int(np.ceil(clip.beats / 4))
    rng = _rng(remix, clip)
    if clip.src.patch_id == "top:squeak":
        notes, octaves = H.squeak(chord_at, bars), 2
    else:
        pcs = pitch_set(s.stems, s.sr, s.bpm, s.downbeat_s, max(1, clip.src.start_bar - 8), 8, tuning_cents=s.tuning_cents)
        notes, octaves = H.motif(chord_at, bars, remix.key, rng, pcs), 1
    out = np.zeros((2, n), np.float32)
    per = 60.0 / remix.bpm * sr
    for b, beats, midi in notes:
        R._note(b, beats, midi + 12 * octaves + _tune(s), "", "top")
        y = np.asarray(render_squeak(midi + _tune(s), beats, remix.bpm, sr, int(rng.integers(4)), octaves), np.float32)
        a = int(round(b * per))
        m = min(y.shape[1], n - a)
        if m > 0:
            out[:, a : a + m] += y[:, :m]
    return out


def _groove(clip: RemixClip, remix: Remix, s: SourceAudio, sr: int, n: int) -> np.ndarray:
    src = clip.src
    if src.patch_id.startswith("top:"):
        with R.trace(clip.id, clip.at_beat):
            return _fit(_top(clip, remix, s, sr, n), n)
    if src.patch_id.startswith(ENGINE_PATCHES):
        with R.trace(clip.id, clip.at_beat):
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
    if (clip.src.pattern_id or "").startswith("fx."):
        return _fit(_fx(clip, remix, sr, n), n)
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
    y = _synth_hits(hits, clip.src.kit_id, remix.bpm, clip.beats, sr, choice(remix, "kit.layer") or "synth", int(remix.seed),
                    remix.key, sources["A"].tuning_cents if sources and "A" in sources else 0.0, _kit_roots(remix, clip))
    y = foxbox_kit([Hit(h.voice, h.beat, h.vel) for h in hits], remix.bpm, sr, n, int(remix.seed)) if y is None else y
    return _drums_match(_fit(y, n), clip, remix, sr, sources)


def _fx(clip: RemixClip, remix: Remix, sr: int, n: int) -> np.ndarray:
    """A drop's impact stack (Sound Bible 1.7) on the kit-fx lane: fx.impact, a boom (sine 40 + 60 e^(-t/0.06) Hz) and a
    crash from the drop's downbeat; fx.reverse, the crash reversed into it, ending exactly on the clip's end (the
    downbeat). S1's drum voices when installed, else synthesised here; about -10 dBFS."""
    seed = int(_rng(remix, clip).integers(1 << 30))
    try:
        from fvwks_synth.drums import render_drum
    except ImportError:
        render_drum = None
    if render_drum is not None:  # S1's voices are designed at 48 kHz (a lower rate puts their cymbal filters past Nyquist)
        at48 = lambda y: y if sr == 48000 else signal.resample_poly(y, sr, 48000, axis=-1).astype(np.float32)  # noqa: E731
        mode = choice(remix, "kit.layer") or "synth"
        try:
            from fvwks_synth.layers import layer as sample_layer
        except ImportError:
            sample_layer = lambda x, *a: x  # noqa: E731
        drum = lambda v, **kw: sample_layer(render_drum(v, 48000, seed=seed, **kw), v, 48000, int(remix.seed), mode)  # noqa: E731
        if clip.src.pattern_id == "fx.reverse":
            return at48(drum("reverse_cymbal", length_s=n / sr))
        y, c = drum("impact"), drum("crash")
        m = max(y.shape[1], c.shape[1])
        return at48(np.pad(y, ((0, 0), (0, m - y.shape[1]))) + np.pad(c, ((0, 0), (0, m - c.shape[1]))))
    if clip.src.pattern_id == "fx.reverse":
        rng = np.random.default_rng(seed)
        crash = signal.sosfilt(signal.butter(2, 4000, "high", fs=sr, output="sos"), rng.standard_normal(n))
        y = 0.3 * crash / max(float(np.abs(crash).max()), 1e-9) * np.linspace(0, 1, n) ** 2
        return np.stack([y, y]).astype(np.float32)
    rng = np.random.default_rng(seed)
    t = np.arange(int(2.5 * sr)) / sr
    boom = np.sin(2 * np.pi * np.cumsum(40 + 60 * np.exp(-t / 0.06)) / sr) * np.exp(-t / 0.35)
    crash = signal.sosfilt(signal.butter(2, 4000, "high", fs=sr, output="sos"), rng.standard_normal(t.size))
    crash = crash / np.abs(crash).max() * np.exp(-t / 0.9) * np.minimum(1, t / 0.001)
    y = 0.3 * (boom + 0.35 * crash)
    return np.stack([y, y]).astype(np.float32)


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


def prepare_clip(clip: RemixClip, remix: Remix, sources: dict[str, SourceAudio], sr: int = 48000,
                 others: np.ndarray | None = None) -> np.ndarray:
    """The clip's audio (see the module doc): (2, n) float32, n = clip.beats at remix.bpm. `others`: for a drop's
    first-hit carrier (dropfx.carries_first), the drop's other bass lanes, prepared, summed from its downbeat."""
    n = int(round(clip.beats * 60.0 / remix.bpm * sr))
    kind = clip.src.kind
    if kind == "stem":
        y = _stem(clip, remix, sources[clip.src.slot], sr, n)
    elif kind == "groove":
        y = _groove(clip, remix, sources[clip.src.slot], sr, n)
    else:
        y = _kit(clip, remix, sr, n, sources)
    role = next((lane.role for lane in remix.lanes if any(c.id == clip.id for c in lane.clips)), None)
    if role in ("bass", "synth_bass"):  # the drop rules in the clip itself (M1.14): the app plays what the export does
        y = bass_rules(y, clip, role, remix, sources, sr, others)
    per_beat = sr * 60.0 / remix.bpm
    fi, fo = int(clip.fade_in_beats * per_beat), int(clip.fade_out_beats * per_beat)
    if fi:
        y[:, :fi] *= np.linspace(0, 1, fi, dtype=np.float32)
    if fo:
        y[:, n - fo :] *= np.linspace(1, 0, fo, dtype=np.float32)
    return (y * np.float32(10 ** (clip.gain_db / 20))).astype(np.float32)
