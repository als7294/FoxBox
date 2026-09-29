#!/bin/sh
# Builds Surge XT's Python module (surgepy, GPL-3.0) for arm64 / Python 3.12 and installs it into
# engine/synth/src/fvwks_synth/_native/ (git-ignored; it ships in engine-code, never in git).
# Needs Xcode Command Line Tools, git and uv; cmake and ninja come from PyPI into a throwaway venv (no Homebrew).
# FoxBox's one change to Surge is surgepy-set-tempo.patch (a setTempo(bpm) binding). This script, that patch and the
# pinned commit are the corresponding source for the GPL.
# Usage: engine/synth/native/build_surgepy.sh <work dir>   (about 420 MiB download, ~1.5 min build on an M3 Pro)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
COMMIT=9ebdd49c56d563848a5dec2070575d48d2054b61  # Surge XT 1.4.main.9ebdd49, the build FoxBox ships
W=${1:?work dir}
mkdir -p "$W" && cd "$W"
[ -d tools ] || uv venv -q -p 3.12 tools
VIRTUAL_ENV="$W/tools" uv pip install -q cmake ninja
PATH="$W/tools/bin:$PATH"
if [ ! -d src ]; then
  # Exactly the pinned commit (and its submodules), however far main has moved.
  git init -q src
  (cd src && git remote add origin https://github.com/surge-synthesizer/surge.git && git fetch -q --depth 1 origin "$COMMIT" \
    && git checkout -q FETCH_HEAD && git submodule update -q --init --recursive --depth 1)
fi
(cd src && git apply --check "$HERE/surgepy-set-tempo.patch" 2>/dev/null && git apply "$HERE/surgepy-set-tempo.patch" || true)
# Plugin options stay at their defaults (pluginval's config expects the targets); only surgepy is built.
cmake -S src -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DSURGE_BUILD_PYTHON_BINDINGS=ON -DSURGE_BUILD_TESTRUNNER=OFF \
  -DCMAKE_OSX_ARCHITECTURES=arm64 -DPython_EXECUTABLE="$W/tools/bin/python" -DPYTHON_EXECUTABLE="$W/tools/bin/python" \
  -DCMAKE_C_FLAGS="-ffile-prefix-map=$W=/surge" -DCMAKE_CXX_FLAGS="-ffile-prefix-map=$W=/surge"
# -ffile-prefix-map: __FILE__ strings (asserts) name /surge/…, never the build folder (the builder's home: anonymity).
cmake --build build --target surgepy -j 8
cp build/src/surge-python/surgepy*.so "$HERE/../src/fvwks_synth/_native/"
ls -l "$HERE/../src/fvwks_synth/_native/"
