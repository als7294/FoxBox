"""The FVWKS rack pipeline behind ``fvwks_fx.api.render``.

Order (fixed): PREP -> MASK -> LAYERS -> MACHINE -> PLACE (arrange: fit / beat-lock / stutter / pre-roll)
-> DRIVE -> CRUSH -> TONE -> MOTION -> DYNAMICS -> SPACE -> STEREO -> FINISH (tape-stop) -> MASTER.

Placement sits before the time-based FX so delays, throws, reverb tails and the reverse swell live on the
bar grid; tape-stop and the exact-length cut happen after STEREO.

Every stage is memoized under a hash of everything upstream of it (``memo.STAGES``). Final renders run the
rack at 48 kHz; previews run it at 24 kHz (WORLD synthesizes directly at 24 kHz from the 48 kHz analysis).
"""

from __future__ import annotations

import dataclasses
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Sequence

import numpy as np
from scipy import signal

from fvwks_contracts.models import (
    Arrange,
    Chain,
    FitReport,
    Loudness,
    Master,
    RenderRequest,
    Segment,
    SegmentFlags,
    StackVoice,
    Word,
)
from fvwks_contracts.seam import ENGINE_SR, RenderOutput, Source

from . import arrange as arr
from .dsp import EPS, active_rms, as2d, audio_hash, db_to_lin, finite, fit_length, lin_to_db, stable_hash, to_mono, to_stereo
from .maskscore import mask_strength
from .master import master as run_master, resample
from .memo import STAGES
from . import motion as MOT

try:  # contracts proposal 10 (RenderInfo.motion); until the model exists the payload stays a plain dict
    from fvwks_contracts.models import Motion as _MotionModel
except ImportError:
    _MotionModel = None
from .modules import airwin as AW
from .modules import crush as C
from .modules import drive as D
from .modules import dynamics as DY
from .modules import layers as L
from .modules import machine as MC
from .modules import mask as M
from .modules import motion as MO
from .modules import prep as PR
from .modules import space as SP
from .modules import stereo as ST
from .modules import tone as T
from .music import Key, beat_seconds, note_seconds, parse_key
from .rack_spec import OFF_DB, SPECS

PREVIEW_SR = 24000
REF_DB = -20.0  # internal calibration level (active RMS, dBFS)
# pyworld synthesis, pedalboard, scipy resampling/convolution all release the GIL (measured ~4x on 4 threads), so
# independent work (layer voices, SPACE sends, the dry A/B master) runs concurrently. The master's own loudness
# search uses a separate pool (master.EVAL_POOL) so a task here never waits on a nested task in the same pool.
POOL = ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 4), thread_name_prefix="fvwks-rack")


# --------------------------------------------------------------------------- params


class Params:
    """Resolved-chain accessor with rack defaults."""

    def __init__(self, chain: Chain):
        self.mods = {m.id: m for m in chain.modules}

    def on(self, module: str) -> bool:
        m = self.mods.get(module)
        return bool(m is not None and m.enabled)

    def get(self, module: str, param: str) -> Any:
        m = self.mods.get(module)
        spec = SPECS.get(module, {}).get(param)
        default = spec.default if spec is not None else None
        if m is None:
            return default
        return m.params.get(param, default)

    def f(self, module: str, param: str) -> float:
        v = self.get(module, param)
        try:
            return float(v)
        except (TypeError, ValueError):
            spec = SPECS[module][param]
            return float(spec.default)

    def module_params(self, module: str) -> dict:
        """Effective params of a module (defaults filled), or None when disabled (for memo keys)."""
        if not self.on(module):
            return {"enabled": False}
        return {p: self.get(module, p) for p in SPECS.get(module, {})}


@dataclass
class Ctx:
    sr: int
    quality: str
    key: Key
    arrange: Arrange
    master: Master
    kind: str
    seed: int = 0
    warnings: list[str] = field(default_factory=list)
    timings: dict[str, float] = field(default_factory=dict)


def _timed(ctx: Ctx, name: str, key: str, fn: Callable[[], Any]) -> Any:
    t0 = time.perf_counter()
    hit = STAGES.get(key)
    if hit is None:
        hit = fn()
        STAGES.put(key, hit)
    ctx.timings[name] = round((time.perf_counter() - t0) * 1000.0, 2)
    return hit


# --------------------------------------------------------------------------- sources


def source_audio48(src: Source) -> np.ndarray:
    """Mono float32 at 48 kHz (sources should already be at ENGINE_SR; resample defensively)."""
    x = to_mono(np.asarray(src.audio, dtype=np.float32))
    sr = int(getattr(src.info, "sample_rate", ENGINE_SR) or ENGINE_SR)
    if sr != ENGINE_SR:
        x = as2d(resample(x, sr, ENGINE_SR))
    return finite(x)


def analysis_method(kind: str, role: str = "main") -> str:
    """Harvest for the main voice (best voicing decisions; cached, computed in the background by analyze()).
    STACK voices sit 8-14 dB under it and are analyzed at render time: DIO (~20x faster) is plenty there."""
    return "dio" if role == "stack" else "harvest"


