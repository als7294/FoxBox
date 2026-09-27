"""LAYERS: SUB (-12 st), GHOST (+12 st whisper) and STACK (extra TTS voices aligned per segment).

STACK alignment works on WORLD frames: for every primary segment, the stack voice's matching segment
is time-mapped (frame-interpolated) onto the primary segment's span, word by word through the word boundaries
when both segments carry the same words (TTS v0.1 word timings), else linearly. Then pitch/formant are
applied and the whole voice is synthesized once. A Rubber Band (pedalboard.time_stretch) path, segment-linear,
is the fallback when no WORLD analysis is available.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Sequence

import numpy as np
import pedalboard
from scipy import signal

from ..dsp import EPS, active_rms, as2d, db_to_lin, fit_length, highpass, lowpass, pan_gains, to_mono
from ..music import Key, parse_key
from .mask import (
    WorldAnalysis,
    WorldFeatures,
    band_slice,
    bins_for,
    breathe,
    jitter,
    mcadams_envelope,
    pitch_contour,
    render_features,
    warp_envelope,
    world_synth,
)


@dataclass(frozen=True)
class Span:
    start_s: float
    end_s: float
    knots: tuple[float, ...] = ()  # interior word boundaries (source s): the middle of each gap between words
    words: tuple[str, ...] = ()  # normalized word texts, to check two segments say the same words


MAX_WORD_WARP = 3.0  # a word piece may run at most 3x faster/slower than its segment's average map (else linear)


def _get(obj: Any, key: str) -> Any:
    return obj.get(key) if isinstance(obj, dict) else getattr(obj, key, None)


def _word_knots(words: Sequence[Any], a: float, b: float) -> tuple[tuple[float, ...], tuple[str, ...]]:
    """Middle of each gap between consecutive words, strictly increasing inside (a, b), else none. The first word's
    start and the last word's end are left out: TTS word edges next to silence are the least reliable timings."""
    if len(words) < 2:
        return (), ()
    knots = tuple(0.5 * (float(_get(w0, "end_s")) + float(_get(w1, "start_s"))) for w0, w1 in zip(words, words[1:]))
    edges = (a, *knots, b)
    if any(t1 <= t0 for t0, t1 in zip(edges, edges[1:])):
        return (), ()
    return knots, tuple("".join(ch for ch in str(_get(w, "text") or "").lower() if ch.isalnum()) for w in words)


def spans_of(segments: Sequence[Any] | None) -> list[Span]:
    """Duck-typed segments (objects or dicts with start_s/end_s, optional words) -> sorted spans."""
    out: list[Span] = []
    for s in segments or []:
        a, b = _get(s, "start_s"), _get(s, "end_s")
        if a is None or b is None or b <= a:
            continue
        out.append(Span(float(a), float(b), *_word_knots(_get(s, "words") or [], float(a), float(b))))
    return sorted(out, key=lambda sp: sp.start_s)


# --------------------------------------------------------------------------- SUB / GHOST


