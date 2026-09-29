# FoxBox REMIX: final genre fingerprints (v1)

> **⚠ PM OVERRIDE (2026-09-29): the user corrected the breakdown rule after this was written.** "the 4 bar breakdown, remove it, I didn't mean that. Maybe 1 beat of silence."
> **There is NO breakdown.** The form is: original build → pre-drop hook → **at most ~1 beat of silence** → the drop. Wherever this document says "4-bar breakdown" or describes breakdown bars B1–B4, read it as that ≤ 1-beat silence. Everything else stands. Plan of record: `docs/REMIX_IMPLEMENTATION_PLAN.md` §7.


**For:** S2 (patterns, drums, arrangement, mix) and S3 (synth, growl and bass engines)
**Source tags:** **[P]** is the producer's own words. **[P-adj]** is a closely related producer (Infekt, Subfiltronik, DEFINITIVE, roi*). **[3P]** is a third-party guide, pack or article. **[INF]** is our own inference.
**Honesty note:** we could not read any full studio-stream transcript (YouTube transcript sites returned 403 or a CAPTCHA, and EDM.com returned 403, so part of it was read through a reader proxy or from search snippets). Interviews give us philosophy and a handful of concrete facts. The concrete numbers below are mostly [3P] or [INF] and are labelled that way. Unread primary sources are listed at the end.

---

## 0. Global rules (every style)

### User arrangement rules (these override anything below)

1. **Keep the source's weight.** The source bass is a huge held 808 or sub lasting several seconds, so every remix keeps long held low notes under the chops.
   - Our way to reconcile this with the genre research: **the SUB holds and the MIDS chop.**
   - Riddim and tearout both demand a clean, separate sub under chopped mid basses ([3P] EDMProd, Melodigging, tracksensei). The held source 808 becomes that sub layer.
2. **VIP form.** The original build, then the original **pre-drop hook**, then **~1 beat of silence (NO breakdown; user correction)**, then a **new drop**. The new drop is optional for trap-hybrid.
3. **Beat pause.** Occasionally stop the beat mid-drop for effect.
4. **First bass hit is the hardest.** The first bass hit of every drop is the loudest and fullest event in that drop.

### Grid conventions

- One 16-step row is **one bar at the track tempo**, in 16th notes.
- Half-time backbeat: kick on step 1, snare or clap on **step 9**.
- At 140 BPM:
  - 1/16 = **107 ms**
  - 1/32 = **53.6 ms**
  - 1/8 triplet = **143 ms**
- One of the research notes said 1/32 is about 107 ms. That is wrong: 107 ms is 1/16.
- Grid letters:
  - `X` = accented hit, `x` = hit, `g` = ghost (about −8 dB)
  - `=` = held from the previous hit, `-` = silence
  - `d` = hit pushed about 1/32 late, with a delay tail
  - `r` = roll, `m` = machine-gun retrigger

### Mix invariants

- Sub is a mono sine below about 100 Hz. **Never distort the sub.**
- Mid basses are high-passed at 100–150 Hz and mono below 200 Hz. Stereo width only goes on high-passed layers ([3P] tracksensei, edmtemplates).
- Duck mids **and** sub 2–4 dB to the kick **and** the snare or clap, with a fast (about 60–80 ms) release ([3P] tracksensei).
- Before the drop, kill reverb and delay returns so beat 1 lands dry ([3P] tracksensei; [P] Subtronics wants "big shock value and big contrast", Dancing Astronaut 2021).
- Every chop gets a 3–10 ms fade-out, plus a 1–2 ms fade-in unless the chop is a designed transient.
- All waveshaping and clipping is **oversampled at least 4×** (see Tearout: why ours reads wrong).

### Implementing "first hit hardest"

- The first bass event gets the full layer stack plus an impact.
- Its peak is +2 to +3 dB above every later bass hit in the drop.
- It is the longest hit in bar 1.
- Every later hit is capped below it.
- QA check: `peak(first_hit) >= max(peak(other bass hits)) + 1.5 dB`.

---

## 1. RIDDIM (Level Up + early Subtronics)

### Identity

Minimal, repetitive, wonky, dark UK-wonk descendant. One mid-range wub idea looped almost unchanged. The mid bass is the hook and the rhythm.

