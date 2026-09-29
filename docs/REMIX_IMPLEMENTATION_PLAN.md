# FoxBox REMIX: implementation plan v2

**Status:** v2, drafted for the PM on 2026-09-29 from all REMIX research, the session reports (~02:45) and the commits that landed after them (to ~03:05). It replaces v1.
- **PM decisions folded in (03:20):**
  - C1: one Remix doc with `Remix.takes`, and edits belong to their take (v0.11.9).
  - C10: the §7.3 weighted draw.
  - C18: add a TEAROUT flip.
- **Also since the draft:** M3.1 TAKES/ROLL shipped unstyled (S4), M4.1/M4.3 routes shipped (S3), and remix_qa on main now grades per-bus stems with the M2.4 checks (2cb9c36).
- Section order and item IDs M1.1–M5.5 are v1's. New items continue each milestone (M1.12+, M2.7+, M3.6+, M4.5+).
- New sections: §3 (the sound spec), §4 (variation axes), §11 (listening gates).

**Sources**
- Docs: **SB** `REMIX_SOUND_BIBLE.md` · **FP** `REMIX_GENRE_FINGERPRINTS.md` · **ER** `REMIX_ENGINE_REVIEW.md` · **DU1** `REMIX_DESIGN_UPDATE_1.md` · **BE** `REMIX_BACKEND.md`.
- Code: `help/s2-bassdna` @ a0a35d8: the engine path; `help/s3-growls` @ 0074395: voices and midbus; includes S1 up to 930a219; `help/s1-riddim` @ 50b131c: S1's drums, squeak and seeded options, not yet in S3's branch; `main` @ 063bd19: remix_qa §5 and contracts v0.11.8; `remix/s4-takes` @ aeaade4 and `help/s5-ux` @ 33105d3.

**Tags**
- Evidence: [P] a producer's own words · [P-adj] a close producer · [3P] a tutorial, pack or article · [SRC] cited in SB · [INF] our inference, a starting knob.
- **overridden Rn:** a research number that your rule n replaces (§9).
- Cross-references: AX-nn axis (§4) · I1–I12 invariant (§4.2) · Q01–Q42 QA check (§8) · C1–C18 contradiction (§2.3) · L1–L14 listening gate (§11).

**Owners**
- S1 synth voices (riddim, 808, wobble, top, drum voices).
- S2 remix engine (styles, arrange, prepare, mixdown, resample, seeds and choices, audition harness, goldens).
- S3 tearout voices, midbus, QA, server routes.
- S4 the REMIX page and release · S5 UX.
- PM contracts, listening gates, the rules registry, merges.

**Sizes:** S ≤ ½ day · M ≈ 1 day · L several days. ✅ = in the code today.

---

## Scope: "ship lean" (the user's decision, 2026-09-29, 11:15)

1.5 ships as soon as REMIX sounds right to the user (the listening gates in §11).

**In 1.5:**
- SMART VISUALS, fixes, face masks (LOW-POLY, DEPTH GLITCH BETA; FOX frozen) and live-set safety;
- the REMIX core:
  - the recipes;
  - TAKES/ROLL with ratings (M4.1–M4.3);
  - editing (M3.2);
  - SWAP SOUND (M3.3);
  - the design look (M3.5) with the v0.11.12 controls (VIP BASS, TOP layers, bass macros, flip-card grids);
  - lane M/S/gain;
  - WYHIWYG (M1.14);
  - robustness on any track (M2.3);
  - corpus QA green (M5.2).

**Moved to 1.5.1:** REMIX ALL (M2.6), the TEAROUT flip (C18), the speed pass (M2.5), golden takes (M4.4), QA calibration from ratings (M4.5), CC0 sample layers (M1.19), the user's own sample packs (M3.9), Rekordbox import, the in-app mask maker.

## 0. TL;DR (for you)

1. **Three sounds, built on purpose, plus your 808 VIP.** TEAROUT: short metallic "gun-shot" hits with real silence between them. RIDDIM: one wobbly bass idea repeating over a simple kick-and-clap beat, with a clean deep bass under it. TRAP-HYBRID: your track's own big 808 with hip-hop drums and hat rolls. 808 VIP: your 808, answered by growls.
2. **Your rules are built in and checked on every render.** The big held bass stays under the short hits. No breakdown: the original build and hook, at most one beat of silence, then the drop. The first hit is the hardest, and the 808 never starts high or whiny. Beat pauses sometimes; a 2-beat switch-up into a darker, longer first hit for trap-hybrid. Club-safe (−7 LUFS, −1 dBTP), and the tempo follows your track.
3. **Growl quality is job #1.** The next listening pass is per growl sound: you say keep, fix or drop.
4. **There isn't one right answer, so FoxBox keeps them all.** Where producers disagree (riddim drums, tempo, how hard the bass ducks, fills), every good option stays in and each take picks one. Your ratings slowly tilt the odds; your rules hold for every option.
5. **Tons of takes, any track.** Each take has a seed: the same seed rebuilds the same take, and ROLL makes a new one. Every change is tested on 7 tracks (song-1 and ncs-01…06), never one.
6. **A lite DAW, in your order:** TAKES/ROLL → editing (undo, split, copy, snap, zoom) → swapping the sound on one clip. The mixer comes last.
7. **It learns by counting, not AI.** Thumbs up or down plus a reason chip; ROLL leans toward what you liked. Takes you love become tests, so they can't get worse. No generative AI anywhere in the music.
8. **What we need from you:** short listening checks (§11), mostly "does this sound right: yes or no".
9. **Order:** sounds and checks right → tons of takes → lite DAW → ratings → ship 1.5 with the Claude Design look.

---

## 1. Principles

- **The engine, not the clip.** Every improvement lands in engine code or data: styles and grids as data, voices in `fvwks_synth`, rules in `arrange`/`prepare`/`mixdown`. Every clip anyone hears comes from `remix_audition.py` → `fvwks_fx.remix.run`, exactly as the app makes it.
- **Your rules beat the research.** Each research number a rule replaces is marked overridden and listed in §9.
- **No single correct answer (R14).** Where credible sources disagree, the choice becomes a seeded axis with default weights (§4); ratings shift them (§7); the invariants (I1–I12) hold for every option. Listening gates ask "does it work", never "which convention is right".
- **Reproducible takes.** (Remix doc, seed, recorded choices) → the same audio. A clip's cache key covers everything its render reads (C14). Rebuilding an existing seed reuses its recorded choices, never newer preferences.
- **What you hear is what you export.** The app, the export and the audition play the same prepared clips, so bus processing belongs in prepare, not only in mixdown (C2 → M1.14).
- **No generative AI in music (R13):** DSP, designed synths, resampling and plain statistics (Beta counts).
- **Any track.** Every change passes QA on the corpus (song-1, ncs-01…06; local only in `~/<test media>`, neutral names, titles never written).
- **Tempo follows the source (R8).** No stretch within ±15%; a half/double-time read counts as ×2/×½; the style tempo applies only by your choice or when the source is out of every range (AX-08).
- **Club-safe (R9):** −7.0 ± 0.5 LUFS short-term max, ≤ −1.0 dBTP, ≤ 3 dB limiter GR. Density comes from the buses (OTT, clipping), not master gain.
- **No new Python runtime dependencies** (engine-runtime stays v1.2.1): numpy, scipy, pedalboard, pyloudnorm (in fvwks-fx), soundfile (in fvwks-synth). Dev scripts may use mutagen.
- **Simple, executed well.** Subtronics credits "Black Ice" to a good idea done simply [P].
- **Lean QA.** One automatic remix_qa pass per take (seconds); one corpus run per engine change (7 tracks × 4–5 recipes × 2 seeds); no sweeps.

---

## 2. Where we are (reports ~02:45, plus commits to ~03:05)

### 2.1 State

