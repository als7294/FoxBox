"""Mask-strength badge: how hard the resolved chain makes it to recover the speaker.

Heuristic, never forensic. A single global pitch shift is reversible (re-pitch it back), so a pitch-only
chain is WEAK. Points come from transforms that re-pitching cannot undo: independent formant shift,
McAdams warping, flattened intonation, whisper, vocoder excitation, inharmonic ring/shift, nonlinear drive,
codec damage and layers at other pitches. TTS sources are SYNTHETIC: no biometric voice is present.
"""

from __future__ import annotations

from typing import Sequence

from fvwks_contracts.models import Chain, MaskStrength, StackVoice

from .rack_spec import OFF_DB, SPECS

STRONG = 6.0
MEDIUM = 3.0


def _getter(chain: Chain):
    mods = {m.id: m for m in chain.modules}

    def g(module: str, param: str):
        spec = SPECS.get(module, {}).get(param)
        default = spec.default if spec is not None else None
        m = mods.get(module)
        if m is None or not m.enabled:
            return None
        return m.params.get(param, default)

    def f(module: str, param: str, off: float) -> float:
        v = g(module, param)
        try:
            return float(v) if v is not None else off
        except (TypeError, ValueError):
            return off

    return g, f


def score_chain(chain: Chain, stack: Sequence[StackVoice] = (), stack_is_tts: Sequence[bool] = ()) -> tuple[float, list[str]]:
    g, f = _getter(chain)
    score, reasons = 0.0, []
    pitch = f("mask", "pitch_st", 0.0)
    formant = f("mask", "formant_st", 0.0)
    if abs(formant) >= 2.0:
        if abs(formant - pitch) < 1.0:
            score += 1
            reasons.append(f"Formant {formant:+.1f} st moves with pitch (varispeed-like, partly reversible)")
        elif abs(formant) >= 5.0:
            score += 3
            reasons.append(f"Formant {formant:+.1f} st, independent of pitch")
        else:
            score += 2
            reasons.append(f"Formant {formant:+.1f} st, independent of pitch")
    alpha = f("mask", "mcadams", 1.0)
    if alpha <= 0.8:
        score += 3
        reasons.append(f"McAdams α {alpha:.2f} warps formants non-linearly")
    elif alpha <= 0.9:
        score += 2
        reasons.append(f"McAdams α {alpha:.2f}")
    flat = f("mask", "monotone", 0.0)
    mode = g("mask", "pitch_mode")
    if flat >= 0.5 or (mode == "scale" and g("mask", "pitch_st") is not None):
        score += 2
        reasons.append("Flattened / quantized intonation hides your prosody")
    elif flat >= 0.25:
        score += 1
        reasons.append("Partly flattened intonation")
    breath = f("mask", "breath", 0.0)
    if breath >= 0.7:
        score += 2
        reasons.append("Whisper removes your pitch")
    if f("mask", "growl", 0.0) >= 0.4:
        score += 1
        reasons.append("Growl adds subharmonics and roughness")
    voc = f("machine", "vocoder_mix", 0.0)
    kind = "Talkbox" if g("machine", "vocoder_mode") == "talkbox" else "Vocoder"
    if voc >= 0.5:
        score += 3
        reasons.append(f"{kind} replaces your vocal excitation")
    elif voc >= 0.1:
        score += 1
        reasons.append(f"{kind} blend")
    ring = f("machine", "ring_mix", 0.0)
    shift = f("machine", "shift_mix", 0.0) if abs(f("machine", "shift_hz", 0.0)) >= 50 else 0.0
    if ring >= 0.2 or shift >= 0.2:
        score += 1
        reasons.append("Inharmonic ring mod / frequency shift (re-pitching cannot undo it)")
    color = g("drive", "color")
    colored = color in ("tape", "tube") and f("drive", "color_drive", 0.0) >= 0.5
    clip = f("drive", "drive_db", 0.0) if f("drive", "mix", 0.0) >= 0.3 else 0.0
    if clip >= 12.0 or (colored and (clip >= 6.0 or f("drive", "color_drive", 0.0) >= 0.8)):
        score += 1
        reasons.append(f"Nonlinear drive ({color} into clip)" if colored and clip < 12.0 else "Nonlinear drive")
    codec = g("crush", "codec")
    if ((codec not in (None, "none")) or f("crush", "bits", 24.0) <= 10 or f("crush", "rate_hz", 48000.0) <= 16000
            or f("crush", "derez", 0.0) >= 0.3):
        score += 1
        reasons.append("Codec / crush destroys fine detail")
    layered = f("layers", "sub_gain_db", OFF_DB) >= -16.0 or f("layers", "ghost_gain_db", OFF_DB) >= -20.0
    tts_stack = False
    for i, sv in enumerate(stack or []):
        if sv.gain_db < -18.0:
            continue
        is_tts = stack_is_tts[i] if i < len(stack_is_tts) else sv.voice_id is not None
        if is_tts:
            tts_stack = True
        elif abs(sv.pitch_st - pitch) >= 2.0:
            layered = True
    if layered:
        score += 1
        reasons.append("Layers at other pitches (one re-pitch cannot undo them all)")
    if tts_stack:
        score += 1
        reasons.append("TTS voices stacked over yours")
    if score == 0 and abs(pitch) > 0:
        reasons.append("Pitch-only: re-pitching reverses it")
    if not reasons:
        reasons.append("No mask applied")
    return score, reasons


def mask_strength(kind: str, chain: Chain, stack: Sequence[StackVoice] = (),
                  stack_is_tts: Sequence[bool] = ()) -> MaskStrength:
    score, reasons = score_chain(chain, stack, stack_is_tts)
    if kind == "tts":
        level = "strong" if score >= STRONG else "medium" if score >= MEDIUM else "weak"
        return MaskStrength(level="synthetic", score=score,
                            reasons=["Synthetic TTS voice: no biometric voice present.",
                                     f"On a recording this chain would score {level.upper()}."])
    level = "strong" if score >= STRONG else "medium" if score >= MEDIUM else "weak"
    return MaskStrength(level=level, score=score, reasons=reasons)
