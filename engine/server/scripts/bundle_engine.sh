#!/usr/bin/env bash
# Build the portable engine bundle for FoxBox.app (owned by S3).
#
#   engine/server/scripts/bundle_engine.sh [OUT_DIR]        default: <repo>/out/engine
#
# Layout. It is relocatable: no absolute paths inside, so copy it anywhere, e.g. to
# "FoxBox.app/Contents/Resources/engine". Two components the app updates separately (1.2):
#   runtime/           everything third-party; byte-identical across builds while uv.lock (and uv) stay the same
#     python/          uv-managed CPython (python-build-standalone), trimmed
#     venv/            `uv venv --relocatable` with the locked dependencies; fvwks-code.pth puts ../code on sys.path
#     requirements.txt what was installed (uv export, no header)
#   code/              our packages: fvwks_contracts, fvwks_voice, fvwks_fx, fvwks_server, fvwks_synth (+ package data,
#                      and surgepy in fvwks_synth/_native when build_surgepy.sh has run)
#   components.json    {"runtime": sha256, "code": sha256}: each a sha256 of the component's sorted file manifest
#   bin/fvwks-engine   launcher with the same flags as the dev entry point:
#                      --port 0 --token T --data-dir D [--export-dir E] --exit-with-parent
# Every .pyc is unchecked-hash (never rewritten) and records /install/engine/... as its source path.
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

RT="$OUT/runtime"
SITE="$RT/venv/lib/python$PYVER/site-packages"
rm -rf "$OUT"
mkdir -p "$OUT/bin" "$RT"
touch "$OUT/$MARK"
cp -R "$PREFIX" "$RT/python"
# Trim what the engine never imports (test suite, Tk, IDLE, ensurepip).
rm -rf "$RT/python/lib/python$PYVER/"{test,idlelib,tkinter,turtledemo,ensurepip} \
       "$RT/python/lib/"{tcl,tk,itcl,thread}* "$RT/python/share"

echo "==> relocatable venv"
uv venv --quiet --relocatable --python "$RT/python/bin/python$PYVER" "$RT/venv"
# uv links venv/bin/python* to the absolute interpreter path; point them inside the bundle instead.
for link in "$RT"/venv/bin/python*; do
  [ -L "$link" ] && ln -sfn "../../python/bin/python$PYVER" "$link"
done

echo "==> dependencies from uv.lock"
(cd "$ENGINE" && uv export --quiet --frozen --no-dev --no-hashes --no-header --no-emit-workspace \
  --package fvwks-server -o "$RT/requirements.txt")
install() { VIRTUAL_ENV="$RT/venv" uv pip install --quiet --python "$RT/venv/bin/python" --link-mode copy "$@"; }
install -r "$RT/requirements.txt"
# Our packages go to code/, without dist-info (nothing reads their metadata), found through a .pth whose relative
# line site.py resolves against site-packages, so the runtime never changes when only our code does.
install --no-deps --target "$OUT/code" "$ENGINE/contracts" "$ENGINE/voice" "$ENGINE/fx" "$ENGINE/server" "$ENGINE/synth"
rm -rf "$OUT"/code/*.dist-info "$OUT/code/bin"
echo "../../../../../code" > "$SITE/fvwks-code.pth"

echo "==> scrub build paths"
# The bundle must not name the machine that built it. uv writes its interpreter folder (under the builder's home)
# into sysconfig and libpython's install name, the build folder into pyvenv.cfg, and the source folders into
# direct_url.json. They all become /install, python-build-standalone's own placeholder prefix. Nothing reads them at
# run time: the interpreter finds its stdlib from where it runs, and pyvenv.cfg's home is already a folder that
# doesn't exist once the bundle is copied into the app.
"$RT/python/bin/python$PYVER" -I - "$OUT" "$PREFIX" <<'PY'
import sys
from pathlib import Path

out, prefix = Path(sys.argv[1]), sys.argv[2]
for data in (out / "runtime" / "python" / "lib").glob("python3*/_sysconfigdata_*.py"):
    text, ns = data.read_text(), {}
    exec(text, ns)
    for old in sorted({prefix, ns["build_time_vars"]["prefix"]} - {"/install"}, key=len, reverse=True):
        text = text.replace(old, "/install")
    data.write_text(text)
cfg = out / "runtime" / "venv" / "pyvenv.cfg"
cfg.write_text("".join("home = /install/bin\n" if line.partition("=")[0].strip() == "home" else line
                       for line in cfg.read_text().splitlines(keepends=True)))
for url in (out / "runtime" / "venv" / "lib").glob("python3*/site-packages/*.dist-info/direct_url.json"):
    record, entry = url.parent / "RECORD", f"{url.parent.name}/direct_url.json,"
    record.write_text("".join(line for line in record.read_text().splitlines(keepends=True)
                              if not line.startswith(entry)))
    url.unlink()
PY
LIBPY="$RT/python/lib/libpython$PYVER.dylib"  # not loaded by the (static) interpreter, but shipped
if [ -f "$LIBPY" ]; then
  install_name_tool -id "/install/lib/libpython$PYVER.dylib" "$LIBPY" 2>/dev/null
  codesign --force --sign - "$LIBPY" 2>/dev/null  # arm64 needs a valid (ad-hoc) signature after the edit
