# S1 VOICE + CAMERA: status

Updated 2026-09-29 (afternoon). 1.5 is frozen: my camera sha is `help/s1-camfix` a01e5f1. 1.5.1 work is on
`help/s1-151`. I own `engine/voice/` and the camera/clip files (`app/src/renderer/src/components/camera/`,
`components/clips/`). S4 owns the VISUALS page, the compositor and `visuals/live/bases/*`.

## Camera for 1.5 (help/s1-camfix a01e5f1, from s4-app b444d59)

- **Face crop** (`vision.ts` `nextRoi`): held while the face stays inside it; whole frame for big faces (in at 85 %
  of the height, out at 70 %). A crop that glided every frame made the VIDEO-mode landmarker search afresh each time
  (3x the worker time on small faces, jitter ~45 % of a face width): that was the face-01/02 regression.
- **Drawing** (`smartCamera.ts`): one primary face; a second one needs the detector at >= 0.7 and a plausible size;
  each face on one box; the mesh anchored on the per-frame detector box; held 300 ms, then a 200 ms fade.
- **Styles** (`faceStyles.ts`): LOW-POLY facets lit by their normals, the rim reaching out over glasses at eye level
  (back 5 cm along the head's forward axis, out 2.6 cm); DEPTH GLITCH (new, BETA tag on its chip) beside GLITCH.
- **Numbers:** `out/mask-audition/v2/README.txt` in this worktree (5 stock DJ clips, before/after).
- **Open:** the glasses rim isn't checked on the clips yet (a 2-clip heavy slot after the RC). QA harness lessons:
  Chromium throttles a covered test window (use `--disable-backgrounding-occluded-windows` and
  `setBackgroundThrottling(false)`); a quit can hang on either build, so quit by PID after 15 s.

## REMIX 1.5.1 (help/s1-151; help/s1-c11 stops at e0f905b, merged by S3)

- **yoi buzz** (e0f905b, in 1.5): the growl post's grit fold (mid x drive into sin(3y)) ticked on yoi's formant
  swells. `growls._GRIT_DRIVE` puts S1's yoi, riddim and dswub at 1.5 (S3's voices stay at 2). HF clicks per
  4-bar loop: yoi 60 -> 0, riddim 28 -> 16, dswub 8 -> 0.
- **M1.4a** (103a403): `riddim.shift` (off / on, a tie keeps off): R1 through a +-20-80 Hz freq shift with a 1/64
  echo at 25 %.
- **M1.12a** (bad0597): `bass808.line_from_groove(notes, root_pc, minor)`: BASS DNA's groove as an 808 line (1/16
  grid, the key's scale, the root in C1-B1, legato only where the source glided). S2 wired it on help/s2-m114.
- **Gate loops** (L4, L5, L9): `out/growl-audition-s1/` in this worktree, 22 MP3s and a README.
- **Next:** re-voicing after the listening round. If R1's remaining HF ticks are heard (0-12 per loop, most at
  1/8T): they start in the FM'd square itself, ~21 ms after each LFO restart (not the grit, not the LFO's step: easing
  the LFO made them worse), so tame `riddim.r1_fm_peak` or low-pass the square before the comb; the grit at 1.2 only
  trims what's left.

## REMIX sound design (help/s1-riddim, 2026-09-29)

- **`riddim.py`:**
  - R1, the square-FM wub: comb, flanger, and a saw-down LFO restarted per note, at 1/4, 1/4T, 1/8 or 1/8T.
  - R2, the formant yoi.
  - Both are growl engines, routed in `growls._ENGINES` as "riddim" and "yoi".
- **`bass808.py`:**
  - `render_808_line(notes)`: glides only where notes overlap (80/240 ms, ±12).
  - The start is a ≤ +7 st drop settled by 30 ms, per the user's "too high and whiny".
  - Parallel saturation, 4x oversampled.
  - `render_darkhit`: on pitch, a low-pass bloom with grit.
- **`candy.py`:** an arp, a power-up and coin sounds, in key.
- **`drums.py`:** the §3.1 kit, synthesized: kicks (default, riddim, tearout), the L1–L4 snare stack, the pan snare,
  the clap with its room, hats, impact, crash, reverse cymbal.
  - Call: `render_drum(voice, sr, vel, seed, variant, root_hz, length_s)`, with a seeded micro-variation per hit.
  - S2 sequences it.
