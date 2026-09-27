# S3 ENGINE SERVER: status

Branch `session/s3-engine`. `v0-contracts` is merged. The OpenAPI drift test is green (the route signatures are untouched).

## Done
- **M1: contract-independent modules**
  - `writer.py`: AIFF/WAV writing.
    - AIFF by default, or WAV, 24-bit via soundfile. 16-bit output gets TPDF dither.
    - Canonical WAV layout: `fmt ` (tag 0x0001) at byte 12, `data` at byte 36, then `LIST/INFO`. Any extensible (0xFFFE) header is rewritten.
    - Tags: ID3v2.3 in AIFF (TIT2, TPE1, TALB, TBPM, TKEY, COMM, TXXX:FVWKS_RENDER JSON, TYER, TSSE). RIFF INFO in WAV (INAM, IART, IPRD, ICMT, ICRD, ISFT).
    - Files are named by `Settings.filename_pattern`. Every file of one export shares the next free `v<nn>`.
    - Writes are staged and atomic.
  - `rekordbox.py`: DJ_PLAYLISTS/COLLECTION/PLAYLISTS.
    - TEMPO at 0.000 s, hot cue A (Num=0) at the first word, memory cue (Num=-1) at the tail.
    - Target path root rewrites locations; parse-back is supported.
  - `library.py`: SQLite for sources, renders, takes, exports, presets, personas, settings and cache. Includes the content-addressed artifact cache with LRU pruning.
  - `jobs.py`: lane-based background jobs (`default`, `analysis`, `install`) with per-item states and cancellation.
- **M2: the stub is replaced** (`service.py` + `app.py`).
  - Every route is real, with the SQLite library, caches and jobs behind it.
  - **Auth:**
    - Bearer token on every route. `?token=` is accepted only on `GET /api/audio/*`. Tokens are compared in constant time.
    - Binds 127.0.0.1 only. CORS applies only with `--allow-origin` (dev).
  - **Paths:**
    - The engine accepts no client file paths. The only exception is `Settings.export_dir`, which is validated: absolute, not a system folder, and writable.
    - Every returned path is checked to be inside the export root.
  - **TTS:** cached by (script, voice, speed, bpm, name, lexicon). Each new source queues a background WORLD-analysis job (`fx.analyze`).
  - **Render:**
    - Preset fill for `None` fields, plus `arrange_hint`/`master_hint` for fields the client didn't send.
    - STACK voices are synthesized via `voice.synthesize` (cached in memory and on disk), then `fx.render(main, stack, req)` runs.
    - Identical requests return the cached render.
    - Final render → Vault take + auto-export of the wet file. It is idempotent, and re-exports if the file was deleted.
  - **Exports:** wet, dry and `alt:<preset_id>` (re-rendered on the same grid), plus stems when fx provides them. rekordbox.xml goes to the export root or the batch folder.
  - **Batch/Setlist:**
    - Per-line job items with states and errors.
    - Output goes to `<export root>/<playlist>/`, plus the XML (its path is in `Job.message`).
    - One failing line doesn't stop the batch. If every line fails, the job is `error`.
  - **Also:** settings, lexicon and presets persist across restarts. `/api/voices` gets audition clips (`smp_…`, synthesized on first GET). `GET /api/audio` serves Range requests.
  - **Housekeeping:** keeps the newest 24 previews and the newest 100 sources (plus any used by final renders).
  - **Entry point:** `fvwks-engine --port 0 --token T --data-dir D [--export-dir E] [--exit-with-parent]` prints `FVWKS_ENGINE_READY port=N`.
    - The default export dir is `~/Music/FoxBox` when `--data-dir` is `~/Library/Application Support/FoxBox`. Otherwise it is `<data-dir>/../exports`.
  - **Engine overhead per preview:** about 28 ms on top of fx (store about 7 ms, peaks, DB, HTTP). A cache hit returns in about 6 ms; the first audio GET takes about 20 ms.
  - **Tests** (140 in `engine/server/tests`, plus the opt-in bundle tests). Every route in the contract is checked for the token.
    - The full API flow tts → render → export → rekordbox.xml against the voice and fx stubs.
    - WAV header bytes, ID3 and RIFF INFO read back, XML parse-back.
    - Auth, library, presets, settings, batch and jobs.
    - The real process (ready line, loopback bind, `--exit-with-parent`).

