# Syphon host (1.6)

`syphon_host.node` receives a Syphon server's frames: TouchDesigner's Syphon Spout Out TOP, sender name `FoxBox`.

- **Build:** `./build.sh` fetches [Syphon](https://github.com/Syphon/Syphon-Framework) (BSD-3) at a pinned commit into the git-ignored `vendor/`, then compiles it into one Node-API addon. Only the Command Line Tools are needed, since the Metal server's shader compiles at run time.
- **Packaged:** the addon ships in the app's Resources (`syphon_host.node`), and `main/bridge/tdSession.ts` loads it.
- **Zero-copy where it can be:** a frame whose IOSurface is tagged `BGRA` goes straight to Electron's `sharedTexture`, as every Syphon client draws it.
  - A CPU-side copy stalled for 43–91 ms a frame on the server's own writes into that surface.
  - Measured against a 54 fps test server: about 54 frames a second through, and 0.23 ms upload in each of two windows.
- **TouchDesigner's surfaces carry no pixel-format tag,** and Chromium refuses to import an untagged surface as `bgra`. The GPU process logs "IOSurface pixel format does not match" and soon loses its context. So those frames are copied on the GPU into one of up to six BGRA-tagged surfaces of the addon's own, and handed over when the copy completes, with nothing waiting on it.
  - Measured against TouchDesigner 2025.33230 at 1280 × 720: 57 frames a second converted, 56 a second into a window, 0 GPU errors.
  - `take()` hands over only `BGRA` surfaces (its `fourcc`), and `testConvert()` checks the copy (`tests/unit/main/syphon.test.ts`).
- **Release after the hand-over:** release an imported texture only once `sendSharedTexture` settles. Released sooner, every send rejects and the GPU process logs missing mailboxes.
- **Polled, not called back:** a thread-safe callback into Electron's main loop drained only about 10 times a second.
- **Test server:** `testServer` / `testPublish` stand in for TouchDesigner.
