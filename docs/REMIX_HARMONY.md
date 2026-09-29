# FoxBox REMIX: Harmony and Musicality (v1)

> **For:** S2 (patterns, arrangement, drums, mix) and S3 (growl and bass engines, `remix_qa.py`).
> **Why this exists:** after hearing the latest remixes, the user said they are all bad and asked us to study chord progressions. The parts they flagged are the growls and bass sound, the drums, and the arrangement and drop.
> **Scope:** this doc adds the missing layer, which is musicality: which notes play over which chords, when the chords change, and how the drums and the drop arc serve that. It does **not** repeat the patch recipes, bus chains, sidechain numbers or per-style grids in `docs/REMIX_SOUND_BIBLE.md` (SB) and `docs/REMIX_GENRE_FINGERPRINTS.md` (FP).
> **PM overrides still stand:**
> - There is no breakdown. The form is the pre-drop hook, then at most 1 beat of silence, then the drop.
> - The 808's first hit has a blip of at most +5–7 st and settles within 30 ms.

**Tags:** **[P]** a producer's own words · **[P-adj]** a closely related producer (as in FP) · **[3P]** a tutorial, article, paper or dataset · **[INF]** our inference, a starting knob to calibrate with `remix_qa.py` and the user's ears · **[SB]/[FP]** our own docs. Handles such as `[3P KAN]` point to the Sources list.

**Notation:**
- **Chords** are Roman numerals relative to the minor tonic, in semitones above it: i=0 (minor), bII=1 (major), III=3 (major), iv=5 (minor), v=7 (minor), V=7 (major, from harmonic minor), VI=8 (major), VII=10 (major). A trailing `5` means a power chord (root and 5th only).
- **Bass degrees** are relative to the **current chord's root**: R=0, b2=+1, 3=+3 on a minor chord or +4 on a major one, b5=+6, 5=+7, b7=+10, 8=+12. `-5` is the 5th an octave down (−5 st), `-8` and `R-12` the root an octave down. `>` means a glide to the next note.
- **Grid** as in SB: 16 steps a bar, the snare on step 9 (beat 2.0 when beats count from 0), and the 12-slot 1/8T grid.

---

## TL;DR: the 10 changes most likely to stop the remixes sounding "bad"

1. **Take the harmony from the source; supply the rhythm and sound ourselves.**
   - Build a chord track per half-bar (root plus quality) from the stems (§6), then a 16-bar **harmonic plan** per drop (§1.5), and pick every generated note relative to the chord playing at that moment.
   - Today one `root_pc` covers a whole clip with fixed steps {0, 3, 5, 7}, or the transcribed line is replayed (§0): the first sounds static, the second reads as a MIDI cover. [INF]
2. **The sub and 808 play chord roots only.**
   - Riddim and tearout pedal the tonic (at most one root change per 4–8 bars); trap-hybrid and melodic sections follow the loop's roots at 1–2 bars a chord.
   - The sub never follows the mid's passing notes; today the resample path's `sub_line` jumps to every hit's note. [3P 808 guides, KAN; INF]
3. **Choose mid-bass notes by beat position.**
   - Chord tones (R, 5, 8, and b7 over minor chords) on strong steps; b2 and b5 only as ≤ 1/8 pickups that resolve to R on the next strong step.
   - Glides start and land on chord tones, and no 3rds sit inside a distorted layer. [3P EDMProd melody, HMT, Disc Makers; INF]
4. **Tune everything to the track.**
   - Estimate the source's tuning offset in cents and apply it to every synth voice, one-shot repitch, kick and snare. Today everything is A=440 equal temperament, and `_near()` throws away the fractional tuning `groove.py` measured.
   - Key-track combs and resonators to the note's harmonics; frequency-shift only by multiples of f0/2, or only on transients. [3P Dressler, Lerch, comb and frequency-shift sources; INF]
5. **Land the drop on the source drop's own root, which is almost always i.**
   - The pre-drop hook is verbatim, so read the chord it ends on: a "question" chord (V/v, VII, VI or iv) resolves on our first hit.
   - Withhold the root through the gap, and make the gap's vocal cue a chord tone of the first drop chord. [3P Black Rooster, EDMProd tension; INF]
6. **Give each style a harmonic arc (§5.3).**
   - Riddim: pedal on i with one lift (iv or VI) or a bII tension bar at bars 8 and 16. Tearout: pedal on i with turnaround roots (VI–VII, bII or V) in bars 7–8 and 15–16.
   - Trap-hybrid loops the hook's own chords; melodic moments use i–VI–III–VII, VI–VII–i or VI–iv–i at 2 bars a chord. [3P Hooktheory, Melodigging, soundwitches; FP; INF]
7. **Put one in-key hook on top.**
   - A 1-bar motif (chord tones on strong steps, 60–80% stepwise, 2–3 rhythm cells) sequenced through the chords as A A′ A B, with pitches from the source hook where possible.
   - Riddim gets a squeak on R and 5 only; trap-hybrid gets source vocal chops chosen by pitch class. [3P EDMProd, shedthemusic, Hooktheory; P Subtronics; INF]
8. **Drums that are in tune and alive.**
   - The kick ends on the tonic (or its 5th) and is 30 dB down by 150 ms whenever the sub is on another root; the snare's tone sits on R or 5 nearest 200 Hz.
   - 5–7 round-robin variants, velocity driving timbre, an accent map per voice, and a CC0 acoustic transient under the synth snare.
   - Kick and snare stay on the grid and swing goes on hats only: listeners rate quantized drums best and early hits worst. [3P MusicRadar, Frühauf 2013, Davies 2013, Unison; INF]
9. **Build the drop from 4-bar "weapons"** (call, response, escalate, reset).
   - Bars 9–16 switch patch family and, by style, the harmony; tension notes and turnaround roots go in bars 7–8 and 15–16; bar 9 is a second "first hit" at −1 dB. [3P EDMTemplates, KAN, Solberg 2014; P Subtronics; INF]
10. **Add harmonic QA to `remix_qa`** (§6.6): chord-tone share ≥ 85%, sub on the planned root 100%, out-of-key energy ≤ 15%, tuning within ±5 cents of the source, and no kick/sub beating. [INF]

---

## 0. What the engine does today (read from `help/s2-bassdna` 30c2bc3) [INF: code reading]

- **One root for the whole clip.** `remix/resample.py: root_pc()` is the pitch class the source bass spends the most time on, and it is used for the entire clip. `sequence()` places the shots at fixed scale steps {0, 3, 5, 7} (R, b3, 4, 5; the `RIDDIM`/`HALFTIME`/`TEAROUT` tables) above that root, whatever the source chords do.
  - The 4th (+5) lands on beat 2 as a half-beat note, which makes it a strong-beat non-chord tone.
- **The sub follows the mids.** `sub_line(hits)` puts a sine under every hit "at the hit's note", so on the resample path the sub follows the mid's b3, 4 and 5 responses. The riddim path holds one root and re-strikes it every 2 bars, which is right, but it never moves.
- **Tuning is thrown away.** `_near()` snaps shot pitches to A=440 equal temperament; designed shots are built at `12*(octave+1)+root_pc`, and the 808 and sub use `440*2**((m-69)/12)`. `groove.py` keeps "the track's tuning" as fractional MIDI, but the resequencer rounds it off.
  - A source tuned at 432 Hz (−31.8 cents) therefore gets a new bass 32 cents out against its own kept stems: 1.7 Hz of beating on a 90 Hz mid fundamental and about 13 Hz of roughness at its 8th partial.