| Area (owner) | Branch @ sha | Done | Open |
|---|---|---|---|
| Riddim voices (S1) | `help/s1-riddim` 930a219 → 0cc14f5, 50b131c | **R1** `riddim.r1`: a square-FM wub with a comb, a flanger and a saw-down LFO restarted per note; the variant is the rate (1/4, 1/4T, 1/8, 1/8T). **R2** `riddim.r2`: the formant "yoi", Q 9, u→a→i or i→o→i. New: `render_squeak` (top layer), `late_with_delay` (the off-grid "d" hit), `r2_blend(seed)` (0.3–0.5). 19/19 synth tests pass; loops in `out/growl-audition/` | The re-fade after the chain (S1's finding → M1.16); a freq-shift + delay stage (M1.4); record the seeded options as take choices (C11) |
| 808, dark hit, candy (S1) | same | `bass808.render_808_line`: a ≤ +7 st drop settled by 30 ms, glides only where notes overlap (80/240 ms, ±12), parallel saturation; new `glide_times(seed)`. `render_darkhit`: on pitch, slow LP bloom, grit, long tail. `candy.render_candy`: arp, power-up and coin, in key | `render_808_line` isn't used by the engine (M1.12) |
| Drum voices (S1) | 0cc14f5 | `drums.render_drum(voice, sr, vel, seed, variant, root_hz, length_s)`: kick, kick_riddim, kick_tearout, the L1–L4 snare stack, snare_pan, clap with room, hat, open_hat, impact, crash, reverse_cymbal; seeded micro-variation per hit | S2 sequencing, buses and loudness (M1.10); not yet in S3's or S2's branch |
| Tearout voices + growls API (S3) | `help/s3-growls` b5cc3c1, 820660b, 0074395 | `growls.render_growl(style, midi, beats, bpm, sr, variant, sub, hit)`: A chomp, B talker, C disperser, D dive, E pwm, plus metal and reese; riddim, yoi, 808 and darkhit routed to S1's code. Per-hit click fixes: talker 23→3, dive 54→0, chomp 23→13 (the rest is a measurement artifact). New: `gun` (3-layer gun shot), `mgun` (1/32 retrigger), a resonance notch on every growl, integer FM ratios on pitched growls | Your verdict per voice (M1.1); the engine's sequencer doesn't use gun, mgun or the disperser yet (M1.2) |
| midbus (S3) | bdf1f73, 2414b2e | `lr4`, 4× `distort`/`clip`, `ott` (the Faust model with the §1.3 numbers), `phaser`, `flanger`, `freq_shift`, `notch_whistles`; `midbus` presets print, chomp, talker, bus; `sub_hz`/`sub_voice`. New: `resample_chain`/`chain_a` (Marauda's chain A: every generation plus a stretch or pitch mangle; printed crest 7–13 dB, aliasing −110 dB), `resonance_notch`, `AXES` + `pick()` | The re-fade (M1.16); one OTT and one sub fold (M1.13); the Ableton OTT option (AX-12) |
| QA (S3) | `main` f3a4d10 + 70fcfc8 | `remix_qa.py` with the SB §5 checks and `--style tearout/riddim/hybrid`; the click rule treats buzz as local regularity | Per-bus stems (M2.7): mid crest and drum loudness can't be judged from a mixdown. Whine, distinctness and switch-up checks; real loudness targets (C12); trap_hybrid targets |
| Engine path (S2) | `help/s2-bassdna` ddb5e29, 0d88f7f, e27d3da, a0a35d8 | prepare dispatches clips by patch_id (`resample:<style>`, `hybrid:<growl>`, `riddim:wub`, `808:dark`, `808:dive`); every rng is seeded from `Remix.seed`. arrange: a 1-beat pre-drop gap; a seeded beat pause (bar 8 or 12, 1–2 beats); trap_hybrid's 2-beat switch-up; the held 808 kept under the engine bass; an 808:dark first hit (2 beats). mixdown: bass lanes split at 120 Hz, sidechain envelopes, the snare window, first-hit +1.5 dB, the impact. `FLIP_STYLES` riddim = SB 2.1. `remix_audition.py`. New: `clip_key` hashes the seed and the clip id for seeded clips | WYHIWYG (C2 → M1.14); styles as data + the axis resolver (M1.7); the QA flags (§2.2 → M1.17); ER gaps (M1.18); clip_key context (C14) |
| Corpus run (S2) | running | 4 recipes × 7 tracks: vip `hybrid:tearout`, flip `trap_hybrid`, flip `riddim`, vip `resample:riddim` | Results → M2.8; no tearout flip yet (C18) |
| Server (S3) | `help/s3-remix` 1465779, 994ffa6, 70ace00 | Every BE v0.11.4 route; `Remix.seed` through create and PATCH (a new seed re-prepares clips); clip cache by clip_key; export (AIFF, MP3, .als BETA, rekordbox.xml, VISUALS Song); merged main (v0.11.8) | ✅ 70ace00: the v0.11.8 routes (feedback, prefs, reset), `Remix.takes` upkeep, and the `choose(axis, weights)` build seam. Next: the v0.11.9 per-take arrangements and the list filters, then the §7.3 weighted draw (C10) |
| App (S4) | `remix/s4-phase1` a537a3a; `remix/s4-takes` aeaade4 | The unstyled REMIX page on the real routes: waveform-playlist playback of prepared clips, A/B against the original, drag-in, the export drawer. **M3.1 ✅ (1b571ec, 9bbb182):** TakesStrip, TakeCard and RollButton on one Remix doc with `Remix.takes`; S5's TakeRating wired in; ~6 takes with starred ones never trimmed; R and 1–6. Perf: stage capped at 60 fps (47af763); flash guard stays synchronous. Release work continues | M3.2 editing (in progress); per-take edits on v0.11.9; SWAP SOUND, markers, REMIX ALL, the mixer, the design |
| UX (S5) | `help/s5-ux` 69e3f7b, 33105d3 | The UX audit is closed. M4.2 is built on v0.11.8: TakeRating, ReasonChip(s), TasteReadout, `takeFeedback.ts` | S4 wires it into TakeCard; then a REMIX UX pass |
| Contracts (PM) | `main` 063bd19, 0a8be85 | **v0.11.9:** `RemixTake.sections`/`lanes` (edits belong to their take), `RemixBuildRequest.fresh`, list filters `?song_id=&recipe=`. v0.11.7 `Remix.seed`. **v0.11.8 is frozen:** RemixTake, TakeChoice, RemixTakeEdit, TakeFeedbackCreate, TakeFeedback, PrefOption, PrefAxis, RemixPrefs(Result), TakeTag, `Remix.takes`, `RemixUpdate.takes`; routes feedback, remix-prefs and reset | `BassPatch.category` tearout/top (a v0.11.10 candidate) |

### 2.2 What QA flags on the older renders, and why (from the code; confirm on stems)

| # | Flag | Likely causes | Fix → check |
|---|---|---|---|
| 1 | No pre-drop gap: −17 to −27 dBFS vs ≤ −40 | `mixdown._impact` lays a reversed crash across the whole last beat at 0.3× the mix peak; `arrange._pre_drop_gaps` keeps the vocals, but QA measures the full band; source tails | M1.17a, AX-02 (swell ≤ ¼ beat) → Q07 on non-vocal stems |
| 2 | The first hit is usually not the hardest | `prepare._match` LUFS-matches the 808:dark clip like any other; mixdown adds only +1.5 dB for one beat, on bass lanes; QA's band (30 Hz–4 kHz of the mix) includes the kick and snare; tearout has no hero hit | M1.17b, M1.2 → Q12 on stems |
| 3 | The snare is never the top peak | `mixdown.loud`'s tanh clipper flattens every peak to one ceiling; the held sub isn't ducked at snares, so sub + snare sum; there's no per-voice snare clip or transient | M1.17c, M1.10 → Q21 on stems |
| 4 | Bass onsets inside the snare window | `resample.RIDDIM` answers at beat 2.0, which *is* the snare (used by trap_hybrid and resample:riddim); notes ending on the snare ring through it after the chain (RIDDIM_MOTIF A (1.5, 0.5), HALFTIME (1.75, 0.25), TEAROUT (1.75, 0.25), the *_SWITCH grids); the source 808 lane is only −4 dB at snares; the duck's recovery edge lands at +1/16 | M1.17d, I6 in the resolver → Q22 on stems |
| 5 | (Predicted; confirm in M2.8) riddim loses its held weight | `resample.riddim_bass` gates the sub per hit (`sub_line`), and riddim flips don't keep the source bass lane | AX-18 held sub (M1.5) → Q27 |

### 2.3 Contradictions between the docs and the code (and how v2 resolves them)

- **C1 · The TAKES model.** v0.11.8 keeps takes inside one Remix (`Remix.takes`, keyed by seed; feedback 404s an unknown seed); S4's `remix/s4-takes` makes **one Remix doc per take**, grouped in localStorage. Only one can ship. **PM decision: one doc with `Remix.takes`.** S4 moved to it (M3.1 ✅).
  - v0.11.9 keeps edits per take: a seed change saves `sections`/`lanes` into the take it leaves, BUILD restores a saved take, and `fresh: true` rebuilds from its choices.
  - The app never auto-trims an edited take.
- **C2 · The app ≠ the export.** BE says what you hear is what you export, and ER put the duck in prepare, but the code applies ducks, the snare window, the first-hit gain and the impact only in `mixdown._drop_mix`, while the app plays the prepared clips. → M1.14.
- **C3 · The pre-drop gap.** SB 1.7's reversed cymbal "ending exactly on the downbeat" (a full beat in `mixdown._impact`) fills SB 1.8's silence; the vocals are kept through it and QA measures the full band. → AX-02 (swell ≤ ¼ beat); Q07 on non-vocal stems.
- **C4 · The first-hit margin.** +0.5 dB (SB §5, live on main) vs +1.5 dB (FP) vs +2 dB (v1); the code gives the first hit no designed margin, and QA's band includes the kick and snare. → I3 = +1.5 dB on bass stems (Q12); design +2..+3 dB.
- **C5 · Snare on top vs held sub vs first hit.** On a full-band mixdown the held sub (R2) dominates sample peaks and the club clipper flattens them, but SB 3.2 expects the snare on top. → Judge on stems: first hit on the bass bus, snare on the drum bus vs the bass bus (Q12, Q21).
- **C6 · The sub, held or gated.** Gated: v1 M1.5 ("gated sine"), SB 1.1 (gate on accent bars), `resample.sub_line`, and the snare gaps in SB 2.1/2.2 and `growls._sub_line`. Held: R2 and FP (≥ 2 bars, only ducked). → Gating is overridden by R2; AX-18 picks among held variants.
- **C7 · Grids put bass on the snare** (against SB 1.4's window): FP's tearout bars 1/2/4 and its riddim WUB and trap WOBBLE rows hit step 9; SB's fixed riddim cell answers on slot 7; `resample.RIDDIM` answers at beat 2.0. → The resolver enforces I6 (the hit moves to step 10+ or drops); §3 shows the grids corrected.
- **C8 · The trap-hybrid pre-drop.** R7's switch-up (`arrange._switch_ups`) fills the last beat, so Q07 fails it by design; SB 2.3's "1 beat of silence with a vocal chop" is replaced. → Q08 replaces Q07 for trap_hybrid.
- **C9 · Pauses.** arrange puts one in every drop and QA expects exactly 1 per 16 bars, against R4's "occasionally"; QA's full-band ≤ −30 dBFS test also fails whenever the vocals carry through. → AX-03 includes "none"; Q28 = 0–1 per 16 bars on non-vocal stems.
- **C10 · The Thompson wording.** The v0.11.8 docstring says ROLL picks the highest Beta(1+up, 1+down) draw, and BE says "with no ratings every option has equal odds, so the default weights decide"; with a pure argmax the defaults stop mattering after the first rating. BE also credits +1 per chosen option regardless of tags. → **PM decision: adopt §7.3** (a weighted draw with a 5% floor and tag-scoped credit). It uses the same float counts, so there's no contract change; the docstrings are aligned on main.
- **C11 · Synth-side choices aren't recorded.** `midbus.AXES`/`pick`, `riddim.r2_blend(seed)` and `bass808.glide_times(seed)` draw inside the voice, so `RemixTake.choices` can't hold them and ratings can't move them. → BUILD resolves take-level axes and passes them down (M1.7).
- **C12 · Loudness targets.** remix_qa's short-term (−12..−4 LUFS) and true-peak (−3..−0.8 dBTP) targets are placeholders, not R9's −7 ± 0.5 / ≤ −1.0. → M2.4f.
- **C13 · Duplicated DSP.** Three OTTs (`midbus.ott` Faust; `growls._ott` target-level; `resample.ott` at 120 Hz / 2.5 kHz with a pedalboard Compressor, which SB 1.3 asked to move to 88.3 Hz); an un-oversampled tanh in `resample.print_shot`; five sub folds (SB C1–A1, `midbus.sub_hz` 30–60 Hz, `resample._sub_hz` 28–56 Hz, `_fold_c1` C1–B1, `groove.render_groove` C1–B1); `mixdown.loud` at 2× (SB: 4×). → M1.13.
- **C14 · clip_key context.** The seed is covered since a0a35d8, but not the context `_engine_bass` reads (whether a bass-stem clip overlaps; the 808:dark spans), so editing those lanes can serve stale engine clips. → M2.2a.
- **C15 · Dead code carrying void rules.** `resample.breakdown` (4-bar breakdown), `changeup` (1-bar change-up), `growls._808`/`_808_body` (a +24 st glide, unreachable behind `_FINISHED`), `resample.render_drop`/`render_hybrid`/`render_riddim` (no callers). → Delete (M1.13).
- **C16 · The hybrid switch bar.** SB 2.5's bar-4 full-bar growl switch is missing (`hybrid_growls` skips every first half-bar, so TEAROUT_SWITCH plays one hit), and the source 808 isn't pulled −3 dB under the growl windows. → M1.8e, M1.9e.
- **C17 · remix_audition grades everything as tearout** (it calls remix_qa without `--style`). → M2.1b.
- **C18 · No TEAROUT flip.** DU1's GENRE FLIP cards and the corpus run have none, though tearout is a headline style. → **PM decision: add a TEAROUT flip style** after M1.7 (drums on the tearout grid, gun-shot/hero bass), and a TEAROUT card in the next design update.

---

## 3. The sound spec, engine-ready

### 3.1 Layers (SB 1.1, FP §0)

| Layer | Content and numbers | Home |
|---|---|---|
| **SUB** | A mono sine, one voice, continuous phase through glides. 30–60 Hz with the root forced into C1–A1 (32.7–55 Hz; B and A# fold to B0/A#1). Gate A 2–3 ms, R 10–20 ms; LR4 LP 120 Hz (LP 90 Hz when it's built from the source's 808 [FP]). Level: match the original drop's **30–90 Hz RMS** ±1 dB, not its LUFS. No OTT, clip, reverb or wobble; an optional 1–2 dB tanh only at 4× | `midbus.sub_hz`/`sub_voice` ✅ (S3); every other fold moves onto it (M1.13) |
| **808** | Replaces the SUB: **one low-end owner at a time** (I7). Numbers in §3.9. Root in C1–G1; kick transient under 100 ms, 12–15 dB below the 808 | `bass808` ✅ (S1); arrange keeps the source 808 stem ✅ (S2) |
| **MID** | A designed patch or resample slices. LR4 HP 120 (range 100–150), mono below 200 Hz, the full §3.2 chain. Tearout: at most **1** mid voice per step [FP]; riddim: at most 2, counting the squeak | `growls`, `riddim`, `midbus` ✅ (S3/S1); `resample` (S2) |
| **TOP** | Arp, lead, squeak, ear candy, FX. Sides only above ~200 Hz; free width above ~7 kHz; chorus 15–25% mix between 650 Hz and 7 kHz; squeak BP 2–5 kHz at about −10 dB | `candy` ✅, `riddim.render_squeak` ✅ (S1); wiring M1.6 (S2) |

**Held weight (R2): the sub holds, the mids chop.**
- ≥ 1 bar of held sub or 808 per 4-bar phrase (I1); FP targets held notes of ≥ 2 bars.
- The sub is ducked at kicks and snares, never gapped. ~~SB 2.1/2.2 SUB gaps at the snare~~ and ~~SB 1.1's riddim sub that follows the gate~~ are **overridden R2**.

### 3.2 The MID bus chain (SB 1.2; `midbus.midbus` ✅, S3)

Level-match after every stage (denser, not louder). Every nonlinearity runs 4× oversampled; 8× for a hard clip [FP].

```
[patch / slices]
 → formant, vowel or comb stage (before any distortion)
 → LR4 HP 120 Hz
 → Distortion #1, 4x: hard/diode 18-24 dB on prints; 9-12 dB on a riddim bus [FP]
 → movement (AX-25): phaser (1/2 synced, fb 0.6, mix 0.5) | flanger 1-5 ms fb 0.7 | freq shift ±20-200 Hz
 → Distortion #2, a different mode: tanh 6-12 dB, 4x
 → OTT (§3.3): 0.6-1.0 on design prints, 0.4-0.6 on a bus
 → EQ: LR4 HP 120 again; -3 dB @ 400 Hz Q 1; notch_whistles (1-2 whistles, -4..-8 dB, Q 6-10);
       resonance_notch (the tallest 2-4 kHz peak -4..-8 dB at Q 8, plus a 3.5 dB dynamic cut); -2 dB @ 3 kHz
 → sidechain (§3.4)
 → clip: 1-3 dB of peak reduction on a bus, 4x
 → re-fade: raised cosine 3 ms in / 10 ms out, because the filters ring past the note (M1.16, S1's finding)
```

- **Presets ✅:** print: dist1 20 hard, flanger, dist2 8, OTT 0.8, clip 3; chomp: dist1 24 hard, dist2 6, OTT 1.0, clip 3; talker: dist1 20 diode, phaser, dist2 8, OTT 0.8, clip 2; bus: OTT 0.5, clip 1.5.
- **Drive budget:** 24–30 dB in total across the stages suits design prints (the main layer clipped by about 30 dB [P]). On a bus, keep it to 1–3 dB.

### 3.3 OTT (SB 1.3; `midbus.ott` + `OTT_BANDS` ✅, S3)

| Band | Split | Down thr | Down ratio | Up thr | Up ratio / max | Attack | Release | Out gain |
|---|---|---|---|---|---|---|---|---|
| Low | < 88.3 Hz | −33.8 dB | 66.7:1 | −40.8 dB | 4:1 / +36 dB | 47.8 ms | 282 ms | +10.3 dB |
| Mid | 88.3 Hz–2.5 kHz | −30.3 | 66.7:1 | −41.8 | 4:1 / +36 | 22.4 | 282 | +5.7 |
| High | > 2.5 kHz | −35.5 | ∞:1 | −40.8 | 4:1 / +36 | 13.5 | 132 | +10.3 |

- **Behaviour:** Input +5.2 dB; a stereo-linked one-pole detector on (L²+R²)/2, updated every 16 samples, looking ahead by the attack; it starts settled, and silence stays silent below −90 dB; `depth` is the wet/dry blend; `time` scales the release.
- **Depth by use:** Design prints 0.6–1.0, a bus 0.4–0.6 [SB]; riddim 30–40% [FP, 3P] (SB: 0.4 bus / 0.8 prints); tearout chain A 0.4 [FP]; trap wobble 25–35% [FP]; master ≤ 0.1.
- **On Demucs slices:** gate below −40 dBFS first, then use depth 0.2–0.3 [SB INF]. Upward gain lifts bleed by up to 36 dB.
- **Model:** the table is the Faust model, which SB picked over the Ableton preset (the two "disagree slightly") → AX-12. The Ableton option sits at weight 0 until S3 transcribes its numbers from the two cited sources.
- **Fold in (M1.13):** `growls._ott` (a target-level squash, depth 0.2–0.35) and `resample.ott` (120 Hz / 2.5 kHz; pedalboard `Compressor` −24 dB 4:1 plus an upward stage at −38 dB).

### 3.4 Sidechain as envelopes (SB 1.4, FP §0)

We know every hit time, so these are gain envelopes, not an audio compressor.

| Target | Trigger | Depth (axis) | Attack | Hold | Release | Source | Code today (`mixdown._drop_mix`) |
|---|---|---|---|---|---|---|---|
| SUB | kick | **AX-10 A:** −10 dB (range 8–12) | 1–3 ms look-ahead | 20 ms | exponential 120–150 ms | SB | ✅ −10 dB, 2 ms, 20 ms, 130 ms |
| SUB | kick + snare | **AX-10 B:** −2..−4 dB | fast | – | 60–80 ms | FP (tracksensei) | – |
| 808 | kick | **AX-11 soft:** −2..−3 dB | 1 ms | – | 80 ms | SB ("plays with the kick") | ✅ −2.5 dB |
| 808 | kick | **AX-11 hard:** −4..−6 dB | – | – | 50 ms | FP trap risk 1 | – |
| 808 | – | **AX-11 kickhp:** no duck; HP the kick at 50 Hz | | | | SB | – |
| MID | kick | **AX-09:** −6 dB (SB) or −2..−4 dB (tracksensei); other sources say 1–2 | 0.5 ms | – | 1/16 (100 ms @ 150) | SB, FP | ✅ −6 dB, 0.5 ms, 100 ms |
| MID | snare/clap | −4 dB **plus the window** | 0.5 ms | – | 100 ms | SB | ✅ −4 dB; synth_bass also −12 dB from 1/16 before to 1/16 after |
| First hit | – | **No duck on the drop's first kick;** layer the kick instead | | | | SB 1.7 | ✅ `KICK_FIRST` = 1/16 |

- **The window (I6):** No mid onset from 1/16 before a clap to 1/16 after it. The mid ends ≥ 1/16 before and re-enters ≥ 1/16 after (the chequerboard); it applies to **every** clap position of the style's grid, not only step 9.
- **Release limits:** ≥ 250 ms smears into the next 1/8, and < 70 ms clicks, so FP's 60–80 ms is clamped to 70–80 ms.
- **Replace, don't stack:** remove the source's baked-in pump before the new ducks. In a flip, the kept source 808 still carries its old pump at the old kick positions (a known ceiling; ponytail note).
- **Keep the low end fast:** a light kick-bus squash (§3.11), following Subtronics on low-end attenuating speed [P].
- **Home:** this processing moves into prepare, per clip, in M1.14.

### 3.5 Master and loudness (SB 1.5; `mixdown.loud` + `master.master` ✅, S2)

- **Chain:** HP 25 Hz → mono below 120 Hz → OTT ≤ 0.1 → soft clip (tanh) 1–3 dB → BrickwallLimiter (release 50–100 ms, ≤ 3 dB GR on the drop) → true-peak check at 4×. Today: `loud()` is a 2× tanh clipper, its drive bisected to a short-term target of −7.5, then `master(club, −7, −1 dBTP, mono < 120)`. Move the clipper to 4× (M1.13).
- **Targets (R9):** Drop short-term max **−7.0 ± 0.5 LUFS**, TP ≤ −1.0 dBTP, GR ≤ 3 dB; the mix bus peaks around −6 dBFS before the master; ~~Pro drops −6..−3 LUFS~~ **overridden R9**: expect ours to read a little quieter at matched gain (the accepted trade).
- **Contrast:** The build 4–6 LU under the drop (Q05); the source's own intro 8–10 LU under it (info, Q06); ~~An inserted breakdown 8–10 LU under~~ **overridden R3**.
- **If GR > 3 dB is needed,** the buses are under-prepared: fix the buses, not the master.
- **Drums:** match the kit to the original drum stem over the same bars, ±1 LU, before the bus stages (Q31; today it's −12.4 LUFS).
- **MP3:** `remix_audition._mp3` re-encodes until the decoded file holds ≤ −1 dBTP ✅.

### 3.6 Tempo and the grid (SB 1.6, R8)

| BPM | 1/4 | 1/8 | 1/8T | 1/16 | 1/16T | 1/32 | bar |
|---|---|---|---|---|---|---|---|
| 140 | 429 ms | 214 | 143 | 107 | 71 | 54 | 1.714 s |
| 145 | 414 | 207 | 138 | 103 | 69 | 52 | 1.655 s |
| 150 | 400 | 200 | 133 | 100 | 67 | 50 | 1.600 s |

- **Remix tempo = the source's.** `arrange.build` keeps it whenever the style tempo is within ±15% ✅; a source read at 70–75 counts as ×2 (the DJ's `bpm_override`); a mashup must honour `tempo_ratio` (M1.18); outside every window, BUILD uses AX-08 only if the stretch stays ≤ ±15% (I10); otherwise it keeps the source tempo, uses a half-time grid and warns; ~~SB's keep-within-±5% and ±10% cap~~ and ~~each style's fixed default BPM~~ are **overridden R8**.
- **Re-trigger, don't stretch.** Drums and one-shots are re-triggered at grid times; Rubber Band R3 is for tonal stems; drums use R2 crisp and keep their pitch ✅; one-shots are re-pitched by varispeed (`resample._pitched`); the speed change is part of the sound.
- **Drop entry:** fade-in ≤ 1/64 beat (`CUT_BEATS` ✅); the onset within ±5 ms of the grid (Q10); 0 bars late (Q11 ✅).
- **The grid:** 1 bar = 16 steps of 1/16; the half-time snare is on step 9; the 1/8T grid has 12 slots per bar, with the snare on slot 7; `foxsynth.sync_hz(div, bpm)` gives the LFO rates; 4/4 only in 1.5 (`beats_per_bar` is ignored; M1.18).

### 3.7 TEAROUT (Cyclops-era Subtronics, Marauda, Kai Wachi)

- **Identity:** Heavy half-time: short, metallic, resampled hits in call and response, with real gaps; sounds switch in sequence and are never stacked: at most 1 mid voice per step, plus 1 top voice ≥ 1 kHz; a clean held sub underneath; the metallic "pan" snare stands alone on step 9; Subtronics' rule: "Loud, quiet, loud" [P]. Heaviness means grimy depth, not bright screech [P Kai, paraphrased].
- **Tempo:** the source's. AX-08 when not following: 140 [3P Marauda/Kai] · 145 [FP] · 150 [P Subtronics pack; SB]. ~~150 or 145 default~~ **overridden R8**.
- **Key:** minor, the source's. Pitched growls use integer FM ratios (0.5, 1, 2, 3); non-integer ratios go only on transients ✅ (0074395).

**Voices** (`growls.render_growl`, S3). Each voice runs its own §3.2 chain, and `_finish_voice` then sets −13 dBFS RMS, LP 10 kHz, side above 1 kHz and 4/12 ms fades.

| Voice | Code | Recipe | State |
|---|---|---|---|
| A chomp | `_voice_chomp` | A feedback sine (fb 0.2–0.4) at root +12/+24, plus a sine 5th at −6 dB; pitch env +24 → 0 st, exponential, over 25–40 ms; dist 24 hard → OTT 1.0 → clip 6 → HP 120 → OTT 0.5 → notch | built; verdict L1; the snap is AX-26 |
| B talker | `_voice_talker` | Root +12 with PM ratio 0.5; index stepped on 1/16 (rasp 1.5–3, or scream 4–8 on 30% of hits); a saw or sine carrier; vowel paths ioi/ua/aoi/oai/iau/eoa (F1/F2/F3 at Q 8/10/12), stepped on 1/16 with 3 ms glides; bounce on 1/4T; midbus "talker" | built |
| C disperser | `_voice_disperser` | A saw chomp (+12..+24 → 0 st over 20–40 ms) through 16–64 allpasses at 150–400 Hz, Q 0.7–4; LP 4 kHz → 300 Hz per shot; retriggered on 1/16 (60%) or 1/8T with 3 ms joins; midbus "print" | built |
| D dive | `_voice_dive` | A chomp seed driven tanh 12 + 6 dB into a 1/32 or 1/16 loop (fb 0.7–0.9, HP 150 inside); an SSB shift of 0 → −300..−800 Hz across the note; gated at the next downbeat | built |
| E pwm reso | `_voice_pwm` | A pulse at root +12, width 30 ± 20% on 1/8; a 24 dB LP at 300 + 2200·e^(−t/≈1/16) Hz, resonance 60–75%; OTT 1.0 → clip 4 → HP 120 | built (the drop-2 family) |
| F gun | `_voice_gun` | (a) a 5–20 ms metal clang; (b) an FM burst at a non-integer ratio of 1.41–3.5, index 5–9 → 1 over 30–80 ms, amp over 80–200 ms, through chain A 1–2×, then silence; (c) an 80 ms root sine, ducked under the held sub | built 0074395; not sequenced yet |
| G mgun | `_voice_mgun` | Burst (b) every 1/32, ±1–2 st per repeat, each 5–15% quieter; a burst lasts ½–1 beat (3–6 hits) | built; not sequenced yet |
| metal | `_metal` | FM (ratio 2, index 2–4 on a 1/8T LFO) → an SSB up-shift of 37/80/150/60 Hz that decays → integer ring mod → sine fold → OTT → BP 500·6^lfo | built |
| Hero hit | new (M1.2b) | The widest and longest print, 400–700 ms (~1.5 beats), with every generation layered; +2..+3 dB over every later hit. **Only drop bar 1, beat 1** | to build |
| Legacy states | `_tearout` | growl/screech/dive/stab per hit; FM ratio from {0.5, 1, 2, 3}; fold 0.7–1.5; LFO 1/4–1/16; tail dives of {0, 5, 7, 12, 19, 24} st | live in `resample:tearout` for growl-less sources |

**Grids** (one bar, 16 steps; every hit that sat on step 9 moves to step 10 under I6):

```
                  1   5   9   13
KICK              x.........x.....   step-11 push optional [FP]; SB bar 2: x.....x.......x.
SNARE (pan)       ........X.......   alone: no mid onset on steps 8-10 (I6)
HAT               ..x...x...x...x.   quiet 8ths, swing 55% [FP]; SB: 8ths, bar 2's last beat in 1/16
SUB               ================   held root >= 2 bars, ducked on 1 and 9 (SB's snare gap: overridden R2)
T-SB   call A     xxx...x.........   3/16 chomp on 1, stab on 7                          [SB 2.2]
       resp B     .........xx.x.vv   10-11, 13, dive 15-16
T-FP   bar 1      H=====...ss....s   H = hero (drop bar 1 only); gun shots from step 10   [FP, corrected]
       bar 2      s..s.s...mmmm...   m = 1/32 machine gun, pitch-stepped (FP had 9-12)
       bar 4      s..s.s...S===.rr   S = scream stab (FP had step 9), rr = a roll into bar 5
T-code            x=.xx=x...xxx=x=   resample.TEAROUT (its step-8 hit rang into the snare: removed)
MACHINE-GUN bar   chomp 1-2 | C/G x6 on 3-8 | snare alone on 9 | 10-15 ratchet 1/16 -> 1/32 (8 hits) | 16 silent  [SB]
```

**The drop, bar by bar (R3: no breakdown):**

| Bars | MID (growls) | Low end | Drums | Checks |
|---|---|---|---|---|
| gap | Silence of ½ or 1 beat (AX-01), returns killed; an optional source vocal cue or a ≤ ¼-beat swell (AX-02) | out | out | Q07, Q09 |
| 1 | **Hero hit** → silence → 2 gun shots (the call) | the held sub starts (root, ≥ 2 bars); the first kick isn't ducked | kick + impact + the pan snare alone on 9 | Q12, Q34 |
| 2 | Response: gun shots, then mgun on steps 10–13 stepping down, then a gap | holds | | bars 1–2: ≥ 30% silent 1/16 slots |
| 3 | The call on a **different generation**, at normal level | holds | | Q25 |
| 4 | Response with a new answer (a scream stab or a reverse hit) | holds | fill (AX-05): metal/snare roll or D dive | |
| 5–7 | Bar 5: the call on the second family (AX-22). Bar 6: guns + mgun stepping up. Bar 7: a pitch-dive growl (−12 st over 1 beat) | re-struck on 5 | | |
| 8 | The big switch: the second half is the machine-gun bar [SB]; the pause (AX-03/04) takes out drums **and** mids while the sub tail rings [FP] | tail | stop; back on 9 | Q28 |
| 9–15 | The same skeleton; every sound moves to its next generation, or a new call family (AX-24); bars 13–15 in a switch state | re-struck on 9 and 13 | bar-2 kick variation | Q26 |
| 16 | A glitch (1/8 → 1/16×2 → 1/32×4 → 1/64×8 with a +12 st ramp) or a tape-stop (rate 1 → 0.25 over the last beat) (AX-07) | | | |
| drop 2 | A different family: C + E instead of A + B [SB] | | | |

- ~~FP's breakdown bars B1–B4 (filtered drums, a riser, a snare roll)~~ **overridden R3**.
- **Cadence:** small every 4 bars (the bar-4 fill), big every 8 (the bar-8 switch), a new family for drop 2. The variation follows a call-and-response skeleton you can learn, never random switching [FP].
- **Mistakes to avoid:** aliasing (use 4× everywhere); stacked patches; unnotched 2–4 kHz whistles; a sustained LFO wobble from bar 1; single-pass renders; low end inside the mids, or a distorted sub; out-of-key growls; no gaps (Subtronics wants shock and contrast [P]); squashed kicks; random switch-ups; build tails bleeding into beat 1, or drop 1 not being the strongest variant; hours spent on one bass (build a bank and reuse it).

### 3.8 RIDDIM (Level Up, early Subtronics)

- **Identity:** Minimal, repetitive and wonky: one 1–2-bar wub motif through the whole drop, varied only by pitch, delay or a dropped hit. Subtronics calls riddim "far more minimal, repetitive and wonky" [P]; real silence, a clean held sub, a clap-led groove; bass only in the drop: no melody or chords [P-adj DEFINITIVE]. The eerie melody belongs in the intro and build [P Level Up].
- **Tempo:** the source's; AX-08: 140 [P Subtronics pack; P-adj Infekt] · 145 [SB; Level Up 145–150]. A 150 source is followed and played half-time [FP]. ~~140/145 defaults~~ **overridden R8**.
- **Pitch vocabulary [SB]:** About 80% of hits on the tonic (the wub sits at root +12); accents from {+12, +7, +1, +6, −2}; about 1 in 4 notes ends with a −12..−24 st glide over its last third; BASS DNA is snapped to this vocabulary; **the source line is never replayed.**
- **Why it read as trap, and the fix (R11):** The chopped 808 led the rhythm → a designed wub leads, and the 808 becomes only the held sub, LP 90 Hz; 808 glides → none; one root per 2–4 bars; a syncopated kick → kick on 1 (+ a ghost) or kicks on the quarters (AX-14); a big snare on 3 → clap-led; hat rolls as a feature → plain hats; a roll only as a bar-8 fill (trap-style hats are allowed [P]); a melodic top line → none in the drop; a one-note squeak is fine; a big riser build → the original build as is.

**Voices (S1):**

| Voice | Code | Recipe | State |
|---|---|---|---|
| R1 square-FM wub | `riddim.r1` | **SB:** square PW 50% at root +12; sine FM 1:1 (0.5 = throat), 15–25% at rest → ~40% at peaks; Comb+ 300–900 Hz (1.1–3.3 ms), fb 60–80%, mix 60%, ±12 st; LP 24 dB 4–6 kHz, res 15%; amp A1 D200 S100 R15; each hit gated at 60–90% of its slot; pitch +12 → 0 st over 30 ms; LFO1 restarted per note, an exponential saw-down (open at the start, shut for the last 30%) driving amp 60–100% and FM +20–35 pts; LFO2 at half rate drives the flanger mix. **FP:** FM index 0.3–0.8 (maxed reads as noise); a 1/4 LFO as the main rate on filter and amp; medium 2-stage drive 9–12 dB at 4×; comb 1–5 ms, fb 0.6–0.8, mix 25–40%; freq shift ±20–80 Hz at 20–30% plus delay [P snippet]; flanger/phaser 1/2, fb 50–60%, mix 30–50%; OTT 30–40%; soft clip; HP 100–120. **Code:** ratio 1.0; rasp 0.3 → ~45% by the LFO; a +12 st click (τ 8 ms); Comb+ 440 Hz ±12 st, fb 0.7, mix 0.6; LP 5 kHz (2 biquads, Q 0.8); a 2 ± 1 ms flanger with its mix on LFO2; tanh 2 at 4× → OTT 0.35; amp 0.6 + 0.4·lfo; the variant is the rate (1/4, 1/4T, 1/8, 1/8T) | ✅ |
| R2 yoi | `riddim.r2` | A saw into 2 BPs at Q 8–10 on the formants u 250/595, o 360/640, a 850/1610, e 390/2300, i 240/2400 Hz; u→a→i or i→o→i once per 1/8T LFO cycle, back to the start in the last 15%; + 0.5 plain saw; tanh 3 at 4× → OTT 0.3; mixed 30–50% under R1 (`r2_blend(seed)`) | ✅ |
| "d" hit | `riddim.late_with_delay` | 1–2 per bar, pushed +1/32 (up to +1/16) late, with echoes every 1/16 at fb 0.4, each darker (off-grid delayed basses [P]); with drums B, cap the push at +1/32 (I6) | ✅; S2 places them (M1.4c) |
| Squeak | `riddim.render_squeak` | R1 one or two octaves up, BP 2–5 kHz, −10 dB, a little wide; follows the wub accents (AX-21) | ✅ |
| Sub | `midbus.sub_voice` | A held clean sine at the root (C1–A1), each note ≥ 2 bars, re-struck per AX-18, ducked per AX-10, never driven; an optional ¼-note amp bounce ≤ 30% [3P]. ~~Gated per hit (`sub_line`, v1 M1.5)~~ **overridden R2** | M1.5b |
| Heavy mode | `r1(heavy=)` | A 20–30 dB oversampled hard clip on the main layer [P]; off by default (AX-19) | to add |

Print chain [SB]: dist 20 + 8 dB, flanger 2 ms fb 0.7, OTT 0.8, and a 10-bit bitcrush at 20% in parallel [INF]. The bus uses FP's medium drive with OTT 0.3–0.4.

**Grids** (drums are AX-14, bass grids AX-15; the resolver pairs them under I6):

```
Drums A "half-time whack" [SB 2.1; flip.FLIP_STYLES['riddim'] today]
                 1   5   9   13
KICK (LP 3-5k)   x.......g.......   g = ghost kick -9 dB under the clap
CLAP (lead)      ........X.......
HAT              ..x...x...x...x.   offbeat 8ths v0.8; hat-on-kick -9 dB
bar 2 KICK       x.............x.   pickup on 15 at v0.7; HAT beat 4 = six 1/16T hits v0.4 -> 0.8
Drums B "quarter seesaw" [P Subtronics, paraphrased: kicks on the quarters, claps on the off beats]
KICK (LP 3-5k)   x...x...x...x...
CLAP             ..X...X...X...X.
HAT (-9 dB)      x...x...x...x...   quiet quarters, or none
Drums C "backbeat seesaw" [v1's reading of the same quote]
KICK             x.......x.......   + ghost kicks under the claps
CLAP             ....X.......X...
Bass R-SB (1/8T: 12 slots, clap on slot 7; A = R1, B = R2 or a print)                   [SB 2.1]
         1 2 3 |4 5 6 |7 8 9 |10 11 12
Bar 1 A: x - . |. . . |. x - | .  .  .
      B: . . . |x . . |. . . | x  x  .
Bar 2 A: x x . |. . . |. x~v| .  .  .      slot 8: a 2-slot hit, bend -12 st
      B: . . x |. . . |. . . | .  x  x     slots 11-12: LFO 1/16T
Bass R-FP (16 steps, made for drums B: wubs on the quarters, one 'd')                     [FP]
WUB call         X===x=..x=.d....   with drums A, the step-9 x moves to step 10
WUB resp         x===....x=x=..x.
SQUEAK           x.......x.......   follows the accents (TOP layer, >= 1 kHz)
Bass R-code (resample.RIDDIM_MOTIF; the step-7 note shortened to end 1/16 before the clap)
bar A            x===..x....x=...   rates 1/8T, 1/4, 1/8
bar B            x=.x==....x===..   rates 1/4T, 1/8T, 1/8T
Bass R-cell [SB]: xx. ... xxx ..x (1/8T); the answer moves off slot 7 to slot 8 (I6)
Bass R-332 [SB]:  A..A..A...BB.A..  ("3+3+2" in 1/16)
SUB              ================   the held root, ducked at the kick and clap
```

**The drop, bar by bar (FP rewritten under R3):**

| Bars | Wub | Sub | Drums |
|---|---|---|---|
| gap | Silence of ½ or 1 beat (AX-01/02). ~~FP's eerie 3-bar breakdown and SB's 1-bar fake-out~~ **overridden R3** | out | out |
| 1 | **The first hit:** wub hit 1 with the full stack (R1 + R2 + squeak) at +2..+3 dB; then the motif (the call) | the held root starts (≥ 2 bars); the first kick isn't ducked | kick + clap per grid + impact |
| 2 | The response phrase, with one `d` hit | holds | |
| 3 | Bar 1's phrase at normal level | holds | |
| 4 | Bar 2 with **one** change (e.g. the last wub +12) | holds | fill (AX-05): a 1/8T perc flick |
| 5 | Bar 1 | re-struck | |
| 6–7 | Bars 2–3; bar 7 doubles the squeak, or puts new LFO rates on 1–2 notes / moves B +5 or +7 [SB] | holds | |
| 8 | The pause (AX-03/04): wub + sub on beat 1; drums out on steps 5–12 while the delay tail and sub ring; a triplet snare flick on 13–16 [FP]. Or a scratch fill [SB INF] | tail | |
| 9–16 | Bars 1–8 with one swap (AX-20): R2 leads or +5 st [FP]; or SB's switch state on bars 13–16 (classic wobble / growl call-response / the 4-bar techno switch); bar 16 per AX-07 | re-struck on 9 and 13 | |

- **Cadence:** one change per 4 bars. Repetition is the identity, so Q26 is inverted for riddim: motif similarity ≥ 0.8 over bars 1–4.
- **Mistakes to avoid:** too many layers (his "hundreds of layers" aren't riddim [P]); going harder and harder instead of keeping the groove [P-adj]; melody or chords in the drop; filling every grid line; dead quantization; overthinking the patch; trap tells (R11); the old 12 × 1/8T hat carpet (removed ✅ 3be46a9).

### 3.9 TRAP-HYBRID (Tape B, with Kai Wachi's hip-hop package)

- **Identity:** "Old school × new school": UKF-era wobble and hip-hop energy over trap drums; a big held 808 with glides allowed; hat rolls (1/16, 1/32, 1/16T); a half-time snare on 9; vocal tags in the gaps; a gritty drum bus; Kai Wachi calls hybrid trap "the full package" [P]: a hip-hop intro and gritty drums; Tape B's tests: a fun hook, and it has to hit live [P].
- **Tempo:** the source's; AX-08: 150 [3P] · 140 half-time. ~~145 outside 138–150 (SB)~~ **overridden R8**.
- **Pre-drop (R7, `arrange._switch_ups` ✅):** The original build → the original pre-drop hook → **a 2-beat switch-up**. Everything but the vocals ends 2 beats early; beat −2 is a 1/16 snare stutter (v 0.5 → 0.89); beat −1 is `808:dive` (a +5 st blip, then −19 st over the beat), gated at the downbeat; then the dark, long first hit; ~~A 1-beat silence holding a vocal chop (SB 2.3)~~ **overridden R7**. QA uses Q08, not Q07.

**Voices:**

| Voice | Code | Recipe | State |
|---|---|---|---|
| 808 line | `bass808.render_808_line` | Up +5..+7 st with τ 8–9 ms (settled ≤ 30 ms); held (S 90%, R 150 ms) or a one-shot with a ~3 s decay, by variant; legato glides only where notes overlap, 60–100 ms up to 7 st and 180–300 ms beyond (`glide_times(seed)`), clamped to ±12; parallel saturation: tanh 10–14 dB at 4×, LP 400 Hz opening from 150 Hz over the attack, mixed 0.6. ~~+24 (to +36) st over 60–120 ms (SB 2.3)~~ **overridden R6** | ✅ (S1); engine M1.12 |
| Dark first hit | `bass808.render_darkhit` → `808:dark` | On pitch from sample 1; env 0.7 + 0.3·e^(−t/half the note); an LP bloom from 80 Hz to 0.8/1.2/2 kHz over 50–90% of the note; tanh 16 dB; grit = a 6 kHz, 6-bit crush at 0.15–0.3; an optional octave layer at 0.12; 0.3 s release; length AX-27 | ✅ |
| 808 dive | `resample.eight08(dive_st=−19)` → `808:dive` | The switch-up dive; its blip is +5 st / 30 ms | ✅ |
| Source 808 | the bass lane | Its held notes and glides are the original's weight (R2); exaggerated in the hybrid: HP 90 → tanh 5 → BP 90–1500 Hz, mixed 0.6 | ✅ |
| 808 chops as accents | `resample:trap_hybrid` | Slices at held-808 onsets, 1/8–1/4 long, within ±4 st; fades 5–10 ms in / 10–20 ms out; HP 120 (the code uses 100) and +12 st varispeed (the code keeps the shot's octave); never layered with the old 808's sub (`with_sub=not held` ✅) | ✅; fixes M1.9 |
| Old-school wobble | new `wobble.py` (M1.15) | A saw at −1 oct (unison 1–2, low detune) + a sine 1–2 oct down FM'd at 25% (cap 40%); a 24 dB ladder LP, base 200 Hz, swept 150 Hz → 1.5 kHz, res 30–45%; an MSEG LFO (slow rise, fast fall) that also drives FM at 50% of the cutoff depth; dist 8–14 dB; −3 dB @ 3–5 kHz; −2 dB @ 300–500 Hz. FP adds OTT 25–35% and HP 150. The LFO rate is per note, at most 3 rates per bar | to build (S1) |
| Downsample wub | new `wobble.py` (M1.15) | The same core; a 1/2 LFO with a drawn 3–4-step shape on cutoff (250 Hz–1.2 kHz), formant and FM; a small second LFO at 1/8 or 1/8T; a zero-order hold at 6000–11025 Hz before the distortion; the §3.2 chain with 15–25% chorus | to build (S1) |
| Drum bus | M1.10 | Saturation 3–6 dB + a parallel 8:1 compressor at 30% [FP]; the 808 kick (AX-31); a UK snare (clap −8 dB, −1 st; AX-30) | M1.10 |

**Grids:**

```
SB 2.3 (2 bars, 1/16)
Bar 1  808   R------. ..R--~+7-.   released at 8 so the snare hits in silence; the +7 glides 80 ms
       KICK  x....... ..x.....
       SNARE ........ x.......
       HAT   x.x.x.x. x.x.x.x.     swing 54-58%; drop 2: 16ths at v60-127
Bar 2  808   R------. ....+12~R--  an octave stab on 13, a 240 ms glide down
       KICK  x....... ......x.
       SNARE ........ x......g     a ghost on 16 at v0.6
       HAT   8ths; the last beat a 1/32 roll (8 hits, v60 -> 127, +2..+5 st) or 1/16T (6)
FP (1 bar at 150)
KICK (808)       X.....x...x..x..
SNARE            ........X.......
HAT              x.x.x.x.x.x.xrrr   rolls from step 14 only
808              X===========..x=   held, gliding into step 15
WOBBLE           ..x=x....x=.x=x.   the step-9 hit moved to 10 (I6)
VOCAL chop       ....x.........x.   in the gaps
Held weight (R2): at least 1 bar per 4-bar phrase holds the 808 THROUGH the snare (ducked, not released);
SB's release-at-8 bar is used for bars 2-3 of a phrase only.
```

**The drop, bar by bar (FP rewritten):**

| Bars | Mids | 808 | Drums |
|---|---|---|---|
| −2..0 beats | the switch-up (R7) | dive | stutter |
| 1 | A wobble stab + the impact, at +3 dB | **`808:dark`** (AX-27), then the source's held 808 for the rest of the bar | 808 kick, snare on 9 |
| 2 | The wobble answers | re-triggers, gliding up a 5th on step 15 | a syncopated kick |
| 3 | Bar 1 at normal level; a vocal chop on steps 5–8 | held | |
| 4 | | slides down an octave (240 ms) | a 1/32 hat roll on the last beat |
| 5–7 | Bars 1–3 with the wobble LFO at 1/8T | | |
| 8 | The pause (AX-03/04): drums cut on beats 2–3; the 808 tail and a vocal tag alone; a snare flam into bar 9 [FP] | tail | |
| 9–16 | Drop 1 stays sparse [SB]: wobble + 808, swung 8th hats, a chop every 4 bars, 808 slides in bar 4 of each phrase. Drop 2 alternates every bar between [wobble/wub] and [808 + trap rolls + chop]; bars 9–16 use the downsample wub | | |

- ~~Drop 1 as "wobble plus a clean sine sub" (SB 2.3)~~ **overridden R2/R11**: the 808 owns the low end in this style.
- **Mistakes to avoid:** the 808 swallowing the drums (use AX-11 hard, or HP the kick); riddim or tearout markers leaking in (the seesaw, gun shots); dubstep with 808s swapped in (Kai's point is the whole hip-hop package [P]); rushing [P Tape B]; keys: B plays badly on club systems, E/F/D are the norm [P Kai]. This is advisory only, since we follow the source key.

### 3.10 808 VIP and the HEADLINE hybrid (song-1's dream remix)

- **808 VIP (SB 2.4):** The source's own held 808 pattern and notes (quantized), made enormous and bouncing, with tearout growls as punctuation; one low-end owner: under the growls the 808 holds at −3 dB, or rests; a change every 4 bars, a big switch every 8. **Never loop 1 bar for more than 4 bars.**
- **HEADLINE (SB 2.5):** An 808-only source (song-1's growl band sits around −28 dB) keeps and exaggerates its 808, answered by designed growls A/B/C, printed and resampled; code: `hybrid:tearout` = `resample.hybrid_growls` ✅. The chomp calls and talkers answer, only in each bar's second half; two gaps remain (C16).
- **BASS DNA → 808 (M1.12)**, for a weak source 808 or a quantized VIP:
  1. Quantise note starts to 1/16 (minimum length 1/16) and merge same-pitch neighbours into legato.
  2. Snap to the key scale within an octave of the root; fold the root into C1–G1.
  3. **Keep the multi-second held notes.** Split them only at bar lines, and only for I6.
  4. Glide only where the source had one, or where a template marks `~`.
  5. Render with `render_808_line`.

**Phrase template** (4 bars, repeated with variation; rewritten for R5, R6 and R10):

```
Bar 1 FIRST HIT + CALL : 808:dark on beats 1-2 (on pitch, bloom), kick + impact, first kick not ducked;
                         growls answer on steps 10-16:  .... .... .xx. x.vv           (AX-28: or a +1..+2 dB
                                                                                       mid stab on the downbeat, SB 1.7)
Bar 2 GROWL RESPONSE   : the 808 holds the root (-3 dB under the growls); growls on steps 10-16
Bar 3 808 CALL'        : the octave stab + glide (SB 2.3 bar 2); a 1/32 hat roll on the last beat
Bar 4 GROWL SWITCH     : A chomp 1-3, C machine gun (or G mgun) 3-8, the snare alone on 9, B talker 10-14,
                         D dive 15-16 into the next downbeat; the 808 holds at -3 dB           (missing today: C16)
Kick on 1 (+11 in bar 1, +15 in bar 2); the snare on 9 in every bar.
```

- **Overridden:** ~~The 808's longest note with the full +36 st click (SB 2.5 first hit)~~ **overridden R6**: use `808:dark`; ~~Growls out until bar 2 (SB 2.5)~~ **overridden R10**: growls are in bar 1.
- **16-bar drop:** Bars 1–4: the template; bars 5–8: a new vowel path and the 808's +12 stab; bar 8 has the pause (AX-03/04); bars 9–12: a role swap. The growl calls on beats 1–2 and the 808 answers on 3–4, with the family switched to C + E; bars 13–16: the 808 alone for 2 bars (max saturation, double-time hat rolls), then 2 bars of machine gun; bar 16 ends in a tape-stop.
- **Form (R3):** The arrangement follows the song's own sections (arrange copies A's), and each source drop becomes a new drop; the song's own breaks stay (DU1's BREAK blocks), and the outro keeps drums + sub for the DJ; ~~A 4-bar breakdown before the drop (SB 2.5 / §4)~~ **overridden R3**.
- **Balance [INF]:** 808 bars: the mid sits 6–10 dB under the sub band; growl bars: the mid is within 0–4 dB of it; Q17 targets −10..−6 over the whole drop.

### 3.11 Drums (SB 3; FP drum notes; `drums.render_drum` ✅ S1; sequencing and buses S2)

| Voice | Build (the `drums.py` voice) | Level (peak re kick) |
|---|---|---|
| Kick | Body: a sine 150 → 52 Hz (τ 25 ms; it ends on the root when that's 45–60 Hz), 220 ms decay, gone by 300 ms, HP 30 Hz. Click: noise HP 2 kHz, 8–15 ms, −8 dB. Transient +3..+6 dB; limiter −2 dB (`kick`) | 0 dB |
| Riddim / tearout kick | LP 4 kHz, dull (`kick_riddim`) / the transient kept, **nothing squashed** (`kick_tearout`; his old kicks were over-squashed [P]) | 0 dB |
| Ghost kick | The kick under each clap (AX-14 A/C) | −9 dB (−8..−10), vel ≈ 0.35 |
| Snare stack | L1 body: noise + a 185 Hz tone, decay 120–180 ms, +2..+3 dB @ 200 Hz, HP 120 (−3 dB in the stack). L2 crack: noise BP 1–5 kHz, 10–20 ms, transient +3..+6 dB. L3 clap (the lead in riddim and tearout): 3 bursts 10 ms apart, BP 1.2 kHz, HP 500, with its own room (wet 0.35, ~0.9 s, 15 ms pre-delay, wet HP 600 / LP 12 kHz). L4 tail: noise HP 2 kHz, −12 dB, alternating tail A (180 ms) and tail B (300 ms, or +2 st) hit by hit (`snare` variants 0–2) | stack −0.7 dB |
| UK snare / pan snare | The clap −8 dB under the snare, −1 st (variant 3) / the stack + a 25% struck-plate layer (`snare_pan`) | −0.7 dB |
| Hats | 808-style metal (6 square partials) + noise, HP 7 kHz, 60–100 ms, bus HP 500, pan ±15% (`hat`); open 300–450 ms (`open_hat`) | −6.8 (accents v0.62, ghosts v0.47); open −10.3 |
| Impact / crash / reverse | A boom at 40 + 60·e^(−t/0.06) Hz, 0.35 s; a ~2 s crash; a reverse swell ending on the downbeat (`impact`, `crash`, `reverse_cymbal`) | −9 / −8 / −10 |

- **Drop the stem band-split drums.** `flip.split_drums` is unused; delete it (M1.18). The source stem's snare serves at most as a −6 dB body layer.
- **Kit ids:** `foxbox` (these voices, M1.10), `source` (the song's own one-shots, `resample.source_kit` ✅), `tr808-*` (CC0 ✅). The kit is your pick in KitPicker, not an axis.
- **Buses (M1.10; per kit clip, so the app hears them):** Per voice: EQ → transient → clip (kick 3–6 dB, snare 4–8 dB, 4×); the drum bus: glue (4:1, 10/100 ms, ~2 dB GR) + a parallel crush (8:1, 1/60 ms, 8–10 dB GR) at 25% → clip 1–3 dB; trap: saturation 3–6 dB + a parallel 8:1 at 30%; the goal: the snare is the top peak (Q21) and the kick peaks 1–3 dB over the bass bus; **Never clip the sub.** Clipping snares is disputed → AX-13.
- **Fills** (AX-05; bar 4 small, bar 8 big): SB: beat 4 → snare 16ths at v 0.5/0.6/0.75/0.9, or a 1/32 hat roll; bar 8 → snare 16ths on steps 11–16, v 0.5 → 1.0, pitch 0 → +5 st, or a "ratatat" (rests on 12 and 14); ER: halftime snare runs + 32nd hats; riddim triplet snares; FP: riddim 1/8T or triplet flicks; a tearout metal roll or vinyl-spin stutter; a trap 1/32 roll or snare flam.
- **Build roll (SB 3.4): GENRE FLIP builds only.** VIP and hybrid keep the source build verbatim and add only the gap, cue and impact. Hits per beat by bar: 1, 1, 1, 1, 2, 2, 4, 8; bar 8 plays 32nds on beats 1–3 and leaves beat 4 as the gap; velocity −18 → 0 dB with ±5% random; pitch 0 → +7 by bar 7 → +12 by bar 8 (+5 is the safe knob); LP 1 kHz → open, plus HP 150; reverb 10 → 40%, cut at the gap; kicks on every beat in bars 5–8 with the highs off (riddim adds claps on every beat); risers 4–6 dB under the drop; `reprogram` already keeps a source build's own roll ✅.

### 3.12 The resample engine (FP §2 A–B, SB 2.1–2.3)

**Chain A (Marauda) = `midbus.chain_a` + `resample_chain` ✅ 2414b2e (S3).** It's offline: it prints banks, never runs per note.

```
1  source: a 2-4 s held note from 2-3 FM operators on a saw/square carrier; a pitched growl uses ratio 1:1 or 2:1,
   index 1.5-4; the throat is a sine an octave down at 15-25 % FM (>= 40 % turns screamy); a WT/formant LFO at 1/2
   (motion) or 1/8 (syllables), never faster than 1/16
2  drive: 4x asymmetric (diode), 12-18 dB
3  EQ: HP 90 Hz, +3 dB at 1-1.5 kHz, -3 dB at ~400 Hz
4  movement (AX-25): freq shift ±30-200 Hz | comb 2-8 ms fb 0.7 | phaser 1/2, 60 %, 50 % mix
5  OTT 0.4
6  hard clip 6-12 dB into the ceiling (4x)
7  normalize to -1 dBFS
8  repeat 2-7, N = 3 or 5 times (AX-25), keeping EVERY generation: the variant family for bars 9-16
9  mangle one generation (AX-25): phase-vocoder stretch 2-4x (midbus.stretch) | formant-free pitch shift ±3-7 st
   (varispeed) | [not built] STFT peak-pick resynthesis
10 resonance_notch (the tallest 2-4 kHz peak -4..-8 dB at Q 8, plus a dynamic -3.5 dB), HP 120-150
11 slice: 80-250 ms one-shots at zero crossings, 1-2 ms in / 5-10 ms out; the hero keeps 400-700 ms
Measured: printed crest 7-13 dB (target <= 14); aliasing -110 dB (target < -60).
```

**The gun shot (FP §2 B)** = `growls` `gun`/`mgun` ✅ 0074395:
- (a) a metal transient, 5–20 ms;
- (b) an FM burst at a non-integer ratio of 1:1.41–1:3.5, its index falling over 30–80 ms and its amp over 80–200 ms, through chain A 1–2×;
- (c) a root sine, 60–100 ms, the only low content, ducked under the held sub.
- The machine gun retriggers (b) every 1/32 at ±1–2 st per repeat.

| Per-style prints (`resample.print_bank`, M1.11; cached per track, style and seed family) | Recipe |
|---|---|
| Riddim [SB 2.1] | Print R1 holding one note for 2 bars at each of 1/4, 1/4T, 1/8T and 1/16; chop at LFO-cycle boundaries into 1/8T–½-beat shots (zero crossings, 1 ms in / 8 ms out); keep the 6–10 most distinct by centroid and pitch contour; varispeed to {−12, −5, 0, +3, +7, +12}; reverse about 1 in 8; pass 2: OTT 0.5 + clip 3 dB with a different modulation rhythm |
| Tearout [SB 2.2] | Print 2–4 bars each of A, B, C and E; pass 2 changes the modulation rhythm (a vowel on 1/8 → a disperser or freq shift on 1/16); chop 1/16–1/4; keep the 8–10 most distinct; ±3 st; fades 4/8 ms; HP 120 + a fresh sine sub; **never the same shot twice in a row within a bar** |
| Hybrid [SB 2.3] | The 808 chops of §3.9 |
| The track's own stems (M1.11) | `bass` + `other` summed within the drop; onset-sliced; keep slices with a centroid > 400 Hz and high flux; reject any slice where the drums are within 12 dB; gate below −40 dBFS before OTT (depth 0.2–0.3); HP 120, then re-sub |

Today:
- `slice_bass` reads the bass stem only (SB cause #10).
- `print_shot` = HP 100 + an **un-oversampled** tanh(6x) mixed in at 0.6.
- `drop_chain` = HP 100 + `resample.ott`.
- `has_growls` = 100–600 Hz within −18 dB of < 80 Hz.

### 3.13 The patch_id grammar (engine clips; a free string in the contract)

| patch_id | Renders | Code | State |
|---|---|---|---|
| `resample:<style>` (trap_hybrid, riddim, tearout, halftime) | The source's one-shots (designed prints for growl-less sources) on the style grid, printed and chained; a clean sub unless a source-808 lane holds | `resample.resample_bass` | ✅ |
| `hybrid:<growl>` | Designed growls answering the held source 808 | `resample.hybrid_growls` | ✅ (C16) |
| `riddim:wub` | R1 (+R2) on the motif + the sub | `resample.riddim_bass` | ✅ (sub → M1.5) |
| `808:dark` / `808:dive` | The first hit / the switch-up dive | `bass808.render_darkhit`; `resample.eight08` | ✅ |
| `808:line` | BASS DNA → a quantized 808 line | `bass808.render_808_line` | M1.12 |
| `voice:<style>` | One designed voice from `growls.STYLES` on the groove's notes (SWAP SOUND) | `growls.render_growl` | M3.3 |
| `top:<squeak/arp/powerup/coin>` | The TOP layer | `riddim.render_squeak`, `candy.render_candy` | M1.6 |
| `wobble:<old/ds>` | Trap-hybrid wobble / downsample wub | new `fvwks_synth/wobble.py` | M1.15 |
| `foxbox.*`, `surge.*` | A library patch on the groove (the ONE PATCH mode) | `fvwks_synth.bass.render_groove` | ✅ |

Kit clips: `kit_id` is `source`, `foxbox` or `tr808-*`. `pattern_id` `fx.impact`/`fx.reverse` go on the `kit-fx` lane (M1.14).

---

## 4. Variation axes ("there isn't always a correct answer", R14)

### 4.1 How an axis works

- **Declared once:** Engine axes live in `fvwks_fx/remix/styles/<style>.json` (M1.7); synth axes live beside their voice in `midbus.AXES`'s shape, `{axis: {option: weight}}`: `midbus.AXES` ✅, plus `riddim.AXES` and `bass808.AXES` for S1; ids are dotted, as in the contract's own example (`riddim.drums` / `seesaw`).
- **Resolved once per take by BUILD:** `styles.resolve(style, seed, prefs) -> list[TakeChoice]` gives each axis its own stream seeded by (seed, axis id), so adding an axis never reshuffles the others. The draw rule is §7.3; the result is recorded in `RemixTake.choices` (v0.11.8 ✅) and passed down, e.g. `resample_chain(passes=…, mangle=…)`; **An existing take reuses its recorded choices;** only a new seed resolves. A voice's own `pick()` stays as the fallback for auditions.
- **Scopes:** **take:** once per take; **drop:** drop 2 may differ; **phrase:** per 4 bars; it may rotate between phrases; **hit:** micro-variation (tearout hit states, drum jitter, glide times, R2 level inside its range). Hit-level picks are seeded but **not recorded or rated.**
- **Compatibility:** the resolver prunes illegal combinations before drawing. For example, a bass grid × drum grid pair that breaks I6 gets the offending hits shifted +1/16 or dropped.
- **Health:** An option that FAILs an invariant on the corpus goes to weight 0 and is listed in M2.8 until fixed. It's never silently deleted; weight 0 in the JSON means declared but inactive, e.g. the Ableton OTT until its numbers exist.
- **Budget:** at most ~8 take-level axes live per style in 1.5 (distinct takes that still sound like the style). The rest stay at one live option.

### 4.2 Invariants: they hold for every option of every axis

- **I1 Held weight:** ≥ 1 bar of held sub or 808 per 4-bar phrase; the sub holds and the mids chop (R2). → **Q27**
- **I2 No breakdown:** the source's build and pre-drop hook play up to the gap; the silence is ≤ 1 beat, with ≥ ½ beat quiet on non-vocal stems (R3); trap-hybrid replaces the gap with the switch-up. → **Q07, Q08, Q09**
- **I3 First hit hardest:** on the bass stems, the first hit is ≥ every later bass hit + 1.5 dB (R5). → **Q12**
- **I4 Not whiny:** the low-end owner's first note starts ≤ +7 st over its pitch and settles by 30 ms; it never glides in from above (R6). → **Q13**
- **I5 Club-safe:** −7.0 ± 0.5 LUFS short-term max, ≤ −1.0 dBTP, limiter GR ≤ 3 dB (R9). → **Q01, Q02, Q04**
- **I6 Snare window:** no mid-bass onset, or sounding mid, within ±1/16 of any snare or clap in the take's grid (SB 1.4). → **Q22**
- **I7 One low-end owner:** sub or 808, never both at once. → **Q35**
- **I8 Clean edges:** 0 clicks at joins; ≤ 2 per minute mix-wide, buzz excluded. → **Q29**
- **I9 A clean mono sub:** correlation ≥ 0.95 below 120 Hz; no distortion, OTT or width on the sub. → **Q14, Q15**
- **I10 Tempo follows the source:** within ±15% of the source, or of its ×2/×½ (R8). → **Q41**
- **I11 Pauses:** ≤ 1 per 16 drop bars (≤ 2 per 32), with full-energy re-entry on the next downbeat (R4). → **Q28**
- **I12 On the grid:** drops on the source's drop bars, 0 bars late; 95% of onsets within ±5 ms. → **Q11, Q30**

R13 (no generative AI) is a design rule for every option. It's checked in review.

### 4.3 The axes

Weights are defaults (ratings shift them, §7); sources are in brackets.

| AX | Axis id (scope) | Options → default weight [source] | Owner · code | Invariants (+ I1–I12 always) |
|---|---|---|---|---|
| 01 | `drop.gap` (take) | ½ beat 0.3 [SB 1.8, tracksensei] · 1 beat 0.7 [SB default; your cap]. ~~1–2 bars [KAN]~~ and ~~a 1-bar fake-out at 30% [SB]~~ **overridden R3** | S2 · `arrange.GAP_BEATS` → styles | I2 |
| 02 | `drop.gap_fill` (take) | silence 0.5 · a reverse swell ≤ ¼ beat into the downbeat 0.3 [SB 1.7] · a source vocal/soundbyte cue 0.2 [SB 1.8] | S2 · `mixdown._impact` → the `kit-fx` lane | Q07 on non-vocal stems |
| 03 | `drop.pause` (drop) | bar 8 0.45 · bar 12 0.25 · none 0.30 [SB 1.7; R4 "occasionally"]; today there's always one | S2 · `arrange._beat_pauses` | I11 |
| 04 | `drop.pause_len` (drop) | ½ beat 0.2 · 1 beat 0.4 · 2 beats 0.4 [SB ½–2; FP 2]. What drops out: tearout drums + mids, with the sub tail ringing [FP]; other styles everything but the vocals | S2 · `arrange._cut_window` | I11, Q28 |
| 05 | `drop.fill` (phrase) | riddim: 1/8T flick 0.35, triplet snare 0.25, snare 16ths 0.15, 1/32 hat roll 0.10, scratch 0.15 · tearout: metal/snare roll 0.3, D dive 0.3, 1/32 snare stutter 0.2, vinyl-spin stutter 0.2 · trap: 1/32 hat roll 0.4, 1/16T roll 0.2, snare flam 0.2, snare 16ths 0.2 [SB 3.3, FP, ER] | S2 · `flip.reprogram` + styles | a fill ends on the next downbeat; I6 |
| 06 | `drop.cadence` (drop) | a small change every 4 + a big one every 8: 0.6 [SB, KAN, melodigging] · every 8 only: 0.2 · every bar (hybrid drop 2): 0.2 [SB 2.3]; riddim uses AX-20 instead | S2 · the styles scheduler | never loop 1 bar > 4 bars; Q26 |
| 07 | `drop.end` (drop) | glitch stutter 0.3 · tape-stop 0.3 [SB] · a stop with the last 2 beats silent 0.2 [SB riddim] · straight on 0.2 | S2 · styles | I12 |
| 08 | `tempo.<style>` (take; only when not following the source) | riddim 140 0.5 / 145 0.5 · tearout 140 0.33 / 145 0.33 / 150 0.34 · trap_hybrid 150 0.5 / 140 0.5 [§3.7–3.9] | S2 · `arrange.build` + the styles' bpm | I10 |
| 09 | `mix.mid_duck` (take) | −6 dB at the kick 0.5 [SB] · −3 dB (2–4) at the kick + snare 0.5 [FP, tracksensei] | S2 · `mixdown._duck` → prepare (M1.14) | I6, Q21 |
| 10 | `mix.sub_duck` (take) | −10 dB at kicks, 130 ms 0.6 [SB] · −3 dB at the kick + snare, 75 ms 0.4 [FP] | S2 · same | I1, I9 |
| 11 | `mix.808_duck` (take) | soft −2.5 dB / 80 ms 0.5 [SB] · hard −5 dB / 50 ms 0.35 [FP] · kick HP 50 Hz, no duck 0.15 [SB] | S2 · same | Q31; the first kick undocked |
| 12 | `mix.ott` (take) | faust 1.0 [SB's pick; `midbus.OTT_BANDS`] · ableton 0.0 until transcribed [SB] | S3 · `midbus.ott(model=)` | Q18, Q29 |
| 13 | `mix.drum_clip` (take) | per-voice clip on (kick 3–6, snare 4–8 dB) 0.6 [SB 3.2] · off 0.4 [disputed, SB] | S2 · the kit bus (M1.10) | Q21, Q31; never clip the sub |
| 14 | `riddim.drums` (take) | whack (kick 1, a −9 dB ghost, the clap on 9, offbeat hats) 0.5 [SB 2.1] · quarter seesaw (kicks on the quarters, claps on the off-beat 8ths) 0.35 [P Subtronics] · backbeat seesaw (kick 1 & 9, clap 5 & 13) 0.15 [v1's reading] | S2 · `FLIP_STYLES['riddim']` → `styles/riddim.json` | I6 on every clap; kick LP 3–5 kHz |
| 15 | `riddim.grid` (take) | R-SB 0.25 · R-FP 0.25 (pairs with drums B) · R-code 0.25 · R-cell 0.15 · R-332 0.10 [§3.8] | S2 · `resample.RIDDIM_MOTIF` → styles | I6 (resolver); Q26 ≥ 0.8 |
| 16 | `riddim.lfo` (take) | all 1/4 0.4 [FP: the main rate] · a per-note set of {1/4, 1/4T, 1/8, 1/8T} 0.4 [SB, code] · plus 1/16 accents 0.2 [SB] | S1 · `riddim.AXES`; S2 grid | the LFO restarts per note; ≤ 3 rates per bar |
| 17 | `riddim.r2` (take) | off 0.2 · on the first + accent notes 0.4 [code] · on every note 0.4. Level: `r2_blend(seed)` 0.3–0.5 (hit-level) [SB] | S1/S2 · `riddim.r2_blend`, `resample.riddim_bass` | R1 + R2 count as one mid sound (Q32) |
| 18 | `riddim.sub` (take) | held, re-struck every 2 bars 0.5 · every 4 bars 0.3 [FP: one root per 2–4 bars] · held + a ¼-note bounce ≤ 30% 0.2 [3P EDMProd]. ~~Gated per hit~~ **overridden R2** | S2 · `resample.sub_line` → `midbus.sub_voice` | I1, I7 |
| 19 | `riddim.drive` (take) | medium (2 stages, 9–12 dB) 0.8 [FP] · heavy (a 20–30 dB oversampled clip on the main layer) 0.2 [P] | S1 · `riddim.r1(heavy=)` | Q18 ≤ 8, Q20, Q29 |
| 20 | `riddim.half2` (drop) | one swap (R2 leads, or +5 st) 0.7 [FP; Infekt: no new families] · SB's switch state on bars 13–16 (wobble / growl call-response / techno switch) 0.3 [SB] | S2 · styles | Q26 inverted (≥ 0.8) |
| 21 | `top.layer` (take) | riddim: none 0.3, squeak 0.5, candy in the build/fills only 0.2 · tearout: none 0.5, an arp top line 0.3 [SB], squeak 0.2 · trap: none 0.6, candy 0.4 [the Level Up palette] | S1/S2 · `render_squeak`, `candy` | TOP ≥ 1 kHz, never masking the bass (Q33) |
| 22 | `tearout.order` (phrase) | chomp → talker 0.3 [SB 2.2; code] · talker → chomp 0.1 · chomp → disperser 0.2 · hero → guns → mgun 0.4 [FP, Marauda] | S3 voices · S2 `hybrid_growls`/the sequencer | Q32 ≤ 1; never the same state twice in a row; Q25 |
| 23 | `tearout.grid` (phrase) | T-code 0.3 · T-SB 0.35 · T-FP 0.35 [§3.7] | S2 · `resample.TEAROUT` → styles | I6, Q34 |
| 24 | `tearout.second` (drop) | the next resample generation 0.6 [FP, Marauda] · a new call family C + E 0.4 [SB] | S2 · the print bank | Q25, Q26 |
| 25 | `resample.passes` / `.movement` / `.mangle` (take) | passes 3 0.6 / 5 0.4 · movement shift 0.4 / comb 0.3 / phaser 0.3 · mangle stretch 0.5 / pitch 0.5 ✅ [FP, P Marauda] | S3 · `midbus.AXES`, `resample_chain` | printed crest ≤ 14 dB; Q29 |
| 26 | `tearout.chomp_snap` (take) | +24 st over 25–40 ms 0.7 [SB voice A] · ≤ +12 st with a 2–4 ms ramp 0.3 [v1 M1.1]; L2 sets the default | S3 · `growls._voice_chomp` | Q29 at joins (the whine check covers only the low end) |
| 27 | `hybrid.first_len` (drop) | 2 beats 0.5 [code] · 3 beats 0.25 · 1 bar 0.25 [FP: the 808 held the full bar] | S2 · `arrange.FIRST_BEATS` | I3, I4 |
| 28 | `hybrid.first_growl` (drop) | growls answer on steps 10–16 of bar 1 0.6 [SB 2.5 window; R10] · a +1..+2 dB mid stab on the downbeat with the dark hit 0.4 [SB 1.7] | S2 · `hybrid_growls` | I3 on the bass bus; R10 |
| 29 | `trap.mids` (drop) | old-school wobble 0.4 · downsample wub 0.2 [SB 2.3] · 808 chops as accents 0.4 [code; your round-2 "pretty good"] | S1 voices (M1.15) · S2 | Q17 hybrid, Q32 |
| 30 | `drums.snare` (take) | riddim: clap-led 1.0 · tearout: pan 0.6 / clap-led 0.4 · trap: UK 0.5 / clap-led 0.5 [SB 3.1, FP] | S1 · `drums` variants | Q21 |
| 31 | `drums.kick` (take) | riddim `kick_riddim` · tearout `kick_tearout` · trap: 808 kick 0.6 / 2-layer 0.4 [SB, FP] | S1 · `drums` | Q31 |
| 32 | `808.glide` (hit) | glide times 60–100 ms (≤ 7 st) / 180–300 ms (beyond), a seeded range [SB, S1] | S1 · `bass808.glide_times` | a ±12 st clamp; I4 |

---

## 5. Milestones

Each item gives its owner, size, dependencies and state; then its sub-steps (file · function · parameters); then **Accept**, naming the QA checks (§8).

### M1 "Sounds right": voices plus drop rules, QA-clean on the corpus

**M1.1 Tearout listening pass** · S3 + PM · M · deps: none (the loops exist) · open
- a) **PM:** a listening page from `out/growl-audition/` (S3's tearout, chomp, talker, disperser, pwm, reese, metal, gun, mgun loops; S1's riddim-r1, yoi-r2, 808-s1, darkhit-s1, drums-s1); one AskUserQuestion per voice: keep / rework / drop, with reasons clicky, whiny, thin, harsh, not heavy, synthy (L1).
- b) **S3:** drop → weight 0 in AX-22; rework → fix and re-audition. c) **L2 chomp snap:** "clicky/whiny" → AX-26's ≤ +12 st with a 2–4 ms raised-cosine attack becomes the default; else +24 st stays (a designed transient). d) Verdicts → §9 and `remix-taste`.
- **Accept:** a verdict per voice; Q29 = 0 on every loop; `growls.qa().clicks` = 0 at joins.

**M1.2 Tearout = percussive gun shots** · S3 voices + S2 sequencer · M · deps: M1.7 · voices ✅ 0074395
- a) ✅ `gun`, `mgun`, `resonance_notch` on every growl, integer ratios on pitched growls.
- b) **S3:** `growls.render_hero(midi, beats, bpm, sr, seed)`: the `resample_chain` generations of an A/B print layered into 400–700 ms, +2..+3 dB over the drop's later hits.
- c) **S2:** `resample.tearout_bass(...)` driven by AX-22/23: ≤ 1 mid voice per step; ≥ 30% silent 1/16 slots in bars 1–2; ½–1-beat mgun bursts on the grid's `m` slots (steps 10–13); `hit` indices never repeat within a bar.
- d) **S2:** `hybrid:tearout` uses gun, mgun and the disperser besides chomp and talker (AX-22).
- **Accept:** Q25 ≥ 3 states per bar; Q34; Q32 ≤ 1; Q29 = 0; L3.

**M1.3 Iterative resampling** · S3 · M · ✅ 2414b2e
- a) ✅ `midbus.chain_a` / `resample_chain(x, sr, seed, passes, chain, mangle, bpm)`: every generation plus one mangle, notched, HP 120, −1 dBFS; `midbus.stretch` is the phase vocoder.
- b) Open (S3, S): STFT peak-pick resynthesis as a third mangle (FP A.9), only if L3 says the prints sound samey.
- c) Open (S2): `resample.print_bank(style, root, bpm, seed_family)` prints with `resample_chain`, cached per (track, style, seed // 8) in the engine data dir, so ROLL reuses banks.
- **Accept:** printed crest ≤ 14 dB (measured 7–13 ✅); aliasing < −60 dB (measured −110 ✅); a bank cache hit on ROLL (M2.5).

**M1.4 Riddim R1** · S1 (+S2) · M · R1 ✅, `late_with_delay` ✅
- a) **S1:** FP's freq-shift stage (±20–80 Hz at 20–30%) + a short delay as `r1(shift=True)`, exposed as `riddim.shift` (off 0.5 / on 0.5). b) **S1:** `riddim.AXES` holds `riddim.lfo` (AX-16) and `riddim.r2` (AX-17); `r1(rate=…)` takes the resolved rate.
- c) **S2:** `riddim_bass` places 1–2 `d` hits per bar with `late_with_delay` (+1/32 by default; +1/16 only with drums A). d) **S2:** the §3.8 pitch vocabulary in the motif.
- **Accept:** Q26 (riddim ≥ 0.8), Q23 4–9/bar, Q22 = 0; L4 "sounds like riddim, not trap".

