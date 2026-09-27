# S4 APP — status (FoxBox)

Branch `session/s4-app` · owns `app/` · last update 2026-09-27 (FoxBox 1.0.0 release candidate)

## Where things stand
| Area | State |
|---|---|
| Scaffold (electron-vite 5, Vite 7, React 19, TS 5.9 strict) | done |
| Engine supervisor (spawn, READY-line port, health wait, restart w/ backoff, process-group kill, stale-pid cleanup, logs) | done, 11 unit tests against a fake engine |
| Preload bridge (contextIsolation + sandbox, no nodeIntegration, CSP meta) | done |
| Engine access: IPC proxy + `vbx://audio/<id>` | done (see "Deviations") |
| Typed client (openapi-typescript + openapi-fetch) from `contracts/openapi.yaml` | done: `npm run gen:api` |
| TanStack Query + Zustand stores | done |
| MSW mocks (contracts/examples + fixture WAVs + crude pitch/drive/bar-fit render) | done: `npm run web` / `npm run dev:mock` |
| Waveform + BarGrid + words + playhead + A/B + gapless loop (Web Audio) | done; Phase 2 replaced wavesurfer with the design's canvases: band-coloured waveform from the decoded render, reveal and morph sweeps, bar grid with lit beats |
| Recorder (askForMediaAccess → getUserMedia → AudioWorklet → 24-bit WAV, meter, 3-2-1 count-in, takes) | done; e2e records a synthetic tone through the real pipeline (worklet → WAV → multipart over IPC → engine ingest → render). A real mic is untested. |
| Import (engine formats as-is; others via decodeAudioData → WAV) | done; e2e covers both paths against the real engine |
| Re-render on release (150 ms debounce), stale dimming | done |
| Shortcuts (Space, ⌘↩, ⌘⇧E, `\`, L, M, 1–7, ⌘S, R, ?, Esc) paused while typing | done. EXPORT moved to ⌘⇧E in 2.1 because ⌘E is ECHO inside the script editor; M toggles the metronome (2.3) |
| Screens STUDIO / VAULT / SETLIST / VOICES / SETTINGS with the handoff component names | done; styled to the TRANSMISSION design (Phase 2). DOSSIER was dropped in 2.1 (user decision) |
| Drag-out (`startDrag`) from cartridge, export rows, Vault rows (multi) | done; e2e verifies dragstart → startDrag({file, icon}) with a real PNG icon and refuses unreturned paths. **The drop into Finder/GarageBand needs a manual check (computer-use access was declined).** |
| Contracts | on **v0.1** (merged `main` incl. S3's integrated server): partial arrange/master (hint rule), word ticks + now-speaking, script preview (SAYS line + warnings), analysis_state chip, persona candidates, `Take.source_id`, export warnings |
| Playwright Electron e2e (7 tests) | **7/7 passing against the real engine** (Kokoro-MLX voice + the FVWKS rack, v0.3; last run 2026-09-27, Phase 2.2). They cover the core loop (typing → auto-preview → ⌘↩ final → export sheet → WAV on disk with fmt tag 1), the drag chain, engine SIGKILL → restart → render again, record, import (+ conversion), a 5-line setlist → 5 files + playlist XML → Vault play + Rekordbox export, and every screen. Plus an opt-in `shots` spec for the design screenshots |
| Vitest | **123 tests in 20 files passing** (Phase 2.2), including: a whole-app jsdom smoke test; the model-install flow; macro→param values checked against the engine (S2's table); the export guard's S3 repro; the engine-epoch rule; Vault and Setlist against the mock engine; v0.3 (AUTO bars + the capability probe and fallback, clean-up, transcripts) |
| VOICES: model installs + persona designer | VOICES → MODELS lists every model the engine offers (Phase 2.2); install is a background job: size, free disk before/after (5 GB reserve), progress, cancel, `disk_full` with S3's hint, models/voices refresh on completion; persona designer uses `GET /api/personas/candidates/{id}` |
| Engine venv upkeep | the pill says INSTALLING ENGINE / UPDATING ENGINE while it runs (Phase 2.2); `uv sync --all-packages` runs automatically when `.venv` is missing, when any engine `pyproject.toml`/`uv.lock` is newer than the last sync (e.g. S3 added `mutagen`), and once more if a launch dies during startup |
| Packaging (electron-builder --mac dir, ad-hoc, fuses, mic usage string) | done; installed at `~/Applications/FoxBox.app` (v0.1 build), linked to `~/VoiceBox/engine` |
| Phase 2 (Claude Design bundle in `app/design/`) | see "Phase 2" below |

## Phase 2: the TRANSMISSION design (Claude Design handoff in `app/design/`)
Status: implemented across STUDIO, VAULT, SETLIST, VOICES and SETTINGS, plus the states from the brief and the addendum.
Screenshots live in `app/docs/screens/after/1512x982` and `after/1280x800`, captured against the real engine with
`FVWKS_SHOTS=docs/screens/after npx playwright test shots`. The pre-FoxBox sets (Phase 1, the prototype, and the
old-brand after/ set) were removed with the rename; the after/ set is retaken with the FoxBox brand.

### What was ported
- **Tokens and themes.** Every value lives in `styles/tokens.css` (`--vb-bg`, `--vb-panel`, `--vb-ink`, `--vb-dim`, `--vb-accent`, `--vb-amber`, `--vb-font-mono`, `--vb-font-display` and the rest).
  - One theme, TRANSMISSION. The DOSSIER alternative was dropped in 2.1 (user decision): no switch, no stencil/Courier fonts.
  - Canvases read the same palette from `visuals/theme.ts`.
- **Fonts.** Big Shoulders Display, JetBrains Mono, Courier Prime and Saira Stencil One, bundled as woff2 from `@fontsource` (OFL texts alongside). No CDN.
- **Visuals and motion.** Ported from `voicebox-engine.js` into `src/renderer/src/visuals/`, fed by real data instead of the prototype's synthetic voice. `support.js` and the mock logic are not shipped.
  - **Waveform:** band-coloured (low/mid/high one-pole splits of the decoded render), with reveal and morph sweeps, stale greying, played-part dimming and word labels from `Segment.words`.
  - **Bar grid:** beats light up during playback; loop shading; overflow hatching.
  - **Voice core:** a particle sphere driven by the output analyser and the four macros. Its labels show the resolved pitch and ring.
  - **LED loudness meter:** anchored to the render's measured short-term LUFS and true peak, and live while playing.
  - **Also ported:** the cartridge mini-waveform, the record orb/strip/level, the boot sequence and the screen wipe.
  - **Performance:** one shared RAF loop that pauses while the window is hidden. Nothing animates on the input path; knob drags, typing and renders never wait on a frame.
- **Reduced motion.** `prefers-reduced-motion` turns off:
  - the boot, panel reveals, screen wipes, knob tweens, drawer, toast and banner entrances, and sweeps (renders swap instantly);
  - the idle voice-core spin, the synthesis shimmer and the orb's idle arcs;
  - all CSS transitions.
- **Boot.** The boot screen is driven by the real start-up: engine pid, model-load progress from `/api/health`, lexicon, rack, BPM. Any key or click skips it, and it never waits more than 6.5 s. With `health.state = error` or an offline engine it prints `[ FAIL ]` and hands over to the banner.
- **Studio.**
  - **Auto-preview:** typing pauses → preview (the design's 1.3 s). RENDER (⌘↩) is the final render and auto-exports. EXPORT (⌘⇧E) hands over the final file; ▾ opens the full export sheet.
  - **Macro knobs:** tweened preset changes and double-click reset. Map rings come from the preset's `macro_map`, using S2's resolve formula (verified against engine values in `macros.test.ts`).
  - **Rack drawer:** the generic ModuleCard for every ParamSpec kind (knob, fader, switch, select, segmented, number stepper), closed-summary and advanced states, live values for macro-driven params, and the STACK voices.
  - **FIT:** FIX chips from `FitReport.suggested_bars`. **MASK STRENGTH:** reasons on hover or focus. **Banner:** the full state list.
- **Other screens.** VAULT (declassify-on-hover redaction, filters, selection bar → Rekordbox playlist with the "✓ WRITTEN" steps modal), SETLIST, VOICES (recommended voices, persona designer states, lexicon) and SETTINGS (auto-save, ENGINE card).
- **Kept from Phase 1:**
  - the component names from the brief, including EmptyState, ErrorState, ProgressOverlay, Tooltip and Modal;
  - the IPC proxy, `vbx://`, drag-out, and all shortcuts (plus R to record and Esc to close).
  - All 7 e2e tests, with updated selectors, plus an opt-in `shots` spec.

### Security fixes from S3's review (main process)
- **Engine token:** passed to the engine in its environment (`FVWKS_TOKEN`), never in argv (argv is visible to every local user through `ps`).
- **Export guard:** learns paths only from engine-generated structures: ExportedFile, RekordboxResult, and a finished batch job's `.xml`. It learns roots only from GET `/api/health` and GET/PUT `/api/settings`. User-echoed strings no longer count; there's a unit test for S3's repro.
- **Drag icon:** always main's own PNG; images from the renderer are never decoded.
- **Trusted URLs:** checked by path containment, not by string prefix.
- **Packaged builds:** ignore `FVWKS_ENGINE_CMD`, `FVWKS_UV` and `FVWKS_ENGINE_DIR`, and DevTools is dev-only.
- **Deferred:** `uv sync --locked`, until `engine/uv.lock` is committed at integration (this worktree's lock is stale, so `--locked` would block the engine); and serving the renderer from `app://` (follow-up).

### Engine integration (S3's review)
- **Engine error:** `health.state = error` shows ENGINE ERROR (pill and banner, with the engine's message and RESTART).
- **Superseded previews:** 409 `superseded` is ignored.
- **Lost batch jobs:** a lost job (404) stops polling.
- **Lexicon:** edits re-synthesize the current line.
- **Vault OPEN:** loads the take's own preset, chain, macros and stack.
- **Vault export:** uses Settings format, bit depth and playlist.
- **Error banners:** titled by code (EXPORT FOLDER UNAVAILABLE / DISK FULL / EXPORT FAILED). "Not exported: …" final-render warnings raise a toast.

### Phase 2.1 (2026-09-27): coordinator and user follow-ups
- **v0.3 contracts in the app:** API types are generated from `contracts/openapi.yaml` at tag `v0.3-contracts` (db6ccc5). The engine code comes with the coordinator's v0.3 merge, not in this branch.
- **Capability probe:** each (re)started engine gets one bogus render request with `bars: "auto"`. A 422 means pre-v0.2; a 404 (the source lookup) means v0.2+. v0.3 UI shows only when it answers yes. As a safety net, a 422 on an AUTO render falls back to 4 bars once, with a toast.
- **AUTO bars (v0.2):** the default and first in BARS, showing "AUTO · N" after a render (N = `RenderInfo.bars`). It's also available in SETTINGS defaults and per setlist line, is sent as `bars: "auto"`, and hidden on older engines.
- **Clean-up (P5):** OFF / LIGHT / FULL on RECORD and IMPORT, sent as `denoise` 0 / 0.5 / 1. Changing it re-sends the active take or file. The applied strength (`SourceInfo.denoise`) is shown.
- **Transcripts (P6):** a TRANSCRIBING… chip while `transcript_state` runs. When it finishes, the source is taken into the Studio and re-rendered, so its words show.
- **Editable transcripts (P7) and the script editor:** the insert buttons (BEAT BREAK / PAUSE ▾ / ECHO), in-editor chips, ECHO wording and in-editor shortcuts are S1's package (`help/s1-script`), merged here when done.
- **Shortcut scheme:** ⌘↩ final render everywhere; in the script editor ⌥↩ beat break and ⌘E echo; ⌘⇧E export everywhere (the menu too).
- **DOSSIER dropped** (user decision).
- **MSW mock:** emulates v0.3; `mockEngine.autoBars = false` emulates an older engine.

### Phase 2.2 (2026-09-27): the QOL build
- **The voice core moves per preset** (user request). `visuals/motionProfile.ts` derives the motion from the four
  macros and the live chain, so USER presets and edited chains get their own feel:
  - DEPTH → mass, gravity and size (heavier is slower). `layers.sub_gain_db` adds weight and sub pulses.
  - GRIT → turbulence and crisp particles, with `drive.drive_db` and `crush.bits`.
  - MACHINE → a lattice with beat-stepped rotation, with `machine.vocoder_mix` / `ring_mix`.
  - SPACE → trails and spread, with `space.reverb_mix` / `reverb_decay_s`. `mask.growl` → tremor.
  - Factory signatures on top: PACT embers, sub pulses and a satellite per stack voice; LEGION orbiting clusters, scan-line jitter and speckle; ABYSS a slow sinking drift with dark ember particles and tremor; UNIT the lattice, stepped rotation and crisp rings; GHOST pale trails; SIGNAL glitch slices and an RGB split on transients; RAW breathing.
  - The A/B dry side drops the signature.
  - Preset changes crossfade in about 400 ms. Reduce Motion jumps and freezes the decorative motion, but the sphere still answers the audio.
  - Trails are frame-rate independent (ProMotion runs at 120 Hz) and brightness-bounded.
  - All the visuals together cost about 1.1–1.4 ms a frame at 120 fps (p95 under 2 ms), measured in mock mode while playing each preset.
  - ![voice core per preset](../../app/docs/screens/after/1512x982/15-voice-core-presets.png)
- **VOICES → MODELS** (S1 [HIGH]):
  - A strip with every model the engine offers (kokoro, deepfilternet3, whisper-aligner and the persona model), required first.
  - Each is a compact ModelCard sharing the persona designer's install hook (5 GB guard, progress, cancel, `disk_full`, a lost job).
  - `openModelsFor(id)` jumps there with that tile lit and its Download focused.
- **Lexicon SPELL** (S1 [MED]): pressed only when the engine really spells the word (an acronym whose `say` is blank or the word itself, compared the way `_norm_key` does).
- **Small fixes:**
  - Persona kicker "persona · male" (S1 [LOW]).
  - Auditions play to the end of the line, capped at 4.5 s (S1 [LOW]).
- **UPDATING ENGINE** (S2): the first `uv sync` after the Airwindows native module lands compiles for about 7 s. `EngineStatus.setup` drives the pill: UPDATING ENGINE or INSTALLING ENGINE, with "Updating the engine (uv sync)…" in the tooltip and the boot lines.
  - Render warnings "Unavailable in this build" (a failed native compile) raise one toast per session.
- **Hardening** (S3's second review): packaged builds ignore these dev-only overrides:
  - `FVWKS_MOCK` and `ELECTRON_RENDERER_URL` (the latter could point the window and its preload bridge at any page);
  - `FVWKS_DATA_DIR`, `FVWKS_EXPORT_DIR` and `FVWKS_USER_DATA_DIR`.
  - Also: `window.open` reaches only an allow-list of hosts, and `vbx://` ids no longer admit `.` or `:`.
- **Mock engine:** a short transcript job could end in "running" (its timers raced). That was the flaky v0.3 unit test.

### Phase 2.3 (2026-09-27): FoxBox, endings, metronome, credit, installer
- **FoxBox identity** (user decision):
  - appId `com.smittytech.foxbox`, `FoxBox.app`; data in `~/Library/Application Support/FoxBox`, exports default to `~/Music/FoxBox`.
  - Brand text FOXBOX, and the fox mark (`components/common/FoxMark.tsx`, from `design/brand/foxbox-mark.svg`) in the TopBar and on the boot screen.
  - The app icon is `build-resources/icon.icns`, built with iconutil from `design/brand/foxbox-icon-1024.png`.
  - `LSMinimumSystemVersion` is 14.0, because the bundled engine's wheels are macOS 14 arm64.
- **Endings never cut** (v0.4, contracts v0.5 types):
  - FIT reads "EXTENDED 2 → 4 BARS" with the engine's message and a KEEP fix, and shows the reserved tail after the speech (`FitReport.reserved_tail_s`). 'overflow' remains only for older engines.
  - END (`Arrange.snap_end`, BEAT → BAR → OFF) is a chip in the FIT readout, because the top bar has no room at 1280 or 1512. It's sent only once chosen.
- **Metronome** (M, CLICK in the transport): synthesized clicks with an accented downbeat on a lookahead scheduler. They stay locked to the render's bar grid through play, pause, seek, the gapless loop, A/B and new renders.
  - The clicks go out on a monitor bus beside the master, never into a render, an export or the meters.
- **Credit:** "Designed by SmittyTech" appears in the About panel, on the boot screen, in the SETTINGS footer and in the ? overlay.
  - The contact address is injected at build time (`__CREDIT_EMAIL__`) from `FVWKS_CREDIT_EMAIL` or the gitignored `app/credit.local.json`, so it's never in git.
  - Without it, the credit is plain text. main opens only that mailto address.
- **Voice core:** follows `RenderInfo.motion` (v0.5) when a render carries it:
  - beat lock, stutter holds, tape-stop brake and sag, the swell halo, throw-echo rings, squelch;
  - returns-driven tails, and a pitch ring from f0.

  Without it, the chain-driven motion runs alone.
- **S1's script editor** (help/s1-script) is merged:
  - The insert buttons and chips use ECHO wording.
  - The transcript editor is in RECORD and IMPORT, and its 503 notice deep-links to the whisper-aligner model.
  - A transcript edit re-keys the render.
- **Packaging:** electron-builder 26 rewrote the source package.json during packaging; package.mjs now restores it.
- **Installer and updater** (FoxBox 1.0.0):
  - **Bundled engine.** `package.mjs --bundle-engine` ships S3's bundle at `Resources/engine`, launched with no uv.
    - `HF_HOME` is `<data>/models`.
    - Before every spawn the quarantine flag is cleared from our own engine folder. A read-only, still-quarantined copy isn't launched: Setup says "Move FoxBox to Applications".
    - S3's unchecked-hash .pyc keep the code signature intact after the first run.
  - **Setup window** (first bundled launch): required and optional components, a disk meter, byte-level progress with speed and ETA, retry and resume, cancel, then Ready.
  - **Updater:**
    - It reads GitHub Releases of `als7294/FoxBox` by default. The user approved this source directly; `latest-mac.json` holds the version, notes, and the size and SHA-256 of each file.
    - A private repo needs the optional token, which is Keychain-encrypted and sent only to api.github.com.
    - Checks: size and SHA-256 while streaming, then bundle id, version and codesign.
    - Nothing installs without "Restart to update". The previous app is kept until the new one starts.
    - UI: the update bar and SETTINGS → UPDATES.
  - **Distribution.** `release.mjs <version>` builds `FoxBox-<v>-arm64.dmg` (a branded window with first-open steps) and `.zip` (for updates), plus `latest-mac.json`. Publishing stays with the coordinator.

### Release 1.0.0 (2026-09-27)
- **Candidate:** session/s4-app 6955be2, built from a clean `git archive` of that commit with `release.mjs --no-bump`.
  - `FoxBox-1.0.0-arm64.dmg`: 393.3 MB, sha256 6f190a1d…d469.
  - `FoxBox-1.0.0-arm64.zip`: 425.9 MB, sha256 5c50a739…50d9.
  - The files are in `app/release/1.0.0/`, which is git-ignored.
- **Checks:**
  - Typecheck is clean and vitest passes 367/367 on the export.
  - e2e passes 7/7 against the real engine.
- **Fresh launch from the DMG** (headless, with the engine folder quarantined):
  - Setup ran to READY (365 MB) and the engine reached ready.
  - Preview and final render worked, and the export carries the cover art.
  - There were no Gatekeeper dialogs, the signature was intact after the first run, and it quit cleanly.
- **Known:** it's ad-hoc signed and not notarized, so a downloaded copy needs Open Anyway once. The DMG art and "Open FoxBox.txt" explain this. A Developer ID would remove it.
- **Pending for 1.0.1 / 1.1:** S1's camera prototype, the ModelCard re-attaching to `install_job_id`, and the full update modal and WhatsNew.


### Verification (2026-09-26)
- **Typecheck:** `npm run typecheck` is clean across all four configs (node, web, test, e2e).
- **Unit tests:** `npx vitest run` passes 107 tests in 18 files (Phase 2.1).
- **e2e:** `npm run e2e` passes 7/7 against the real engine: first the worktree's engine, then again after merging `main` @ 43e6c24 (S1 f0 tags, denoise and aligner; S3 shutdown fix; S2 beat-lock). About 2.3 min.
- **Packaging:** `npm run package:install` rebuilt and installed `~/Applications/FoxBox.app` (ad-hoc signed, linked to the main checkout's `engine/`).
- **Screenshots:** the `shots` spec captured 15 states at 1512×982 and 11 at 1280×800. I compared them by eye with `docs/screens/design/`.
  - Studio, rack, record, overflow, restart, vault, setlist, voices and settings all hold at both frame sizes, with no horizontal overflow.
  - At 1280×800 the cartridge tightens up (a height container query) so EXPORT stays in view, and the rack drawer scrolls vertically.

### Verification (2026-09-27, Phase 2.2)
- **Typecheck:** clean.
- **Unit tests:** 123/123 in 20 files, three runs in a row after the mock fix.
- **e2e:** 7/7 against the real v0.3 engine (1.9 min).
- **Voice core:** checked per preset in mock mode (the contact sheet above), plus the frame-cost measurement.

### Open items
- **Waiting on S3:**
  - `ModelInfo.install_job_id`, so model cards reattach after a reload and show the engine's own first-run installs.
  - `Health.missing_models`.
  - A `model_id` on 503 `model_not_installed`.
  - The bundled engine for fresh Macs (S3 [HIGH]). The app half comes once `bundle_engine.sh` is on main: launch `Resources/engine/bin/fvwks-engine` without uv, `HF_HOME` under the data dir in bundled mode only, and `package.mjs --bundle-engine`.
- **S1's script-editor package** (`help/s1-script`): the insert buttons, chips, ECHO wording and the editable transcript. Merge it when it lands.
- **S2's v0.4 fit** (coming): FitReport status `extended` (the render grows so speech is never cut; its message also arrives as a render warning) replaces `overflow`, plus `FitReport.reserved_tail_s`. FitIndicator and the FIX chips need updating when that contract lands.
- **Manual (for the user):**
  - drop the cartridge into Finder and GarageBand;
  - record with a real mic (the e2e uses a synthetic tone);
- **Follow-ups:**
  - `uv sync --locked` once `engine/uv.lock` is committed;
  - the `app://` renderer scheme;
  - skip re-uploading takes after an engine restart (the engine dedupes them anyway);
  - persona candidates' F0 (needs a `PersonaCandidate.f0_hz` proposal).

## Installed app
- `~/Applications/FoxBox.app` runs the main checkout's `engine/`. On first launch it runs
  `uv sync --all-packages` there if `engine/.venv` is missing (shown as "Installing the engine (uv sync)…").
  Rebuild after integration with `npm run package:install` from `app/`.

## Commands (in `app/`)
- `npm run dev`: Electron + HMR; spawns `../engine/.venv/bin/fvwks-engine` (runs `uv sync --all-packages` first if the venv is missing). Data in `<worktree>/.devdata/`.
- `npm run dev:mock` (Electron) or `npm run web` (plain browser): no engine, MSW mocks.
- `npm test` (Vitest), `npm run e2e` (build + Playwright Electron), `npm run typecheck`.

## Deviations from my brief (following the coordinator's plan-review notes in docs/sessions/README.md)
- The bridge does **not** expose the engine token. `window.fvwks.engine` is `{request, abort, audioUrl}`:
  JSON goes preload → IPC → main → engine (main adds `Authorization`), audio through `vbx://audio/<id>`
  (privileged, streaming, handled by main). The CSP no longer allows `127.0.0.1` at all.
- The engine is launched as `<engine>/.venv/bin/fvwks-engine --port 0 --data-dir … --export-dir … --exit-with-parent`, with the token in the `FVWKS_TOKEN` environment variable (never argv)
  (not `uv run --project`), and the port is read from `FVWKS_ENGINE_READY port=N`.
- Drag/reveal accept only paths the engine itself returned in structured fields (ExportedFile, RekordboxResult, a
  finished batch's XML), inside an export root reported by `/api/health` or `/api/settings`.

## Notes for other sessions
- S3: the app passes `--export-dir` on every launch (dev: `.devdata/exports`, packaged: `~/Music/FoxBox`);
  per the v0.1 ruling a persisted `Settings.export_dir` wins.
- S1/S2: the Studio draws `Segment.words` from `RenderInfo.segments` as output-timeline times (same as segments).
  If words stay in source time after placement, tell me and I'll map them.
- S3: the app sends `Range` through for `GET /api/audio/{id}` and copies `content-type`, `content-length`,
  `accept-ranges`, `content-range` back.
