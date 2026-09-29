# Handoff: FoxBox REMIX page (1.5, with brief update 1)

## Overview
REMIX is rail page **03** in FoxBox. It makes lots of bass-music remixes of one track quickly (TAKES + ROLL) and then lets the DJ shape the one they like on a lite-DAW timeline. There are three recipes: **VIP / DROP SWAP**, **MASHUP** and **GENRE FLIP**. Everything runs locally, and the UI never says AI, "generate", "smart" or "learning". The verbs are BUILD, ROLL, SWAP, FLIP and LINE UP.

The chosen look is **HARDWARE**: TRANSMISSION dark console, with panels as recessed wells, LED stripes and meters, and stepped-bar waveforms. It has no scanlines. Glass appears only on the small popovers.

## About the design files
The files in `prototype/` are **design references built in HTML**, a working prototype of the look and behaviour. They are not production code. Recreate them in the existing app, in `app/src/renderer` (React + TypeScript + Vite in Electron, CSS Modules, the `--vb-*` tokens), following its patterns: `Segmented`, `MacroKnob`, `Button`, `Screen`, `Toast`, `useFrame`, `cssVar()`, and so on. Keep the component names below; the unstyled page in code already uses them.

Open `prototype/Remix.dc.html` in a browser to run it. **STATES** at the bottom of the rail jumps to all 20 designed states. It's a review tool; don't ship it.

## Fidelity
**High fidelity.** Colours, type, spacing, states and motion are final. Match them pixel for pixel using the codebase's components.

## Global rules (UX audit, enforced here)
- Text is never below **11px** (`--vb-text-min`), including small caps. Tiny caps use loosened tracking (.06–.22em).
- Dim text is `#8d8a82` on `#0b0b0c`–`#18181b`, which stays ≥ 4.5:1. Only truly disabled controls use `opacity:.45`.
- Every control's hit area is ≥ 24×24. Destructive actions are either two-step (DELETE… → CONFIRM, CUT… → CONFIRM CUT, RESET → CLEAR?) or sit apart behind a 10–14px spacer.
- **No modals.** There are two notification surfaces:
  - the **transport status display**, which replaces floating toasts (see Transport);
  - **inline panels**: the section tool row, the swap card docked in the context panel, and the export and queue drawers above the transport.
- Warnings pair a glyph (▲ / !) with text, never colour alone. Lanes, sections and clips always carry labels.
- Focus is shown everywhere: `outline: 2px solid var(--vb-amber); outline-offset: 2px` on `:focus-visible`.
- `prefers-reduced-motion` switches off every animation and transition. The playhead still moves, because it's functional.
- The UI shows file names only, never paths.
- **No top bar on this page.** The fox mark and engine status sit at the bottom of the rail. BPM, key and loudness live in the transport.

## Layout (1512×982, with 1280×800 as the floor)
The root is a grid: `76px rail | 1fr main`, with no top row. Main is inset 12px and stacks with 10px gaps:

1. **Top row (64px):** `RecipeStrip`, with the build-status line under it · `BuildButton` 148w · `RollButton` 104w · `TakesStrip` (flex 1).
2. **TakeRating row (30px, single line):** shown whenever a take exists.
3. (Optional) the engine-offline alert strip.
4. **Body grid:** `minmax(0,1fr) | clamp(316px, 23cqw, 348px)`, 10px gap.
   - The centre column stacks: Sources (52) · RemixTimeline (flex) · [RemixAllQueue] · [RemixExport drawer] · RemixTransport (52).
   - The right column is the context panel: tabs (40) plus a scrolling body.

Responsive: the root is a size container. Below **1420w or 880h** it switches to compact:
- the recipe labels shorten to VIP / MASHUP / FLIP;
- the transport hides its beat lights, meters and LUFS readout;
- COMPARE labels shorten to ORIG / T2;
- DELETE… becomes ✕;
- the status display uses its short form.

Label visibility inside clips and blocks comes from the **real pixel width** (the root width minus the known column widths), not from fixed thresholds.

