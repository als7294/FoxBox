# FoxBox REMIX: open-source code, patches and data for pro-sounding growls, mixes and vocals (v1)

2026-09-29. For S3 (growl engines in `fvwks_synth`), S2 (mix, arrange and vocals in `fvwks_fx/remix`), S4 (builds and notices) and the PM.

**The complaints this answers:**
- Melodies sound silly and the noises too cartoony.
- The songs aren't properly mixed.
- It should be able to move the vocals around.
- Still off: the growl and bass sound, the bass notes, the drop arrangement.

**Method:**
- Web research used WebSearch and WebFetch only.
- The repo was read only, from `help/s2-151-wip` (worktree `confident-saha-1e7c0f`) and `docs/` on main.
- Three quick local probes, all read-only:
  1. The pinned surgepy build (the one built in worktree `gifted-margulis-ac6fe7`) listed its own oscillator, waveshaper, filter, FX and Airwindows types. It ran with a throwaway HOME, which was deleted afterwards.
  2. pedalboard 0.9.25's installed `time_stretch` signature.
  3. pyworld timings, plus a sub-bass pitch test.

**Licence marks:**
- ✅ read from the LICENSE file, README, official page, PyPI, or the file's own metadata.
- ⚠ covered only by the repo-wide licence (no per-folder notice).
- ❓ UNVERIFIED.

**Hard rules applied:**
- No generative AI or ML models.
- GPL-3-compatible licences only.
- Sizes and runtime costs are stated for every candidate.

Tags in the "Fixes" column:
- **GROWL**: the growl or bass sound.
- **CARTOON**: sounds toy-like or cartoony.
- **MIX**: not properly mixed.
- **VOX**: moving the vocals around.
- **BASS**: 808 and sub.

---

## TL;DR: the 5 highest-value picks

1. **Use Surge XT as a real growl engine.**
   - Cost: already shipped, GPL-3.0, +0 MB of code.
   - Our renderer loads 12 CC0 patches and wobbles the first low-pass cutoff, which is the "2010 wobble" the Sound Bible calls toy-like.
   - The *same* surgepy build we ship has:
     - 12 oscillator types: Wavetable, FM2/FM3, Modern, Alias, String, and **Twist, a port of Mutable Instruments Plaits**.
     - 42 waveshapers and 35 filters.
     - 31 effects: Bonsai, Combulator, Resonator, Freq Shift, Waveshaper, Nimbus (a port of Mutable Instruments Clouds), Vocoder, Convolution, and **75 Airwindows effects**.
   - It also exposes `loadWavetable`, `savePatch`, `setModDepth01` and `processMultiBlockWithInput`, so Surge's effects can also process our own prints and the vocal stem.
   - Build the growl patches in Python from recipes.
   - Fixes: GROWL, CARTOON, BASS.

2. **Real growl and vowel wavetables, plus resample-to-wavetable.**
   - Surge's repo already carries:
     - Venus Theory's **VT Growl 1–10** (0.42 MB).
     - Layzer's **Vocal 1–32** (4.1 MB).
     - The factory Vocal Ah, Vocal O and Choir Formant tables.
     - All GPL-3 with the repo.
   - AKWF and WaveEdit Online single cycles are CC0.
   - The pro trick is to cut our own prints, and the song's own vocal, into exact single cycles (we know f0) and load them back as tables.
   - That gives real formants instead of a band-pass "talking toy".
   - Cost: +1–2 MB of curated data.
   - Fixes: GROWL, CARTOON.

3. **Eight more Airwindows effects in `fvwks_fx._airwin`.**
   - MIT and already vendored; about +0.3 MB.
   - The effects:
     - **Console9 channel and buss**: one console for the stems and the synths.
     - **ButterComp2** and **Pressure5**: bus glue.
     - **ClipOnly2** and **ADClip8**: clipping before the limiter.
     - **Density2**.
     - **Cabs**: speaker colour that takes the fizz off growls.
     - **Acceleration2**: tames a harsh top.
   - Fixes: MIX, CARTOON.

4. **Tonal-balance matching plus vocal-aware ducking.**
   - Re-implement Matchering's GPL-3 algorithm in about 150 lines of numpy/scipy. Don't install the pip package: it pulls in statsmodels (which brings pandas) and resampy (which brings numba).
   - The new parts' long-term spectrum is matched to:
     - the source's own drop or chorus (the stems we keep),
     - blended with a per-style target curve,
     - capped at ±4 dB, above 150 Hz only.
   - The bass mids dip 2–3 dB at 1–4 kHz while the vocal sings.
   - Fixes: MIX.

5. **A vocal-chop engine on what we already ship (0 MB).**
   - What we already have:
     - pedalboard 0.9.25's `time_stretch` takes per-sample pitch arrays with `preserve_formants=True` (Rubber Band R3).
     - `fvwks_fx/modules/mask.py` already has cached WORLD analysis, scale-quantised pitch contours, a formant warp, and an stftpitchshift poly-shift (root, 5th and octave in one pass).
   - What we add:
     - segmentation (WORLD voicing plus spectral flux),
     - retuning to chord tones,
     - stutter, gate, reverse and tape-stop,
     - Surge's vocoder, with the growl as carrier and the vocal as modulator.
   - Fixes: VOX.

**A spike, not a pick: Vita, Vital's engine in Python.**
- GPL-3.0, a 0.9 MB wheel with macOS arm64 builds, and thread-parallel rendering.
- Presets are JSON with embedded wavetables.
- It brings spectral warp (Formant and Vocode), a formant filter, and an OTT-style compressor.
- Try it only if the Surge recipes still sound cartoony in a blind A/B.
- Vital's own presets can't ship, and the "Vital" name can't be used.

**The cheapest fix isn't a library.** The cartoony sound comes largely from our own numbers. The table is in §1.
- The LFOs are pure cosines.
- The vowels jump every 1/16 or sweep ×2.5–×5 per cycle.
- Formant peaks are snapped onto harmonics, so they ring as tuned whistles.
- Pitch snaps go up to +24/+36 st.
- The sources are bare sines.

---

## 0. What we already have (don't re-add it)