- **`riddim.py`, added:** `render_squeak` (the top layer) and `late_with_delay` (the off-grid "d" hit).
- **Seeded options** (the user's "there isn't always a correct answer"):
  - R1's variant is its LFO rate;
  - `r2_blend(seed)`;
  - `bass808.glide_times(seed)`.
- **Checks:** `synth/tests/test_s1_voices.py`.
- **Auditions:** in the main checkout's `out/growl-audition/` (riddim-r1-*, yoi-r2-*, 808-s1-*, darkhit-s1-*, drums-s1-*), rendered by
  scratch scripts.
- **Open:** "darkhit" isn't a `render_growl` style yet (S3 routes it); S2 calls bass808 directly.
- **C11** (help/s1-c11): `riddim.AXES` (R1 rate pool, throat, comb; R2 blend), `bass808.AXES` (glide, drop) and
  `hybrid.AXES`, all in `growls.AXES`. Each is resolved per take and passed down as `axes`
  (`riddim.option(axes, axis)`).
- **M1.15** (`hybrid.py`): "wobble", the old-school wobble (variant = rate), and "dswub", the downsample wub (variant
  = step shape). Both are `render_growl` styles.
  - Loops: `out/growl-audition/wobble-s1.mp3` and `dswub-s1-*.mp3`.

## REMIX: fvwks_synth, previews, the Ableton Live 11 export (2026-09-29)

- **fvwks_synth** (help/s1-synth 6162908, merged as a8dce76):
  - Surge XT runs in a child process: its HOME, CFFIXED_USER_HOME and SURGE_DATA_HOME are inside the engine data dir.
    `native/build_surgepy.sh` pins the Surge commit and applies our `setTempo` patch.
  - It has 12 CC0 Surge patches and 5 FoxBox patches, plus 4 TR-808 kits (Michael Fischer, via tidalcycles, CC0) and
    the FoxBox kit.
  - `bass.render_groove(...)` and `kit.render_kit(kit_id, hits, *, bpm, beats, sr)`, velocities 0–1. The PM has S2
    aligning prepare.py to these; keep the names.
- **Previews** (bb6ceb1):
  - `preview.preview(patch_id)` and `kit_preview(kit_id)` each return a cached WAV of one bar at 140 BPM,
    loudness-matched (-16 dBFS RMS, peak ≤ -1 dBFS).
  - They're cached in `<bass.configure dir>/previews`, keyed by content.
  - Cold: 4.6 s for everything. Warm: 3 ms.
- **.als writer** (56fb196, df4c735, BETA): `fvwks_server.als.write_als(remix, clip_audio, out_dir, name=None)` returns
  `<out_dir>/<name> Project/<name>.als`, with the audio copied into `Samples/Imported`.
  - Template: an installed Live's own `DefaultLiveSet.als`, else `als_live11.xml` (Live 11's default document
    structure, with no set content).
  - It writes the tempo (knob and master envelope), the meter, a track per lane (name, colour, gain, mute), warped
    arrangement clips (gain, fades), and locators at the sections.
  - IDs are unique, NextPointeeId is above them all, and there's a clip slot per scene.
- **Validation:**
  - Structure, against owenbush/ableton-inspector's Live 11/12 fixtures (MIT, read only):
    - every element path we write exists in real sets;
    - the child order matches Live 11.3's.
    - It caught Live 12's `MainTrack`/`IsSongTempoLeader` renames (handled).
  - Round trip, through ableton-inspector's reader: tempo, meter, locators, tracks and project-relative samples all
    come back.
- **Open:**
  - Fade lengths are written in beats, which is unconfirmed.
  - It's untested in real Live (there's no Live on this Mac).

## 1.5 SMART VISUALS handoff (2026-09-28)

**Scope (from the PM):**
1. Depth pass-through: a near face or hand comes through the effect layers, still encrypted.
2. At least 6 new irreversible face styles.
3. Hand and body signals for effects and S2's director.
4. AUTO-FRAME: a 16:9 camera into a 9:16 output follows the person.

**Done**, on help/s1-smartcam:
- `f61c803`: eight styles in `faceStyles.ts` (GLITCH, ASCII, REDACTED, LOW-POLY, FOX MASK, STATIC, HALFTONE,
  THERMAL VOID), plus MOSAIC/BLUR/SOLID, through `compose.maskRegion`, so live and clips match.
  - Irreversible by construction: image styles see only a grid of at most 16 cells across; REDACTED, STATIC and
    FOX MASK use no picture.
  - They animate with `FaceMask.react` (a stem pulse).
  - Also here: the MediaPipe models and `camMath.ts` (unit-tested).
- `5040390`: `smartCamera.ts` (tracking, near mask, signals, AUTO-FRAME), `nearMask.ts`, `CameraControls.tsx`,
  `smartCameraBase.ts` (a drop-in CAMERA base), `vision.ts`, and the store's `passThrough` and `autoFrame`.
- `d0374c2`: GestureRecognizer replaces hand_landmarker (named gestures in the signals), sticky calibration, and the
  landmarker at 0.6 confidence.