def get_analysis(x48: np.ndarray, kind: str, quality: str, role: str = "main") -> M.WorldAnalysis | None:
    """Cached WORLD analysis. Finals compute Harvest when missing; previews fall back to a fast DIO analysis
    until the background Harvest analysis lands."""
    method = analysis_method(kind, role)
    an = M.cached_analysis(x48, ENGINE_SR, method)
    if an is not None:
        return an
    if role == "stack":  # a background analyze() of the stack source (Harvest) serves it too
        an = M.cached_analysis(x48, ENGINE_SR, "harvest")
        if an is not None:
            return an
    if quality == "final" or method == "dio":
        return M.analyze_world(x48, ENGINE_SR, method)
    return M.cached_analysis(x48, ENGINE_SR, "dio") or M.analyze_world(x48, ENGINE_SR, "dio")


def calibration_gain(x: np.ndarray, sr: int) -> float:
    r = active_rms(x, sr)
    return float(db_to_lin(REF_DB) / r) if r > EPS else 1.0


def to_rate(x48: np.ndarray, sr: int) -> np.ndarray:
    if sr == ENGINE_SR:
        return as2d(x48)
    return as2d(signal.resample_poly(as2d(x48), sr, ENGINE_SR, axis=-1).astype(np.float32))


# --------------------------------------------------------------------------- stages


def stage_mask(ctx: Ctx, p: Params, x48: np.ndarray, gain: float, an: M.WorldAnalysis | None
               ) -> tuple[np.ndarray, M.WorldFeatures | None, str]:
    """PREP + MASK. Returns (mono voice at ctx.sr, masked WORLD features or None, engine)."""
    sr = ctx.sr
    ref = float(db_to_lin(REF_DB)) if (not p.on("prep") or bool(p.get("prep", "normalize"))) else active_rms(x48 * gain, ENGINE_SR)
    if p.on("mask") and an is not None:
        levels = PR.frame_levels_db(x48 * gain, ENGINE_SR, an.n_frames, an.frame_period_ms) if p.on("prep") else None
        fmt = p.f("mask", "formant_st")
        # previews synthesize at 24 kHz: only the bins below 12 kHz (+ warp margin) are ever used
        sl = M.band_slice(an, M.bins_for(an.fft_size, an.sr, sr, min(2.0 ** (fmt / 12.0), 1.0))) if sr < an.sr else an
        sp, f0 = sl.sp, sl.f0
        if p.on("prep"):
            sp, f0 = PR.prep_envelope(sp, f0, ENGINE_SR, levels, hpf_hz=p.f("prep", "hp_hz"), gate_db=p.f("prep", "gate_db"),
                                      deess=p.f("prep", "deess"), fft_size=an.fft_size)
        base = M.WorldAnalysis(an.sr, an.frame_period_ms, f0, sp, sl.ap, an.n_samples, an.content_hash, an.method, an.rms,
                               an.fft_size)
        feat = M.mask_features(
            base, pitch_st=p.f("mask", "pitch_st"), pitch_mode=str(p.get("mask", "pitch_mode")), monotone=p.f("mask", "monotone"),
            key=ctx.key, formant_st=fmt, mcadams=p.f("mask", "mcadams"), breath=p.f("mask", "breath"),
            growl=p.f("mask", "growl"), seed=ctx.seed, out_sr=sr,
        )
        y = M.render_features(feat, out_sr=sr)[None, :]
        cur = active_rms(y, sr)
        if cur > EPS:
            y = y * (ref / cur)
        return as2d(y), feat, "world"
    x = to_rate(x48 * gain, sr)
    if p.on("prep"):
        x = PR.prep(x, sr, hpf_hz=p.f("prep", "hp_hz"), gate_db=p.f("prep", "gate_db") if p.f("prep", "gate_db") > -79.9 else None,
                    deess_db=p.f("prep", "deess") * 10.0, normalize_db=None)
    if not p.on("mask"):
        return as2d(x), None, "bypass"
    y = M.mask_preview(x, sr, pitch_st=p.f("mask", "pitch_st"), formant_st=p.f("mask", "formant_st"), breath=p.f("mask", "breath"))
    cur = active_rms(y, sr)
    if cur > EPS:
        y = y * (ref / cur)
    return as2d(y), None, "stft"


def _stack_part(ctx: Ctx, p: Params, i: int, sv: StackVoice, src: Source | None, main: Source, main48: np.ndarray,
                main_an: M.WorldAnalysis | None, n48: int) -> np.ndarray | None:
    return _stack_part_raw(ctx, p, i, sv, src, main, main48, main_an, n48)


