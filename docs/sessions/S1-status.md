# S1 VOICE: status

Updated 2026-09-27. Branch `session/s1-voice`, on main (contracts v0.6). Owner of `engine/voice/`.

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