**The Surge renderer:** `fvwks_synth/surge.py` and `_surge_child.py`.
- surgepy is built from Surge XT commit `9ebdd49` with one patch, a `setTempo` binding (`engine/synth/native/build_surgepy.sh`).
- The .so is 8.0 MB and ships in engine-code. The S1 spike measured 47× realtime.
- It runs in a child process with its own HOME, CFFIXED_USER_HOME and SURGE_DATA_HOME. Keep that: `createSurge` writes `~/Documents/Surge Synth Team/…`, which we confirmed in the probe.
- Per render it:
  1. loads one of 12 `.fxp` patches (A.Liv, qb, Kinsey Dulcet), each with CC0 in its metadata ✅;
  2. plays the groove's notes with pitch-bend curves at **±24 st** (the Sound Bible asks for ±12);
  3. routes a free voice LFO, tempo-synced, into the **first low-pass filter's cutoff** at depth × 0.6;
  4. adds a "growl" curve as a cutoff offset of up to +24 st.
- It does **not** use:
  - wavetable loading;
  - the FX slots;
  - modulation routings beyond that one LFO;
  - `savePatch`;
  - the audio input (`processMultiBlockWithInput`).
- `_native/` is git-ignored and empty in this worktree. A built copy exists in worktree `gifted-margulis-ac6fe7` and can be used for spikes.

**The numpy voices:** `growls.py`, `riddim.py`, `hybrid.py`, `bass808.py`, plus `midbus.py`.
- They already cover:
  - the clean sine sub with an LR4 crossover at 120 Hz;
  - 4× oversampled distortion and clipping;
  - the Faust-model OTT;
  - phaser, flanger, moving comb and frequency shift;
  - the resonance notch;
  - Marauda's chain A resample loop.
- Nothing in this report replaces that chain. The new sources feed into it.

**`fvwks_fx` already ships:**
- pedalboard 0.9.25 (GPL-3), which includes Rubber Band and JUCE effects.
- `_airwin`: ToTape9, Tube2, DeRez4 and Galactic3. It's MIT, built from `airwin2rack` at `b6eef0af`, and the .so is 361 KB.
- pyworld (MIT; the WORLD library itself is modified BSD), with `modules/mask.py` on top.
- stftpitchshift (MIT).
- pyloudnorm.

---

## 1. Why ours sounds cartoony, and what pros do instead

| Ours (file) | What pro growls do | Fix [evidence] |
|---|---|---|
| `growls._lfo` is a pure cosine. Every per-note LFO (FM depth, fold, formants) is sine-shaped. | Hand-drawn, multi-step LFO shapes. A plain sine LFO gives a siren, not syllables [SRC monosounds]. | Stepped or drawn shapes: 3–8 steps per cycle with 3–10 ms slews. The existing `hybrid.steps` already does this for the downsample wub. [INF numbers] |
| `_voice_talker` steps vowels on every 1/16: the vowel paths (`VOWEL_PATHS`), three band-passes at Q 8–12, gains 0/−3/−9 dB. `_tearout` sweeps formants ×5 and ×2.5 per LFO cycle. | Vowel moves are small (oh → ah is a tiny knob move), with formant resonance around 20–40% [SRC monosounds]. In a real bass voice, F2–F5 sit 7–30 dB under F1 (bass "i": F2 −30 dB) [SRC Csound Appendix D]. | Use the Csound bass-voice table's gains and bandwidths (in §2 C). Keep vowel moves to about ½ octave around a vowel. Glide over 1/8–1/4 instead of stepping every 1/16. [INF] |
| `harmonic_of()` snaps formant centres onto harmonics of f0 (REMIX_HARMONY 1.4). At Q 8–12 on a buzzy source, a peak sitting on a harmonic rings as a pitched whistle. | A voice's formants stay put while the harmonics move through them; that is what makes a vowel read as a vowel. Resonance makes a sound thinner, harsher and more "synth" [SRC Gearspace]. | Snap only combs and resonators that ring for long. Leave the vowel formants fixed, or use real vowel wavetables (pick 2). [INF] |
| Pitch snaps: `_voice_chomp(snap=24)`, `_gunshot` +36 st, riddim `r1` +12 click, and `r1`'s comb swept ×0.5–×3 (−12..+19 st) every cycle. | These are laser and boing gestures. The user has already vetoed high, whiny first hits. | Keep snaps ≤ +12 st over ≤ 20 ms. Allow a bigger one only on the single hero hit and on Voice D fills. Keep comb sweeps within ±7 st. [INF] |
| The sources are a feedback sine plus a sine 5th, sine-on-sine FM, and saw stacks. | Start from something harmonically complex (vowel or growl wavetables, FM on rich carriers), then resample at least twice [SRC monosounds; SRC KVR]. | Use wavetable sources (picks 1 and 2). The numpy voices become a fallback. |
| Each voice gets its own distortion and there's no shared space. | Run the bass layers through a shared distortion group. The "soft" quality comes from the contrast around the distortion, not from a special patch [SRC KVR]. | One shared distortion and glue stage for all bass mids. A tiny shared room on the mids and top, never the sub. [INF] |

---

## 2. Candidates

### A. Synth engines that can run headless from Python

