# FoxBox Strings on Windows: the plan

The user asked for a Windows release ("start cooking"). This is the plan, owned by S3, with S1's tracking and S2's audio sections. Nothing is built yet. Base: main a4b3a0fe (2.0.1). The user's calls are at the end.

**In short:** ship it in three steps, all built and smoke-tested on GitHub Actions, because we have no Windows machine:
1. **A SAUCE-only beta** (x64, Windows 10 and 11, an NSIS installer). SAUCE needs no engine: it's the camera, the instrument, the frame and the GUIDE.
2. **REMIX**, with the engine on Windows: stems through ONNX Runtime (DirectML, with a CPU fallback) instead of MLX.
3. **Small updates and a signed installer.**

ARM64 comes after x64.

## 1. The engine
**What breaks:**
- MLX stems: Apple-only, and 203 MB of today's 465 MB unpacked runtime.
- `afconvert` for AAC/M4A/ALAC. (`sips` art thumbnails already fall back to the original.)
- The Mac's Serato and Rekordbox paths (see 3).
- `bundle_engine.sh`'s POSIX layout and codesign.

**What's portable:**
- Every other dependency has win_amd64 wheels (soundfile carries libsndfile).
- The analysis stack (`fvwks_fx`) is numpy + scipy only.
- The stems clean-up (`refine`) is scipy's STFT, so it carries over unchanged.

**Stems: three options.**

| | ONNX Runtime (pick) | PyTorch Demucs | MLX on Windows |
|---|---|---|---|
| Runtime deps | onnxruntime-directml 25 MB wheel (it carries the CPU provider too) | torch 124 MB wheel, ~900 MB unpacked (CPU) | the MLX wheel, CPU only (no Metal) |
| Speed | CPU is ~20–30% faster than PyTorch (Mixxx: RTF ~0.35; StemSplit: 0.20 on an M4 Pro). Laptop CPUs run at roughly RTF 0.4–2, so 1–6 min per 3-min song. DirectML: no public benchmark, to measure | the CPU baseline | unmeasured, likely the slowest |
| Quality | the same weights, STFT in the graph: SI-SDR 7.43 vs PyTorch's 7.44 (Mixxx, MusDB) | the reference | the same |
| Licence | MIT (demucs-onnx by StemSplit, the Mixxx fork, ORT) | MIT code | MIT |

