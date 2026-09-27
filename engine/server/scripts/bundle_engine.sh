#!/usr/bin/env bash
# Build the portable engine bundle for FoxBox.app (owned by S3).
#
#   engine/server/scripts/bundle_engine.sh [OUT_DIR]        default: <repo>/out/engine
#
# Layout. It is relocatable: no absolute paths inside, so copy it anywhere, e.g. to
# "FoxBox.app/Contents/Resources/engine".
#   python/            uv-managed CPython (python-build-standalone), trimmed
#   venv/              `uv venv --relocatable`: the engine and its locked dependencies, non-editable, precompiled
#   bin/fvwks-engine   launcher with the same flags as the dev entry point:
#                      --port 0 --token T --data-dir D [--export-dir E] --exit-with-parent
#
# Needs engine/uv.lock (git-ignored until integration; created with `uv lock` if missing).
# Models are not bundled: voices download into the user's cache on first use.
set -euo pipefail

ENGINE="$(cd "$(dirname "$0")/../.." && pwd -P)"
REPO="$(dirname "$ENGINE")"
OUT="${1:-$REPO/out/engine}"
PYVER="${FVWKS_PYTHON:-3.12}"

command -v uv >/dev/null || { echo "bundle: uv not found (https://docs.astral.sh/uv/)" >&2; exit 1; }
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
MARK=".fvwks-engine-bundle"  # only a folder this script created may be replaced
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ] && [ ! -f "$OUT/$MARK" ]; then
  echo "bundle: $OUT exists and isn't an engine bundle; refusing to replace it" >&2
  exit 1
fi
[ -f "$ENGINE/uv.lock" ] || (cd "$ENGINE" && uv lock --quiet)

echo "==> CPython $PYVER (uv-managed, standalone)"
uv python install --quiet "$PYVER"
PREFIX="$(uv run --no-project --managed-python --python "$PYVER" python -c 'import sys; print(sys.base_prefix)')"

rm -rf "$OUT"
mkdir -p "$OUT/bin"
touch "$OUT/$MARK"
cp -R "$PREFIX" "$OUT/python"
# Trim what the engine never imports (test suite, Tk, IDLE, ensurepip).
rm -rf "$OUT/python/lib/python$PYVER/"{test,idlelib,tkinter,turtledemo,ensurepip} \
       "$OUT/python/lib/"{tcl,tk,itcl,thread}* "$OUT/python/share"

echo "==> relocatable venv"
uv venv --quiet --relocatable --python "$OUT/python/bin/python$PYVER" "$OUT/venv"
# uv links venv/bin/python* to the absolute interpreter path; point them inside the bundle instead.
for link in "$OUT"/venv/bin/python*; do
  [ -L "$link" ] && ln -sfn "../../python/bin/python$PYVER" "$link"
done

echo "==> dependencies from uv.lock"
(cd "$ENGINE" && uv export --quiet --frozen --no-dev --no-hashes --no-emit-workspace --package fvwks-server \
  -o "$OUT/requirements.txt")
install() { VIRTUAL_ENV="$OUT/venv" uv pip install --quiet --python "$OUT/venv/bin/python" --link-mode copy "$@"; }
install -r "$OUT/requirements.txt"
install --no-deps "$ENGINE/contracts" "$ENGINE/voice" "$ENGINE/fx" "$ENGINE/server"

echo "==> bytecode (unchecked-hash)"
# Timestamp-checked .pyc files go stale when packaging copies the sources (new mtimes). An interpreter started
# without -B (the voice package's model downloader, say) would then rewrite them inside the signed app and break
# its seal. Unchecked-hash .pyc files are used as they are, never re-validated or rewritten. A few files that don't
# compile (Python 2 syntax in rarely used corners) keep no .pyc, which is fine: they're never imported.
COMPILE_LOG="$(mktemp)"
"$OUT/python/bin/python$PYVER" -I -m compileall -q -f -j 0 --invalidation-mode unchecked-hash \
  "$OUT/python/lib/python$PYVER" "$OUT/venv/lib/python$PYVER/site-packages" > "$COMPILE_LOG" 2>&1 || true
rm -f "$COMPILE_LOG"

cat > "$OUT/bin/fvwks-engine" <<'SH'
#!/bin/sh
# FoxBox engine (portable bundle). -I ignores PYTHON* env vars and user site-packages; -B keeps a signed,
# read-only app bundle free of new .pyc files. -I also makes this interpreter ignore PYTHONDONTWRITEBYTECODE, but
# the interpreters it starts without -I (the model downloader) inherit it, so none of them writes .pyc either.
HERE="$(cd "$(dirname "$0")/.." && pwd -P)"
export PYTHONDONTWRITEBYTECODE=1
exec "$HERE/venv/bin/python" -I -B -m fvwks_server.main "$@"
SH
chmod +x "$OUT/bin/fvwks-engine"

echo "==> smoke test"
"$OUT/bin/fvwks-engine" --version
"$OUT/venv/bin/python" -I -B -c 'import fvwks_server.app, fvwks_voice.api, fvwks_fx.api, mutagen, soundfile'
{
  echo "fvwks-engine bundle"
  echo "built:  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "python: $("$OUT/venv/bin/python" -I -c 'import sys; print(sys.version.split()[0])')"
  echo "git:    $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "size:   $(du -sh "$OUT" | cut -f1)"
} > "$OUT/MANIFEST.txt"
cat "$OUT/MANIFEST.txt"
