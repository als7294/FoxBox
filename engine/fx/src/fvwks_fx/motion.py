"""Voice-core motion data (contracts proposal 10, ``RenderInfo.motion``, approved by the user): the arrange plan's
events plus two 50 fps tracks, the SPACE returns level and the output pitch, so the app can move the voice core with
the sound without analysing audio. Additive: the pipeline attaches it once the contract has the field.
"""

from __future__ import annotations

import base64
import math
from typing import Any

import numpy as np

from .arrange import PlacementPlan

FPS = 50
FLOOR_DB = -60.0  # track levels: FLOOR_DB .. 0 dB -> 0 .. 255
ECHO_FLOOR_DB = -30.0  # throw echoes quieter than this aren't events (the v0.4 tail-room floor)
SQUELCH_S = 0.09  # CRUSH squelch bursts (crush.noise_bed): 90 ms at the edges of the bed


def n_frames(length_s: float, fps: int = FPS) -> int:
    return max(1, math.ceil(length_s * fps - 1e-9))


def _b64(a: np.ndarray) -> str:
    return base64.b64encode(np.asarray(a, dtype=np.uint8).tobytes()).decode("ascii")


def events(plan: PlacementPlan, *, bpm: float, tape_beats: float = 0.0, swell_beats: float = 0.0, squelch: bool = False,
           throw_level_db: float | None = None, throw_period_s: float = 0.0, throw_feedback: float = 0.55,
           bed: tuple[float, float] | None = None) -> list[dict[str, Any]]:
    """Exact output-timeline events from the plan, sorted: Beat-Locked chunk onsets, stutter slices, the tape-stop,
    the reverse swell into the first word, each audible echo of a thrown span, the squelch bursts (at the edges of
    ``bed``, the CRUSH bed's span as the pipeline placed it; by default where an untightened bed would sit)."""
    beat = 60.0 / bpm
    ev: list[tuple[str, float, float]] = []
    for i, (c, st) in enumerate(zip(plan.chunks, plan.starts_s)):
        if c.lock:  # Beat-Locked chunks, and every v0.8 chop piece
            ev.append(("beat_lock", st, (c.speech_end - c.src0) / plan.sr / plan.chunk_factor(i)))
    if plan.stutter:
        at, sl, n = plan.stutter
        ev += [("stutter", at + i * sl, sl) for i in range(n)]
    if tape_beats > 0:
        ev.append(("tape_stop", plan.speech_end_s, tape_beats * beat))
    if swell_beats > 0 and plan.first_word_s > 0:
        t0 = max(0.0, plan.first_word_s - swell_beats * beat)
        ev.append(("swell", t0, plan.first_word_s - t0))
    if throw_level_db is not None and throw_period_s > 0:
        per_db = 20.0 * math.log10(min(max(throw_feedback, 1e-3), 0.99))
        for pl in plan.placed:
            for a, b in pl.throw_spans:
                k = 1
                while throw_level_db + per_db * (k - 1) > ECHO_FLOOR_DB:
                    ev.append(("throw_echo", a + k * throw_period_s, b - a))
                    k += 1
    if squelch:
        start, end = bed or (max(0.0, plan.first_word_s - 0.12), min(plan.length_s, plan.speech_end_s + 0.25))
        ev += [("squelch", start, SQUELCH_S), ("squelch", max(start, end - SQUELCH_S), SQUELCH_S)]
    length = plan.length_s
    return [{"t": round(t, 4), "dur": round(max(0.0, min(d, length - t)), 4), "kind": k}
            for k, t, d in sorted(ev, key=lambda e: (e[1], e[0])) if 0.0 <= t < length]