## Surfaces (HARDWARE)
- **Panel:** `background:#101012; border:1px solid rgba(0,0,0,.7); border-radius:4px; box-shadow: inset 0 2px 10px rgba(0,0,0,.55), 0 1px 0 rgba(233,229,218,.05)`.
- **Panel head:** 40px, title in Big Shoulders Display 800 14px, tracking .2em, ink colour.
- **Wells** (clips, cards, segmented backs): `#0b0b0c`, or `#0e0e10` for source slots. The border is `rgba(0,0,0,.7)` with `inset 0 2px 6px rgba(0,0,0,.6)`.
- **Buttons:**
  - secondary: fill `rgba(233,229,218,.07)`, `.14` on hover, borderless, radius 2, JetBrains Mono 700 11px;
  - ink primary: EXPORT N in the drawer, LINE IT UP; `#e9e5da` with `#0b0b0c` text, and `#fff` on hover;
  - ember primary: **BUILD only**; `linear-gradient(180deg,#ff5a3c,#e8431f)`, radius 3, `box-shadow: 0 0 18px rgba(255,75,43,.25), inset 0 1px 0 rgba(255,255,255,.3), inset 0 -3px 0 rgba(0,0,0,.25)`.
- **Segmented:** well `#0b0b0c`, 1px `rgba(233,229,218,.14)` border, radius 3, padding 3. The selected option is ink fill with `#0b0b0c` text.
- **Amber chip or button**, for automatic things like SNAP, the stretch/shift badges and suggestions: 1px `rgba(255,178,62,.55)`, fill `.06–.12`, text `#ffb23e`.
- **LED stripe:** 3px wide, radius 1, `box-shadow: 0 0 6px <colour>`. Used on section blocks, take cards, patch rows and recipe cards.
- **LED meter:** N segments, 4–6px tall, 2px gaps. Unlit is `rgba(233,229,218,.1)`, lit is amber, and it turns ok-green when done.

## Components
New names are the ones from update 1.

### Rail (shell)
- 7 items: 01 STUDIO · 02 VISUALS · **03 REMIX** · 04 VAULT · 05 PROD · 06 VOICES · 07 SETTINGS.
- Each item is `clamp(60px,7.3cqh,72px)` tall. The number is Big Shoulders Display 700 19px; the label is Mono 500 11px, tracking .08em.
- The current item gets a 2px ember bar on the left edge (16px inset top and bottom) with a glow.
- PROD sits at opacity .45 with `aria-disabled`, and a WIP badge (1px amber outline) inline under its label.
- The bottom block holds the fox mark (28px, ember) and a status dot plus READY. The dot breathes (1.9s); OFFLINE is ember and blinks at 0.56s (≤ 3 flashes/s).
- Below that is the "?" button, which toggles ShortcutsOverlay.

### RecipeStrip, BuildButton, RollButton
- **RecipeStrip:** a Segmented, 34px tall. Under it, a status line (Mono 11px): the reason BUILD is blocked, in amber, or the current take's summary.
- **BuildButton:** label BUILD or BUILDING in Big Shoulders Display 800 21px, tracking .16em. Under the label, a 12-LED progress strip that fills as sections become ready. It's truly disabled (.45) when blocked:
  - ADD TRACK A;
  - LINE UP TRACK B (in MASHUP);
  - FIX THE KEY FIRST;
  - WAITING FOR THE ENGINE.
- **RollButton:** secondary style, `#111113` with a `.24` ink border. It shows ⟳ ROLL; the ⟳ spins 360° with the `--vb-ease-snap` curve on each roll. Under it is the TasteReadout: "LEANS TEAROUT" in amber once ratings exist, otherwise "KEY R". Its tooltip has the full sentence, e.g. "ROLL leans on 12 ratings · TEAROUT".

