# FoxBox REMIX Sound Bible (v1)

> **⚠ PM OVERRIDE (2026-09-29): there is NO breakdown.** The user corrected it: "the 4 bar breakdown, remove it, I didn't mean that. Maybe 1 beat of silence." Wherever this bible says "4-bar (quick) breakdown" (§1.7 rule 2, §2.5 Form, §4 Whole VIP), read: original pre-drop hook → **at most ~1 beat of silence** → the new drop. Also, **the 808 first hit must not be high or whiny**: ignore the +24/+36 st pitch-envelope starts in §2.3 and §2.5 and use ≤ +5–7 st over ≤ 30 ms, starting on pitch. Plan of record: `docs/REMIX_IMPLEMENTATION_PLAN.md`.

> **PM owner remap (2026-09-29):** items listed for **S1** (1 sub split, 2 OTT + oversampled midbus, 5 designed voices, 13 ear candy) are done by **S3**, which owns the growl engines in fvwks_synth under a PM exception while S1 is on face masks. **S3 also takes #12** (QA additions to its remix_qa.py). S2 owns 3, 4, 6–11.

For S1 (synth and patches) and S2 (resample, patterns, mix). Everything here is DSP or algorithmic. There is no generative AI, no third-party presets and no copied melodies or audio.

**How sure each number is:**
- **[SRC]** comes from a cited tutorial, interview or forum post.
- **[INF]** is our engineering inference. Treat it as a starting knob and calibrate it with `scripts/remix_qa.py`.

**Known gaps:**
- No video tutorials could be read, because every transcript service returned 403.
- Subtronics, LEVEL UP and Tape B have published almost no parameter-level numbers. Their traits come from interviews and reviews; their numbers come from genre tutorials.
- Marauda and Kai Wachi were not researched separately. The tearout section is built from the Subtronics/Cyclops canon plus general tearout tutorials, and we are assuming it carries over to them.

**Grid convention:**
- 1 bar = 16 steps of a 1/16. Step 1 is the downbeat. The half-time snare is on step 9.
- The triplet grid is 12 slots of a 1/8T per bar. Slots 1, 4, 7 and 10 start the beats, and the snare is on slot 7.
- `x` = hit, `-` = hold, `.` = rest, `g` = ghost (-9 dB), `~` = glide, `v` = pitch dive.

| BPM | 1/4 | 1/8 | 1/8T | 1/16 | 1/16T | 1/32 | bar |
|---|---|---|---|---|---|---|---|
| 140 | 429 ms | 214 | 143 | 107 | 71 | 54 | 1.714 s |
| 145 | 414 | 207 | 138 | 103 | 69 | 52 | 1.655 s |
| 150 | 400 | 200 | 133 | 100 | 67 | 50 | 1.600 s |

LFO rates at 150 BPM: 1/2 = 1.25 Hz, 1/4 = 2.5, 1/4T = 3.75, 1/8 = 5, 1/8T = 7.5, 1/16 = 10, 1/16T = 15. `fvwks_synth.sync_hz()` already computes these.

---

## 0. Why the first remixes sounded awful (ranked)

1. **The sub goes through the distortion.**
   - `groove.py render_groove` computes `tanh(drive*(0.8*sub + 0.6*saw))` with drive up to 5.
   - `foxsynth` adds the sub at hz/2 *before* the drive and the filter. With E1–G1 notes, that puts the sub at 20–25 Hz, which is subsonic, wastes headroom and makes the limiter pump.
   - The result is intermodulation mud and a sub whose level moves with every growl gesture.
   - Every source agrees on the fix: a separate clean mono sine sub plus a mid layer high-passed at 100–150 Hz. [SRC tracksensei, dubstepforum, Virtual Riot masterclass]
2. **Wrong sound-design paradigm.**
   - Now: a saw or square into a 2-pole LP sweeping 120 Hz–4 kHz, and foxbox.riddim is an LP at 150 Hz, Q 4. That is the 2010 wobble, and it whistles and sounds toy-like.
   - Modern tearout and riddim midrange comes from pitch envelopes, FM, formants, comb/phaser/allpass stages and frequency shifters, then OTT and clipping. An LP sweep mostly *removes* energy.
3. **No density.**
   - There is no upward compression (OTT), no staged clipping and no oversampling, so the drive aliases into fizz.
   - That gives a high crest factor: the bass sounds thin, then gets LUFS-matched up and squashed by the master.
4. **One timbre, one loop, no arc.**
   - Tearout changes timbre about every 1/16 (about 10 times a second) [SRC soundwitches].
   - Everything needs a change every 4 bars and a big switch every 8 [SRC KAN, melodigging].
   - We loop one patch and one bar for 16 bars. That is exactly "cool for a few seconds then awful", and the 808 VIP verdict.
5. **It replays the transcribed bass line.**
   - Riddim is a 1–2 bar, 1–3 pitch, gated motif with rests and call/response.
   - A transcribed line through an LFO reads as a MIDI cover. Jittery Demucs note fragments also retrigger envelopes and LFOs at random points.
6. **Nothing clears the snare, and the ducking is wrong.**
   - The bass plays through step 9.
   - The old pump baked into the source stem lands in the wrong places after the flip.
   - The planned fixed -6 dB / 70 ms duck is too shallow for the sub and too deep for the mids.
7. **Weak drums.**
   - `flip.py` band-splits the drum stem at 150 Hz and 5 kHz. The snare loses its clap sizzle and the kick loses its click.
   - Riddim plays 12 flat-velocity 1/8T hats every bar (a machine gun), with no ghost kick and no layered snare.
   - The kit sits at about -12.4 LUFS while the master sits at -7.
8. **Blunt drop entry.**
   - Groove clips land one bar late.
   - There is a 0.25-beat fade-in on the drop, no pre-drop gap and no impact.
9. **Tempo handling.**
   - Rubber Band stretches drums and distorted bass, which smears transients.
   - The 2x ratio for half/double-time sources is ignored.
10. **Resample slices come from the bass stem only.**
    - The growl's 1–5 kHz partly lands in Demucs `other`, so slices are dull and phasey, and they carry the old sub.

---

## 1. Global rules (every style)

### 1.1 Layers
| Layer | Content | Range | Processing allowed |
|---|---|---|---|
| **SUB** | numpy sine, mono, one voice, continuous phase through glides | 30–60 Hz fundamental; force the root into C1–A1 (32.7–55 Hz) | Amp gate (A 2–3 ms, R 10–20 ms), LR4 LP at 120 Hz, sidechain. Optional tanh 1–2 dB at 4x oversampling only. **No OTT, no clip, no reverb, no wobble.** |
| **808** (hybrid/VIP) | sine with a pitch envelope, glide, parallel saturation | same root range | See §2.3. It *replaces* SUB in 808 sections. **Never both at once**: one owner of the low end at a time. |
| **MID** | designed patch or resample slices | LR4 HP at 120 Hz (range 100–150) | Full chain, §1.2 |
| **TOP** | arp, lead, ear candy, FX | sides above about 200 Hz | Width free above about 7 kHz; chorus 15–25% mix from 650 Hz–7 kHz |

