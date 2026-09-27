# S2 SOUND: status

Branch `session/s2-sound` (up to date with `main` and `v0.1.2-contracts`). Owns `engine/fx/`. **State: B1–B9 done,
including v0.1 word throws; ready for the final merge. The full engine suite passes apart from two S1 voice tests (see
the bottom). The audition pack is ready in `out/audition/`.**

## How to use
- Tests: `scripts/check.sh fx` runs the fx suite, including perf, which are skippable with `FVWKS_SKIP_PERF=1`. The contract
  tests also pass against the real engine.
- CLI, from `engine/`:
  - `uv run fvwks render <voice.wav | fixtures/sources/x.source.json> -p pact --bpm 140 --bars 4 --key Am -o out.wav --dry dry.wav`
  - `uv run fvwks presets`, `uv run fvwks rack`.
- Audition pack: `uv run fvwks audition` writes `<repo>/out/audition/` (needs the `dev` extra for matplotlib).
  See its README.

## What's built
- **Seam** (`fvwks_fx.api`), `ENGINE_NAME = "fvwks-rack"`:
  - `rack_schema`, `list_presets`, `get_preset`, `resolve`, `analyze`, `render`.
  - Helper `apply_hints(req, preset)`.
  - `resolve` interpolates each macro target between min (0) and max (1) with lin/exp/log curves. It clamps to the
    rack ranges and lists every module in rack order with its effective params.
- **Pipeline order:** PREP → MASK → LAYERS → MACHINE → PLACE → DRIVE → CRUSH → TONE → MOTION → DYNAMICS → SPACE →
  STEREO → FINISH → MASTER.
  - Stage-memoized on a hash of everything upstream: a SPACE tweak reuses MASK..DYNAMICS.
  - The dry A/B master is cached across FX tweaks.
  - PLACE (ARRANGE placement) sits before the time-based FX, so delays, throws, reverb tails and the swell live on
    the grid.
- **Quality:** finals run at 48 kHz, previews at 24 kHz (WORLD synthesizes at 24 kHz from the 48 kHz analysis).
  Output is at `Master.sample_rate` for both.
- **MASK (WORLD):**
  - Analysis:
    - Harvest for the main voice (DIO missed 2–9% of voiced frames), cached per source by `analyze()`.
    - DIO for STACK voices, and for previews until Harvest is ready.
    - D4C runs at 24 kHz.
    - PREP (HPF, gate, de-ess) is applied to the WORLD envelope, so one analysis serves any PREP setting.
  - Pitch, monotone, scale-lock:
    - `pitch_mode` picks what FLAT (`monotone`) pulls toward: own median, key root, or scale-snapped then root.
  - Formant warp.
  - **McAdams**, re-implemented from arXiv 2011.01130:
    - LPC order 20 at the paper's 16 kHz reference.
    - Complex pole angles φ → φ^α; the new/old all-pole ratio is applied to the WORLD envelope.
    - Tested against the paper's formula (a 1 kHz pole at α 0.8 lands at 1206 Hz).
  - Breath: aperiodicity; a full whisper uses a fast STFT noise synthesizer.
  - Growl: period-doubling AM locked to WORLD's pulse times, plus jitter.
  - Silent runs are skipped in synthesis.
- **LAYERS:**
  - Sub is synthesized at 12 kHz.
  - Ghost is a pitched whisper double.
  - **STACK** is time-mapped per segment on WORLD frames, then pitch, formant and FLAT. Voices synthesize at half rate.
  - Pseudo-stack is used when `stack[i]` is None.
  - Rubber Band fallback when there's no analysis.
- **MACHINE:**
  - STFT channel vocoder: 16–40 log bands, whitened saw/square/noise carrier on the key root or chord.
  - Ring mod.
  - Hilbert frequency shifter.
- **DRIVE / CRUSH / TONE / MOTION / DYNAMICS / SPACE / STEREO / EDIT:** as in the plan. SPACE convolves generated dark
  IRs by FFT (identical to pedalboard's Convolution, 2–3× faster). STEREO keeps < 150 Hz mono with an exact FFT-domain
  side high-pass, re-applied after the master. Inserts before SPACE process only the active span.
- **MACHINE talkbox** (rack 1.1.0): `vocoder_mode: talkbox` plays the voice's vocal tract (LPC, order ~sr/1500 on
  20 ms frames, batched Levinson-Durbin) with the in-key carrier chord; unvoiced frames switch to noise. UNIT uses it.