### TakesStrip / TakeCard
- **TakesStrip:** a well strip holding up to 6 cards. Each card is flex 1, `min-width:104px`, `max-width:196px`, 54px tall.
- **TakeCard lines:**
  1. `TAKE n` (Big Shoulders Display 800 15px), then ▲ in ok or ▼ in ember, then ★ in amber, then the A/B chip (ice), then the 1–6 key in dim.
  2. The style, e.g. RIDDIM or TRAP-HYBRID (Mono 700 11px).
  3. `#seed · −7.1 LUFS` (dim).
- **States:**
  - current: `#18181b` fill, a 1px ink ring and an ember LED;
  - rated up: the LED turns ok-green;
  - PREPARING: the shimmer overlay, lines 2–3 at opacity .25, and an amber "PREPARING" label.
- Cards enter with `vbCard` (.45s, slide in from the left with overshoot).
- A 7th take drops the oldest unstarred take; the status display says so.

### TakeRating (TakeRating, ReasonChip, TasteReadout)
Everything sits on one 30px line, in this order:
- **Name:** an input, 96px wide, used to rename the take.
- **▲ UP and ▼ DOWN:** when on, UP is ok-green and DOWN is ember.
- **ReasonChips:** GROWLS · RHYTHM · MIX · ARRANGEMENT · SOUNDS LIKE TRAP · TOO LONG · WHINY · BORING · LOVE IT. They appear, staggered 25ms apart, only once the take is rated. When on, a chip is ink-filled. The chips scroll sideways and fade out at the right edge. When the take is unrated, a dim hint shows in their place.
- **☆ KEEP / ★ KEPT**, then **A/B** (marks the take for comparing; when on it has an ice outline and reads A/B ✓).
- **RESET:** only once ratings exist; two-step.
- A 10px spacer, then **DELETE…**, two-step.

Keys: **+ / −** rate the take, **1–6** switch takes, **R** rolls.

Ratings are plain counting over the designed options: `taste[style] += ±1`. `pickStyle()` in `remix-engine.js` weights the style choice by `1 + 0.6·count` (floor 0.2). Never call this AI.

### SourceSlot, MatchBadge
- **SourceSlot:** one 52px row, with a second slot for B in MASHUP:
  - the letter chip (A in ice, B in rose);
  - the title (Big Shoulders Display 800 18px) with meta under it (`140 BPM · C#m · 12A · 4:07`);
  - the track's bar waveform, with BUILD and DROP marker lines and its own playhead;
  - a STEMS ✓ chip, CHANGE, then ✕ after a 10px spacer.
- **SourceSlot states:**
  - empty: "DROP TRACK B" plus PICK;
  - drop target: only real targets highlight, with a 2px dashed ember border, 7% ember fill and "RELEASE TO LOAD INTO A";
  - bad file: "▲ CAN'T READ …" in amber;
  - splitting: 4 stem LED meters (DRUMS / BASS / VOCALS / OTHER), each turning ✓ ok-green when done;
  - reading: 3 meters (DROPS / BASS DNA / DRUMS);
  - failed: "▲ STEM SPLIT FAILED at 61%" in ember, with TRY AGAIN and USE BOUNCED STEMS.
- **Empty page:** one big drop zone, with DROP A TRACK at `clamp(48px,7cqh,72px)` and three recipe cards with LED stripes, staggered in.
- **MatchBadge** (between A and B), 168w:
  - a MashScore ring (r17, stroke 3) that counts up from 0 over ~0.6s after LINE IT UP;
  - the text AUTO-MATCH, with "+2 st · 0.97×" under it;
  - when the keys are too far apart, the ring turns amber and the text reads "▲ 6 ST APART".

### RemixTimeline (RemixPlaylist, BarRuler, SectionLane, SectionBlock, StemLane, Clip, DropMarker, SwapMenu)
**Head (40px):** TIMELINE, the status line, then the EditToolbar:
- ↶ ↷ (disabled at .4 with no history);
- SnapControl: SNAP in amber plus BAR / BEAT / 1/16;
- FOLLOW (a toggle);
- ZoomControl: − `FIT · 144` or `4× · 36 BARS` +.