def _stack_part_raw(ctx: Ctx, p: Params, i: int, sv: StackVoice, src: Source | None, main: Source, main48: np.ndarray,
                    main_an: M.WorldAnalysis | None, n48: int) -> np.ndarray | None:
    sr = ctx.sr
    half = sr // 2  # STACK voices sit 8-14 dB under the main voice: synthesize at half rate, upsample
    n_out = int(round(n48 * sr / ENGINE_SR))

    def up(y: np.ndarray) -> np.ndarray:
        return fit_length(signal.resample_poly(y, 2, 1)[None, :].astype(np.float32), n_out)[0]
    mode, flat, breath = str(p.get("mask", "pitch_mode")), p.f("mask", "monotone"), p.f("mask", "breath")
    if not p.on("mask"):
        mode, flat, breath = "natural", 0.0, 0.0
    main_segs = main.info.segments
    common = dict(pitch_st=sv.pitch_st, formant_st=sv.formant_st, pitch_mode=mode, monotone=flat, key=ctx.key, breath=breath)
    if src is None:  # pseudo-stack: a detuned, slightly late copy of the main voice
        if main_an is None:
            y = L.stack_voice_stretch(to_rate(main48, sr), sr, main_segs, main_segs, int(round(n48 * sr / ENGINE_SR)),
                                      pitch_st=sv.pitch_st)
        else:
            y = up(L.stack_voice_world(main_an, main_segs, main_segs, n48, jitter_amount=0.35, seed=101 + i, out_sr=half,
                                       **common))
        lag = int((0.012 + 0.009 * i) * sr)
        return np.concatenate([np.zeros(lag, np.float32), y[: y.size - lag]])
    x48 = source_audio48(src)
    an = get_analysis(x48, src.info.kind, ctx.quality, role="stack")
    if len(src.info.segments) != len(main_segs):
        ctx.warnings.append(f"stack voice {i + 1}: {len(src.info.segments)} segments vs {len(main_segs)}; aligned as one span")
    if an is None:
        return L.stack_voice_stretch(to_rate(x48, sr), sr, main_segs, src.info.segments, int(round(n48 * sr / ENGINE_SR)),
                                     pitch_st=sv.pitch_st)
    return up(L.stack_voice_world(an, main_segs, src.info.segments, n48, out_sr=half, **common))


def stage_layers(ctx: Ctx, p: Params, voice: np.ndarray, feat: M.WorldFeatures | None, stack: list[StackVoice],
                 stack_src: list[Source | None], main: Source, main48: np.ndarray, main_an: M.WorldAnalysis | None
                 ) -> tuple[np.ndarray, np.ndarray]:
    """Returns (stereo mix, stereo layers-only)."""
    sr = ctx.sr
    n = voice.shape[1]
    jobs: list[tuple[Callable[[], np.ndarray | None], float, float]] = []  # (render, gain_db, pan)
    if p.on("layers"):
        sub_db, ghost_db = p.f("layers", "sub_gain_db"), p.f("layers", "ghost_gain_db")
        if sub_db > OFF_DB + 0.1:
            def sub() -> np.ndarray:
                if feat is not None:
                    return L.sub_layer(feat, p.f("layers", "sub_st"), p.f("layers", "sub_formant_st"), out_sr=sr)
                y = M.stft_shift(voice, sr, 2.0 ** (p.f("layers", "sub_st") / 12.0), p.f("layers", "sub_formant_st"))
                return L.lowpass(y, sr, 2500.0)[0]
            jobs.append((sub, sub_db, 0.0))
        if ghost_db > OFF_DB + 0.1:
            def ghost() -> np.ndarray:
                if feat is not None:
                    return L.ghost_layer(feat, p.f("layers", "ghost_st"), out_sr=sr)
                y = M.stft_shift(voice, sr, 2.0 ** (p.f("layers", "ghost_st") / 12.0), 3.0)
                return L.highpass(y, sr, 700.0, order=2)[0]
            jobs.append((ghost, ghost_db, 0.0))
    for i, sv in enumerate(stack):
        if sv.gain_db <= OFF_DB + 0.1:
            continue
        src = stack_src[i] if i < len(stack_src) else None
        jobs.append((lambda i=i, sv=sv, src=src: _stack_part(ctx, p, i, sv, src, main, main48, main_an, main48.shape[1]),
                     sv.gain_db, sv.pan))
    rendered = list(POOL.map(lambda job: job[0](), jobs))  # every voice synthesizes concurrently
    parts = [L.LayerPart(fit_length(np.asarray(y)[None, :], n)[0], g, pan)
             for y, (_, g, pan) in zip(rendered, jobs) if y is not None]
    if not parts:
        return to_stereo(voice), np.zeros((2, n), np.float32)
    mix = L.mix_layers(voice, parts, sr)
    only = mix - to_stereo(voice)
    return mix, only


def _need_airwin(ctx: Ctx, wanted: bool, what: str) -> None:
    if wanted and not AW.AVAILABLE:
        msg = f"{what}: unavailable in this build (the Airwindows module isn't compiled); skipped"
        if msg not in ctx.warnings:
            ctx.warnings.append(msg)


