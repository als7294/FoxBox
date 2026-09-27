#!/usr/bin/env bash
# Dev launcher. Engine only:  scripts/dev.sh engine   (prints FVWKS_ENGINE_READY port=...)
# Full app (once S4 lands):   scripts/dev.sh          (runs `npm run dev` in app/, which spawns the engine)
# Each worktree keeps its own data under <worktree>/.devdata/ so parallel sessions don't collide.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export FVWKS_DATA_DIR="${FVWKS_DATA_DIR:-$ROOT/.devdata/data}"
export FVWKS_EXPORT_DIR="${FVWKS_EXPORT_DIR:-$ROOT/.devdata/exports}"
if [ "${1:-app}" = "engine" ]; then
  cd "$ROOT/engine" && exec uv run --all-packages fvwks-engine --port "${FVWKS_PORT:-8765}" "${@:2}"
fi
cd "$ROOT/app" && exec npm run dev
