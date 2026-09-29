# S2 SOUND: status

Branch `session/s2-sound`, which owns `engine/fx/`. **State: wrapped up (2026-09-27).** Everything is merged into
`main`: the rack, the 7 factory presets, v0.4/v0.5 arrange and motion, v1.0 QA fixes, v0.7 songs (analyze_song /
mix_song) and the low-confidence key → None rule. Local audition packs in `out/` are git-ignored and stay local.

## REMIX 1.5.1 harmony + the set3 / set4 verdicts: PARKED (2026-09-29, the user: "pause dev on it for now")

Branch `help/s2-151-wip` (worktree `.claude/worktrees/confident-saha-1e7c0f`), everything committed; S3's QA and M2.5
merged in. Renders stay local in `out/` (remix-harmony-set, -set2, -set3, remix-verdict-set4; ~1.9 GB each, only set4
still needed).

Verdicts so far (via the PM):
- Set 1.5.1: "They're all bad you need to study chord progressions etc".
- Set3: "the only good one is #1" (song-1 VIP hybrid tearout: a C#m7 pedal, its own held 808, designed growls, no
  melody); the melodies were "cartoony", "the songs arent properly mixed", and "It should be able to move around
  vocals too".
- Set4: "its meh. will work on it later"; chops beat hook_move; the mix and the drop arrangement still off.

In (on the branch): the harmonic plan per drop (BASS DNA half-bar roots, bent notes and pickups don't vote; trap /
halftime play the source as is; tearout's VI-VII fallback), grid.json harmonic QA inputs, every drop on the -7 club
target (`_contrast`), the source's own pre-drop gap kept on VIPs, cartoon hooks at weight 0, growls pedal on the tonic
(turnarounds only) with `drop.tension` off, `vocals.arrangement` (keep | chops | hook_move) with phrase clips, the
snare gate on recurring snares only, clean source-kit shots.

Next, when it's picked up again:
1. The staccato kept 808 (ncs-01): drop its sub band and let the engine's held root_line sub play under it. It drives
   ncs-01's held_bars, sub_mid_db, sub_corr, beat_pauses and sub_root. The measured drop coverage (share of the time
   BASS DNA notes sound) is song-1 bar 25 0.86 and bar 61 0.63; ncs-01 bar 9 0.53, bar 25 0.68 and bar 73 0.24. A
   threshold near 0.6 keeps song-1's held 808 as it is.
2. build_vs_drop on ncs-01 (2.0-2.5 LU); the chops take vocal energy out of the drop.
3. The PM's REMIX_SOUND_OSS §3.3 / §3.4 (docs/REMIX_SOUND_OSS.md on main): the Airwindows Console9 mix bus
   (+ ButterComp2 / ClipOnly2 on the bass-mid, Acceleration2 on top / vocal), remix/match.py tonal_match (Matchering's
   method re-implemented, synth and kit lanes only), vocal-aware EQ, and the chop engine (a VocalChopSrc proposal first
   if it needs a contract). The user preferred chops to hook_move.
4. S3's help/s3-surge (the cartoon trims as synth axes, then the Surge recipes) merges when S3 sends the sha.

## 1.5 SMART VISUALS handoff (S2 AUDIO), in progress on help/s2-smart

Worktree `.claude/worktrees/confident-saha-1e7c0f`, branch `help/s2-smart` (main + v0.10 /
v0.10.1 contracts + S4 68c951c merged). Tests: `cd app && npx vitest run`; `cd engine && uv run --package fvwks-fx
pytest fx/tests`. Electron smoke harnesses live in the session scratchpad and run with S4's Electron binary
(`.claude/worktrees/nostalgic-neumann-536f47/app/node_modules/electron`).

Done:
- 8da928a `fx/structure.py` song_structure → SongStructure (v0.10). Test song: intro 1, verse 9, build 17, drop 25,
  breakdown 41, build 53, drop 61, outro 77.