def stage_machine(ctx: Ctx, p: Params, x: np.ndarray) -> np.ndarray:
    if not p.on("machine"):
        return x
    sr = ctx.sr
    y = x
    if p.f("machine", "vocoder_mix") > 0:
        voc = dict(carrier=str(p.get("machine", "vocoder_carrier")), key=ctx.key, octave=int(round(p.f("machine", "vocoder_octave"))),
                   chord=str(p.get("machine", "vocoder_chord")), mix=p.f("machine", "vocoder_mix"), seed=ctx.seed)
        if str(p.get("machine", "vocoder_mode")) == "talkbox":
            y = MC.talkbox(y, sr, **voc)
        else:
            y = MC.vocoder(y, sr, bands=int(round(p.f("machine", "vocoder_bands"))), **voc)
    if p.f("machine", "ring_mix") > 0:
        y = MC.ring_mod(y, sr, freq_hz=p.f("machine", "ring_hz"), mix=p.f("machine", "ring_mix"))
    if p.f("machine", "shift_mix") > 0 and abs(p.f("machine", "shift_hz")) > 0:
        y = MC.freq_shift(y, sr, shift_hz=p.f("machine", "shift_hz"), mix=p.f("machine", "shift_mix"))
    return y


def _on_span(x: np.ndarray, sr: int, fn: Callable[[np.ndarray], np.ndarray], pre_s: float = 0.15,
             post_s: float = 0.6) -> np.ndarray:
    """Run ``fn`` only over the non-silent span of the timeline (plus margins for filter / modulation tails).
    Inserts before SPACE see silence outside the placed voice, so this skips pre-roll, tail and padding."""
    m = np.max(np.abs(x), axis=0)
    idx = np.flatnonzero(m > 1e-7)
    if idx.size == 0:
        return x
    a = max(0, int(idx[0]) - int(pre_s * sr))
    b = min(x.shape[1], int(idx[-1]) + int(post_s * sr))
    seg = fn(np.ascontiguousarray(x[:, a:b]))
    out = np.zeros((seg.shape[0], x.shape[1]), np.float32)
    out[:, a : a + seg.shape[1]] = seg[:, : b - a]
    return out


def stage_inserts(ctx: Ctx, p: Params, module: str, x: np.ndarray, plan: arr.PlacementPlan) -> np.ndarray:
    sr = ctx.sr
    if module == "drive":
        if not p.on("drive"):
            return x
        mode = str(p.get("drive", "mode"))
        tone = p.f("drive", "tone")
        lp = 1500.0 * (16000.0 / 1500.0) ** tone
        os = int(p.get("drive", "oversample") or 4)
        if ctx.quality != "final":
            os = min(os, 2)
        color = str(p.get("drive", "color"))
        _need_airwin(ctx, color != "off", f"DRIVE color '{color}'")
        return _on_span(x, sr, lambda s: D.drive(s, sr, mode=mode, drive_db=p.f("drive", "drive_db"), mix=p.f("drive", "mix"),
                                                 oversample=os, tone_hz=lp if lp < 0.45 * sr else None, color=color,
                                                 color_drive=p.f("drive", "color_drive"), seed=ctx.seed + 11))
    if module == "crush":
        y = x
        if p.on("crush"):
            bits = p.f("crush", "bits")
            rate = p.f("crush", "rate_hz")
            codec = str(p.get("crush", "codec"))
            kbps = p.f("crush", "mp3_kbps")
            q = float(np.interp(kbps, [8, 32, 64, 128], [9.99, 9.0, 6.0, 2.0]))
            derez = p.f("crush", "derez")
            _need_airwin(ctx, derez > 0, "CRUSH derez")
            y = _on_span(y, sr, lambda s: C.crush(s, sr, bits=bits if bits < 23.5 else None,
                                                  rate_hz=rate if rate < sr * 0.99 else None, codec_kind=codec,
                                                  mp3_quality=q, mix=p.f("crush", "mix"), derez=derez, seed=ctx.seed + 12))
        noise_db = p.f("crush", "noise_db") if p.on("crush") else -80.0
        squelch = p.on("edit") and bool(p.get("edit", "squelch"))
        if noise_db > -79.5 or squelch:
            start = max(0.0, plan.first_word_s - 0.12)
            end = plan.speech_end_s + 0.25
            level = noise_db if noise_db > -79.5 else -36.0
            bed = C.noise_bed(y.shape[1], sr, level, start=int(start * sr), end=int(end * sr), squelch=squelch,
                              seed=ctx.seed + 5, channels=y.shape[0])
            if noise_db <= -79.5:  # squelch only: keep the bursts, drop the hiss
                hiss = C.noise_bed(y.shape[1], sr, level, start=int(start * sr), end=int(end * sr), squelch=False,
                                   seed=ctx.seed + 5, channels=y.shape[0])
                bed = bed - hiss
            y = y + bed
        return y
    if module == "tone":
        if not p.on("tone"):
            return x
        return _on_span(x, sr, lambda s: T.tone(
            s, sr, hpf_hz=p.f("tone", "hp_hz") if p.f("tone", "hp_hz") > 20.5 else None,
            lpf_hz=p.f("tone", "lp_hz") if p.f("tone", "lp_hz") < 19999 else None, resonance=p.f("tone", "resonance"),
            low_shelf_hz=p.f("tone", "low_hz"), low_shelf_db=p.f("tone", "low_db"), peak_hz=p.f("tone", "mid_hz"),
            peak_db=p.f("tone", "mid_db"), peak_q=p.f("tone", "mid_q")))
    if module == "motion":
        if not p.on("motion"):
            return x
        return _on_span(x, sr, lambda s: MO.motion(s, sr, phaser_mix=p.f("motion", "phaser_mix"),
                                                   phaser_rate_hz=p.f("motion", "phaser_rate_hz"),
                                                   chorus_mix=p.f("motion", "chorus_mix"),
                                                   chorus_rate_hz=p.f("motion", "chorus_rate_hz")))
    if module == "dynamics":
        if not p.on("dynamics"):
            return x
        comp = dict(threshold_db=p.f("dynamics", "comp_threshold_db"), ratio=p.f("dynamics", "comp_ratio"),
                    attack_ms=p.f("dynamics", "comp_attack_ms"), release_ms=p.f("dynamics", "comp_release_ms"),
                    makeup_db=p.f("dynamics", "makeup_db"))
        ott = p.f("dynamics", "ott")
        return _on_span(x, sr, lambda s: DY.dynamics(s, sr, comp=comp, ott_params=dict(amount=ott) if ott > 0 else None))
    raise ValueError(module)


