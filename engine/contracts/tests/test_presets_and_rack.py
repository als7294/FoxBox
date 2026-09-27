"""Factory presets must validate against the Preset model and reference real rack modules/params."""
from fvwks_contracts.models import Preset
from fvwks_fx import api as fx


def test_presets_valid_against_rack():
    rack = fx.rack_schema()
    params = {m.id: {p.id for p in m.params} for m in rack.modules}
    presets = fx.list_presets()
    assert {p.id for p in presets} >= {"pact", "legion", "abyss", "unit", "ghost", "signal", "raw"}
    for p in presets:
        Preset.model_validate(p.model_dump())
        for m in p.chain.modules:
            assert m.id in params, f"{p.id}: unknown module {m.id}"
            unknown = set(m.params) - params[m.id]
            assert not unknown, f"{p.id}.{m.id}: unknown params {unknown}"
        for macro in ("depth", "grit", "machine", "space"):
            for t in getattr(p.macro_map, macro):
                assert t.module in params and t.param in params[t.module], f"{p.id}: bad macro target {t}"