- **Drums are untuned.** In `fvwks_synth/drums.py` the kick sweeps 150 → 52 Hz and only ends on the root when the root falls in 45–60 Hz (52 Hz against an F#1 sub at 46.2 Hz beats at 5.8 Hz), and the snare's tone is fixed at 185 Hz (F#3) in every key.
  - Per-hit jitter (±15 cents, ±6% decay) is already in place, which is good. The kits are CC0 TR-808 samples plus synthesized layers.

---

## 1. Harmony

### 1.1 What the genres use (evidence)

| Finding | Detail | Tag |
|---|---|---|
| EDM is mostly minor | 84.8% of 604 GiantSteps EDM excerpts are minor; the commonest keys are Fm, Cm and Gm | [3P Knees 2015] |
| Bass-music transcriptions are minor or Dorian | 13 of the 13 below | [3P Hooktheory] |
| Chord palette (13 bass-music tracks) | i in 13, VI in 11, III in 9, VII in 8, iv in 7, v in 7, vii° in 2, bII in 1, Dorian IV in 1 | [3P Hooktheory; the count is INF] |
| DnB/dubstep harmony is sparse | 2–4 chords in total, each held 2–4 bars; complex progressions dilute the rhythmic focus | [3P KAN chords] |
| Drops mostly sit on one note | Usually one bass note played over and over with effect automation, and the notes must still relate to the chords | [3P DSF 280452] |
| Riddim | Harmony is kept to a tonal centre or a few notes; chords are restrained or left out; the motif varies within one key with no modulation | [3P Melodigging riddim, soundwitches]; [P-adj DEFINITIVE via FP] |
| Tearout | Harmony is kept to "single-note pedal tones, fifths, or ominous minor intervals"; pitch moves in semitone or whole-tone steps | [3P Melodigging tearout, soundwitches] |
| Hybrid trap | Sparse minor or modal harmony (Aeolian, Phrygian) or pedal tones; short hooks go between bass phrases | [3P Melodigging hybrid] |
| Future/melodic riddim, colour bass | Minor keys with 7ths, 9ths and sus chords. Colour bass plays m7/maj7 chords in the bass register over a separate clean sub; its progressions are i–VI–III–VII and i–iv–VI–V | [3P Melodigging future riddim, PresetDrive colour] |
| Melodic dubstep drop | Built from a "chord bass" and a sub, with growls placed between chord changes | [3P WA Production] |
| Darkness devices | Phrygian (the root followed by the note above it), harmonic minor, chromatic lines | [3P DSF 81444, experienced posters] |
| Tension intervals | Both b2 and b5 appear in Locrian bass lines; the b5 is the "blue note" in blues-scale drops | [3P HMT] |
| Keys that hit | Subs sound best between about low D and low A (E, F and F# are common); Kai Wachi names B as a bad key | [3P KVR 498277]; [P Kai via FP] |
| Trap loops | i; i–iv; i–VI–VII; i–VII–VI; i–VI–V (harmonic minor); bII–i (Phrygian) | [3P Motifkit] |
| What makes a drop a climax | Drops peak in loudness and density; harmony is not what marks the section | [3P Osborn 2023] |

**Hooktheory mini-corpus.** These are crowd-sourced transcriptions, with section names as the site labels them.

| Track (key, BPM) | Progressions |
|---|---|
| Skrillex – Scary Monsters and Nice Sprites (Gm 140) | pre-chorus VI–VII–i–VII; outro VI–VII–i–v |
| Skrillex – Breakn' A Sweat (Em 140) | verse on i (a pedal); pre-chorus VI–VII–VI–i |
| Zomboy – Game Time (Fm 140) | intro VI7–i7–VII–iv9–v |
| Flux Pavilion – Emotional (Bm 148) | intro i–iv7–VI–VII; verse i–VI–VII; chorus i–III–iv–VI–VII |
| Virtual Riot – Chroma (Em 150) | verse VI–v–i–III–VII (all voiced without 3rds); chorus i7(no3)–i9(no3)–i7(no3)–III7–iv(add11) |
| Virtual Riot – Simulation (D#m 145) | chorus i9–**bII9**–i9–III9–VII(add9) |
| Virtual Riot – Different World (Gm 145) | chorus i7–VI–III7–iv7–v7 |
| Virtual Riot – Dream Logic (D#m 150) | chorus i9–VI(add9)–iv–VI9–III(add9) |
| Virtual Riot – Energy Drink (Gm 128) | chorus v–VI–III–vii°6–i |
| Seven Lions – Nepenthe (Bm 140) | chorus VI–iv–i |
| Seven Lions – ID (Am 140) | i–VI–iv (the site lists 966+ songs sharing it) |
| Seven Lions – Below Us (G#m 144) | chorus III7–v–i–III7–VI7 |
| Seven Lions – Days to Come (F Dorian 140) | chorus III–v7–IV–i |

- The same pages report melodies that are 94–100% diatonic, 51–94% chord tones and mostly stepwise. [3P]
- **Reading:** the palette is natural minor (i, iv, v, III, VI, VII) plus an occasional Phrygian bII or raised-7th dominant; 3rd-less voicings are common under heavy sound design. VI is the commonest move away from i, and VI–VII the commonest adjacent pair (4 tracks). [INF from the table]

### 1.2 Harmonic rhythm: how often the root changes

| Section | Riddim | Tearout | Trap-hybrid (Tape B) | Melodic moment |
|---|---|---|---|---|
| Intro and break (source stems) | the source's chords, untouched | same | same | same |
| Build and pre-drop hook (verbatim) | we only **read** it (§1.3) | same | same | same |
| Drop bars 1–8 | i pedal: 0 changes | i pedal plus one turnaround root in bars 7–8 | the hook loop at 1 chord per 1–2 bars | the loop at 1 chord per 2 bars (1 per bar if the loop is 4 bars long) |
| Drop bars 9–16 | i, or one lift (iv or VI) for 4–8 bars | i with a new patch family; turnaround in bars 15–16 | the same loop, varied | the same loop |
| Most root changes per 16 bars | 2 | 4 | 16 | 8 |

- Sources: KAN (2–4 bars a chord) [3P]; trance loops at 1–2 bars a chord [3P Conklin/MDPI]; riddim with no chord changes [P-adj] and restrained chords [3P]; for trap, "Harmony's job is to sit still" [3P Motifkit].
- The number in each cell is [INF].

### 1.3 Tying the drop to the intro, build and vocal

1. **One tonic and one tuning for the whole remix.**
   - Use the source key (`song.py`) and the tuning offset (§6.1) [INF]; never modulate a riddim drop [3P soundwitches].
2. **Drop bar 1's root = the original drop's bar-1 root**, read from the source drop's bass (§6.5). In EDM this is nearly always i. [INF]
3. **Read the last chord of the pre-drop hook.**
   - If it is a question chord (V/v, VII, VI or iv), our first hit on i resolves it. Producers "park" on that chord for the last bar or two [3P Black Rooster], and a dominant build resolves at the drop [3P EDMProd tension].
   - If the hook already ends on i, the first hit restates i, so lean harder on the SB §1.7 impact stack.
4. **Withhold the root.** If the source bass has already stopped, keep the sub silent through the gap and make the drop's first sub note the root. Planting the root at the arrival and releasing the pedal on the downbeat are standard devices. [3P Black Rooster, EDMProd tension]
5. **The gap cue (≤ 1 beat)** is a vocal chop whose pitch class is a chord tone of the first drop chord (R, b3 or 5), or a 2 or b7 that resolves into it by a step. [INF]
6. **Borrow the hook.**
   - Producers tie builds to drops by moving a drop element into the build [3P Cymatics]. Our build is verbatim, so we do the reverse: build the drop's top motif from the source hook's pitch classes (§3.2). [INF]
   - EDM drops often replace the vocal chorus with a synth or vocal-chop hook [3P Osborn; search summary].
7. **Vocal chops over the drop.**
   - Take a chop from a source bar whose chord matches the plan's current chord.
   - Otherwise, varispeed it by at most ±2 st to the nearest chord tone, or alternate it by ±12 [3P MusicTech pitched chops; INF].
8. **A pedal under a moving top.**
   - In riddim and tearout, the top layer (squeak, arp or chop) may outline the source loop's chords (VI, VII and so on) over the i pedal. That is pedal-point tension, and it resolves when the top comes home at bar 9. [3P EDMProd tension, pedal-point sources; INF]
   - This is how a riddim drop can carry "a progression" without breaking the genre.

### 1.4 Voicing and tuning rules for heavy sounds

- **Distorted layers** play single notes or power voicings (R + 5 + 8).
  - A 3rd inside the same nonlinearity creates intermodulation clutter, which is why guitarists use power chords [3P Disc Makers].
  - 3rds and 7ths belong in clean layers: pads, leads, and colour-bass chords over their own clean sub [3P PresetDrive].
  - A b3 on a mid-bass note is fine as a single melodic tone over the clean sub. Never sustain R and b3 together inside one distorted patch. [INF]
- **Comb filters and resonators are pitched.**
  - Set the comb delay to 1/(k·f0), with k = 1, 2, 4…, at rest, and modulate it in octaves or fifths.
  - A fixed 300–900 Hz comb (SB R1) is an out-of-key pitch unless it is key-tracked, and producers tune combs by hand for this reason [3P KVR 561477, DSF comb thread; INF].
- **Frequency shifters make partials inharmonic** [3P Unison freq-shift, Perfect Circuit].
  - On sustained notes, shift by m·f0/2 (m an integer), which keeps a harmonic series.
  - Keep arbitrary shifts (SB: ±20–200 Hz) to hits of 1/8 or shorter, and to dives. [INF]
- **High-Q vowel resonators** (Q ≥ 8) ring as pitches. Centre each one on the harmonic of f0 nearest the formant. [INF]
- **FM ratios** stay integer on pitched growls (FP §2 #7), and **808 blips** stay ≤ +5–7 st, settling on the chord root (PM override).

### 1.5 Progression templates (data)

```python
# (semitones above the tonic, quality): 'm' minor, 'M' major, '5' power (quality taken from the key)
DEGREE = {"i": (0, "m"), "bII": (1, "M"), "III": (3, "M"), "iv": (5, "m"), "v": (7, "m"),
          "V": (7, "M"), "VI": (8, "M"), "VII": (10, "M")}
# 16-bar drop plans, one symbol per bar; "x/y" = x for beats 1-2, y for beats 3-4. Weights are the seeded draw [INF].
PLANS = {
  "riddim":  [(0.50, ["i"] * 16),
              (0.25, ["i"] * 8 + ["iv"] * 4 + ["i"] * 4),                 # FP's "pitch step of a 4th"
              (0.25, ["i"] * 7 + ["i/bII"] + ["i"] * 7 + ["i/bII"])],     # a Phrygian tension bar
  "tearout": [(0.50, ["i"] * 6 + ["VI", "VII"] + ["i"] * 6 + ["VI", "VII"]),
              (0.30, ["i"] * 7 + ["i/bII"] + ["i"] * 7 + ["VI/V"]),       # V = harmonic-minor pull home
              (0.20, ["i"] * 16)],
  "trap_hybrid": "source hook loop at its own rate; fallback ['i','i','VI','VI','iv','iv','VII','VII'] * 2",
  "halftime":    "source loop; fallback ['i','i','VI','VI','VII','VII','i','i'] * 2",  # old-school wobble follows roots
  "melodic": [["i", "VI", "III", "VII"], ["VI", "VII", "i", "i"], ["VI", "iv", "i", "i"],
              ["i", "iv", "VI", "VII"], ["i", "VI", "iv", "iv"]],         # 2 bars per symbol
}
```

- The progressions are [3P Hooktheory, KAN, Unison, PresetDrive, Motifkit], and the weights and bar placement are [INF].
- **The source always wins:** if the harmonic skeleton of the source's drop or hook is detected (§6.5), style-transform it rather than drawing a template. For riddim, collapse it to a pedal on its tonic and keep its commonest other root as the lift. For tearout, keep its last two roots as the turnaround. For trap-hybrid, use it as is.

---

## 2. Bass lines over harmony

### 2.1 Which layer plays what

| Layer | Pitch rule | Tag |
|---|---|---|
| **Sub (sine) / 808** | The current chord root, held, and re-struck at chord changes and per the SB held-weight rule. In trap-hybrid, 808 bounces to 5 or 8 of ≤ 1/8 are allowed. The sub never plays the mid's passing notes. | [3P productionmusiclive, Motifkit, KAN; INF] |
| **Mid bass** (growl, wub, chop) | Degrees relative to the chord root (§2.2), at the sub note +12 (SB) | [INF] |
| **Top** | Chord tones and diatonic notes (§3) | [3P EDMProd melody] |

- The trap guides agree: the 808 mirrors each chord's root (Am–F–G–Em → A, F, G, E) [3P trap 808 guides, via a search summary; productionmusiclive], and the root sits very low, the chord tones high, with the middle left empty [3P Motifkit].

### 2.2 Degree by beat position (16-step bar, snare on step 9)

| Steps | Role | Degree weights | Tag |
|---|---|---|---|
| 1 | Downbeat anchor | R 1.0 on both sub and mid. "The downbeat note stays a plain root and never slides." | [3P Songen] |
| 5, 13 (beats 2 and 4) | Strong | R .50 · 5 .25 · 8 .20 · b7 .05 | [3P EDMProd; INF weights] |
| 3, 7, 11, 15 (8th offbeats) | Medium | R .40 · 5 .20 · 8 .20 · b7 .10 · 3 .10 | [INF] |
| 2, 4, 6, 10, 12, 14, 16 (16ths) | Weak / pickups | R .30 · 8 .20 · 5 .15 · b2 .15 · b5 .10 · b7 .10 | [3P DSF 81444, HMT; INF] |
| 8, 9 | Snare window | No mid onsets: the mid ends ≥ 1/16 before step 9 and re-enters on step 10 or later (SB §1.4) | [SB] |
| Last 2 steps of bars 4, 8, 12, 16 | Phrase end | Tension (b2, b5) or a +12 leap at double weight | [3P MusicRadar tip 13, HMT; INF] |

### 2.3 Tension notes, slides and octaves

- **Tension notes** (b2, b5, and b7 over a major chord) last ≤ 1/8 and are followed within ≤ 1/4 beat by R or 5 of the same chord, or by the next chord's root. At most 2 per bar (1 in riddim). "Dissonance is spice, not the meal." [3P Black Rooster; the numbers are INF]
- **Chromatic approach:** reach a new root from a half step above or below on the last 1/16 before the change; the major-7th leading tone only appears in plans that contain V. [INF]
- **Glides** (808 and wobble): only between chord tones or into the next root, slide to chord tones first, at most 1 per bar in drop 1 and 2 in drop 2 [3P Songen; INF].
  - A short note gets a fast glide and a long note a slow one [3P Songen]: 60–80 ms and 150–240 ms [INF]; octave slides take 240 ms and bends are clamped to ±12 [SB].
- **Octaves:** +12 at phrase ends (the last bar of a 4- or 8-bar phrase an octave up [3P MusicRadar tip 13]) and on backbeat-adjacent responses, steps 10–12 [3P HMT Locrian]. Only the mid jumps octaves, never the sub. [INF]
- **Dives and pitch gestures (tearout):** start on a chord tone (8 or 5) and end on R−12, or cut off; the −12 to −24 st ranges are in SB. [INF]
- **A veteran's block recipe:** the root 3 times then b7 (or 5) on the 4th hit, repeated for 4 bars, then the whole block moved an octave [3P DSF 204676]. Remix tips agree: keep the original's notes and add 1–2 notes, or an octave jump for half a beat [3P remix tips].

### 2.4 Pitch budgets (distinct pitch classes in the mid bass per 4-bar phrase, gestures excluded)

| Style | Pitch classes | Share of note-time on the current R | Tension notes per bar | Tag |
|---|---|---|---|---|
| Riddim | 2–3 (R, 5 or b7, and one b2/b5 accent) | ≥ 75% | ≤ 1 | [SB: ~80% tonic; 3P Melodigging; INF] |
| Tearout | 3–4 | ≥ 50% | ≤ 2 | [3P Melodigging, soundwitches; INF] |
| Trap-hybrid 808 | the loop's roots plus 5/8 bounces: 3–5 | ≥ 60% | ≤ 1 | [3P 808 guides; INF] |
| Melodic chord bass | the loop's chord tones: 4–7 | n/a | as passing tones only | [3P PresetDrive, WA; INF] |

### 2.5 Templates as data (these replace the fixed-step tables in `resample.py`)

Each hit is `(beat, beats, degree, role)`, with the degree relative to the plan's root **for that bar**. Nothing starts between beats 1.75 and 2.25. The rhythms keep the current tables' and SB's grids; the degrees follow §2.2 [INF].

```python
RIDDIM_H = [   # 2-bar call/response; one tension pickup that resolves on the next downbeat
  [(0.0, .75, "R", "call"), (1.0, 1/3, "R", "call"), (4/3, 1/3, "8", "call"),
   (2.25, 5/12, "R", "resp"), (2 + 2/3, .5, "5", "resp"), (3.5, .25, "R", "resp")],
  [(0.0, .75, "R", "call"), (1.0, .5, "b7", "call"),
   (2.25, .5, "R", "resp"), (2.75, .5, "8", "resp"), (3.5, .25, "b2", "resp")]]
TEAROUT_H = [
  [(0.0, .5, "R", "call"), (.75, .25, "R", "call"), (1.0, .5, "5", "call"), (1.5, .25, "8", "call"),
   (2.5, .25, "R", "resp"), (2.75, .25, "b2", "resp"), (3.0, .5, "R", "resp"), (3.5, .5, "8>R-12", "resp")],
  [(0.0, .25, "R", "call"), (.25, .25, "R", "call"), (.5, .25, "b5", "call"), (.75, .25, "5", "call"),
   (1.0, .75, "R", "call"), (2.25, .25, "8", "resp"), (2.5, .25, "b7", "resp"), (2.75, .25, "5", "resp"),
   (3.0, 1.0, "R", "resp")]]
HALFTIME_H = [ # old-school wobble: root, 5th, octave; slides into the next root
  [(0.0, 1.0, "R", "call"), (1.25, .25, "5", "call"), (1.5, .25, "R", "call"),
   (2.5, .5, "8", "resp"), (3.25, .5, "b7", "resp")],
  [(0.0, .5, "R", "call"), (.75, .5, "5", "call"), (2.5, .5, "8", "resp"), (3.0, 1.0, "R>next", "resp")]]
EIGHT08_H = [(0.0, 1.75, "R"), (2.5, .5, "R"), (3.0, .5, "5"), (3.5, .5, "8>R")]   # fills end bars 2 and 4
```

- **Resolving degrees.** A degree is resolved against the bar's chord, so the same template follows i → VI → VII automatically.
  - `3` resolves to +3 or +4 by the chord's quality.
  - On a `5` (power) chord, `3` falls back to `5`.
  - Set `_near()`'s `root_pc` per bar from the plan. [INF]
- **The switch tables** (`*_SWITCH`) get the same treatment: keep their rhythm and replace the steps {0, 3, 5, 7} with {R, R, 5, 8, b7, R}. [INF]

### 2.6 Register and voice leading of roots

- **Sub window:** fold each chord root into B0–B1 (30.9–61.7 Hz), choosing the octave nearest the previous sub note (≤ 7 st where possible).
  - For example, with i = F#1 (46.2 Hz), VI is D1 at 36.7 Hz, not D2 at 73.4 Hz.
  - SB's rule of forcing the root into C1–A1 still holds for i. [INF]
- **Mid line:** keep it within ±7 st of its previous note across chord changes (nearest-motion voice leading, which KAN applies to pads) [3P KAN; INF].

---

## 3. Melody and hooks

### 3.1 The top line's role in each style

| Style | Top line in the drop | Tag |
|---|---|---|
| Riddim | None, or a one-note squeak or bleep that follows the wub accents (R or 5, at +24). The eerie melody lives only in the intro and build. | [P Level Up via FP; P-adj DEFINITIVE; SB] |
| Tearout (the Subtronics lane) | A top line is part of the sound. Subtronics calls his: "belligerently loud, lots of beep boops in a melodic way". | [P Subtronics, Dancing Astronaut 2022; SB "essential top line"] |
| Trap-hybrid (Tape B) | The source's vocal hook is kept and is the hook; chops go in the gaps | [3P Relentless Beats flips; P Tape B via FP "a fun hook"] |
| Hybrid trap generally | A drop needs one element the listener can remember: a vocal chop, lead, stab or short motif | [3P EDMTemplates hybrid, Melodigging hybrid] |
| Melodic moments | A lead motif above a chord bass, or pitched bass hits carrying the melody | [3P Melodigging future riddim, WA] |

### 3.2 Motif rules

- **Length and shape:** 1 bar, the usual length of a motif [3P shedthemusic]; 3–6 onsets; a range of at most 9 st, with an octave leap only at the phrase end. [INF]
- **Pitch placement:** chord tones on the strong steps (1, 5, 13), passing and neighbour tones on weak steps resolved by step [3P EDMProd], and nothing on step 9 below 1 kHz [SB snare window].
- **Motion and rhythm:** 60–80% stepwise motion and 2–3 distinct rhythm cells [3P EDMProd].
- **Targets from Hooktheory:** bass-music melodies there are 94–100% diatonic with 51–94% chord tones. Aim for ≥ 60% chord tones and 100% diatonic apart from the marked b2 accents. [3P Hooktheory; INF]
- **Sequencing:** when the chord changes, move the motif with it, keeping the contour and rhythm and refitting the notes to the new chord [3P shedthemusic].
- **The 4-bar phrase:** **A** · **A′** (the same rhythm sequenced to chord 2, ending on 5 or 2: the question) · **A** · **B** (the answer, ending on R with its longest note). Over 8 bars, play it twice and put bar 8 up an octave or end it with a 1-beat rest. [3P shedthemusic, MusicRadar tip 13; INF]
- **Source first:** if the source hook (on the `other` or `vocals` stem) can be transcribed, use its first 3–5 scale degrees as the motif's pitch set and re-rhythm them on our grid. This ties the drop to the vocal and the pre-drop hook the crowd has just heard. [INF]

### 3.3 Arps, squeaks, chops and candy

- **Arp** (the tearout top line, SB):
  - Arpeggiate the **current chord**, not the root triad. Minor chords use R, b3, 5, 8; major (VI, III, VII) use R, 3, 5, 8; power chords use R, 5, 8, 12.
  - 1/16 notes on a 2-bar cycle, in the pattern 0-1-2-3-2-1.
  - Every 4 bars change the pattern, not the rate. [INF]
- **Squeak** (riddim): uses the wub's accent rhythm on R or 5 (+24 or +31), band-passed at 2–5 kHz as in FP. [FP; INF]
- **Vocal chops:** filter them by pitch class (§1.3 rule 7). In trap-hybrid, place them in the step 5–8 gaps and on step 13 of bars 4 and 8 (SB). [SB; INF]
- **Candy** (8-bit): `candy.render_candy` arpeggiates the root triad. Feed it the current chord from the plan instead. [INF]

### 3.4 Repetition versus variation

- **Riddim:** one 1–2 bar motif, repeated. Change its filter, pitch, density and accent positions rather than its notes, with at most 1 pitch change per 4 bars. [3P soundwitches, Melodigging riddim; INF]
- **Tearout:** 4-bar weapons. Bar 1 states the idea, bar 2 responds, bar 3 escalates, and bar 4 resets with a fill or a stop. [3P EDMTemplates tearout]
- **Hybrid:** an 8-bar shape. Bars 1–2 set the core, bars 3–4 vary it, bars 5–6 raise the energy and bars 7–8 reset. "Repeat enough to feel like a song. Change enough to feel alive." [3P EDMTemplates hybrid]
- **808:** keep the first half of an 8-bar phrase constant and vary the fills in the second half. A simple fill ends bar 2 and a busier one ends bar 4. [3P Songen]
- **Melodic:** use the ABCB or A A′ A B phrase schemes [3P shedthemusic].

---

## 4. Drums

SB §3 and FP already cover the kit layers, the bus chains, the riddim kick–clap seesaw and the build roll. This section adds tuning, variation, groove, drop-half changes and what our kit gets wrong.

### 4.1 What makes them hit (new evidence)

- **Tune drums to the key:** the kick to the root, the snare (if tonal) to another note such as the 5th, toms to R, 3 and 5 [3P MusicRadar tuning]. Dubstep kicks impact at 50–60 Hz and snares peak at 150–250 Hz [3P Soundbridge, Unison dubstep].
- **Layer by band:** kick sub 40–80 Hz, body 80–200 Hz, transient 1–5 kHz; snare body 150–500 Hz, crack 2–5 kHz, air above 10 kHz [3P Unison layering].
- **Phase:** nudge layers 1–2 ms so their transients align, flip the polarity if two layers cancel, and detune clashing layers by 10–20 cents [3P Unison layering].
- **Real snares are complex.** An acoustic snare is shell modes plus wires. Synth recipes need two tuned modes (the 175 and 224 Hz offsets) plus contoured noise, and they still simplify [3P SOS Synth Secrets]. Pairing a synthesized, tuned body with a sampled top layer is standard practice [3P Gearspace, Point Blank layering].
- **The machine-gun effect** is identical repeats. Round-robin an **odd** number of variants (5 or 7) so the cycle never locks to 4/4 phrases [3P MusicRadar round-robin].
- **Timing:** listeners rate quantized drum patterns highest; ±15–25 ms shifts lower the groove rating, and early shifts rate worse than late ones [3P Frühauf 2013, Davies 2013]. In classic hip-hop breaks the median 16th-note swing is 1.2:1 (about 54.5%), and the beat-2 snare (not beat 4) sits 2–3% of a beat late [3P Frane 2017].
- **Variation cadence:** change something every 4–8 bars [3P KAN, Better Beats]. In second drops, one producer runs the drums double-time for about the first quarter [3P BassGorilla]; forum veterans strip back and re-add, or double-time the beat [3P DSF 286292].
- **Tearout drums:** kick on 1, snare on 3, and swung hats with ghosted percussion. The drums stay simple so the bass leads [3P Melodigging tearout, soundwitches]. The kick is not squashed [FP].

### 4.2 Spec

**Tuning**

| Voice | Rule | Examples |
|---|---|---|
| Kick body end frequency | The tonic folded into 40–62 Hz. If it folds outside that range, use its 5th. | E→41.2, F#→46.2, A→55.0, B→61.7; C→G1 49.0, D→A1 55.0 |
| Kick tail | Whenever the sub plays a root other than the kick's pitch, the kick must be ≤ −30 dB by 150 ms | Stops 1–10 Hz beating against VI or VII roots |
| Snare body tone | Take {R, 5} in every octave and pick the one nearest 200 Hz within 150–260 Hz | Fm→F3 174.6; Em→E3 164.8; Gm→G3 196; Dm→A3 220 |
| Toms and fill percussion | R, b3 and 5 of the key | [3P MusicRadar] |
| Clap and noise tails | Untuned | |

All tuning numbers are [INF] unless tagged.

**Variation per hit** [3P MusicRadar round-robin; INF]: 5 round-robin variants (7 for hats) in sequence with no immediate repeat; pitch ±10–15 cents and decay ±6% (both already in place); level ±0.5 dB on top of the accent map; a +1.5 dB shelf above 3 kHz for every +0.25 of velocity (harder hits are brighter).

**Accent maps** (velocity 0–1)

```text
HAT offbeat 8ths (riddim, tearout)   ..x...x...x...x.   v .80 .70 .85 .70        [SB grid; INF v]
HAT 16ths (trap-hybrid)              per beat [1.0, .55, .75, .55]; rolls ramp .6 -> 1.0  [3P Unison/LANDR rolls; INF]
GHOST snare                          step 16 of bars 2 and 4 at .35-.45                 [SB; INF]
GHOST kick (riddim "whack")          step 9 at .35 (SB)                                 [3P EDMProd riddim]
```

**Microtiming**

| Voice | Riddim | Tearout | Trap-hybrid |
|---|---|---|---|
| Kick, snare | 0 ms | 0 ms | 0 ms; a snare knob of +5..+12 ms, default 0 |
| Hats | straight to 52% | 54–55% (the UK shuffle) | 54–58% |
| Percussion | 52–55% | 55% | 56% |

Sources: [3P Frühauf, Davies (quantize the kick and snare), Frane (1.2:1), Melodigging tearout (swung hats); SB 54–58%]. The individual numbers are [INF]. **Never randomize timing.**

### 4.3 Fills, and how the drums change across a drop

| Where | Riddim | Tearout | Trap-hybrid |
|---|---|---|---|
| Bar 4, beat 4 | A 1/8T percussion flick | Snare 16ths at .5 → .9, or a metal roll | A 1/32 hat roll |
| Bar 8 | Beat pause (FP) plus a triplet flick | A 2-beat pause plus a stutter | Drums out on beats 2–3, then a snare flam |
| Bars 9–16 vs 1–8 | Add soft 8th hats (FP) | Add an extra kick on step 11; ghost 16th hats on beat 4 | Hats go from 8ths to 16ths; a roll every 2 bars |
| Drop 2, bars 1–4 | The same seesaw with a new clap tail | Double-time kick and snare for 2–4 bars | Double-time hat rolls |

- Fills sit on the harmony: every fill ends on the bar before a chord change or a turnaround (bars 7–8 and 15–16), and resolves on the downbeat. [3P KAN, BassGorilla, DSF 286292; SB; FP; INF]

### 4.4 What our kit gets wrong, and the fix

1. **The kick ends at 52 Hz unless the root is 45–60 Hz.** Use the tuning table and the tail rule. [INF, from the code]
2. **The snare's tone is 185 Hz (F#3) in every key.** Use the tuning table. [INF, from the code]
3. **Every style gets a TR-808 character.**
   - Keep the 808 kits for trap-hybrid.
   - Riddim and tearout get a stack: the synth body, plus a **CC0 acoustic snare transient and room** from Karoryfer *Frankensnare* (900 MB) or *Gogodze Phu Vol II* (133 MB, both CC0), plus the clap.
   - Ship ≤ 20 trimmed one-shots (a few MB), not the libraries. This follows the "keep updates small" rule. [3P SFZ Instruments; INF]
4. **One sample per sample-based voice.** Give each 5–7 round-robin variants; the synth voices already jitter. [3P MusicRadar round-robin]
5. **Flat velocities.** Use the accent maps above, with velocity driving the timbre. [INF]
6. **The drums don't change between drop halves.** Apply §4.3. [INF]
7. **"Humanized" random timing.** Keep everything on the grid and use systematic swing only (§4.2). [3P Frühauf, Davies]

---

## 5. Drop anatomy (with the harmony and tension overlay)

### 5.1 Units

- **The 4-bar weapon:** call, response, escalate, reset (a fill or a stop) [3P EDMTemplates tearout]. For riddim: the main bar, an answering bar, the main bar with a tiny change, then a fill [3P EDMTemplates riddim].
- **The 8-bar arc:** establish (1–2), vary (3–4), raise (5–6), turn around and reset (7–8) [3P EDMTemplates hybrid].
- **Length:** a 16-bar drop. 32 bars (about 55 s at 140 BPM) is the norm, and identical bars go monotonous within 8 [3P KAN].
- **Inside the bar:** "Loud, quiet, loud" [P Subtronics, MusicTech].
- **Tension devices:** uplifters, drum rolls, big frequency changes, and taking the bass and kick out and bringing them back [3P Solberg 2014]. Micro-breaks (muting the kick or bass for half a bar) make the return hit harder [3P KAN].

### 5.2 Bar by bar (16 bars)

The lanes refer to the SB and FP per-style patterns; the overlay is [INF], built on §5.1's sources.

| Bar | Root (riddim / tearout / hybrid) | Bass | Top | Drums | Tension |
|---|---|---|---|---|---|
| gap | the hook's last chord, cut | Silent; the root is withheld | Vocal cue on a chord tone of i | Silent | maximum |
| 1 | i / i / loop 1 | **Hardest hit:** the sub root's longest note plus the mid on R (SB §1.7) | Tearout arp from bar 2 | Full kit plus the impact | **release** |
| 2 | i / i / loop 2 | Response on 5 and 8 | Top enters (tearout, melodic) | | low |
| 3 | i / i / loop 3 | Call variant (the next resample generation) | A | | low |
| 4 | i / i / loop 4 | Response plus a phrase-end b2/b5 pickup | B, the answer | Beat-4 fill | medium |
| 5 | i / i / loop 1 | The sub re-strikes the root; call on the 2nd patch | A | | release |
| 6 | i / i / loop 2 | Response, sequenced | A′ | | medium |
| 7 | i / **VI** / loop 3 | Escalate: machine gun or octave up | A | Busier hats | rising |
| 8 | i→**bII** on beats 3–4 / **VII** / loop 4 | Turnaround and tension notes, then the **beat pause** | B up an octave, or a rest | Pause plus a flick | **peak** |
| 9 | i / i / loop 1 | **Second first hit** at −1 dB vs bar 1, with a new patch family | The motif returns | One density level up | **release** |
| 10–12 | i or **iv** (the lift) / i / loop | Pattern B; the lift transposes the calls | A A′ A | Add percussion | medium |
| 13–14 | i or iv / i / loop | Switch state (SB) | B | | rising |
| 15 | i / **VI** / loop | Escalate | | Fill | high |
| 16 | i→bII / **VII** or **V** / loop end | Glitch or tape-stop on a tension note, resolving on the next section's i | | Stop | **peak** |

- **32 bars:** bars 17–32 repeat bars 1–16 with the patch families swapped and the voice roles inverted (SB §4). In riddim, move the lift to bars 17–24 on iv or VI, and return to i for bars 25–32. [SB; INF]

### 5.3 Harmonic plan per style (the defaults behind §1.5)

- **Riddim:** the pedal i is the genre. The only harmonic events are one lift (iv or VI) for 4–8 bars and the bII pickup at bars 8 and 16; chords live only in the top layer over the pedal (§1.3 rule 8). [3P Melodigging riddim, soundwitches; FP; INF]
- **Tearout:** pedal i with turnaround roots in bars 7–8 and 15–16: VI–VII (the commonest adjacent pair in the corpus), bII (Phrygian) or V (harmonic minor, pulling home). Pitch gestures start and end on chord tones. [3P Melodigging tearout, Hooktheory; INF]
- **Trap-hybrid:** the hook's loop with the 808 on its roots (no clear loop: i–i–VI–VI–iv–iv–VII–VII); chops come from bars whose chord matches (§1.3 rule 7). [3P Motifkit, Relentless Beats; INF]
- **Old-school wobble (halftime):** the wobble follows the loop's roots at 2 bars a chord; see `HALFTIME_H` in §2.5. [INF]

### 5.4 A tension model you can compute (for the scheduler and QA)

`T(bar) = .35·(share of the bar off i) + .20·min(1, tension_notes/2) + .20·density + .15·[octave up] + .10·[pause or micro-break]`

- **density** is the bar's fastest retrigger rate mapped as 1/8 → 0, 1/16 → .5, 1/32 → 1.
- **Targets:** T ≤ .2 on bars 1 and 9 (release), .3–.6 on bars 4 and 12, ≥ .5 on bars 7 and 15, ≥ .6 on bars 8 and 16 (riddim reaches it through density, register, the pause and the half-bar bII). Never 3 bars in a row at ≥ .7, and the downbeat after a peak is i with the full kit. [INF]

---

## 6. Analysis we can compute (numpy/scipy only; no new runtime dependencies)

### 6.1 Tuning offset

- **Input:** the `other` and `vocals` stems (they are harmonic), over the 30–60 s with the most tonal energy.
- **Peaks:** an 8192-sample STFT at 44.1 kHz; in each frame, the local maxima within 40 dB of the frame's maximum between 100 and 2000 Hz, refined by parabolic interpolation `p = 0.5(a−c)/(a−2b+c)`.
- **Deviation per peak:** `c = 1200·log2(f/440)`, wrapped into [−50, 50) cents; then the magnitude-weighted circular mean `θ = 100/(2π) · angle(Σ w·exp(2πi·c/100))` [3P Dressler 2007; FMP C3].
- **Apply θ everywhere:** synth pitch `f = 440·2^((m−69)/12 + θ/1200)`, one-shot repitch targets `+= θ/100` semitones, the kick and snare tuning, and the chroma bin centres.
- **When to skip:** if |θ| < 5 cents. Professional players hold tuning to within about 3–5 cents [3P Lerch 2006]; 432 Hz is −31.8 cents. [INF]

### 6.2 Chroma features

- **Reuse `song._chroma`** (11.025 kHz, a 4096 FFT, 55–2000 Hz, a 9-frame median, square-root magnitude). Run it:
  - on the **treble** (the `other` stem plus 0.5 × the `vocals` stem), to get the chord **quality**;
  - on the **bass** stem at 30–250 Hz, to get the **root**. For the bass, use a 16384 FFT, which gives 0.67 Hz bins (E1 and F1 are 2.5 Hz apart).
  - Better still, take the root from the **BASS DNA notes**: a pitch-class histogram per frame, weighted by duration × level, with downbeat notes counted twice. [INF]
- **Why stems:** a distorted bass's 3rd partial is the 5th and its 5th partial is the major 3rd, which puts a false major 3rd into full-mix chroma. NNLS approximate-transcription chroma was built to fix this in mixes [3P Mauch & Dixon 2010, nnls-chroma docs]; stems avoid most of it for free. [INF]
- **Optional NNLS step:** `scipy.optimize.nnls` against a dictionary of notes whose partials decay by s^(k−1), s = 0.5–0.9 [3P nnls-chroma]. Add it only if stem chroma underperforms on the corpus.
- **Pooling:** average the chroma per **half-bar** from `song.py`'s BPM and downbeat (about 9 frames at a 0.09 s hop and 145 BPM), then log-compress with `log(1 + 10·c)` and L2-normalize [3P FMP templates; the gamma is INF].

### 6.3 Chord per half-bar: templates, a bass prior, a key prior and Viterbi

```python
def chord_path(treble, bass_pc, diatonic, p_stay=.75, beta=12., gamma=3., delta=.7, n_floor=.6):
    """treble (T,12) half-bar chroma, L2-normalized (all-zero rows = silence); bass_pc (T,12) bass pitch-class
    weights (rows sum to 1, zero where the bass is silent); diatonic (36,) 1.0 for chords in the key, 0.5 for V
    and bII, else 0. States 0-11 minor, 12-23 major, 24-35 power ('5'), 36 no-chord. Returns (T,) state ids."""
    tpl = np.zeros((36, 12))
    for r in range(12):
        tpl[r, [r, (r + 3) % 12, (r + 7) % 12]] = 1., .8, .9
        tpl[12 + r, [r, (r + 4) % 12, (r + 7) % 12]] = 1., .8, .9
        tpl[24 + r, [r, (r + 7) % 12]] = 1., .9
    tpl /= np.linalg.norm(tpl, axis=1, keepdims=True)
    root = np.tile(np.arange(12), 3)
    s = np.empty((len(treble), 37))
    s[:, :36] = beta * treble @ tpl.T + gamma * bass_pc[:, root] + delta * diatonic   # cosine + priors
    s[:, 36] = beta * n_floor        # no-chord wins only where no chord reaches cos n_floor (e.g. silence);
    logA = np.full((37, 37), np.log((1 - p_stay) / 36))   # a flat "N" template would beat log-compressed chords
    np.fill_diagonal(logA, np.log(p_stay))
    d, back = s[0].copy(), np.zeros(s.shape, int)
    for t in range(1, len(s)):
        c = d[:, None] + logA
        back[t], d = c.argmax(0), c.max(0) + s[t]
    path = [int(d.argmax())]
    for t in range(len(s) - 1, 0, -1):
        path.append(int(back[t, path[-1]]))
    return np.array(path[::-1])
```

- **Checked on synthetic data** (this block, run against i–VI–III–VII in A minor, 2 half-bars a chord, noise and a false 3rd added, 20 seeds): 100% exact with the bass prior; 46–82% without it, and every miss was a relative-chord confusion (Am↔C, F↔Am). **The bass stem is the main lever.** Silent half-bars came back as no-chord. [INF: our test]
- **Power chords:** if `max(c[r+3], c[r+4]) < .25·c[r]` at the chosen root, report `5` and take the quality from the key's diatonic chord on that root. [INF]
- **Self-transition probability:** `p_stay = 1 − 1/L` for an expected chord length of L half-bars. Use L = 4 (0.75) for loops and L = 8 (0.875) for pedal drops.
  - A high self-transition probability matters more than musically informed transition matrices [3P Cho & Bello 2014].
  - librosa's own demo uses 0.9 per frame and says the demo is not accurate enough for real use [3P librosa].
  - Halve the transition probability off the downbeat so changes prefer bar lines. [INF, after Mauch's metric modelling]
- **Confidence:** the score margin between the top two states at each half-bar. Below .1, mark it uncertain and let the plan inherit the neighbouring chord. [INF]
- **What to expect:** roots are the reliable part. Automatic systems reach about 0.79–0.84 root recall on pop, against about 0.93 agreement between human annotators [3P Humphrey & Bello 2015]. Our plans use roots plus the key's chord qualities, so root accuracy is what counts. [INF]

### 6.4 Key per window

- **Today** `song.py` runs Krumhansl–Schmuckler on the whole song. Add EDM-specific profiles:
  - On GiantSteps (604 EDM excerpts), Faraldo's EDM profiles score 70.1 (edmm) and 65.6 (edma) weighted, while the same system with classical profiles scores 44.6. A CNN scores 74.3 [3P Korzeniowski & Widmer 2017, Table I], and Rekordbox gets 71.85% correct (79.55 weighted) [3P Knees 2015].
- **The edma profiles** (from the paper's `edmkey` repo, which has no licence file; they are published numbers, so cite them or re-derive them from our corpus). The repo's hand-tuned `faraldo` profile may be the edmm one; it isn't labelled, so test both. [3P edmkey templates.py]
  - minor `[1, .3096, .4415, .5827, .3262, .4948, .2889, .7804, .4328, .2903, .5331, .3217]`
  - major `[1, .2875, .5020, .4048, .6050, .5614, .3205, .7966, .3159, .4506, .4202, .3889]`
- **Prefer minor:** 84.8% of EDM is minor [3P Knees], so take the minor reading unless major wins by ≥ .1 correlation. [INF]
- **Local key** over 8-bar windows, with hysteresis: switch only when a new key wins 2 windows running by ≥ .05. The remix follows the key of the drop section. [INF]

### 6.5 Finding the loop and building the plan

- **The source drop's skeleton** is its roots per half-bar, taken from the BASS DNA notes (duration-weighted pitch class, downbeat notes ×2). When it exists, it is the VIP's harmony. [INF]
- **The hook loop:**
  - From the per-bar roots `r[b]` over the hook, chorus and build bars, score each length L in {2, 4, 8} as `mean(r[b] == r[b+L])`.
  - Take the smallest L that scores ≥ .75.
  - Rotate the loop so it starts on the source drop's bar-1 root. [INF]
- **The plan** is the style transform (§1.5) of the skeleton, else the loop, else the template. Seed it from `Remix.seed` and record it in the take so a rebuild reproduces it. [INF]

### 6.6 QA additions to `remix_qa`

| Check | How | Target |
|---|---|---|
| Tuning match | Circular-mean cents of the new bass stem vs the source's θ | ±5 cents |
| Sub root agreement | Sub f0 per half-bar vs the plan's root | 100% (within ±50 cents) |
| Chord-tone share | Mid note-time on chord tones, from the sequencer's hit list (tension slots excluded) | ≥ 85% |
| Out-of-key energy | Treble and mid chroma energy outside the key scale, excluding the bII/b5 slots | ≤ 15% per bar |
| Kick/sub beating | Kick end frequency vs the sub root in the same bar; flag when they are 0.3–1.0 st apart and overlap for more than 50 ms | 0 cases |
| Harmonic arc | The T(bar) profile vs §5.4 | Peaks at 7–8 and 15–16; release at 1 and 9 |
| Detector self-test | `engine/fx/tests/songsynth.py` renders known progressions with a distorted bass and a pad | ≥ 90% half-bar root accuracy |
| Corpus spot-check | 5–10 hand-labelled tracks from the local test corpus | ≥ 80% root accuracy per bar |

All targets are [INF].

### 6.7 Packages and licences (FoxBox is GPL-3.0 and adds no new runtime dependencies)

| Package | Method | Licence | Verdict |
|---|---|---|---|
| madmom | Deep chroma plus CRF, major/minor | Code BSD; models CC BY-NC-SA 4.0 | **No.** Non-commercial models can't ship in the app, and it would be a new dependency [3P madmom] |
| librosa | Chroma plus the `viterbi_discriminative` demo (25 states, self-loop 0.9) | ISC | **No dependency.** The algorithm is the ~30 lines above, and its docs say the chord demo is only a demonstration [3P librosa] |
| NNLS Chroma / Chordino | NNLS transcription, bass and treble chroma, HMM | GPLv2 (a C++ Vamp plugin) | **Algorithm only**, via `scipy.optimize.nnls` [3P c4dm] |
| Essentia (+ edmkey) | HPCP plus the EDM key profiles | AGPL-3.0 | **Profile numbers only** [3P MTG] |
| libfmp / FMP notebooks | Template and HMM chord recognition, tuning estimation | MIT | **Reference only** [3P libfmp] |

---

## Sources

**Genre, harmony and melody**
- Hooktheory TheoryTab (crowd-sourced): Skrillex https://www.hooktheory.com/theorytab/artists/s/skrillex, Scary Monsters https://www.hooktheory.com/theorytab/view/skrillex/scary-monsters-and-nice-sprites, Breakn' A Sweat https://www.hooktheory.com/theorytab/view/skrillex/breakn-a-sweat, Virtual Riot https://www.hooktheory.com/theorytab/artists/v/virtual-riot (Chroma, Simulation, Different World, Dream Logic, Energy Drink pages), Zomboy Game Time https://www.hooktheory.com/theorytab/view/zomboy/game-time, Flux Pavilion Emotional https://www.hooktheory.com/theorytab/view/flux-pavilion/emotional---featuring-matthew-koma, Seven Lions https://www.hooktheory.com/theorytab/artists/s/seven-lions (Nepenthe, ID, Below Us, Days to Come)
- Melodigging, riddim https://www.melodigging.com/genre/riddim-dubstep ; tearout https://www.melodigging.com/genre/tearout ; hybrid trap https://www.melodigging.com/genre/hybrid-trap ; future riddim https://www.melodigging.com/genre/future-riddim
- soundwitches, riddim https://note.com/soundwitches/n/nb9beca19adb2?hl=en ; tearout https://note.com/soundwitches/n/n1485003dd099?hl=en
- KAN Samples, dark progressions https://kansamples.com/blogs/learn/chord-progressions-dark-electronic ; arrangement https://kansamples.com/blogs/learn/dubstep-track-arrangement
- Unison, dark progressions https://unison.audio/dark-chord-progressions/ ; frequency shifting https://unison.audio/frequency-shifting/ ; drum layering https://unison.audio/drum-layering/ ; dubstep https://unison.audio/how-to-make-dubstep/
- PresetDrive, colour bass https://www.presetdrive.com/color-bass-sound-design-for-beginners-how-to-get-started-in-serum/
- WA Production, melodic dubstep drop https://www.waproduction.com/videos/view/making-a-melodic-dubstep-drop
- Dubstepforum (DSF): In the key of dubstep https://www.dubstepforum.com/forum/viewtopic.php?t=81444 ; Chord progressions? https://www.dubstepforum.com/forum/viewtopic.php?t=280452 ; Bassline writing? https://www.dubstepforum.com/forum/viewtopic.php?t=204676 ; 2nd drop and variation https://www.dubstepforum.com/forum/viewtopic.php?t=286292 ; comb filters https://www.dubstepforum.com/forum/viewtopic.php?f=8&t=252299
- KVR, keys for dubstep https://www.kvraudio.com/forum/viewtopic.php?t=498277 ; key-following combs https://www.kvraudio.com/forum/viewtopic.php?t=561477
- Hack Music Theory (HMT), EDM bass drops https://hackmusictheory.com/blogs/theory/posts/4703488/how-to-write-epic-edm-bass-drops-in-7-steps ; Locrian bass lines https://www.goodreads.com/author_blog_posts/23742715-how-to-write-locrian-bass-lines-music-theory-from-rezz-suffer-in-sile
- MusicRadar, 14 dubstep tips https://www.musicradar.com/tuition/tech/14-dubstep-production-tips-178489 ; drum tuning https://www.musicradar.com/tuition/tech/how-to-tune-electronic-beats-to-fit-a-tracks-key-643622 ; round-robin https://www.musicradar.com/tuition/tech/how-to-avoid-the-machine-gun-effect-using-round-robin-sampling-632302
- EDMProd, advanced melodies https://www.edmprod.com/advanced-melodies-chord-tones-motifs/ ; tension https://www.edmprod.com/tension/ ; riddim https://www.edmprod.com/how-to-make-riddim/
- Black Rooster Audio, tension and release https://blackroosteraudio.com/en/blogreader/tension-and-release-harmony-tricks-every-producer-should-steal
- shedthemusic, melodic development https://www.shedthemusic.net/free-resources/melodic-development
- Motifkit, trap progressions https://motifkit.com/trap-chord-progressions/ ; Songen, drill 808 slides https://songen.app/blog/drill-808-slides/ ; Production Music Live, 808 patterns https://www.productionmusiclive.com/blogs/news/trap-beat-guide-bass-essential-tips-for-making-808-patterns
- EDMTemplates, hybrid trap drops https://edmtemplates.net/blogs/edm-templates-blog/how-to-make-hybrid-trap-drops-in-serum-2 ; tearout https://edmtemplates.net/blogs/edm-templates-blog/how-to-make-tearout-dubstep-bass-in-serum-2 ; riddim https://edmtemplates.net/blogs/edm-templates-blog/how-to-make-riddim-bass-in-serum-2
- Cymatics, EDM song structure https://cymatics.fm/blogs/production/edm-song-structure
- Disc Makers, power chords https://blog.discmakers.com/2022/08/power-chords/ ; Perfect Circuit, frequency shifters https://www.perfectcircuit.com/signal/frequency-shifters
- MusicTech, pitched vocal chops https://musictech.com/tutorials/pitched-vocal-chops/ ; remix tips https://unison.audio/how-to-remix-a-song/ , https://hyperbits.com/how-to-remix-a-song/
- Dancing Astronaut, FRACTALS (Subtronics quote) https://dancingastronaut.com/2022/01/subtronics-debut-record-fractals-makes-its-landing/ ; SoundCloud, Sound Advice: Subtronics https://soundcloud.com/stories/post/sound-advice-subtronics
- Relentless Beats, Tape B flips https://relentlessbeats.com/2024/04/remix-recall-tape-bs-top-flips/ ; the art of the drop https://relentlessbeats.com/2025/05/the-art-science-of-the-drop/
- Osborn 2023, Formal Functions and Rotations in Top-40 EDM https://theory.esm.rochester.edu/integral/36-2023/osborn/
- Solberg 2014, Waiting for the Bass to Drop (Dancecult) https://dj.dancecult.net/index.php/dancecult/article/view/451
- Conklin et al., chord sequence generation for EDM (trance loops) https://mdpi.com/2076-3417/8/9/1704/html (seen via a search summary only)

**Drums and groove**
- Sound On Sound, Dubstep Drums https://www.soundonsound.com/techniques/dubstep-drums ; Practical Snare Drum Synthesis https://www.soundonsound.com/techniques/practical-snare-drum-synthesis
- Soundbridge, dubstep drums https://www.soundbridge.io/designing-dubstep-drums ; Better Beats, EDM drum programming https://www.betterbeatsblog.com/post/the-complete-guide-to-edm-drum-programming
- Attack Magazine, Mystik dubstep https://www.attackmagazine.com/technique/beat-dissected/mystik-dubstep/ ; BassGorilla, dubstep construction https://bassgorilla.com/dubstep-construction-mixdown-tutorial-in-ableton-pt-1/
- Frühauf, Kopiez and Platz 2013, Music on the timing grid https://journals.sagepub.com/doi/abs/10.1177/1029864913486793 ; Davies et al. 2013 https://online.ucpress.edu/mp/article-abstract/30/5/497/62581/ ; Frane 2017, swing in breakbeats https://shamslab.psych.ucla.edu/wp-content/uploads/sites/57/2017/01/Frane_SwingInBreakbeats_2017.pdf
- SFZ Instruments drum libraries (the Karoryfer CC0 kits) https://sfzinstruments.github.io/drums/

**Analysis**
- Knees et al. 2015, GiantSteps datasets https://www.cp.jku.at/research/papers/knees_etal_ismir_2015.pdf
- Korzeniowski and Widmer 2017, key CNN (the GiantSteps table) https://arxiv.org/pdf/1706.02921 ; edmkey https://github.com/anxefaraldo/edmkey (templates.py)
- FMP notebooks: templates https://www.audiolabs-erlangen.de/resources/MIR/FMP/C5/C5S2_ChordRec_Templates.html ; HMM https://www.audiolabs-erlangen.de/resources/MIR/FMP/C5/C5S3_ChordRec_HMM.html ; tuning https://www.audiolabs-erlangen.de/resources/MIR/FMP/C3/C3S1_TranspositionTuning.html
- Cho and Bello 2014 (via a search summary) https://www.researchgate.net/profile/Taemin-Cho ; Humphrey and Bello 2015, Four Timely Insights https://archives.ismir.net/ismir2015/paper/000294.pdf
- Dressler 2007, tuning via circular statistics https://archives.ismir.net/ismir2007/paper/000357.pdf ; Lerch 2006, tuning frequency http://www2.users.ak.tu-berlin.de/akgroup/ak_pub/2006/Lerch_2006_On_the_Requirement_of_Automatic_Tuning_Frequency_Estimation.pdf
- Mauch and Dixon 2010, NNLS chroma https://ismir2010.ismir.net/proceedings/ismir2010-25.pdf ; nnls-chroma (GPLv2) https://github.com/c4dm/nnls-chroma
- librosa `viterbi_discriminative` https://librosa.org/doc/main/generated/librosa.sequence.viterbi_discriminative.html ; madmom LICENSE https://github.com/CPJKU/madmom/blob/main/LICENSE ; Essentia https://github.com/MTG/essentia ; libfmp https://pypi.org/project/libfmp/
- Internal: `help/s2-bassdna` (30c2bc3): `engine/fx/src/fvwks_fx/remix/resample.py`, `groove.py`, `engine/synth/src/fvwks_synth/drums.py` ; `engine/fx/src/fvwks_fx/song.py` (main)

**Honesty notes**
- No YouTube transcripts were used.
- Producer interviews rarely name chords, so the harmony rules rest on transcriptions (Hooktheory), tutorials and datasets. The [P] quotes cover philosophy (Subtronics, and Level Up and Tape B via FP).
- Hooktheory is crowd-sourced and skews melodic. No riddim or tearout drop is transcribed there, so those styles' pedal plans rest on the genre guides (Melodigging, soundwitches) and FP.
- Cho & Bello and the MDPI trance-loop statistic were read through search summaries.
