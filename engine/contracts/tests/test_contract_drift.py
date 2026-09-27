"""Guards the frozen HTTP contract: the running app's OpenAPI must equal contracts/openapi.yaml.
If this fails, either revert your signature change or send a proposal to the coordinator
(contracts/proposals/S<n>.md). Only the coordinator regenerates contracts/openapi.yaml.
"""
import importlib.util
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]


def _build():
    spec = importlib.util.spec_from_file_location("export_openapi", ROOT / "scripts" / "export_openapi.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.build_openapi()


def test_openapi_matches_contract():
    frozen = yaml.safe_load((ROOT / "contracts" / "openapi.yaml").read_text())
    live = yaml.safe_load(yaml.safe_dump(_build(), sort_keys=False, allow_unicode=True))
    assert live["paths"].keys() == frozen["paths"].keys(), "route set changed"
    for path, ops in frozen["paths"].items():
        for method, op in ops.items():
            assert method in live["paths"][path], f"{method.upper()} {path} missing"
            assert live["paths"][path][method].get("operationId") == op.get("operationId"), f"operationId changed: {path}"
    assert live["components"]["schemas"] == frozen["components"]["schemas"], "component schemas changed"