**M1.5 Riddim sub, non-whiny 808, dark first hit** · S1 + S2 · M · 808 line ✅, darkhit ✅
- a) ✅ `render_808_line` (≤ +7 st, settled ≤ 30 ms, glides only on overlaps), `render_darkhit` (on pitch), `glide_times(seed)`.
- b) **S2:** `riddim_bass` replaces the per-hit `sub_line` with a held `midbus.sub_voice` at the root, re-struck per AX-18, with the optional ¼-note bounce ≤ 30%. c) **S2:** in riddim flips the sub is the one low-end owner; the source 808 lane stays muted (R11). d) **S3:** the whine check (Q13, M2.4a).
- **Accept:** Q27 ≥ 1 bar (riddim, 7 tracks); Q13; L5 "not whiny".

**M1.6 The hook/top layer** · S1 + S2 · S · squeak ✅, candy ✅
- a) **S2:** a `top-A` lane of groove clips (`top:squeak`, `top:arp`, `top:powerup`, `top:coin`) per AX-21: riddim's squeak follows the wub accents; tearout gets an arp top line in key (root triad, 1/16, 2-bar cycle, sides above 200 Hz); candy only in builds and fills.
- b) **S2:** `top:` clips skip the bass processing (no 120 Hz split, no snare window). c) **S1:** candy stays in key (`minor` from the song key; key None → minor).
- **Accept:** Q33 (no top energy under 1 kHz above −20 dB re itself); L11.