fi

echo "==> bytecode (unchecked-hash)"
# Timestamp-checked .pyc files go stale when packaging copies the sources (new mtimes). An interpreter started
# without -B (the voice package's model downloader, say) would then rewrite them inside the signed app and break
# its seal. Unchecked-hash .pyc files are used as they are, never re-validated or rewritten. A few files that don't
# compile (Python 2 syntax in rarely used corners) keep no .pyc, which is fine: they're never imported.
COMPILE_LOG="$(mktemp)"
find "$OUT" -name __pycache__ -type d -prune -exec rm -rf {} +  # stray .pyc files (e.g. .opt-1) from uv's copy
# -s/-p: each .pyc records its source path; record /install/engine/... rather than the build folder (Python swaps in
# the real path when it loads the .pyc).
"$RT/python/bin/python$PYVER" -I -m compileall -q -f -j 0 --invalidation-mode unchecked-hash \
  -s "$OUT" -p /install/engine \
  "$RT/python/lib/python$PYVER" "$SITE" "$OUT/code" > "$COMPILE_LOG" 2>&1 || true
rm -f "$COMPILE_LOG"

cat > "$OUT/bin/fvwks-engine" <<'SH'
#!/bin/sh
# FoxBox engine (portable bundle). -I ignores PYTHON* env vars and user site-packages; -B keeps a signed,
# read-only app bundle free of new .pyc files. -I also makes this interpreter ignore PYTHONDONTWRITEBYTECODE, but
# the interpreters it starts without -I (the model downloader) inherit it, so none of them writes .pyc either.
HERE="$(cd "$(dirname "$0")/.." && pwd -P)"
export PYTHONDONTWRITEBYTECODE=1
exec "$HERE/runtime/venv/bin/python" -I -B -m fvwks_server.main "$@"
SH
chmod +x "$OUT/bin/fvwks-engine"

echo "==> smoke test"
"$OUT/bin/fvwks-engine" --version
"$RT/venv/bin/python" -I -B -c 'import fvwks_server.app, fvwks_voice.api, fvwks_fx.api, fvwks_synth.bass, mutagen, soundfile
from fvwks_server.writer import cover_art; cover_art()  # package data (the AIFF cover art) is in'
echo "==> no build paths"
# Fails the build if any file (or symlink) still names the build folder, uv's interpreter folder or the builder's
# home, also in the dash-escaped form (/Users/x -> -Users-x) that temp folders use.
"$RT/python/bin/python$PYVER" -I - "$OUT" "$PREFIX" "$HOME" <<'PY'
import os, sys

root, prefix, home = sys.argv[1:4]
needles = [n.encode() for n in {root, prefix} | ({home, home.replace("/", "-")} if len(home) > 1 else set())]
leaks = []
for folder, _, files in os.walk(root):
    for name in files:
        path = os.path.join(folder, name)
        if os.path.islink(path):
            data = os.readlink(path).encode()
        else:
            with open(path, "rb") as fh:
                data = fh.read()
        if any(n in data for n in needles):
            leaks.append(os.path.relpath(path, root))
if leaks:
    sys.exit(f"bundle: {len(leaks)} file(s) name the build machine, e.g. {', '.join(sorted(leaks)[:5])}")
PY
echo "==> component hashes"
# sha256 of each component's sorted manifest: one line per file (path, executable bit, sha256 of the content) or
# symlink (path, target). Content only, no timestamps, so an unchanged runtime hashes the same in every build.
# A .pyc counts by its 16-byte header (Python magic + the hash of the source it was compiled from): marshal can
# write the same code object differently from one compile to the next (1 file in ~20k differed between two builds).
"$RT/python/bin/python$PYVER" -I - "$OUT" <<'PY'
import hashlib, json, os, sys

out = sys.argv[1]


def component(root: str) -> str:
    lines = []
    for folder, dirs, files in os.walk(root):
        for name in dirs + files:
            path = os.path.join(folder, name)
            rel = os.path.relpath(path, root)
            if os.path.islink(path):
                lines.append(f"L {rel} -> {os.readlink(path)}")
            elif os.path.isfile(path):
                with open(path, "rb") as fh:
                    digest = ("pyc:" + fh.read(16).hex() if name.endswith(".pyc")
                              else hashlib.file_digest(fh, "sha256").hexdigest())
                lines.append(f"F {rel} {'x' if os.stat(path).st_mode & 0o111 else '-'} {digest}")
        dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(folder, d))]
    return hashlib.sha256("\n".join(sorted(lines)).encode()).hexdigest()


hashes = {name: component(os.path.join(out, name)) for name in ("runtime", "code")}
with open(os.path.join(out, "components.json"), "w") as fh:
    json.dump(hashes, fh, indent=2)
    fh.write("\n")
print(json.dumps(hashes))
PY
{
  echo "fvwks-engine bundle"
  echo "built:  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "python: $("$RT/venv/bin/python" -I -c 'import sys; print(sys.version.split()[0])')"
  echo "git:    $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "size:   $(du -sh "$OUT" | cut -f1)"
} > "$OUT/MANIFEST.txt"
cat "$OUT/MANIFEST.txt"
