# FoxBox — voice-mask studio for GUY FVWKS

## Context
GUY FVWKS wants a Mac desktop tool that turns **typed text (TTS)** or **their own recorded voice** into a
super-low, distorted, anonymous "Deathpact-style" voice. It exports **bar-exact, club-ready files** for baking
into tracks and pre-recorded set bits, so they never touch the mic.

Research backs a TTS-first approach. Deathpact's lore voice is itself described as a *collage of robotic
text-to-speech voices* ("WE ARE DEATHPACT", "transmissions"). No public recipe for it exists, so we recreate
the **processing style** with original presets. We never clone a real artist's voice.

**Appendix A is the Claude Design handoff brief. Copy it into Claude Design now.** The build runs at the same time:
after approval I bootstrap the repo, then launch **four individual Claude Code sessions** (Appendix B) and
coordinate them from here. The product is **FoxBox** (bundle id `com.smittytech.foxbox`).

**Locked decisions:**
- Desktop app with native drag-out of files.
- Target DJ software is Rekordbox/CDJs.
- v1 mask is DSP only (no AI voice conversion). The chain keeps a slot for it later.
- Export only: no live soundboard.

**Machine:**
- M3 Pro, 36 GB RAM, macOS 14.4.
- **About 18 GB free disk.** So the default install stays under ~2 GB and heavier models are opt-in.
- Installed: Node 24, uv + Python 3.12, Swift CLT, git, Chrome, GarageBand.
- Not installed: Rust, Xcode.app, Homebrew, ffmpeg.

## What we build on (researched Sep 2026)
| Role | Pick | License | Why |
|---|---|---|---|
| Default TTS | **Kokoro-82M via `mlx-audio`** (kokoro-onnx as fallback) | Weights Apache-2.0, library MIT | 10x+ faster than real time on Apple Silicon and small. Bases: am_fenrir, am_michael, am_puck, bm_george, af_heart. The FX chain provides the depth. |
| Persona voice (opt-in) | **Qwen3-TTS** VoiceDesign + Base clone via `mlx-audio` | Apache-2.0 | Describe a voice ("deep gravelly menacing narrator"), then clone that clip so every line uses the same persona. |
| FX / render / file I/O | **Spotify `pedalboard` 0.9.25** | GPL-3.0 | Supplies every effect the chain needs; exact classes are listed in S2 milestone B4. Also used for `time_stretch` (Rubber Band R3), AU/VST3 hosting and 24-bit file writing. |
| Pitch / formant / monotone | **`pyworld-prebuilt`** (WORLD) + **`stftpitchshift`** | MIT (WORLD core: modified BSD) | Pitch and formants move independently. Also gives monotone, whisper and growl, plus several pitch layers in one pass. Plain `pyworld` has no arm64 wheel. |
| Loudness / files / tags | `pyloudnorm`, `soundfile`, `mutagen` | MIT, BSD-3, GPL-2+ | Measures LUFS (BS.1770-4). **Rekordbox reads ID3 from AIFF but only RIFF INFO from WAV.** |
| Shell | **Electron** + electron-builder | MIT | `webContents.startDrag` drags files into Rekordbox, Ableton or Finder. No Rust or Xcode needed. |
| UI | React + TypeScript + Vite, `wavesurfer.js`, `openapi-typescript` | MIT / BSD-3 | Takes the Claude Design handoff directly. |

- **Not forking** `jamiepine/voicebox` (MIT). It has open Apple Silicon crash bugs, needs a Rust/Bun toolchain, has stale dependency pins, stalled development, and many features we don't need. We **borrow its effects-registry/preset pattern**, with attribution.
- **Excluded:**
  - macOS `say` voices: Apple's license is personal and non-commercial only.
  - F5-TTS, XTTS-v2, Fish Speech: non-commercial weights.
  - AllTalk, so-vits-svc: AGPL.
  - Seed-VC: archived.
  - Chatterbox: its PyTorch pins clash with mlx-audio, and it watermarks output. It's a candidate for the AI voice-conversion slot later.
- **Licensing:** the GPL parts only matter if the app is ever *distributed*. Rendered audio is yours (GPL FAQ).

