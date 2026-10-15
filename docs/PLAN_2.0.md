# FoxBox 2.0: STRINGS only (revised)

## Context
The user wants every feature except STRINGS removed, archived and compressed. STRINGS becomes the flagship, and it gets an in-house UX redesign "that actually makes sense". It has two purposes:
- **Primary: making sounds.** It's an air instrument. This is new: today, STRINGS makes no sound unless a song or the TEST BEAT is playing.
- **Secondary: remixing songs.** That is today's STRINGS: stems, beat FX, finger filters, GLASS and scrubbing.

**User decisions (2026-10-14):**
- Two playing styles, switchable: **PLUCK** (fingers pluck notes) and **FLOW** (theremin-like).
- Sounds at launch: **BASS** (808, REESE, GROWL, WOBBLE) and **MELODY** (PLUCK, LEAD, KEYS). Only DSP, no generative AI.
- **In-house design.** S5 designs, S4 builds, and the user reviews screenshots.
- **Changed 2026-10-15:** the user rejected S5's four style options. The design now comes from **Claude Design** (prompt: docs/STRINGS_2_DESIGN_PROMPT.md). S4 builds functional, unstyled screens with its component names until the handoff lands.
- **FoxBox 2.0 ships as an auto-update to everyone.** 1.5.5 stays on GitHub as the full toolkit, and no user files are deleted.
- **Revision:**
  - Making sounds never involves the demo track or any song. Songs and the TEST BEAT exist **only in REMIX**.
  - The two modes must **feel like completely separate UI styles**.

**Done:**
- The archive tag `archive/foxbox-1.5.5-full` is on b1ba1c4c.
- The verified bundle is `~/FoxBoxArchive/foxbox-1.5.5-full.bundle` (124 MB).
- No session has been briefed yet.

**What exploration found:**
- STRINGS' audio engine and song deck are created inside VISUALS (`screens/LiveScreen.tsx` ~l.118–200), handed over through `state/liveDeck.ts`, and RECORD's sound comes via `setClipAudio`. All of that must move before VISUALS can go.
- About 10 imports drag other features into STRINGS:
  - `StringsPreview` → `TdPreview` (only for `cameraAlert`);
  - `prodActions`, `liveCapture` and `soundMap` → `state/visuals`;
  - `clips/render` (only for `CLIP_SIZE`);
  - `state/song` → `state/studio`;
  - `SongStrip` → `RekordboxImport`;
  - `songDeck` → `api/remix` (only for `waitJob`);
  - `prodFeed` → the TouchDesigner feed.
- **Engine:** REMIX needs only songs, stems, jobs, audio, health, models and settings. Stems run on MLX (no torch). Dropping TTS and voice deps takes the zipped runtime from 293 MB to about 150–180 MB. New installs also stop downloading Kokoro (342 MB) at boot.
- **Tone.js is already a dependency.** The instrument uses its voices before any custom worklet.
- **The HARDWARE look** (`app/design/remix/`: `README.md`, `remix-tokens.css`, the prototype) is a dark DJ console the user chose in Claude Design for REMIX in 1.5. It is ready-made for the REMIX mode.

## Shape of the new app: two worlds, one switch
It's one window with no rail. The name stays **FoxBox** (`appId` and `productName` unchanged, so updates keep working). It opens in **PLAY**.

The switch between modes is a whole-screen change: layout, palette, type and how the strings are drawn all change, not just a side panel. The two modes share only invisible plumbing (camera and hand tracking, face hiding, RECORD and OUTPUT, updates) and the settings sheet.

**PLAY: make sounds** (the primary mode). Its own instrument style, which S5 proposes. Direction: minimal and luminous, with the strings as the hero and little chrome.
- **Stage:** the camera with the strings labelled by note. Coach text when no hands are seen ("Raise both hands"). A live readout ("PLUCK · C#m · 808").
- **Controls:**
  - SOUND (BASS: 808, REESE, GROWL, WOBBLE; MELODY: PLUCK, LEAD, KEYS);
  - STYLE (PLUCK or FLOW);
  - KEY + SCALE (minor pentatonic by default);
  - OCTAVE.