- Subtronics: riddim is "far more minimal, repetitive and wonky sounding" ([P] https://edm.com/interviews/subtronics-interview/).
- Subtronics: it is a "re-hashing of the wonky UK DUBSTEP vibe" ([P] https://edm.com/interviews/subtronics-on-bass-music/).
- Infekt: "Riddim gains its energy through much more of a flow" ([P-adj] https://ukf.com/read/infekts-guide-to-riddim/).
- Level Up keeps the spooky melody in the intro and build. The drop is bass only: she describes "writing eerie intros followed by super heavy drops" ([P] https://consciouselectronic.com/2020/09/19/level-up-scared-of-the-dark-ep/).
- DEFINITIVE on riddim drops: no heavy melody, vocals or chord changes ([P-adj] https://www.insomniac.com/magazine/how-to-talk-to-your-kids-about-riddim/).

### Five audible markers

1. **The kick–clap seesaw, not one big snare.**
   - Subtronics: "kicks on every quarter note and claps on the off beats" ([P] EDM.com 2020).
   - Low-passed, dull kicks: "low pass-filtered kick drums" ([P] same).
   - A quieter ghost kick under the clap gives the riddim "whack" ([3P] EDMProd).
2. **A square-based wub squashed by OTT is the lead.**
   - "Black Ice" was essentially a square wave squashed by Xfer OTT ([P] https://musictech.com/features/interviews/subtronics-interview-fibonacci-studio-monitors/).
   - His Splice pack has a Serum patch called "Good Ole Square Boi" ([P] pack).
3. **Quarter-note placement, with a few hits pushed late with delays.**
   - Subtronics calls "Blow Stuff Up" a quarter-note tune ([P] Dancing Astronaut 2020).
   - He names "off-grid delayed kind of basses" as what marks modern riddim ([P] EDM.com 2020).
4. **Space.** Real silence between wubs, plus dark atmosphere. Infekt: "there's space, there's reverb, there's atmospheres" ([P-adj] UKF).
5. **Repetition.** One 1–2 bar motif through the whole drop, varied only by pitch, delay or a single dropped hit. It is DJ-doubleable (Level Up's "tricky doubles", roi* on double drops).

### Why ours reads as TRAP, and exactly what to change

The chopped source 808 is the **lead**, and the drums are a TR-808 trap kit. Both are trap signatures.

Kai Wachi defines hybrid trap as 808s plus trap drums plus dubstep bass: "Hybrid trap is the full package, like hip-hop intro with gritty drums" ([P] https://runthetrap.com/2018/02/27/kai-wachi-interview/). So by his definition our render really is hybrid trap. That style now lives as TRAP-HYBRID. For riddim:

| Ours now (trap tell) | Change to |
|---|---|
| Chopped 808 carries the rhythm and melody | 808 becomes the **held sub only**: low-passed at 90 Hz, no glide, no audible distortion. A new **square/FM mid wub** carries the rhythm. |
| 808 pitch glides and slides | No glides. One root note per 2–4 bars. |
| Syncopated, bouncing trap kick | Kick on step 1 only, plus a ghost kick under the clap on step 9 |
| Big 808 snare on 3 | Clap on step 9 (with ghost kick). Kick is low-passed at about 3–5 kHz, so it sounds dull. |
| Hat rolls as a feature | Straight quarter or 8th hats, quiet (about −9 dB under kick and clap). A roll only as a bar-8 fill. Subtronics does include "Lex Luger-style trap high hats" in riddim ([P] EDM.com), so plain hats are allowed. Rolls as the focus are not. |
| Melodic top line in the drop | None in the drop. Melody belongs in the intro and breakdown (Level Up). A squeaky one-note top layer is fine. |
| Big riser build | Minimal breakdown: "literally only had quarter note high hats and the occasional bleeps" ([P] Subtronics, EDM.com 2020) |

### The drop, bar by bar (140 BPM)

**The 4-bar breakdown** (after the original pre-drop hook):

- **B1–B3:** Level Up-style eerie motif (music box or bleep) plus quarter-note hats. The source's held 808 rings once on B1 beat 1, filtered.
- **B4:** hats continue to beat 3. Then **silence** for the last 2 beats, with returns killed. An optional dry vocal or game chop sits in the gap.

**Bars 1–8:**

- **Bar 1 (the hardest hit):** Beat 1 is the impact. Kick, the **held sub (source root, sustained for the whole bar and longer)** and wub hit #1 land together, with the wub's full layer stack (square, FM, top squeak, +2.5 dB). The clap enters on step 9 and the wub motif plays out (call). The eerie melody is gone.
- **Bar 2:** Wub response phrase at normal level. One hit uses the `d` late-with-delay placement. The sub holds.
- **Bar 3:** Exact repeat of bar 1's phrase, but its first hit is at normal level, not the accent.
- **Bar 4:** Bar 2 with **one** change, for example the last wub up an octave. A 1/8-triplet percussion flick on the last beat.
- **Bar 5:** Repeat of bar 1 at normal level. The sub re-articulates the root (new held note).
- **Bar 6:** Repeat of bar 2.
- **Bar 7:** Repeat of bar 3 with the top squeak layer doubled (movement without changing the rhythm; Subtronics' "top squeaky layer", [P] Dancing Astronaut 2020).
- **Bar 8: beat pause.** Wub and sub hit on beat 1. Drums stop from step 5 to step 12 while the wub's delay tail and the held sub ring out alone. Steps 13–16: a triplet snare flick into bar 9.
- **Bars 9–16:** Bars 1–8 again with a single swap: either a second wub variant (vowel/formant version of the same patch) or a pitch step of a 4th. No new patch families.

### Bass sound design chain (the riddim wub, in order)

1. **Sources ([P] square core; [3P] FM, square-saw)**
   - Square wave at the mid-bass octave: the sub root +1 octave, for example sub E1 at 41 Hz and wub at E2 around 82 Hz.
   - Plus a sine FM modulator one octave down.
   - FM index 0.3 to 0.8, driven by the LFO: small FM for throat. FM maxed all the time reads as noise ([3P] edmtemplates).
   - Optional: square-saw blend at 30%.
2. **Filter movement before distortion ([3P] EDMProd: Auto Filter envelope, then distortion).**
   - Low-pass or formant filter, cutoff swept from about 250 Hz to 2.5 kHz.
   - LFO at **1/4 note** is the main rate. 1/8 for chops, 1/8T for flicks. One parameter leads.
   - Amp and cutoff share the LFO shape (saw-down or stepped).
3. **Distortion, medium (oversampled 4×).**
   - tanh or soft-clip at 9–12 dB drive.
   - Chain two mild stages rather than one maxed stage ([3P] presetdrive).
   - Keep it medium: multi-stage heavy saturation pushes riddim toward tearout ([3P] note.com).
4. **Comb or short delay for the metallic wub ([3P] DSF, Wikipedia).**
   - 1–5 ms delay, feedback 0.6–0.8, mix 25–40%.
   - Optionally modulate the delay time with the same 1/4-note LFO.
5. **Frequency shifter plus delay ([P] Subtronics studio feature: Ableton stock Frequency Shifter and Delay are "primary driving forces" of his mid sound; source is a snippet only).**
   - Frequency shift ±20–80 Hz at 20–30% mix.
6. **Flanger or phaser ([3P] Wikipedia).**
   - Rate 1/2 note, feedback 50–60%, mix 30–50%.
7. **OTT-style 3-band up/down compression ([P] "a square wave squashed by Xfer's OTT", MusicTech).**
   - Depth 30–40% ([3P] presetdrive).
   - More than that thins the bass.
8. **Clip.**
   - Soft clip the layer.
   - Subtronics clips the main bass layer very hard on purpose: "the main bass layer is clipping by 30db" ([P] Dancing Astronaut 2020). Treat that as an **optional heavy mode** (20–30 dB into an oversampled hard clip) and keep it off in the default riddim mode.
9. **EQ cleanup.**
   - High-pass at 100–120 Hz.
   - Subfiltronik writes the synth in the sub's register, then "cut the low and mids midway and put the synth on top" ([P-adj] https://djlifemag.com/2022/02/riding-the-riddim-with-subfiltronik-interview/).
   - Mono below 200 Hz.
10. **Top squeak layer (separate).** The same MIDI an octave or two up, band-passed at 2–5 kHz, about −10 dB, width allowed.
11. **Sub (separate, never distorted).**
    - Sine, from the source's held 808 low-passed at 90 Hz or regenerated at the root.
    - Held notes last at least 2 bars (user rule 1).
    - Sidechain duck −3 dB to kick and clap.
    - Optional 1/4-note amp gate at no more than 30% depth for bounce ([3P] EDMProd). Keep the held weight.

### 16-step grids (one bar at 140)

```
                 1   5   9   13
KICK   (lp'd)    X-------g-------     ghost kick −8 dB under clap
CLAP             --------X-------
HAT (−9 dB)      ----x-------x---     drop may add soft 8ths: --x---x---x---x-
PERC fill (b8)   ------------rrr-     1/8T flick only on bar 4/8
WUB bar A (call) X===x=--x=-d----     quarter-note hits, one late 'd' hit
WUB bar B (resp) x===----x=x=--x-     rests are part of the riff
SQUEAK (top)     x-------x-------     follows the wub accents
SUB              ================     held root; ducked on steps 1 and 9
```

### Tempo

- **140 BPM.** Subtronics' pack labels its "riddim_full" loop 140 ([P]). Infekt says 150 works technically but loses the riddim vibe ([P-adj]).
- If the source is 150 BPM, follow the source and play the drop half-time.

### Mistakes to avoid

- **Too many layers or ideas.** Subtronics says his own "hundreds of layers" and dramatic intros make his music NOT riddim ([P] EDM.com 2020).
- **Going harder and harder** instead of keeping the groove ([P-adj] Infekt).
- **Melody or chords in the drop** ([P-adj] DEFINITIVE).
- **Every grid line filled.** "Riddim is not about filling every grid line" ([3P] edmtemplates).
- **Robotic dead quantization.** Push 1–2 hits per bar late with a delay tail ([P] "off-grid delayed").
- **Overthinking the patch.** Of "Black Ice", Subtronics says "the idea was good, executed simply enough" ([P] MusicTech).

---

## 2. TEAROUT (Cyclops-era Subtronics + Marauda + Kai Wachi)

### Identity

Heavy half-time. Short, metallic, heavily **resampled** bass hits in call-and-response, with gaps between them. Sounds are switched one after another, never stacked. A clean sub sits underneath.

- Marauda's core method is to render a held note and then "repeat the process several times with the same FX chain" ([P] https://ukf.com/read/get-to-know-mastadon/).
- Subtronics' arrangement rule: "Loud, quiet, loud. It's just so effective." ([P] MusicTech).
- Kai Wachi's reference point for heaviness is grimy, deep weight (old Cookie Monsta), not bright screech ([P] DJ Times 2019, paraphrase).

### Five audible markers

1. **"Gun shot" stabs.** Short (80–250 ms) metallic FM bass hits with sharp attacks. They are the rhythmic backbone ([3P] Splice/Dropgun).
2. **Call and response between different sounds.** A growl call, then a gun-shot or machine-gun answer. Svdden Death describes his tearout alias VOYD as "a lot more of like a call and response" ([P-adj] Wikipedia).
3. **Machine-gun bursts.** One hit retriggered at 1/32 (53.6 ms) for half a beat to a beat, often stepping in pitch.
4. **Metallic "pan" snare on step 9**, big and cracking. The kick is punchy but **not squashed**.
5. **Evolving timbre that belongs to one family.** Each pass through the same chain makes a related variant (Marauda), so the sound keeps changing and still sounds like one track.

### Why an automated tearout first drop still sounds awful (self-critique, most likely cause first)

1. **Aliasing [INF, high confidence].** A numpy tanh or clip at 18–30 dB drive at 44.1/48 kHz folds harmonics back down as inharmonic fizz. Push it through OTT upward compression and the fizz comes forward. The fix is to oversample 4–8×, drive, low-pass, then decimate on **every** distortion and clip stage. "Clipping by 30 dB" only sounds good when it is oversampled.
2. **Stacked patches.** Several growls sum at once and become phasey mush with resonance build-up ([3P] Dubstepforum brostep tell). In tearout, sounds **switch in sequence**: at most one mid-bass sound plus one top layer at a time.
3. **Harsh 2–4 kHz resonances left in.** FM plus distortion produces fixed formant peaks. Notch them at −4 to −8 dB, Q 6–10, and add a dynamic cut of 3–4 dB ([3P] tracksensei).
4. **A sustained, LFO-wobbling patch from bar 1.** That reads as brostep mush. Tearout bar 1 is built from short hits with silence between them.
5. **Single-pass Surge renders sound synthy.** Marauda resamples several times ([P] UKF).
6. **Low end inside the mid basses, or a distorted sub.** Mud, phase cancellation against the held 808, and lost weight.
7. **Out-of-key growls.** Non-integer FM ratios on the **main** growl blur its pitch against the source's held 808. Use integer ratios (1:1, 2:1, 3:1) for pitched sounds and non-integer ratios only for the transient of a gun shot.
8. **No gaps and no dynamic contrast.** Subtronics: "you need big shock value and big contrast" ([P] Dancing Astronaut 2021).
9. **Squashed kicks.** Subtronics said his old kicks were "blown out, real squashed" on accurate monitors ([P] MusicTech).
10. **Random switch-ups with no rhythm people can learn.** Variation has to follow a repeating call-and-response skeleton.
11. **Build tails bleeding into beat 1, and drop 1 not the strongest variant.** Subtronics swapped drop order "like 8 times" ([P] Dancing Astronaut 2020). Put the best variant first.

### The drop, bar by bar (145 BPM default)

**The 4-bar breakdown:**

- **B1–B2:** filtered drums, **no sub**, mono image. Optionally the source's held 808 as a low-passed swell.
- **B3:** riser at 4–6 dB below drop level ([3P] tracksensei). Metallic snare roll in the second half.
- **B4:** hits end on beat 2. Beats 3–4 are near-silent, with returns killed. One dry pre-drop vocal shout or impact sits in the gap. Trench-leaning option: skip the riser entirely, because the surprise is the device ([P-adj] Infekt).

**Bars 1–8:**

- **Bar 1 (the hardest hit):** Beat 1 is the impact: kick, metallic snare **on step 9**, the **held sub (source root, sustained 2+ bars)** and the **HERO hit**. The hero hit is the widest and longest resampled growl (about 1.5 beats), with every generation layered, +3 dB. Then silence, then two gun shots (the call).
- **Bar 2 (response):** Gun-shot pattern, then a **machine-gun** burst on beat 3, pitch-stepped down. Then a gap.
- **Bar 3:** Call again using a **different generation** of the same growl, at normal level.
- **Bar 4:** Response with a new answer sound (scream stab or reverse percussive bass). On beat 4, a snare or metal roll into bar 5.
- **Bar 5:** The sub re-articulates its held root. Call with a second growl family (noisy or neuro).
- **Bar 6:** Response: gun shots plus machine gun, pitch-stepped up this time.
- **Bar 7:** Call: a pitch-dive growl (−12 semitones over 1 beat).
- **Bar 8: beat pause.** Beat 1 is a hit. Then drums **and** mids go to full silence for 2 beats, with only the sub tail ringing. Beat 4 brings a vinyl-spin or stutter fill into bar 9.
- **Bars 9–16:** The same 8-bar skeleton with every sound replaced by its next resample generation. Optionally a scream bass with percussion under it at bars 13–16 ([3P] letsynthesize outline). Subtronics-lane option: scatter the sounds across the spectrum until they are "dazzling", then snap back to one hit ([P] MusicTech).

### Bass sound design chains (in order)

**A. The resample engine ([P] Marauda: layered oscillators, one long held note, render, heavy effects, same chain repeated; also resynthesis and time-stretch).**

1. **Source.** A 2–4 s held note: 2–3 FM operators, carrier saw or square.
   - Pitched growl: ratio 1:1 or 2:1, FM index 1.5–4.
   - Throat: sine one octave down at 15–25% FM, which gives a rasp. 40% or more turns metallic and screamy ([3P] monosounds).
   - Wavetable or formant position LFO: 1/2 for motion, 1/8 for syllables. **Never faster than 1/16** ([3P] monosounds).
2. **Drive.** Oversampled 4× waveshaper at 12–18 dB, asymmetric for even harmonics.
3. **EQ.** High-pass 90 Hz, +3 dB bell at 1–1.5 kHz, −3 dB at about 400 Hz.
4. **Movement stage.** Frequency shift ±30–200 Hz ([P] Subtronics frequency shifter plus delay; Echobode per the [3P] We Rave You plugin list), **or** a comb at 2–8 ms with feedback 0.7, **or** a phaser at 1/2 rate, 60% feedback, 50% mix.
5. **OTT-style 3-band compression** at 40%.
6. **Hard clip.** Oversampled, 6–12 dB into the ceiling.
7. **Normalize to −1 dBFS.**
8. **Repeat steps 2–7 N = 3–5 times.** Store **every** generation: they are the variant family for bars 9–16.
9. **Second-stage mangle (pick one per generation) ([P] Marauda: Harmor resynthesis and Ableton time-stretch).**
   - A 2–4× phase-vocoder stretch (metallic smear), or
   - Pitch shift without formant correction, or
   - An STFT peak-pick, then partial-quantized resynthesis.
10. **Resonance clean-up ([3P] tracksensei).**
    - FFT-find the tallest fixed peak in 2–4 kHz and notch −4 to −8 dB at Q 6–10.
    - Dynamic cut of 3–4 dB in 2–4 kHz on the loudest frames.
    - High-pass at 120–150 Hz.
11. **Slice.** Cut into 80–250 ms one-shots at zero crossings: 1–2 ms in, 5–10 ms out. The hero hit keeps 400–700 ms.

**B. Gun shot (built from layers, [3P] Avant's "Gun Builder" structure, [INF] numbers).**

- **Layer (a):** metal transient (clang or click), 5–20 ms.
- **Layer (b):** FM burst at a non-integer ratio of 1:1.41 to 1:3.5, with the FM index decaying from high to low over 30–80 ms and the amp decaying over 80–200 ms. Run it through chain A steps 2–7 once or twice.
- **Layer (c):** short sine at the root, 60–100 ms. It is the only low content in the hit, and it is **ducked under the held sub**.
- **Machine gun:** retrigger (b) at 1/32 with pitch steps of ±1–2 semitones per repeat and a slight decay per hit.

**C. Sub.** The source's held 808 or a regenerated sine, low-passed at 90 Hz and mono. Held notes last at least 2 bars. No distortion, no chorus. Ducked 2–4 dB to kick **and** snare.

**Drums.** Kick: transient +3 to +6 dB and **no** heavy bus squash (keep the low end fast to attack and decay: Subtronics' "low-end attenuating speed", [P] MusicTech). Snare: +2–3 dB at 200 Hz, a crack at 2–5 kHz, and a metallic layer (ring-mod or struck-plate) at 20–30% ([3P] tracksensei, Splice).

### 16-step grids (one bar at 145)

```
                 1   5   9   13
KICK             X---------x-----     optional kick on step 11 for push
SNARE (metal)    --------X-------
HAT (sparse)     --x---x---x---x-     quiet 8ths; swing 55%
BASS bar1 call   H=====--s-s----s     H=hero (bar 1 of drop only; later 'G' growl)
BASS bar2 resp   s--s-s--mmmm----     m = 1/32 retrigger, pitch-stepped
BASS bar4 resp   s--s-s--S===--rr     S = scream stab, rr = roll into next bar
SUB              ================     held root, ducked on steps 1 and 9
```

**Rule:** at most **one** mid-bass voice sounding at any step. A top squeak or scream may overlap it only if it is high-passed above 1 kHz.

### Tempo

- **Default 145 BPM.** Range 140–150.
- Marauda sits mostly around 140 ([3P] SongBPM estimates). Kai Wachi's tearout is 140 ([3P] Mixgraph). Subtronics' pack labels its "death" loops 150 ([P] pack).
- Use 150 for the Subtronics lane.

### Mistakes to avoid

- Using a bass rendered once. Resample it several times ([P] Marauda).
- Stacking sounds instead of switching between them. No gaps.
- Unnotched 2–4 kHz resonance, or unoversampled distortion.
- Distortion on the sub.
- Squashed kicks ([P] Subtronics).
- Four hours on one bass. Build a small library of strong resampled hits and reuse it ([3P] EDM Templates).
- Pure aggression with no flow. Even Marauda framed his growth as keeping the heaviness while making his ideas "more flowing" ([P] UKF, paraphrase).

---

## 3. TRAP-HYBRID (Tape B direction, the one that works)

### Identity

"Old School x New School": UKF-era wobble dubstep plus nostalgic hip-hop energy, over trap and hip-hop drums, with a big held 808.

- Tape B's two rules: a fun hook, and "it has to be able to hit live" ([P] https://iedm.com/blogs/onblast-edm-blog/interview-wooli-and-tape-b-discuss-their-new-single-dopamine-future-goals-more).
- His quality test for releasing a song: "if it makes me giggle while I'm making it" ([P] https://ukf.com/read/in-conversation-with-tape-b/).
- Levity on what Tape B brings: "a little deeper and a little 'wubbier'" ([P-adj] EDM.com 2026, snippet only).

### Five audible markers

1. A TR-808 kick and a **long held 808** carrying the low end, with glides allowed.
2. Hat rolls (1/16, 1/32, 1/16T) and a half-time snare on step 9.
3. **Wobble** mid basses: LFO at 1/8 and 1/8T, old-school UKF style, bouncy rather than destroyed.
4. A vocal or tag hook (a chop from the source) placed in the gaps.
5. Gritty, slightly distorted drum bus, the hip-hop-drums element of Kai's "full package" ([P] Run The Trap).

### What could make ours read wrong

It currently works, so change little. Two risks:

1. **The 808 swallows the drums.** Kai kept the 808 very low on MUD ([P] paraphrase). Tape B wants the 808 big, so keep it big but duck it hard to the kick (−4 to −6 dB, 50 ms) so the kick transient stays on top.
2. **Riddim or tearout leaking in.** Tearout guns or the riddim seesaw would muddy the style. Keep this style's **exclusive** markers here: rolls, 808 glides, syncopated kick.

### The drop, bar by bar (source tempo; 150 ideal, 140 fine)

A new drop is **optional** (user rule 2). The default is the original drop's vocal and 808 with new drums and wobbles.

- **Breakdown B1–B4:** B1–B3 carry the source vocal hook over a filtered 808 hold. B4 ends in a hat roll plus a gap of about 1 beat, with a dry vocal tag.

**Bars 1–8:**

- **Bar 1 (the hardest hit):** 808 kick plus the **source 808 held for the full bar**, plus a wobble stab and impact, +3 dB. Snare on step 9.
- **Bar 2:** Syncopated kick. The 808 re-triggers and glides up to the 5th on step 15. Wobble answers.
- **Bar 3:** Repeat of bar 1 at normal level, with a vocal chop in the step 5–8 gap.
- **Bar 4:** Hat roll (1/32) on the last beat. 808 slides down an octave.
- **Bars 5–7:** Repeat bars 1–3, with the wobble LFO switched to 1/8T for bounce.
- **Bar 8: beat pause.** Drums cut for beats 2–3. The 808 tail and a vocal tag play alone. Snare flam into bar 9.

### Bass chain (in order)

- **808:** sine plus 2nd-harmonic saturation (tanh at 6 dB, oversampled). Glide 60–120 ms. Low-pass at 5 kHz. Mono. Held notes up to 2–4 bars ([P] user rule).
- **Wobble:**
  - Saw plus square.
  - Low-pass at 24 dB/oct, cutoff 150 Hz to 3 kHz driven by the LFO (1/8, 1/8T, 1/4). Resonance 20–30%.
  - Drive 6–9 dB.
  - OTT at 25–35%.
  - High-pass at 150 Hz.
  - Kai: Serum/Massive-style wavetables ([P] DJ Times).
- **Drum bus:** saturation at 3–6 dB (the hip-hop "gritty" element, [P] Kai), then a parallel compressor at 8:1 blended at 30%.

### 16-step grids (one bar at 150)

```
                 1   5   9   13
KICK (808)       X-----x---x--x--
SNARE            --------X-------
HAT              x-x-x-x-x-x-xrrr     rolls on step 14+ only
808              X===========--x=     held, glide into step 15
WOBBLE           --x=x---x=--x=x-
VOCAL chop       ----x---------x-     in the gaps
```

### Tempo

- 150 BPM ([3P] Mixgraph: Kai's hybrid tracks cluster at 150), or 140 half-time.
- Follow the source.

### Mistakes to avoid

- **Dubstep with 808s swapped in** instead of the full hip-hop package ([P] Kai, Run The Trap).
- **Rushing a track** ([P] Tape B, UKF).
- **Keys that don't play on club systems.** Kai names B as bad and E/F/D as the norm ([P] paraphrase). This is advisory only, because we follow the source's key.

---

## 4. Prioritized fixes

### S3: synth, growl and bass engines

1. **Oversample every nonlinearity 4× (8× for hard clip).** Shared helper: upsample, shape, low-pass, decimate. This is the main fix for the "awful" tearout.
2. **Resample-N engine.** `render_held(src, 2–4 s) -> [chain]×N`, normalizing between passes and returning **all** generations plus a mangle variant (phase-vocoder stretch 2–4× or formant-free pitch shift). Chain as in Tearout chain A.
3. **Auto resonance notch.** FFT peak-pick in 2–4 kHz, notch −4 to −8 dB at Q 6–10, dynamic cut of 3–4 dB. Apply to every growl and gun output.
4. **Tearout one-shot kit from the generations:** hero (400–700 ms), growl calls, gun shot (3-layer build), machine gun (1/32 retrigger with pitch steps), scream stab, reverse hit. Zero-crossing slicing with 1–2 ms in and 5–10 ms out.
5. **Riddim wub engine:** square plus sine FM one octave down (index 0.3–0.8 on the LFO), 1/4-note LFO on cutoff and amp, then medium 2-stage drive, 1–5 ms comb, frequency shift, flanger, OTT at 35%, soft clip, high-pass at 110 Hz. Plus a top squeak voice. Heavy mode: oversampled 20–30 dB clip on the main layer.
6. **Sub engine, separate and clean:** takes the source's held 808 (low-passed at 90 Hz) or regenerates a sine at the root. Long holds. No distortion, no width.
7. **Tuning:** pitched growls use integer FM ratios and are locked to the source key. Non-integer ratios only on transients.
8. **Kick:** keep the transient and do not bus-squash it. The riddim kick is low-passed at 3–5 kHz.

### S2: patterns, drums, arrangement, mix

1. **Split the styles.** RIDDIM loses its 808 kit, hat rolls, syncopated kick and 808-as-lead: the 808 becomes a held sub and the new wub leads. The current chopped-808 render moves to TRAP-HYBRID unchanged.
2. **VIP form everywhere:** original build, original pre-drop hook, **4-bar breakdown** (style-specific, as above), new drop (optional for trap-hybrid).
3. **First hit hardest:** full stack, +2 to +3 dB, longest hit in the drop, with a QA assert (see section 0).
4. **Beat pause:** in bar 8 (sometimes bar 12), drums (and in tearout, mids too) silent for 2 beats while the sub tail rings.
5. **Tearout sequencer:** call-and-response skeleton. **Max one mid-bass voice per step.** Gaps are mandatory. Bars 9–16 swap in the next resample generation.
6. **Riddim sequencer:** one 2-bar motif repeated, with one change per 4 bars; one `d` late-delay hit per bar; kick–clap seesaw with ghost kick.
7. **Mix bus:**
   - Sub and mids ducked to kick **and** snare/clap.
   - Mids high-passed at 100–150 Hz, mono below 200 Hz.
   - Returns killed before beat 1.
   - Riser 4–6 dB under drop level.
   - Drop 1 uses the strongest variant.
8. **Tempo per style:** riddim 140, tearout 145 (140–150), trap-hybrid follows the source (150 or 140).
9. **QA checks:**
   - Count simultaneous mid-bass voices (tearout 1 or fewer, riddim 2 or fewer counting the squeak).
   - Check first-hit peak dominance.
   - Check that no energy below 120 Hz exists in the mid stems.
   - Check that a gap of at least 1/16 of silence exists per bar in riddim and tearout.

---

**Best unread primary sources (transcribe when a route works):**

- Subtronics production stream: https://youtu.be/7jFlqzhO4ds
- Subtronics "Blow Stuff Up" tutorial stream: https://www.youtube.com/watch?v=rf_8j3jMEv4
- Mr. Bill Podcast #37 with Subtronics: https://mrbillstunes.libsyn.com/37-subtronics
- Marauda on the Filthy Beat Inspectors podcast: https://www.youtube.com/watch?v=3SkWMAcniSI

No files were written.
