# Session coordination

| Session | Owns | Branch |
|---|---|---|
| S1 VOICE | `engine/voice/` | `session/s1-voice` |
| S2 SOUND | `engine/fx/` | `session/s2-sound` |
| S3 ENGINE | `engine/server/` | `session/s3-engine` |
| S4 APP | `app/` | `session/s4-app` |
| Coordinator (planning session) | `contracts/`, `engine/contracts/`, `engine/pyproject.toml`, `scripts/`, `fixtures/`, `docs/` except your own `docs/sessions/S<n>-status.md` | `main` |

## Contracts: tag `v0-contracts`
Merge it into your branch with `git merge v0-contracts`. It contains:
- `engine/contracts/src/fvwks_contracts/`:
  - `models.py`: all HTTP/data models. This is the source of truth.
  - `seam.py`: `Source`, `RenderOutput`, and the `VoiceAPI`/`FxAPI` protocols.
  - `audio.py`: shared helpers (`resample`, `bar_samples`, `peaks`, `wav_bytes`).
- `contracts/openapi.yaml`: exported from the server stub. `engine/contracts/tests/test_contract_drift.py` keeps it frozen.
- `contracts/chain.schema.json` (the Preset schema) and `contracts/rack.v0.json` (the initial rack descriptor, served at `GET /api/rack`).
- `contracts/examples/*.json`: real example payloads for every main response.
- Working stubs, which you now own and replace:
  - `engine/voice/src/fvwks_voice/api.py`: serves Kokoro fixtures.
  - `engine/fx/src/fvwks_fx/api.py` and `presets/*.json`: passthrough render on the bar grid, plus the rack descriptor and 7 presets.
  - `engine/server/src/fvwks_server/{main,app,config,stub_store,audio_io}.py`: every route works end-to-end.
- `fixtures/`:
  - `voices/*.wav`: dry Kokoro audio at 24 kHz.
  - `sources/*__<voice>.wav` + `.source.json`: multi-segment scripts in 3 voices at 48 kHz, with 1:1 segments for STACK.
  - `markup_cases.json`: parser expectations shared by S1 and S4.

## Commands
- Tests: `scripts/check.sh [all|contracts|voice|fx|server|app]`.
- Engine only: `scripts/dev.sh engine` prints `FVWKS_ENGINE_READY port=…`.
- Data lives in `<worktree>/.devdata/`, so sessions never share a database or export folder.
- `engine/uv.lock` stays uncommitted until integration. Add dependencies only to your own member's `pyproject.toml`.
- Contract changes: write `contracts/proposals/S<n>.md`, keep a backward-compatible local workaround, and keep the drift test green. The coordinator batches accepted proposals into `v0.1-contracts`.

## Notes from the plan review, per session
**All sessions**
- To mark a real implementation in `GET /api/health`, set `ENGINE_NAME = "<name>"` in your `api.py`, e.g. `"kokoro-mlx"` or `"fvwks-rack"`.
- The rack descriptor (`fvwks_fx.api.rack_schema()`) is **runtime data owned by S2**, not a frozen contract. The UI builds one generic ModuleCard per module from it. Presets must stay valid against it (`engine/contracts/tests/test_presets_and_rack.py`).
- Convention: macros default to 0.5, which is the preset as designed. `MacroTarget.min` and `max` are the values at 0 and 1.

**S1 VOICE**
- `misaki[en]` is required for Kokoro in mlx-audio, and it pulls in **torch, transformers and spaCy**. Measure the venv size and compare against kokoro-onnx (espeak-based, no torch). Report the numbers in your status file and pick the default.
- misaki downloads spaCy's `en_core_web_sm` at runtime unless it's pinned as a dependency.
- The server (S3) caches STACK sources by (script, voice, speed, lexicon). STACK voices must produce the same segment count as the main voice (same `script_hash`).
- `synthesize(req, lexicon)` receives the user lexicon from the server (`GET/PUT /api/lexicon`).

**S2 SOUND**
- **Build a vertical slice first:** MASK, DRIVE, TONE, SPACE, ARRANGE and MASTER, plus PACT, RAW and UNIT.
  - Modules that aren't built yet get `available=False` in the rack and are bypassed with a warning.
  - After that: machine/vocoder, stack, crush/codec, motion and OTT. Scale-lock, the frequency shifter and the `edit` module (stutter, tape-stop, squelch) come last.