- **Crossover:** LR4 at **120 Hz** (two cascaded 2nd-order Butterworths via scipy). This matches the master's existing mono-below-120 Hz fold.
- **Sub level:** match the **30–90 Hz band RMS** of the original drop within ±1 dB, not its LUFS. K-weighting under-counts content below about 40 Hz. [INF]
- **Held weight (user rule 1):** the test track's bass is a multi-second held 808/sub.
  - Every style keeps **at least one held sub/808 note of ≥ 1 bar per 4-bar phrase**, with mids chopped on top.
  - The sub is only kick/snare ducked. It is never chopped to the mid's gate, except in riddim, where it follows the gate on accent bars only.

### 1.2 MID bus processing order (the canonical chain)
Level-match after every stage: the sound should get *denser*, not louder.

```
[patch/slices]
 → formant/vowel or comb stage (before distortion)
 → LR4 HP 120 Hz
 → Distortion #1, 4x oversampled (resample_poly 4:1): pedalboard Distortion drive_db 18–24 (hard/diode character)
 → movement FX: Phaser (rate 1/2 synced, fb 0.6, mix 0.5) OR flanger 1–5 ms fb 0.7 OR freq-shifter
 → Distortion #2, different mode: tanh/soft 6–12 dB, 4x oversampled
 → OTT (numpy, §1.3) depth 0.6–1.0 on sound design, 0.4–0.6 on the bus
 → EQ: LR4 HP 120 Hz again; -3 dB @ 400 Hz (Q 1); resonance notches -4..-8 dB @ Q 6–10;
       dynamic -3..-4 dB @ 2–4 kHz on peaks
 → Sidechain duck (§1.4)
 → Clipping: 1–3 dB of peak reduction, 4x oversampled
```

- Sources: [SRC monosounds, presetdrive, tracksensei, edmtemplates].
- The "clipping by 30 dB" anecdote [SRC Dancing Astronaut] means a total drive of 24–30 dB across the stages is in style *for design prints*. On the bus, keep it to 1–3 dB.
- Pedalboard's `Distortion` is plain tanh and `Clipping` is a plain hard clip, with no oversampling. **Always wrap both in 4x `resample_poly`.**

### 1.3 OTT (numpy, build once; S1 owns it, everyone uses it)
- **Bands:** LR4 crossovers at **88.3 Hz and 2.5 kHz**.
  - The existing `resample.ott` crosses at 120 Hz. Move it to 88.3 Hz, or HP first so the low band is empty.
- **Detector:** stereo-linked one-pole on (L²+R²)/2.
- **Downward:** low -33.8 dB at 66.7:1, mid -30.3 dB at 66.7:1, high -35.5 dB at ∞:1.
- **Upward:** thresholds -40.8, -41.8, -40.8 dB at about 4:1, gain capped at **+36 dB**.
- **Attack/release:** low 47.8/282 ms, mid 22.4/282 ms, high 13.5/132 ms. "Time" is a release multiplier.
- **Gains:** input +5.2 dB. Output low +10.3, mid +5.7, high +10.3 dB.
- **Depth** 0–1 is a wet/dry blend.
- **Source:** Faust co.xfer_ott PR #257 and the Ableton OTT preset [SRC]. The two disagree slightly (Xfer vs Ableton). Pick the Faust model.
- **On Demucs slices:** gate or expand below -40 dBFS *before* OTT and use depth 0.2–0.3. Upward compression lifts bleed by up to 36 dB. [INF]

### 1.4 Sidechain (volume envelopes; we know every hit time, so no audio compressor is needed)
| Target | Trigger | Depth | Attack | Hold | Release @150 BPM |
|---|---|---|---|---|---|
| SUB | kick | -10 dB (range 8–12) | 1–3 ms ramp with look-ahead | 20 ms | exponential, 120–150 ms |
| 808 | kick | -2..-3 dB only (it plays *with* the kick); or HP the kick at 50 Hz | 1 ms | – | 80 ms |
| MID | kick | -6 dB | 0.5 ms | – | 1/16 (100 ms) |
| MID | snare | -4 dB, **plus** the no-onset window (below) | 0.5 ms | – | 100 ms |

- Sources: [SRC presetdrive 8–12 dB and 100–250 ms, tracksensei 2–4 dB on mid, dubstepforum 70–150 ms]. Sources disagree on mid depth (1–2, 2–4 or 6 dB). Start at the values in the table.
- Duck only above 90 Hz on the mid (it is high-passed anyway).
- Release ≥ 250 ms smears into the next 1/8, and < 80 ms clicks.
- **Snare window:** no mid-bass onset between snare - 1/16 and snare + 1/16. The mid ends ≥ 1/16 before step 9 and re-enters on step 10 or later. This is the "chequerboard": the snare stands alone. [SRC edmtemplates, gearspace snippet]
- **Replace, don't stack:** remove the source stem's baked-in pump (re-synthesize or replace the sub) before applying the new ducks.

### 1.5 Loudness and master (user-fixed)
- **CLUB target: drop short-term max = -7 LUFS (±0.5), true peak ≤ -1.0 dBTP.**
  - Research says pro heavy drops run hotter (-6 to -3 short-term). The user chose -7 deliberately for club safety. **Density comes from OTT and clipping on the buses, not from master gain.**
  - Expect ours to read slightly less loud than references at matched gain. That is the accepted trade.
- Mix bus peaks around -6 dBFS before the master.
- **Master chain:** HP 25 Hz → mono below 120 Hz → OTT depth ≤ 0.1 → soft clip (tanh) 1–3 dB → BrickwallLimiter (release 50–100 ms, ≤ 3 dB GR on the drop) → true-peak check at 4x.
  - If the limiter needs more than 3 dB of gain reduction, the buses are under-prepared. Fix the buses, not the master.