- **None of the song world:** no track, TEST BEAT, BPM, timeline, stems or BEAT FX sheet.
- **Its own hand-shape set for sound design** (for example, fist adds drive and pinch sets the wobble rate), separate from REMIX's beat FX. S1 and S2 settle it.
- **RECORD** saves a WAV take of what you played, with drag-out to Ableton/Rekordbox.
- **First sound within 10 s** of a fresh launch, with no download. PLAY never waits for the engine.

**REMIX: remix a song** (the secondary mode). It is the 1.5.5 STRINGS, restyled in the **HARDWARE** console look.
- Load or drop a track, or the TEST BEAT.
- ▶, the section timeline, stems, the BEAT FX sheet, GLASS and the finger filters.
- RECORD (MP4 or WAV) and SEND TO OUTPUT.
- The stems model (84 MB) downloads on the first stem split, not at boot.

**Playing defaults** (S1 and S2 tune them; the user judges by hand):
- **PLUCK:** folding a finger plucks its string; velocity comes from how fast it folds. The 10 fingers are 10 scale notes, with the left hand an octave below the right. Tilt slides the pitch, shake adds vibrato, and hand height sets the octave.
- **FLOW:** the right hand's height sets the pitch (scale-snapped, with glide), the spread between the hands opens the filter, shake adds vibrato, and a closed fist mutes.
- **There is no tempo in PLAY.** Rates such as the wobble come from the hands. Skipped: a TEMPO for synced wobbles; add it only if the user asks.
- The both-hands-open playing pose must never fire an FX (today it fires GROWL).

## Work plan (parallel sessions; each on `help/sN-2.0`, one candidate tree each)
**Wave 1, all at once:**
1. **PM:**
   - `docs/ARCHIVE.md`: what was removed, and how to restore a feature with `git checkout archive/foxbox-1.5.5-full -- <path>`.
   - The OSS scan for the instrument (links, licence, whole vs inspiration) goes to the user.
   - The PM rules on contracts **v1.0** (the trimmed API).
2. **S4: removal in the app.**
   - Move the deck and audio-engine owner out of `LiveScreen` into `state/liveDeck.ts` (REMIX only), including `getClipAudio`.
   - Cut the ~10 cross-feature imports above.
   - Then delete:
     - the STUDIO, VISUALS, MASKS, REMIX-page, VAULT, VOICES, SETLIST and Setup pages and components;
     - TouchDesigner (`touchdesigner/`, `app/native/syphon`, `main/bridge/*`, the `td*` shared files);
     - Ableton Link, shaders, sample packs and the mic IPC;
     - the dead files, the designs for removed pages, and their tests.
   - **Keep** `app/design/remix/` (the HARDWARE look).
   - Remove the rail, trim `menu.ts`, and drop the dependencies nothing uses (`butterchurn`, `interactive-shader-format`, `troika`…). Keep `three` and `tone`.
   - **Gate:** typecheck clean, vitest green, and REMIX behaves exactly like 1.5.5.
3. **S3: slim the engine.**
   - Keep the songs, stems, jobs, audio, health, models and settings routes.
   - In `fx`, keep `song`, `structure`, `bassline`, `harmony`, `stems` and the plumbing. Decouple `song.py` from `master.py`, and drop `_cache_mash`.
   - In `voice`, keep only `stems/` plus the models catalog, with only `stems-htdemucs` (not required at boot).
   - Delete `engine/synth`, and list `mlx` and `huggingface-hub` directly.
   - Run `uv lock`, regenerate `openapi.yaml` with the drift test green, and rebuild the runtime with `bundle_engine.sh`.
   - **Gate:** pytest for the kept modules, plus a bundle smoke: health → upload → analysis and sections → stems.
4. **S2: the PLAY instrument, fully separate from the song chain.**
   - Tone.js voices on FoxBox's AudioContext (`Tone.setContext`): 808 with glide, REESE, GROWL (FM plus formant), WOBBLE (hand-rate LFO), PLUCK, LEAD and KEYS.
   - Its own FX chain: Tone effects into the existing `fvwks-limit` worklet. Not `SongFx`, not `SongDeck`, not `testBeat`.
   - The key/scale note map, the PLUCK and FLOW input API, and the PLAY shape set's sound.
   - A worklet only if Tone measurably falls short on latency or CPU.
   - **Gate:** unit tests (scale map, the input API), plus a hidden offline render of every sound: not silent, F0 within ±0.5 st of the note, under the ceiling.