**Section tool row (34px):** slides in under the head only while sections are selected. It holds the label (DROP 1, or "2 SELECTED"), then ◀ ▶ DUPLICATE SPLIT LOOP, a 14px gap, CUT… (two-step), and ESC. It never overlays content.

**Keys-too-far strip:** amber and inline. It explains the problem and offers SHIFT B +1 ST and FIND ANOTHER IN RADAR.

**Header column:** `clamp(166px,11.6cqw,176px)` wide.
- Lane rows: a ▾ caret (rotates −90° when collapsed), the source dot, the name (Big Shoulders Display 800 13px), then M and S.
  - M on: ink fill.
  - S on: ice fill.
  - When a lane is muted, or another lane is soloed, the lane drops to .35 opacity.
- Collapsed lanes are 26px and show a hint of how to fill them.
- Lanes are auto-expanded when they have material; the user's toggle overrides this.
- Lane order is chosen so the layers read top to bottom: **DRUMS · TOP · SYNTH BASS · BASS · VOCALS · OTHER · KIT**. Short hits sit above the long held 808.
- On the selected lane, the row also shows SWAP ALL ▾ (the lane-wide SwapMenu popover) and a gain fader (amber fill, 4×12 ink thumb, −24 to +6 dB).

**BarRuler (36px):**
- Tick detail depends on zoom:
  - FIT: a tick every 4 bars and a label every 16;
  - 2×: labels every 8;
  - 4×: labels every 4;
  - 8× and up: labels on every bar.
- Phrase lines every 8 bars run through all lanes, a little stronger every 32.
- The loop region is a 3px amber bar with a faint 4% amber band through the lanes.
- Clicking the ruler seeks.

**Drop anatomy markers** (GapMarker, FirstHitMarker, PauseMarker, SwitchMarker) are 14px tags at the bottom of the ruler:

| Marker | Look | Label | Where |
|---|---|---|---|
| GAP | dashed ink outline | "GAP ▸" | right-aligned to the drop start |
| FIRST HIT | solid ember | "◆ FIRST HIT" | at the drop start |
| PAUSE | ice outline | "‖ PAUSE" | 1–2 beats, at bar 8 or 12 of the drop |
| SWITCH | bare amber glyph | "⇄ SWITCH" | every 4 or 8 bars (2 in TRAP-HYBRID) |

At FIT only GAP and FIRST HIT show, as glyphs. At 2× and above all four show with full labels. They're read-only in 1.5 but built as positioned elements, ready for dragging later.

**SectionBlock (46px row):**
- Block style: `#0b0b0c`, a 3px LED stripe in the section colour, the name (Big Shoulders Display 800 14px) and the source (`A · 33`).
- The bar count only shows when the block's pixel width can fit it. The label ellipsizes rather than cuts.
- Selected: a 1px ink border with `0 0 0 1px #e9e5da` and a drop shadow.
- **Drag to reorder:** the block follows the pointer and lifts 3px. The other blocks slide aside live to open a gap (`left/width .3s --vb-ease-glide`). An amber insertion line shows where it will land.
- Shift-click adds a block to the selection.
- The currently playing section gets a live ring plus a glow in its colour. The glow drops out during the GAP.

**Clip:**
- Body `#0a0a0b` with stepped-bar waveforms:
  - source stems: A in ice at .36 (.55 in the selected section), B in rose;
  - BASS in HYBRID or RESAMPLE drops: long **808 HELD** blocks, 2–6 bars each;
  - SYNTH BASS: short hits whose rhythm depends on the sound family (TEAROUT call-and-response with silence · RIDDIM steady wubs · 808 trap pattern). The first hit is always long and tallest;
  - TOP: sparse blips.