def stage_space(ctx: Ctx, p: Params, x: np.ndarray, plan: arr.PlacementPlan) -> tuple[np.ndarray, np.ndarray]:
    """Returns (dry + returns, returns only)."""
    s = to_stereo(x)
    if not p.on("space"):
        return s, np.zeros_like(s)
    sr = ctx.sr
    bpm = ctx.arrange.bpm
    sends: list[Callable[[], np.ndarray]] = []
    rv = p.f("space", "reverb_mix")
    _need_airwin(ctx, rv > 0 and str(p.get("space", "reverb_type")) == "galactic", "SPACE galactic reverb (a hall plays instead)")
    if rv > 0:
        sends.append(lambda: rv * SP.reverb_wet(s, sr, decay_s=p.f("space", "reverb_decay_s"), predelay_ms=p.f("space", "predelay_ms"),
                                                damping=p.f("space", "reverb_dark"), kind=str(p.get("space", "reverb_type"))))
    dl = p.f("space", "delay_mix")
    if dl > 0:
        sends.append(lambda: dl * SP.delay_wet(s, sr, time_s=note_seconds(str(p.get("space", "delay_div")), bpm),
                                               feedback=p.f("space", "delay_feedback"), pingpong=bool(p.get("space", "pingpong"))))
    th = p.f("space", "throw_send")
    # v0.1: exactly the *thrown* words when word timings exist, else the whole flagged segment
    spans = [(int(a * sr), int(b * sr) + int(0.03 * sr)) for pl in plan.placed for a, b in pl.throw_spans]
    if th > 0 and spans:
        sends.append(lambda: SP.throws_wet(s, sr, spans, time_s=note_seconds("1/4d", bpm), level_db=float(lin_to_db(th)) - 1.0,
                                           reverb_decay_s=max(2.5, p.f("space", "reverb_decay_s") * 1.5),
                                           damping=p.f("space", "reverb_dark")))
    swell = p.f("space", "swell_beats")
    if swell > 0:
        onset = int(round(plan.first_word_s * sr))
        length = swell * beat_seconds(bpm)
        if plan.first_word_s + 1e-6 < length:
            ctx.warnings.append(f"swell {swell:g} beats is longer than first_word_beat "
                                f"({ctx.arrange.first_word_beat:g}); it was cut at the file start")
        if onset > 0:
            sends.append(lambda: SP.reverse_swell(s, sr, onset, length_s=length, damping=p.f("space", "reverb_dark")))
    wet = np.zeros_like(s)
    for w in POOL.map(lambda f: f(), sends):  # the sends are independent: run them concurrently
        wet += w
    return s + wet, wet


def stage_stereo(ctx: Ctx, p: Params, x: np.ndarray) -> np.ndarray:
    if not p.on("stereo"):
        return to_stereo(x)
    return ST.stereo(x, ctx.sr, width=p.f("stereo", "width"), mono_below_hz=p.f("stereo", "mono_below_hz"))


# --------------------------------------------------------------------------- render


def _segments_out(plan: arr.PlacementPlan) -> list[Segment]:
    out = []
    for pl in plan.placed:
        flags = SegmentFlags()
        raw = pl.raw
        if raw is not None:
            fl = raw.get("flags") if isinstance(raw, dict) else getattr(raw, "flags", None)
            if isinstance(fl, SegmentFlags):
                flags = fl.model_copy()
            elif isinstance(fl, dict):
                flags = SegmentFlags(**fl)
        words = [Word(text=w.text, start_s=round(max(0.0, w.start_s), 5), end_s=round(max(0.0, w.end_s), 5), throw=w.throw)
                 for w in pl.words]
        out.append(Segment(index=pl.index, text=pl.text or None, start_s=round(max(0.0, pl.start_s), 5),
                           end_s=round(max(0.0, pl.end_s), 5), flags=flags, words=words))
    return out