5. **S1: playing gestures.**
   - Pluck events: the fold's onset, velocity and debounce, per finger and hand.
   - FLOW signals: height to pitch, spread, mute.
   - The PLAY shape set, kept separate from REMIX's `SHAPE_FX`.
   - Fix the open-palm conflict.
   - Full-rate tracking in PLAY: skip face, pose and segmenter when not needed.
   - **Targets:** at least 25 hands/s in a dim room, and pluck-to-sound at most ~80 ms.
   - **Gate:** the hidden tracker harness: every fold in a recorded clip fires one pluck.
6. **S5: two style directions and mocks.**
   - `docs/STRINGS_UX.md`: the mode switch, the first run (opens in PLAY, first sound in under 10 s), empty states, copy, each mode's gesture legend, and shortcuts.
   - Two clearly different static mocks:
     - **PLAY**, a new instrument style;
     - **REMIX**, the HARDWARE tokens.
   - The PM sends the user screenshots at 1512×982 and 1280×800 **before** S4 builds either screen. Use the impeccable skill.

**Wave 2:**
- **S4** builds both screens from the approved mocks and merges S1, S2 and S3. It adds RECORD (PLAY: a WAV take with drag-out, reusing main's `startDrag` and the drag-out in `SavedClip.tsx`; REMIX: as in 1.5.5 plus WAV), the settings sheet, and a WHAT'S NEW 2.0 guide (it says where 1.5.5 lives).
- **S3** draws the strings twice, once in each style: in PLAY, note names and a flash on each plucked string; in REMIX, today's band look.
- **S5** runs a first-time-user audit on the build.

**Wave 3, release:**
- Set the version to `2.0.0` and build the RC with the new engine-runtime part (electron is reused).
- Give the user an isolated test copy.
- Test the update path, then the user says "publish".
- Rewrite the README (link to 1.5.5 for the old toolkit), write the release notes, and publish v2.0.0 with `publish_snapshot.sh` and `gh release`.

**Skipped:** freeing users' old voice models (up to ~12 GB) from inside the app. Add it if the user wants it.

## Critical files
- `app/src/renderer/src/App.tsx`, `state/ui.ts`, `state/liveDeck.ts`, `screens/LiveScreen.tsx` (the deck owner to move)
- `components/prod/*` (ProdPage, StringsPreview, StringsPanel, ProdStrip, SectionTimeline, prodActions, prodFeed)
- `audio/live/{engine,songDeck,songFx,beatFx,soundMap,testBeat}.ts`, `worklets/live-processors.js` (`fvwks-limit`)
- `components/camera/{fxShapes,smartCamera,vision.worker,camMath}.ts`, `components/strings/*`
- `app/design/remix/{README.md,remix-tokens.css}`, `styles/tokens.css`
- `app/src/main/index.ts`, `menu.ts`, `updater.ts`, `components.ts`; `app/electron-builder.config.cjs`, `scripts/release.mjs`
- `engine/server/src/fvwks_server/{app,service}.py`, `engine/fx/src/fvwks_fx/{api,song}.py`, `engine/voice/src/fvwks_voice/{api,models}.py`, all `pyproject.toml` files, `engine/server/scripts/bundle_engine.sh`

## Verification
1. **Each session's gate (above):** typecheck and vitest, engine pytest plus the drift test, and the hidden proofs.
2. **PLAY is song-free:** a unit test asserts that PLAY creates no `SongDeck`, loads no TEST BEAT and makes no `/api/songs` call. A fresh launch plays its first pluck with the engine still starting.
3. **Sizes against 1.5.5:** the runtime part about 150–180 MB zipped (was 293), the app part smaller than 22 MB, and the DMG smaller than 420 MB.
4. **Update path:** an isolated installed 1.5.5 copy updates to the 2.0 RC through a local feed (runtime part replaced) and launches clean. This is the first runtime change since v1.2.1.
5. **RC smoke (content):**
   - a fake-camera pluck in PLAY gives audio above the floor, with no song;
   - REMIX loads the test song, splits stems and seeks to the bar;
   - RECORD writes a WAV that isn't silent in each mode.
6. **The user's test copy** (isolated HOME, `open -n --env`):
   - opens in PLAY, with a first sound within 10 s;
   - PLUCK and FLOW play in key;
   - BASS and MELODY sounds;
   - the switch to REMIX feels like a different app;
   - REMIX works as in 1.5.5;
   - a PLAY take drags into Ableton.
