"""Export the HTTP contract (contracts/openapi.yaml) from the engine app.
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
    spec = build_openapi()
    (ROOT / "contracts" / "openapi.yaml").write_text(yaml.safe_dump(spec, sort_keys=False, allow_unicode=True, width=120))
    print("wrote contracts/openapi.yaml", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