- **Section contrast:**
  - Build 4–6 LU under the drop.
  - Intro and breakdown 8–10 LU under the drop (LEVEL UP's eerie-intro contrast). [SRC tracksensei; INF for the LU]
- **Drum level:** loudness-match the kit to the original drum stem over the same bars *before* the bus stages (it is -12.4 LUFS now).

### 1.6 Timing and tempo
- **Tempo per style:**
  - Keep the source BPM if it is within ±5% of the style tempo.
  - Treat half/double-time sources as ratio about 1.0 (70 over 140). **Honour `MashMatch.tempo_ratio`.**
  - Cap stretch at ±10%. [INF]
- **Re-trigger, don't stretch:** drums and bass one-shots are re-triggered at grid times at the remix tempo. Rubber Band is used only for sustained tonal and vocal stems.
- **Pitch one-shots with varispeed** (resample), not Rubber Band. The speed change that comes with it is part of the aesthetic.
- **Fix the one-bar-late groove bug.** Drop-bar fade-in ≤ 1/64 beat (about 7 ms).

### 1.7 Arrangement laws (user rules; apply to every style)
1. **Held weight:** long held sub/808 notes stay (§1.1).
2. **VIP form:** the original build → the original **pre-drop hook** (kept verbatim from the source stems) → a **quick 4-bar breakdown** → the **NEW drop**. For the trap-hybrid, the breakdown is optional.
3. **Beat pause:** once per 16-bar drop (at most twice per 32), a mid-drop pause:
   - 1/2 to 2 beats with everything out except an optional vocal chop or FX tail,
   - placed at the end of bar 8 or bar 12,
   - then a full-energy re-entry on the next downbeat.
4. **First bass hit is the hardest.** Drop bar 1, beat 1 stacks:
   - kick at 1.0,
   - impact boom (sine 40 + 60·exp(−t/0.06) Hz, 0.35 s decay, peak about -10 dBFS pre-master),
   - crash,
   - a reversed cymbal ending exactly on the downbeat,
   - the first sub/808 note with **no kick duck on that one hit** (layer the kick instead),
   - the mid's hardest patch at +1..+2 dB over the rest of the drop, with its longest note.
   
   It also arrives out of silence (§1.8).

### 1.8 Pre-drop gap
- Sources disagree: 1/2–1 beat [SRC tracksensei] versus 1–2 bars [SRC KAN].
- **Default: 1 beat.**
- Everything is muted except an optional vocal or soundbyte cue from the source's vocal stem. Kill reverb and delay tails.
- **Fake-out option:** a 1-bar gap. Use it in about 30% of renders, and when using a false drop.

---

## 2. Styles

### 2.1 RIDDIM (LEVEL UP / early Subtronics)
**Identity:** one-note square-FM wub motif, 1–2 bars, triplet-rolled, with metallic comb/flanger colour, huge silence around a clap-led snare, and wonky LFO-rate switching. It is *not* busy.

**BPM:** 145 by default (range 142–150). LEVEL UP sits at 145–150.

**Pitch vocabulary:** about 80% of hits on the tonic (mid at root +12). Accents come from {+12, +7, +1, +6, −2}. About 1 in 4 notes ends with a −12..−24 st glide over its last third. Snap BASS DNA to this vocabulary; **never replay the source line.**

**Bass voice R1, "square-FM wub" (S1, Surge XT or foxsynth)**
- Osc1: Classic, square, PW 50%, unison 1, root +12 (E2 82 Hz for E minor).
- Osc2: Sine at a 1:1 ratio (or 0.5 for throat), FM routing 2>1.
- FM depth 15–25% at rest, swept to about 40% by LFO1 at peaks.
- Filter 1: Comb+ at 300–900 Hz (a 1.1–3.3 ms delay), feedback 60–80%, mix 60%, ±12 st from LFO1.
- Filter 2: LP 24 dB at 4–6 kHz, resonance 15%, static (the "muffled" top).
- Amp: A 1 ms, D 200 ms, S 100%, R 15 ms. Gate each hit to 60–90% of its slot.
- Pitch env: +12 → 0 st over 30 ms (the click).
- LFO1: **retrigger on note-on**. Shape: exponential saw-down (open at note start, closed for the last 30%).
  - Targets: amp 60–100% (the wub itself), FM +20–35 pts, comb freq, WT position.
  - Rate per note from {1/4, 1/4T, 1/8, 1/8T, 1/16}.
- LFO2 at half of LFO1's rate drives phaser/flanger mix. [SRC DSF thread]
- The numbers for the comb/"square4" dual comb are [INF].

**Bass voice R2, formant "yoi" (S1, numpy)**
- A saw or square through a Surge Resonator or two parallel band-passes, Q 8–10, at vowel formants F1/F2 in Hz:
  - u 250/595, o 360/640, a 850/1610, e 390/2300, i 240/2400.
- Per note, sweep u→a→i (or i→o→i, the "yoi") over one LFO cycle at 1/8T. Mix 30–50% under R1.

**Resample recipe (S2)**
1. Print R1 holding one note for 2 bars, once for each LFO rate in {1/4, 1/4T, 1/8T, 1/16}.
2. Chop at LFO-cycle boundaries into shots 1/8T to 1/2 beat long. Cut at zero crossings, 1 ms in and 8 ms out.
3. Keep the 6–10 shots that are most distinct by centroid and pitch contour.
4. Varispeed-repitch to {−12, −5, 0, +3, +7, +12}. Reverse about 1 in 8.
5. Second pass: OTT 0.5 + clip 3 dB, with a *different* modulation rhythm than pass 1.
6. **From the track's own stems:** sum Demucs `bass` + `other` within the drop. Onset-slice and keep only slices with centroid > 400 Hz and high flux. Reject any slice where the drums-stem RMS is within 12 dB of the slice. HP at 120 Hz, then re-sub with the sine.
   - For the test track (pure 808, growl band about -28 dB), stem slices are 808 chops: that is the **trap** sound. **Real riddim must use designed R1/R2 prints.**

**Chain:** §1.2 with Distortion #1 at 20 dB and Distortion #2 at 8 dB. The movement FX is the flanger (2 ms, fb 0.7). OTT depth 0.4 (presetdrive: 30–40%) on the bus and 0.8 on prints. Add Bitcrush at 10 bits, 20% parallel, for the Roar-noise flavour [INF mapping of the EDMProd recipe].

**Grid (2 bars, 1/8T, 12 slots; A = R1, B = R2 or a resample shot; snare on slot 7):**
```
         1 2 3 |4 5 6 |7 8 9 |10 11 12
Bar 1 A: x - . |. . . |. x - | .  .  .
      B: . . . |x . . |. . . | x  x  .
Bar 2 A: x x . |. . . |. x~v| .  .  .     (slot 8: 2-slot hit, bend −12 st)
      B: . . x |. . . |. . . | .  x  x    (slots 11-12: LFO 1/16T)
SUB  : held root through beats 1-2, cut from slot 7 (snare) to slot 8, held again; kick-ducked
```
- Alternative straight grid, T2 "3+3+2", in 1/16: `A..A..A.[9 rest]..BB.A..`
- Or the fixed riddim cell in 1/8T: `xx. ... xxx ..x` (call beat 1, rest beat 2, response with the snare, pickup).

**Drums (16 steps, 145 BPM):**
```
Bar 1  KICK  x...............      GHOST(-9dB) ........g.......
       SNARE ........x.......  (clap-led stack, tail A)
       HAT   ..x...x...x...x.  (offbeat 8ths, v0.8; hat-on-kick at -9 dB)
Bar 2  KICK  x.............x.  (step 15 at v0.7)
       SNARE ........x.......  (tail B)
       HAT   ..x...x...x.....  + beat 4: six 1/16T hits, v0.4→0.8
```
Remove the 12-hat carpet from `FLIP_STYLES['riddim']`.

**Switch-ups (per 16):**
- Bars 1–4 T1.
- Bars 5–8 T1 with new LFO rates on 1–2 notes and the B pitch moved +5 or +7. Bar 8: beat pause (§1.7) plus a scratch fill (a 1/8 vocal or bass slice played forward then reversed at 1/16T, transformer-gated at 1/32; LEVEL UP's turntablist DNA [INF]).
- Bars 9–12: swap voice B for a resample shot, triplet grid.
- Bars 13–16: switch state. Options: the classic wobble (saw, 24 dB LP 150 Hz → 1.5 kHz, rate automated 1/4 → 1/8 → 1/16), the growl call/response, or a 4-bar **techno switch** (kick on every beat, clap on 5 and 13, open hat on the offbeats, bass 1/16 stabs on steps 3, 7, 11 and 15).
- Bar 16: a stop with the last 2 beats silent.

**Drop entry:** 1-beat gap (1 bar for a fake-out). Fake-out: 2 beats of the wrong patch plus silence, then the real drop. 8-bit ear candy is optional in the build and fills: square arp of the root triad at 1/16, a +24 st power-up sweep over 1 beat, coin blips a 4th apart at 1/32 [INF from "video-game sound world"].

### 2.2 TEAROUT (Cyclops-era Subtronics, and assumed to fit Marauda and Kai Wachi)
**Identity:** pitch-gesture basses (chomp, disperser pew, freq-shift dive), a different sound every 1/16–1/8, call and response between 2–3 patches, loud-quiet-loud inside the bar, a melodic top line, and dense, clipped midrange.

**BPM:** 150 (range 145–150). Minor key, E minor most common.

**Voice A, "Sine Comp chomp" (S1)** [INF from SRC "compressed sine bass"]
- Osc1: Sine at root +12/+24, Surge feedback 20–40%. Osc2: sine at +7 st, −6 dB (the "Sine 5th").
- Pitch env: +24 → 0 st, exponential, 25–40 ms. Amp: A 0–1 ms, R 10–20 ms.
- Chain: Distortion 24 dB → OTT 1.0 → Clipping −6 dB → HP 120 → OTT 0.5 → notch the 1–2 whistles (Q 6–10, −4..−8 dB) → level match.

**Voice B, "FM talker/growl"**
- Carrier: saw or sine at root +12. Modulator: sine at ratio 0.5 (Surge FM2: M1 = 1, M2 = 0.5).
- Numpy PM index: 1.5–3 for rasp, 4–8 for scream.
- Index driven by a step-seq LFO on 1/16 (values 0.3, 1.0, 0.6, 0.9, …).
- Vowel stage *before* distortion: Resonator on F1/F2/F3, Q 8–12, vowel stepped on 1/16 (yoi = i-o-i, wah = u-a).
- Then Distortion 18–24 dB → Phaser (1/2, fb 0.6, mix 0.5) → HP 120 → −3 dB @ 400 Hz → tame 2–5 kHz.
- Movement layers: main 1/2, syllables 1/8, bounce 1/4T.

**Voice C, "disperser machine gun"**
- A cascade of N = 16–64 2nd-order allpass biquads at f0 = 150–400 Hz, Q 0.7–4 (`lfilter` per stage). This turns a hit into a falling chirp.
- Apply it to a short saw chomp one-shot with a +12..+24 → 0 st pitch env over 20–40 ms. LP ramps 4 kHz → 300 Hz per hit.
- Retrigger at 1/16, or 1/12 (1/8T) for the off-beat feel.

**Voice D, "freq-shift dive/riser" (fills; the Echobode idea)**
- An SSB shift (`scipy.signal.hilbert`, block 64) inside a delay loop: delay 1/32 or 1/16, feedback 0.7–0.9, HP 150 Hz inside the loop.
- Shift 0 → −300..−800 Hz over 1 beat (dive), or 0 → +200..+600 Hz over 4–8 bars (riser).
- Hard-gate the tail at the next downbeat.

**Voice E, "PWM reso" (drop-2 patch family)**
- Pulse with its width LFO at 1/8, 10–50%. 24 dB ladder LP 300 Hz–2.5 kHz, resonance 60–75%, env decay 1/16.
- Then OTT 1.0 → Clip −4 dB → HP 120.

**Top line:** an arp in the key (root triad, 1/16, 2-bar cycle), sides only above 200 Hz, returning in the drop. "Essential top line" [SRC Dancing Astronaut].

**Resample (S2):**
- Print 2–4 bars each of A, B, C and E.
- Pass 2: change the modulation rhythm (vowel on 1/8 → disperser or freq-shift on 1/16).
- Chop to 1/16–1/4, keep the 8–10 most distinct, varispeed ±3 st.
- Fades 4 ms in, 8 ms out at zero crossings. HP 120 plus a fresh sine sub.
- **Never use the same shot twice in a row within a bar.**

**Bass grid (1 bar, 1/16) + drums, 150 BPM:**
```
BASS A  xxx. ..x. .... ....     (3/16 chomp on 1, stab on 7)
BASS B  .... .... .xx. x.vv     (response after snare: 10-11, 13, dive 15-16)
SUB     x--- ---. .--- ----     (held; gap at snare; kick/snare ducked)
KICK    x... .... .... ....   | bar 2: x... ..x. .... ..x.
SNARE   .... .... x... ....     (clap layer on 9)
HAT     x.x. x.x. x.x. x.x.   | bar 2: last beat xxxx (2nd layer −9 dB)
```
**Machine-gun bar:** steps 1–2 chomp; steps 3–8 six C retriggers; step 9 snare alone; steps 10–15 ratchet accelerating from 1/16 to 1/32 (8 hits); step 16 silent.

**Switch-ups (per 16):**
- Bars 1–3 pattern A.
- Bar 4: A plus a beat-4 fill (Voice D dive, or a 1/32 snare stutter).
- Bars 5–7: A′, same rhythm with a new response patch or vowel path.
- Bar 8: big switch (the second half-bar goes to the machine gun, or the §1.7 beat pause plus a vocal chop).
- Bars 9–15: new call patch.
- Bar 16: glitch edit (last 1/8 → 1/16×2 → 1/32×4 → 1/64×8 with a +12 st ramp), or a tape-stop (rate 1.0 → 0.25, exponential over the last beat).
- **Drop 2 uses a different patch family** (C + E instead of A + B) [SRC A.F.B.1. review, KAN].

**Drop entry:** 1/2–1 beat of silence plus an optional soundbyte from the source vocal. The first hit is Voice A's hardest chomp plus the impact (§1.7).

### 2.3 HALF-TIME HYBRID (Tape B-leaning, "old school x new school")
**Identity:** a bouncing, gliding, saturated 808 with trap hats over a half-time snare, the source hook kept, a sparse first drop, a busier second drop, and the 2010–12 "wah" wobble as the old-school half.

**BPM:** keep the source if it is 138–150; otherwise 145. Half-time, snare on step 9. Hats swing (54–58% on the 16th offbeats); kick, snare and 808 stay hard-quantised.

**808 (S1, numpy sine is fine, Surge optional):**
- Pitch env: +24 st (up to +36) → 0 over 80 ms (range 60–120).
- Amp for held drop notes: A 0, S 90%, R 150 ms. For trap-style one-shots: D about 3 s, S 0, R 300 ms.
- **Mono legato, with glide only when notes overlap:** 80 ms for steps of 7 st or less, 240 ms for octave slides.
  - Clamp the pitch-bend range to ±12. The current ±24 plus detection jitter gives seasick slides.
- **Saturation:** parallel Distortion 10–14 dB, 4x oversampled, then LP 400 Hz on the dirty path, mixed at 0.6. This gives laptop and phone audibility. [SRC monosounds 808, INF mapping]
- Root in C1–G1. Kick transient under 100 ms, 12–15 dB below the 808.
- Transposing 808 one-shots from the stem: stay within ±4 st.

**Wobble (old school, S1):**
- Osc1: saw at −1 oct, unison 1–2, low detune. Osc2: sine 1–2 oct down, FM to Osc1 at 25% (cap 40%).
- 24 dB ladder LP: base 200 Hz, LFO sweep 150 Hz → 1.5 kHz, resonance 30–45%.
- MSEG LFO with a slow rise and fast fall. The same LFO drives FM at 50% of the cutoff depth.
- Post: Distortion 8–14 dB, EQ −3 dB @ 3–5 kHz, −2 dB @ 300–500 Hz.

**Freeform wub / downsample (new school, drop 2):**
- Same core. LFO at 1/2 with a hand-drawn 3–4 step shape driving cutoff (250 Hz–1.2 kHz), formant and FM. Second LFO at 1/8 or 1/8T with small depth.
- `Resample(6000–11025 Hz, ZeroOrderHold)` before the distortion.
- Then the §1.2 chain with Chorus 15–25%.

**Resample (S2):**
- The test track's 808 chops **are** this style's texture (the user liked them as "trap"): slice held-808 onsets at 1/8–1/4.
- Keep slices within ±4 st of the target. Fades 5–10 ms in, 10–20 ms out.
- Re-sequence the chops as *mid-register accents* (HP 120, +12 st varispeed) over the new held 808. **Never layer the old 808's sub under the new one.**

**Grid (2 bars, 1/16):**
```
Bar 1  808   R------. ..R--~+7-.   (release at 8 → snare hits in silence; +7 glides 80 ms)
       KICK  x....... ..x.....
       SNARE ........ x.......
       HAT   x.x.x.x. x.x.x.x.     (swing 56%; drop-2: 16ths, v60-127)
Bar 2  808   R------. ....+12~R--  (octave stab 13, 240 ms glide down)
       KICK  x....... ......x.
       SNARE ........ x......g     (step 16 ghost v0.6)
       HAT   8ths, last beat = 1/32 roll (8 hits, v60→127, +2..+5 st) or 1/16T (6 hits)
```

**Wobble LFO-rate grid (drop 1, retrigger per note, at most 3 rates per bar):**
- Bar 1: steps 1–8 at 1/8 | rest on 9 | 10–12 at 1/16T | 13–16 at 1/4.
- Bar 2: 1–8 at 1/4T | 9–12 at 1/8 | 13–16 rest plus a vocal chop.

**Switch-ups:**
- Drop 1 is sparse: wobble plus a clean sine sub, swung 8th hats, one vocal chop every 4 bars, and 808 slides only in bar 4 of each phrase.
- Drop 2 alternates every bar: [wobble/wub] then [808 + trap rolls + chop]. Bars 9–16 swap the wobble for the downsample wub.
- Tag chops of 1–3 syllables (from the source vocal) on step 13 of bars 4 and 8, and in the pre-drop gap. This is the fragmented-tag idea.

**Drop entry:** 1 beat of silence holding one vocal chop, then the 808's longest note plus the kick plus the impact.

### 2.4 808 VIP
**Identity:** the source's own held 808 made enormous and bouncing, with tearout growl switch-ups as punctuation. This is the "cool for a few seconds" idea, fixed with variation and space.

It is covered by the **headline recipe** below. The difference is that the VIP uses the source's 808 *pattern and notes* (quantised, §2.5), while the headline adds more designed-growl bars. Its rules:
- One owner of the low end at a time. When growls play, the 808 either holds underneath (−3 dB, mono) or rests.
- Something changes every 4 bars, with a big switch every 8.
- **Never loop 1 bar for more than 4 bars.**

### 2.5 HEADLINE: Tape B hybrid 808 × tearout growls (the test track's dream remix)
**Premise:** the source is pure sub/808 with no growls (growl band about −28 dB). Keep and exaggerate its 808 (glides, swing, saturation). Put designed tearout growls on top as call and response with the 808.

**BPM:** keep the source's (138–150), half-time.

**Bass DNA → 808 conversion (S2):**
1. Quantise note starts to 1/16, minimum length 1/16. Merge same-pitch neighbours into legato.
2. Snap pitches to the key scale within one octave of the root. Force the root into C1–G1.
3. **Keep the multi-second held notes** (user rule 1). Split a held note only at bar lines, and only when the §1.4 snare window needs it.
4. Add glides only where the source had one or where the template below marks `~`.

**Growls (S1):** Voice A chomp, Voice B FM/vowel talker and Voice C disperser from §2.2, printed and resampled per §2.2.

**Phrase template (4 bars, repeated with variation over a 16-bar drop):**
```
Bar 1 (808 CALL):   808 held root, bounce as §2.3 bar 1, trap hats 8ths swung, NO growl
Bar 2 (GROWL RESPONSE): 808 holds root under (−3 dB) or rests;
                    growls on steps 10-16 only:  .... .... .xx. x.vv  (B then A, dive on 15-16)
Bar 3 (808 CALL′):  §2.3 bar 2 (octave stab + glide), 1/32 hat roll last beat
Bar 4 (GROWL SWITCH): full-bar growl: A chomp 1-3, C machine-gun 3-8, snare alone 9,
                    B talker 10-14, freq-shift dive (Voice D) 15-16 → next bar-1 downbeat
Kick/snare constant: kick 1 (+11 in bar 1, +15 in bar 2), snare 9 on every bar.
```

**16-bar drop:**
- Bars 1–4: the template.
- Bars 5–8: the template with a new growl vowel path and the 808 +12 stab. Bar 8 ends with the **beat pause** (1 beat out, vocal chop).
- Bars 9–12: role swap. The growl calls on beats 1–2 and the 808 answers on beats 3–4, with the growl patch family switched to C + E.
- Bars 13–16: the 808 alone for 2 bars (held, maximum saturation, double-time hat rolls), then 2 bars of growl machine gun. Bar 16 is a tape-stop into the next section.

**Form (user rule 2):**
- Original intro and build (source stems).
- The original **pre-drop hook**, verbatim.
- A **4-bar breakdown** (hook chords, LP 400 Hz, filtered hat, no bass). Optional for this style.
- A 1-beat gap.
- **NEW DROP** (the 16 bars above).
- Break: 8 bars of the source vocal over 808 and trap hats, hip-hop feel.
- Build 2: 8 bars.
- Drop 2: 16 bars. Denser: every bar alternates 808 and growl, and hat rolls every 2 bars.
- Outro: 8 bars of drums plus sub, so the DJ can mix out.

**First hit (user rule 4):** the 808's longest held note with the full pitch-env click (+36 st), the impact and the crash, with no kick duck on that note. Growls stay out until bar 2, so the 808 owns the moment.

**Sub/mid balance targets:**
- 808 bars: sub-dominant. Mid (150 Hz–4 kHz) sits 6–10 dB under the sub band.
- Growl bars: mid within 0–4 dB of the sub band. [INF; calibrate against references]

---

## 3. Drums

### 3.1 Kit mapping (TR-808 CC0 plus synthesized layers)
| Voice | Build | Level (peak, rel. kick) |
|---|---|---|
| **Kick body** | synthesized sine, pitch 150 → 52 Hz (τ 25 ms; end on the root if it falls in 45–60 Hz), decay 220 ms, fade to 0 by 300 ms, HP 30 Hz | 0 dB |
| **Kick click** | 808 kick top or a noise burst, HP 2 kHz, 8–15 ms, −8 dB under the body; transient +3..+6 dB; Limiter −2 dB | – |
| **Ghost kick** | the same kick on step 9 | −9 dB (knob −8..−10) |
| **Snare L1 body** | 808 snare or noise + a 185 Hz tone, decay 120–180 ms, +2..+3 dB @ 200 Hz, HP 120 Hz | −3 dB in the stack |
| **Snare L2 crack** | noise BP 1–5 kHz, 10–20 ms, transient +3..+6 dB | |
| **Snare L3 clap** (the lead in riddim and tearout) | 808 clap or 3 noise bursts 10 ms apart, BP 1.2 kHz, HP 500 Hz; own reverb (wet 0.35, room about 0.55 ≈ 0.9 s, 15 ms pre-delay by zero-padding, wet HP 600 Hz / LP 12 kHz) | 0 dB in the stack |
| **Snare L4 tail** | white noise HP 2 kHz; tail A 180 ms and tail B 300 ms (or +2 st), alternating on every 2nd hit | −12 dB |
| **Snare stack total** | | −0.7 dB |
| **Closed hat** | 808 CH or noise HP 7 kHz, 60–100 ms, bus HP 500 Hz, pan ±15% | −6.8 dB; accents v0.62, ghosts v0.47 |
| **Open hat** | 808 OH | −10.3 dB |

- Tape B/UK snares: put the clap −8 dB under the snare, tuned −1 st.
- **Drop the stem band-split drums in `flip.py`.** Use the source stem snare at most as a −6 dB body layer.

### 3.2 Buses
- **Per-voice:** EQ → transient → clip. Kick clip 3–6 dB, snare 4–8 dB, 4x oversampled.
- **Drum bus:** glue Compressor (4:1, 10 ms attack, 100 ms release, about 2 dB GR) plus a parallel crush (8:1, 1 ms, 60 ms, 8–10 dB GR) at 25% → clip 1–3 dB.
- **Result:** the snare is the highest peak in the drop, and the kick peaks 1–3 dB over the bass bus.
- Clipping snares is disputed on forums, so keep it a knob. **Never clip the sub.**

### 3.3 Fills
- **Every 4th bar:** beat 4 becomes snare 16ths at v 0.5, 0.6, 0.75, 0.9, or a 1/32 hat roll.
- **Every 8th bar:** snare 16ths on steps 11–16, v 0.5 → 1.0, pitch 0 → +5 st. Alternatives: "ratatat" (rests on 12 and 14), or the §1.7 beat pause.

### 3.4 Build roll (8 bars; double every length for 16)
- **Hits per beat by bar:** 1, 1, 1, 1, 2, 2, 4, 8. Bar 8 plays 32nds on beats 1–3 only; beat 4 is the gap.
- **Velocity:** −18 → 0 dB rising in dB, ±5% random per hit.
- **Pitch:** 0 st to bar 4, +7 by bar 7, +12 by bar 8. Sources only say "slight"; +5 is the safe knob.
- **Filter:** LP 1 kHz → open, plus HP 150 Hz.
- **Sends:** reverb 10 → 40%, cut at the gap.
- **Kick:** a kick on every beat in bars 5–8 with its highs filtered off. Riddim adds a clap on every beat.
- **Risers:** 4–6 dB under the drop.
- **Remix builds:** the user wants the *original* build, so apply only the gap, cue and impact on top of it.

---

## 4. Arrangement template for a remixed drop

### 16 bars
| Bars | Content |
|---|---|
| gap | 1 beat of silence plus a vocal/soundbyte cue (1 bar for a fake-out) |
| 1 | **Hardest hit**: impact + crash + reverse cymbal + longest bass note, no duck on the first hit |
| 1–4 | Pattern A (call/response) |
| 4 b4 | Fill (freq-shift dive, snare 16ths or scratch) |
| 5–7 | A′: same rhythm, new response patch or vowel, or B pitch +5/+7 |
| 8 | Big switch: machine gun, triplet ratchet or techno bar; ends with the **beat pause** (½–2 beats) |
| 9–12 | Pattern B: new call patch, resample shots |
| 13–15 | Switch state (style-specific) |
| 16 | Glitch stutter or tape-stop, then a gap or straight into the next section |

### 32 bars
- **Bars 1–16:** as above.
- **Bars 17–32:** the same drum grid with the **patch families swapped** and the voice roles inverted (who calls, who answers). Add the bar-2 kick variation from bar 17.
- A second beat pause at bar 24. Bar 32 goes into the breakdown.
- **Keep everything on 8/16-bar phrase lines** that match the original's beat grid and phrasing (so CDJ doubles lock), with drops on the original's drop bars.

### Whole VIP (user rule 2)
Original intro 16–32 → original build → **original pre-drop hook** → **4-bar quick breakdown** (optional for the hybrid) → gap → **NEW DROP 1** (16–32) → breakdown 8–16 (source melodics, 8–10 LU down) → build 8 → gap → **DROP 2** (different patch family) → outro 8–16 of drums plus sub.

---

## 5. Objective checks (add to `scripts/remix_qa.py`)

All windows are measured on the render and, where noted, on the original's drop. Status markers: ✅ = the number is well sourced; ~ = inference, calibrate it against the original and user verdicts.

| Check | How | Target |
|---|---|---|
| Drop short-term LUFS max | 3 s window, BS.1770 | **−7.0 ±0.5** ✅ user |
| True peak | 4x oversampled | **≤ −1.0 dBTP** ✅ |
| Master limiter GR on drop | log from the limiter | ≤ 3 dB ~ |
| Build vs drop | short-term mean, last 4 build bars vs drop | drop +4..+6 LU ✅ |
| Intro/breakdown vs drop | same | −8..−10 LU ~ |
| Pre-drop gap | RMS in the last beat before the drop (excluding the vocal cue band 300 Hz–4 kHz if a cue is present) | ≥ 1/2 beat at ≤ −40 dBFS, full band ~ |
| Drop attack | fade-in on drop beat 1 | ≤ 7 ms (1/64 beat); onset within ±5 ms of the grid ✅ (existing) |
| **First hit is hardest** | peak and 100 ms RMS of the bass bus (sub + mid) on drop beat 1 vs every other beat in the drop | beat 1 ≥ max(others) + 0.5 dB ~ |
| Grid alignment | bass/drum onsets vs the 1/16 or 1/8T grid | 95% within ±5 ms; drop on the original's drop bar (0 bars late) ✅ |
| Sub mono | L/R correlation, LR4 LP 120 Hz | ≥ +0.95 ✅ |
| Sub purity | in the sub bus, energy above 3× f0 vs the fundamental | ≤ −25 dB ~ |
| Sub band level | 30–90 Hz RMS vs the original drop | ±1 dB ~ |
| Sub/mid ratio | RMS 30–120 Hz vs 150 Hz–4 kHz in the drop | Tearout/riddim growl bars: mid −4..+2 dB rel. sub. Hybrid 808 bars: mid −10..−6 dB ~ |
| Mid-bass crest | peak − RMS of the mid bus (150 Hz–4 kHz) over the drop | **6–10 dB** (≤ 8 for tearout/riddim) ~ |
| Mid-bass correlation | 150 Hz–1 kHz | ≥ +0.5 ~ |
| Resonance whistle | 1/3-octave bands 1–5 kHz, long-term | no band > 6 dB above the mean of its neighbours ✅ (derived from tracksensei) |
| Snare is top peak | peak on step-9 windows vs the drop max | the snare window contains the drop's max peak in ≥ 75% of bars ~ |
| Snare window clear | mid-bass onsets within ±1/16 of each snare | 0 ✅ |
| Onset density per bar (bass) | onsets per bar in the drop | riddim 4–9, tearout 6–14, hybrid 3–8 ~ |
| Timbre movement | spectral centroid of the mid bus in 1/16 frames; std within each beat | tearout ≥ 300 Hz; riddim ≥ 150 Hz; also ≥ 3 distinct centroid clusters per 4 bars ~ |
| Novelty | cosine similarity of 4-bar chroma+MFCC blocks in the drop | no two *consecutive* 4-bar blocks > 0.97, and 8-bar halves differ ~ |
| Held weight | longest sub/808 note per 4-bar phrase | ≥ 1 bar ✅ user |
| Beat pause present | a ≥ 1/2-beat window at ≤ −30 dBFS inside the drop | 1 per 16 bars (at most 2 per 32) ✅ user |
| Clicks | existing detector on the edges of every slice | 0 ✅ (existing; don't flag a buzzy bass's own edges) |
| Drum loudness | kit LUFS vs the original drum stem over the same bars | ±1 LU ✅ (review) |

---

## 6. Implementation list (ordered by impact)

| # | Owner | What | Why |
|---|---|---|---|
| 1 | S1 | **Split sub from mid everywhere.** Add a clean sine sub voice at the fundamental (root forced into C1–A1), LR4 at 120 Hz; remove the sub from `render_groove`'s tanh and from foxsynth's pre-drive `sub_octave`; fix the width layer's LP → HP 150 Hz. | Cause #1 of the mud; fixes the 20–25 Hz subs |
| 2 | S1 | **numpy OTT** (§1.3) plus a **4x oversampled** Distortion/Clipping wrapper, and the §1.2 chain as one function `midbus(x, preset)` | Density and crest factor; stops aliasing fizz |
| 3 | S2 | **Fix the one-bar-late groove bug**, drop fade-in ≤ 7 ms, 1-beat pre-drop gap, impact stack, and the **first-hit-hardest** rule | The drop is the product; user rule 4 |
| 4 | S2 | **Sidechain as envelopes** (§1.4) plus the snare no-onset window; remove the old baked-in pump | The snare never lands today |
| 5 | S1 | **Designed voices:** tearout A (chomp), B (FM + stepped vowel), C (disperser), D (freq-shift feedback), E (PWM reso); riddim R1 (square-FM + comb), R2 (formant); wobble and downsample wub; the 808 with pitch env, overlap-only glide (±12 range) and parallel saturation | Replaces the 2010 LP-sweep patches; tearout growls were "awful" |
| 6 | S2 | **Resample engine:** print → second pass with a new mod rhythm → chop at zero crossings → pick distinct shots by centroid/contour → varispeed repitch → never repeat a shot in a row; stem slices from bass + other, with bleed rejection, HP 120 and re-sub | Movement and a "produced" sound |
| 7 | S2 | **Pattern engine:** the §2 grids as data (16-step and 12-slot), a switch-up scheduler (4/8/16 cadence), beat pause, fills, glitch/tape-stop, and patch-family swap for drop 2 | Cures "cool for a few seconds" |
| 8 | S2 | **Headline hybrid recipe (§2.5):** Bass DNA → quantised held-808 converter, 808/growl call/response template, VIP form (original build → pre-drop hook → 4-bar breakdown → new drop) | The user's dream remix |
| 9 | S2 | **Drums rebuild:** the §3 kit (2-layer kick, 4-layer clap-led snare with alternating tails, ghost kick), riddim hats fixed (offbeat 8ths, no carpet), 2-bar variation, build rolls, drum bus clip/parallel, kit loudness-matched to the source | Weak drums and the machine-gun riddim |
| 10 | S2 | **Tempo:** honour `tempo_ratio` (half/double time at ×1.0), re-trigger drums and one-shots, Rubber Band for sustained stems only, ±10% cap | Transient smear, chipmunked vocals |
| 11 | S2 | **Master:** confirm the chain at −7 LUFS short-term / −1 dBTP with ≤ 3 dB GR; move loudness into the buses | Club-safe with no pumping |
| 12 | S2 | **QA additions (§5):** first-hit, snare window, crest, timbre movement, novelty, held-weight and beat-pause checks, and a scorecard per render | Catch "awful" before the user hears it |
| 13 | S1 | Ear-candy generator (8-bit arp, power-up, coin in the key) and top-line arp | LEVEL UP and Subtronics hooks; low priority |

---

## Sources
- MusicTech, Subtronics interview: https://musictech.com/features/interviews/subtronics-interview-fibonacci-studio-monitors/
- Dancing Astronaut, Scream Saver breakdown: https://dancingastronaut.com/2020/04/subtronics-breaks-down-his-hardest-hitting-project-yet-scream-saver-ep-interview/
- WeRaveYou, Subtronics plugins: https://weraveyou.com/2021/01/list-of-plugins-currently-used-by-subtronics/
- This Song Is Sick, Subtronics studio (seen via snippets only): https://thissongissick.com/post/9-things-youll-find-in-subtronics-studio/
- EDM.com, Subtronics on bass music (snippets only): https://edm.com/interviews/subtronics-on-bass-music/
- EDM.com, A.F.B.1. review: https://edm.com/music-releases/subtronics-excision-afb1/
- Mixgraph, Subtronics: https://www.mixgraph.io/artists/subtronics
- Mixgraph, Tape B: https://www.mixgraph.io/artists/tape-b
- songbpm (Subtronics, LEVEL UP, Tape B): https://songbpm.com/@subtronics , https://songbpm.com/@level-up , https://songbpm.com/@tape-b
- Splice, Subtronics pack: https://splice.com/sounds/packs/splice/subtronics-pack/samples
- letsynthesize, BASSTRONICS course: https://letsynthesize.teachable.com/p/basstronics-dubstep-start-to-finish
- Conscious Electronic, LEVEL UP: https://consciouselectronic.com/2020/09/19/level-up-scared-of-the-dark-ep/
- Beatportal, LEVEL UP playlist: https://www.beatportal.com/playlists/159034-playlist-of-the-week-level-up
- Relentless Beats, LEVEL UP (2020, 2021, 2022): https://relentlessbeats.com/2020/02/dj-to-watch-level-up/ , https://relentlessbeats.com/2021/09/artist-spotlight-level-up/ , https://relentlessbeats.com/2022/09/artist-spotlight-level-up-2
- Insomniac, LEVEL UP bio: https://www.insomniac.com/music/artists/level-up/
- EDM.com, Dingus: https://edm.com/music-releases/listen-to-subtronics-wooli-and-level-ups-wonky-dubstep-banger-dingus/
- EDM.com, Sapphire Souls: https://edm.com/music-releases/level-up-sapphire-souls-ep/
- UKF, Tape B: https://ukf.com/read/in-conversation-with-tape-b/
- EDM.com, Signature Sound: https://edm.com/music-releases/tape-b-zaytoven-signature-sound/
- Relentless Beats, Tape B flips: https://relentlessbeats.com/2023/10/tape-bs-top-five-flips-that-will-leave-you-melting
- Relentless Beats, Flip It: https://relentlessbeats.com/2024/03/calm-vibes-heavy-beats-tape-bs-dubstep-mastery-shines-in-levitys-flip-it/
- Glasse Factory, Tape B: https://glassefactory.com/vibe-check-have-you-heard-the-new-tape-b/
- Deadbeats, Tape B: https://deadbeatsofficial.com/artists/tape-b
- EDMProd, riddim: https://www.edmprod.com/how-to-make-riddim/
- EDMProd, dubstep: https://www.edmprod.com/how-to-make-dubstep/
- EDMProd, OTT: https://www.edmprod.com/ott-plugin/
- EDMProd, LUFS: https://www.edmprod.com/lufs/
- EDMProd, sidechain: https://www.edmprod.com/sidechain-compression/
- EDMProd, build-ups: https://www.edmprod.com/ultimate-guide-build-ups/
- Faust OTT model (PR #257): https://github.com/grame-cncm/faustlibraries/pull/257
- monosounds, growls: https://monosounds.studio/serum-2-dubstep-growls/
- monosounds, wobble: https://monosounds.studio/wobble-bass-serum-2/
- monosounds, 808: https://monosounds.studio/serum-2-808-bass/
- monosounds, trap kit: https://monosounds.studio/trap-drum-kit/
- PresetDrive, sidechain: https://www.presetdrive.com/sidechain-compression-bass-music/
- PresetDrive, riddim guide: https://www.presetdrive.com/how-to-make-riddim-bass-in-serum-complete-sound-design-guide/
- PresetDrive, dubstep bass: https://www.presetdrive.com/dubstep-bass-serum/
- PresetDrive, OTT: https://www.presetdrive.com/ott-compression-for-bass-music-explained-the-complete-guide/
- EDMTemplates, tearout: https://edmtemplates.net/blogs/edm-templates-blog/how-to-make-tearout-dubstep-bass-in-serum-2
- EDMTemplates, riddim: https://edmtemplates.net/blogs/edm-templates-blog/how-to-make-riddim-bass-in-serum-2
- tracksensei, mixing dubstep: https://tracksensei.com/blog/how-to-mix-dubstep
- KAN Samples, arrangement: https://kansamples.com/blogs/learn/dubstep-track-arrangement
- KAN Samples, loudness: https://kansamples.com/blogs/learn/mastering-loudness-lufs-streaming
- Futureproof, mixing and mastering dubstep: https://futureproofmusicschool.com/blog/mixing-mastering-dubstep-easy
- Mastering The Mix, loudness: https://www.masteringthemix.com/pages/how-loud-should-you-master
- Black Ghost Audio, master clipping: https://www.blackghostaudio.com/blog/how-to-correctly-clip-your-master-bus
- mastrng, clipper vs limiter: https://mastrng.substack.com/p/clipper-vs-limiter
- Studio Brootle, dubstep drums: https://www.studiobrootle.com/dubstep-drum-patterns/
- Studio Brootle, trap drums: https://www.studiobrootle.com/trap-drum-patterns/
- Sound on Sound, dubstep drums: https://www.soundonsound.com/techniques/dubstep-drums
- Attack Magazine, snare rolls: https://www.attackmagazine.com/technique/tutorials/10-snare-rolls-for-the-drop/
- Attack Magazine, layering drums: https://www.attackmagazine.com/technique/tutorials/secrets-dance-music-production-layering-drums/
- Attack Magazine, 808 basslines: https://www.attackmagazine.com/technique/tutorials/creating-808-style-basslines-for-jungle-trap-and-footwork/
- MusicRadar, snare roll: https://www.musicradar.com/how-to/how-to-create-the-ultimate-snare-roll-build-up
- MusicRadar, trap hats: https://www.musicradar.com/how-to/how-to-program-mixed-resolution-trap-style-hi-hat-patterns
- LANDR, trap hats: https://blog.landr.com/trap-hats/
- howtomakeelectronicmusic, dubstep beat: https://howtomakeelectronicmusic.com/how-to-make-a-dubstep-beat/
- Unison, how to make dubstep: https://unison.audio/how-to-make-dubstep/
- note.com/soundwitches, riddim: https://note.com/soundwitches/n/nb9beca19adb2?hl=en
- note.com/soundwitches, tearout: https://note.com/soundwitches/n/n1485003dd099?hl=en
- melodigging, riddim: https://www.melodigging.com/genre/riddim-dubstep
- Wikipedia, Riddim: https://en.wikipedia.org/wiki/Riddim_(genre)
- Wikipedia, Formant: https://en.wikipedia.org/wiki/Formant
- DSF, riddim thread: https://community.dsf.ninja/t/riddim-a-type-of-dubstep-production-techniques-help-thread/12308
- dubstepforum, machine gun: https://dubstepforum.com/forum/viewtopic.php?f=8&t=261374
- dubstepforum, drum clipping: https://dubstepforum.com/forum/viewtopic.php?t=274926
- dubstepforum, sine under bass: https://www.dubstepforum.com/forum/viewtopic.php?t=197237
- dubstepforum, sidechain: https://www.dubstepforum.com/forum/viewtopic.php?t=109661
- Kilohearts Disperser: https://kilohearts.com/docs/disperser
- Echobode: https://www.kvraudio.com/product/echobode-by-sonic-charge
- Surge XT manual: https://surge-synthesizer.github.io/manual-xt/
- pedalboard reference: https://spotify.github.io/pedalboard/reference/pedalboard.html
- Slam Academy, Virtual Riot masterclass: https://slamacademy.com/blog/virtual-riot-masterclass
- BassGorilla, Snails bass tutorial: https://bassgorilla.com/serum-tutorial-snails-bass-hybrid-trap-dubstep-bass/
- Antidote Audio, yoi bass: https://www.antidoteaudio.com/how-to-create-the-yoi-dubstep-bass-in-massive
- Internal: docs/REMIX_ENGINE_REVIEW.md and engine `remix/groove.py`, `remix/flip.py`, `fvwks_synth/foxsynth.py`, `master.py`
- Not read (transcripts blocked): YouTube VR1pU44e0es, eOYx8vKcYts, masUy0z2WjQ, kaYhGOaj5BE, hyylV51BPHs, 0n22pjXFunE