- **Airwindows** (rack 1.2.0; MIT sources vendored in `engine/fx/native/airwin`, compiled by setup.py + pybind11):
  DRIVE `color` tape (ToTape9) / tube (Tube2) + `color_drive`; CRUSH `derez` (DeRez4); SPACE `reverb_type: galactic`
  (Galactic3, decay-calibrated, level and width matched to the hall). All rate-compensated so previews match finals.
  PACT (tape), ABYSS (tube), SIGNAL (DeRez at 8 kHz) and GHOST (Galactic tail) use them.
- **v0.4 never cut speech:** fixed bars are a minimum. When the phrase plus its tail can't fit, the render grows to
  the next count (`extended`). `auto_tail` (default on) keeps `reserved_tail_s` after the last word: its release
  plus the chain's reverb / delay / thrown-word echoes down to -30 dB (0 with a tape-stop ending). AUTO and FREE
  count it too.
- **v0.4.1 snap_end** (default "beat"): R3-warps the phrase within max_stretch so the last word (VOICE OUT) ends
  exactly on the nearest reachable beat ("bar": bar line, else the nearest beat), then the tail rings. When the
  tail would need more bars just to land on the grid, it may shrink to 80 %. With Beat-Lock the last chunk's start
  is fixed, so a closest approach within 25 ms counts. Otherwise the natural timing stays and the fit message says so.
- **v0.5 motion:** `RenderOutput.motion` (events, returns, f0) on every render.
- **ARRANGE:**
  - Exact N bars; the first word lands on `first_word_beat`.
  - Fit modes: `auto` (pad, or R3 stretch ≤ 8%, else overflow + `suggested_bars`), `pad`, `stretch`.
  - Beat-Lock and `[Nb]` pauses at the render tempo; FREE = whole beats. Every chunk starts at its onset, so a
    locked chunk's first sound lands on its beat (within 0.3 ms, from 22–68 ms late on S1 sources; S1 review).
  - Stutter and tape-stop.
- **MASTER:**
  - CLUB targets the short-term max over 3 s windows (the whole file if under 3 s) with pyloudnorm K-weighting.
  - The secant loudness search runs a 2×-oversampled soft clip + BrickwallLimiter chain with a measured BS.1770
    true-peak trim inside every pass, so the true peak is guaranteed. The search warm-starts from the previous render.
  - BAKE: sample peak −6 dBFS, no limiting.
  - CUSTOM: gated integrated target (vectorized; matches pyloudnorm to 0.001).
  - 48 k → 44.1 k with `resample_poly(147, 160)`; exact length.
  - `tpdf_dither()` is available for S3.
- **Mask strength:**
  - SYNTHETIC for TTS, with a "would score" hint.
  - Recordings: pitch-only = WEAK, RAW = MEDIUM (4), PACT = STRONG (6+), each with reasons.
- **Presets:** 7 factory presets. Macros at 0.5 reproduce the plan's starting values, and every macro targets an
  enabled module.

## Measured
- **Every preset, final** (`we_are` fixture, 4 bars @ 140):
  - Exactly 302,400 samples @ 44.1 kHz.
  - Short-term max −7.0 ±0.3 LUFS; true peak ≤ −1.02 dBTP.
  - Side energy below 110 Hz under −60 dB; no NaNs.
- **Pitch:** measured F0 is within ±0.5 st of the target from −12 to +4 st, with and without formant shift and
  McAdams (Harvest, frame-wise).
- **Speed** (10.9 s line, 8 bars, PACT + 2 stack voices, analysis cached, other sessions running). Independent
  work runs concurrently: pyworld, pedalboard and scipy release the GIL.

  | Render | Time |
  |---|---|
  | Final | 0.8–1.6 s (target < 3 s ✅) |
  | Preview, SPACE tweak | 0.23–0.30 s (< 400 ms ✅) |
  | Preview, DEPTH tweak | 0.36–0.58 s |
  | Preview, cold | 0.48–0.88 s |

  The coordinator accepted targets of < 800 ms (DEPTH/MACHINE tweak) and < 1.2 s (cold). `test_perf.py` enforces
  both.
- **Real-engine HTTP numbers**, measured by S3 on integration/i1 (7 presets × 4/8 bars):

  | Request | p50 | p95 |
  |---|---|---|
  | Warm preview | 254 ms | 381 ms |
  | First preview per preset | 491 ms | 811 ms |
  | Final + export | 1037 ms | 1448 ms |

  Every final lands at −7.0 ±0.05 LUFS with true peak ≤ −1.02 dBTP and exact length.