**M1.7 Styles as data, plus the axis resolver** · S2 · L · deps: none · open
- a) `fvwks_fx/remix/styles/{riddim,tearout,trap_hybrid,halftime,dubstep140,fourfloor,dnb}.json`; `flip.FLIP_STYLES`, `resample.STYLES` and `RIDDIM_MOTIF` move there; `GET /api/flip-styles` reads them (S3).
- b) Schema, one file per style:

```json
{"id": "riddim", "name": "Riddim", "bpm": {"140": 0.5, "145": 0.5}, "half_time": true, "low_end": "sub",
 "axes": {"riddim.drums": {"whack": 0.5, "seesaw": 0.35, "backbeat": 0.15},
          "riddim.grid": {"sb": 0.25, "fp": 0.25, "code": 0.25, "cell": 0.15, "t332": 0.1}},
 "drums": {"whack": {"hits": [[0, "kick", 1.0], [2, "kick", 0.35], [2, "snare", 1.0], [0.5, "hats", 0.8]], "alt": []}},
 "bass":  {"sb": {"slots": 12, "bars": [["x-.", "...", ".x-", "..."]]}},
 "fills": {"1/8T_flick": 0.35, "triplet_snare": 0.25}, "pause": {"8": 0.45, "12": 0.25, "none": 0.3},
 "qa": {"onsets_bar": [4, 9, 2], "centroid_std_hz": [150, 20000, 50]}, "sources": {"drums.whack": "SB 2.1"}}
```