- **Merging:** neighbouring clips from the same source merge into one strip, with square inner corners and one tag.
- **Tag:** A in ice, B in rose, or the sound name in ink with dark text. It ellipsizes.
- **Badges** (amber on dark: +2 st, 0.97×, RE-TIMED, 808 HELD) only show on clips ≥ 112px wide. Kit names shorten below 130px.
- **Selected:** a 1px ink ring plus 4px ink trim handles at both ends. The handles are visual only in 1.5.
- **PREPARING:** a diagonal hatch plus the moving shimmer (1.3s linear), the waveform at .22, and the label "PREPARING" ("PREP" under 96px). It appears only on the clip being prepared.
- Waveforms print in left to right (`clip-path` reveal, .75s), staggered 50ms per lane while building.
- Ghost cells are dashed and show where material was swapped out: "→ SYNTH BASS", "→ KIT", "MUTED".

**Overview strip (24px, under the lanes):** the length readout (`4:07 · 144 BARS`), a mini map of the sections, the visible-window rectangle (only when zoomed), and a playhead. Drag it to scroll.

**Zoom:** FIT, 2×, 4×, 8×, 16×, via ⌘+ / ⌘− / ⌘0, ⌘-scroll (anchored at the cursor) or the buttons (anchored at the playhead). FOLLOW keeps the playhead between 12% and 78% of the view by easing `scrollLeft` about 18% per frame.

### SwapSoundPopover (docked)
Clicking a SYNTH BASS, BASS, DRUMS or KIT clip docks a card at the top of the context panel, replacing its content until ← BACK. It holds:
- SWAP SOUND (or SWAP KIT), with the sub-line "DROP 1 · SYNTH BASS · NOW WUB";
- family tabs;
- sound rows, each with a ▶ 2s audition (a 2s amber sweep line).

Picking a sound re-prepares **only that clip**, taking about 1s. The lane's SWAP ALL ▾ menu changes every clip on the lane.

### BassDnaPanel (GrooveRoll, WobbleLane, BounceCurve, PatchPicker)
- **VIP BASS:** a Segmented, HYBRID (the default) · RESAMPLE · ONE PATCH, with a one-line explanation under it.
- **GrooveRoll:**
  - an 8-bar pitch grid, `clamp(84px,12cqh,120px)` tall, in `#080809` with an inset shadow;
  - notes are ink bars, and the first hit is ember;
  - 808 glides are amber curves;
  - the pitch labels are C#1, G#1, C#2;
  - a playhead runs through the roll, the wobble lane and the curves.
- **WobbleLane:** 8 cells, each showing the LFO division, with "TRIP" under triplets.
- **BOUNCE and GROWL:** one 32px graph. BOUNCE is ice and dips on every kick and snare; GROWL is ink at .35.
- **PatchPicker:**
  - a 3×2 tab grid: TEAROUT · RIDDIM · 808 · WOBBLE · REESE · GROWL;
  - sound rows 30px tall, each with an LED, the name, a SURGE or FOXBOX tag, and ▶ 2s;
  - the selected row has an amber edge and gradient;
  - picking a sound sets every SYNTH BASS clip and re-prepares them.
- **TOP:** the toggles ARP · POWER-UP · COIN.
- **MacroKnob ×4** (GRIT, WOBBLE, SUB, GLIDE) at 58px. Same geometry as the Studio MacroKnob: r44 ring, dash 207.35, ticks and a cap. Drag up or down (Shift for fine), arrow keys work, and double-click resets.
- **COMPARE:** OLD BASS | NEW BASS.

### MashRadar (RadarResult, MashScore)
- **Controls:** BORROW FROM B (BUILD / DROP / VOCALS) · bass-style chips (DEEP / TRAP / DUBSTEP) · KEY-COMPATIBLE ONLY · BPM − 132 + TO − 148 +.
- **Status line:** "SCANNING YOUR 214 TRACKS…" with a sweeping amber bar, then "214 TRACKS · 3 GOOD MATCHES".
- **RadarResult:**
  - a 42px score ring (ok at ≥ 80, amber at 65–79, dim below);
  - the title, then the section plus BPM and key;
  - reason chips;
  - ▶ PREVIEW and LINE IT UP (ink). Once lined up it reads ✓ LINED UP in ok-green.
  - Rows rise in 70ms apart.
