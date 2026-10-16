#!/bin/sh
# 2.1's native parts, into build/native/ (electron-builder ships them as Contents/Resources/native/, the app part):
#   foxbox_link.node  Ableton Link (native/link: Link 4.1 + asio, vendored), compiled against Node's N-API headers.
#                     N-API is ABI-stable, so no node-gyp and no rebuild when Electron changes.
#   midi.node         @julusian/midi's darwin-arm64 N-API prebuild (the virtual CoreMIDI port), copied as is.
set -eu
APP=$(cd "$(dirname "$0")/.." && pwd)
OUT="$APP/build/native"
NODE_INC=$(node -p "require('path').resolve(process.execPath, '../../include/node')")
mkdir -p "$OUT"
[ -f "$NODE_INC/node_api.h" ] || { echo "no node_api.h under $NODE_INC" >&2; exit 1; }
xcrun clang++ -std=c++17 -O2 -arch arm64 -mmacosx-version-min=14.0 -fvisibility=hidden \
  -DLINK_PLATFORM_MACOSX=1 -DLINK_PLATFORM_UNIX=1 -DNAPI_VERSION=8 \
  -I"$APP/native/link/link/include" -I"$APP/native/link/asio/include" -I"$NODE_INC" \
  -bundle -undefined dynamic_lookup -o "$OUT/foxbox_link.node" "$APP/native/link/foxbox_link.cc"
cp "$APP/node_modules/@julusian/midi/prebuilds/midi-darwin-arm64/node-napi-v7.node" "$OUT/midi.node"
ls -l "$OUT"
