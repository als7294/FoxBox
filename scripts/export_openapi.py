"""Export the HTTP contract (contracts/openapi.yaml) and schemas from the engine app.
Run from repo root:  cd engine && uv run python ../scripts/export_openapi.py
"""
import json
import sys
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def build_openapi() -> dict:
    from fvwks_server.app import create_app
    from fvwks_server.config import Config

    with tempfile.TemporaryDirectory(prefix="fvwks-openapi-", ignore_cleanup_errors=True) as d:  # never left behind
        tmp = Path(d)
        return create_app(Config.from_env(str(tmp / "data"), str(tmp / "exports"))).openapi()


def main() -> int:
    from fvwks_contracts.models import Preset
    from fvwks_fx.api import rack_schema

    spec = build_openapi()
    (ROOT / "contracts" / "openapi.yaml").write_text(yaml.safe_dump(spec, sort_keys=False, allow_unicode=True, width=120))
    (ROOT / "contracts" / "chain.schema.json").write_text(json.dumps(Preset.model_json_schema(), indent=2) + "\n")
    (ROOT / "contracts" / "rack.v0.json").write_text(rack_schema().model_dump_json(indent=2) + "\n")
    print("wrote contracts/openapi.yaml, chain.schema.json, rack.v0.json", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