- c) `styles/__init__.py`: `load(id)`; `resolve(style, seed, prefs=None) -> list[TakeChoice]` (per-axis streams, the §7.3 draw, I6 pruning); `style_of(remix)` (the flip style, or the VIP family: `hybrid`, `resample:<style>`, `riddim`, `library`).
- d) BUILD upserts `remix.takes` with `RemixTake(seed, style, choices, created_at)`; prepare reads the choices from the take for `remix.seed`. e) The resolver imports `midbus.AXES`, `riddim.AXES` and `bass808.AXES` and records the take-level ones (C11).
- f) C18: a `tearout` flip style (half-time kick 1 / pan snare on 9; bass `resample:tearout` or the M1.2 sequencer).
- **Accept:** each style passes QA on 7 tracks; the same seed gives the same choices, and a new seed usually changes ≥ 2 axes; no rule lives outside arrange/prepare/mixdown/styles; L6 (you can tell the styles apart).

**M1.8 The drop rules as code** · S2 · M · gap ✅, pause ✅, switch-up ✅, 808:dark ✅, impact ✅
- a) First hit hardest → M1.17b. b) Gap + fill (AX-01/02) → M1.17a. c) Pauses become AX-03/04 (with "none"); tearout pauses take out drums **and** mids, so only the sub tail rings.
- d) A growly initial drop (R10): the hybrid's bar 1 carries growls (AX-28). e) C16: `hybrid_growls` plays the bar-4 full-bar switch (A 1–3, C/G 3–8, the snare alone on 9, B 10–14, D 15–16).
- f) The VIP drop plays another family (AX-24), or `VIP_SWITCH` for library patches (ER `vip-drop-switch`). g) Loud-quiet-loud: Q34. h) The trap-hybrid pre-drop is the switch-up only (Q08).
- **Accept:** Q07/Q08/Q09, Q12, Q28, Q34 on 7 tracks × 5 recipes.

**M1.9 The low end** · S2 · M · deps: M1.14 · envelopes ✅ (in mixdown)
- a) One owner per span (I7), by style (sub: riddim, tearout; 808: trap, hybrid), recorded in the take for QA. b) Held weight (I1): hybrid/VIP keep the source 808; riddim uses AX-18; tearout holds the root ≥ 2 bars, re-struck on 5, 9 and 13.
- c) The ducks become AX-09/10/11. d) The source 808's mid band (its saturation harmonics) gets the synth_bass −12 dB clap window (M1.17d). e) The hybrid 808 drops −3 dB inside the growl windows (C16). f) Fast low-end start/stop: gates A 2–3 / R 10–20 ms; duck releases 70–150 ms.
- **Accept:** Q27, Q22, Q14, Q35, Q17 (hybrid −10..−6).

**M1.10 The drums rebuild** · S2 (+S1 voices ✅ 0cc14f5) · M · deps: M1.14
- a) The `foxbox` kit plays `drums.render_drum` with a per-hit seed = hash(remix seed, clip id, hit index); kick and snare from AX-30/31; alternating snare tails A/B.
- b) The per-kit-clip bus in `prepare._kit` (§3.11): per-voice clip (AX-13), glue + 25% parallel crush + 1–3 dB clip; the trap variant. c) Kit loudness matched to the source drum stem over the section's bars ±1 LU (ER `kit-loudness-match`; `_match` factored out of `_groove`).
- d) Fills (AX-05) plus ER's `flip-phrase-fills` data; no machine-gun hats. e) Delete `flip.split_drums`.
- **Accept:** Q21 (stems), Q31 ±1 LU, M1.17c; L7.

**M1.11 The resample path for tracks with real growls** · S2 · M · deps: M1.3 ✅
- a) `resample.slice_source(bass, other, drums, sr, analysis, start_bar, bars)`: bass + other in the drop, onset-sliced; centroid > 400 Hz and high flux; reject a slice if the drums RMS is within 12 dB; gate below −40 dBFS; OTT 0.2–0.3; HP 120; re-sub.
- b) `print_bank` (M1.3c) runs `resample_chain` on the kept slices (AX-25). c) `print_shot` uses `midbus.distort` at 4× (M1.13). d) The automatic choice stays `has_growls`: ncs tracks with growls resample; 808-only tracks (song-1) design first, then resample.
- **Accept:** all 7 tracks render; Q29; no audible drum bleed (L8).