- **No good matches:** amber suggestions WIDEN BPM TO 124–156, ALLOW KEY SHIFTS and ALL BASS STYLES.

### FlipCards, KitPicker, DrumsRead
- **FlipCards (2 columns):** TRAP-HYBRID, RIDDIM, HALF-TIME, 140 DUBSTEP, FOUR-ON-THE-FLOOR, DNB. Each card shows the target BPM and a 16×2 kick/snare grid. The selected card has an ember border plus an inner glow.
- **KitPicker:** FOXBOX KIT (layered kick, clap-led snare) and four TR-808 kits (1994), each with ▶ 2s. The name sits over the tag.
- **SWING:** a fader.
- **DrumsRead:** a K/S/H × 16-bar heat grid of hit counts. Bar 31 is a roll and bar 32 is silent, with a note under the grid.

### RemixTransport, RemixExport, RemixAllQueue, ProgressStrip
**Transport (52px), left to right:**
- ▶ PLAY / ■ STOP (ember while playing);
- ⟲ LOOP (amber when on; loops the selection, or DROP 1 by default);
- the time (Big Shoulders Display 700 21px) with `BAR 43.2 / 144` under it;
- 4 beat LEDs (ember on beat 1, amber on the others);
- L/R meters (green → amber → ember);
- the live short-term LUFS readout;
- the **status display**: a flexible well, `min-width:150px`. It shows every notification (a dot plus a title in its tone colour, then the body in dim) for 3.4s. Otherwise, while playing, it shows the live position, e.g. "DROP 1 → BREAK · 22", turning amber within 4 bars of a drop and reading "· GAP ·" during gaps;
- BPM, then KEY;
- COMPARE: ORIGINAL | REMIX, or ORIGINAL | TAKE 2 | TAKE 3 once two takes are marked A/B. ORIGINAL shows an ice "◐ HEARING THE ORIGINAL · A" chip over the lanes;
- LINK (a dot);
- EXPORT ▴ (outline), which toggles the drawer.

**RemixExport drawer:** it slides up from 14px (`vbDrawer` .32s).
- Four toggle cards with an LED check:
  - AIFF + CUES ("24-bit · rekordbox cues at every drop");
  - MP3 320;
  - LIVE SET, with an ice BETA tag ("opens in Live 11 and 12");
  - TO VISUALS.
- FILE NAMES preview, e.g. `NIGHTSHIFT (RIDDIM VIP · TAKE 2).aiff`.
- EXPORT N (ink).
- **Running:** a 12-LED ProgressStrip on each card.
- **Done:** file tiles eject in 90ms apart (`vbEject`, as with the Cartridge). Each shows DRAG TO REKORDBOX / DAW with a dashed ember bar, the LIVE SET tile adds "OPENS IN LIVE 11+ · BETA", and the VISUALS tile shows "✓ ADDED TO VISUALS · OPEN →". REVEAL sits alongside.
- **Low disk:** an amber strip, "LOW DISK · 1.2 GB FREE", with SKIP THE LIVE SET. EXPORT is truly disabled until it's resolved.

**RemixAllQueue:**
- Tick tracks in "pick a track" (a checkbox on each row), then REMIX ALL (n) · ONE TAKE EACH.
- The queue is an inline section above the transport: 4 columns, each with the title, a %, QUEUED or ✓ TAKE 1, and a 12-LED bar.
- You can keep working while it runs.

## Interactions and keys
The ShortcutsOverlay opens with ?. It's a panel, not a modal.

| Action | Key |
|---|---|
| Play / stop | Space (ignored when a button, slider, tab or radio is focused) |
| BUILD | ⌘↩ |
| ROLL | R |
| Rate the take | + / − |
| Jump to a take | 1–6 |
| Undo / redo | ⌘Z / ⇧⌘Z (80 steps; snapshots of sections and per-clip sounds) |
| Multi-select | Shift-click |
| Copy / paste / duplicate | ⌘C / ⌘V / ⌘D |
| Split at the playhead | S (snapped to BAR, BEAT or 1/16) |
| Delete | ⌫ (immediate; undo covers it) |
| Move a section | ← → |
| Loop | L |
| Zoom | ⌘+ / ⌘− / ⌘0, ⌘-scroll |
| Close | Esc |

