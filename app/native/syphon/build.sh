#!/bin/sh
# Builds syphon_host.node: Syphon's client and server (BSD-3, github.com/Syphon/Syphon-Framework, fetched at a pinned
# commit into vendor/, never committed) compiled into one Node-API addon with our host. Command Line Tools only (no
# Xcode): Syphon's Metal server compiles its 62-line shader at run time instead of from a prebuilt metallib.
set -eu
cd "$(dirname "$0")"
SYPHON_COMMIT=f4761677a45b8034a3c2069ec0f3d2553da81fba
if [ ! -f vendor/SyphonMetalClient.m ]; then
  rm -rf vendor && mkdir -p vendor
  gh api "repos/Syphon/Syphon-Framework/tarball/$SYPHON_COMMIT" | tar -xz -C vendor --strip-components=1
  # newDefaultLibraryWithBundle needs Xcode's metal compiler at build time: compile the shader source at run time
  sed -i '' 's|\[device newDefaultLibraryWithBundle:bundle error:&error\]|[device newLibraryWithSource:[[NSString alloc] initWithBytes:SyphonMetalShaders_metal length:SyphonMetalShaders_metal_len encoding:NSUTF8StringEncoding] options:nil error:\&error]|' vendor/SyphonServerRendererMetal.m
  mkdir -p vendor/shader  # the shader with its one local header inlined (a run-time compile can't resolve it)
  { cat vendor/SyphonServerMetalTypes.h; grep -v '#include "SyphonServerMetalTypes.h"' vendor/SyphonMetalShaders.metal; } > vendor/shader/SyphonMetalShaders.metal
  (cd vendor/shader && xxd -i SyphonMetalShaders.metal > ../SyphonMetalShaders.h)
  sed -i '' 's|#import "SyphonServerRendererMetal.h"|#import "SyphonServerRendererMetal.h"\n#import "SyphonMetalShaders.h"|' vendor/SyphonServerRendererMetal.m
fi
NODE_INC="${NODE_INC:-$HOME/Library/Caches/node-gyp/$(node -p process.versions.node)/include/node}"
SRC="SyphonCFMessageReceiver SyphonCFMessageSender SyphonClientBase SyphonClientConnectionManager SyphonImageBase
  SyphonMessageQueue SyphonMessageReceiver SyphonMessageSender SyphonMessaging SyphonMetalClient SyphonMetalServer
  SyphonPrivate SyphonServerBase SyphonServerConnectionManager SyphonServerDirectory SyphonServerRendererMetal"
mkdir -p build/include build/obj
ln -sfn ../../vendor build/include/Syphon  # its headers import <Syphon/...>
FLAGS="-fobjc-arc -fobjc-weak -O2 -arch arm64 -mmacosx-version-min=12.0 -DSYPHON_CORE_SHARE -Ibuild/include -Ivendor"
for f in $SRC; do
  xcrun clang -c $FLAGS -include vendor/Syphon_Prefix.pch "vendor/$f.m" -o "build/obj/$f.o"
done
xcrun clang -c -O2 -arch arm64 -mmacosx-version-min=12.0 -Ivendor vendor/SyphonDispatch.c -o build/obj/SyphonDispatch.o
xcrun clang++ -std=c++17 -ObjC++ $FLAGS -DNODE_GYP_MODULE_NAME=syphon_host -I"$NODE_INC" -bundle -undefined dynamic_lookup \
  -framework Cocoa -framework Metal -framework IOSurface syphon_host.mm build/obj/*.o -o build/syphon_host.node
echo "built build/syphon_host.node"