## The sound: the FVWKS rack
Fixed order; each module can be bypassed. The **4 macro knobs** are the hero controls. Each maps to several parameters and is resolved by the engine, which returns the result as `resolved_chain`:
- **DEPTH:** pitch, formant, sub level.
- **GRIT:** drive, crush, OTT.
- **MACHINE:** vocoder, ring mod, monotone amount.
- **SPACE:** reverb, delay.

1. **PREP:** high-pass, gate, de-ess, normalize. Mostly for recorded voice.
2. **MASK** (WORLD):
   - `pitch_st` −24…+12.
   - `pitch_mode`: natural, monotone (flat on the key root) or scale-lock.
   - `formant_st` −12…+12.
   - `mcadams` α 0.5–1.0 (reimplemented from the paper, not the GPL code).
   - `breath` (whisper) and `growl` (subharmonics).
3. **LAYERS:**
   - SUB: a further −12 st octave.
   - GHOST: +12 st whisper.
   - **STACK:** 1–3 extra TTS voices on the same script. Each gets its own pitch, pan and gain, and is time-aligned per segment. This is the "robotic TTS collage".
4. **MACHINE:**
   - Channel vocoder: 16–40 bands, saw carrier on the key root or chord (numpy/scipy).
   - Ring mod at 20–150 Hz.
   - Frequency shifter at ±50–500 Hz (Hilbert transform).
5. **DRIVE:** tanh, tube, fold or hard clip, oversampled, parallel mix.
6. **CRUSH:** bit depth, sample rate, GSM or MP3 codec grit, radio noise bed.
7. **TONE:** high-pass, low shelf, mid peak/scoop, low-pass (or band-pass).
8. **MOTION:** phaser, chorus.
9. **DYNAMICS:** compressor plus a 3-band "OTT".
10. **SPACE:**
    - Dark reverb (generated IR fed to Convolution).
    - Tempo-synced delay or ping-pong.
    - **Throws** on `*flagged*` words.
    - Reverse-reverb swell.
11. **STEREO:** width, with everything below 150 Hz kept mono. Club systems are often mono.
12. **ARRANGE:**
    - Length: **1 bar = 240/BPM s**, and the file is exactly N bars.
    - Fitting: the first word lands on sample 0. If the phrase is too long, stretch it by at most 8% with R3; otherwise suggest the next bar count.
    - **Beat-Lock:** each `|` chunk lands on the next beat.
    - Also: pre-roll, tail, fades, stutter, tape-stop.
13. **MASTER:**
    - **CLUB** (default): short-term max −7 LUFS, true peak ≤ −1 dBTP.
    - **BAKE-IN:** peaks at −6 dBFS with no limiting, for mixing into songs.
    - CUSTOM: set the target LUFS yourself.

**Mask-strength badge.** A single global pitch shift is **reversible**; re-pitching exposes the voice. The engine scores the chain and shows WEAK, MEDIUM or STRONG with reasons:
- Points come from formant shift, McAdams, monotone, vocoder, nonlinear drive, codec and stack.
- It warns when a preset is pitch-only.
- TTS sources show SYNTHETIC, since no biometric voice is present.
- We never claim forensic-grade protection.