- **Speed:** DEPTH and MACHINE change MASK parameters, so stage memoization doesn't help 2 of the 4 hero knobs.
  - Cache the WORLD analysis per source (`analyze()` is called in the background after TTS) and run MASK resynthesis at 24 kHz.
  - Use stftpitchshift for sub, ghost and stack.
  - Benchmark first, then commit to the <400 ms preview target or propose a new one.
- **MASTER order:**
  1. Resample to the output rate.
  2. Match loudness. Short-term = max over 3 s windows; for files under 3 s, use the whole file.
  3. Apply the `BrickwallLimiter` true-peak ceiling.
  4. Trim to exact length = `round(bars·240/bpm·sr_out)`.
- Pre-roll and swells use `Arrange.first_word_beat` (GHOST sets 4 via `arrange_hint`). The first word lands on that beat, not always at sample 0.
- Keep the audition pack under ~300 MB (the disk is nearly full).

**S3 ENGINE**
- The app proxies every request through Electron main over IPC, so **CORS is unnecessary**. Keep `--allow-origin` for dev only.
- Keep the token on every route. `?token=` is allowed only on `GET /api/audio/*`.
- `--exit-with-parent` watches stdin. `--port 0` picks a free port.
- Final renders auto-export the wet file (`RenderInfo.export`), so the cartridge is drag-ready. Only paths inside the export root are ever returned.
- Header test: libsndfile writes fmt tag 1 for `WAV`/`PCM_24`. Keep the byte test anyway.
- Write RIFF INFO through soundfile's string fields before the first frame. Use mutagen for ID3 in AIFF.
- Batch items report per-item state and errors (`JobItem`).

**S4 APP**
- **Talking to the engine:**
  - Use `contextIsolation`. The renderer never sees the token: proxy JSON through preload → IPC → main → engine.
  - Serve audio through a privileged custom scheme such as `vbx://audio/<id>` with `stream: true`, handled by main with the token.
  - Load the UI from `app://` or `file://`; no localhost CORS.
  - The CSP needs `style-src 'unsafe-inline'`, because wavesurfer injects a style tag.
- **Spawning the engine:**
  - Use the absolute path `<repo>/engine/.venv/bin/fvwks-engine --port 0 --token <T> --data-dir <D> --exit-with-parent`. Parse `FVWKS_ENGINE_READY port=N` from stdout.
  - Apps launched from Finder have no shell PATH. If `.venv` is missing, run `~/.local/bin/uv sync --all-packages` in `engine/` first.
  - Show a "restarting" state and re-read the port after a restart; expose `onEngineStatus` and `restartEngine` on the bridge.
