# S3 ENGINE SERVER: status

Branch `session/s3-engine`. `v0-contracts` is merged. The OpenAPI drift test is green (the route signatures are untouched).

## Done
- **M1: contract-independent modules**
  - `writer.py`: AIFF/WAV writing.
    - AIFF by default, or WAV, 24-bit via soundfile. 16-bit output gets TPDF dither.
    - Canonical WAV layout: `fmt ` (tag 0x0001) at byte 12, `data` at byte 36, then `LIST/INFO`. Any extensible (0xFFFE) header is rewritten.
    - Tags: ID3v2.3 in AIFF (TIT2, TPE1, TALB, TBPM, TKEY, COMM, TXXX:FVWKS_RENDER JSON, TYER, TSSE, APIC cover art). RIFF INFO in WAV (INAM, IART, IPRD, ICMT, ICRD, ISFT).
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

- **1.0 release fixes** (`fda0feb` and this commit):
  - **Signed app stays sealed:** the bundle's .pyc files are unchecked-hash and the launcher sets `PYTHONDONTWRITEBYTECODE=1`, so first launch no longer rewrites 413 .pyc files inside the app. The opt-in bundle tests check the bundle is byte-for-byte unchanged after a launch.
  - **Cover art:** every exported AIFF (wet, dry, alts, stems) carries the FoxBox fox as APIC (front cover, `image/jpeg`, desc `FoxBox`).
    - The art is `fvwks_server/assets/cover.jpg`: the brand icon flattened on black, a 600×600 baseline JPEG, 32 KB. The bundle's smoke test loads it.
    - WAV gets none (RIFF INFO has no art field Rekordbox reads).
    - No `embed_cover_art` setting: it would be a contract change. The writer takes `ExportMeta.cover=None`, so a future setting is a one-line wire-up.

- **v0.7 songs** (this commit): the user's own tracks to put drops over.
  - `POST /api/songs` decodes WAV/AIFF/FLAC/MP3 with soundfile, keeping the file's own rate and channels (mono or stereo).
    - Limits: 400 MB and 15 min. Errors: `unsupported_format`, `song_too_long`, `file_too_large`.
    - The same audio imported again returns the same song.
    - The audio is kept under `<data>/songs/` as FLAC-24 (bit-exact for 16/24-bit files), or float WAV if it goes over full scale. `audio_id` (`sng_…`) streams from there.
  - **Analysis:** a background `song_analysis` job (lane `songs`, so voice analyses never wait) calls `fx.analyze_song(audio, sr)` and stores `analysis`/`analysis_state`.
    - A job the last process never finished starts again at launch.
    - Without `fx.analyze_song` the state is `error`; mixing then needs the overrides.
  - `GET`/`PATCH`/`DELETE /api/songs/{id}`:
    - PATCH applies only the fields sent; null clears an override. Keys are normalised (`f# minor` → `F#m`).
    - DELETE also drops the song's mixes and cancels its analysis.
  - `POST /api/mix`:
    - Grid: bpm = override or analysis; bar 1 = override or analysis; a bar = beats_per_bar·60/bpm.
    - The drop starts at bar 1 + (at_bar−1) bars. The excerpt is start_bar/end_bar on the same grid, clamped to the song.
    - Errors: 409 `song_not_analyzed` (retryable while the analysis runs), unless the overrides give both BPM and bar 1. 422 when the drop is past the end or outside the excerpt.
    - `fx.mix_song` gets the render's wet audio and the render's Master. Mixes are cached by (render, song, grid, placement, quality, master); the newest 8 are kept.
  - **Baked exports:** with `ExportRequest.bake`, each render also writes variant `baked`, the final-quality mix.
    - Title `<title> (baked vNN)`, with the song's BPM and key, bars free, and the fox cover.
    - The first-word/tail cues are shifted to where the drop sits.
  - Library schema v4: `songs` and `mixes` tables.
  - Tests use stub `analyze_song`/`mix_song` until S2's land.