| # | Candidate | Licence | What we'd embed | Size and runtime | Fixes | Risk | Verdict |
|---|---|---|---|---|---|---|---|
| A1 | [Surge XT + surgepy](https://github.com/surge-synthesizer/surge) (pinned 9ebdd49) | **Code:** GPL-3.0 ✅<br>**Factory and third-party content:** the repo's GPL-3 ⚠. Relicensing to CC-BY-SA was proposed for XT 2.0 ([#6741](https://github.com/surge-synthesizer/surge/issues/6741), still open).<br>**Our 12 patches:** CC0 metadata ✅ | The engine (already shipped), plus:<br>• growl patch recipes in Python<br>• an FX-only mode for prints and vocals<br>• wavetables | 0 new code; the 8.0 MB .so is already in engine-code. 47× realtime. FX passes add per-effect cost (measure Nimbus and Convolution). | GROWL, BASS, CARTOON, VOX | Recipes need ears. No Intel build (same as today). The isolated HOME must stay. | **ADOPT (use it properly)** |
| A2 | [Vita](https://github.com/DBraun/Vita), the [Vital](https://github.com/mtytel/vital) engine | **Code:** GPL-3.0 ✅ (PyPI, README)<br>**Vital's bundled presets:** not redistributable ✅<br>**Name:** no "Vital" branding ✅ | The .so, plus our own `.vital` JSON presets. Wavetables are embedded as base64 frames ✅. | Wheel 886 KB (cp312, macOS arm64) ✅, about 2–4 MB unpacked [INF]. Vendor it into engine-code `_native/` like surgepy so engine-runtime stays unchanged. Rendering releases the GIL, one Synth per thread ✅. Speed not measured. | GROWL, CARTOON | v0.1.0 (2026-07-27), one maintainer. `render(pitch, velocity, note_dur, render_dur)` is single-note: fine for one-shot prints, but no pitch-bend automation. A second engine to maintain. | **SPIKE** (1 day). Adopt only if it wins a blind A/B against the Surge recipes. |
| A3 | [DawDreamer](https://github.com/DBraun/DawDreamer) | GPL-3.0 ✅ | A dev tool: Faust JIT and plugin hosting for prototyping | 39.7 MB wheel (0.9.0, 2026-08-12) ✅. Uses LLVM. | — | Heavy. The README warns about import-order segfaults with other LLVM libraries. | **DEV-ONLY** (never ship) |
| A4 | [Odin 2](https://github.com/TheWaveWarden/odin2) | GPL-3.0 ✅ (the font is OFL) | — | JUCE plugin with no headless or Python API. No presets in the repo ✅. | — | Build effort for nothing new | EXCLUDE |
| A5 | [Dexed](https://github.com/asb2m10/dexed) | GPL-3.0 ✅. The msfa FM core is Apache-2.0 ✅. | Reference only | — | — | DX7 cartridge licences are unclear. Surge's FM2/FM3 cover FM. | EXCLUDE |
| A6 | [Helm](https://github.com/mtytel/helm) | GPL-3.0 ✅. Patches CC-BY-4.0 ✅ (stated in the patch file). | — | Archived 2025-02-08 ✅. 75 bass patches, none dubstep-specific. | — | A dead engine | EXCLUDE |
| A7 | [ZynAddSubFX](https://github.com/zynaddsubfx/zynaddsubfx) | GPL-2.0+ ✅. Bank licences ❓ | — | Needs FFTW, mxml and liblo | — | Heavy, and not built for bass music | EXCLUDE |

**Which ones ship free bass or dubstep patches under redistributable licences?**
- **Surge:** yes.
  - Factory Basses (for example Distorted FM, Behemoth, Doomsday, Ring Mayhem): 59+ patches under the repo's GPL-3.
  - Many third-party patches, often with CC0 metadata.
  - Nothing is tearout-specific. Treat them as raw resample sources at most.
- **Helm:** CC-BY-4.0 patches, but they need the Helm engine.
- **Vital:** no. Its presets can't be redistributed, and free community packs typically forbid redistribution.
- **Odin 2, Dexed, ZynAddSubFX:** no usable redistributable dubstep set.
- **Conclusion:** design our own recipes.

### B. DSP code and building blocks

| # | Candidate | Licence | What we'd embed | Size and runtime | Fixes | Risk | Verdict |
|---|---|---|---|---|---|---|---|
| B1 | [Airwindows via airwin2rack](https://github.com/baconpaul/airwin2rack) (already vendored) | MIT ✅ | Add Console9Channel/Console9Buss, ButterComp2, Pressure5, ClipOnly2, ADClip8, Density2, Cabs, Acceleration2. All are present upstream ✅. | 361 KB for 4 effects today, so about +0.3 MB [INF]. Per-sample C++, faster than numpy. | MIX, CARTOON | Our pin `b6eef0af` may predate Console9, so bump it. Each effect needs the README's sample-rate check. | **ADOPT** |
| B2 | The Airwindows effects inside Surge's FX slot: 75 in our build (77 slots, 2 of them NoOp placeholders) ✅ | MIT, inside GPL-3 Surge | Nothing to build. Pick them in recipes: AD Clip, Butter Comp, Pressure, Density, Drive, Focus, Loud, Spiral, Mackity, Cabs, Fire Amp, Bass Drive, Pafnuty, Power Sag, Hard Vacuum, Iron Oxide, To Tape. | 0 MB | GROWL, CARTOON | Surge-only (Apple silicon) | **REUSE** |
| B3 | [Mutable Instruments eurorack](https://github.com/pichenettes/eurorack): Plaits, Clouds, Rings, Braids, Warps | MIT for the STM32 code ✅. The name is a trademark ✅. | Use them through Surge. Twist is a port of Plaits (formant, 2-op FM, waveshaping, wavetable, modal, speech). Nimbus is a port of Clouds. | 0 MB | GROWL (as sources) | Plaits' speech models (SAM, LPC) sound like a robot, which is cartoony. Use FM, formant and waveshaping only as raw sources before heavy processing. | **REUSE via Surge** |
| B4 | [Faust libraries](https://github.com/grame-cncm/faustlibraries) | LGPL-2.1+ with an exception that lets compiled code ship under any licence ✅. Some functions are GPL-3.0-only or STK-4.3 ✅. | Data and technique: `pm.formantValues` (Csound's formant table) and the FOF formant model. The OTT model is already ported. | 0 MB. If ever needed: `faust -lang cpp` offline, then pybind11 like `_airwin`. | CARTOON | None | **REFERENCE / DATA** |
| B5 | [Csound formant table](https://csound.com/docs/manual/MiscFormants.html) (Appendix D) | Numeric facts, also inside Faust physmodels (LGPL with the exception) ✅ | Five formants per vowel (frequency, gain, bandwidth) for the bass and tenor voices, about 150 numbers | About 2 KB | CARTOON | None | **ADOPT (data)** |
| B6 | [ChowDSP utils](https://github.com/Chowdhury-DSP/chowdsp_utils) and [chowdsp_wdf](https://github.com/Chowdhury-DSP/chowdsp_wdf) | chowdsp_utils DSP modules: GPL-3.0 ✅ (some need JUCE). chowdsp_wdf: BSD-3, header-only ✅. | Technique: ADAA clippers (hard, tanh, soft), which give alias-free distortion without 4× oversampling. Surge already contains ChowDSP's CHOW, Tape and warp filters. | 0 MB; ADAA in numpy is about 30 lines | CARTOON (fizz), speed | None | **TECHNIQUE** |
| B7 | [DaisySP](https://github.com/electro-smith/DaisySP) | MIT ✅. Some modules moved to DaisySP-LGPL. | Reference only: FormantOsc, Fm2, VOSIM, wavefolder, SOAP, comb | — | — | Duplicates Surge and numpy | REFERENCE |
| B8 | [Soundpipe](https://github.com/PaulBatchelor/Soundpipe) and [Voc](https://github.com/PaulBatchelor/voc) | Soundpipe: MIT ✅, archived January 2024 ✅. Voc: MIT core, generated C in the public domain ✅. | Optional: Voc, a Pink Trombone vocal-tract model, as a "throat" filter for talkers | About 50 KB of C | CARTOON (talkers) | Speculative | REFERENCE (optional) |
| B9 | [LSP Plugins](https://github.com/lsp-plugins/lsp-plugins) | LGPL-3.0, plus some GPL-3.0 ✅ | Reference designs: multiband compressor, limiter, clipper, dynamic EQ | Heavy build; macOS support only partial ⚠ | — | Build cost | REFERENCE |

**Formant data to use (Csound, bass voice):**
- Frequencies in Hz, amplitudes in dB relative to F1, bandwidths in Hz.
- The tenor table sits on the same page.

| Vowel | F1–F5 (Hz) | Amplitude (dB) | Bandwidth (Hz) |
|---|---|---|---|
| a | 600, 1040, 2250, 2450, 2750 | 0, −7, −9, −9, −20 | 60, 70, 110, 120, 130 |
| e | 400, 1620, 2400, 2800, 3100 | 0, −12, −9, −12, −18 | 40, 80, 100, 120, 120 |
| i | 250, 1750, 2600, 3050, 3340 | 0, −30, −16, −22, −28 | 60, 90, 100, 120, 120 |
| o | 400, 750, 2400, 2600, 2900 | 0, −11, −21, −20, −40 | 40, 80, 100, 120, 120 |
| u | 350, 600, 2400, 2675, 2950 | 0, −20, −32, −28, −36 | 40, 80, 100, 120, 120 |

Compare with ours:
- `growls.VOWELS` holds only F1–F3, at flat 0/−3/−9 dB.
- `riddim.FORMANTS` holds only F1 and F2, at 0/−2 dB.

### C. Wavetables, single cycles, patches and impulse responses

| # | Candidate | Licence | What we'd embed | Size | Fixes | Risk | Verdict |
|---|---|---|---|---|---|---|---|
| C1 | Surge third-party wavetables: [Venus Theory "VT Growl 1–10"](https://github.com/surge-synthesizer/surge/tree/main/resources/data/wavetables_3rdparty/Venus%20Theory/Growl) and [Layzer "Vocal 1–32"](https://github.com/surge-synthesizer/surge/tree/main/resources/data/wavetables_3rdparty/Layzer/Vocal) | The repo's GPL-3 ⚠. No per-folder licence file ✅. Credit the authors. | Data, loaded with `loadWavetable(scene, osc, path)` | 0.42 MB plus 4.1 MB. Ship about 8 vocal tables, around 1.1 MB. | GROWL, CARTOON | The licence is repo-wide. If content moves to CC-BY-SA it is still compatible. | **ADOPT (curated)** |
| C2 | Surge factory "Sampled" tables: Vocal Ah 1/2, Vocal O, Vocal O Formant 1/2, Choir Formant | The repo's GPL-3 ⚠ | Data | Small (≤ 0.5 MB, INF) | CARTOON | As C1 | **ADOPT** |
| C3 | [AKWF-FREE](https://github.com/KristofferKarlAxelEkstrand/AKWF-FREE) | CC0-1.0 ✅ | 600-sample single cycles (folders include hvoice, fmsynth, distorted, overtone, raw, bitreduced) as endpoints for morph tables | Curate 50–200 files: 60–250 KB [INF] | GROWL | Quality varies | **ADOPT (curated)** |
| C4 | [WaveEdit Online](https://github.com/smpldsnds/wavedit-online) banks | CC0-1.0 ✅. A community archive, not an official Synthesis Technology one ⚠. | Banks of 64 waves × 256 samples | About 32 KB per bank [INF] | GROWL | Community uploads, so provenance per bank is unknown | OPTIONAL |
| C5 | Our own tables: resample-to-wavetable and vocal-to-wavetable | Ours, or the user's own content at runtime | Code: an exact-cycle cutter and a `.wt` writer (the "vawt" header plus float32 frames), about 80 lines | 0 MB shipped | GROWL, CARTOON, VOX | None | **ADOPT** |
| C6 | Surge factory and third-party bass patches | Repo GPL-3 ⚠, or CC0 per patch ✅ | Optional resample sources | 25–110 KB each | GROWL | Generic, not genre-specific | OPTIONAL |
| C7 | [Soundwoofer](https://www.soundwoofer.se) cabinet IRs | Claimed "public domain" ❓ UNVERIFIED | Bass-cab IRs for `pedalboard.Convolution` | Small | CARTOON | The licence is unverified | HOLD (use Airwindows Cabs instead) |
| C8 | [OpenAIR](https://www.openair.hosted.york.ac.uk/) room IRs | Creative Commons chosen per IR ✅ (use only CC0 or CC-BY) | One short room IR for a shared "same space" send | 100–500 KB | MIX | Attribution per file | OPTIONAL |

**How to build Serum-style growl tables** (Surge takes up to 512 frames of up to 4096 samples; Serum's convention is 256 × 2048) [SRC gist; INF recipes]:
1. **Vowel morph:**
   - Start from a saw, or an AKWF `hvoice` cycle, at 2048 samples.
   - For each frame, multiply the harmonic amplitudes by a formant envelope interpolated along a → o → u → e → i, using the table above.
   - Use 64 frames per vowel pair.
2. **FM sweep:**
   - Bake 2-op FM at index 0→8 (ratio 0.5, 1 or 2) into 256 frames.
   - Wavetable position then *is* the FM depth, band-limited by the oscillator instead of aliasing like our numpy FM.
3. **Resample:**
   - Print a growl at a known f0 (C2, 65.41 Hz).
   - Cut consecutive cycles at the exact period (sr / f0 samples) and resample each to 2048.
   - Keep the 256 frames with the most spectral change between neighbours (WaveCleaver's RMSE selection).
   - Remove DC, normalise, and crossfade neighbouring frames.
4. **Vocal:**
   - Take a sustained vowel from the song's vocal stem: WORLD-voiced, F0 stable to ±20 cents for at least 150 ms.
   - Cut cycles on WORLD's F0 and make 64–256 frames.
   - The growl then carries the singer's real formants.
5. **Play it:**
   - Drive wavetable position with a drawn, stepped LFO, retriggered per note.
   - Chain: Waveshaper (Fuzz or OJD) → Combulator or Resonator on octaves of f0 → Bonsai → Airwindows Cabs.
   - Print, then run chain A (resample twice).

### D. Mixing and mastering

| # | Candidate | Licence | What we'd embed | Size and runtime | Fixes | Risk | Verdict |
|---|---|---|---|---|---|---|---|
| D1 | [Matchering](https://github.com/sergree/matchering)'s algorithm | GPL-3.0 ✅ | Re-implement, about 150 lines (sketch below). | STFT of a few windows per section, about 0.1–0.3 s per song [INF] | MIX | Over-matching a source that isn't in the genre. Blend it with a style target and cap it at ±4 dB. | **ADOPT the algorithm.** Not the pip package: it needs statsmodels (which brings pandas, patsy and formulaic ✅) and resampy (which brings numba ✅). |
| D2 | Per-style tonal targets (the idea behind iZotope's Tonal Balance Control; it has dubstep targets) | Ours: averaged 1/3-octave curves computed from the local corpus, which never ships | Data, about 30 numbers per style | About 1 KB | MIX | Only derived statistics are stored [INF] | **ADOPT** |
| D3 | Vocal-aware dynamic EQ (the sidechain-EQ or Trackspacer idea) | Technique [SRC Attack Magazine, iZotope] | Numpy STFT, or three-band gains | About 40 lines | MIX, VOX | Too much dulls the drop; cap it at −3..−4 dB | **ADOPT** |
| D4 | Airwindows (B1) on the buses | MIT ✅ | Console9 channel/buss, bus compression, clipper | See B1 | MIX | See B1 | **ADOPT** |
| D5 | pedalboard Compressor and Limiter, pyloudnorm, our `master.py` | Already shipped | — | — | — | — | REUSE |

The D1 algorithm, step by step:
1. Take the average STFT magnitude of the loudest pieces of the target and the reference.
2. Divide reference by target to get a correction curve.
3. Smooth it on a log-frequency scale. Matchering uses LOWESS; a 1/3-octave moving average is enough.
4. Turn it into an FIR filter (irfft, then a Hann window).
5. Convolve it on mid and side separately, then match RMS.

### E. Vocals

| # | Candidate | Licence | What we'd embed | Size and runtime | Fixes | Risk | Verdict |
|---|---|---|---|---|---|---|---|
| E1 | [pedalboard](https://github.com/spotify/pedalboard) 0.9.25 `time_stretch` (Rubber Band R3) | GPL-3.0 ✅ (installed). Rubber Band is GPL-2+. | Per-sample `pitch_shift_in_semitones` arrays (they take effect in steps of 1024 samples or more) and `preserve_formants=True`, confirmed in the installed source ✅ | 0 MB. R3 takes about 1.1 s per 8 s of stereo; R2 about 0.2 s (engine review). | VOX | Phasey on big shifts. Use it for ±5 st. | **REUSE** |
| E2 | pyworld/WORLD plus our `modules/mask.py` | MIT wrapper, modified-BSD WORLD ✅ | `analyze_world` (cached), `pitch_contour`, `warp_envelope`, `world_synth` | 0 MB. Measured here: harvest takes 0.16 s per second of audio, dio 0.01 s. Analysis plus synthesis is about 0.3 s per second at 48 kHz. | VOX | Can buzz on reverb-heavy or bleed-heavy Demucs vocals [INF]. **Fails on sub-bass:** 3–4% voiced on 35–55 Hz tones in our probe, so don't use it for 808 pitch. | **REUSE** |
| E3 | [stftPitchShift](https://github.com/jurihock/stftPitchShift) | MIT ✅ | A list of pitch factors in one pass (harmony stacks) and a quefrency formant lifter ✅ | 88 KB, already installed | VOX | — | **REUSE** |
| E4 | [Parselmouth](https://github.com/YannickJadoul/Parselmouth) (Praat's PSOLA) | GPL-3.0 ✅ | PSOLA for short monophonic chops | 8.6 MB wheel ✅, a new runtime dependency | VOX | Size, and it duplicates E1–E3 | SKIP. Hand-write TD-PSOLA on WORLD's pitch marks (about 60 lines) only if E1 and E2 fail a listening test. |
| E5 | Surge's Vocoder (FX slot 10: 20 bands, the audio input is the modulator) | GPL-3 ✅ | Growl carrier times vocal modulator: a talking growl that says the lyric | 0 MB | VOX, GROWL | Intelligibility | **ADOPT** (an S3 recipe) |
| E6 | [LMMS SlicerT](https://github.com/LMMS/lmms/tree/master/plugins/SlicerT) | GPL ✅ | Reference: spectral-flux slicing | — | VOX | — | REFERENCE |
| E7 | [WaveCleaver](https://github.com/cemkod/wavecleaver/) | GPL-3.0 ✅ (a Go GUI app) | Reference algorithm for C5: F0, zero-crossing cycles, RMSE frame selection | — | GROWL | — | REFERENCE |

**Bass notes (a side note):**
- No library picks the right notes. The harmony rules are in REMIX_HARMONY.
- If the notes come out wrong because of transcription, the suspect is `fvwks_fx/bassline.py`: it autocorrelates the band below 150 Hz over 100 ms, which is prone to octave errors.
- pYIN, a YIN-based tracker with Viterbi smoothing (in librosa, ISC), is the algorithm to port (about 150 lines).
- WORLD is not the tool for this; see E2.
- Clamp Surge's bend range from ±24 to ±12 (the Sound Bible's "seasick slides").

---

## 3. Recommended plan per engine area

### 3.1 Growls (S3, `fvwks_synth`)

1. **Recipe renders** (`surge.py`, `_surge_child.py`):
   - A job can carry a `recipe` instead of a `patch`. The recipe holds:
     - oscillator types and parameters, with a wavetable path per oscillator;
     - FM routing;
     - waveshaper type and drive;
     - filter types;
     - FX slots (type index plus parameters);
     - modulation routes (source, target, depth);
     - per-note parameter curves, applied at block boundaries like the existing event loop.
   - The child builds the recipe on the init patch and can `savePatch` it into the print cache.
   - FX type indices, verified in our build:
     - 5 Distortion, 7 Freq Shift, 10 Vocoder
     - 14 Airwindows, 15 Neuron, 17 Resonator, 18 CHOW
     - 21 Combulator, 22 Nimbus, 23 Tape
     - 25 Waveshaper, 28 Bonsai, 31 Convolution
2. **FX-only mode** (`_surge_child.py`): take an input (2, n) → Audio Input oscillator and/or FX → `processMultiBlockWithInput`. This runs Surge's effects on numpy prints (Bonsai, Combulator, Airwindows, Waveshaper, Freq Shift) and on vocal chops (the Vocoder).
3. **Wavetables** (new `fvwks_synth/wavetables/` plus a `library.json` with id, file, author, licence and source, like `patches/library.json`):
   - VT Growl 1–10, about 8 Layzer Vocal tables, the 6 factory vocal tables, and a few AKWF morph tables.
   - Keep the `.wt` writer and the cycle cutter (C5) in `growls.py` or `midbus.py`.
4. **New voices** (`growls.py`):
   - New `wt:*` styles, for example:
     - `wt:talker`: a vocal table, FM3 on oscillator 2, a stepped LFO driving wavetable position and formant.
     - `wt:chomp`: the growl table, a +12 st / 15 ms snap, Waveshaper "OJD", Bonsai.
     - `wt:vocoder`: see E5.
   - Print them through the existing `chain_a` (resample twice).
   - The numpy voices stay as the fallback on builds without Surge.
5. **Cartoon trims** (the table in §1), as AXES options so ratings decide:
   - stepped LFO shapes;
   - vowel range ≤ ½ octave, using the Csound gains;
   - formants not snapped to harmonics;
   - snaps ≤ +12 st;
   - comb sweeps ≤ ±7 st.
6. **The wobble target:** for recipes, point the default wobble at wavetable position, FM depth or waveshaper drive instead of the first LP cutoff.
7. **Cost:**
   - No new dependencies.
   - +1–2 MB of data.
   - Renders at Surge's 47× realtime plus the effects.
8. **Check:**
   - The existing `growls.qa` (crest, centroid movement) and the click detector.
   - Then a blind A/B with the user: three old voices against three recipes.

### 3.2 Bass: sub, 808 and riddim (S3, with S1's files)

1. **`bass808.py`:**
   - The sine core stays clean.
   - Send only the parallel "dirty" path through Surge's Bonsai, or Airwindows Density or Bass Drive via Surge, keeping the Sound Bible's LP at 400 Hz on that path.
   - Pitch envelope ≤ +5–7 st over 30 ms (PM override).
   - Add a slow ±3–5 cent drift and 2–4 round-robin takes so held notes don't sound like a looped sample [INF].
2. **`riddim.py` `r1`:** a Surge recipe:
   - Classic square, plus FM2/FM3 "throat";
   - the "FX Comb +" filter on an octave of f0, or the Combulator (three combs plus a noise exciter);
   - the saw-down LFO drawn in Surge's MSEG;
   - comb sweep within ±7 st.
3. **`hybrid.py`:** wobble and downsample wub move from an LP sweep to wavetable position or FM on a vocal or growl table, with the LP kept as a minor layer.
4. **`_surge_child.BEND_RANGE`:** 24 → 12.
5. **Bass notes:** see the side note in §2 E (pYIN in `bassline.py`, S2, optional).

### 3.3 Mix bus and mastering (S2; S4 builds)

1. **Airwindows** (`fx/setup.py` EFFECTS, `native/airwin/binding.cpp`, `modules/airwin.py`):
   - Add Console9Channel/Console9Buss, ButterComp2, Pressure5, ClipOnly2, ADClip8, Density2, Cabs and Acceleration2.
   - Bump the airwin2rack pin if Console9 is missing.
   - Run each effect's sample-rate check (24 kHz preview against 48 kHz).
2. **`remix/mixdown.py` `_drop_mix`:**
   - Console9Channel on every lane (stems and synths alike), then the sum, then Console9Buss: one console for everything.
   - Bass-mid bus: ButterComp2 at about 1–2 dB of gain reduction, then ClipOnly2.
   - Light Acceleration2 on the top and vocal.
   - Cabs as an A/B take on the growl mids.
3. **New `remix/match.py`:** `tonal_match(new, ref, sr, cap_db=4.0, lo_hz=150.0)`, the D1 algorithm.
   - Apply it per section to the synth and kit lanes only, never to the stems.
   - Reference: the kept stems of the same section, blended 50/50 with `STYLE_TARGET[style]`.
   - The targets live in `remix/styles/tonal_targets.json`, computed offline by a script from the local corpus.
4. **`remix/mixdown.py`, vocal-aware EQ:**
   - Where the vocal lane is active, duck bass-mid and `other` at 1–4 kHz by up to 3 dB (attack about 10 ms, release about 150 ms).
   - Put new synth top lines and chops on one short shared room send (Galactic3 or a CC0/CC-BY IR) so they share the stems' space. Never the sub.
5. **`master.py`:** add ClipOnly2 and ADClip8 as clipper takes in AXES, next to `mixdown.loud`.
6. **`scripts/remix_qa.py` (S3):** a tonal-deviation check: each octave band from 150 Hz to 10 kHz within ±3 dB of the target [INF].
7. **Cost:** +0.3 MB of native code, about 250 lines of Python, about 1 KB of data. engine-runtime is unchanged.

### 3.4 Vocals: "move the vocals around" (S2; contracts via the PM)

1. **New `remix/vox.py`** (about 250 lines):
   1. **Phrases:** vocal activity from RMS above −35 dB relative, at least 1 beat long, bar-aligned. Score repetition with the chroma code in `mash.py` to find the hook.
   2. **Syllables:** WORLD voicing edges (`mask.analyze_world` on the chosen phrases only: about 3 s for 20 s of vocal with harvest, or about 0.2 s with dio), plus spectral-flux onsets at 2–8 kHz for consonants.
   3. **Chops:** 80–500 ms, cut at zero crossings, 2 ms in and 10–20 ms out.
   4. **Retune:** take each chop's median F0 and move it to the nearest chord tone from REMIX_HARMONY's plan.
      - Up to ±5 st: `time_stretch(pitch_shift_in_semitones=…, preserve_formants=True)`.
      - Larger moves, or robot-tight hits: `world_synth` with F0 replaced.
   5. **Effects:**
      - "Demon" tags: formant −3..−5 st (`warp_envelope`), with pitch −12.
      - Harmony stacks: `stft_shift(factors=[1, 1.4983, 2])`, i.e. root, 5th, octave.
      - Stutter at 1/16–1/32, with a gain ramp.
      - Gate at 60–90% of the slot.
      - Reverse with a pre-swell.
      - Tape-stop (a varispeed ramp).
      - Throw delay: 1/4 dotted, 25% feedback, band-passed 300 Hz–5 kHz.
2. **`remix/arrange.py`:**
   - Keep the hook phrase verbatim in the build and pre-drop (as today).
   - In drops, place chops in the growl rests, at the call/response positions the Sound Bible and REMIX_HARMONY already give (steps 5–8 and step 13 of bars 4 and 8).
   - Allow one chop in the beat pause and one in the 1-beat gap.
   - Riddim stays sparse: one tag per 4 bars.
3. **`remix/prepare.py`:** render a new `VocalChopSrc` clip kind.
4. **Contracts (PM):** `VocalChopSrc {slot, start_s, end_s, target_midi | shift_st, formant_st, reverse, stutter, gate}`.
5. **S3:** the vocoder recipe (E5), fed by a chop.
6. **Check:**
   - No chop inside the snare window (existing check).
   - Output pitch within ±30 cents of the target (WORLD on the output).
   - No clicks (existing detector).
7. **Cost:** 0 MB, code only.

---

## 4. Short technique notes

**What pro remixers do with vocals in these genres** (short):
- **Few chops:** keep 3–4 strong ones, gate them so they don't ring the whole phrase, and don't fill every gap [SRC EDMProd].
- **A melody from one word:** the same slice at the root, +7 and +12 [SRC sfxengine].
- **Formants:** down for a heavier, darker voice, up for a thinner one [SRC sfxengine].
- **Transitions:** reverse clips and tape-stops into drops; extreme stretches for texture [SRC MusicRadar].
- **Making room:** when the vocal enters, duck the beat's upper mids by about 2 dB with a dynamic EQ [SRC Attack Magazine / iZotope].
- **Per genre:**
  - Hybrid trap puts tags in the gaps.
  - Tearout puts soundbytes in the pre-drop gap and in pauses.
  - Riddim uses rare tags and scratch fills at bar 8.
  - (The Sound Bible already covers placement.)

**Less-cartoony checklist** (numbers are INF unless cited):
1. **LFOs:** drawn or stepped, not cosine [SRC monosounds].
2. **Vowels:** small moves, real formant gains, not snapped to harmonics on held notes [SRC Csound, monosounds].
3. **Pitch gestures:** ≤ +12 st over ≤ 20 ms, except the hero hit and fills.
4. **Sources:** rich (growl and vocal tables, resampled prints) [SRC monosounds].
5. **Noise:** a noise "air" layer at −20..−26 dB, amplitude-modulated by the growl's own envelope. Surge's Bonsai has noise AM built in [SRC Surge].
6. **Distortion:** one shared distortion and glue stage for all bass mids, then Cabs or a low-pass at 8–12 kHz [SRC KVR].
7. **Variation:** 2–4 round-robin takes per hit, ±3–5 cents, ±0.5 dB, never the same shot twice in a row.
8. **Space:** a tiny shared room on the mids and top, never the sub.
9. **Resonance:** avoid heavily resonant low-pass sweeps on held basses (reese variant 3 is at Q 4; PWM reso sits at 60–75%). Resonance thins the sound [SRC Gearspace].

---

## 5. Excluded, and why

- **Generative or ML tools (the hard rule):**
  - MusicGen, Stable Audio, RAVE, DDSP-trained models, neural synths.
  - Vocal-Chopper, because it needs CREPE and Demucs with torch and TensorFlow.
  - The madmom models (also CC BY-NC-SA).
- **Vital's bundled presets:** a separate licence forbids redistribution. Free Vital and Serum preset packs (for example Black Lotus, sin aesthetic, RPS, Muted.io) typically allow use but forbid redistribution.
- **Commercial or "free to use" content:**
  - Commercial preset and wavetable packs, and free Serum wavetable giveaways (Sonic State, BVKER): redistribution not granted ❓.
  - Sample sites (SampleFocus, Noiiz, Splice): royalty-free for music, not for shipping inside software.
- **AJ Young BassTables:** no licence stated on Surge's wiki. The Surge "Psiome Send Sound" patches built with them are also out; their provenance is ❓.
- **Closed tools:** Xfer OTT, Serum, Kilohearts (Disperser), Trackspacer, RC-20, Soothe. We re-implement the ideas instead.
- **Matchering as a pip dependency:** pandas, patsy and formulaic (via statsmodels) and numba/llvmlite (via resampy) are a big engine-runtime bump. Re-implement it instead (D1).
- **DawDreamer in the app:** a 39.7 MB wheel with LLVM. Dev-only.
- **Parselmouth:** an 8.6 MB new runtime dependency that duplicates Rubber Band, WORLD and stftpitchshift.
- **Other synth engines:**
  - Odin 2: no headless API, no presets.
  - Helm: archived.
  - ZynAddSubFX: heavy dependencies, bank licences ❓.
  - Dexed: redundant FM, unclear cartridges.
- **LSP Plugins:** partial macOS support and a heavy build. Reference only.
- **Soundpipe as a library:** archived. Voc is optional reference only.
- **Soundwoofer IRs:** exact licence ❓. Use Airwindows Cabs.
- **Plaits' speech models (via Twist) as growl voices:** robotic, which is exactly the "cartoony" problem.
- **WORLD for sub-bass pitch:** failed our probe (3–4% voiced on 35–55 Hz tones).
- **Essentia (AGPL) and sms-tools (AGPL):** not needed.

---

## Sources

**Surge**
- Surge XT repo and LICENSE: https://github.com/surge-synthesizer/surge
- Content licensing issue #6741: https://github.com/surge-synthesizer/surge/issues/6741
- surgepy source: https://github.com/surge-synthesizer/surge/blob/main/src/surge-python/surgepy.cpp
- Manual: https://surge-synthesizer.github.io/manual-xt/
- Changelog: https://surge-synthesizer.github.io/changelog/
- Wavetables: https://github.com/surge-synthesizer/surge/tree/main/resources/data/wavetables_3rdparty
- Additional content wiki: https://github.com/surge-synthesizer/surge-synthesizer.github.io/wiki/Additional-Content
- Twist and Nimbus: https://bedroomproducersblog.com/2021/04/25/surge-synthesizer-update/ , https://synthanatomy.com/2021/04/surge-1-9-free-synth-plugin-4-new-osc-types-new-effects-mi-clouds-more.html
- Bonsai, Resonator and Combulator: https://library.vcvrack.com/SurgeXTRack/SurgeXTFXBonsai
- `.wt` format: https://gist.github.com/iicaras/f63dc9fcc3f9a83ccaf2de3fbc9fbb5a

**Vital and Vita**
- Vital: https://github.com/mtytel/vital
- Vita: https://github.com/DBraun/Vita , https://pypi.org/project/vita/ , https://github.com/DBraun/Vita/blob/main/CHANGELOG.md
- Vital spectral warp: https://www.musicradar.com/music-tech/plugins/fantastic-free-plugins-and-how-to-use-them-vital , https://forum.vital.audio/t/vocode-and-formant-scale/9604
- Vital filters: https://davidmvogel.com/docs/Vital/UserGuide/Filters
- Vital compressor: https://forum.vital.audio/t/the-compressor-settings-walk-through/2918
- `.vital` format: https://forum.vital.audio/t/help-decoding-waveform-data-from-vital-presets/12267

**Other synth engines**
- DawDreamer: https://github.com/DBraun/DawDreamer , https://pypi.org/project/dawdreamer/
- Odin 2: https://github.com/TheWaveWarden/odin2
- Dexed: https://github.com/asb2m10/dexed
- Helm: https://github.com/mtytel/helm (patch licence in `patches/Factory Presets/Bass/COA Trap Bass 1.helm`)
- ZynAddSubFX: https://github.com/zynaddsubfx/zynaddsubfx

**DSP code**
- Mutable Instruments: https://github.com/pichenettes/eurorack , https://pichenettes.github.io/mutable-instruments-documentation/modules/plaits/manual/
- DaisySP: https://github.com/electro-smith/DaisySP
- Soundpipe: https://github.com/PaulBatchelor/Soundpipe
- Voc: https://github.com/PaulBatchelor/voc
- Faust libraries: https://github.com/grame-cncm/faustlibraries (compressors.lib header), https://faustlibraries.grame.fr/libs/physmodels/
- Csound formants: https://csound.com/docs/manual/MiscFormants.html
- ChowDSP: https://github.com/Chowdhury-DSP/chowdsp_utils , https://github.com/Chowdhury-DSP/chowdsp_wdf
- Airwindows: https://github.com/baconpaul/airwin2rack , https://github.com/airwindows/airwindows (Airwindopedia), https://www.airwindows.com/consolex/ , https://www.airwindows.com/thenewcabs/
- LSP Plugins: https://github.com/lsp-plugins/lsp-plugins

**Wavetables and impulse responses**
- AKWF: https://github.com/KristofferKarlAxelEkstrand/AKWF-FREE
- WaveEdit Online: https://github.com/smpldsnds/wavedit-online
- WaveCleaver: https://github.com/cemkod/wavecleaver/
- Soundwoofer: https://www.kvraudio.com/news/soundwoofer-launches-new-section-of-public-domain-impulse-response-library-47884
- OpenAIR: https://www.openair.hosted.york.ac.uk/?page_id=2

**Mixing**
- Matchering: https://github.com/sergree/matchering (`stages.py`, `stage_helpers/match_frequencies.py`), https://pypi.org/project/matchering/
- resampy on PyPI: https://pypi.org/project/resampy/
- statsmodels on PyPI: https://pypi.org/project/statsmodels/
- Dynamic-EQ ducking: https://www.attackmagazine.com/technique/tutorials/creating-natural-space-in-a-mix-with-dynamic-eq/ , https://www.izotope.com/en/learn/5-ways-to-use-dynamic-eq-with-sidechain.html
- Tonal Balance Control 3: https://www.musicradar.com/music-tech/izotopes-tonal-balance-control-3-captures-audio-directly-from-spotify-youtube-and-your-daw-timeline-for-fast-and-intuitive-referencing
- Mixing a drop: https://edmtemplates.net/blogs/edm-templates-blog/how-to-mix-a-dubstep-drop

**Vocals**
- pedalboard: https://github.com/spotify/pedalboard (and the installed `TimeStretch.h`)
- pyworld: https://github.com/JeremyCCHsu/Python-Wrapper-for-World-Vocoder
- stftPitchShift: https://github.com/jurihock/stftPitchShift
- Parselmouth: https://github.com/YannickJadoul/Parselmouth , https://pypi.org/project/praat-parselmouth/
- Vocal-Chopper: https://github.com/Moebytes/Vocal-Chopper
- LMMS SlicerT: https://github.com/LMMS/lmms/blob/master/plugins/SlicerT/SlicerT.cpp
- Vocal chops: https://www.edmprod.com/vocal-chops/ , https://sfxengine.com/blog/vocal-chops-tutorial
- Acapella tricks: https://www.musicradar.com/tuition/tech/8-essential-vocal-acapella-production-tricks-641406
- pYIN: https://librosa.org/doc/0.11.0/generated/librosa.pyin.html

**Growl sound design**
- monosounds growl recipe: https://monosounds.studio/serum-2-dubstep-growls/
- Gearspace on resonance: https://gearspace.com/board/electronic-music-instruments-and-electronic-music-production/1414285-bass-sound-design.html
- KVR on distorted bass: https://www.kvraudio.com/forum/viewtopic.php?p=9303137
- Vocal wavetables: https://rocketpoweredsound.com/blogs/production/5-ways-to-make-growl-bass-in-serum

**Internal**
- `docs/REMIX_SOUND_BIBLE.md`, `docs/REMIX_HARMONY.md`, `docs/REMIX_BACKEND.md`, `docs/REMIX_ENGINE_REVIEW.md`
- The engine code on `help/s2-151-wip`