**M1.12 BASS DNA → 808** (new) · S2 + S1 · M
- a) `resample.bass_dna_808(groove, key) -> notes`: quantise to 1/16 (min 1/16), merge legato, snap to the scale within an octave, fold the root into C1–G1, keep held notes, split only at bar lines for I6.
- b) `prepare._engine_bass` handles `808:line` → `render_808_line(notes, bpm, sr, variant, glide=glide_times(seed))`. c) Used when the source 808 is weak (30–90 Hz ≥ 10 dB under the drop's median) or when you pick ONE PATCH → 808 LINE.
- **Accept:** Q13, Q27; pitch within ±50 cents of the source notes.

**M1.13 One OTT, one sub fold, 4× everywhere; delete void code** (new) · S3 (+S2) · S
- a) `growls._ott` and `resample.ott` route to `midbus.ott` with `model=` (AX-12; `OTT_MODELS = {"faust": OTT_BANDS}`). b) One `midbus.sub_hz`, used by `resample._sub_hz`, `_fold_c1`, `groove.render_groove` and render_growl's sub.
- c) `resample.print_shot` and `mixdown.loud` at 4×. d) Delete `resample.breakdown`, `changeup`, `render_drop`, `render_hybrid`, `render_riddim`, `growls._808`/`_808_body` (C15); grep first (no callers today).
- **Accept:** one OTT implementation in the tree; golden QA within ±0.5 dB (M4.4).

**M1.14 What you hear is what you export** (new) · S2 · M
- a) `prepare._bass_bus(clip, remix, y)` applies, per `bass`/`synth_bass` clip, the ducks (AX-09/10/11), the clap window, the first-hit gain and the 120 Hz split. Hit times come from the arrangement (kit clips' inline hits; `song_drum_hits` for stem drums); it reuses `mixdown._duck`.
- b) The impact stack moves to a `kit-fx` lane (role `kit`, no contract change, as in ER `riser-impact-fx`): `KitClipSrc(kit_id="foxbox", pattern_id="fx.impact"/"fx.reverse")` renders `drums.render_drum("impact"/"crash"/"reverse_cymbal")`; you can mute or swap it.
- c) A bass clip's `clip_key` hashes the drum-hit times under it (ER `sidechain-pump`). d) `mixdown` keeps only the sum, the B match and the master.
- **Accept:** Q39 (clip sum vs pre-master mixdown ≤ 0.5 dB RMS per bar on a golden take); the impact lane shows in the app.

**M1.15 Trap-hybrid wobble voices** (new) · S1 · M
- a) New `fvwks_synth/wobble.py`: `render_wobble(midi, beats, bpm, sr, variant, lfo_rates)` and `render_dswub(...)` with the §3.9 numbers; routed as `growls._ENGINES` `wobble`/`dswub` and `patch_id` `wobble:old`/`wobble:ds`.
- b) Per-note LFO rates, ≤ 3 per bar; SB's wobble LFO grid as data (bar 1: steps 1–8 at 1/8, rest on 9, 10–12 at 1/16T, 13–16 at 1/4; bar 2: 1–8 at 1/4T, 9–12 at 1/8, 13–16 rest + a vocal chop).
- **Accept:** Q29 = 0; L9 "bouncy wobble, not destroyed".

**M1.16 The midbus re-fade** (new) · S3 · S
- a) `midbus.midbus()` ends with raised-cosine edges (3 ms in, 10 ms out) after its clip: the root-cause fix, in the shared function, for S1's finding that prints ring past the note after the chain. b) Remove the per-caller re-fade in `resample.riddim_bass` (its "S1: re-fade after the chain" line).
- **Accept:** `growls.qa().clicks` = 0 at the joins of every print; Q29 = 0 on 7 tracks.

**M1.17 The four QA flags, fixed at the root** (new) · S2 (+S3 stems) · M · deps: M2.7 (to verify)
- a) **No pre-drop gap:** the reverse swell shrinks to ≤ ¼ beat before the downbeat (AX-02) and moves to the `kit-fx` lane; `other`/`drums` get a 30 ms fade into the gap (they already end 1 beat early); the vocal cue is measured separately. **Accept:** Q07 ≥ ½ beat at ≤ −40 dBFS on non-vocal stems, 7 tracks.
- b) **First hit not the hardest:** `prepare._match` still matches the first-hit clip to the source bar, then **adds** `FIRST_DB` (2.5 dB, knob 2–3); `_bass_bus` caps later bass hits at first − 1.5 dB with a slow gain ride (≥ 50 ms, no pumping); tearout gets the hero hit (M1.2b). **Accept:** Q12 ≥ +1.5 dB on bass stems.
- c) **Snare never the top peak:** a per-voice snare transient and clip plus the drum bus (M1.10b); a 1–3 dB mid-bus clip so bass peaks sit lower; AX-10 B ducks the sub at snares; `loud()` keeps its gentle clipper over better-shaped buses. **Accept:** Q21 ≥ 75% of bars (bar 1 excluded) on the mix, and drums-stem snare peak ≥ bass-bus peak in ≥ 75% of bars.
- d) **Bass onsets in the snare window:** move `resample.RIDDIM`'s response off beat 2.0 (to ≥ 2.25); every grid note that ends at a clap now ends 1/16 before it (RIDDIM_MOTIF A, HALFTIME, TEAROUT, *_SWITCH); the resolver enforces I6; the source 808's mid band gets the window (M1.9d); duck recovery starts at +1/16 + 10 ms. **Accept:** Q22 = 0 on the mid stem vs claps found on the drums stem.
- e) **(Predicted) riddim held weight** → M1.5b. **Accept:** Q27.

**M1.18 Engine-review gaps still open** (new) · S2 (+S3 docs) · M in total

| ER item | State on `help/s2-bassdna` | Action | Size |
|---|---|---|---|
| groove-bar-late-fix, 2nd edit: `groove.py:100` drops notes that start a few ms before t0 or are held across it | open | The overlap rule (keep when min(end, t1) − max(t, t0) ≥ `MERGE_S`); it protects R2's held notes | S |
| grid-override-regrid: `downbeat_override_s or …` treats 0.0 as unset; no re-barring after a BPM fix | open (`song_drum_hits`, `_audio_source`, `_pick_mash`) | `_on_grid(song)` at `run()` entry | S |
| surge-foxbox-fallback: `_synth_groove` catches only KeyError, so a Surge crash kills the job | open | Fall back to the same-category `foxbox.*`, with a log line | S |
| prepare-fail-fast | open | `cancel_futures` + `add_note(clip id)` | S |
| content-cache-keys | seed + id ✅ a0a35d8 | Add the context (C14) and a drums fingerprint | S |
| kit-loudness-match | open | M1.10c | – |
| mashup-phrase-parts (B's part fills A's phrase) | open | `b_left` | S |
| mash-half-double-time (`tempo_ratio` never read) | open | `beat_mult` in arrange + pipeline | M |
| vip-drop-switch(up) (the VIP copy repeats the same patch) | open | M1.8f | – |
| The flip's `half_time` is never read; prepare never sets BASS DNA's `half_time` | open | Read it from styles; set it from the section | S |
| `split_drums` unused (~28 s) | open | Delete (M1.10e) | S |
| `beats_per_bar` ignored | open | Document 4/4-only for 1.5 | S |
| Docs drift: BE names `run.py` (it's `pipeline.py`); `GrooveWobble.shape`; bend ±12 vs Surge ±24; "loudness-matched per lane" | open | Fix BE; clamp Surge's bend to ±12 | S |
| A deep-dubstep flip style | missing | Won't do in 1.5 (not a target style) | – |
| Done since the review | bar-late (1st edit), pre-drop breath, grid-true sections, drop-hit transitions/intact, drum stretch profile, stretched-join guard, sidechain (in mixdown → M1.14), server calls run ✅ | – | – |

**M1.19 CC0 sample layers** (new; **moved to 1.5.1**: the user will download the Freesound packs later) · S1 (+PM licences) · M
- Layer curated CC0 one-shots under the synthesized kit and FX; the synths stay the main sound.
- **What:** kicks, snares, metal "pan" hits, impacts, reverse cymbals.
- **Sources:**
  - Freesound CC0/CC-BY packs, downloaded by the user (login): deadrobotmusic kicks and snares, Mighty Snares (CC-BY: a credit per sound), ROHHSA impacts, JarredGibb reverse cymbals.
  - No-signup CC0: VSCO-2 CE anvil and brake drum, Kenney impacts, Sonic Pi hits.
- **Rules:**
  - Check every file's AI flag.
  - Store the kept one-shots as mono FLAC in engine-code, about 10–20 MB at most.
  - Keep a per-file manifest: source URL, author, licence.
  - Credit CC-BY files per sound in THIRD_PARTY_NOTICES.
  - Make the sample layer a variation axis (`kit.layer: synth | sample | both`).
- **Accept:** the drum QA passes with the layers, the update grows ≤ 20 MB, and the manifest covers every file.

### M2 "Tons of takes": seeds, the corpus harness, any track

**M2.1 `scripts/remix_audition.py`** · S2 · M · base ✅ (`--song --recipe vip|flip --style --patch --kit --seed --takes --bars --lead-bars --out`)
- a) `--corpus DIR` runs every audio file (neutral names by construction) × `--recipes` × `--seeds 1,2` → `out/remix-corpus/<track>/`. Default recipes: vip hybrid:tearout, flip trap_hybrid, flip riddim, vip resample:riddim, + flip tearout after C18.
- b) Pass `--style` to remix_qa per recipe (C17): hybrid/resample → hybrid; riddim → riddim; tearout → tearout; trap_hybrid → its new targets. c) A `<take>.json` beside each MP3: the Remix doc, seed, `RemixTake.choices`, engine sha, QA row.
- d) One `original-drop.mp3` per track (the Q11/Q16 reference). e) `--stems` (M2.7), `--goldens` (M4.4), `--from-take FILE`. f) A mashup recipe (two corpus tracks).
- **Accept:** a take.json re-renders to identical decoded samples on the same machine (Q37); one command runs the corpus.

**M2.2 Seeded choices and the take record** · S2 · M · rngs from `Remix.seed` ✅; clip_key seed ✅ a0a35d8
- a) `clip_key` also hashes the context `_engine_bass` reads (the spans of overlapping bass-stem clips and of `808:dark` within the clip's window) (C14). b) The resolver (M1.7c) + take record (M1.7d); rebuilding an existing seed reuses its choices even if prefs changed.
- c) prepare reads choices from the take; anything you can SWAP comes from a choice or the clip, never a new draw. d) Q36 and Q38 as unit tests in `fx/tests/test_remix_pipeline.py`.
- **Accept:** same (doc, seed) → byte-identical; two seeds → different clip keys and distinct audio (Q36); a ROLL through the server never serves the previous take's audio.

**M2.3 Robustness on any track** · S2 · M · deps: M2.8 findings
- a) No drop detected → the loudest 16-bar block with the most 30–90 Hz energy, plus a warning. b) Half/double tempo: `tempo_ratio` (M1.18), the ×2 read, I10. c) Key None → root from `resample.root_pc`; candy minor.
- d) Short tracks: < 16 drop bars → no bar-12 pause; < 8 → no pause. e) 808-only vs growl-heavy (`has_growls`); no vocals (the gap fill never picks "cue"); beatless drums (the style loop). f) The ncs set: 145–150 BPM in Eb/F/G/B/C#.
- g) `RunResult.warnings: list[str]` for every fallback, logged by the server (no contract change).
- **Accept:** 7 tracks × 5 recipes × 2 seeds render with 0 invariant FAILs.

**M2.4 QA additions** · S3 · M · the §5 set ✅ (main)
- a) **Whine (Q13):** a pitch track (autocorrelation on the ≤ 400 Hz low stem, 5 ms hops) over the low-end owner's first 60 ms; max − settled ≤ 7 st, settled by 30 ms; first-50 ms centroid ≤ 3× f0.
- b) **Distinctness (Q36):** the mean 4-bar chroma+MFCC cosine (`_mfcc_chroma`) between two seeds' drops ≤ 0.95 (calibrate). c) **Riddim repetition** (Q26 inverted, ≥ 0.8 over bars 1–4); **tearout** ≥ 3 centroid clusters **per bar** (Q25).
- d) **Switch-up (Q08):** trap_hybrid's last 2 beats hold only stutter + dive energy (kit and first_hit lanes, from take.json). e) **Grid-aware claps (Q22)** from take.json or detected on the drums stem.
- f) **Loudness:** `st_max_lufs` → (−7.5, −6.5, 0.5); `true_peak` → (−120, −1.0, 0.2) (C12); `int_lufs` info only. g) `STYLE_TARGETS['trap_hybrid']`. h) **Pauses (Q28):** 0–1 per 16 bars on non-vocal stems.
- i) Selftests inject a whiny first hit, a swell-filled gap, a bass hit on the snare, a gated sub.
- **Accept:** `--selftest` flags each injected fault; corpus-calibrated targets on main.

**M2.5 Performance** · S2 + S3 · M
- Targets: first play < 5 s after stems; a full take < 20 s; a warm ROLL < 10 s; a SWAP < 1 s per 4 bars; export < 20 s for 5 minutes.
- a) Bank cache (M1.3c). b) Progressive prepare ✅ (first 16 bars, then the first drop). c) If `resample_chain` is hot, print banks in a thread once the first 16 bars are playable.
- **Accept:** measured on 3 corpus tracks and logged in M2.8.

**M2.6 REMIX ALL** · S4 (+S3) · M · deps: M3.1
- a) Multi-select tracks in "pick a track" → REMIX ALL. b) The app loops `POST /api/remixes` (random seed) → `/build` → `/prepare` per track; jobs queue on the server's `remix` lane; no new route.
- c) RemixAllQueue: inline per-track progress in the ProgressStrip or the drawer; you keep working. d) Results arrive as takes on each track.
- **Accept:** 7 tracks queued without blocking the UI; each result opens as a take.

**M2.7 Per-bus stems for QA** (new) · S2 writes, S3 grades · M
- a) **S2:** `--stems` writes the audition window pre-master as FLAC-16 per take, from mixdown's lane buffers: `-sub` (bass lanes < 120 Hz), `-mid` (bass lanes > 120 Hz + top), `-drums` (drums, kit, kit-fx), `-rest` (vocals, other). The master's make-up gain goes into take.json. ~2.5 MB per stem; ≤ 0.5 GB per corpus run, overwritten each run.
- b) **S3:** `remix_qa.py` reads the stems when present: Q12, Q18 (mid crest 6–10, ≤ 8 tearout/riddim), Q21, Q22, Q31 (vs the original's drum stem ±1 LU), Q33, Q15, Q13, and Q07/Q28 on non-vocal stems.
- **Accept:** every stem check runs; the four §2.2 flags are re-measured on stems; the mixdown-only mid-crest target is retired.

**M2.8 The corpus matrix** (new) · S2 (running) + PM · S
- a) Finish 4 recipes × 7 tracks; add the tearout flip after C18. b) `out/remix-corpus/summary.md` (local): PASS/WARN/FAIL by check × recipe × track, plus timings.
- c) Triage each FAIL (engine / voice / QA target / source quirk) with an owner and an item. d) Re-run after each merge that touches `fvwks_fx.remix` or `fvwks_synth`.
- **Accept:** the table exists; every FAIL has an owner.

### M3 "Lite DAW": your priorities first (unstyled until the design package)

**M3.1 TAKES/ROLL** · S4 · M · built unstyled ✅ aeaade4
- a) ✅ One Remix doc with `Remix.takes` (C1).
- b) ✅ BUILD makes take 1. ROLL = PATCH a new seed → build → prepare. The TakesStrip keeps ~6 (the oldest unstarred, unedited take is trimmed), with R and 1–6, A/B, star, rename and two-step delete.
- b2) v0.11.9: edits survive a switch (saved into the take, restored by BUILD). REBUILD sends `fresh: true` in two steps.
- c) TakeCard: TAKE n · SEED, style, loudness (from the mixdown report), TakeRating (S5 ✅, wired by S4). d) Switching is instant: the prepared clips and the doc already exist.
- **Accept:** switching between prepared takes < 100 ms; a ROLL plays its first 16 bars within 5 s.

**M3.2 Editing the arrangement** · S4 · L · deps: M3.1
- a) Undo/redo over a stack of `RemixUpdate` bodies (⌘Z / ⇧⌘Z); on a 409: refetch, re-apply, re-PATCH. b) Multi-select (shift-click, box); copy/paste/duplicate sections and clips (⌘C/⌘V/⌘D).
- c) Split at the playhead (S): `arrangement.ts` mirrors `arrange._part` (the source advances; fades land on the cut). d) ⌫ deletes; snap BAR/BEAT/1/16; zoom ⌘+/⌘− and FIT; loop (L); ShortcutsOverlay (?).
- e) Editing never re-prepares: a move or split keeps `clip_key`, so the server's `_keep_prepared` keeps the audio.
- **Accept:** DU1 §3's gestures work; no engine call on move/split/duplicate.

**M3.3 SWAP SOUND per clip and per lane** · S4 (+S2 API, +S3 library) · M · deps: M1.7
- a) SwapSoundPopover on a bass clip: families → sounds, each with a 2 s audition. Tabs: TEAROUT (CHOMP, TALKER, DISPERSER, DIVE, PWM RESO, METAL, GUN, MACHINE GUN) · RIDDIM (WUB, YOI + library) · 808 (808 LINE, DARK HIT + library) · WOBBLE / REESE / GROWL; a small TOP section (ARP, POWER-UP, COIN, SQUEAK).
- b) A swap PATCHes the clip's `patch_id` (`voice:<style>`, `808:line`, `top:*`, a library id) and re-prepares only that clip; a drum clip swaps `kit_id`; the lane's SwapMenu swaps every clip on the lane.
- c) The library needs `BassPatch.category` tearout and top (a v0.11.10 candidate); until then the app groups by `patch_id` prefix.
- **Accept:** a swap re-renders in < 1 s per 4-bar clip; an audition plays within 300 ms (cached previews).