- **1.2 component updates: the bundle is split** (this commit):
  - Layout under `engine/`: `runtime/` (python/, venv/ with every third-party package, requirements.txt), `code/` (fvwks_* packages + assets, ~2 MB, no dist-info), `bin/fvwks-engine`, `components.json`, `MANIFEST.txt`.
  - `runtime/venv/.../site-packages/fvwks-code.pth` holds one constant relative line to `../code`, so the runtime records nothing about our packages. Swapping `code/` alone works.
  - `components.json`: `{"runtime": sha256, "code": sha256}`, each the sha256 of the component's sorted manifest (path, exec bit, content sha256; symlinks by target).
    - A `.pyc` counts by its 16-byte header (magic + source hash): marshal isn't byte-stable (1 scipy test pyc in ~20k differed between builds).
  - Two clean builds from the same uv.lock give the same runtime hash; a code-only change moves only the code hash. An opt-in bundle test checks this with a second build.
  - S4's updater swaps components in a re-signed staged copy of the app (never inside the running app), so the seal stays valid.


- **1.2.4 ARRANGE chop (v0.8)** (fx arrange by coordinator ruling, this commit):
  - `plan_placement(..., chop, chop_unit, chop_slots)`: with chop on, the line is cut per word (a segment without word timings counts as one piece) or per '|' chunk.
    - Each piece's onset (the engine's onset convention: 1 ms pre-roll) starts exactly on its slot: every beat, every 2 beats or every bar from 0 (consecutive), or at custom beats. A custom piece without a slot follows the previous one at the natural spacing.
    - A piece is squeezed (R3, per piece, within max_stretch; none in pad mode) only when its speech would run into the next slot. Past that, the next slot slides to the next free grid step (a beat for custom). Speech is never cut.
    - Pieces get 5 ms fades and keep up to 150 ms of natural release, cut at the next slot.
  - Length: the bars that hold every piece + auto_tail + tail beats. AUTO picks the next standard count; a numeric count too short is extended (never cut); FREE is whole beats.
  - `RenderOutput.chop` → `RenderInfo.chop` (index, landed beat). Each piece is a `beat_lock` motion event. The chop fields are in fx's plan cache key and the server's render key (the whole arrange block).

- **1.4 VISUALS: song stems (v0.9)**:
  - `POST /api/songs/{id}/stems` → a `song_stems` job (lane `songs`): S1's `separate_stems` (HT-Demucs) under a new `stems` voice gate, then S2's `stem_features`.
    - Stems are content-addressed by the song's audio and the separator (`voice.STEMS_ENGINE` or the voice digest), so asking again is instant.
    - They're stored in the songs folder as `sgs_` FLAC-24 with one shared headroom gain (Demucs stems overshoot to ±1.6; the balance is kept, ~¼ the size of float WAV). `Song.stems` gives their audio ids for playback.
  - `GET /api/songs/{id}/stems/features` → `StemFeatures` (60 fps, drums/bass/vocals/other/mix × (rms, onset)), cached and recomputed from the stored stems if the cache was pruned. 409 `stems_not_ready` before; 501 without the hooks.
  - An unfinished separation resets to `none` at launch, and deleting a song deletes its stems.
  - The real test song (2 min 24 s): 14 s end to end, 8,644 feature frames, a second request 1 ms, stems 20–30 MB each.

## 1.5.0 SMART VISUALS: handoff (S3 ENGINE + FX, branch `help/s3-smart`)

Scope (from the PM):
- Server: Song.structure and lyrics.
- The ISF standard uniforms for build, drop and bass, used in every shader and filter.
- At least 4 smart ISF effects.
- The TEXT family ("text right before a drop").
- The MILKDROP drop switch.
Send the shas to S4 and the PM when each part lands.