- ebb57f7 `visuals/live/director.ts` (AutoDirector / autoDirector, registered in families/index.ts, off until AUTO
  calls `autoDirector.setEnabled(on)`); `audio/live/structure.ts` (StructureTrack / StructureReader, TRACK);
  `audio/live/liveStructure.ts` (LIVE INPUT detector); `visuals/live/trackStructure.ts` (useTrackStructure,
  withTrackStructure); inputSource fills the live fields.
- 1a1eeac `fx/bassline.py` (BassFrames): StemFeatureData.bass + SongSection bass fields.
- 20e56e0 TRACK bass: `StemTrack.bassAt` / `StemTrackReader.read(pos, bpm, sections)` → AudioFrame.bass + feel;
  `trackSourceWithStems(source, reader, playhead, song.structure?.sections)` (S4 passes the 4th arg).
- 288067f LIVE bass: the fvwks-stems worklet posts sub / growl / 30-600 Hz / sub f0 (s[8..11]); `audio/live/liveBass.ts`
  LiveBass (notes = the < 150 Hz level on for 80 ms; slides; wobble by growl ACF; style); inputSource fills bass /
  feel. Real-music check: intro reads no bass, the drop's sub holds long notes, style → deep. fx: sub and growl now
  share one scale (the bass's peak).
- 30069a0 director: ScenePatch.saturation (build drains to mono, pre-drop 0, hit 1.3) and typed EffectLayer.locked
  (merged S4 ac88c93).

Next steps:
1. Check the bass analysis on the test song once S1 / S3 stems exist (local only).
2. Live half-time (needs the downbeat) if the user asks; TRACK has it.

Field names:
- AudioFrame (S4's registry.ts): section, buildProgress, preDrop, dropIn, dropHit, dropEnergy, dropIndex, drop,
  bass {on, noteOn, heldBeats, expectBeats, sub, growl, pitch, glide, wobble {div, phase}}, feel {halfTime, style}.
- Contracts: SongStructure (sections, drops_s, builds, phrase_bars, energy_fps 10, energy_b64, from_stems);
  StemFeatureData.bass = uint8 (frames, 4): flags (bit0 on, bit1 note start), sub, growl, pitch MIDI x 2;
  SongSection.bass_style / half_time / note_beats / wobble_div / wobble_anchor_s.

Pending with S4: wire `useTrackStructure` + `withTrackStructure`, the 4th `sections` arg of `trackSourceWithStems`, and
the AUTO toggle (`autoDirector.setEnabled`) in VisualsStage.

Standing rules: ponytail full (read ~/.claude/plugins/cache/ponytail/ponytail/4.10.0/skills/ponytail/SKILL.md);
downloads under 1 GB are fine, over 1 GB need the user's OK, and every new package or model is reported to the PM;
no new Python runtime deps; the test song (~/<test media>/song-1.*) is local only: never copy,
commit or name it ("the test song"); lean QA, but walk the headline click path end to end; reports: sha first, then
at most three lines. Peers: "FoxBox PM: coordination, contracts, releases", "S4 APP + RELEASE: UI, compositor,
updater, builds", "S1 VOICE + CAMERA: TTS, stems, face tracking, clips", "S3 ENGINE + FX: server, jobs, shaders,
Link".

## 1.6 REMIX spike "BASS DNA" (S2 AUDIO), on help/s2-bassdna

DSP only, no generative AI. `engine/fx/src/fvwks_fx/groove.py`:
- `extract_groove(bass_stem, sr, analysis) -> Groove`: reads the bass stem through `bassline.BassFrames` (the same
  frames as `StemFeatures.bass_b64`).
- `render_groove(groove, sr)`: the proof synth, a numpy saw + sub. The notes gate it, each note's bend sets its
  pitch, the level curve sets the volume, and the growl share opens a low-pass and drives it.
- Test: `fx/tests/test_groove.py`, on synthetic held subs, a 1/8 wobble and gliding 808s.

Groove extraction:
- **Notes.**
  - A note runs from each note start to the next start, or to where the bass goes off.
  - Pitch is the median of the voiced frames after the first 100 ms.
  - A slide keeps its pitch contour as `bend`.
  - A legato fragment under 60 ms at the same pitch merges into its neighbour. The volume curve keeps its dip.
- **Start times, refined to the millisecond.** The 60 fps frames see a note up to ~30 ms early. Within −60..+40 ms,
  the start moves to the steepest rise of a trailing 20 ms RMS when the level climbs 3 dB or more. A legato change
  with no rise gets a calibrated +25 ms instead (`FLUX_LAG_S`; the log-flux bias measured 19–31 ms).
- **Bars.** Per bar: the wobble (`BassFrames.wobble` over that bar and the next) and the drive (the growl share).
- **Env.** Two 60 fps curves: level (the bounce) and growl share.

bassline.py fixes found on the way:
- The per-frame `np.pad` (0e34515 on help/s2-smart: 13 s down to 0.8 s).
- Pitch voicing is now gated on the 28–150 Hz fundamental band, not < 60 Hz, so notes above ~60 Hz (D#2 and up) get a
  pitch. Unpitched notes on the test song: 31% → 12%.
- `BassFrames.level` and `BassFrames.wobble(a, b, beat)` are split out.

Accuracy on the test song (demucs stem; 2.4 min, 145 BPM; 185 notes, 88 bars; extraction 0.3 s):

| What | Result |
|---|---|
| Note starts: the re-play vs the original | recall 0.86, precision 0.96, median error 4 ms |
| Note starts on the synthetic test | median error 4 ms (worst 24 ms) |
| Bounce: level curve, re-play vs original | r 0.95, zero lag |
| Bounce: kick-locked level shape (107 kicks) | r 0.99 (0.97 per kick) |
| Bass start after the nearest kick | 37 ms (original), 42 ms (re-play re-read) |
| Pitched notes | 88% |
| Re-play pitch within 0.5 semitone | 94% of voiced frames, no octave errors (synthetic: within 0.1 semitone) |
| Slides | 16 in the song; all of the synthetic 808 slides (+3.7 semitones) |
| Wobble | none in the test song (as the section analysis says); synthetic 1/8 found on 6+ of 7 bars |

Listen, local only: in the S2 scratchpad, `bassdna_A_original.wav` is the drums + the original bass and
`bassdna_B_replayed.wav` is the drums + the re-play.

What fails, or is approximate:
- **Unpitched notes.** 12% of notes read no pitch (growl-only or noisy) and hold the previous pitch in the re-play.
- **Legato starts.** Legato changes rely on the +25 ms calibration; expect about ±10 ms error.
- **The proof synth.** It's naive: a filter switched per 64-sample block, and 8 s to render 2.4 min. Surge XT replaces
  it.
- **The grid.** The analysis downbeat sits ~17 ms before the kicks, so `offset_ms` includes that. Swing is relative to
  the song grid.
- **The key.** The bass line's pitch centre is C# (55% of pitched time), then D (24%) and D# (11%). That agrees with
  S3's corrected chroma (C#m) rather than the DJ's D#m. The user should confirm.

**Moved (a182cf4):** now `fvwks_fx/remix/groove.py`, shaped like the draft `Groove` in docs/REMIX_BACKEND.md.
It's in beats from the groove's first bar, so rendering at another bpm re-times it. Re-scored on the test song:
- note starts: recall 0.81, precision 0.93, 3 ms median error;
- pitch: 95% of matched notes within half a semitone;
- bounce: level curve r 0.98, kick-locked shape r 0.99;
- extraction takes 0.4 s.

What doesn't fit the draft `Groove` (all added):
- **`level_b64` is missing from the draft.** The level curve (the bounce: sidechain pumps and stabs) is what keeps the
  re-play locked to the drums (kick-locked r 0.99). Without it the notes alone lose the pump. It maps to CC11.
- **Curves are per beat, not per second.** `level_b64` and `growl_b64` are uint8 at `per_beat` = 24 samples a beat,
  so a re-timed groove keeps its curves.
- **`glide_to` alone loses the slide.** An 808 slide has a start time and a shape inside the note. Added
  `bend: [[beats into the note, midi], ...]`; `glide_to` = its last pitch.
- **`wobble[].phase` is missing.** Added: 0–1 at the bar line, 0 = the LFO's peak. Without it a synced LFO lands off
  the original's peaks.
- **`wobble[].shape` isn't detected.** It's always "sine"; `depth` is (p95 − p5) / p95 of the growl in that bar.
- **`midi` is a float.** It carries the track's tuning. An unpitched note (12%) holds the pitch before it.
- **`start_bar` is 1-based,** like `SongSection.start_bar`.

## 1.6 REMIX: state (help/s2-bassdna), updated as work lands
All in `engine/fx/src/fvwks_fx/remix/`; tests are `fx/tests/test_remix_*.py` (11 pass).

| Module | What | sha |
|---|---|---|
| `groove.py` | BASS DNA → the v0.11.1 `BassGroove`; `fvwks_fx.api.bass_groove` = FxAPI.bass_groove (the server sets `half_time` from the section) | 04d48a9 |
| `flip.py` | `drum_hits`, `split_drums`, `FLIP_STYLES`, `reprogram` | 0cbdebf, 7b7e4fb |
| `arrange.py` | `build(remix, songs, match=, vip_drop=)` for the three recipes | dbd772a |
| `prepare.py` | `prepare_clip(clip, remix, sources, sr, synth=, kit=)` | cb71025, 8bae9ce |
| `mixdown.py` | `mixdown(remix, audio, sr, Master)` | 8bae9ce |

- **flip:**
  - `drum_hits` finds each voice in its own band (kick 30–120 Hz, snare 1–5 kHz and it must ring on, hats > 6 kHz).
  - `reprogram(hits, style, start_bar, bars, swing)`: silent bars stay silent, fills stay as played.
  - `split_drums` is ~28 s per song (a ponytail note: cache it).
- **arrange:**
  - vip: the drop bass becomes its groove; optional VIP drop.
  - mashup: B's matched part, A's vocals over it, one bass at a time, 0.25-beat fades.
  - flip: the style tempo, kit + groove.
- **prepare:**
  - stems: one Rubber Band R3 pass (stretch + shift).
  - grooves: extracted from their bars ± 1, re-played at the remix tempo, LUFS-matched to the bass they replace; the
    `synth=` hook is for S1's Surge.
  - kit: the style pattern; the `kit=` hook is for S1's sampler, and a FoxBox kit is the fallback.
- **mixdown:** lane gain / mute / solo; B sections matched to A's of the same kind (±6 dB); `master()` to target, mono
  below 120 Hz; exact length.
- **Golden BUILD on the test song (local):**
  - VIP: 103 bars, exact length, sections on 4-bar lines, no NaN, −7.0 LUFS short-term max, true peak −1.02 dB;
    prepare 0.56 s per 8 bars.
  - Flip (dubstep140): 87 bars, same checks pass; prepare ~1 s per 8 bars per lane (Rubber Band and the groove).
  - Mixdown 8–15 s.
  - Listen: `golden_vip.wav` and `golden_flip.wav` in the S2 scratchpad.
- **v0.11.2 (ef4ff6a):**
  - Flip kit clips carry the song's re-programmed hits inline: `build(..., drum_hits=flip.drum_hits(A's drums))`, and
    the server caches those hits per song. Without them, `pattern_id` = the style's straight loop.
  - Groove clips default to the FoxBox patch for the section's bass style (deep → reese, trap → 808, dubstep → wobble,
    other → growl).
- **S1 adapter:** `prepare` calls `fvwks_synth` directly. `_synth_groove` puts the groove's level curve on S1's render,
  because S1's synths ignore level/growl/bend/phase. `_synth_hits` maps hats → hat and vel 0–1 → 0–127. Both fall back
  to the FoxBox sounds when the import fails, or on an unknown patch/kit or Surge not built.
  - Checked against help/s1-synth ab87b53 via PYTHONPATH, not merged: S1 sends its final sha.
- **Mashup golden** (the test song against a 6% faster, +1 st copy made in memory; B's first drop under A's): 87 bars,
  exact length, no NaN, −7.0 LUFS, true peak −1.02 dB. B's drop is back at C#1 (34.63 Hz), B's kicks sit 3.9 ms from
  A's 16th grid, and only B's bass plays there. Listen: `golden_mashup.wav` in the S2 scratchpad.
- **Key fix for 1.5.1:** b3b4c9b + facbf77 on help/s2-keyfix, approved. Give S4 the sha when S4 opens 1.5.1.
- **Pipeline (b34a771):** `fvwks_fx.remix.run(remix, {slot: SongInput(song, stems, sr)}, stage=, audio=, match=,
  vip_drop=, master=, sr=, progress=)` → `RunResult(remix, audio, mix, report)`.
  - build runs on stage "build" or an empty remix; a flip's drum hits are cached per song.
  - prepare renders only clips with no audio_id that aren't passed in.
  - `clip_key` is a content hash for S3's cache (it ignores at_beat and id).
  - S3 has the call.
- **S1 adapter (b6ce016):** S1's final API from 6162908: `render_groove(g, patch_id, start_bar, bars, bpm, shift_st, sr)`
  (the bounce is applied inside it) and `render_kit(kit_id, KitHits, bpm, beats, sr)`. Checked via PYTHONPATH, not merged.
- **MASH RADAR (06763bf, 0d495f0, bd19252):** `remix/mash.py`, taken over from S3.
  - Scan: 0.25 s for 200 songs × 10 parts on a drop query (target < 3 s); rankings identical to S3's code.
  - The 13 key shifts are scored at once from one 12×12 matrix.
  - The request's filters (tempo window, Camelot-compatible keys unshifted, bass styles) drop songs before pairing.
  - Returns the contract `MashMatch`, built for the top N only.
  - `MashSong` = the seam's `MashFeatures`; `fvwks_fx.api` exposes `mash_features` and `mash_scan`.
  - Features: 0.65 s per song from the mix, 1.5 s with vocals, ~30 KB. The server computes them in the analysis /
    stems job, never in the scan.
- **BASS DNA fixes:**
  - Legato starts with a pitch change are timed at the pitch track's halfway crossing (0e37efb): median 3.9 ms, was
    8.3 ms with the +25 ms constant, which now covers only same-pitch re-articulations.
  - Wobble shape is now square / saw / sine (8171109); triangle still reads as sine.
  - Unpitched notes: left as they are. On the test song the 14% unpitched notes are ~44 ms, quiet (vel 0.34),
    sub-heavy blips, likely kick bleed or pump tails. Holding the previous pitch is right for them. A wide-band
    (< 600 Hz) pitch fallback gained 0–1%, so it was reverted.
- **LOCK (1.5 bug, help/s2-lock 54db9ee, merged by S4 in c242773):** the director's look (hue, saturation, punch zoom
  + brightness) is now drawn into the base and each unlocked generator layer, not onto the finished picture.
  - A locked layer gets no patch, runs at its own dt, and is drawn plain.
  - Filter layers aren't re-coloured (their input already carries the look).
  - The punch flash is brightness on unlocked content instead of a white wash.
  - Test: `lockShield.test.ts`; it fails without the fix.
- **Progressive prepare (d95d0e4):** `run(stage="prepare", on_clip=, play_from_bar=)` prepares the playhead's 16 bars
  first, then the first drop, then the rest, on up to 4 threads (output bit-identical to serial). It calls
  `on_clip(clip_id, audio, PrepareProgress(done, total, playable, drop_ready))`.
  - Test song, engine compute from BUILD: first playable at 0.02 s (VIP) and 2.4 s (flip); all clips at 1.5 s and
    8.2 s (were 4.3 and 31.4).
  - This excludes the server's stem load and store and the app's fetch.
  - S3 has the progress shape.
- **Engine branch for S4:** 94774f5 merges a8dce76; with fvwks_synth installed the engine suite passes, and the kit
  test holds for any kit.
- **v0.11.4 (fb8c13b, bc7c6cb):**
  - A mashup plays `remix.mash` (LINE IT UP's pick), arranged by the matched part's kind: B's drop replaces A's next
    drop, B's vocals go over A's drop, B's build replaces the section before A's drop.
  - Without a pick, `run()` takes the best-scoring A–B match either way round and records it in `remix.mash`.
  - The mash scan filters by `borrow`.
- **Audition pack (for the user, via the PM):** `out/remix-audition/` (git-ignored).
  - 16-bar clips (4 bars of build into 12 of the drop): original-drop, vip-reese / wobble / 808, flip-riddim /
    halftime / dubstep140 on TR-808 kits, and a mashup against the +1 st, 6% faster copy.
  - MP3 320, true peak ≤ −1 dBTP; ID3 is only title = file name and artist "FoxBox demo".
  - The script is `audition_pack.py` in the S2 scratchpad. Re-render one clip with a third argument
    (e.g. `mashup.mp3`); Surge needs S1's `FVWKS_SURGEPY_DIR` (read-only).
- **User feedback on the first audition clips:** the synth renders sounded bad. The PM's probes found real bugs, all
  fixed (8cced1f), and the clips were re-rendered:
  - groove clips played one bar late;
  - the incoming drop was faded in (its first kick at −9.6 dB);
  - clicks at stretched joins;
  - drums were key-shifted and smeared by R3;
  - sections were counted in seconds, so the pre-roll played a bar twice.
- **RESAMPLE (4e50b5f, `remix/resample.py`):** one-shots sliced from the bass stem, re-sequenced on riddim /
  half-time grids pitched to the root, with a clean sub sidechained hard to the song's own kick. The drop chain is
  hi-pass 100 Hz, parallel distortion, 3-band OTT-style squash, clipper.
  - Clips: flip-riddim-resample.mp3 and vip-resample.mp3 (script `resample_pack.py` in the S2 scratchpad); drops at
    −5.4 / −5.0 LUFS short-term after a 1-beat breath.
  - Finding: the test song has no growls. Both drops' bass is pure sub/808 (100–600 Hz is 22 dB under < 80 Hz), and
    the other stem holds none. Resampling it can only give distorted 808 hits.
  - Proposed to the PM: (a) render the BASS DNA notes through growl patches, then resample those; or (b) growl the
    808 one-shots with wavefolding, FM and formant filters. Waiting for the pick and the "sound bible".
- **QA rule (PM):** run `scripts/remix_qa.py` (main 510048f; a copy lives in the S2 scratchpad) on every render, and
  never hand the user a FAIL.
- **Fixes from it:**
  - zero-crossing chops;
  - the sidechain dives in 3 ms;
  - declicks at non-contiguous clip edges;
  - a flip bar is silent only when the whole kit is;
  - `mixdown.loud()`: loudness from a smooth clipper before the limiter;
  - `print_shot`: distort before the chop;
  - a 3 ms look-ahead on the OTT's upward stage.
- **User round 2:**
  - hybrid-tearout: the 808 carries the drop, growls only at switch-ups (PASS).
  - The resampled-808 chop is renamed `trap_hybrid` (PASS / 1 WARN).
  - Real riddim needs a rework: one root note plus rests, the LFO retriggered per note at 1/4, 1/4T, 1/8 or 1/8T, and
    the drums' whack (kick 1, a ghost kick at −9 dB under the snare on step 9, a loud clap-snare, offbeat hats,
    triplet accents only at bar ends).
  - Designed growls come from S3's bank (fvwks_synth.growls, help/s3-growls). Its riddim and yoi still click in
    sequence (reported to S3); those clips are parked in `out/remix-audition/_failing/`.
- **Target:** −7 LUFS short-term max (club-safe), true peak ≤ −1 dBTP.
- **Sound Bible (docs/REMIX_SOUND_BIBLE.md on main): S2's items, in the PM's order.**
  - **#3 drop entry:** fades ≤ 7 ms (CUT_BEATS = 1/64, done), a 1-beat pre-drop gap (clips end a beat early, vocals
    excepted), the impact stack at drop bar 1 (a boom sine 40 + 60·e^(−t/0.06) Hz, a crash, a reversed cymbal ending
    on the downbeat), and first-hit-hardest (no kick duck on the first 808 note; the mid +1..+2 dB).
  - **#4 sidechain as envelopes:** sub −10 dB at the kick (1–3 ms in, 20 ms hold, 120–150 ms out), 808 −2..−3 dB, mid
    −6 dB at the kick and −4 dB at the snare, plus a snare no-onset window (±1/16); drop the groove's baked pump on
    flips; in `groove.render_groove` the sub leaves the tanh (clean sine) and the saw path is hi-passed at 120 Hz.
  - **#6 resample engine:** print → second pass → zero-crossing chops → distinct shots (never repeated in a row);
    slices from bass + other with bleed rejection; HP 120 and re-sub.
  - **#7 pattern engine:** §2 grids as data, a 4 / 8 / 16 switch-up scheduler, pauses, fills, glitch or tape-stop.
  - **#8 headline hybrid (§2.5):** a Bass DNA → quantised held-808 converter, the 808 / growl phrase template, the
    VIP form.
  - **#9 drums (§3):** a synthesized kit (2-layer kick, a 4-layer clap-led snare, hats), patterns, a drum bus clip
    and parallel crush, loudness-matched to the source drums.
  - **#10 tempo:** honour `tempo_ratio`; re-trigger one-shots; Rubber Band for sustained stems only.
  - **#11 master:** −7 LUFS short-term with ≤ 3 dB of gain reduction; loudness from the buses.
- **S3 owns** the synth side (sub split, OTT / midbus, designed voices) and QA #12.
- **Engine path (the user's rule: every clip comes from Remix doc → remix.run; commits 86be150, 624ccc7, a511a70):**
  - **Groove clips by `patch_id`:**
    - `resample:<style>`: the source's one-shots re-sequenced;
    - `hybrid:<growl>`: S3's chomp/talker answering the held 808 every half bar;
    - `riddim:wub`: S1's R1/R2;
    - `808:dark`: S1's `render_darkhit`;
    - `808:dive`: the switch-up dive.
    Each has a numpy fallback.
  - **Kit clips:** `kit_id` `source` plays the song's own drums.
  - **Rules in arrange:**
    - hybrid/resample VIPs and the trap_hybrid flip keep the source 808 lane;
    - trap_hybrid's switch-up (a 1/16 snare stutter, then an 808 dive);
    - the drop's first 2 beats as an `808:dark` clip (engine bass is silent under it);
    - a seeded beat pause (bar 8 or 12, 1–2 beats, vocals spared);
    - the 1-beat pre-drop gap;
    - flips stay at the source tempo.
  - **Rules in mixdown:** sidechain envelopes, the snare window, first-hit +1.5 dB with no duck, the impact stack.
  - **Seeding:** everything is seeded from `Remix.seed` (the same seed gives an identical take).
  - **Growl guard:** each growl hit is re-rendered if it fails `growls.clicks`. S3's tearout variants 0 and 3 still
    click in sequence (reported to S3), so the seed picks variant 1 or 2.
  - **Synth package:** unified at help/s3-growls a13bb30, for local runs via PYTHONPATH (an archive in the S2
    scratchpad).
- **`scripts/remix_audition.py`:** `--song --recipe vip|flip --style --patch --kit --seed --takes --bars --lead-bars
  --out`. Stems are cached per content hash; files are named `<song file stem>-<recipe>-<tag>-s<seed>.mp3`; QA runs at
  the end. The user's corrections: no breakdown (at most 1 beat of silence before the drop); the 808's first hit on
  pitch.
- **Test corpus:** `the local test corpus` holds song-1 and ncs-01…06 (titles only in `_manifest.txt`; never write them).
  Corpus runs go to `out/remix-corpus/`.
- **Next:** merge S1's final fvwks_synth sha and re-run the goldens through it; the server wiring is S3's (routes and
  jobs call build(drum_hits=) / prepare_clip / mixdown / bass_groove). Launch rule: FoxBox copies get bundle id
  …test.s2, a temp HOME and CDP port 9312, and are quit only by PID.

## Handover: tuning the presets
- **Where they live:** `engine/fx/src/fvwks_fx/presets/<id>.json` (pact, legion, abyss, unit, ghost, signal, raw).
  Each file has:
  - `chain`: the modules in rack order, each with fixed `params`.
  - `macros`: the default DEPTH / GRIT / MACHINE / SPACE, 0..1.
  - `macro_map`: each macro sweeps module params from `min` (macro 0) to `max` (macro 1), `lin` / `exp` / `log`.
  - `stack`, and the voice / speed hints.
- **Param names and ranges:** `rack_spec.py` (also `uv run fvwks rack`). `resolve()` clamps anything out of range.
- **Tuning loop:**
  - Edit the JSON.
  - Listen: `uv run fvwks render fixtures/sources/<x>.source.json -p <id> --bpm 140 --bars 4 --key Am -o out.wav`
    from `engine/`, or `uv run fvwks audition` for the whole pack.
  - Then `FVWKS_UPDATE_GOLDEN=1 scripts/check.sh fx` to accept the new sound, and `scripts/check.sh fx` to confirm
    green.
  - The golden tests exist to catch unintended changes; regenerate them only for deliberate retunes.
- **Macro math is mirrored in the app** (S4's `lib/macros.ts`). Changing a preset's `macro_map` needs no app change;
  changing the curve formulas in `api.resolve` does.
- **Songs:** `fvwks_fx/song.py`. Key detection is the weak spot on bass-heavy tracks: song-1 is D#m, and it reads
  None there, so the user sets it with the override.

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
  - Stage-memoized on a hash of everything upstream: a SPACE tweak reuses MASK..DYNAMICS (except a CRUSH radio
    bed in a tight file: it closes in time for SPACE's echoes, so there a SPACE move re-runs CRUSH..DYNAMICS).
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
- v1.0.0 QA (the render sweep was stopped early at the coordinator's call): two real failures, both fixed with
  tests. Every render's first and last samples carried a small click (-40 to -70 dBFS), from the master's
  clip, limiter and resampler ringing onto the edges; the output edges are now faded again and pinned to 0.
  LEGION's radio bed had its echo cut by a tight 2-bar end at 120 BPM (-35 dBFS in the last 50 ms); the bed
  now closes sooner when the file is tight. Bar counts and tail room are unchanged.

- v0.7 songs (`fvwks_fx/song.py`, exported from `api`): `analyze_song` (tempo on the 85-175 range, bar 1, key
  + Camelot; numpy/scipy, ~0.5 s for a 2.5-min song) and `mix_song` (drop placed sample-exact, sidechain-style
  duck with a half-beat release, gains, true-peak limit, excerpt with 5 ms fades). Tests: `test_song.py`.

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