**M3.9 Your own sample packs** (new, 1.5.1 by the user's decision 2026-09-29) · S4 + S2 · M. Drop a folder of one-shots (e.g. SampleRadar, Cymatics, W.A.) into the kit and sound pickers. The files stay on your Mac: royalty-free packs can't ship in FoxBox, but you may use them.

**M3.4 Per-lane mixer** · S4 · M · lower priority, may slip to 1.5.1. Per-lane gain, mute, solo and a meter; the macro knobs (GRIT, WOBBLE, SUB, GLIDE) as before; no mixer page (DU1 §10).

**M3.5 Apply the Claude Design package** · S4 · L · deps: M3.8. Prompt v2 + update 1: no page title; an 11 px floor; 4.5:1; 24 px hit areas; no modals; file names only; no "AI"/"generate"/"smart"/"learning" wording. **Accept:** matches deliverables 1–7.

**M3.6 Drop-anatomy markers** (new) · S4 (+S2) · S · deps: M1.7. GapMarker, FirstHitMarker, PauseMarker, SwitchMarker, read from the take's choices (`drop.gap`, `drop.pause`, `drop.pause_len`, `drop.cadence`) and the clips (`808:dark`, the `kit-x` switch-up); read-only in 1.5; colour-blind safe; always labelled. **Accept:** each marker within 10 ms of its rendered event.

**M3.7 The bass reads as layers** (new) · S4 · S. BASS (the long held 808) under SYNTH BASS (short hits); the BOUNCE curve dips at kicks **and** snares (from the M1.14 envelopes); KitPicker 2 s auditions (previews ✅); the loudness readout on every TakeCard.

**M3.8 The design package** (new) · PM + you · S. a) The PM pastes DU1 into the Claude Design chat. b) You approve the 7 deliverables (TAKES with 4–6 takes; SwapSoundPopover; multi-select + EditToolbar + ShortcutsOverlay; anatomy markers; RemixAllQueue; PatchPicker tabs + the VIP BASS row; the prototype pass). c) The bundle goes to S4 (M3.5).

### M4 "Learns your taste": the feedback loop (details in §7)

**M4.1 Contracts v0.11.8 and routes** · PM ✅ 063bd19 · S3 routes · M
- a) ✅ The models and routes (§7.2). b) **S3:** SQLite `take_feedback` (TakeFeedback rows) + `remix_prefs_reset` (style, reset_at); counts computed on read from the rows after the last reset (history kept). POST checks the seed is in `remix.takes`, copies `style` and `choices`, sets `RemixTake.rating`, credits per §7.3.
- c) **S3:** the build job upserts `Remix.takes` from `run()` and passes the `prefs` for `style_of(remix)` into `run()`.
- **Accept:** one happy-path test per route, plus 404 (unknown seed) and 409 (stale rev).

**M4.2 The feedback UI in TAKES** · S5 ✅ 69e3f7b · S4 wires it · S. TakeRating (+/−), ReasonChip(s) for the 9 tags, TasteReadout ("ROLL leans on N ratings · STYLE"), a two-step RESET; inline and keyboard-first; never AI/smart/learning wording. **Accept:** a take rated in ≤ 2 keystrokes; the rating persists; the readout updates.

**M4.3 Preference weights** · S3 (server credit) + S2 (engine draw) · M · deps: M1.7, M4.1
- a) The server stores up/down per (style, axis, option) with §7.3's tag-scoped credit (floats ✅). b) `styles.resolve(style, seed, prefs)` uses §7.3's weighted Thompson draw with the 5% floor. c) The PM aligns the v0.11.8 docstrings (C10).
- **Accept:** §7.3's worked example reproduces in a unit test; after 10 synthetic 👍 on one option its ROLL share rises from its default to ≥ 0.6; RESET restores the defaults.

**M4.4 Golden takes** · S2 · M · deps: M2.1
- a) LOVE IT takes (and those the PM promotes) → `out/goldens/<track>-<style>-s<seed>/`: take.json, qa.json, `fp.npz` (4-bar chroma+MFCC), the MP3; local, git-ignored. b) `remix_audition.py --goldens` re-renders each golden from take.json after every engine change, runs QA and diffs.
- c) **Block:** an invariant flips PASS → FAIL, or a choice no longer resolves. **Flag:** another check crosses its band, loudness moves > 0.5 LU, or any block's fingerprint cosine < 0.9 ("sounds different"). d) The PM accepts (re-baselines with a note) or asks for a revert.
- **Accept:** ≤ 40 goldens in < 5 min; merges that block are held.

**M4.5 QA calibration from ratings** (new) · S3 + PM · S · deps: M2.7, M4.1. `remix_qa.py --calibrate ratings.jsonl` proposes `STYLE_TARGETS` diffs (§7.6); the PM approves; S3 commits; invariants are never widened. **Accept:** a diff is proposed only when its evidence thresholds are met.

**M4.6 Recurring tags → rules** (new) · PM · S, ongoing. The §7.8 process: a recurring tag → one confirming question to you → a rule in §9 and `remix-taste`, with an owner, a parameter and a QA check. **Accept:** every new rule appears in §9 with its code location and check.

### M5 "Ship in 1.5"

- **M5.1 The design, applied** · S4: M3.5 done; M3.1–M3.3 and M3.6–M3.7 styled; the functional page complete.
- **M5.2 Corpus QA green, listening gates passed** · S2 + S3: 7 tracks × {tearout, riddim, trap_hybrid, hybrid VIP, resample VIP} × 2 seeds with FAIL = 0; L3–L10 passed; goldens green.
- **M5.3 The candidate** · S4: surgepy build and signing; fvwks_synth bundled; the runtime stays v1.2.1 (`latest-mac.json`, `uv lock --check`); the update-size check; an isolated launch (`.test` bundle id, temp HOME/CFFIXED_USER_HOME; never touch your data or TCC).
- **M5.4 The main-flow walk** · S1 + S3: pick a track → BUILD → ROLL ×2 → rate take 2 up (GROWLS) → switch to take 2 → swap one clip's sound → export AIFF + cues, MP3, .als BETA, SEND TO VISUALS; REMIX ALL on 3 tracks.
- **M5.5 Docs and publish** · PM + S4: a REMIX README and WHAT'S NEW (no artist names in the UI or notes); THIRD_PARTY_NOTICES (Surge GPL-3.0, pedalboard GPL-3.0, tr808 CC0); history-free snapshot rules; publish only with your OK.

---

## 6. Session queues (in order; the first item is next)

- **PM:** (C1, C10 and C18 decided ✅) → the merge rule: S2 is the engine integrator (it merges S1's and S3's voice branches into help/s2-bassdna, so the corpus runs on real voices), and S4 merges S2 plus S3's server into the app → paste DU1 (M3.8) → one listening page and one AskUserQuestion per §11 gate → keep §9 and `remix-taste` in sync → check `df` at check-ins.
- **S1:** M1.15 wobble + downsample wub → `riddim.AXES`/`bass808.AXES` (C11, M1.4b) → M1.4a shift + delay option → M1.12 with S2 (`render_808_line` for BASS DNA) → loops for L4, L5, L9 → re-voicing after L1.
- **S2:** M2.8 finish the corpus run → M2.7a stems → M1.17 the four flags → M1.7 + M2.2 styles, resolver and take record → M1.14 WYHIWYG → M1.10 drums on `drums.py` → M1.8, M1.9 → M1.2c/d tearout sequencer → M1.5b/c riddim held sub → M1.12 → M1.11 → M1.18 → M2.1a–f → M4.4 → M2.3 → M2.5. Every render goes through the corpus QA.
- **S3:** M2.7b stem grading → M2.4 → M1.16 re-fade → M1.13 → M4.1b/c + M4.3a (feedback and prefs routes, take upkeep) → M1.1b act on L1 → M1.2b hero hit → M1.3b only if L3 asks → M4.5.
- **S4:** perf, soak and startup ✅ → M3.1 ✅ → M3.2 (in progress; undo history per take) → v0.11.9 per-take edits in the client → M3.3 → M2.6 → M3.6/M3.7 → M3.4 → M3.5 and M5 when the package lands.
- **S5:** the REMIX UX pass as S4 lands pieces (discoverability, the ShortcutsOverlay, dead ends, the lite-DAW feel) → audit the M3.2 gestures against DU1 §3 → the TasteReadout and RESET wording.

---

## 7. The feedback loop

### 7.1 The dev loop (now, and alongside M4)