**Factory presets** (starting values from producer recipes for similar voices; to be tuned by ear from S2's audition pack):

| Preset | Idea | Starting values |
|---|---|---|
| **PACT** | Deathpact-inspired entity | Pitch −9 st, formant −5 (set separately). Sub −12 st at −8 dB. Stack: 2 voices at −8 and −10 st, panned ±40, −14 dB. Vocoder mix 0.15. Parallel tube→hard-clip at 45% wet. OTT 30%. HPF 50 Hz, −3 dB at 300 Hz, LPF 8 kHz. Dark plate ~1 s at 15%, 1/8 slap. |
| **LEGION** | Intercepted "we are legion" broadcast | Pitch −3, monotone 0.8. Stack of 2 at −6 dB. Ring mod 60 Hz at 25%. 10-bit crush, GSM codec, noise bed −30 dB. Band-pass 300–3400 Hz with +4 dB at 1.2 kHz. Squelch clicks at start and end. |
| **ABYSS** | Pit-demon | Pitch −12, formant −7, growl 0.6. Layers at −7 and −12. Heavy tube drive. Phaser 0.3. LPF 8 kHz. Hall 2.5 s at 25%. |
| **UNIT** | Robot / vocoder in key | Monotone on the key root. 32-band saw vocoder at 0.8. Ring mod 60 Hz at 35%. Hard clip. HPF 80 Hz, LPF 10 kHz. 1/16 slapback, no reverb. |
| **GHOST** | Whisper transmission | Pitch −2, breath 1.0. Sub at −15 dB. HPF 180 Hz. 1-bar reverse swell. Hall 6 s at 40%. Dotted-1/4 ping-pong. |
| **SIGNAL** | Glitch | Pitch −5, formant −2. 6-bit crush at 8 kHz. Frequency shift +200 Hz. 1/16 ×4 stutter. Tape-stop. Gate. |
| **RAW** | Anonymizer base | Prep on. Pitch −4, formant −4, McAdams 0.8. Everything else off. |

**Script markup** (S1 parses it; S2 consumes the segments):

| Markup | Meaning |
|---|---|
| `\|` | Beat break |
| `[0.5]` | Pause in seconds |
| `[2b]` | Pause in beats |
| `*word*` | Throw (delay/reverb on that chunk) |

- A lexicon handles names: `FVWKS` → "Fawkes". It can be edited.
- ALL-CAPS text is lower-cased before TTS, so "EXPECT US" isn't read as "U.S.".

## Architecture
```
Electron main ─spawns→ Python engine (FastAPI, 127.0.0.1:<random port>, bearer token from Electron)
  preload bridge: engineUrl, token, startDrag(path), reveal(path), chooseFolder()
Renderer (React) ─HTTP→ /api/*
Engine: voice (TTS · stack voices · persona · ingest) → Source cache (+ cached WORLD analysis)
        → fx.render (stage-memoized rack → arrange → master) → export (AIFF/WAV + tags + stems)
        → library (SQLite) → rekordbox.xml
Data: ~/Library/Application Support/FoxBox/    Exports: ~/Music/GUY FVWKS/VoiceBox/
```
- **Audio format:** 48 kHz float32 inside the engine; output is stereo.
- **Performance:**
  - WORLD analysis is cached per source.
  - Stages are memoized by a hash of the parameters upstream of them, so a SPACE tweak doesn't redo MASK.
  - Targets: preview under 400 ms for a 10 s line; final render under 3 s.
- **Security:**
  - The engine binds to localhost only and requires the token.
  - It accepts no client-supplied file paths.
  - Electron only drags or reveals paths the engine returned, after checking they're inside the export root.

**Repo layout and ownership.** Each session edits only the folders it owns.
```
docs/        PLAN.md  DESIGN_HANDOFF.md  sessions/S{1..4}.md (+ each session's own S<n>-status.md)  [Step 0]
contracts/   openapi.yaml (exported from the server stub)  chain.schema.json  proposals/S<n>.md    [frozen]
engine/      pyproject.toml — uv workspace; uv.lock is git-ignored until integration               [Step 0]
  contracts/ fvwks_contracts: pydantic models, the source of truth for all shapes                  [Step 0, frozen]
  voice/     fvwks_voice: TTS, stack, persona, markup, lexicon, ingest                   [S1; Step 0 leaves a stub]
  fx/        fvwks_fx: rack, macros, presets, arrange, master, mask score, CLI (no file I/O)  [S2; Step 0 leaves a stub]
  server/    fvwks_server: FastAPI, library, caches, jobs, settings, file writing + tags, rekordbox.xml
                                                               [S3; Step 0 leaves a stub with every route]
app/         Electron + React (the Claude Design bundle unzips to app/design/)                     [S4]
fixtures/    4 dry Kokoro phrases + expected.json                                                   [Step 0, read-only]
scripts/     dev.sh  check.sh  export_openapi.py                                                    [Step 0]
```

**Python seam** (lives in `fvwks_contracts`):
- `synthesize(TTSRequest) -> Source`
- `ingest(bytes) -> Source`
- `render(sources: list[Source], chain, macros, arrange, master, quality) -> RenderResult`
  - `sources[0]` is the main voice; the rest are STACK voices.
- `write_audio(RenderResult, ExportOptions) -> list[ExportedFile]`. S3 owns this; S2 never writes files except for its audition pack.
- Errors use one shape everywhere: `{error: {code, message, hint}}`.
- `Source` carries audio, `segments[{text, start_s, end_s, flags}]` and peaks.
- `RenderResult` carries: audio, LUFS figures and true peak, peaks, placed segments, a fit report (speech length vs. available, stretch, suggestion), mask strength, `resolved_chain` and per-stage timings.

**HTTP API** (the full schema is exported to `contracts/openapi.yaml`; a drift test keeps it in sync):

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Status and versions |
| `GET /api/voices` | Voices and personas |
| `POST /api/models/{id}/install` + `GET /api/jobs/{id}` | Opt-in download with a disk check |
| `POST /api/sources/tts` | `{script, voice_id, speed}` |
| `POST /api/sources/upload` | WAV/AIFF/FLAC/MP3. The UI converts other formats first via Web Audio. |
| `POST /api/personas` | Returns 3 candidates to audition, then save |
| `GET / POST / PUT / DELETE /api/presets` | Factory presets are read-only |
| `POST /api/render` | `{source_id, chain, macros, arrange, master, quality: preview\|final}` |
| `POST /api/exports` | `{render_ids, format: aiff\|wav, variants: [wet, dry, alt:<preset>], stems, name}` |
| `POST /api/exports/rekordbox` | `{export_ids, playlist, target_path_root?}` |
| `GET / PATCH / DELETE /api/library` | Take history |
| `POST /api/batch` | Setlist rendering |
| `GET / PUT /api/settings` | App settings |
| `GET /api/audio/{id}` | Stream audio |

**Export rules for Rekordbox/CDJs:**
- **Format:** AIFF 44.1 kHz / 24-bit stereo by default. WAV is optional.
- **WAV header:** a WAV must be **integer PCM, format tag 0x0001**. CDJs reject WAVE_FORMAT_EXTENSIBLE (0xFFFE) with error **E-8305**, so a test checks header bytes 20–21.
- **Tags:** ID3v2.3 in AIFF: title, artist "GUY FVWKS", BPM, key, the script and preset in the comment, and the render parameters as JSON in a custom field (TXXX). WAV gets RIFF INFO instead.
- **Filename:** `GUYFVWKS_<PRESET>_<slug>_<bpm>bpm_<bars>bar_<key>_<variant>_v<nn>.aiff`
- **rekordbox.xml:** a COLLECTION plus a playlist.
  - Beatgrid: a TEMPO element starting at 0.000 s.
  - **Hot cue A at the first word** (a POSITION_MARK with Num=0), and a memory cue at the tail (Num=−1).
  - A configurable **target path root**, so the XML also works on your Rekordbox laptop.
  - Import it in Rekordbox under Preferences → Advanced → rekordbox xml.
- **Sampler loops:** bar-exact files also sync in Rekordbox's sampler in Loop mode with BPM SYNC on.

## Execution
**Right after you approve (this session acts as coordinator):**
1. **Send you `DESIGN_HANDOFF.md`** (Appendix A) as a file, so Claude Design can start immediately.
2. **Step 0 bootstrap (~30–45 min):**
   - `git init`, `.gitignore`, and the `docs/` folder (this plan, the handoff, and the 4 session briefs).
   - `fvwks_contracts` pydantic models.
   - **Server stub** with every route returning example data and fixture audio. Export `contracts/openapi.yaml` and `chain.schema.json` from it.
   - Voice stub, and an fx passthrough stub that normalizes and pads to bars.
   - 7 preset JSON files.
   - 4 dry Kokoro fixtures via `uv run --with mlx-audio`. This also proves Kokoro works on this Mac.
   - `scripts/`.
   - Commit and tag `v0-contracts`.
3. **Launch 4 individual sessions** (S1–S4), each in its own worktree/branch with its brief from Appendix B. I'll use direct session start if this app allows it; otherwise you get 4 one-click session chips.
4. **Coordinate:** watch the status files, rule on contract proposals, route your Claude Design bundle to S4, then integrate.

**Rules for every session:**
- Edit only the folders you own.
- Contracts are frozen. Needed changes go in `contracts/proposals/S<n>.md`, backed by a backward-compatible local workaround.
- Commit per milestone and keep `docs/sessions/S<n>-status.md` current.
- Never commit `engine/uv.lock`.
- **No model downloads other than Kokoro without your OK.**

**S1 — VOICE** (`engine/voice`)
- `TTSEngine` protocol. Kokoro-MLX adapter: voice list with tags, speed (default 0.9), warm-up.
  - If mlx-audio pulls in PyTorch (over 1 GB), make kokoro-onnx the default instead.
  - Pin the `en_core_web_sm` wheel so misaki doesn't pip-install it at runtime.
- Markup parser, lexicon (with a user JSON and ALL-CAPS handling) and per-segment synthesis. Returns a Source with segments.
- **STACK voices** are synthesized from the same segments.
- Ingest: decode with soundfile, resample to 48 kHz, trim, high-pass, normalize, split segments on silence.
- **Stretch (needs your OK):** Qwen3-TTS persona.
  - Disk check first: at least 5 GB free.
  - VoiceDesign produces 3 candidates; save one, then generate every line from it with Base clone.
- **Tests:** parser, lexicon and ingest. A warm 10-word line synthesizes in under 1 s.

**S3 — ENGINE SERVER** (`engine/server`)
- Replace the stub route bodies without changing signatures (the OpenAPI drift test enforces this):
  - SQLite library.
  - Content-addressed caches, plus a background job for WORLD analysis that calls S2's analysis function.
  - Jobs with progress, batch/Setlist, settings.
  - Token auth, and CORS for the app origin only.
  - Entry point: `fvwks-engine --port --token --data-dir`.
- **File writing (`write_audio`):**
  - AIFF by default, or WAV, 24-bit, via soundfile. WAV must use **fmt tag 0x0001**, checked by a test.
  - Tags: ID3v2.3 via mutagen for AIFF, RIFF INFO for WAV.
  - Variants (wet, dry, alt preset), stems, the filename pattern, TPDF dither for 16-bit.
- **rekordbox.xml:** TEMPO at 0 s, hot cue A at the first word, memory cue at the tail, target path root.
- Engine bundle script for the portable .app (uv standalone Python + relocatable venv).
- **Tests:** drift test, a full API flow tts → render → export → xml, header bytes, tags read back, XML parses back.

**S2 — SOUND** (`engine/fx`). The heaviest session: pure DSP, no file I/O.
- **B1.** Module registry of pure functions `(float32[ch, n], sr, params) → array`. Stage memoization. Macro resolver.
- **B2.** MASK on WORLD: shift, monotone/scale-lock, formant warp, McAdams, breath, growl. Fast preview path via stftpitchshift.
- **B3.** LAYERS (sub, ghost, stack with per-segment alignment) and MACHINE (vocoder, ring mod, frequency shifter).
- **B4.** The remaining modules:
  - DRIVE: pedalboard Distortion and Clipping, oversampled, plus custom tube and fold curves.
  - CRUSH: Bitcrush, Resample, GSM and MP3 codecs, noise bed.
  - TONE: LadderFilter and shelf/peak filters.
  - MOTION: Phaser, Chorus.
  - DYNAMICS: Compressor plus the 3-band OTT.
  - SPACE: Convolution with generated IRs, Delay, throws, swell.
  - STEREO: width.
- **B5.** ARRANGE: exact bar length, fitting with at most 8% R3 stretch, Beat-Lock, pre-roll, tail, stutter, tape-stop.
- **B6.** MASTER:
  - Loudness modes: CLUB short-term max, BAKE-IN, CUSTOM.
  - BrickwallLimiter true-peak ceiling.
  - Resample 48→44.1 kHz with `resample_poly(147,160)`.
  - Exact-sample length. TPDF dither for 16-bit.
- **B7.** Mask-strength scorer. `render()` returns the final float buffer at the output sample rate with exact length, plus metrics, dry and wet peaks, placed segments, the fit report, `resolved_chain`, and optional stems.
- **B8.** The 7 presets plus macro maps, validated against the schema. `fvwks render` CLI.
- **B9.** **Audition pack** in `out/audition/`: each fixture through each preset and macro sweep, with spectrogram PNGs, for you to listen to.
- **Tests:**
  - Measured F0 within ±0.5 st of the target.
  - Exact sample length.
  - LUFS within ±0.5 of the mode target, true peak at or below the ceiling.
  - No NaNs, and mono-compatibility.
  - Golden renders with tolerance.
  - Performance targets.

**S4 — APP** (`app/`)
- **Phase 1 (no design needed, starts immediately):**
  - Electron + Vite + TS (strict). Main process spawns the engine (`uv run --project ../engine fvwks-engine`), with random port and token, health wait, restart on crash, logs.
  - Preload bridge, plus contextIsolation, sandbox and CSP.
  - Client typed from `openapi.yaml`. **MSW mocks** with the fixture audio. TanStack Query and Zustand.
  - wavesurfer waveform with a bar/beat grid, segment regions, dry/wet A/B and loop.
  - Recorder: getUserMedia → WAV. Import any file via Web Audio decode.
  - Re-render on knob release (150 ms debounce).
  - **Drag-out:** `startDrag({file, icon})` from every cartridge and Vault row.
  - Keyboard shortcuts.
  - Functional but unstyled screens using the Appendix A component names.
- **Phase 2 (when your Claude Design bundle lands in `app/design/`):** apply its tokens, components and states, following its README.
- **Packaging:** `electron-builder --mac dir` produces an ad-hoc-signed `FoxBox.app` in ~/Applications, with the mic usage description.
  - Default build is **linked**: it runs the repo's engine.
  - Optional **portable** build uses S3's engine bundle.
- **Tests:** Vitest, and a Playwright Electron end-to-end run: launch → type → render → export → file exists.

**Integration (coordinator, after S1–S4 finish):**
1. Merge S2, then S1, then S3, then S4. Folders don't overlap.
2. Settle the proposals.
3. Run `uv lock` and commit the lockfile.
4. Run `scripts/check.sh` and the end-to-end test.
5. Listen through the audition pack together and tune `engine/fx/presets/*.json`.

## Verification (end-to-end)
1. `scripts/check.sh` passes: pytest for voice, server and fx, the OpenAPI drift test, and Vitest.
2. Launch the app. The engine shows READY.
3. Type `WE ARE GUY FVWKS | EXPECT *US*`, then pick am_fenrir, PACT, 140 BPM, 4 bars and key Am. Render. The preview plays and A/B shows the dry voice. The stack collage and the throw on "US" are audible.
4. Export produces an AIFF at 44.1 kHz / 24-bit. Check:
   - **Exactly 302,400 samples** (4 bars at 140 BPM).
   - Short-term max −7 ±0.5 LUFS.
   - True peak ≤ −1 dBTP.
   - ID3 tags read back.
   - A WAV variant has format tag 0x0001.
5. Drag the cartridge into Finder and into GarageBand. The file lands in both.
6. Export rekordbox.xml for 3 drops. Check that the XML is well-formed. Then import it into Rekordbox on your DJ machine and confirm the grid and hot cue A are right.
7. Record 5 s of your own voice through PACT. The badge shows STRONG, and you can't recognize yourself even after re-pitching +9 st. RAW alone shows MEDIUM with reasons.
8. A 5-line Setlist batch produces 5 files plus a playlist XML.

**Later (not v1):**
- AI voice conversion slot (Chatterbox VC or MeanVC).
- Live soundboard.
- User AU/VST3 plugins in the rack.
- Serato/Traktor exports.
- `/design-sync` of the built component library back into Claude Design.

---
## Appendix A — Claude Design handoff brief
*(Paste this into Claude Design now. Right after approval I also send it as `docs/DESIGN_HANDOFF.md`. `contracts/openapi.yaml` follows about 30 minutes later; attach it too if you like.)*

**Product.** FoxBox is a macOS desktop voice-mask studio for the anonymous DJ **GUY FVWKS**. You type a
line or record your voice. It comes back as a low, distorted, anonymous "transmission". Then you drag a
bar-exact, club-loud file straight into Rekordbox or Ableton.
- **Core loop:** type → hear → twist 4 knobs → export → drag out. It should take under 30 seconds.

**Audience and context.**
- One user: a DJ/producer, not an audio engineer.
- Prep happens at home, in the dark, on a MacBook Pro 14". Design at **1512×982**; the minimum window is 1280×800.
- The mouse is primary, with power-user keyboard shortcuts.
- Big, confident controls come first; the deep rack is second.

**Brand direction.**
- **Sources:**
  - GUY FVWKS is a Guy Fawkes pun.
  - Anonymous-style broadcast hijacks and "WE ARE ___" messaging.
  - The dark, masked bass-music world (Deathpact).
- **Mood words:** intercepted transmission, redacted dossier, black-ops console, gunpowder/ember, stage gear.
- **Explore 2 directions on the Studio screen first, and let me pick:**
  1. **TRANSMISSION:**
     - Near-black console panels, bone-white text and one ember/signal-red accent, with amber for meters.
     - Monospace data, condensed display type, restrained phosphor glow and very subtle scanlines.
  2. **DOSSIER:**
     - A dark declassified-file look: redaction bars, stencil/typewriter type, stamp marks, serial numbers ("TRANSMISSION #0042").
- **Rules:**
  - No stock neon-cyberpunk gradients or glassmorphism.
  - **Do not reproduce the V for Vendetta / Anonymous mask artwork**; it is Warner Bros-owned. Use an original abstract mark, or none.
  - Only open-license (OFL) fonts, because the app bundles them.

**Screens** (left rail navigation):
1. **STUDIO** (main; no scrolling at 1512×982):
   - **Top bar:**
     - App mark and engine status (READY / LOADING MODEL / OFFLINE).
     - BPM field with tap-tempo, KEY picker, BARS (1/2/4/8/16/FREE).
     - Output format chip (AIFF 24/44.1), loudness mode chip (CLUB / BAKE-IN).
     - RENDER button.
   - **SOURCE panel**, with tabs TYPE | RECORD | IMPORT:
     - TYPE:
       - A big monospace **Script editor** with markup highlighting: `|` shows as beat ticks, `[0.5]` as pause chips, `*word*` as a highlighted "throw".
       - A markup cheat-sheet popover.
       - **Voice picker**: cards with a 2 s audition button and tags.
       - Speed control.
     - RECORD:
       - Giant record button, input meter, 3-2-1 count-in, takes list.
     - IMPORT:
       - Drop zone.
   - **SIGNAL view** (center hero):
     - Output waveform over a **bar/beat grid** with numbered bars, segment regions, playhead, dry/wet **A/B** and loop.
     - **Fit indicator**, e.g. "speech 7.2 s → 4 bars @140 = 6.86 s: STRETCH 0.95× or go 8 BARS", with suggestion chips.
     - **Loudness meter** (short-term LUFS max, true peak) and a **Mask-strength badge** (SYNTHETIC / WEAK / MEDIUM / STRONG, with reasons on hover).
   - **RACK:**
     - Preset strip: PACT, LEGION, ABYSS, UNIT, GHOST, SIGNAL, RAW, plus user presets.
     - **4 macro knobs** as the visual hero: DEPTH, GRIT, MACHINE, SPACE. Each has a ring showing its mapped parameters.
     - "OPEN RACK" expands 13 module cards, each with a bypass switch and 3–6 controls: PREP, MASK, LAYERS, MACHINE, DRIVE, CRUSH, TONE, MOTION, DYNAMICS, SPACE, STEREO, ARRANGE, MASTER.
     - Save preset.
   - **Output cartridge:**
     - A draggable tile showing the file name, duration, BPM/key and a mini waveform.
     - Actions: EXPORT, REVEAL, ADD TO SETLIST.
2. **VAULT** (library):
   - Rows showing play, the script with a redaction-style reveal, preset, voice, BPM/key/bars, LUFS, date, tags and a star.
   - Filters. Every row is draggable.
   - Multi-select → export to a Rekordbox playlist, or re-render with another preset.
   - Open in Studio.
3. **SETLIST** (batch):
   - Rows of lines, each with its own preset, voice, BPM and bars, plus a status.
   - Paste-many, render all with progress, export a folder plus rekordbox.xml under a playlist name.
4. **VOICES:**
   - Installed voices.
   - An optional "Persona designer": describe a voice → 3 candidates → audition → save. This needs a download, so show its size and the free disk space.
   - Lexicon editor (FVWKS → "Fawkes").
5. **SETTINGS:**
   - Export folder, format, sample rate.
   - Loudness mode and targets.
   - Filename pattern, artist tag.
   - Rekordbox options: hot cue at first word, memory cue at tail, target path root.
   - Audio output.

**States to design.**
- **Startup:** first run / engine starting; model downloading, with progress and free disk.
- **Studio flow:** empty studio (placeholder script "WE ARE GUY FVWKS | EXPECT *US*"); stale while editing; synthesizing; preview rendering; final rendering.
- **Export:** export success toast with a draggable cartridge; Rekordbox XML exported, with import steps.
- **Problems:**
  - Engine offline, with reconnect.
  - TTS or render error.
  - Fit overflow.
  - True-peak warning.
  - Mic permission denied.
  - Low disk (under 3 GB).
  - Batch partial failure.

**Interactions.**
- **Knobs:** vertical drag; Shift for fine control; double-click to reset; scroll; arrow keys; a value tooltip.
- **Rendering:** re-render on release. The waveform dims while stale.
- **Shortcuts:**

  | Key | Action |
  |---|---|
  | Space | Play |
  | ⌘↩ | Final render |
  | ⌘E | Export |
  | `\` | A/B |
  | L | Loop |
  | 1–7 | Presets |
  | ⌘S | Save preset |
  | ? | Shortcut overlay |

- **Accessibility:** AA contrast, visible focus, knobs work as ARIA sliders, and warnings never rely on colour alone.

**Mock data:**
- **Voices:** Fenrir (US male), Michael (US male), Puck (US male), George (UK male), Heart (US female).
- **Numbers:** 140 BPM, A minor / 8A, 4 bars, −7.0 LUFS, −1.0 dBTP, 6.86 s.
- **File:** `GUYFVWKS_PACT_we-are-guy-fvwks_140bpm_4bar_Am_wet_v01.aiff`.

**Deliverables:**
1. Two direction explorations of Studio.
2. Every screen and state above in the chosen direction.
3. A component sheet with states. Use these names:
   - Layout: AppShell, TopBar, EngineStatus, TempoField, KeyPicker, BarsPicker, SourceTabs.
   - Source: ScriptEditor, VoicePicker, Recorder, ImportDropzone.
   - Signal: SignalView, BarGrid, FitIndicator, LoudnessMeter, MaskBadge.
   - Rack: PresetStrip, MacroKnob, Knob, Fader, Switch, Segmented, ModuleCard, RackPanel.
   - Output and tables: Cartridge, ExportSheet, VaultTable, SetlistTable.
   - Voices: PersonaDesigner, ModelCard, LexiconEditor.
   - Feedback: Toast, ProgressOverlay, EmptyState, ErrorState.
4. **Design tokens as CSS variables**: colour, type scale, spacing, radii, shadows/glows, motion durations and easings.
5. A clickable prototype of the core loop.
6. **Handoff to Claude Code** targeting **React + TypeScript + Vite inside Electron**, with CSS variables and CSS Modules. Data fields should follow `contracts/openapi.yaml`.

**Handing the design back:** in Claude Design choose Export → Handoff to Claude Code and download the zip. Give it
(or its handoff prompt) to me. I'll unzip it into S4's `app/design/` and tell S4 to start Phase 2. S4 builds
unstyled screens with these exact component names in the meantime, so keep the names stable.

---
## Appendix B — Session briefs (I launch these; Step 0 also saves them as `docs/sessions/S{1..4}.md`)
Every session gets the same header:

> You're one of 4 parallel sessions building FoxBox.
> 1. Read `docs/PLAN.md` and your `docs/sessions/S<n>.md`.
> 2. Work only in your own worktree/branch. If you're not already in one, create it with EnterWorktree.
> 3. Edit only the folders you own.
>    - Contracts are frozen: write proposals to `contracts/proposals/S<n>.md`, backed by a backward-compatible local workaround.
>    - Keep the route and seam signatures unchanged.
> 4. Commit per milestone and keep `docs/sessions/S<n>-status.md` current.
> 5. Don't commit `engine/uv.lock`, and don't download any model other than Kokoro.

Then each brief adds its own part:

| Session | Branch | Owns | Builds | Done when |
|---|---|---|---|---|
| **S1 VOICE** | `session/s1-voice` | `engine/voice/` | The S1 bullets | Voice tests pass. The server stub returns real Kokoro Sources with segments and stack voices. |
| **S2 SOUND** | `session/s2-sound` | `engine/fx/` | B1–B9 | You can't listen, so verify with measurements (F0, LUFS, true peak, exact length, spectrograms). Done when the tests pass and `out/audition/` is ready for the user. |
| **S3 ENGINE** | `session/s3-engine` | `engine/server/` | The S3 bullets | The drift test is green. The full API flow tts → render → export → rekordbox.xml works against the voice and fx stubs. The header-byte and tag tests pass. |
| **S4 APP** | `session/s4-app` | `app/` | Phase 1 now, Phase 2 when the design bundle arrives, then packaging | The Playwright Electron end-to-end run passes, and dragging a cartridge into Finder and GarageBand works. |