**APIs** (all sent to S4):
- `nearMask()` in `components/camera/nearMask.ts` returns `{ mask, level } | null`.
  - null when PASS-THROUGH is off, there's no camera, or nothing is near.
  - The mask is in the camera base's frame at 1/4 size; its alpha is how near.
  - S4 passes it as `Compositor.frame(a, dt, { passThrough })` (68c951c).
  - Tell S4 to drop `ctx.globalAlpha = pass.level` in compositorEngine: my alpha already carries the level, so
    multiplying again squares the fade.
- `cameraSignals()` in `smartCamera.ts` returns
  `{ at, calibrating, near, head: { x, y, yaw, roll, lean } | null, hands: [{ x, y, pinch, open, near, gesture }] }`.
  - x/y are 0–1 in the drawn frame.
  - gesture is one of fist | open | point | thumbs-up | thumbs-down | victory | love, or null.
  - `recalibrateCamera()` is exported too.
- AUTO-FRAME: `camMath.autoFrame()`, applied inside `smartCamera.draw` when `settings.autoFrame` is on and the
  camera is more than 1.3× wider than the output. Clips can pass `FrameInput.crop` (compose.drawFrame).
- S4 wiring, not yet done by S4. A local patch of all three is in my scratchpad at `smartcam/s4-hooks.patch`:
  1. `bases/index.ts`: `case 'camera': return smartCameraBase(palette)`.
  2. CompositeStage: `c.frame(src, dt, { passThrough: nearMask() })`.
  3. BasePanel: `{base.kind === 'camera' && <CameraControls />}`.

**Verified end to end** (fake camera: the public-domain portrait resting, then leaning in, then panning; the y4m is
`scratchpad/smartcam/lean.y4m`, and the harness is `scratchpad/smartcam.mjs` on a temporary merge with the patch):
- near goes 0 → 1.00 on the lean and back to 0;
- the pass-through shows the encrypted face through the tunnel;
- AUTO-FRAME follows the pan;
- all 11 styles render.
Hands aren't e2e-tested (a still portrait has none); their maths is unit-tested.

**Since the handoff:**
- `bf80107` SMART CAM 4: the models run in `vision.worker.ts` (a classic worker; renderer `worker.format: 'iife'`).
  The stage went from ~44 to 80-111 fps. `faceTrack.mergeBoxes` gives one cover per face (the detector and the
  landmarker both reported it).
- `2125ad1`: SAVE CLIP renders the stage's scene text (`useSceneText()`).
- S4 wired all three hooks (ea4dc48, d30ab50).

**Next:**
- MediaPipe's graphs try to POST usage logs to odml.pa.googleapis.com. The CSP blocks them (nothing leaves); they
  only fill the console with errors.
- BlazeFace (0.35, fail-safe) covers a "face" in the portrait's hands on the fake camera. This is the same as 1.4,
  and deliberately kept.
- Hands are unit-tested only (the fake camera has none).