1. **Change the engine, not a clip.** A session changes engine code or data (styles, voices, rules), never a one-off render.
2. **Render the corpus.** `remix_audition.py --corpus ~/<test media> --seeds 1,2 --stems --out out/remix-corpus` makes ~70 takes, each with take.json, an MP3 and stems.
3. **Grade.** `remix_qa.py` grades each take per style, on the mixdown and the stems → `qa.json` + `summary.md` (M2.8).
4. **Gate.** A take that FAILs any invariant (I1–I12) never reaches you; the session fixes it first. WARNs are listed.
5. **Diff the goldens.** `--goldens` diffs every golden (M4.4); flags go to the PM, who accepts or reverts.
6. **Build the listening page.** The PM builds `out/remix-audition/listen.html` (local, file names only): 2 tracks × 2 seeds per style, plus each original drop.
7. **You listen and rate.** You give each take 👍/👎 with the app's 9 reason chips plus free text (AskUserQuestion), plus the §11 gate questions.
8. **The PM records it:**
   - the verdicts as TakeFeedback-shaped rows in `out/remix-audition/verdicts.jsonl`, so they can seed the app's counts once M4.1 is live;
   - rules → §9 and `remix-taste` (§7.8);
   - preferences → the default weights in `styles/*.json` (that's how dev ratings move the defaults before M4).
9. **Owners implement.** Each fix comes as code plus a QA check wherever it's measurable: "whiny" → Q13; "too long" → Q07/Q09; "sounds like trap" → Q17/Q23 + the riddim no-808 rule.
10. **Repeat** from step 2.

### 7.2 In the app: contracts v0.11.8 (frozen ✅ 063bd19)

```
TakeTag  = "growls" | "rhythm" | "mix" | "arrangement" | "sounds_like_trap" | "too_long" | "whiny" | "boring" | "love_it"
TakeChoice          {axis: str (<= 64), option: str (<= 64)}                  e.g. {"riddim.drums", "seesaw"}
RemixTake           {seed, style, choices: [TakeChoice], name?, starred, rating: -1|0|1, created_at}
Remix.takes         [RemixTake], oldest first; BUILD adds or refreshes the take for Remix.seed
RemixTakeEdit       {seed, name?, starred}         RemixUpdate.takes = the takes to keep (a seed left out is deleted)
TakeFeedbackCreate  {seed, rating: -1|0|1, tags: [TakeTag] (<= 9), note? (<= 500)}
TakeFeedback        {id, remix_id, seed, style, choices (copied at rating time), rating, tags, note?, created_at}
PrefOption          {option, up: float, down: float}       PrefAxis {axis, options}
RemixPrefs          {style, ratings, axes: [PrefAxis]}     RemixPrefsResult {styles: [RemixPrefs]}
POST   /api/remixes/{id}/feedback   TakeFeedbackCreate -> TakeFeedback   (404 when the seed isn't a take)
GET    /api/remix-prefs             -> RemixPrefsResult
DELETE /api/remix-prefs/{style}     -> 204  (RESET; two steps in the UI)
```

- **"Refresh" never re-resolves.** Rebuilding an existing seed keeps its choices (§4.1); only engine-version fields may change.
- **v0.11.9 ✅ 0a8be85:**
  - `RemixTake.sections`/`lanes`: a take's own edited arrangement, saved when you switch away and restored by BUILD.
  - `RemixBuildRequest {fresh}`.
  - `GET /api/remixes?song_id=&recipe=`.
- **v0.11.10 candidate:** `BassPatch.category` tearout and top (M3.3c).

### 7.3 Preference weights: the math (plain counting)

For each style s, axis a and option o, the server keeps float counts **up** and **down**.

**Credit per take (tag-scoped; C10).** Each take counts once, from its latest feedback: a re-rating replaces the earlier one, rating 0 withdraws it, and the history rows stay (S5's find, 03:20). `ratings` = the takes whose latest rating isn't 0.
- 👍: +1 up for every option the take used. LOVE IT: +2, and the take becomes a golden.
- 👎: +1 down on the axes its tags map to (§7.4) and +0.25 down on the take's other axes. With no tags: +0.5 on every axis.
- A rating of 0 adds nothing. `sounds_like_trap` on a trap_hybrid take is ignored.

**The draw on each ROLL** (BUILD with a new seed), on the axis's own seeded stream:
1. θ_o ~ Beta(1 + up_o, 1 + down_o) for every option (the Thompson step).
2. p_o = w_o·θ_o / Σ_j w_j·θ_j, where w is the default weight from §4.3.
3. p_o ← max(p_o, 0.05), then renormalize. The floor keeps every option alive, because there isn't one right answer.
4. Draw o from p.

The expected share is ≈ w_o·μ_o / Σ_j w_j·μ_j, with μ = (1 + up)/(2 + up + down). With no ratings the shares ≈ the defaults, and the defaults keep mattering after the first rating, unlike a pure argmax (C10).

**Worked example: AX-14 `riddim.drums`, defaults whack 0.50 · seesaw 0.35 · backbeat 0.15**

| Option | Ratings on riddim takes that used it | Counts | Beta | μ | w·μ | Expected share, before → after |
|---|---|---|---|---|---|---|
| whack | 3 👍, 1 👎 tagged rhythm (mapped: full blame) | up 3, down 1 | Beta(4, 2) | 0.667 | 0.333 | 0.50 → **0.65** |
| seesaw | 2 👎 tagged sounds_like_trap (mapped) | up 0, down 2 | Beta(1, 3) | 0.250 | 0.088 | 0.35 → **0.17** |
| backbeat | 1 👍, 1 👎 tagged mix only (unmapped: 0.25) | up 1, down 0.25 | Beta(2, 1.25) | 0.615 | 0.092 | 0.15 → **0.18** |

**One ROLL, step by step:**
1. The draws are θ = (0.58, 0.31, 0.74).
2. w·θ = (0.290, 0.109, 0.111), so p = (0.569, 0.213, 0.218).
3. The seed's uniform number is 0.62, which falls in seesaw's slice (0.569–0.782).
4. So this take tries the seesaw again. That's exploration: no option ever disappears.

**Reproducible:** the draw is a function of (seed, axis, prefs snapshot), and the result is stored in `RemixTake.choices`, so later ratings never change an existing take.

### 7.4 Tag → axis → parameter

| Tag (UI chip) | Axes that take full 👎 blame | Dev-loop parameters (owner) | QA to check |
|---|---|---|---|
| growls (GROWLS) | AX-22, 23, 24, 25, 26, 17, 19, 12, 29 | Voice params, midbus depth, resample passes, notch depth (S3/S1) | Q18, Q20, Q24, Q25, Q29 |
| rhythm (RHYTHM) | AX-14, 15, 16, 23, 05, 06 | Grid variants, the `d` offset, swing (S2) | Q22, Q23, Q30 |
| mix (MIX) | AX-09, 10, 11, 12, 13 | Duck depths, the owner level, the bus clip (S2/S3) | Q17, Q18, Q21, Q31 |
| arrangement (ARRANGEMENT) | AX-03, 04, 06, 07, 20, 24, 28 | Cadence, pause use, drop form (S2) | Q26, Q28 |
| sounds_like_trap (SOUNDS LIKE TRAP; riddim only) | AX-14, 15, 16, 18 | No 808, glides or rolls in riddim; a clean sine sub (S2/S1) | Q17, Q23 |
| too_long (TOO LONG) | AX-01, 04, 27 | Gap, pause length, first-hit length (S2) | Q07, Q09, Q28 |
| whiny (WHINY) | AX-26, 27, 21, 32 | The 808 blip and τ, the dark-hit take, the chomp snap, the top layer (S1/S3) | Q13, Q20 |
| boring (BORING) | AX-06, 20, 24, 21, 22 | Switch cadence, generations, the top layer (S2/S3) | Q24, Q25, Q26 |
| love_it (LOVE IT) | (up +2 on every axis) | → a golden (M4.4) | all |

### 7.5 Goldens

- **Selection:** LOVE IT → a golden automatically; 👍 → a candidate the PM may promote. At most 3 per (track, style) and 40 in total.
- **Storage:** `out/goldens/`, local only and never committed; the corpus titles never appear.
- **Diffs:** blocks and flags as in M4.4. The PM re-baselines only with a note in the take's folder.
- **Unresolvable goldens:** if an option was removed, the change is blocked until the option returns or you retire the golden.

### 7.6 QA calibration from ratings (M4.5)

- **Evidence:** Dev-loop takes always carry QA values; in-app ratings stay on your machine; they're used only when you share them (the PM hands you a one-line export command; nothing is read otherwise).
- **Widen** check c for style s when ≥ 3 👍 takes from ≥ 2 tracks sit outside its PASS band. Proposal: the 10th–90th percentile of the liked values, ± the margin.
- **Tighten** it when ≥ 3 👎 takes whose tags map to c (§7.4) PASS it. Proposal: the band of the 👍 values.
- **Invariants (I1–I12) never move with ratings.** Only you change a rule (§7.8).
- **Output:** a `STYLE_TARGETS` diff with its evidence rows; the PM approves and S3 commits.

### 7.7 Reset and per-style scope

- **Per style:** prefs are keyed by `style_of(remix)` (tearout, riddim, trap_hybrid, hybrid, resample:<style>, halftime, dubstep140, fourfloor, dnb, library). A riddim rating never moves tearout's odds; shared axes (AX-01..13) still count per style.
- **RESET** (two steps in the UI): `DELETE /api/remix-prefs/{style}` writes `reset_at`, and the counts are recomputed from rows after it. The rows stay, for the registry and the goldens.
- **The readout:** TasteReadout shows "ROLL leans on N ratings · STYLE", where N = `RemixPrefs.ratings` since the last reset.

### 7.8 Recurring tags → rules (PM)

**The signal:** the same tag on ≥ 3 of the last 10 rated takes of one style, or on takes from ≥ 2 tracks in one session.

**The steps:**
1. **Check for a preference first.** If one axis option explains the tag (e.g. every sounds_like_trap 👎 used `riddim.drums = seesaw`), it's a preference: the weights already handle it, so no rule is needed.
2. **Otherwise, ask you once.** If it cuts across options, the PM asks one AskUserQuestion, e.g. "Riddim takes keep getting SOUNDS LIKE TRAP. Should riddim never use X?" [make it a rule] [keep it a preference] [other].
3. **Make the rule.** It goes into §9 and `remix-taste` in your words, with an owner, a parameter and a QA check that holds for every option (a new invariant). An option that can't meet it goes to weight 0.
4. **Confirm.** The next corpus run and the goldens confirm it.

**Never:** a rule from a single rating, or a rule that crowns one valid convention (R14).

---

## 8. QA gates (`scripts/remix_qa.py`)

- **Live** means on main (9183b5d/371ec58).
- **mix** = measured on the mixdown · **stems** = on the M2.7 buses · **doc** = from take.json.
- In the Source column, ✅ = well sourced; ~ = calibrate it.

| Q | Check | How | Target (per style) | Source | On | Status |
|---|---|---|---|---|---|---|
| 01 | Drop loudness | Short-term (3 s) max, BS.1770 | −7.0 ± 0.5 LUFS (WARN ±1) | R9 ✅ | mix | live with a −12..−4 placeholder → M2.4f |
| 02 | True peak | 4× oversampled, on the decoded MP3 | ≤ −1.0 dBTP | SB ✅ | mix | live with a ≤ −0.8 placeholder → M2.4f |
| 03 | Integrated loudness | BS.1770 | info | – | mix | live |
| 04 | Limiter GR on the drop | Logged by `master()` | ≤ 3 dB | SB ~ | engine | pending (S2 logs it) |
| 05 | Build vs drop | Short-term mean, the last 4 build bars vs the drop | +4..+6 LU | SB ✅ | mix | live |
| 06 | Intro vs drop | Same | −8..−10 LU (the source's intro; info) | SB ~ | mix | pending, info |
| 07 | Pre-drop quiet | The quietest ½ beat in the last beat before the drop | ≤ −40 dBFS, non-vocal when there's a cue; not for trap_hybrid | SB ✅, R3 | mix → stems | live (full band) → M2.7 |
| 08 | Switch-up present | The last 2 beats hold only the stutter + dive | present, with the other lanes silent | R7 | doc + stems | pending M2.4d |
| 09 | No breakdown | Silence before the drop ≤ 1 beat; the 2 beats before the gap within 10 dB of the build | pass | R3 | mix | pending M2.4 |
| 10 | Drop attack | The fade-in on beat 1; the onset vs the grid | ≤ 7 ms; ±5 ms | SB ✅ | mix | live |
| 11 | Bass in place | `bass_in_db`, `bass_lag_bars` vs the original | lag 0 | ER ✅ | mix | live |
| 12 | First hit hardest | Peak and 100 ms RMS of the first bass hit vs every later bass hit | ≥ +1.5 dB (design +2..+3) | R5, FP (SB's +0.5 is the mix floor) | stems | live on mix at +0.5 → M2.7 |
| 13 | Whine | A low-stem pitch track over the first 60 ms; the 50 ms centroid | ≤ +7 st, settled ≤ 30 ms; centroid ≤ 3× f0 | R6 | stems | pending M2.4a |
| 14 | Sub mono | L/R correlation, LR4 < 120 Hz | ≥ 0.95 | SB ✅ | mix | live at 0.90 → 0.95 |
| 15 | Sub purity | Sub-stem energy above 3× f0 vs f0 | ≤ −25 dB | SB ~ | stems | pending M2.7 |
| 16 | Sub vs the original | 30–90 Hz RMS vs the original drop | ±1 dB | SB ~ | mix | live (needs original-drop) |
| 17 | Sub/mid balance | RMS 30–120 Hz vs 150 Hz–4 kHz | tearout/riddim −4..+2 · hybrid/trap −10..−6 | SB ~ | mix | live |
| 18 | Mid crest | Peak − RMS of the mid bus | 6–10 dB (≤ 8 tearout/riddim) | SB ~ | stems | live on mix (not valid there) → M2.7 |
| 19 | Mid correlation | L/R, 150 Hz–1 kHz | ≥ 0.5 | SB ~ | mix | live |
| 20 | Whistle | The worst 1/3-octave band (1–5 kHz) over its neighbours | ≤ 6 dB | SB ✅ | mix | live |
| 21 | Snare on top | Mix: the snare window holds the bar's max peak (bar 1 excluded). Stems: snare peak ≥ bass-bus peak | ≥ 75% of bars | SB ~ | mix + stems | live (mix) → M2.7 |
| 22 | Snare window clear | Mid onsets within ±1/16 of each clap (from the take's grid, or claps found on the drums stem) | 0 | SB ✅ | stems | live (step 9 on the mix) → M2.4e |
| 23 | Onsets per bar | Mid onsets per bar | riddim 4–9 · tearout 6–14 · hybrid 3–8 | SB ~ | mix | live |
| 24 | Timbre movement | `centroid_move`; `centroid_std_hz` within a beat | tearout ≥ 300 · riddim ≥ 150 · hybrid ≥ 100 Hz | SB ~ | mix | live |
| 25 | Distinct states | Centroid clusters | ≥ 3 per 4 bars; tearout ≥ 3 per bar | SB ~, v1 | mix | live per 4 bars → per bar in M2.4c |
| 26 | Novelty / repetition | The cosine of consecutive 4-bar chroma+MFCC blocks | tearout/hybrid ≤ 0.97; riddim bars 1–4 ≥ 0.8 | SB ~, FP | mix | live (≤ 0.97) → riddim M2.4c |
| 27 | Held weight | The longest held 30–90 Hz run per 4-bar phrase | ≥ 1 bar | R2 ✅ | mix → stems | live |
| 28 | Beat pauses | ≥ ½-beat windows ≤ −30 dBFS inside the drop | 0–1 per 16 bars (≤ 2 per 32) | R4 | stems (non-vocal) | live (=1, mix) → M2.4h |
| 29 | Clicks | > 4 kHz energy packed into 0.3 ms, buzz excluded | 0 at joins; ≤ 2/min mix-wide | SB ✅ | mix | live |
| 30 | Grid alignment | Bass and drum onsets vs the 1/16 or 1/8T grid | 95% within ±5 ms | SB ✅ | stems | pending |
| 31 | Drum loudness | Kit LUFS vs the original drum stem over the same bars | ±1 LU | SB ✅, ER | stems | pending M2.7 |
| 32 | One mid voice per step | From the take's hit list | tearout ≤ 1; riddim ≤ 2 (with the squeak) | FP | doc | pending |
| 33 | Mid below 120 Hz | Mid-stem energy under 120 Hz vs 150 Hz–4 kHz | ≤ −30 dB | FP | stems | pending |
| 34 | Silence per bar | Silent 1/16 slots on the mid stem | riddim/tearout ≥ 1 per bar; tearout bars 1–2 ≥ 30% | FP, v1 | stems | pending |
| 35 | One low-end owner | From the take (lanes and spans) | never sub + 808 in one span | SB | doc | pending |
| 36 | Take distinctness | Two seeds' drops: the mean 4-bar block cosine | ≤ 0.95 (to calibrate) | v1 | mix | pending M2.4b |
| 37 | Reproducible | Re-render from take.json | identical samples (same machine) | principle | doc | pending M2.1 |
| 38 | Cache key covers the seed | clip_key differs across seeds for seeded clips, and with the context | always | C14 | unit | seed ✅ a0a35d8; context pending |
| 39 | App = export | The clip sum vs the pre-master mixdown, per bar | ≤ 0.5 dB RMS | BE | engine | pending M1.14 |
| 40 | Choices recorded | take.json / `RemixTake.choices` resolve; every option legal for the style | always | R14 | doc | pending M1.7 |
| 41 | Tempo follows the source | The remix bpm vs the source (or ×2/×½) | within ±15% | R8 | doc | pending |
| 42 | In key (later) | Mid-stem chroma vs the source key profile | to calibrate | FP ~ | stems | optional, 1.5.1 |

**Cost:** about 10 s per take on the mix, plus about 5 s on stems. A corpus run is about 70 takes. No sweeps beyond that (lean QA).

---

## 9. The user's rules registry (source of truth: memory `remix-taste`)

| R | Your rule | Enforced by (code) | QA | Research it overrides |
|---|---|---|---|---|
| 1 | Targets: tearout (Cyclops-era Subtronics, Marauda, Kai Wachi); riddim (Level Up, early Subtronics); trap-hybrid (Tape B) | `styles/*.json`; voices §3.7–3.9 | L6 | The FP/SB assumption that Marauda and Kai carry over becomes an explicit target |
| 2 | Keep the source's huge held bass: the sub holds, the mids chop | arrange keeps the 808 lane ✅; AX-18; M1.9 | Q27, Q35 | SB 1.1's riddim gate; the SB 2.1/2.2 SUB gaps at the snare; v1 M1.5's gated sine; `sub_line` gating: all **overridden** |
| 3 | No breakdown: the original build → the original pre-drop hook → at most ~1 beat of silence → the new drop | `arrange._pre_drop_gaps` ✅; AX-01 | Q07, Q09 | SB §1.7 rule 2, §2.5 Form and §4 Whole VIP; FP §0 rule 2 and every B1–B4; SB 1.8's 1-bar fake-out; KAN's 1–2 bars; `resample.breakdown`/`changeup`: **overridden** (the song's own BREAK sections stay) |
| 4 | Beat pauses occasionally, for effect | `arrange._beat_pauses` ✅ → AX-03/04 | Q28 | SB's "once per 16-bar drop" → 0–1 per 16 |
| 5 | The first bass hit is always the hardest | `808:dark`, the hero hit, `FIRST_DB` (M1.17b) | Q12 | QA's +0.5 dB → +1.5 dB on stems |
| 6 | The 808's first hit isn't high or whiny: ≤ +5–7 st over ≤ 30 ms, starting on pitch | `bass808` ✅; the `eight08` blip +5 st/30 ms ✅ | Q13 | SB 2.3's +24 (to +36) st over 80 ms; SB 2.5's +36 st first hit; `growls._808`'s +24 st variant: **overridden** |
| 7 | Trap-hybrid: a 2-beat switch-up → a darker, longer first hit | `arrange._switch_ups` + `_first_hits` ✅; AX-27 | Q08, Q12 | SB 2.3's 1-beat silence entry: **overridden** |
| 8 | Tempo follows the source | `arrange.build` ±15% ✅; AX-08 | Q41 | The styles' default BPMs (SB 145/150, FP 140/145); SB's ±5%/±10%: **overridden** |
| 9 | Club-safe: −7 LUFS short-term, −1 dBTP | `mixdown.loud` + `master` ✅ | Q01, Q02, Q04 | Pro drops at −6..−3 LUFS: **overridden**; QA placeholders tightened |
| 10 | Growl quality is the #1 issue; the initial drop is unique and growly | M1.1, M1.2, AX-28 | L1, L3, L10 | SB 2.5's "growls out until bar 2"; round 2's "growls only at switch-ups": **overridden** |
| 11 | Riddim on 808 chops reads as trap: that's trap_hybrid. Real riddim = a designed wub + a clean sine sub | FLIP_ENGINE riddim → `riddim:wub` ✅; `resample:trap_hybrid` ✅; M1.5c | Q17, Q23, L4 | SB 2.1's resample step 6 (stem slices) for 808-only sources: **overridden** (designed prints) |
| 12 | An engine for tons of remixes of any track; a lite DAW, not a toy (TAKES/ROLL → editing → per-clip SWAP; the mixer last) | the order of M2 and M3 | Q36, Q37 | – |
| 13 | No generative AI in music: DSP, designed synths, resampling, plain statistics | every voice; §7.3's counting | review | – |
| 14 | There isn't always a correct answer: conflicts become seeded axes with weights; ratings shift them; invariants hold for every option | §4, §7.3 | Q40 | Any "pick one" in SB/FP ("pick the Faust model", "default 1 beat", …) becomes an axis |

---

## 10. Risks

| Risk | Impact | Mitigation | Owner |
|---|---|---|---|
| Overfitting to song-1 | High | Corpus QA + goldens on 7 tracks; axes add variety, not song fixes | S2, PM |
| Too many axes → takes feel random | Medium | ≤ 8 take-level axes per style in 1.5; the skeleton and cadence stay learnable; L13 | S2, PM |
| Preferences collapse onto a few options | Medium | The weighted draw + a 5% floor, per-style scope, RESET, tag-scoped blame | S3, S2 |
| Research gaps (no transcripts read; many [INF] numbers) | Medium | Numbers are starting knobs; disagreements become axes; listening gates decide | PM |
| The voice quality ceiling (numpy vs Serum-grade) | High | Chain A resampling, OTT, oversampled clipping, the resonance notch; Surge where it wins; L1/L3 | S3, S1 |
| The app sounds unlike the export (C2) | High | M1.14 + Q39 | S2 |
| The takes-model split (C1) | High | One decision before M3.1 is styled; either model keeps feedback working | PM |
| Stale clips after edits (C14) | Medium | M2.2a context hashing; Q38 | S2 |
| QA false alarms (vocals, the sub, the clipper) | Medium | Stems (M2.7); style-scoped checks (Q07/Q08) | S3 |
| CPU time printing banks | Medium | A bank cache per (track, style, seed family); print after the first 16 bars | S2 |
| Disk (corpus renders + stems) | Low | FLAC-16 windows only, overwritten per run, ≤ 0.5 GB; deletions go to you as a command | S2, PM |
| Runtime dependency creep | Medium | numpy/scipy/pedalboard/pyloudnorm/soundfile only; `uv lock --check` in M5.3 | all |
| Licences | Medium | The corpus stays local (NCS terms); tr808 is CC0; Surge GPL notices; nothing from the corpus ships | PM |
| Tempo edge cases (100 BPM hip-hop, 174 DnB) | Low | The ±15% cap; a half-time grid fallback with a warning (M2.3) | S2 |
| Scope creep | Medium | M3.4 mixer, M1.6 candy, AX-12 Ableton, peak-pick resynthesis and 32-bar drops can slip to 1.5.1 | PM |

---

## 11. Open listening questions (gates, not debates)

Each is yes/no or keep/fix/drop, with an action for each answer. None asks you to pick between valid conventions (R14).

| L | Gate | Listen to | Question | Answer → action |
|---|---|---|---|---|
| 1 | M1.1 | Every tearout voice loop (A–E, gun, mgun, metal, reese) | Keep, rework or drop each? | Drop → weight 0 in AX-22; rework → S3 fixes it and re-auditions |
| 2 | M1.1 | 4 chomp hits: +24 st vs +12 st | Does the chomp's attack read as a click or a whine? | Yes → AX-26 defaults to +12 st |
| 3 | M1.2 | 2 tearout drops per track × 2 tracks | Is it gun-shot tearout, with real gaps, and heavy? | No → S2/S3 fix the named part (sequencer, hero, prints) |
| 4 | M1.4/M1.5 | Riddim on 3 tracks × each drum option | Does each sound like riddim, not trap? | An option that fails → weight 0 plus a fix (all of them may pass) |
| 5 | M1.5 | The 808 line and the 4 dark-hit takes | Is any of them whiny? | The whiny take leaves the variants |
| 6 | M1.7 | One take of each style on one track | Can you tell the styles apart? | No → S2 strengthens each style's markers |
| 7 | M1.10 | The drums alone and in the mix, 3 styles | Do the drums hit like the references? | No → retune the M1.10 bus numbers |
| 8 | M1.11 | Resampled drops on the ncs tracks with growls | Any drum bleed or phasey slices? | Yes → tighten M1.11's rejection thresholds |
| 9 | M1.15 | Trap-hybrid with the wobble, the downsample wub and the chops | A bouncy wobble, not destroyed? | No → S1 retunes |
| 10 | M1.8 | 4 hybrid first drops | Is the initial drop growly and unique enough? | No → AX-28 and the hero stack |
| 11 | M1.6 | Takes with and without the top layer | Is the squeak or candy welcome where it plays? | No → raise AX-21's "none" |
| 12 | M1.8 | 6 takes with pauses and 2 without | Pauses: too many, too few, or right? | → AX-03's weights |
| 13 | M2.2 | 6 ROLLs of one track | Distinct enough, and not random? | → the axis budget; the Q36 threshold |
| 14 | M5.2 | The final corpus page | Ready to ship, per style? | Yes → M5.3 |

---

## 12. Traceability: research → plan

| Research | What it says | Where it lands |
|---|---|---|
| SB §0 #1–#3 | The sub through distortion; the wrong paradigm; no density | §3.1–3.3; I9; M1.13; the foxsynth sub split ✅ 7eb0fab; midbus ✅ |
| SB §0 #4–#5 | One timbre, no arc; replaying the line | AX-06, AX-22–24; Q25/Q26; §3.8 pitch vocabulary; M1.4d |
| SB §0 #6–#8 | The snare isn't cleared; weak drums; a blunt entry | §3.4, I6, M1.9, M1.17d; §3.11, M1.10; M1.8 (✅ bar-late, CUT_BEATS, gap, impact) |
| SB §0 #9–#10 | Tempo; slices from the bass stem only | §3.6, M2.3, M1.18; M1.11 |
| SB §1.1–1.5 | Layers, chain, OTT, sidechain, master | §3.1–3.5; AX-09–13; M1.9, M1.13, M1.14 |
| SB §1.6–1.8 | Tempo; the arrangement laws; the pre-drop gap | §3.6 (±10% overridden R8); M1.8 (rule 2 overridden R3; rule 3 → AX-03/04; rule 4 → M1.17b); AX-01/02 |
| SB §2.1 / §2.2 / §2.3 | Riddim / tearout / half-time hybrid | §3.8 + AX-14–20 + M1.4/M1.5 · §3.7 + AX-22–26 + M1.1–M1.3 · §3.9 + AX-11/27/29 + M1.15 (+24/+36 st overridden R6) |
| SB §2.4–2.5 | 808 VIP / headline | §3.10; M1.12; AX-28; C16 |
| SB §3 / §4 / §5 | Drums / the arrangement template / objective checks | §3.11 + M1.10 + AX-05/13/30/31 · the per-style drop tables (breakdown overridden R3) · §8 |
| SB §6 #1–13 | Implementation list | #1–2 ✅ (S3); #3 M1.8/M1.17; #4 M1.9/M1.14; #5 ✅ + M1.15; #6 M1.3/M1.11; #7 M1.7; #8 M1.12; #9 M1.10; #10 M2.3/M1.18; #11 §3.5; #12 M2.4/M2.7; #13 candy ✅ + M1.6 |
| FP §0 | Your rules, mix invariants, first-hit QA | §4.2 I1–I4, I6, I9; Q12 (+1.5 dB) |
| FP §1 | Riddim: markers, the trap tells, bar by bar, the chain, grids, tempo, mistakes | §3.8; AX-14–20; M1.4, M1.5; R11 |
| FP §2 (+A, B) | Tearout; chain A; the gun shot | §3.7, §3.12; M1.3 ✅ 2414b2e; M1.2 ✅ 0074395 |
| FP §3 | Trap-hybrid | §3.9; M1.15; AX-11 hard |
| FP §4 S3 #1–8 | Oversample, resample-N, the auto notch, the kit, the riddim engine, the sub, tuning, the kick | M1.13, M1.3 ✅, `resonance_notch` ✅, M1.2, M1.4, M1.5, integer ratios ✅, M1.10 |
| FP §4 S2 #1–9 | Split styles, VIP form, first hit, pause, sequencers, the mix bus, tempo, QA | M1.7, R3 (void), M1.17b, AX-03/04, M1.2c, M1.4c, M1.9/M1.14, §3.6, Q32–Q34 |
| ER (16 gaps, 20 ideas) | Plan-vs-code gaps; scored fixes | The M1.18 table; C2, C14; done ideas in M1.18's last row; M1.10c, M1.14 |
| DU1 §1–§5 | TAKES/ROLL, rating, editing, SWAP SOUND, patch tabs | M3.1 (✅ unstyled), M4.2 (✅), C1; M3.2, M3.3, §3.13 |
| DU1 §6–§10 | Styles, the VIP BASS row, drop anatomy, layers, REMIX ALL, kits, loudness, the mixer later | M1.7, §3.13, M3.6, M3.7, C18; M2.6, M1.10, M3.4 |
| BE | Principles, routes, performance, lean checks | §1 (WYHIWYG → M1.14), §7.2, M2.5, M2.8/M4.4; docs drift → M1.18 |
| Your rounds 1–4 + "no correct answer" | The rules | §9 R1–R14; §4 |

