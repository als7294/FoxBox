#!/usr/bin/env bash
# Builds link-helper, FoxBox's bridge to Ableton Link ("Sync to Rekordbox"; any Link app on the network), for macOS
# arm64 with the Command Line Tools (no Xcode needed).
#
#   app/native/link/build.sh [OUT_DIR]        default: app/native/link/out
#
# Ableton Link (GPL-2.0-or-later) is header-only; it and its asio (BSL-1.0) are fetched at the pinned commits below
# into .deps/ (git-ignored), once.
set -euo pipefail

LINK_COMMIT=9c9091275e707ab09d09a5a608fcdb84bf0dec85   # Ableton/link master, 2026-09
ASIO_COMMIT=8806a6803cde7054c3049d3666d3ec36786568c5   # asio-1-38-2 (Link's submodule)
HERE="$(cd "$(dirname "$0")" && pwd -P)"
DEPS="$HERE/.deps/link-${LINK_COMMIT:0:12}"
OUT="${1:-$HERE/out}"

if [ ! -f "$DEPS/include/ableton/Link.hpp" ]; then
  rm -rf "$DEPS.tmp"
  git init -q "$DEPS.tmp"
  git -C "$DEPS.tmp" fetch -q --depth 1 https://github.com/Ableton/link.git "$LINK_COMMIT"
  git -C "$DEPS.tmp" checkout -q FETCH_HEAD
  git init -q "$DEPS.tmp/modules/asio-standalone"
  git -C "$DEPS.tmp/modules/asio-standalone" fetch -q --depth 1 https://github.com/chriskohlhoff/asio.git "$ASIO_COMMIT"
  git -C "$DEPS.tmp/modules/asio-standalone" checkout -q FETCH_HEAD
  rm -rf "$DEPS" && mv "$DEPS.tmp" "$DEPS"
fi

mkdir -p "$OUT"
xcrun clang++ -std=c++17 -O2 -arch arm64 -mmacosx-version-min=12.0 -DLINK_PLATFORM_MACOSX=1 \
  -I "$DEPS/include" -I "$DEPS/modules/asio-standalone/asio/include" \
  "$HERE/link-helper.cpp" -o "$OUT/link-helper"
# Ad-hoc signed on its own (Apple silicon runs only signed code); the app's seal then covers it as a resource.
codesign --force -s - "$OUT/link-helper"
cp "$DEPS/LICENSE.md" "$OUT/link-helper.LICENSE.md"
echo "built $OUT/link-helper"