**Open decisions:** none pending. The PM accepted Canvas-2D styles, the ~50-landmark LOW-POLY, and depth from
matrix z + segmenter + palm-vs-face (no depth model; Depth Anything V2 Small only as a fallback, with the user's OK).

**Standing rules:**
- **Ponytail (level full)**, from the user: climb the ladder (does it need to exist → in the codebase → stdlib →
  platform → an installed dep → one line → the minimum). Fix at the root. No unrequested abstractions or deps.
  Shortest correct diff after reading fully. Leave one runnable check. Mark corner-cuts with `ponytail:`. Never
  simplify away validation, data-loss handling, security or accessibility. Reports: sha first, then at most three
  lines. SKILL.md: ~/.claude/plugins/cache/ponytail/ponytail/4.10.0/skills/ponytail/SKILL.md.
- **Downloads:** under 1 GB need no approval; over 1 GB needs the user's OK. Report every new package or model to
  the PM with why, what it does in plain English, and how popular it is. Don't edit THIRD_PARTY_NOTICES; the PM
  does them on main.
- **Approved OSS:** MediaPipe tasks-vision models (face landmarker, gesture recognizer, selfie segmenter);
  pmndrs/postprocessing and three.js passes for styles if needed; Depth Anything V2 Small as a fallback only.
  Avoid jeelizFaceFilter and three's AsciiEffect.
- **Test song** `~/<test media>/song-1.m4a`: local only. Never commit it, copy it into the repo,
  or show its original title (import it as "song-1").
- **No old brand anywhere** (code, tests, fixtures, docs, UI, screenshots, commits, GitHub). GUY FVWKS is fine.
- **Git:** identity SmittyTech <89995047+als7294@users.noreply.github.com>; never the credit email. Never `git push`
  (publish via scripts/publish_snapshot.sh). Never commit engine/uv.lock. Never bare `git stash`. Commit per
  milestone and send shas to S4 and the PM.
- **Camera:** never run the real camera from tools; use the fake camera (y4m). Test launches use temp data dirs
  (FVWKS_*_DIR). Don't write to other worktrees' files.

## Earlier: 1.4 (stems, SAVE CLIP), all shipped in 1.4.0
- `help/s1-stems`: separate_stems on HT-Demucs MLX (vendored model code, no new runtime dep), the stems-htdemucs
  model (84 MB).
- `help/s1-clip`: SAVE CLIP (offline WebCodecs render, mp4.ts muxer, elst-compensated AAC, 6 ms limiter
  lookahead removed); stems-driven features; `help/s1-clip-pause` 168497b (clipRendering flag).


## Handover (2026-09-27, wrap-up)
Everything that ships is merged, either by S4 (camera, app) or in main (engine). Nothing is left uncommitted.

**Engine** (`session/s1-voice` @ 3c0246a): models already on this Mac aren't downloaded again.
- `models.repo_dir` looks for the exact pinned snapshot in the other HF caches: $HF_HUB_CACHE, $HF_HOME/hub,
  ~/.cache/huggingface/hub and the other FoxBox*/models/hub.
- It trusts a snapshot only when every required file is there and the fetched files add up to exactly
  `size_bytes`. A trusted one is cloned in with `cp -c` (APFS, no extra disk), so list/health/install see it as
  installed. Anything else downloads as before.
- Kokoro's pinned size was corrected to 341,742,463 bytes.

**Camera** (`help/s1-camera`, all in session/s4-app; S4 has since added the fox intro/outro at 089c6a5, so
further camera work starts from there). The camera lives in RECORD (VOICE + CAMERA):
- A masked live preview sits in the orb's place, and takes are filmed too (in memory, only ever used masked).
- MAKE CLIP / RECORD CLIP make the clip. Clips are remuxed to plain MP4 (`remux.ts`).
- A filmed take plays back synced with its drop (`filmSync.ts`: speech onsets + `fit.stretch_ratio`). The whole
  picture is hidden for 0.4 s after any switch or jump.
- The DROP + SONG sound uses S4's shared song store (`state/song.ts`).
- The fox watermark loops every 7 s. It can be turned off in SETTINGS → Camera clips (view prefs).

**Open ends:**
- The camera has only been driven by a fake camera from my tools. Real-camera runs were the user's own.
- The README camera shot is 1× (1512×982), while the others are 2×. I offered to retake it.
- contracts/proposals/S3.md still shows Kokoro's old size in an example.

## 2026-09-27 (late): the ASR test flake and the TTS release
- **ASR flake (the coordinator saw one word's start 222 ms off under load).** It isn't load: MLX on the GPU isn't
  bit-exact between processes (even with the RNG seeded, Kokoro's audio differs a little per process), and within
  a process everything repeats exactly. The fragile spot was real, though: a short word right after a comma pause
  ("REMEMBER, THE"). The aligner ran THE mostly into the pause, and `_snap` refused to move it because THE would
  have kept only 15 ms. In some processes THE stayed ~200 ms early. `_snap` now starts it where the pause ends and
  gives it at least 40 ms, taken from the next word. Measured:
  - realign: THE's start error went from -200 ms (3 of 5 processes) to under 2 ms in all 5;
  - transcribe: at most 82 ms over 12 seeds and 3 processes.

  The test now names the word when it fails.
- **"TTS is cut off at the end sometimes."** Each chunk used to end at -50 dB below its loudest frame plus 60 ms,
  faded over 10 ms. The loudest thing dropped was a breathy release at -56 dB (af_heart's "Expect us."); the mask's
  compression and drive can lift that into hearing. A chunk now ends where its release falls below -70 dB, at most
  600 ms later, with a 30 ms fade. The start trim is unchanged, so onsets stay exact.
  - These values come from a sweep of all 28 voices x 4 lines (224 chunks). With -65 dB and 300 ms, 13 chunks from
    5 female voices still dropped tail peaks above -63 dB, because af_alloy and af_nova breathe out for ~0.5 s at
    -52 dB. Now the worst dropped tail is -65.3 dB. The release adds 10 ms at the median, 239 ms at p90, 527 ms at
    most. There are no leading clicks (the first 5 ms stay at -54 dB or lower). LEGION's and PACT's stack voices
    get identical segments.
  - ENGINE_VERSION is `s1.7`, so the server's TTS and STACK caches start over. Each segment's last word now ends
    exactly at the segment's end (they used to differ by 1 µs of rounding).
  - Every path (TTS, STACK voices, personas) goes through `render_script`. The chunk's closing period is added
    there, and the last word's end is the clip end.

## 2026-09-27: FoxBox scrub, fresh-Mac Kokoro fix, v0.6 model hooks, S4's editor package
- **Rename and scrub (the user's request, relayed by the coordinator):** the product is FoxBox. The old name and its
  example line are gone from engine/voice, fixtures, the fixture scripts and this file. The lexicon's user file
  lives in `~/Library/Application Support/FoxBox`. The example line is now
  `REMEMBER, REMEMBER [0.5] THE SIGNAL NEVER DIES | WE DO NOT FORGIVE | *EXPECT US*`.
  - **Regenerated fixtures** (same ids): `voices/remember_remember.wav` and its `fixtures.json` entry,
    `sources/remember__{am_fenrir,am_michael,bm_george}.{wav,source.json}`, and the second case of
    `markup_cases.json`. Only these were regenerated: re-running the scripts today doesn't reproduce the other
    fixtures byte for byte (mlx-audio has moved on since Step 0), so they were left alone.
- **Fresh-Mac ship-blocker (S3's repro), a50df21:** Kokoro looked up `refs/main`, which a pinned download never
  writes. Every loader now asks the registry (`models.repo_path`) for the revision in use.
- **v0.6 model hooks, a50df21:**
  - installer fields on `list_models()`: version, installed_version, update_available, default_selected,
    install_needs_bytes;
  - byte progress keywords on `install_model`;
  - `VoiceError.model_id` (P7);
  - `uninstall_model` (P8);
  - `apply_model_manifest` (P9: revision moves of the same repos only; file names and license re-checked with the
    Hub before an update downloads; the installed version stays in use until the update is complete).
- **S4's Phase 2.1 help package (`help/s1-script` f2a4031, merged by S4):** the app's markup parser is now a port of
  `fvwks_voice.markup`, tested on 85 engine-generated cases. It also has the insert buttons, the chip layer, and the
  TranscriptEditor.

**State: v0.1 adopted, all VoiceHooks implemented, persona designer working, espeak long-path bug fixed.**
- **Voice tests:** 149 pass (about 80 s with every model installed).
- **Whole engine suite:** with every session's code on main, 369 pass. The one failure is S3's
  `test_jobs_models_personas`, which assumes the persona model can't be installed (see the notes for S3).

## v0.3 contracts adopted (merged `v0.3-contracts`, db6ccc5)
- **`SourceInfo.denoise`:** the DeepFilterNet3 strength actually applied. 0.0 when it's off or when a tone/music
  take is kept as recorded; None for TTS.
- **`SourceInfo.transcript_state`:** `"none"` from ingest, `"done"` on what `transcribe()` and `realign()` return.
  The server sets queued, running and error around its background job.
- **The seam's `ingest(..., *, denoise=None)`** matches S1's signature. The extra `with_words` keyword is kept for
  scripts and tests.
- **Engine suite on this merge:** 449 passed, 8 failed. All 8 come from fx's `arrange.py` not accepting v0.2's new
  default `Arrange.bars = "auto"` (`ValueError: could not convert string to float: 'auto'`); the server
  batch/render/SIGTERM failures cascade from those renders. That's S2's AUTO-bars work, not voice code.

## Recorded-voice upgrades (round 2, approved by the user): done
ENGINE_VERSION is now `s1.5`. New models are pinned and license-checked, and all are installed on this Mac.

| Model | License | Size | Kind |
|---|---|---|---|
| `deepfilternet3` | MIT | 8.7 MB | required |
| `whisper-aligner`: Whisper large-v3-turbo + OpenAI's tokenizer files + Qwen3-ForcedAligner-0.6B-8bit | MIT + Apache-2.0 | 2.9 GB | opt-in; Whisper was already cached |

Contract proposals P5–P7 are in `contracts/proposals/S1.md`.

1. **Denoise at ingest (DeepFilterNet3 through mlx-audio).**
   - `ingest(data, filename, kind, *, denoise=None)`: strength 0–1, defaulting to 1.0 for recordings and imports.
     It runs after the 70 Hz high-pass and before the trim. There is no delay (lag 0), so the dry/wet mix is
     aligned. It takes 0.21 s for 4.7 s of audio; takes over 60 s go through in 30 s blocks.
   - **SI-SDR** against the clean line:

     | Noise | 5 dB SNR | 15 dB SNR |
     |---|---|---|
     | White | — | 15.0 → 24.0 |
     | Pink | — | 15.0 → 20.5 |
     | Hum + rumble | 5.1 → 20.0 | — |

     Clean input passes almost untouched: 36 dB, with 95% of the sibilant energy kept.
   - **Consonants:** 70–81% of the 4–10 kHz energy survives at 15 dB SNR, but only 26–42% at 5 dB broadband SNR,
     where lowering the strength helps (P5).
   - **Limits:** it can't separate a competing voice (babble at 5 dB SNR gets worse).
   - **Safety net:** a speech denoiser fades out steady tones, chords and music. When it would remove more than
     half of a take, the take is kept as recorded, with a warning.
2. **Word timings for recordings.**
   - `transcribe(source) -> Source` (new hook, background job, P6): sets `info.script` to the transcript and fills
     `Segment.words`. The last word of each segment keeps its release, as for TTS.
   - `realign(source, script) -> Source` (new hook, route in P7): the edited transcript, markup included,
     re-segments the take like TTS, with flags and per-word throws.
   - **How the words are placed:** Whisper transcribes (1.1–2.3 s for 5 s), the aligner places the words (0.1 s),
     then refinement:
     - Whisper's finer times are used where they agree with the aligner's 80 ms grid;
     - edges are snapped to pauses, guarded by punctuation;
     - squeezed words are repaired (the raw aligner does this to about 1 word in 128);
     - the text is normalized to normal case before aligning.
   - **Found and fixed: the aligner breaks on ALL-CAPS text.** An ALL-CAPS phrase collapsed 3 words to zero length.
     Case is now normalized before aligning, and the user's spelling is kept.
   - **Accuracy on noisy, denoised recordings** (128 words, known truth):

     | Path | Starts: median / p90 / max | Non-final ends: median / p90 / max |
     |---|---|---|
     | transcribe | 13.4 / 36.4 / 101 ms | 16.1 / 42.3 / 239 ms |
     | realign | 16.1 / 53.4 / 123 ms | 25.4 / 59.1 / 219 ms (ALL-CAPS text now identical) |
3. **S2's review findings:** they were already fixed in 4821036 (see below).
4. **S4:** `f0:NNN` tags on every Kokoro voice and on saved personas (9355987).
5. **MLX exit segfault (S3's finding):** `fvwks_voice.api` imports `mlx.core` at import time, so it lands on the host's
   main thread.

**Notes for S3.**
- **Ingest now uses a model.** DeepFilterNet3 adds about 0.2 s per 5 s of audio.
- **Transcripts in the background.** Call `voice.transcribe(src)` as a background job after an upload when
  `whisper-aligner` is installed. It raises `model_not_installed` otherwise. Replace the stored Source's info,
  keeping id and audio_id.
- **New route:** the realign route in P7.

**Notes for S4.**
- **Transcript and words:** a recording's transcript is `SourceInfo.script`, and its words are in `Segment.words`,
  once the server has run `transcribe`.
- **Editing:** editing it (the SAYS line) needs S3's P7 route.

## S2's review of engine/voice: fixed
All four findings were reproduced with S2's own probe scripts, fixed, and re-measured with the same probes.
ENGINE_VERSION is now `s1.4`.

1. **Word edges near silence.** Kokoro's timings tile the phrase, so pauses and the lead-in landed inside the
   neighbouring words (20–100 ms).
   - Fix: `synth._snap_words` moves edges that border a pause onto the audible edges (5 ms frames, −40 dB,
     ±100 ms). That covers the first word, and boundaries at a punctuation token or a word ending in one.
   - Other boundaries are left alone: snapping there would catch stop closures inside words such as "ex_pect".
   - The last word still keeps the chunk's release.
   - Result: first words sit 0–2.5 ms from the onset (were +20 to +40 ms). At "…FORGIVE. WE…", bm_george's edges
     moved from 95 and 67 ms off to 21 and 3 ms.
   - A new test fails on the old code.
2. **Ingest trim and rumble.** A −30 dBFS 35 Hz rumble made trim keep everything.
   - Fix: the high-pass is now 4th order (35 Hz −48 dB; an 85 Hz fundamental −1.7 dB, where 2nd order lost
     3.3 dB). Trim and split now listen to a 150 Hz–5 kHz copy, with a threshold that stays 6 dB above the noise
     floor (capped 10 dB under the peak).
   - Result: 2.62 s trimmed with rumble at −30 or −45 dBFS or none; the 35 Hz band sits −56 dB down.
3. **Mic-bump click before the speech.** A burst shorter than 50 ms that sits more than 150 ms from the rest is
   now dropped at either edge. The click take now matches the clean take.
4. **Word text** no longer carries edge punctuation ("One." becomes "One").

## Final checklist (coordinator, wrap-up)
- **Branch:** `main` (b2f860f) is merged.
- **Full engine suite:** 370 passed, 2 skipped, 1 failed. The failure is S3's
  `test_jobs_models_personas`; S3 fixed it on `session/s3-engine` (aeb7d62), and main doesn't have the fix yet.
- **S3's bundle test** `test_tts_espeak_fallback_from_a_deep_install_path` (`FVWKS_TEST_BUNDLE=1`, a relocated
  engine under a deep `.app` path, TTS with an out-of-lexicon word) **XPASSes** with the espeak fix.
- **Concurrency:** S3 now gates Kokoro and Qwen3 separately, so they can run at once. A stress test (a Qwen3 clone
  loop in one thread, Kokoro in another, 2 runs of 42–46 Kokoro lines) showed no crashes or bad audio, and Kokoro
  durations matched single-threaded runs.
- **"Bucket or pad token lengths":** not done, on purpose.
  - Padding the phonemes changes the speech, and the decoder's frame count varies with the audio length anyway.
  - Profiling showed the multi-second first calls were mostly GPU contention: the same shapes were as slow on
    repeat while another job held the GPU at 40–100%.
  - The genuine first-call cost (per size class) is paid at startup by the spread warm-up.
- **"Median of 3":** the test uses the best of 3 fresh 10-word lines instead.
  - A real regression slows all 3 runs, so best-of-3 still catches it.
  - Contention on 2 of the 3 runs, as seen with load average about 8.7, doesn't make it flake.
  - The failure message reports GPU load.
- **kokoro-onnx against Kokoro-MLX:** Kokoro-MLX stays the default.
  - The v0.1 contract now needs word timings (P1). Kokoro-MLX gets them from the duration predictor;
    kokoro-onnx's `create()` returns audio only.
  - Its G2P is espeak-only, where misaki uses a lexicon plus spaCy.
- **Qwen3 variant: bf16,** as the user chose when asked (standard size and best quality, over quantized or
  smallest). Switching to 8-bit means changing the repo and revision constants in `models.py`
  (Base-8bit is 3.10 GB against 4.54 GB). The per-line speed gain is not measured yet.
- **Team phase:** the VOICES UI package waits for S4's split. Next I'm cross-reviewing S2's use of segments, words
  and flags.

## Done since the last update
- **Priority espeak fix (coordinator open issue).** espeak-ng keeps its data path in a fixed-size buffer (about
  160 bytes). A longer path, such as a packaged `.app` or a deep worktree, makes it `exit(1)` with
  `…/runner/work/espeakng-loader/…/phontab: No such file`, which Python can't catch.
  - `espeak_path.py` gives phonemizer a copy of `espeak-ng-data` at a short path: an APFS clone (`cp -c`), so it
    takes no extra disk space. Candidates are `~/Library/Caches/fvwks-espeak/<hash>/`, then
    `/tmp/fvwks-espeak-<uid>/<hash>/`, and each install gets its own hash folder, so parallel venvs never
    replace each other's copy.
  - A symlink would not work, because phonemizer calls `.resolve()` on the path.
  - It runs in `configure()`, in `warm_up()` and before any Kokoro pipeline exists.
  - `test_voice_espeak_path.py` reproduces the crash at a 265-character `.app`-like path without the fix, and
    shows that the fix phonemizes "XYLOQUENDRAX" through espeak.
- **v0.1 contracts.**
  - `Segment.words`: `Word{text as spoken, start_s, end_s, throw}` in source time, from Kokoro's duration
    predictor. `throw` is per word: in `EXPECT *US*`, only "us" throws.
  - `SourceInfo.bpm` is the bpm actually used (the request's, or 120).
  - `SourceInfo.warnings` carries parser warnings for TTS and clipping warnings for ingest.
  - `preview_script(script, lexicon=None, bpm=None) -> ScriptPreview`.
  - The acronyms now come from `DEFAULT_LEXICON`, and the hidden list is gone. A supplied lexicon is the complete
    user list.
- **VoiceHooks, with the names and signatures S3 uses:**
  - `ENGINE_NAME = "kokoro-mlx"` and `ENGINE_VERSION = "s1.3+mlx-audio-0.5.6+kokoro-a71e4d38"`. `_BUILD` is
    bumped whenever the output changes; it was bumped for v0.1, whose Sources now carry words.
  - `warm_up()`, `configure(data_dir)`, `list_models()`, `install_model(id, progress)`,
    `design_persona(req)`, `save_persona(name, candidate)`.
- **Persona designer (Qwen3-TTS, approved by the user).**
  - **Models.** `qwen3-tts-voicedesign` installs two pinned repos as one model: `mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16` and
    `…-1.7B-Base-bf16`, 9.06 GB together, Apache-2.0. It is one entry because the app's VOICES screen gates the
    designer on the first `engine == "qwen3"` model. Both repos are **installed on this Mac**.
  - **Voices.** Personas are listed as `persona:<id>` voices (engine `persona`) and stored under
    `<voice data dir>/personas/<id>/`: `ref.wav` at 24 kHz plus `persona.json`.
  - **Rendering.** Personas are cloned with Base per chunk. The seed is fixed per (persona, line), so the same
    line renders the same take. Speed is applied with a pitch-preserving time stretch (Rubber Band via
    pedalboard), because Qwen3 has no speed control.
  - **No word timings.** Qwen3 doesn't give any, so persona Sources have `words == []`.
- **Installer.** It downloads in a child process: cancelling really stops the transfer, and partial files resume
  on the next install. Progress comes from the bytes on disk. A disk check keeps 5 GB free, and failures map to
  `disk_full` (507), `install_failed` (502), or `OSError(ENOSPC)`.
- **Latency (S3's report).**
  - Fresh lines looked 2–5 s slow. It was mostly **GPU contention**: a background Blender render kept the GPU at
    40–100% busy, and the same shapes were as slow on repeat.
  - There is also a small real per-size-class first-call cost, now paid at startup: warm-up runs short, medium and
    long lines on both accents (1.9 s).
  - The < 1 s test is now best-of-3 fresh 10-word lines and reports GPU load on failure.

## Measurements (M3 Pro)
| What | Result |
|---|---|
| **Warm 10-word line, full `synthesize()`** | **258–284 ms** (3 fresh lines, GPU at 97–100% busy with another job; target < 1 s) |
| Kokoro load / warm-up (spread) | 3.1 s / 1.9 s |
| Persona: design 2 candidates, including model load | 8.4 s (VoiceDesign load 4.6 s; about 2.8 s per 3.5 s candidate after the first) |
| Persona: 3-chunk script (first call includes Base load) / repeat | 6.4 s / 0.08 s (cache) |
| Qwen3 clone speed | about real-time (a 3 s line in 2.7–4.3 s) |
| Qwen3 memory | VoiceDesign 4.6 GB (released after designing); Base about 4.5 GB (kept once used); peak 8.2 GB |
| Designed "deep gravelly menacing" voice | median F0 86–100 Hz. Clones keep it (92–108 Hz against the reference's 93). |

Earlier measurements still hold:
- The venv is torch-free, 538 MB for the whole workspace (about 320 MB of it the voice stack). kokoro-onnx was
  evaluated and rejected: it needs a second copy of the weights, uses espeak-only G2P, and gives no durations.
  PyTorch is now allowed, but nothing needs it.
- Voice tags come from measured F0 and brightness; see `voices.py`.

**Disk.** Free space swings with other jobs. It went from about 20 GB to 12 GiB after the 9 GB persona download
and other sessions' writes, then back to 73 GiB when those jobs freed space. The installer re-checks free space before any
download and keeps 5 GB free.

**HTTP check against main's real server and rack** (`voice_engine: kokoro-mlx`, `fx_engine: fvwks-rack`):
- models list, `POST /api/script/preview` (2 ms) and TTS with words (288 ms) all work;
- a persona design job finished in about 15 s with 2 candidates;
- saving the persona worked, and a persona TTS took 7.2 s, including the Base model load.

## Blocked
Nothing.

## Notes for other sessions
**S3 ENGINE**
- **Stale test.** `server/tests/test_api.py::test_jobs_models_personas` assumes the voice package can't install
  models and can't design personas. With S1's real hooks, and the Qwen3 model installed on this Mac:
  - `POST /api/models/qwen3-tts-voicedesign/install` finishes `done` ("already installed");
  - `/api/personas/design` runs for real, taking about 8 s.

  Please make the test engine-agnostic, e.g. monkeypatch `voice.install_model` and `voice.design_persona` as your
  `FakeVoiceModels` does, or branch on `installed` from `GET /api/models`.
- **Model ids.** They match your fallbacks: `kokoro-82m` and `qwen3-tts-voicedesign`. The latter's size is now the
  real 9,064,407,731 bytes, not 3.4 GB.
- **Candidates.** Each candidate's `info.name` is the design description, which your `PersonaCandidate` shows, and
  `info.script` is the transcript `save_persona` needs.
- **The espeak fix is in `configure()`**, which you call first, so your deep-path bundle test should now pass.
- **Persona timing.** A persona line takes seconds, not milliseconds; keep persona STACK voices in background jobs.

**S2 SOUND**
- **Words.** Kokoro Sources carry `Segment.words` with per-word `throw`.
- **Personas.** Persona Sources have `words == []`, so throw the whole segment, as per the contract.
- **Level.** Persona audio uses the same speech-level normalization (−20 dBFS active RMS, ≤ −1 dBFS peak).

**S4 APP**
- **Persona designer model.** It's one 9.06 GB model entry. Design takes about 8 s for 2–3 candidates.
- **Persona voices.** They appear in `GET /api/voices` with `engine: "persona"`, `language: "en"`, and gender
  guessed from the description (`male`, `female` or `neutral`). They have no word ticks.