def sub_layer(feat: WorldFeatures, st: float = -12.0, formant_st: float = -3.0, lpf_hz: float = 2500.0,
              out_sr: int | None = None) -> np.ndarray:
    """Octave(-ish) below the masked voice with its own formant offset. Synthesized at 12 kHz (the layer is
    low-passed at ``lpf_hz`` anyway) and upsampled. Mono float32 at ``out_sr``."""
    sr = feat.sr if out_sr is None else int(out_sr)
    low_sr = feat.sr // 4 if feat.sr % 4 == 0 else sr
    ratio = 2.0 ** (formant_st / 12.0)
    bins = bins_for(feat.fft_size, feat.sr, low_sr, min(ratio, 1.0))
    sp = feat.sp[:, :bins]
    sp = warp_envelope(sp, ratio) if formant_st else sp
    f = WorldFeatures(feat.f0 * 2.0 ** (st / 12.0), sp, feat.ap[:, :bins], feat.sr, feat.frame_period_ms,
                      feat.n_samples, dict(feat.meta), feat.fft_size)
    y = render_features(f, growl=0.0, out_sr=low_sr)
    if low_sr != sr:
        y = signal.resample_poly(y, sr // low_sr, 1)[: int(round(feat.n_samples * sr / feat.sr))]
    if lpf_hz:
        y = lowpass(y, sr, lpf_hz, order=4)[0]
    return np.asarray(y, dtype=np.float32).reshape(-1)


def ghost_layer(feat: WorldFeatures, st: float = 12.0, breath: float = 0.9, hpf_hz: float = 700.0,
                formant_st: float = 3.0, out_sr: int | None = None) -> np.ndarray:
    """An airy pitched-up whisper double of the masked voice. Mono float32 at ``out_sr``."""
    sr = feat.sr if out_sr is None else int(out_sr)
    ratio = 2.0 ** (formant_st / 12.0)
    bins = bins_for(feat.fft_size, feat.sr, sr, min(ratio, 1.0))
    f0, ap = breathe(feat.f0 * 2.0 ** (st / 12.0), feat.ap[:, :bins], breath)
    sp = warp_envelope(feat.sp[:, :bins], ratio) if formant_st else feat.sp[:, :bins]
    y = world_synth(WorldFeatures(f0, sp, ap, feat.sr, feat.frame_period_ms, feat.n_samples, fft_n=feat.fft_size), sr)
    if hpf_hz:
        y = highpass(y, sr, hpf_hz, order=2)[0]
    return y.astype(np.float32)


# --------------------------------------------------------------------------- STACK


def word_map(p: Span, s: Span) -> tuple[np.ndarray, np.ndarray] | None:
    """Piecewise-linear time map (primary s -> stack s) through the word boundaries, when both segments say the
    same words and no piece warps more than ``MAX_WORD_WARP`` against the segment's average map. None -> linear."""
    if not p.knots or len(p.knots) != len(s.knots) or p.words != s.words:
        return None
    xs = np.array([p.start_s, *p.knots, p.end_s])
    ys = np.array([s.start_s, *s.knots, s.end_s])
    warp = (np.diff(ys) / np.diff(xs)) / ((s.end_s - s.start_s) / (p.end_s - p.start_s))
    if np.any(warp > MAX_WORD_WARP) or np.any(warp < 1.0 / MAX_WORD_WARP):
        return None
    return xs, ys


def align_frame_map(n_frames_out: int, frame_period_ms: float, primary: Sequence[Span], stack: Sequence[Span],
                    n_frames_src: int) -> np.ndarray:
    """Fractional source-frame index for each output frame (-1 = silence). Each stack segment is mapped onto its
    primary segment word by word when both carry matching word timings (see ``word_map``), else linearly."""
    fp = frame_period_ms / 1000.0
    idx = np.full(n_frames_out, -1.0)
    if not primary or not stack:
        return idx
    if len(primary) != len(stack):
        primary = [Span(primary[0].start_s, primary[-1].end_s)]
        stack = [Span(stack[0].start_s, stack[-1].end_s)]
    for p, s in zip(primary, stack):
        p0, p1 = int(round(p.start_s / fp)), int(round(p.end_s / fp))
        s0, s1 = s.start_s / fp, s.end_s / fp
        p1 = min(p1, n_frames_out)
        if p1 <= p0:
            continue
        j = np.arange(p0, p1)
        wm = word_map(p, s)
        if wm is None:
            idx[j] = s0 + (j - p0) * (s1 - s0) / max(p1 - p0, 1)
        else:
            idx[j] = np.interp(j * fp, wm[0], wm[1]) / fp
    idx[idx > n_frames_src - 1] = n_frames_src - 1
    return idx


def gather_frames(a: WorldAnalysis, idx: np.ndarray, n_samples: int) -> WorldFeatures:
    """Resample WORLD frames at fractional indices (log-envelope interpolation)."""
    silent = idx < 0
    i = np.clip(idx, 0, a.n_frames - 1)
    i0 = np.floor(i).astype(np.int64)
    i1 = np.minimum(i0 + 1, a.n_frames - 1)
    w = (i - i0)
    f0a, f0b = a.f0[i0], a.f0[i1]
    both = (f0a > 0) & (f0b > 0)
    f0 = np.where(both, f0a * (1 - w) + f0b * w, np.where(w < 0.5, f0a, f0b))
    # linear-power interpolation between neighbouring 5 ms frames (log-domain costs 2 transcendental ops per bin)
    sp = a.sp[i0] * (1 - w)[:, None] + a.sp[i1] * w[:, None]
    ap = a.ap[i0] * (1 - w)[:, None] + a.ap[i1] * w[:, None]
    f0[silent] = 0.0
    sp[silent] = 1e-16
    ap[silent] = 1.0
    return WorldFeatures(f0, sp, ap, a.sr, a.frame_period_ms, n_samples)


def stack_voice_world(
    a: WorldAnalysis,
    primary_segments: Sequence[Any],
    stack_segments: Sequence[Any],
    n_samples: int,
    *,
    pitch_st: float = 0.0,
    formant_st: float = 0.0,
    pitch_mode: str = "natural",
    monotone: float = 0.0,
    key: str | Key | None = "Am",
    mcadams: float = 1.0,
    breath: float = 0.0,
    jitter_amount: float = 0.0,
    seed: int = 0,
    out_sr: int | None = None,
) -> np.ndarray:
    """One stack voice time-aligned to the primary's segments, pitched/formanted.

    ``n_samples`` is the primary's length at the analysis rate. Mono float32 at ``out_sr``."""
    fp = a.frame_period_ms
    n_frames_out = int(n_samples / a.sr * 1000.0 / fp) + 1
    prim, stk = spans_of(primary_segments), spans_of(stack_segments)
    if not prim:
        prim = [Span(0.0, n_samples / a.sr)]
    if not stk:
        stk = [Span(0.0, a.n_samples / a.sr)]
    idx = align_frame_map(n_frames_out, fp, prim, stk, a.n_frames)
    fft_n = a.fft_size
    ratio = 2.0 ** (formant_st / 12.0)
    if out_sr and out_sr < a.sr:
        a = band_slice(a, bins_for(fft_n, a.sr, out_sr, min(ratio, 1.0)))
    feat = gather_frames(a, idx, n_samples)
    feat.fft_n = fft_n
    k = key if isinstance(key, Key) else parse_key(key)
    feat.f0 = pitch_contour(feat.f0, pitch_st, pitch_mode, monotone, k)
    if formant_st:
        feat.sp = warp_envelope(feat.sp, ratio)
    if mcadams and abs(mcadams - 1.0) > 1e-4:
        feat.sp = mcadams_envelope(feat.sp, a.sr, mcadams, fft_size=fft_n)
    if jitter_amount > 0:
        feat.f0 = jitter(feat.f0, jitter_amount, seed)
    feat.f0, feat.ap = breathe(feat.f0, feat.ap, breath)
    return world_synth(feat, out_sr)


def stack_voice_stretch(
    x: np.ndarray,
    sr: int,
    primary_segments: Sequence[Any],
    stack_segments: Sequence[Any],
    n_samples: int,
    *,
    pitch_st: float = 0.0,
    **_ignored: Any,
) -> np.ndarray:
    """Preview fallback: Rubber Band stretch of each stack segment onto the primary span."""
    mono = to_mono(x)[0]
    prim, stk = spans_of(primary_segments), spans_of(stack_segments)
    if not prim:
        prim = [Span(0.0, n_samples / sr)]
    if not stk:
        stk = [Span(0.0, mono.size / sr)]
    if len(prim) != len(stk):
        prim = [Span(prim[0].start_s, prim[-1].end_s)]
        stk = [Span(stk[0].start_s, stk[-1].end_s)]
    out = np.zeros(n_samples, np.float32)
    for p, s in zip(prim, stk):
        a0, a1 = int(p.start_s * sr), min(int(p.end_s * sr), n_samples)
        b0, b1 = int(s.start_s * sr), min(int(s.end_s * sr), mono.size)
        if a1 - a0 < 64 or b1 - b0 < 64:
            continue
        seg = mono[b0:b1][None, :].astype(np.float32)
        y = pedalboard.time_stretch(seg, float(sr), stretch_factor=float((b1 - b0) / (a1 - a0)),
                                    pitch_shift_in_semitones=float(pitch_st), high_quality=False)
        y = fit_length(y, a1 - a0)[0]
        out[a0:a1] += y
    return out


# --------------------------------------------------------------------------- mixing


@dataclass
class LayerPart:
    audio: np.ndarray  # mono [n]
    gain_db: float = 0.0
    pan: float = 0.0  # -1..1
    normalize_to_main: bool = True


def mix_layers(main: np.ndarray, parts: Sequence[LayerPart], sr: int) -> np.ndarray:
    """Main voice centred at unity, each part level-matched to the main then offset by ``gain_db``
    and panned (constant power, centre = unity). Returns stereo ``[2, n]`` float32."""
    m = to_mono(main)[0]
    n = m.size
    out = np.stack([m, m]).astype(np.float64)
    ref = active_rms(m[None, :], sr)
    for p in parts:
        y = np.asarray(p.audio, dtype=np.float64).reshape(-1)
        if y.size != n:
            y = fit_length(y[None, :], n)[0].astype(np.float64)
        if p.normalize_to_main:
            cur = active_rms(y[None, :], sr)
            if cur > EPS and ref > EPS:
                y = y * (ref / cur)
        g = db_to_lin(p.gain_db)
        gl, gr = pan_gains(p.pan)
        out[0] += y * g * gl
        out[1] += y * g * gr
    return as2d(out.astype(np.float32))