- **Drag-out:** dragstart → `preventDefault` → IPC → `event.sender.startDrag({ file, icon })`. The file must already exist (use `RenderInfo.export.path` or `ExportedFile.path`), and the icon must be a real PNG.
- **Rack UI:** build it generically from `GET /api/rack` (`contracts/rack.v0.json`), using ParamSpec kind, range, unit and scale.
- **Mocks:** MSW is optional; the stub engine plus `contracts/examples/*.json` are a truer mock.
- **Keyboard:** turn off global shortcuts (Space, `\`, L, 1–7) while the ScriptEditor or any input has focus.
- **macOS:**
  - Use a hidden-inset title bar with a draggable top region that leaves room for the traffic lights.
  - Expect the mic permission prompt again after each ad-hoc rebuild.

## Updates
- **2026-09-26: downloads approved.** The user OK'd downloading whatever makes the tool fast and good. This supersedes the earlier "Kokoro only" rule.
  - The Qwen3-TTS persona designer is now in scope (S1 functions, S3 install jobs, S4 VOICES UI).
  - PyTorch is fine.
  - Guard: before any download over 1 GB, check free disk and keep at least 5 GB free (`disk_full` error otherwise).
  - Licenses still need to allow commercial use.

## v0.1-contracts (2026-09-26): rulings on proposals
Tag `v0.1-contracts` is on `main`, and **S3's server is already integrated there**. Merge it: `git merge v0.1-contracts`.
Every change is additive: new optional fields with defaults, plus 2 new routes.

**Accepted**
- **S1 P1: word timings.** `Word{text, start_s, end_s, throw}` and `Segment.words`. S2 throws exactly the `throw` words, or the whole segment when `words` is empty. S4 draws word ticks and a "now speaking" highlight.
- **S1 P2:** `SourceInfo.bpm`. S3 passes it when synthesizing stack voices.
- **S1 P3:** `SourceInfo.warnings`, plus a new route `POST /api/script/preview` → `ScriptPreview{segments[{text, say, flags}], warnings}`.
  - It calls the optional voice hook `preview_script(script, lexicon, bpm)` and falls back to a stub parse.
  - S4's ScriptEditor can use it for exact highlighting.
- **S1 P4:** `DEFAULT_LEXICON` now includes the built-in acronyms (DJ, MC, BPM, CDJ, VIP, EDM, UK, USA, FBI, CIA, NSA, TV) with `acronym: true`. S1 drops its hidden list, and a supplied Lexicon is the user's complete list.
- **S3 P1: optional voice hooks,** documented in `seam.VoiceHooks`: `ENGINE_NAME`, `ENGINE_VERSION`, `warm_up`, `configure`, `list_models`, `install_model`, `design_persona`, `save_persona`, `preview_script`.
- **S3 P2:** `ExportResult.warnings`.
- **S3 P3: the preset-hint rule** (behaviour). `arrange_hint` and `master_hint` fill only the Arrange/Master fields the client did not send (pydantic `model_fields_set`). **S4: send partial `arrange`/`master` objects containing only what the user changed.**
- **S3 P4:** `SourceInfo.analysis_state` (`none|queued|running|done|error`).
- **S3 deviation, approved:** RIFF INFO is written by S3's own chunk writer after the data chunk, so the WAV keeps the canonical 44-byte header (data at byte 36). That's safer for CDJs and naive players.
- **S4 #1:** new route `GET /api/personas/candidates/{candidate_id}` → `PersonaCandidate`. Candidate ids equal their audio ids.
- **S4 #2 (behaviour, S3):** a persisted `Settings.export_dir` wins over `--export-dir`, which only seeds a fresh settings store. S3 has already implemented this.
- **S4 #3:** `Take.source_id`.
- **S4 #4 (data, S1 + S3):** pre-render a short sample per recommended voice in the background after `warm_up` and fill `Voice.sample_audio_id`, so auditions are instant.

**Integration note:** `fixtures/sources/remember__*` were rendered without S1's end-of-chunk period, so their last words may be clipped. The coordinator will regenerate them through S1's `synthesize` at integration. Segment structure and `script_hash` are unchanged.

## Open issues (coordinator)
- **[S1, priority] espeak-ng can't handle long install paths.** espeak-ng truncates its data path at about 160 characters, then fails with `.../espeakng_loader/phontab: No such file`.
  - The packaged `.app` path (`~/Applications/FoxBox.app/Contents/Resources/engine/.venv/...`) and long worktree paths are both at risk.
  - Fix: at `configure()`/`warm_up()`, if the espeak data path is longer than about 100 characters, point espeak at a short symlink or copy (`~/Library/Caches/fvwks-espeak`, or `/tmp/fvwks-espeak-<uid>`). Add a deep-path test.
- **[S3] Bundle test for that bug.** Relocate the engine under a deliberately long `.app` path and run a real TTS call that hits the espeak fallback (after S1's fix).
- **[S3] Integration branch `integration/i1`** (main + S2 + S1):
  - Fix `test_tail_cue_uses_reserved_ring_out`. Ruling: `tail_s` = end of the last word, the memory cue "VOICE OUT".
  - Fix `test_export_variants_errors_and_stems`: the real fx produces stems.
- **[S1]** Update `test_defaults_match_the_contract` for the v0.1 acronyms, and give `preview_script` a `bpm` parameter.
- **FINAL ruling: `tail_s`** (v0.1.2). `tail_s` = end of the last word on the output timeline (word timings when present, else the last segment's end). It's clamped to the file, independent of `tail_beats`, and None only without speech. The rekordbox memory cue "VOICE OUT" sits there. S2 implements this at af0e034. (v0.1.1's "ring-out start" wording was a mistake and is reverted.)
- **Accepted: S2's preview targets.** DEPTH/MACHINE tweaks < 800 ms; a cold first preview < 1.2 s. SPACE/STEREO/master tweaks stay < 400 ms, and a final render < 3 s. `engine/fx/tests/test_perf.py` enforces them.
- **Ruling: word and segment timelines.** In `SourceInfo.segments`, segment and word times are in **source time**. In `RenderInfo.segments`, **both segments and their `words` are on the output timeline**, placed and stretched with the render.
  - **S2** transforms word times along with segment times (including the fit stretch ratio and the Beat-Lock placement).
  - **S4** already treats them as output time.
- **Main now includes S1 and S2** (`integration/i1`, merged). The installed app, linked to `~/VoiceBox/engine`, runs the real voice and rack.
- **[S2]** Build placed `Segment.words` as `Word` models, not dicts. Pydantic warns `PydanticSerializationUnexpectedValue` on RenderInfo serialization.
- **[S2] Done:** merged af0e034 into main. Main now has the regenerated `contracts/rack.v0.json` and real-engine `contracts/examples/*.json`.

## Team phase (the user asked the sessions to help each other)
- **Phase 2 (the Claude Design build) is split across the team. S4 is UI lead and the single integrator for `app/`.**
  - S4 commits a styled "Phase 2 base" (fonts, tokens, primitives, shell, motion helpers) plus `docs/sessions/S4-phase2-split.md`, then sends each helper its package.
  - Helpers branch `help/<sN>-<area>` from the base, edit only their assigned files, and report "HELP DONE" to S4, who merges them.
  - Proposed packages:

    | Session | Package |
    |---|---|
    | S4 | Base + STUDIO |
    | S2 | RACK UI (presets, macro rings, ModuleCard, meters, mask badge) |
    | S3 | VAULT, SETLIST, SETTINGS, ExportSheet, Rekordbox flow |
    | S1 | VOICES (voice cards, model installs, persona designer, lexicon) + ScriptEditor polish |
- **Cross-reviews (read-only; findings go to the owner, with a one-line summary to the coordinator):**

  | Reviewer | Reviews |
  |---|---|
  | S2 | S1's `engine/voice` (audio and timing accuracy) |
  | S1 | S2's use of segments, words and flags in `engine/fx` |
  | S3 | S4's Electron main, preload, IPC and security |
- **Final integration** (coordinator) once S4 reports the merged Phase 2 and S1 and S3 report READY: merge everything, run the full suites (engine, Vitest, e2e), rebuild the app, and write the final report.

## Approved upgrades (user, 2026-09-26)
| # | Upgrade | Owner | Notes |
|---|---|---|---|
| 1 | DeepFilterNet3 denoise at ingest | S1 | Through mlx-audio STS; defaults on for recordings, off for TTS. |
| 2 | Word timings for recordings | S1 | Whisper turbo (cached) for the transcript, then Qwen3-ForcedAligner-0.6B (Apache-2.0, MLX) to fill `Segment.words`. |
| 3 | Airwindows (MIT) | S2 | Tape/tube saturation, DeRez, big reverbs, via the airwin-registry binding or pedalboard plugin hosting. |
| 4 | LPC talkbox | S2 | Our own code, added as a MACHINE mode for UNIT. |
| 5 | pyrekordbox read-back tests | S3 | Tests only. Never write Rekordbox databases. |

- S2 is off UI work. The RACK UI stays with S4 or goes to S3; S4 decides.
- **Open bug (S3):** the server tests segfault at interpreter exit (exit 139) after every test passes. Shutdown must be deterministic.

## Open issues (2026-09-27)
- ✅ **RESOLVED (S3 ef12ebb): the NaN was UI display maths (`'auto' * 240` before the first render), fixed in S4 Phase 2.1. A sweep of 252 SIGNAL AUTO renders over HTTP found 0 NaN.** ~~NaN in SIGNAL with `bars: "auto"`~~ (found in S1's UI review). The coordinator couldn't reproduce it through `fvwks_fx.api.render`: SIGNAL + AUTO on all 5 fixture sources, preview and final, Beat-Lock on and off, gave 0 NaN. **S1:** send the exact repro to S2 (script/voice or recording, macros, arrange, quality, server or app path, and where the NaN shows). AUTO is resolved in `fvwks_fx/api.py` (coordinator stopgap).
- **[S4 / S1]** No install UI for the `whisper-aligner` and `deepfilternet3` models.
- **[S1 → S4 Phase 2.1]** The editor's local markup parser disagrees with the engine on 11 of 22 edge cases. S1 is fixing it in its Phase 2.1 package.
- **[S1]** `test_transcribe_fills_the_transcript_and_words` flakes under load (one word 222 ms off).