def _frame_rms(x: np.ndarray, sr: int, frames: int, fps: int) -> np.ndarray:
    a = np.atleast_2d(np.asarray(x, dtype=np.float32))
    hop = sr / fps
    if float(hop).is_integer():  # every rack rate: frames are whole blocks
        h = int(hop)
        n = min(a.shape[1], frames * h)
        power = np.zeros(frames * h, np.float32)
        power[:n] = np.einsum("cn,cn->n", a[:, :n], a[:, :n]) / a.shape[0]
        return np.sqrt(power.reshape(frames, h).mean(axis=1, dtype=np.float64))
    power = np.einsum("cn,cn->n", a, a).astype(np.float64) / a.shape[0]
    idx = (np.arange(power.size) * fps / sr).astype(np.int64)
    keep = idx < frames
    sums = np.bincount(idx[keep], weights=power[keep], minlength=frames)
    return np.sqrt(sums / np.maximum(np.bincount(idx[keep], minlength=frames), 1))


def level_track(x: np.ndarray, ref: np.ndarray, sr: int, frames: int, fps: int = FPS) -> str:
    """Per-frame RMS of ``x`` in dB re the loudest frame of ``ref``, FLOOR_DB..0 dB as 0..255 (base64)."""
    top = max(float(_frame_rms(ref, sr, frames, fps).max()), 1e-12)
    db = 20.0 * np.log10(np.maximum(_frame_rms(x, sr, frames, fps), 1e-12) / top)
    return _b64(np.round(np.clip((db - FLOOR_DB) / -FLOOR_DB * 255.0, 0.0, 255.0)))


def pitch_track(plan: PlacementPlan, f0: np.ndarray, frame_period_ms: float, frames: int, fps: int = FPS) -> str:
    """Output pitch per frame as MIDI note x 2 (0 = unvoiced; base64). ``f0`` is on the source timeline, after the
    MASK pitch stage; it is mapped through the plan: stutter slices, chunk starts, stretch."""
    t = (np.arange(frames) + 0.5) / fps
    if plan.stutter:
        at, sl, n = plan.stutter
        head = at + sl * (n - 1)  # the phrase itself starts here; the slices in front repeat its first slice
        t = np.where((t >= at) & (t < head), head + np.mod(t - at, sl), t)
    src = np.full(frames, -1.0)
    for i, (c, st) in enumerate(zip(plan.chunks, plan.starts_s)):
        f = plan.chunk_factor(i)
        dur = (c.src1 - c.src0) / plan.sr / f
        m = (t >= st) & (t < st + dur)
        src[m] = c.src0 / plan.sr + (t[m] - st) * f
    hz = np.zeros(frames)
    ok = src >= 0
    if np.any(ok) and f0.size:
        hz[ok] = f0[np.clip(np.round(src[ok] * 1000.0 / frame_period_ms).astype(np.int64), 0, f0.size - 1)]
    midi2 = np.where(hz > 0, 2.0 * (69.0 + 12.0 * np.log2(np.maximum(hz, 1e-9) / 440.0)), 0.0)
    return _b64(np.where(hz > 0, np.clip(np.round(midi2), 1, 255), 0))


def compute(plan: PlacementPlan, *, returns: np.ndarray, mix: np.ndarray, sr: int, f0: np.ndarray | None,
            frame_period_ms: float, bpm: float, tape_beats: float = 0.0, swell_beats: float = 0.0,
            squelch: bool = False, throw_level_db: float | None = None, throw_period_s: float = 0.0,
            bed: tuple[float, float] | None = None) -> dict[str, Any]:
    """The ``Motion`` payload (proposal 10) for one render."""
    frames = n_frames(plan.length_s)
    return {
        "fps": FPS,
        "events": events(plan, bpm=bpm, tape_beats=tape_beats, swell_beats=swell_beats, squelch=squelch,
                         throw_level_db=throw_level_db, throw_period_s=throw_period_s, bed=bed),
        "returns": level_track(returns, mix, sr, frames),
        "f0": pitch_track(plan, f0, frame_period_ms, frames) if f0 is not None else _b64(np.zeros(frames)),
    }
