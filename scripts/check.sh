#!/usr/bin/env bash
# Run all tests (or one area): scripts/check.sh [all|contracts|voice|fx|server|app]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AREA="${1:-all}"
py() { (cd "$ROOT/engine" && uv run --all-packages pytest "$@"); }
case "$AREA" in
  contracts|voice|fx|server) py "$AREA/tests" ;;
  app) (cd "$ROOT/app" && npm test --silent) ;;
  all)
    py
    if [ -f "$ROOT/app/package.json" ]; then (cd "$ROOT/app" && npm test --silent); fi ;;
  *) echo "usage: $0 [all|contracts|voice|fx|server|app]"; exit 2 ;;
esac