RELEASE_S = 0.12  # the last word's own release
TAIL_FLOOR_DB = -30.0  # an FX tail may end once it is this far under the voice
MAX_TAIL_S = 6.0
THROW_FEEDBACK = 0.55  # SP.throws_wet: throws echo on a dotted quarter with this feedback


def tail_room_s(p: Params, bpm: float, segments: Sequence[Any] | None, tape_beats: float) -> float:
    """v0.4 ``auto_tail``: seconds to keep free after the last word for its release and the chain's FX tail --
    the reverb, the delay echoes, and the echoes of a thrown word near the end -- until each is TAIL_FLOOR_DB under
    the voice. A tape-stop ending needs none: it winds everything down (its beats are counted separately).
    Rounded up to 0.25 s, so small SPACE moves keep the cached plan."""
    if tape_beats > 0:
        return 0.0
    tail = RELEASE_S
    if p.on("space"):
        def echoes(level_db: float, feedback: float, period_s: float) -> float:
            if level_db <= TAIL_FLOOR_DB or period_s <= 0:
                return 0.0
            return (1.0 + (TAIL_FLOOR_DB - level_db) / (20.0 * math.log10(min(max(feedback, 1e-3), 0.99)))) * period_s

        rv = p.f("space", "reverb_mix")
        if rv > 0:
            tail = max(tail, max(0.0, float(lin_to_db(rv)) - TAIL_FLOOR_DB) / 60.0 * p.f("space", "reverb_decay_s"))
        dl = p.f("space", "delay_mix")
        if dl > 0:
            tail = max(tail, echoes(float(lin_to_db(dl)), p.f("space", "delay_feedback"),
                                    note_seconds(str(p.get("space", "delay_div")), bpm)))
        th = p.f("space", "throw_send")
        segs = [arr.seg_from(sg, i) for i, sg in enumerate(segments or [])]
        ends = [b for sg in segs for _, b in sg.throw_spans_src()]
        if th > 0 and ends:  # each echo of a thrown span ends one period later than the last
            lead = max(0.0, max(sg.end_s for sg in segs) - max(ends))
            tail = max(tail, echoes(float(lin_to_db(th)) - 1.0, THROW_FEEDBACK, note_seconds("1/4d", bpm)) - lead)
    return min(MAX_TAIL_S, math.ceil(tail / 0.25 - 1e-9) * 0.25)


def _motion(ctx: Ctx, p: Params, plan: arr.PlacementPlan, returns: np.ndarray, mix: np.ndarray, sr: int,
            feat: M.WorldFeatures | None, main_an: M.WorldAnalysis | None, bpm: float, tape_beats: float) -> dict:
    """``RenderOutput.motion`` (proposal 10) when the contract has the field, else nothing to attach."""
    if "motion" not in {f.name for f in dataclasses.fields(RenderOutput)}:
        return {}
    f0, period = None, 5.0
    if feat is not None:  # the voice's own pitch after the MASK pitch stage, breath and gate
        f0, period = feat.f0, feat.frame_period_ms
    elif main_an is not None:  # STFT preview: the analysis through the same pitch stage
        f0, period = main_an.f0, main_an.frame_period_ms
        if p.on("mask"):
            f0 = M.pitch_contour(f0, p.f("mask", "pitch_st"), str(p.get("mask", "pitch_mode")), p.f("mask", "monotone"),
                                 ctx.key)
    space = p.on("space")
    th = p.f("space", "throw_send") if space else 0.0
    data = MOT.compute(plan, returns=returns, mix=mix, sr=sr, f0=f0, frame_period_ms=period, bpm=bpm,
                       tape_beats=tape_beats, swell_beats=p.f("space", "swell_beats") if space else 0.0,
                       squelch=p.on("edit") and bool(p.get("edit", "squelch")),
                       throw_level_db=float(lin_to_db(th)) - 1.0 if th > 0 else None,
                       throw_period_s=note_seconds("1/4d", bpm))
    return {"motion": _MotionModel.model_validate(data) if _MotionModel is not None else data}


def _voice_out(plan: arr.PlacementPlan) -> float | None:
    """``tail_s`` (ruling, integration i1): the end of the last word on the output timeline, i.e. the rekordbox
    memory cue "VOICE OUT". Word timings when the source has them, else the last segment's end; clamped to the
    file; None when there is no speech."""
    ends = [max(w.end_s for w in pl.words) if pl.words else pl.end_s for pl in plan.placed if pl.end_s > pl.start_s]
    if not ends:
        return None
    return round(min(max(ends), plan.length_s), 5)


def _loudness(x: np.ndarray, sr: int, rep) -> Loudness:
    return Loudness(integrated_lufs=round(float(rep.integrated_lufs), 3), short_term_max_lufs=round(float(rep.short_term_max_lufs), 3),
                    true_peak_db=round(float(rep.true_peak_dbtp), 3), sample_peak_db=round(float(rep.sample_peak_dbfs), 3))