**The pick:** demucs-onnx's export of our htdemucs (fp16, 166 MB), run on onnxruntime-directml with the CPU provider as the fallback, behind the current `StemSplitter` seam (`_load` / `apply_model`). The Mac keeps MLX.
- The model is a separate pinned download (a Hugging Face repo, the same flow as today's 84 MB MLX one), never in the runtime.
- The weights notice stays "scientific use only": that's the maintainer's own statement, even though the new Hugging Face card is tagged MIT.
- DirectML is in "sustained engineering": supported, but its wheel lags (1.24 against ORT's 1.31), and new work goes to Windows ML, which has no Python wheel yet. ARM64 has no DirectML wheel, so it gets plain `onnxruntime` (CPU).
- Time the DirectML real-time factor on a real laptop GPU before an RC.
- Inspiration only: demucs.cpp (MIT), and ORT-web/WebGPU in the renderer (it would fight MediaPipe for the GPU).

**Decode:** AAC/M4A/ALAC need a decoder on Windows. Either PyAV (FFmpeg under LGPL, about 30 MB more), or the beta accepts WAV, MP3, FLAC and OGG only and gives a clear "convert it" hint. The user decides; I lean towards the hint for the beta.

**The runtime:** keep uv's python-build-standalone and the relocatable venv. No PyInstaller: its shared bootloader trips antivirus. On Windows 11, Smart App Control can block unsigned binaries outright, so `python.exe` and the `.pyd`/`.dll` files get signed with our identity (see 5).
- Port `bundle_engine.sh` to the Windows layout (`Lib\site-packages`, `python.exe`, no symlinks or codesign). Git Bash on the runner can run it.
- The app spawns `python.exe -I -B -m fvwks_server.main` itself, so there's no `.cmd` and no console window.
- Size: 465 − 203 (MLX) + ~40 (ORT and DirectML) ≈ **300 MB unpacked, ~110 MB zipped** (estimate; the Mac's is 148 MB). Trimming SciPy to what we import is the next lever.
- Launch fixes: `windowsHide`, not detached; `taskkill /T` instead of signals to the process group; drop the `ps` check for a stale engine (or use `tasklist`); look for `uv.exe` in the dev paths.

## 2. Build and CI
We have no Windows machine, so GitHub Actions it is, on the public snapshot repo.
- **Runners:** `windows-latest` is Server 2025 with 4 vCPU, 16 GB and no GPU; `windows-11-arm` covers ARM64 later. Both are free for public repos.
- **Triggers:** by hand or by a snapshot push. Releases stay a manual step.
- **Jobs:**
  - **tests:** vitest and pytest.
  - **engine-win:** bundle, start it, `GET /api/health`, split a 10 s CC clip on CPU (the model cached between runs).
  - **app-win:** `electron-builder --win nsis --x64` + blockmap, with a `win` block (`.ico`), `afterPack` hashing the Windows layout, and `cross-env` in the npm scripts. The fuses carry over. The Link addon gets an MSVC 2022 prebuild per arch (S2).
  - **smoke:** a silent NSIS install, then CDP. It must boot, the engine must be healthy, and the fake MJPEG camera must show hands (CPU delegate pinned, S1).
- **What it can't judge:** feel, latency and GPU speed. Those need a real laptop.

## 3. The app (~40 places, from the code survey)
- **Permissions:**
  - `getMediaAccessStatus('camera')` loses its darwin gate.
  - "Open settings" goes to `ms-settings:privacy-webcam`.
  - The copy names Windows Settings and DPAPI, not System Settings and the Keychain.
- **Mac-only steps become no-ops:** quarantine, App Translocation, "Move to Applications", ad-hoc codesign, `/Volumes/`.
- **Paths:**
  - `app.getPath('music'/'documents')` for exports and the Ableton User Library (OneDrive-redirected folders included).
  - `_Serato_` under Music and at each drive's root. The DJ 4 sqlite is probably under `%LOCALAPPDATA%\Serato` (unverified).
  - Rekordbox's `Location` is `file://localhost/C:/…`.
  - `paths.ts` and `exportGuard.ts` must accept `C:\…`.
- **The window:**
  - A File/Help menu instead of the macOS app menu.
  - `titleBarOverlay` instead of `hiddenInset`, with the drag strips leaving room for the caption buttons.
  - One platform-text helper for the Mac wording ("⌘", "Finder", "this Mac"), in about 12 files. It reads preload's `platform`, which is unused today.
- **Check on Windows:** MediaRecorder's MP4/H.264 (`recording.ts`), and the cost of `backdrop-filter` on weak GPUs.
- **No native modules ship:** `app/native/` is untracked and unused.

## 4. Updates
- **The app:** electron-builder NSIS + electron-updater, with blockmap differential downloads (an asar-only change comes down as a small delta). Windows can't swap a running exe, so the updater runs the installer on quit.
- **The engine:** engine-runtime and engine-code stay separate component downloads, as on the Mac. A `latest-win.json` component feed reuses `components.ts`'s hashes and puts each part in `%LOCALAPPDATA%\FoxBox\engine\<hash>`, which is user-writable, so an engine-code fix is a few hundred KB and needs no installer.
- **SAUCE-only installs** never download the engine. It arrives on first REMIX use, like the stems model.
- **Before `quitAndInstall`:** stop the engine, because a locked `.pyd` or `.dll` breaks the install. A missing cached installer silently falls back to a full download.
- **Backup:** Velopack. **Avoid:** Squirrel.Windows (its installer has a CVE).
- The Mac's custom updater (`updater.ts`: `ditto`, `plutil`, the `.app` swap) stays macOS-only.

## 5. Signing (the user's call)
No certificate gives instant SmartScreen trust any more. Reputation builds over weeks and hundreds of installs, and it carries across versions when the signing identity stays the same.

| Option | Cost | Notes |
|---|---|---|
| Unsigned beta | free | "Windows protected your PC → Run anyway" on every build. Windows 11's Smart App Control can block it outright. Fine for testers only |
| Azure Artifact Signing (was Trusted Signing) | $9.99/mo (Basic), billed from sign-up | Plugs into electron-builder (`win.azureSignOptions`). Individuals: US or Canada, with government-ID checks; companies in more countries. Validation takes 1–20 business days |
| OV certificate | ~$120–300/yr | A hardware token or cloud HSM; at most 460 days. EV costs $400+ and lost its SmartScreen bypass in 2024 |
| SignPath Foundation | free for open source | Wants every shipped component OSI-licensed. The Demucs weights download at runtime, so we probably qualify; to confirm |
| Microsoft Store (MSIX) | the Store account | The Store signs it, with no SmartScreen warnings and Store updates. It needs an MSIX build (electron-builder's `appx`) and Store review |

Recommendation: an unsigned beta for testers, then Azure Artifact Signing if the user qualifies (else SignPath, else OV). The Store is worth a look for the public release.

## 6. Scope
- **x64 first.** Windows 10 22H2 and 11 (Electron 44 still runs on both).
- **ARM64 later:** Electron cross-builds it, and numpy, scipy, onnxruntime (CPU) and python-build-standalone all have win_arm64 builds. MediaPipe on Snapdragon GPUs is untested.
- **The SAUCE-only beta ships first:** no engine, a smaller installer and fewer moving parts.
- **Then REMIX.** The beta's MIDI story is S2's below (OSC to the M4L device; no bundled virtual port).

**Phases (owners):**
- **W0**, CI skeleton and an unsigned x64 installer that boots (S4, S3).
- **W1**, the SAUCE beta: permissions, window, wording, paths (S4), with S1's and S2's fixes.
- **W2**, REMIX on Windows: ORT stems, the Windows bundle, decode, library paths (S3).
- **W3**, updates and signing (S4, S3).

A real Windows laptop pass is needed before any public RC.

## Tracking on Windows (S1)
- **Engine:** MediaPipe Tasks Vision 1.0.1 (WASM, vendored), in a worker fed 640 px ImageBitmaps. The light lift (`levelled()`, OffscreenCanvas 2D) and all gesture rules are plain JS, with no Mac-only code. Most rules are timed in ms, but pluck confirm and re-arm count results, so at 15 results/s plucks land ~70 ms later.
- **GPU:** each model tries the GPU delegate (WebGL2 in the worker; on Windows, ANGLE → D3D11) and falls back to CPU. The log line `FoxBox camera models: {...}` says which. Risks: hybrid laptops default to the integrated GPU (`--force_high_performance_gpu` or the Windows Graphics settings fix it), and blocklisted old Intel/AMD drivers drop to CPU. The CPU delegate's hands/s is unmeasured; we measure it after the plan is approved.
- **Camera:** we ask for 720p30. Many laptop webcams fall to 15 fps in dim light, and YUY2 at 720p can be 10 fps (check `track.getSettings()`). Windows Hello IR cameras appear as grey devices: hide or label them. A camera busy in Teams throws NotReadableError. OBS Virtual Camera works as a normal device, and it's the easy way to feed clips on a real Windows machine.
- **Mac-only code (src/main/index.ts), with the Windows fixes:**
  - On non-darwin, `askCamera` and `cameraStatus` just return granted, so the privacy switch only shows up as NotAllowedError from getUserMedia. Electron's `getMediaAccessStatus('camera')` also works on Windows: use it.
  - `openCameraSettings` does nothing off the Mac. It should open `ms-settings:privacy-webcam`, and the coach text should say Windows Settings.
- **CI (windows-latest, no GPU):** pin the CPU delegate. Use the same fake-MJPEG harness (`--use-file-for-fake-video-capture`, clips in yuvj420p) in a hidden `offscreen: true` window. It smokes model load, hands seen and R06's wheel open and load; it can't gate timing.
- **Needs a real Windows laptop:** the GPU delegate and its rate (target 27–30 results/s), the webcam's fps and format in the dark, the IR, busy and privacy cases, and one pass of the key gestures by hand.

## Audio & MIDI (S2)
- **Latency.** Chromium plays through WASAPI shared mode (~10 ms device period, plus Chrome's own buffering; there's no exclusive mode). We keep `latencyHint: 'interactive'` and Tone's `lookAhead = 0`, which are platform-neutral. Budget ~20–40 ms pluck→sound on wired output; Bluetooth adds 100–200+ ms, so show a "use wired output to play" hint when the output is Bluetooth. `input.ts` already compensates with `ctx.baseLatency`; add `outputLatency` to the frame loop's lock hit once measured.
- **Worklets/CSP.** The fvwks worklets load from our own files (no `blob:`), and Tone uses native nodes only (no Tone worklets). Nothing Mac-specific; no change.
- **RECORD (WAV/.mid).** Encoded in the renderer (encodeWav / writeSmf) and written by main with `fs`. Take names are already sanitised to `[\w .()+#-]`, so they're Windows-safe. Check only that exports resolve via `app.getPath('music')` → `Music\FoxBox`.
- **Web MIDI out to hardware/DAWs.** Works through Chromium's WinMM/WinRT backends. On Win10 a WinMM port is single-client: if Live holds "loopMIDI Port", FoxBox can't open it, or the reverse. Show a clear "port busy" state. Win11's Windows MIDI Services (GA Feb 2026, phased rollout) makes ports multi-client.
- **No built-in virtual "FoxBox" port on Windows.** Win10 has no API. Win11 loopbacks are user-created in MIDI Settings, and their visibility through WinMM/Chrome is reported unreliable. teVirtualMIDI/loopMIDI can't be bundled without the author's written clearance (no public licence). **Plan:** on Windows, FoxBox → Live goes only through S6's Max for Live device over OSC (UDP 127.0.0.1, identical to Mac; needs Live Suite/M4L). Plus "pick any MIDI output" for hardware and a user-installed loopMIDI, documented but not bundled.
- **Ableton Link.** FoxBox is GPL-3.0, so we use the Link SDK under its GPL-2.0-or-later licence (S4 adds it to THIRD_PARTY_NOTICES). That syncs with any Link peer: Live, Rekordbox, Traktor. It feeds `setExternalClock()` (2.1, ready). On Windows the native addon needs an MSVC build and a prebuilt binary per arch, plus a firewall prompt for Link's UDP multicast. **Fallback** if the addon is a pain there: the M4L device sends Live's tempo/beat back over the OSC link (`/fb/<secret>/clock`), which works with Live only.
- **Needs a real Windows box:**
  - pluck→sound latency (wired and BT);
  - Web MIDI port list and Live's single-client clash on Win10;
  - Win11 loopback visibility in Electron;
  - the device install path (`%APPDATA%\Ableton\…\Library.cfg`, the User Library under Documents);
  - a firewall prompt for the device's UDP listener.

## The user's decisions
1. **Signing:** unsigned beta → Azure Artifact Signing ($9.99/mo; US/Canada ID), an OV certificate (~$120–300/yr), SignPath (free, if it accepts us), or the Microsoft Store?
2. **Scope:** a SAUCE-only beta first, x64, Windows 10 and 11? (ARM64 later.)
3. **A real Windows laptop:** whose, for one test pass before a public RC (GPU tracking, latency, cameras, DirectML stems)?
4. **AAC/M4A/ALAC in REMIX:** add FFmpeg (PyAV, LGPL, about 30 MB more), or WAV/MP3/FLAC/OGG only, with a hint, for now?
5. **CI and releases:** OK to build Windows on the public repo's Actions, with the installer released there like the Mac's?
6. **MIDI into other apps:** with no bundled virtual port on Windows (OSC to the M4L device, or a user-installed loopMIDI), is that OK?