- **M3: portable engine bundle.** `engine/server/scripts/bundle_engine.sh [OUT]` writes to `out/engine` by default.
  - Layout:
    - `python/`: the uv-managed CPython 3.12, trimmed.
    - `venv/`: built with `uv venv --relocatable` and installed from `uv.lock`, non-editable and precompiled. Its `python` symlinks are made relative.
    - `bin/fvwks-engine`: the launcher (`-I -B`, same flags as the dev entry point).
  - Verified: it builds in about 30 s (226 MB with today's dependencies), moves into `FoxBox.app/Contents/Resources/engine`, and runs under `env -i`. Health, token and `--exit-with-parent` all work.
  - Test: `FVWKS_TEST_BUNDLE=1 pytest server/tests/test_bundle.py` (skipped by default).
  - For S4: copy the bundle into the app's Resources and spawn `Resources/engine/bin/fvwks-engine --port 0 --token T --data-dir "~/Library/Application Support/FoxBox" --exit-with-parent`. The export root then defaults to `~/Music/FoxBox`.
  - Models aren't bundled. The voice stub's fixtures aren't bundled either, so a portable build only makes sense after S1 and S2 integrate.

- **Model downloads** (the coordinator approved opt-in models):
  - `POST /api/models/{id}/install` is a real background job: `install` lane, one download at a time, deduped per model. It reports progress and can be cancelled.
  - Before starting, it checks that free space ≥ size + 5 GB. Otherwise the job fails with `disk_full` and a hint.
  - `GET /api/models` comes from S1's `list_models()`.
  - Hooks and signatures are in `contracts/proposals/S3.md` P1 (sent to S1). `VoiceError` code, status and hint pass through to the HTTP error.

- **v0.1-contracts merged** (the coordinator integrated S3 into `main` at `fa67805`).
  - `SourceInfo.bpm`, `warnings` and `analysis_state` (read live from the library) are filled. `Take.source_id` is filled.
  - `ExportResult.warnings` covers skipped stems and clipped samples.
  - Stack voices reuse `SourceInfo.bpm`.
  - `POST /api/script/preview` calls S1's `preview_script` hook (the pre-v0.1 signature without `bpm` still works), and hook errors pass through.
  - Recommended voices' audition clips are pre-rendered in the background after `warm_up` (S4 #4). The other voices render on first GET.
  - `GET /api/personas/candidates/{id}` and the design → candidate → save flow are tested with fake hooks.

- **Review fixes** (`3cd2ac1`), from an independent code review (7 confirmed defects, all fixed with regression tests):
  - Source GC never deletes recordings or sources that renders use. It's one indexed SQL query.
  - Final renders re-export when the export root or format changes.
  - `target_path_root` is validated.
  - The token is checked before any body is read, and the docs routes are off.
  - Renders are idempotent across restarts and concurrent requests.
  - Control characters can't break the XML, and the bundle script won't `rm -rf` a folder it didn't create.
- **Integration i1 merged** (real S1 Kokoro + S2 rack). The engine suite passes with the real engines, except S1's lexicon test, which S1 owns.
  - `tail_s` is the end of the last word, written as the memory cue "VOICE OUT".
  - Real stems export as `stem:*` files.

- **Robustness pass 2** (`745f280`, `6864923`, `f112ac0`, `aeb7d62`):
  - An unplugged export drive no longer breaks the Vault or `GET /api/renders`. Final renders still return and become takes, with a "Not exported" warning.
  - A failing voice `configure()` doesn't stop the engine; health reports it.
  - Settings are cached in memory.
  - Exports reserve their version under the lock and encode outside it, so a Setlist export never blocks an interactive one.
  - Waveform peaks are vectorized (identical output, about 6× faster).
  - Stale `.part` temp files are swept at start-up.
  - Stream copies have a 256 MB LRU budget.
  - One voice gate per model (Kokoro and persona), and uploads take no model lock.
  - Verified against S1's `db1bb79` (trial merge): the real persona design → save → TTS → render flow works over HTTP, and the espeak deep-path bundle test passes. That test is xfail only while `fvwks_voice.espeak_path` is missing.

- **Review pass 3** (`701d46c`, `0108745`), from two independent reviews: the engine's concurrency code, and the Electron app's real use of the API. Every fix has a regression test (146 server + contract tests, stable over 3 runs).
  - Write failures (libsndfile, mutagen, OS) map to `export_failed`/`disk_full`. Finals keep their take and return "Not exported". No half-stored renders.
  - `analysis_state` resets at start-up (fx's analyses are in memory) and is re-queued on first use. Preview cache keys include analysis readiness.
  - Saved Settings (master; default bpm/bars/key) fill the render fields the client didn't send.
  - A newer preview of a line supersedes one still waiting (409 `superseded`).
  - A Setlist keeps its export root.
  - The stack prefetch has its own lane.
  - Settings save while the drive is unplugged; the settings cache race is closed.
  - Exact per-key locks; reused previews count as recent for the GC.
  - Health errors clear after a successful synthesis.
  - Persona auditions use the saved clip; ETags are stable; identical uploads are deduped.
  - A new export folder can't be home, `/Users`, `/Volumes` or a hidden folder.
- **Cross-review of S4** (sent to S4):
  - Security: the token is on argv (use the `FVWKS_TOKEN` env); the ExportGuard trusts echoed JSON strings; PNG icons are decoded in main; `uv sync` runs without `--locked`; plus small items.
  - Integration: 7 app-side findings.

- **Exit crash fixed** (the coordinator's priority bug: the server tests passed, then exited 139).
  - **Cause, an MLX 0.32.2 bug.** MLX keeps a compile cache per thread, and its exit hook clears only the cache of the thread that first imported `mlx.core`.
    - S1 imports MLX lazily, so in the suite a TestClient worker thread imported it.
    - Then `test_v01_prerender_recommended_auditions` ran Kokoro on the main thread, and later workers called the same compiled functions (`mlx.nn` activations).
    - The main thread's cache entries were destroyed inside `exit()`, after Python had finalized. Their destructor takes the GIL, so the process crashed.
    - Crash report: `CompileCache::CacheEntry::~CacheEntry` → `PyGILState_Ensure`, from dyld's thread-local finalizers.
    - Minimal repro: 10/10 exit 139, and 0/10 once `mlx.core` is imported on the main thread first.
  - **Fix:** `EngineService` imports `mlx.core` on the main thread when it's built (`bind_native_exit_hooks`). `server/tests/conftest.py` does the same at collection, for combined runs.
  - **Deterministic shutdown:**
    - `close(timeout=3)` cancels and joins the job lanes and the start-up thread (bounded), then closes the library. It runs from the FastAPI lifespan.
    - Audition prerendering stops at the next voice.
    - Tests enter every TestClient's lifespan, and each engine is closed and joined after its test.
  - **SIGTERM:** uvicorn shuts down gracefully (lifespan → `close`), then re-raises the signal. The engine therefore exits with SIGTERM's status, before any native exit-time destructor can run. Tested after real TTS + render (library closed, WAL removed) and during warm-up (exits in under 10 s).
  - **Regression tests** (`test_exit.py`, in subprocesses):
    - The MLX pattern through `create_app`; it fails with the fix disabled.
    - The exact server-test pattern with real Kokoro.
    - Before the fix, 4/4 suite runs exited 139. After it, 5/5 exit 0 (156 tests).
  - **A flaky test this exposed:** the stack prefetch now synthesizes all its voices before analysing any. A slow main-voice analysis holding the background fx lock no longer delays them.
- **pyrekordbox read-back** (user-approved, tests only):
  - `pyrekordbox==0.4.4` (MIT) is in the server's `dev` dependency group. It's never bundled, because the bundle exports with `--no-dev`.
  - Our rekordbox.xml parses back with the collection, TEMPO (Inizio 0, Bpm, 4/4, beat 1), POSITION_MARKs (the VOX hot cue A with its colour, the VOICE OUT memory cue) and the TrackID playlist.
  - Our `Location` is byte-identical to what pyrekordbox writes for the same file, and retargeted Windows and other-Mac roots decode correctly. There's also an end-to-end test through the API.
  - Optional helper `scripts/rekordbox_anlz_check.py`, read-only:
    - After you import our XML into Rekordbox, it finds Rekordbox's ANLZ files for our tracks, by their embedded path or, on a USB export, by name.
    - It checks the grid (beat 1 at 0.000 s, our BPM) and the cues.
    - It never opens `master.db` or `export.pdb`.
    - It's tested against synthetic ANLZ files. Rekordbox isn't installed on this Mac, so it hasn't met real analysis files yet.

- **v0.2 AUTO bars** (`ef21c58`):
  - `RenderInfo.bars` is the count the render actually used: `RenderOutput.bars` (fx resolves `"auto"`), else the request's own integer. An `"auto"` render that fx didn't report is read off its exact N-bar length. FREE stays None.
  - Filenames, `ExportedFile.bars`, `Take.bars` and rekordbox.xml use the resolved count. The TXXX render tag keeps both `"auto"` and the resolved count.
  - Alt-preset and stem re-renders are pinned to the resolved count, so variants stay sample-aligned with the original.
  - Settings, batch lines and the batch default pass `"auto"` through unchanged.
  - fx stays the single source of truth; there's no server-side AUTO. Until `fvwks_fx.api.AUTO_BARS` exists, the server tests stand in for fx with the shared `resolve_auto_bars`. A real-rack test activates once it does.
- **v0.3 recordings** (`3ef4425`):
  - **Upload `denoise`:** passed to `ingest`. A voice package without it gets a warning instead.
    - `SourceInfo.denoise` is filled when ingest doesn't report it.
    - Ingest has its own model gate, so an upload never waits for TTS.
  - **Background transcription** (lane `transcribe`, aligner gate, background priority): runs for recordings and imports when the voice package can transcribe and `whisper-aligner` is installed.
    - `transcript_state` is a column (schema v3), stored and shown live.
    - A missing model leaves the state at `none`. Installing the model queues every waiting recording. Other failures stay `error` rather than retrying.
    - An unfinished job starts over on first use after a restart.
  - **`PUT /api/sources/{id}/transcript` → `realign`:** TTS sources get 400, a missing hook 501, and VoiceError codes pass through. The user's transcript always wins: a queued job is cancelled, and a running one finishes first and is then replaced.
  - **Render cache:** keys include the source's script and segments, so a new transcript re-renders instead of serving a stale preview.
- **Persona candidates stream** (`4082eb6`): each candidate the design yields is stored and listed as it arrives (about 3 s apart, instead of all three after about 14 s).
  - A cancel stops the design between candidates, and the generator is closed.
  - The persona gate is held per candidate.

- **SIGNAL + AUTO NaN** (`ef12ebb`): the NaN was app display math (`'auto' * 240` before any render), already fixed in S4's Phase 2.1.
  - An HTTP sweep of 252 SIGNAL renders at AUTO (7 lines × 60–200 BPM × macros, preview and final) found 0 NaN/Inf in the engine.
  - A regression test keeps it that way.
- **First-run model readiness** (`634c855`):
  - Required models (Kokoro, deepfilternet3) install on first launch through the install jobs, before warm-up.
  - Health shows `loading_model` with one progress bar over the downloads and the installer's message. Opt-in models stay opt-in.
  - If the voice model's download fails, health is `error` with the download's own message.
  - If only the denoiser fails, the engine is `ready`, and health says what's missing. A retry clears that note.
  - Uploads without the denoiser are kept as recorded, with a warning.
  - Proposals: P5 `Health.missing_models`; P6 `ModelInfo.install_job_id` and `install_needs_bytes` (for the model screens, item 3).
- **Review of S4 Phase 2/2.1** (sent to S4): the Phase 1 fixes hold.
  - **High, integration:** the packaged app is "linked" to the dev checkout plus uv, so a fresh Mac has no engine. I proposed shipping `bundle_engine.sh`'s portable engine in Resources, with HF_HOME under the data dir.
  - **Low:** packaged builds honour FVWKS_MOCK and the dir overrides; `window.open` allows any https URL; the vbx:// id regex is loose.

- **Installer and updater support** (v0.4/v0.5; `788d4f3`, `7055a28`, `5d746ac`, `4c124dc`):
  - **Install jobs** report `bytes_done`, `bytes_total`, `rate_bps` (smoothed), `eta_s` and `current_item`.
  - **`ModelInfo`:**
    - `install_job_id` (the running install, first-run ones included) lets model screens reattach.
    - `install_needs_bytes` is the figure the disk guard uses.
    - The version fields pass through from S1's registry.
  - **`Health.required_missing`** is filled.
  - **`RenderInfo.motion`** passes through from fx.
  - **Bundled mode, engine half:** the app will launch `Resources/engine/bin/fvwks-engine` (marker `.fvwks-engine-bundle`) with no uv, `FVWKS_TOKEN` in the environment and `HF_HOME=<data dir>/models`.
    - The opt-in packaged-layout smoke tests cover: ready + render + clean SIGTERM, and a fresh Mac offline (error with the network hint, `required_missing`, no crash).
    - They found that a missing HF_HOME made every first-run install fail. The engine now creates it.
  - **Proposals:** P7 `ApiError.model_id`; P8 `DELETE /api/models/{id}`; P9 a signed model-update manifest (fetched by the app's updater on opt-in, verified by the engine).

- **v0.6 and shipping** (`9e6f48e`, `5be6728`, `9be80e0`, `5e1e7e5`, and this commit):
  - **P7:** `model_not_installed` errors name the model (`ApiError.model_id`, passed through from S1's VoiceError).
  - **P8:** `DELETE /api/models/{id}` goes through S1's `uninstall_model`.
    - Errors: 404 unknown; 409 `model_required`; 409 `model_busy` while downloading. S1's own refusals pass through.
    - It holds the model's gate, so work in flight finishes first.
  - **P9:** `PUT /api/models/manifest` takes a signed manifest.
    - The signature is ed25519 over the manifest's canonical JSON, checked against the release key embedded in `fvwks_server/manifest.py` (`foxbox-1`).
    - Refusals: 403 untrusted; 422 newer schema; 409 older than the one in use (no replayed rollback).
    - S1's hook applies the new pins. An installed model with an update now downloads it.
    - Release tool: `scripts/sign_manifest.py`. The private key is at `~/.config/foxbox/manifest-signing.key` (0600) and never in git.
  - **Fresh-Mac first launch, the real one:**
    - Set-up: the bundle in `FoxBox.app/Contents/Resources/engine`, with an empty HF_HOME and the real network.
    - It found that Kokoro's loader looked up the unpinned `refs/main`, which a pinned download never writes. Warm-up failed on every fresh Mac.
    - With S1's fix (a50df21), it's `ready` in 14.5 s after downloading 365 MB.
    - A no-network regression test pins it down.
  - **Platform:** the bundle needs macOS 14 on Apple Silicon (mlx, numpy and scipy wheels are macosx_14_0_arm64). It's 822 MB.
  - **Renamed to FoxBox:**
    - Data dir `~/Library/Application Support/FoxBox`; default export folder `~/Music/FoxBox`.
    - rekordbox PRODUCT `FoxBox` / `SmittyTech`; file tags `FoxBox`.

## Performance (HTTP, real engines, M3 Pro; `uv run --all-packages python server/scripts/bench_http.py`)
| what | p50 ms | p95 ms |
|---|---|---|
| TTS, phrase lengths already seen | 529 | 757 |
| TTS, new phrase lengths (see the correction below) | 5,148 | 8,773 |
| Preview, first per preset | 491 | 811 |
| Preview, warm (knob moves, 7 presets × 4/8 bars) | 254 | 381 |
| Final render + auto-export AIFF | 1,037 | 1,448 |
| Preview while a Setlist batch renders | 173 | 213 (was 1,961) |
- Every final is at −7.0 ±0.05 LUFS short-term max, with true peak ≤ −1.02 dBTP and an exact sample length.
- WORLD analysis is ready about 0.1 s after TTS returns. A render racing it took 511 ms; the first render after it, 450 ms.
- **Changes from this pass:**
  - Separate interactive and background fx lanes, so previews no longer wait behind batch renders.
  - A priority lock on the voice model: interactive TTS goes before background synthesis.
  - Background prefetch of the stack voices for the newest line, plus their WORLD analysis. The first PACT preview dropped from 1,189 to 435 ms.
  - Final masters are stored as FLAC-24 (about 1/4 of float32).
  - `preview_keep` is 12 and the artifact cache is 256 MB. Disk after the benchmark: 286 → 95 MB.
- **Correction (S1's profiling):** the slow TTS tail was mostly GPU contention, not per-shape compilation. A background Blender render was using this Mac's GPU (40–98 % utilization) while I measured. The real first-call cost is small: 0.5–1 s for each of the first 2–3 size classes. S1's `warm_up()` now compiles a spread of lengths on the US and UK pipelines. The render numbers are CPU-bound and were measured under the same background load.
- **Portable bundle + espeak-ng long paths:** `test_bundle.py` (opt-in `FVWKS_TEST_BUNDLE=1`) moves the bundle into a deliberately deep `…/FoxBox.app/Contents/Resources/engine`, where the espeak data path is over 160 characters. It then runs a TTS that needs the espeak fallback.
  - Marked `xfail` until S1's short-path fix lands.
  - Failure today: espeak-ng rejects the long path, falls back to its compiled-in CI path (`/Users/runner/work/espeakng-loader/…/phontab`) and calls `exit(1)`, so the whole engine dies during warm-up.
  - The relocation test itself passes with the real dependencies.

## Notes for other sessions
- **S1:** optional hooks (`warm_up`, `install_model`, `design_persona`, `save_persona`, `list_models`, `ENGINE_VERSION`) are listed in `contracts/proposals/S3.md`. The server uses them when they exist. Voice calls are serialized by the server.
  - Any other host of `fvwks_voice` (scripts, test suites) should import `mlx.core` on its main thread before a worker can, or it risks the exit crash above.
- **S2:**
  - Calls to `fx.render` and `fx.analyze` are serialized by the server, so they don't need to be thread-safe with each other.
  - `analyze()` runs in the background after each new source.
  - Stems are exported only for the names `dry`, `voice`, `layers`, `fx`.
  - `ENGINE_NAME` and `RACK_VERSION` salt the render cache.
- **S4:**
  - Send only the `Arrange`/`Master` fields the user changed, so preset hints (GHOST's `first_word_beat: 4`) apply.
  - Pass `--export-dir` if the data dir isn't the standard app-support folder.
  - Errors always use the `{error: {code, message, hint, retryable}}` shape, including unknown routes (404) and crashes (500 `internal_error`).
  - On SIGTERM the engine closes cleanly within about 3 s, then exits with SIGTERM's status (uvicorn re-raises the signal). Don't treat that exit as a crash when the app stopped the engine itself.
- RIFF INFO is written by our own chunk writer after `data`, not through soundfile's string fields. This keeps the 44-byte canonical header (`data` at byte 36) that naive WAV readers assume. libsndfile reads the fields back, and a test checks this.