- **Audition pack:** about 0.55 GB (the coordinator raised the budget to about 1 GB). Contents:
  - 6 inputs × 7 presets in CLUB mode, plus the same renders in BAKE-IN mode (no limiter; best for judging the
    voice design).
  - 28 macro sweep strips (every macro on every preset).
  - Dry references.
  - A spectrogram per file, `measurements.json` and a README.

## v0.1 (merged)
- Throws feed exactly the `throw` words; with no `words`, the whole flagged segment.
- Output segments carry their words mapped onto the output timeline.
- `tail_s` follows the integration-i1 ruling: the end of the last word on the output timeline (memory cue
  "VOICE OUT"); None only without speech.

## Dependencies
The coordinator allowed more dependencies. None are added for now:
- The remaining cost is WORLD synthesis and the true-peak limiter search, both already in C/C++ and now parallel,
  so numba has nothing to speed up.
- Engine swaps such as a Faust filterbank vocoder via DawDreamer should follow the user's ear feedback from the
  audition pack.

## Notes for other sessions (details in `contracts/proposals/S2.md`)
- **S3:**
  - Preset hints, STACK analysis and the tail-cue rule are all handled server-side (thanks).
  - **Concurrency confirmed:** renders may overlap. The shared state is:
    - the two thread pools, which are thread-safe;
    - the locked `StageCache`, `ANALYSIS_CACHE` and master warm-start hints;
    - `lru_cache`s.
    `test_concurrency.py` checks that concurrent renders match serial ones. I'll tell you before adding any shared
    mutable state.
  - New shared state (rack 1.1.0): MACHINE's carrier cache (6 entries, locked, arrays read-only).
  - **Build change (rack 1.2.0):** fvwks-fx now compiles a small C++ module (setuptools + pybind11), so `uv sync`
    and `bundle_engine.sh` (`uv pip install ./fx`) need the Xcode command-line tools. Without the module the
    Airwindows stages are skipped with a render warning. New cached state: Galactic rate/level calibrations (lru).
  - Your two stub-assuming tests were fixed on main (d1f0b8e, 2db85a7).
- **S4:**
  - Rack descriptor changes: EDIT is available; new params `space.reverb_type` and `tone.resonance`; new options
    `drive.mode: tube>hard`, `vocoder_chord: key`, `stutter_div: 1/8`.
  - Rack 1.2.0: new `machine.vocoder_mode` (segmented: channel, talkbox), `drive.color` (segmented: off, tape, tube),
    `drive.color_drive`, `crush.derez`; new options `vocoder_carrier: supersaw`, `reverb_type: galactic`.
    `contracts/rack.v0.json` (your mock) predates them.
  - `RenderInfo.segments[].words` are on the output timeline.
- **Coordinator:**
  - `main` has S2 up to a8642bb. The commits after it are ready for the next integration: tests, CLI, audition,
    v0.1 words and throws, concurrency, and `tail_s` per the ruling.
  - Tune presets by ear from the audition pack.

## Final merge check
- `main` merged at 9036ee9 (v0.3 contracts, S1/S3 v0.3, S4 Phase 2). `uv run --all-packages pytest`: 480 passed,
  2 skipped (perf run separately: green).
- Sound upgrades (coordinator, user-approved): talkbox e50a505, Airwindows bcd47c2, presets retuned, goldens
  regenerated. A/B delta for the user: `out/audition/delta/` (39 MB, README inside).
- AUTO bars (v0.2): the coordinator's api stopgap is now resolved in `plan_placement` (5c4155a).
- `engine/uv.lock` not committed; fvwks-fx adds no runtime dependencies (setuptools / pybind11 are build-time only).

## Cross-reviews
- **S1 → S2** (Beat-Lock, words, throws):
  - Fixed: Beat-Locked and `[Nb]` chunks landed their first sound 22–68 ms after the grid point (only chunk 0 was
    onset-corrected). Every chunk now starts 1 ms before its onset, with a 1 ms fade-in.
  - Changed: a flagged segment whose words carry no `throw` flag throws whole instead of not at all.
  - Improved: STACK voices align word by word (piecewise-linear through the middle of each gap between words)
    when both segments carry the same words; otherwise, or when a piece would warp more than 3x, segment-linear
    as before. On Kokoro renders (am_fenrir + am_michael/bm_george) the main/stack envelope lag drops from a
    median 55 ms to 15 ms and zero-lag envelope correlation rises from 0.40 to 0.65.
- **S2 → S1** (voice): findings sent to S1; S2 follow-up `83149d8` (throws open 30 ms early) is on `main`.
- **S2 → S4** (rack UI): engine-checked macro table for `lib/macros.ts` (Python half-even rounding ported).
- **S1 → S2 follow-ups:** STACK voices align word by word (07cf8d8).