- **BUILD flow:** sections drop in 230ms apart (`vbDrop`: −16px and scaleY .5, overshoot to +3px, 0.55s). Readiness goes in the order opening → first drop → the rest, 520ms apart. Playback auto-starts as soon as the first drop is ready (about 1.2s). Clips shimmer until their section is ready. ROLL does the same but faster (140 / 330ms).
- **What re-prepares:** only a new sound (a patch, kit, key shift or VIP BASS mode). Drag, cut, duplicate, split and paste are instant.
- **The UI reacts to playback:** on each drop's first hit, a 1-bar ember flash runs through all lanes and fades over about 0.4s. During the GAP and PAUSE, the meters drop, the beat LEDs go dark and the section glow drops out.
- **File drop:** only the drop targets highlight. A drop anywhere else never navigates the app. Two files fill A, then B, and switch the recipe to MASHUP. Accepted formats are wav, aiff, flac, mp3 and m4a/aac; anything else shows the bad-file state.

## State (a sketch; see the prototype logic class)
- `recipe`, `panel`, `A`, `B` (each `{t, status: bad|splitting|reading|ready|failed, stems[4], read[3]}`).
- `takes[]` (each `{id, n, seed, recipe, style, bassMode, flip, kit, sections[], clipSnd{key→soundId}, defPatch, lufs, rating, reasons[], star, name}`), `cur`, `ab[≤2]`.
- `building`, `placed`, `readyN{}`, `prep{clipKey}`.
- `sel[]` (section ids), `clipSel`, `drag`.
- `playing`, `loop`, `compare`, `zoom`, `follow`, `snap`.
- `lanes{id:{m,s,g,open}}`, `swaps`, `tops`, `mac`, `bassMode`.
- Radar filters.
- `ex{}`, `exState`, `exProg`, `q`, `engine`, `disk`.
- Taste counts: `taste{style:count}` plus `rcount`.
- The seed makes a take deterministic: `arrange(recipe, seed)` plus `pickStyle(recipe, seed, taste)` in `remix-engine.js`.

Section `{id, type: INTRO|BUILD|DROP|BREAK|OUTRO, bars, src, at, pause?, sw?}`. The demo track is 144 bars: INTRO 16 · BUILD 16 · DROP 32 · BREAK 16 · BUILD 16 · DROP 32 · OUTRO 16, at 140 BPM, 4:07.

## Design tokens
`remix-tokens.css` holds every new token in the `--vb-*` family:
- surfaces: `--vb-rack*`, `--vb-well*`;
- sources: `--vb-src-a/b/fox`;
- sections: `--vb-sec-*`;
- canvas timeline tokens for waveform-playlist: `--vb-tl-*`;
- anatomy markers: `--vb-mk-*`;
- scores and ratings;
- motion curves and durations;
- `--vb-text-min`, `--vb-hit-min`.

The existing tokens are unchanged, and colours are unchanged from TRANSMISSION.

Type:
- Big Shoulders Display 700/800 for names, titles and numbers.
- JetBrains Mono 400/500/700 for everything else, at 11–12px.
- Tracking: display .04–.2em; caps labels .06–.22em.

## Assets
- Fonts: `prototype/fonts/`, the app's own bundled woff2 files.
- The fox mark is drawn inline from `app/design/brand/foxbox-mark.svg`.
- No images. Every waveform, hit pattern, groove and curve is generated (`remix-engine.js`), standing in for the real analysis data.

## Files
- `prototype/Remix.dc.html`: the full prototype (template plus logic class).
- `prototype/remix-engine.js`: demo data (tracks, patches, radar, flips, kits), waveform and hit generators, `arrange()`, `pickStyle()`.
- `prototype/support.js`: the prototype runtime only; not needed in the app.
- `remix-tokens.css`: the new tokens.
