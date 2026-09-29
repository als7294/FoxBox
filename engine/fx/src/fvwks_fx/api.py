"""fvwks_fx public seam (implements ``fvwks_contracts.seam.FxAPI`` as module-level functions).

- ``rack_schema()``: the runtime rack descriptor (GET /api/rack).
- ``list_presets()``: the 7 factory presets (validated against the rack by the contract tests).
- ``resolve(chain, macros, macro_map)``: macro interpolation between each target's min (macro 0) and max
  (macro 1), clamped to the rack's ranges, with every module listed in rack order and defaults filled in.
- ``analyze(source)``: warms the per-source WORLD analysis cache (called in a background job after TTS).
- ``render(main, stack, req)``: the full rack -> arrange -> master pipeline (see ``pipeline.py``).
- v0.7 songs (``song.py``): ``analyze_song(audio, sr)`` (tempo, key, bar 1) and ``mix_song(...)`` (the drop in the
  song: duck, gains, true-peak limit, excerpt).
- v0.9 ``stem_features(stems, sr, mix, analysis=, fps=)`` (``stems.py``): per-stem envelopes and onsets for the visuals.
- v0.10 ``song_structure(audio, sr, analysis, stems=)`` (``structure.py``): sections, drops, builds, phrases, energy.
"""

from __future__ import annotations

import json
import math
from functools import lru_cache
from importlib import resources

from fvwks_contracts.models import (
    Chain,
    MacroMap,
    Macros,
    MaskStrength,
    ModuleState,
    Preset,
    RackDescriptor,
    RenderRequest,
)
from fvwks_contracts.seam import RenderOutput, Source

from . import pipeline
from .maskscore import mask_strength as _mask_strength
from .modules import mask as _mask
from .rack_spec import ORDER, RACK_VERSION, SPECS, rack_descriptor
from .remix.groove import extract_groove as bass_groove  # v0.11.1 FxAPI.bass_groove (half_time: the server's, from the section)
from .remix.mash import features as mash_features, mash_scan  # v0.11.3 FxAPI.mash_features / mash_scan
from .song import analyze_song, mix_song
from .stems import stem_features
from .structure import song_structure

ENGINE_NAME = "fvwks-rack"
# v0.2 AUTO bars: plan_placement resolves Arrange.bars == "auto" on the arranged natural length (Beat-Lock gaps,
# [Nb] at the render tempo, stutter / tape-stop growth) and RenderOutput.bars reports the count. Activates
# engine/contracts/tests/test_auto_bars.py::test_engine_resolves_auto_bars.
AUTO_BARS = True
__all__ = ["ENGINE_NAME", "RACK_VERSION", "rack_schema", "list_presets", "get_preset", "resolve", "analyze", "render",
           "mask_strength", "apply_hints", "analyze_song", "mix_song", "stem_features", "song_structure"]

PRESET_ORDER = ["pact", "legion", "abyss", "unit", "ghost", "signal", "raw"]


def rack_schema() -> RackDescriptor:
    return rack_descriptor()


@lru_cache(maxsize=1)
def _load_presets() -> tuple[Preset, ...]:
    out = []
    for entry in resources.files("fvwks_fx.presets").iterdir():
        if entry.name.endswith(".json"):
            out.append(Preset.model_validate(json.loads(entry.read_text())))
    return tuple(sorted(out, key=lambda p: PRESET_ORDER.index(p.id) if p.id in PRESET_ORDER else 99))


def list_presets() -> list[Preset]:
    return [p.model_copy(deep=True) for p in _load_presets()]


def get_preset(preset_id: str) -> Preset | None:
    for p in _load_presets():
        if p.id == preset_id:
            return p.model_copy(deep=True)
    return None


def _interp(lo: float, hi: float, m: float, curve: str) -> float:
    m = min(max(float(m), 0.0), 1.0)
    if curve == "exp" and lo > 0 and hi > 0:
        return lo * (hi / lo) ** m
    if curve == "log":
        return lo + (hi - lo) * math.log1p(9 * m) / math.log(10)
    return lo + (hi - lo) * m


def _clamp(module: str, param: str, value):
    spec = SPECS.get(module, {}).get(param)
    if spec is None or isinstance(value, (str, bool)):
        return value
    v = float(value)
    if spec.min is not None:
        v = max(v, float(spec.min))
    if spec.max is not None:
        v = min(v, float(spec.max))
    if spec.kind == "number" or (spec.step is not None and spec.step >= 1):
        v = float(round(v))
    return round(v, 4)


def resolve(chain: Chain, macros: Macros, macro_map: MacroMap) -> Chain:
    """Apply macro interpolation onto a copy of the chain.

    Macro-controlled params are overwritten (like an Ableton macro rack). Every rack module is listed in rack
    order (unlisted ones as disabled) and every param is filled with its effective value, so the result is
    exactly what the engine played."""
    by_id = {m.id: m.model_copy(deep=True) for m in chain.modules}
    for macro_id in ("depth", "grit", "machine", "space"):
        value = getattr(macros, macro_id)
        for t in getattr(macro_map, macro_id):
            spec = SPECS.get(t.module, {}).get(t.param)
            if spec is None or spec.kind in ("select", "segmented", "switch"):
                continue
            mod = by_id.get(t.module)
            if mod is None:
                mod = ModuleState(id=t.module, enabled=False)
                by_id[t.module] = mod
            mod.params[t.param] = _clamp(t.module, t.param, _interp(t.min, t.max, value, t.curve))
    out = []
    for mid in ORDER:
        mod = by_id.pop(mid, None) or ModuleState(id=mid, enabled=False)
        params = {pid: _clamp(mid, pid, mod.params.get(pid, spec.default)) for pid, spec in SPECS[mid].items()}
        out.append(ModuleState(id=mid, enabled=mod.enabled, params=params))
    out.extend(by_id.values())  # unknown modules pass through untouched (ignored by the engine)
    return Chain(modules=out)


def analyze(source: Source) -> None:
    """Warm the WORLD analysis cache for ``source`` (Harvest; previews use a fast DIO analysis until then)."""
    x48 = pipeline.source_audio48(source)
    _mask.analyze_world(x48, pipeline.ENGINE_SR, pipeline.analysis_method(source.info.kind))


def render(main: Source, stack: list[Source | None], req: RenderRequest) -> RenderOutput:
    """``stack[i]`` corresponds to ``req.stack[i]``; None means pseudo-stack (detuned copy of main)."""
    chain = resolve(req.chain or Chain(), req.macros or Macros(), req.macro_map or MacroMap())
    return pipeline.render(main, list(stack or []), req, chain)


def mask_strength(kind: str, chain: Chain, stack_count: int = 0) -> MaskStrength:
    """Compatibility helper (the stub's signature): score a resolved chain."""
    from fvwks_contracts.models import StackVoice

    return _mask_strength(kind, chain, [StackVoice(voice_id="tts") for _ in range(stack_count)])


def apply_hints(req: RenderRequest, preset: Preset) -> RenderRequest:
    """Fill a request from a preset like the server does, plus the preset's arrange/master hints."""
    arrange = req.arrange.model_copy(update={k: v for k, v in preset.arrange_hint.items() if v is not None})
    master = req.master.model_copy(update={k: v for k, v in preset.master_hint.items() if v is not None})
    return req.model_copy(update={
        "chain": req.chain or preset.chain, "macros": req.macros or preset.macros,
        "macro_map": req.macro_map or preset.macro_map,
        "stack": req.stack if req.stack is not None else preset.stack,
        "arrange": arrange, "master": master,
    })