**Done**
- **`c3dda56`, server** (merges main 644cbd2 v0.10.1, help/s2-smart 8da928a, session/s4-app 68c951c):
  - Song.structure:
    - Computed with the analysis via `fx.song_structure`, on the song's grid (the BPM/bar-1 overrides when set).
    - Refined with the stems at the end of song_stems (`from_stems`).
    - Computed again after a BPM/bar-1 PATCH, and backfilled at start for songs analysed before 1.5.
  - Lyrics routes:
    - `POST /api/songs/{id}/lyrics` → song_lyrics job on the songs lane, so it runs after a stems job asked for first.
    - `GET` → SongLyrics, or 409 `lyrics_not_ready`.
    - With no transcription model, the POST answers 503 model_not_installed + model_id `whisper-aligner`.
  - Lyrics transcription:
    - `voice.transcribe` runs on the vocals stem (else the mix), resampled to 48 kHz.
    - It works in windows of up to 4 minutes, cut at the quietest half second, and skips silent windows.
    - The result is stored in `songs.lyrics` (library v5).
  - `StemFeatures.bass_b64` is passed through from `fx.stem_features`'s `bass` ((frames, 4) uint8).
- **`a9b9b8b`, SHADERS:**
  - Standard ISF inputs (loader.ts `FOXBOX_INPUTS`; the loader declares any a shader uses but leaves out): buildProgress, preDrop, dropHit (a ~¼ s pulse), dropEnergy, dropIn, dropIndex, section, halfTime, bassOn, bassHit, bassHeld, bassHold, bassSub, bassGrowl, bassPitch, bassGlide, bassWobble, bassWobblePhase, beatFlash, hasDepth and depthMask.
    - `cues.ts` holds the pulses and the ≤3 flashes/s beat strobe.
  - `imagePalette.ts` (colorthief 3.5.0): the `"FOXBOX_PALETTE": "extract"` filter publishes `imagePalette()`, and ISF styles follow it.
  - Smart filters: depth-focus (S1's near mask comes via S4's `frame(a, dt, input, extras)`), motion-trails, palette-from-image, beat-strobe and bass-wobble.
  - All 16 generators and 10 filters now build, drop and follow the bass.
  - Fixed FEEDBACK TRAILS and DATAMOSH: they read the texture they drew into, a WebGL feedback loop. A copy pass fixes it.
  - troika-three-text 0.52.5 is installed. Both packages are reported to the PM, who credits them in THIRD_PARTY_NOTICES on main (don't edit that file).
  - The compile check: `node <scratchpad>/isfcheck/check.mjs [name]`. It compiles and draws every pack shader in headless Chromium through the loader. The scratchpad is /private/tmp/claude-501/…/92fddaa3…/scratchpad.

**Also done**
- `8eb83b4`, TEXT family (`engines/text/`, family `text`):
  - Styles: DECRYPT / SLAM / COUNTDOWN / SHATTER are generators; STENCIL is a filter.
  - Timing lives in `track.ts` (`moment`, `typedTrack`, `placedWords`, `latin`), with a test in `textTrack.test.ts`.
  - Fonts are inlined .woff files handed to troika as blob: URLs (S4 added `connect-src blob:`).
  - Settings: `useWorker: false`; Latin only; `text.sync()` every frame (an empty Text is frustum-culled, so troika never synced).
  - A headless render check of all 5 styles passed.
- `9512a56`, MILKDROP drop cuts:
  - A hard cut on `dropHit` to `HIGH_ENERGY_PRESETS` (16, measured), at most once a bar.
  - The N-bar soft cut picks high-energy presets during a drop.
  - TEXT treats a word spanning > 30 s as untimed (S4's drop-script convention).
- Open: first-use glyph generation for a font runs on the main thread, which may cause one small hitch the first time a TEXT style shows. It was fast on a real GPU; add `preloadFont` if it shows.

**Standing rules** (on top of the ones at the top of the summary/memory):
- Ponytail at level full: read `~/.claude/plugins/cache/ponytail/ponytail/4.10.0/skills/ponytail/SKILL.md`. Take the shortest correct diff, fix at the root cause, add no unrequested abstractions, and leave one runnable check.
- Downloads under 1 GB need no approval; over 1 GB needs the user's OK. Report every new package or model to the PM.
- Approved OSS picks: troika-three-text (TEXT), color-thief v3 (palette), and projectM's cut logic as the model for MILKDROP. Avoid React Bits DecryptedText (Commons Clause).
- JS-only dependencies (never Python: it would change the 293 MB engine runtime). Pin them exactly. Don't edit THIRD_PARTY_NOTICES.
- Stay off S4's files: registry.ts, stage*, styles/**, clip*, output*, state/visuals.ts, LiveVisuals.tsx and the camera files. Tell S4 the exact lines touched in main/preload/shared/csp.
- Never push. Publishing goes only through `scripts/publish_snapshot.sh` (the PM). Commit trailer: Claude Opus 5.5.

## 1.6 REMIX server (branch `help/s3-remix` = session/s4-app a8dce76 + help/s2-bassdna + main (contracts v0.11.4) + help/s1-als)
Spec: the route table in `docs/REMIX_BACKEND.md` (v0.11.4). S2 owns `fvwks_fx.remix` (`run`, `clip_key`, `mash_features`, `mash_scan`). S1 owns `fvwks_synth` and `fvwks_server/als.py`. My part is the routes, the jobs, the library and export.

Every route in the table is done:
- `POST /mash/scan` → `MashScanResult {matches, missing}`.
  - Synchronous and reads cached npz only. `_cache_mash` runs wherever the structure is computed.
  - Songs without cached features go in `missing` and are queued.
  - `borrow` is handled inside S2's scan (fb8c13b).
- Remix CRUD: schema v6 `remixes` table (`info` = Remix JSON, `export` = the last RemixExportResult).
  - PATCH needs `rev`; otherwise 409 `remix_conflict`.
  - `_keep_prepared` keeps a clip's audio_id only while it sounds the same. The client's audio_id is never trusted.
  - Create stores `mash` and starts stems (or queues MASH features) for the sources.
- `POST /remixes/{id}/build` (remix_build, `remix` lane): `run(stage="build", match=Remix.mash)`, then a new rev. The match run() picks when mash is None is saved on the Remix.
- `POST /remixes/{id}/prepare` (remix_prepare): progressive.
  - Clips are resolved first by `clip_key` from the cache (kind `remix_clip`).
  - The rest come from `run(on_clip=)`. Each lands on the latest arrangement as it's ready, stored as `rmc_` FLAC-24 in `song_audio`.
  - No rev bump. The message says "Ready to play" once the first 16 bars are ready.
- `POST /remixes/{id}/export` (remix_export) plus `GET /remixes/{id}/export`.
  - Mixdown at `Master()` (44.1 k), with every clip's stored audio passed in.
  - Files: AIFF-24 (`writer.write_track`) and MP3 320 (pedalboard's LAME), in `<export root>/<title>/`, recorded as `exports` rows with `render_id` = the remix id.
  - `.als`: S1's `write_als(remix, {clip_id: path}, folder, name=)`. A failure there is a warning, since BETA.
  - `visuals`: registers the mix as a Song on the remix grid, with sections, drops and builds from the arrangement, and caches its MASH features.
- `GET /patches`: `preview_audio_id` = `pvw_…`. `/api/audio` renders it through `fvwks_synth.preview.preview` on first play.
- `GET /kits` (v0.11.5: `preview_audio_id` = a lazy `pvw_` kit audition) and `GET /flip-styles`: S2's `FLIP_STYLES`.
- Export also writes `rekordbox.xml` next to the AIFF (v0.11.5): TEMPO at bar 1, hot cues A… at each DROP, memory cues at every section (`RekordboxTrack.cues`).
- `GET /songs/{id}/bass/groove`: `fx.bass_groove` on the bass stem, half time from its section, cached JSON.
- `POST /grooves/render`: `fvwks_synth.bass.render_groove`, cached as `rmc_` audio.
  - 409 `synth_unavailable` for a Surge patch without surgepy; 404 for an unknown patch.
- Startup: `fvwks_synth.bass.configure(<data>/synth)`.

Tests (one per area): mash scan, CRUD/rev, build → prepare → export → Song (the real pipeline, .als included), and the sound library + BASS DNA.

Not done:
- A source song's grid changing after prepare: its clips keep their audio until re-prepared. ponytail, in `_keep_prepared`.

Song import: the server decodes WAV/AIFF/FLAC/MP3 (libsndfile 1.2.2). Anything else gets 400 `unsupported_format` with a hint. The app decodes M4A/AAC before upload.

Test launches: bundle id `com.smittytech.foxbox.test.s3`, CDP port **9313** only. Quit by PID only.

## 1.6 REMIX sound design (branch `help/s3-growls`, on session/s4-app; main has no fvwks_synth yet)
The spec is `docs/REMIX_SOUND_BIBLE.md` on main. The split (the PM's):
- **S3:** the sub split, the shared midbus, the TEAROUT voices, and the QA additions (#12).
- **S1:** riddim R1/R2, the 808 / dark hit and ear candy, in its own new files (help/s1-riddim).
- Commits:
  - `bdf1f73`: **midbus.py**, shared by S1 and S2.
    - `lr4`, `distort` / `clip` (4x oversampled), and `ott` (the Faust model with the §1.3 numbers: stereo-linked detector at a 16-sample control rate, starts settled).
    - `phaser` / `flanger` / `freq_shift`, `notch_whistles`.
    - `midbus(x, sr, preset, bpm)`, the §1.2 chain, level-matched per stage. Presets: print / chomp / talker / bus.
    - `sub_hz` (30–60 Hz) and `sub_voice` (the clean gated sine SUB).
  - `7eb0fab`: **foxsynth sub split** (S1's file; they know). Non-808 patches get a mid LR4 high-passed at 120 Hz over a clean sine sub. The width layer is HP 150.
  - `3357dfe`, `bad2176`: **TEAROUT voices** (§2.2), `render_growl(style, midi, beats, bpm, sr, variant, sub, hit)`. Styles: chomp (A), talker (B), disperser (C), dive (D), pwm (E).
    - Per-hit states are seeded by (voice, variant, hit).
    - `_finish_voice` sets the mid at -13 dBFS RMS over the clean sub, with raised-cosine fades.
  - Legacy styles: tearout / riddim / yoi / 808 / reese / metal / gunshot (v2 engines). riddim / yoi / 808 are to be routed to S1's r1 / r2 / render_808 when those land.
    - Routing: r1 and r2 go through the growl post; 808 / darkhit go straight to S1 (no post).
  - `9508e97`: `python -m fvwks_synth.growls --audition DIR` writes 4-bar loops (tearout grid + each voice alone, a held sub, drums, -7 LUFS short-term).
    - They're in the main checkout's out/growl-audition/ (README-S3.txt), shared with S1's loops.
- QA:
  - `qa()` counts clicks at the joins (an edge sample > -60 dB re peak), per the bible's "detector on the edges of every slice".
  - The old HF-concentration rule can't tell a hard-driven growl's texture or a bright onset from a click (tried and measured). The interior is reported as `hf_events` (texture).
  - `scripts/remix_qa.py` (main, `510048f`) counts clicks mix-wide, with the buzz rules.
- The per-hit clicks S2 found were fixed at their sources (`b5cc3c1`):
  - the midbus phaser zippered (it's rebuilt without a feedback loop);
  - OTT looks ahead by its attack;
  - dive's drive sits before its delay loop.
- Click detector rule (`820660b`, and `remix_qa.py` `371ec58`): buzz is local regularity. 3+ evenly spaced events under 30 ms, at any pitch, plus lone edges 1–3 periods off a train.
  - S2's headline sequence reads [0, 0, 1, 0] per 8 bars. The original drop reads 0.
  - Known blind spot: a pop with two edges within 10 ms.
  - Chomp hits are checked at their joins only; their onset snap is "the click" by design.
- #12, the §5 QA checks, is done: `remix_qa.py` on help/s3-remixqa `9183b5d` + `371ec58`, with `--style tearout|riddim|hybrid`. The PM is asked to merge it to main.
- Also done:
  - /api/masks, user-only (`f42b6cd`, help/s3-masks).
  - The step-3 OUTPUT re-check on e072e5f passes.

### Plan v1 → v2 round (2026-09-29)
- **help/s3-growls:**
  - `2414b2e` M1.3 `midbus.resample_chain` / `chain_a`: every generation kept, plus a stretch or pitch mangle. Printed crest is 7–13 dB and aliasing −110 dB. Also `resonance_notch` and `AXES` / `pick()`.
  - `0074395` M1.2 `gun` / `mgun`:
    - 80–200 ms metallic FM shots, then silence;
    - a 1/32 machine gun at ±1–2 st;
    - the notch on every growl; integer FM ratios on pitched growls.
  - `b81be86` M1.3 `printed_bank`: `hero` and `call` styles.
  - `a41ff2f` C11: dotted AXES ids and `render_growl(..., axes=)`.
  - `58c6535` C13: one OTT and one sub fold on my side.
  - `706ea48` M1.16: the midbus re-fade.
  - Pack: out/growl-audition-2/ (gun-1..4 are new). out/growl-audition/ is kept for the M1.1 verdicts.
- **help/s3-remix:**
  - `1465779` v0.11.7: seed.
  - `70ace00` v0.11.8: takes, feedback, prefs, choose().
  - `abacc41` v0.11.9: per-take arrangements, BUILD fresh, list filters.
  - `fd41189` plan v2 §7.3–7.4: latest rating per take, tag-scoped blame, w·θ with a 5% floor.
- **help/s3-remixqa:**
  - `5f28e33` stems grading.
  - `f447d49` M2.4.
  - `e650de0` plan v2 §8 targets, each check on its stem (bass, non-vocal, low-end owner).
- **help/s3-textskip** `90dd840`: TEXT frame() returns false with nothing on screen (merged by S4).
- **Open:**
  - The talker needles: no repro yet at any rate, tempo, note or chop (max 10.5σ on the 2nd difference). Asked S2 for the exact args.
  - C13's remaining duplicates are S2's (resample.ott, _sub_hz, _fold_c1, print_shot tanh, mixdown.loud 2×).
  - The Ableton OTT (AX-12) waits for its numbers.

## Handover (S3 stopped here)
- Branch `session/s3-engine`, latest `99f1b88`. Everything above is committed; main was merged at 55d9b2b (v0.7 contracts).
- Build the bundle: `engine/server/scripts/bundle_engine.sh <out>`. It fails on any file naming the build machine and prints the component hashes. Tests: `uv run --all-packages pytest server/tests contracts/tests` from `engine/`; the bundle tests are opt-in with `FVWKS_TEST_BUNDLE=1` (~2.5 min, two builds).
- Open:
  - Songs run against stub `analyze_song`/`mix_song`. When S2's land, import song-1 (local only, never in the repo) and mix it once through the real ones.
  - rekordbox.xml for `baked` files still anchors TEMPO at 0 s; a song whose bar 1 isn't at 0 needs its downbeat there.
  - An `embed_cover_art` toggle would need a `Settings` field (contract change); the writer already takes `ExportMeta.cover=None`.
- Pitfall: in these Claude shells `grep` is a wrapper that skips ignored and binary files. Use `/usr/bin/grep` or a Python walk for leak scans.

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