def render(main: Source, stack_src: list[Source | None], req: RenderRequest, chain: Chain) -> RenderOutput:
    """Render ``main`` (+ STACK sources) through the resolved ``chain`` onto the grid and master it."""
    t_all = time.perf_counter()
    quality = req.quality
    sr = ENGINE_SR if quality == "final" else PREVIEW_SR
    ctx = Ctx(sr=sr, quality=quality, key=parse_key(req.arrange.key), arrange=req.arrange, master=req.master,
              kind=main.info.kind)
    p = Params(chain)
    stack = list(req.stack or [])
    stack_src = list(stack_src or [])

    # --- sources
    t0 = time.perf_counter()
    main48 = source_audio48(main)
    gain = calibration_gain(main48, ENGINE_SR)
    main_an = None
    if p.on("mask") or any(s is None for s in stack_src[: len(stack)]) or len(stack_src) < len(stack):
        try:
            main_an = get_analysis(main48, main.info.kind, quality)
        except Exception as exc:  # never fail a render on analysis: the STFT path still works
            ctx.warnings.append(f"WORLD analysis failed ({exc}); MASK used the STFT path")
    src_key = stable_hash(audio_hash(main48, ENGINE_SR), [audio_hash(source_audio48(s), ENGINE_SR) if s is not None else None
                                                          for s in stack_src], sr, quality,
                          main_an.content_hash if main_an is not None else "no-world")
    ctx.timings["sources"] = round((time.perf_counter() - t0) * 1000.0, 2)

    # --- PREP + MASK
    k_mask = stable_hash("mask", src_key, p.module_params("prep"), p.module_params("mask"), ctx.key.name)
    voice, feat, engine = _timed(ctx, "mask", k_mask, lambda: stage_mask(ctx, p, main48, gain, main_an))
    if engine == "stft":
        ctx.warnings.append("MASK preview used the fast STFT path (pitch + formant only); final renders use WORLD.")

    # --- LAYERS
    k_layers = stable_hash("layers", k_mask, p.module_params("layers"), [s.model_dump() for s in stack],
                           p.module_params("mask") if stack else None)
    mix, layers_only = _timed(ctx, "layers", k_layers,
                              lambda: stage_layers(ctx, p, voice, feat, stack, stack_src, main, main48, main_an))

    # --- MACHINE
    k_machine = stable_hash("machine", k_layers, p.module_params("machine"), ctx.key.name)
    machined = _timed(ctx, "machine", k_machine, lambda: stage_machine(ctx, p, mix))

    # --- PLACE (arrange)
    a = req.arrange
    edit_on = p.on("edit")
    stut_div = str(p.get("edit", "stutter_div")) if edit_on else "off"
    stut_rep = int(round(p.f("edit", "stutter_repeats"))) if edit_on else 0
    tape_beats = p.f("edit", "tape_stop_beats") if edit_on else 0.0
    room = tail_room_s(p, a.bpm, main.info.segments, tape_beats) if getattr(a, "auto_tail", True) else 0.0
    snap = str(getattr(a, "snap_end", "off"))  # v0.4.1: land the last word on the grid
    arr_key = dict(bpm=a.bpm, bars=a.bars, fit=a.fit, max_stretch=a.max_stretch, beat_lock=a.beat_lock,
                   first_word_beat=a.first_word_beat, tail_beats=a.tail_beats, stut=(stut_div, stut_rep), tape=tape_beats,
                   room=room, snap=snap)
    # the plan (onset, chunks, stretch, beat-lock) comes from the dry voice, so it -- and the dry A/B master --
    # stay cached while MASK/LAYERS/FX knobs move
    dry_src = to_rate(main48 * gain, sr)
    k_plan = stable_hash("plan", src_key, arr_key, list(main.info.segments))

    def _plan():
        plan = arr.plan_placement(
            dry_src, sr, main.info.segments, bpm=a.bpm, bars=a.bars, fit_mode=a.fit, max_stretch=a.max_stretch,
            beat_lock=a.beat_lock, first_word_beat=a.first_word_beat, tail_beats=a.tail_beats,
            stutter_div=stut_div, stutter_repeats=stut_rep, tape_stop_beats=tape_beats, tail_room_s=room, snap_end=snap,
        )
        return plan, arr.apply_placement(plan, dry_src, quality == "final")

    plan, dry_tl = _timed(ctx, "plan", k_plan, _plan)
    k_place = stable_hash("place", k_machine, k_plan, bool(req.stems))

    # --- master settings are known now: start the dry A/B master in the background (it only needs the plan)
    m = req.master
    sr_out = int(m.sample_rate)
    n_out = int(round(plan.length_s * sr_out))
    n_rack = arr.rack_samples_for(n_out, sr_out, sr)
    mono_below = p.f("stereo", "mono_below_hz") if p.on("stereo") else None
    mkw = dict(mode=m.mode, target_lufs=m.target_lufs, ceiling_dbtp=m.true_peak_db, bake_peak_dbfs=m.bake_peak_db,
               sr_out=sr_out, n_out=n_out, fade_in_ms=a.fade_in_ms, fade_out_ms=a.fade_out_ms, channels=m.channels,
               quality=quality, mono_below_hz=mono_below or None)
    # the dry A/B is mastered to the same target / ceiling as the wet (level-matched, delivery-safe)
    k_dry = stable_hash("dry", k_plan, m.model_dump(), a.fade_in_ms, a.fade_out_ms, n_rack, mono_below)
    dry_hit = STAGES.get(k_dry)
    dry_future = None
    if dry_hit is None:
        def _dry_job() -> np.ndarray:
            d = fit_length(to_stereo(dry_tl), n_rack) if m.channels == 2 else fit_length(dry_tl, n_rack)
            dm, _ = run_master(d, sr, **mkw)
            STAGES.put(k_dry, dm)
            return dm

        dry_future = POOL.submit(_dry_job)

    def _place():
        hq = quality == "final"
        wet = arr.apply_placement(plan, machined, hq)
        stems = None
        if req.stems:
            stems = {"voice": arr.apply_placement(plan, to_stereo(voice), hq),
                     "layers": arr.apply_placement(plan, layers_only, hq)}
        return wet, stems

    placed, stem_tl = _timed(ctx, "place", k_place, _place)
    if plan.fit.status == "extended":  # v0.4: the phrase + tail outgrew the requested bars; nothing was cut
        ctx.warnings.append(plan.fit.message)

    # --- inserts
    x, k = placed, k_place
    for module in ("drive", "crush", "tone", "motion", "dynamics"):
        extra = p.module_params("edit") if module == "crush" else None
        k = stable_hash(module, k, p.module_params(module), extra)
        x = _timed(ctx, module, k, lambda m=module, xin=x: stage_inserts(ctx, p, m, xin, plan))

    # --- SPACE, STEREO
    k = stable_hash("space", k, p.module_params("space"))
    spaced, returns = _timed(ctx, "space", k, lambda xin=x: stage_space(ctx, p, xin, plan))
    k = stable_hash("stereo", k, p.module_params("stereo"))
    st = _timed(ctx, "stereo", k, lambda: stage_stereo(ctx, p, spaced))

    # --- FINISH (tape stop) + MASTER
    k = stable_hash("finish", k, tape_beats, n_rack)

    def _finish():
        y = st
        if tape_beats > 0:
            y = arr.tape_stop(y, sr, plan.speech_end_s, tape_beats, a.bpm)
        return fit_length(y, n_rack)

    finished = _timed(ctx, "finish", k, _finish)
    k = stable_hash("master", k, m.model_dump(), a.fade_in_ms, a.fade_out_ms)
    hint = stable_hash("hint", k_plan, m.model_dump(), quality, "wet")
    out, rep = _timed(ctx, "master", k, lambda: run_master(finished, sr, **mkw, hint_key=hint))

    # --- dry A/B: collect the background master (only the time spent waiting shows up here)
    t0 = time.perf_counter()
    dry_out = dry_hit if dry_hit is not None else dry_future.result()
    ctx.timings["dry"] = round((time.perf_counter() - t0) * 1000.0, 2)

    stems: dict[str, np.ndarray] = {}
    if req.stems:
        raw = {"voice": stem_tl["voice"], "layers": stem_tl["layers"], "fx": returns}
        conv = {kk: fit_length(resample(to_stereo(v) if m.channels == 2 else to_mono(v), sr, sr_out), n_out)
                for kk, v in raw.items()}
        pk = max(float(np.max(np.abs(v))) for v in conv.values()) if conv else 0.0
        g = db_to_lin(-1.0) / pk if pk > EPS else 1.0
        stems = {kk: (v * g).astype(np.float32) for kk, v in conv.items()}
        stems["dry"] = dry_out

    fit = plan.fit
    fit_report = FitReport(status=fit.status, speech_s=round(fit.speech_s, 4), available_s=round(fit.available_s, 4),
                           total_s=round(fit.total_s, 4), stretch_ratio=round(fit.stretch_ratio, 4),
                           suggested_bars=fit.suggested_bars, message=fit.message,
                           reserved_tail_s=round(fit.reserved_tail_s, 4))
    stack_is_tts = [(stack_src[i] is not None and stack_src[i].info.kind == "tts") if i < len(stack_src) else False
                    for i in range(len(stack))]
    ms = mask_strength(main.info.kind, chain, stack, stack_is_tts)
    ctx.timings["total"] = round((time.perf_counter() - t_all) * 1000.0, 2)
    ctx.timings["rack_sr"] = float(sr)
    warnings = list(dict.fromkeys(ctx.warnings + plan.notes))
    extra = _motion(ctx, p, plan, returns, spaced, sr, feat, main_an, a.bpm, tape_beats)
    return RenderOutput(
        audio=np.ascontiguousarray(out, dtype=np.float32), dry=np.ascontiguousarray(dry_out, dtype=np.float32),
        sample_rate=sr_out, segments=_segments_out(plan), fit=fit_report, loudness=_loudness(out, sr_out, rep), mask=ms,
        resolved_chain=chain, first_word_s=round(plan.first_word_s, 5), tail_s=_voice_out(plan),
        stems=stems, timings_ms=ctx.timings, warnings=warnings,
        bars=None if fit.status == "free" else int(round(fit.bars)), **extra,
    )
