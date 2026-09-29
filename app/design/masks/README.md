# Handoff: FoxBox MASKS page (1.5.1 flagship)

## Overview
MASKS is a new rail page, **03**, sitting right after VISUALS:
01 STUDIO · 02 VISUALS · **03 MASKS** · 04 REMIX · 05 VAULT · 06 PROD (WIP) · 07 VOICES · 08 SETTINGS.

It's a **video-game character creator for the DJ's face mask**. The core loop:
1. Pick a starting mask from a LINEUP.
2. Flip parts in 8 categories.
3. Tune them with sliders, finishes, colours and FX.
4. RANDOMIZE, with a lock on each category.
5. Name it, SAVE it, and WEAR it in VISUALS.

Every mask always covers the whole face; eyes and mouths are drawn, never holes. The look is deliberately **digital, not physical**: faceted low-poly shells, glass and wire finishes, animated crease lines, and abstract constructs (EQUALIZER bars, VORTEX tunnel, SHARDS, VOXELS…) that react to a demo drop.

**Keep the verbs:** SAVE, WEAR, RANDOMIZE, DUPLICATE. Never say "AI" or "generate".

## About the design files
The files in `prototype/` are **design references built in HTML**: a working prototype of the intended look and behaviour. They are not production code. Recreate them in `app/src/renderer` (React + TypeScript + Vite in Electron, CSS Modules, the `--vb-*` tokens), following the existing patterns: `Segmented`, `Button`, `Screen`, `useFrame`, `cssVar()`, the REMIX HARDWARE surfaces, and so on.

The 3D preview is **three.js**. `prototype/mask-head.js` is a *stand-in* renderer that shows the intended geometry, lighting mood, motion and FX behaviour. Treat it as a spec you can lift code from, not as the final renderer.

Run it by opening `prototype/Masks.dc.html` in Chrome; three.js r160 loads from unpkg. **STATES**, at the bottom of the rail, jumps to all 25 designed states. It's a review tool; don't ship it. The Tweaks props at the top of the file:
- `frame`: FILL / 1512×982 / 1280×800.
- `pickLayout`: GRID / **LINEUP** (chosen) / SPOTLIGHT.
- `tileLook`: LED TILE / **POSTER** (chosen) / LIST.

## Fidelity
**High fidelity.** Colours, type, spacing, states and motion are final. Match them with the codebase's components. The mask geometry is a reference: the proportions, facet counts and animation characters are final, but you may improve the mesh construction.

## Global rules (UX audit, enforced)
- **Text:** nothing below **11px** (`--vb-text-min`). Tiny caps use tracking of .04–.22em.
- **Dim text:** `#8d8a82` on `#0b0b0c`–`#18181b` (≥ 4.5:1). Unselected slot values use `#bdb8ac`. Only truly disabled controls use opacity .45: the PROD rail item, the HEADS slot, and A/B before the first save.
- **Hit areas:** every control is ≥ 24×24.
- **Destructive actions:** DELETE… → CONFIRM DELETE / KEEP, inline on the card.
- **No modals.** Notifications go to the **status display** in the preview head, a well that holds each message for 3.6s. Everything else is inline: IMPORT drawer, custom-colour drawer, camera-blocked card, perf strip, duplicate-name choices.
- **Warnings** always pair ▲ with text. Focus is always visible: `:focus-visible { outline: 2px solid #ffb23e; outline-offset: 2px }`.
- **Photosensitivity:** nothing flickers at rest. Glitches fire **only when the drop lands** (DROP HIT) or once a bar (THROUGH DROP). Every pulse or flash stays ≤ 3/s, and the FLASH RATE meter shows the live rate. **REDUCED** turns off glitch, aura, particles, shimmer, halos and physical materials, and runs at 30fps with pixelRatio 1.
- **`prefers-reduced-motion`:**
  - kills CSS animation and transitions;
  - freezes the dummy's idle, piece drift and edge marching;
  - suppresses the scan line;
  - glow uses the slow STEADY breathe;
  - RANDOMIZE applies instantly, with no shuffle.

## Layout (1512×982; floor 1280×800, no page scroll)
The root is a grid: `76px rail | 1fr main`, with **no top bar and no page title**. Main has 12px padding, is a size container (`container-type:size`), and stacks two rows with a 10px gap:

1. **Body grid:** `var(--vb-mk-tabs-w) | minmax(0,1fr) | var(--vb-mk-opts-w)`, 10px gap.
   - **CategoryTabs:** the left column.
   - **MaskPreview:** the centre.
   - **Options panel:** the right column.
   - In MY MASKS mode, the library spans columns 2–3.
2. **SaveBar:** a single strip, `var(--vb-mk-bar-h)` tall. It is hidden in MY MASKS.

**Compact** means root width < 1420 or height < 880. Everything uses clamp()/cqw/cqh, so the only JS switch is shorter strings. Every primary action stays visible at 1280×800.

### Panels (HARDWARE, as in REMIX)
- **Panel:** `background:#101012; border:1px solid rgba(0,0,0,.7); border-radius:4px; box-shadow: inset 0 2px 10px rgba(0,0,0,.55), 0 1px 0 rgba(233,229,218,.05)`.
- **Panel head:** 40–48px. Title in Big Shoulders Display 800 14–16px, tracking .18–.2em.
- **Well:** `#0b0b0c`, border `rgba(0,0,0,.7)`, `inset 0 2px 6px rgba(0,0,0,.6)`, radius 3.
- **Segmented:** a well with a 1px `rgba(233,229,218,.14)` border and padding 3. Options are 24–26px tall, Mono 700 11px. On = `#e9e5da` fill with `#0b0b0c` text; off = transparent with `#8d8a82` text.
- **Buttons:**
  - secondary: `rgba(233,229,218,.07)` fill, `.14` on hover, radius 2, Mono 700 11px;
  - ink primary (SAVE, EDIT, TRY AGAIN, ← EDITOR): `#e9e5da` fill, `#0b0b0c` text, `#fff` on hover;
  - outline (RANDOMIZE, START FROM BASE): `#111113` fill, 1px `rgba(233,229,218,.24)` border; border `#e9e5da` on hover.
- **Ember primary (WEAR and START WITH …):** `linear-gradient(180deg,#ff5a3c,#e8431f)`, `#0b0b0c` text, radius 3. Box-shadow `0 0 18px rgba(255,75,43,.25), inset 0 1px 0 rgba(255,255,255,.3), inset 0 -3px 0 rgba(0,0,0,.25)`; on hover the glow goes to `0 0 30px rgba(255,75,43,.5)`.
- **LED stripe:** 3px wide, radius 1, `box-shadow: 0 0 6px <colour>`. Ember marks the selection; a mask's own glowColor marks preset identity.
- **Amber** means automatic, beat or warning: 1px `rgba(255,178,62,.55–.6)` border, `.06–.14` fill, `#ffb23e` text.

## Screens and components

### Rail (shell)
Same as REMIX, but with **8 items**:
- Each item is `clamp(58px,7.3cqh,72px)` tall: number in Big Shoulders Display 700 19px, label in Mono 500 11px, tracking .08em.
- The current item gets a 2px ember bar on the left edge, inset 16px top and bottom.
- PROD sits at .45 opacity with `aria-disabled` and an amber WIP badge.
- Bottom block: the fox mark (28px, ember), a READY dot that breathes over 1.9s, and the `?` keys panel.

### PickStart: LINEUP (first open, and ← LINEUP)
- **Heading:**
  - kicker: `NEW MASK · STEP 1 OF 3` (Mono 700 11px, .22em, dim);
  - title: **PICK A STARTING MASK** (Big Shoulders Display 800 `clamp(44px,7cqh,72px)`/.86, .04em);
  - sub-line: `Every mask covers your whole face. Swap any part, material or colour after.`;
  - on the right, a `MY MASKS n` outline button.
- **Roster:** a flex row with a 6px gap, one card per preset in order:
  SUBWOOFER (★ FEATURED) · EVENT HORIZON · CHROME FOX · GLITCH SAINT · VOID RAVER · DEEP SCAN · DEAD PIXEL · TOXIC TV.
- **Unselected card** (`flex:1`):
  - a dim thumbnail (opacity .7) under a black fade;
  - a vertical name (`writing-mode:vertical-rl`, rotated 180°, Big Shoulders Display 800 `clamp(20px,3cqh,28px)`, .12em);
  - the number `01…` at top-left;
  - a 3px top LED in the preset's glowColor at .35 opacity.
- **Selected card** (`flex-grow:4.4`, animated over .5s with `cubic-bezier(.2,.9,.2,1)`):
  - the **live 3D stage** (the dummy wearing the mask; drag to spin);
  - the name in Big Shoulders Display 800 `clamp(36px,6.4cqh,60px)`;
  - trait chips (1px `rgba(233,229,218,.2)` border, Mono 700 11px);
  - the LED at full opacity;
  - a 1px `#e9e5da` border.
- **Selecting:** hover, focus or ← → selects a card, and each selection plays a **random act** (see Motion). Clicking a slice selects it; clicking the open card, or pressing ↵, starts from that preset.
- **Bottom bar** (64px panel), left to right:
  - 8 position pips, 18×4 (ember on the current one);
  - `← → BROWSE · ↵ START`;
  - spacer;
  - `START FROM BASE` (outline);
  - `START WITH <NAME> →` (ember, 48px).
- **Entrance (`vbSlot`, .75s, 75ms stagger):** each card drops from −110% at scaleY 1.6, starts at brightness 3 and saturation 0, and is clip-revealed top to bottom. It overshoots to +4%, then does a two-frame ±5px glitch with a hue-rotate before settling. A glowColor scan line sweeps down the card (`vbScanDown`, .7s) and the top LED draws in left to right (`vbLed`).

### CategoryTabs (left)
- **Head:** `PARTS` plus `n CHANGED`.
- **Slots:** 9 slots, each flex 1 between 46 and 66px, with a 4px gap. Each slot is a well:
  - line 1: `01 BASE` in Mono 700 11px, .1em, dim (ink when selected), plus an ember "changed" dot (6px) when the category differs from the preset it started from;
  - line 2: the **current value** in Big Shoulders Display 800 `clamp(15px,2.1cqh,18px)`, `#bdb8ac` (ink when selected, amber when locked). Values look like `EQUALIZER`, `VISOR BAND`, `NONE`, `FACETS`, `[■■■] BONE`, `DROP · 4 FX`;
  - COLOURS shows three 10×14 chips of c1/c2/c3 before the palette name, or CUSTOM.
- **Selected slot:** `#18181b` fill, 1px `rgba(233,229,218,.5)` border, 3px ember LED on the left.
- **CategoryLock:** a 28px square on the right of each slot with a padlock icon. When locked it has an amber border, amber fill `.1` and amber icon; the aria-label reads "Lock BASE for RANDOMIZE".
- **09 HEADS:** disabled at .45 opacity with an amber LATER badge and the value `AFTER 1.5.1`. It isn't clickable. The future-state preview is reachable only from STATES.
- **Keys:** ↑ ↓ change the category.
- **Footer:** a `MY MASKS n` button (50px) with a grid icon. It's ink-bordered while MY MASKS is open.

### MaskPreview (centre)
**Head (48px), left to right:**
- the mask name (Big Shoulders Display 800 20px) with a sub-line:
  - `FROM <PRESET> · NOT SAVED` (dim);
  - `● UNSAVED CHANGES` (amber);
  - `✓ SAVED` (ok);
- ↶ ↷ undo/redo, 28px (truly disabled at .4 with no history);
- the **status display**: a flexible well with a dot, a title in its tone colour, the body in dim, and an optional action button such as `OPEN VISUALS →`. Defaults when idle:
  - `EDITING · n of 8 parts changed from <PRESET>`;
  - `WEARING IN VISUALS`;
  - `ROLLING`;
- a Segmented: **MODEL** | **● LIVE** | **DJ CLIP**. The LIVE dot is ember, or ok while tracking; it shows ▲ when blocked or no face is found.

**Viewport (TurntableView / LiveTryOn):**
- **Background:** `--vb-mk-stage-bg`, plus a faint ember floor glow `--vb-mk-stage-floor`.
- **Chrome:** four 16px corner brackets. Top-left readout: `MODEL` / `Idles, looks around`.
- **Top-right chips:**
  - `◐ A · SAVED VERSION` (ice);
  - `◌ PREVIEWING · CLICK TO APPLY` (amber, while hovering an option);
  - `▶ SOLO · <FX> ON A DEMO DROP`;
  - `REDUCED EFFECTS · 30 FPS · NO SHIMMER`;
  - `HEADS PREVIEW · NOT IN 1.5.1`.
- **Bottom overlay bar** (chips on `rgba(11,11,12,.88)`):
  - **BeatPreviewToggle:** `BEAT` + 4 LEDs + `BUILD · 3/8` / `DROP · 5/8`. Amber LEDs during the build, ember in the drop;
  - **A/B:** `A · SAVED | B · NOW`, disabled until the first save;
  - `DRAG TO SPIN`;
  - `FX FULL | REDUCED`.
- **Behind the dummy** (only while the demo drop plays in the editor, never on the lineup): a faint stepped-bar waveform of the demo track. Build bars are ink, drop bars ember, with a playhead and `BUILD` / `◆ DROP` labels. Canvas behind the WebGL canvas, fades over .6s.
- **LIVE:**
  - asking → amber chip `● WAITING FOR CAMERA PERMISSION`;
  - working → mirrored camera feed with green tracking brackets and the chip `● LIVE · TRACKING`; the dummy is hidden;
  - blocked → an inline ember card over the model, which keeps idling:
    - title: `▲ CAMERA IS BLOCKED FOR FOXBOX`;
    - body: `Turn it on in System Settings › Privacy & Security › Camera. The head model keeps idling meanwhile.`;
    - buttons: TRY AGAIN · BACK TO MODEL;
  - no face → the feed is dimmed and blurred, the mask **holds on the head model**, and the amber chip reads `▲ NO FACE FOUND · MASK HOLDS ON THE HEAD MODEL` / `Face the camera and add some light. It picks up again by itself.`
- **Perf:** the amber strip `▲ FRAMES ARE DROPPING · 22 FPS` + `REDUCE EFFECTS` + `KEEP FULL`.

### Options panel (right)
**Head (48px):** the number, the category title (Big Shoulders Display 800 16px, .18em) and a `◀ 3 / 7 ▶` flipper (← → keys).

**PartCarousel / MaterialChips (POSTER look):**
- A 2-column grid of square tiles, 6px gap.
- Each tile is a full-bleed 3D thumbnail of **that part on the current mask**:
  - EYES and MOUTH use a close face crop with the dummy hidden;
  - EARS use a 3/4 view (yaw .75);
  - everything else uses a full head with shoulders.
- The name overlays the bottom on a black fade (Big Shoulders Display 800 17px) with an 8px LED dot.
- **Selected:** a 2px inset ink ring and an ember LED.
- **Hover:** a 1px ink ring, and the part is previewed live on the head.
- Thumbnails are re-rendered 260ms after the last change. While rendering, a tile shows a shimmer.
- The LED TILE and LIST looks are in the prototype as alternatives.

**ParamSlider:**
- A grid `82px label | track | 34px value`, 32px tall.
- Track: a 6px well with an ember fill (glow `rgba(255,75,43,.45)`), a 1px tick at the preset value, and a 10×18 ink thumb.
- **Interaction:** drag, Shift for fine (0.2×), double-click to reset to the preset value, arrows ±1, Shift+arrows ±10, Home/End.
- **Mid-drag:** the label and value turn amber, the thumb scales to 1.12, and a bubble above reads `72 · ⇧ FINE`.

**Per category:**
- **01 BASE:** SHELL tiles plus BROW, CHEEKS, CHIN and STAND-OFF.
  - Shells: FULL FACE, VISOR, HOOD, HELMET.
  - Constructs: SHARDS, MONOLITH, VOXELS, **EQUALIZER**, **VORTEX**, VU + RAYS, **SLICES**, HALO RINGS, SCREEN HEAD.
- **02 EYES:** SLITS, VISOR BAND, RINGS, X, PIXEL, GLOW DOTS, LENSES, plus SIZE, SPACING and TILT.
- **03 MOUTH & JAW:** GRILLE, TEETH, STITCHED, SPEAKER SLOTS, NONE, plus SIZE and JAW DROP.
- **04 EARS & HORNS:** FOX EARS, CAT EARS, HORNS, ANTENNAE, CREST, FINS, NONE, plus SIZE, TILT and SPREAD.
- **05 MATERIAL:** FINISH tiles WIREFRAME, GLASS, FACETS, GLITCH, HOLOGRAM, plus EDGE GLOW.
- **06 COLOURS:**
  - **PALETTES:** a 3-column grid with a 3:2:1 bar of c1/c2/c3 and the name: EMBER, ICE, TOXIC, BONE, VOID, SAKURA.
  - **SwatchRow ×3:** PRIMARY, SECONDARY, and ACCENT · EYES & MOUTH. Each has 11 swatches (24px, radius 3; selected = a 2px `#101012` gap plus a 1px ink ring and a centre dot) and `+ CUSTOM`.
  - **+ CUSTOM** opens an inline drawer with HUE (rainbow track), SAT and LIGHT sliders plus a HEX field.
- **07 PATTERN:** NONE, STRIPES, CIRCUIT, CAMO, HALFTONE, WAR PAINT; STRENGTH; **DECAL · FOREHEAD** as a Segmented (NONE · ✕ · ◆ · FOX · TAG), plus a TAG input when TAG is on (≤ 6 chars, `n / 6`).
- **08 GLOW & FX (GlowPanel):**
  1. **FX PRESETS:** a 3-column grid, hover to preview. CLEAN, SIGNAL LOST, EMBER STORM, HOLO GHOST, DATA RAIN, CRT. The header shows the matching preset name or CUSTOM.
  2. **REACTS TO:** a well containing:
     - a `▶ DEMO DROP` / `■ BUILDING` / `■ IN THE DROP` toggle with beat LEDs;
     - a Segmented **THE DROP | STEADY | OFF**. Only the general drop matters; there is no per-stem reaction;
     - **FLASH RATE:** a 12-LED meter, green when safe and amber above 2.5/s, with `2.1 / S · SAFE`.
  3. **FxModule ×7.** Each has a head with a 34×20 amber switch, the name (Big Shoulders Display 800 15px), a summary in dim, and `▶` / `■ SOLO`. Solo plays that effect alone on a forced demo drop for 5s. When on, the module expands its controls with `vbRise`:
     - **GLOW:** 8 colour swatches, AMOUNT and BLOOM.
     - **GLITCH:** STYLE (SLICE · SCATTER · RGB SPLIT), FIRES (DROP HIT · THROUGH DROP) and AMOUNT. The note reads "Fires only when the drop lands."
     - **EDGE LINES:** MOTION (MARCH · PULSE · STILL) and SPEED.
     - **AURA:** AMOUNT.
     - **PARTICLES:** TYPE (EMBERS · DATA RAIN · GLITCH) and DENSITY.
     - **SHIMMER:** TYPE (SCANLINE · HOLOGRAM) and AMOUNT.
     - **PIXELATE:** AMOUNT.
  4. A dashed safety note with an ok-green ◆.

### SaveBar (bottom strip, one panel)
Left to right, with 1px `rgba(233,229,218,.08)` dividers:
1. **← LINEUP** (BackToLineup): the label, with `FROM <PRESET>` under it.
2. **RandomizeButton:**
   - outline style, a 24px dice icon, `RANDOMIZE` / `ROLLING` (Big Shoulders Display 800 16px);
   - sub-line: `KEY R` or `R · 2 LOCKED` (amber);
   - the dice spins 360° per roll over 1s with `cubic-bezier(.2,1.3,.3,1)`.
3. **NAME:**
   - the label, then the input: a well that stretches, Big Shoulders Display 800 20px, uppercase, max 20, placeholder `NAME YOUR MASK`;
   - the hint sits **inside** the right end of the input:
     - `▲ NAME IT FIRST` (amber, with the border turning amber and `aria-invalid`);
     - `▲ MY ONI EXISTS` + stacked `REPLACE IT` / `SAVE AS MY ONI 2`;
     - `✓ SAVED · NOW WEAR IT →` (ok);
     - `✓ IN MY MASKS`;
     - `SAVE UPDATES <NAME>`.
4. **SAVE:** ink primary with `⌘S`.
5. **WearButton:**
   - ember, `clamp(200px,17cqw,250px)` wide;
   - `WEAR` / `✓ WEARING` (Big Shoulders Display 800 24px);
   - sub-line: `NOT SAVED YET` / `UNSAVED CHANGES` / `<NAME>` / `LIVE IN VISUALS NOW`;
   - `IN VISUALS →` on the right;
   - right after a save it pulses its glow 3× (`vbWear` 1.1s).
   - WEAR works on an unsaved mask; the status then says `Not saved: SAVE to keep it in MY MASKS` in amber.

### MY MASKS (a mode of the same page, not a modal)
**Head (56px):** `MY MASKS`, `n SAVED`, then `+ IMPORT`, `TEMPLATE ↓` and a 10px spacer before `← EDITOR` (ink).

**ImportPanel** (inline drawer):
- a drop zone with a 2px dashed border, 118px tall: `DROP AN IMAGE MASK`, or `RELEASE TO IMPORT` with an ember border and 7% ember fill;
- the line `SVG · PNG · WEBP, drawn on the face TEMPLATE`, and a `PICK FILE` button;
- on the right: the rules copy, a bad-file line `▲ CAN'T USE X · SVG, PNG OR WEBP ONLY`, and `TEMPLATE ↓`.

**SAVED · n:** a grid of `auto-fill, minmax(210px,1fr)` MaskCards:
- a 4:3 thumbnail;
- a `● WEARING` ok badge;
- the name (Big Shoulders Display 800 19px) and meta `EDITED 2 MIN AGO · FACETS`;
- actions: `EDIT` (ink), `DUPLICATE`, `RENAME` (inline input: Enter commits, Esc cancels), flex, then `DELETE…` (dim, ember on hover);
- **delete confirm:** replaces the actions with `▲ DELETE X? This can't be undone.`, `CONFIRM DELETE` (ember outline) and `KEEP` (autofocus);
- **image masks:** a striped placeholder `IMAGE MASK · file.png`, with RENAME and DELETE only.

**Empty:** a well containing `NO SAVED MASKS YET`, the copy, then `PICK A PRESET` and `+ IMPORT`.

**BUILT-IN · READ-ONLY:** FOX and LOW-POLY (the existing VISUALS face styles) plus every preset. Each card shows a kind chip and `DUPLICATE` only; duplicating creates `<NAME> COPY` in SAVED.

## The 3D stage (three.js): what to match
**Scene:**
- ACES tone mapping, exposure 1.05, sRGB output.
- PerspectiveCamera with fov 26, at `(0, .25, 10.8·max(1, .9/aspect))`, looking at `(0, −.45, 0)`. This shows the head plus shoulders with room above for horns and ears.
- Lights: see `--vb-mk-light-*`, plus the hemisphere light.
- A small PMREM studio environment: a dark box with a key softbox, an ember strip and an ice strip.

**Dummy ("wireframe person idling"):**
- head, torso lathe and two-segment arms, built as a dark occluding core (`#0a0a0d`) plus an ice wireframe (opacity .3; the head is sparse at .08);
- vertex points on the head at .25.

**Idle (no turntable):**
- every 2.6–6s it picks a new look target (yaw ±.35, pitch −.07…+.11) and springs to it (k 26, damping 0.9·critical);
- the torso counter-rotates 80% so the head leads;
- breathing: 1.25 rad/s sine on torso scale, the arms and a small root y;
- weight shift: .42 rad/s sway on roll and x;
- the arms swing out of phase with each other.

Drag spins the model (yaw .012/px, pitch clamped −.35….4) and resumes the idle after 1.6s. The model never auto-rotates.

**Mask geometry:**
- Shell: a partial sphere scaled to the head ellipsoid (rx .78, ry 1, rz .86) × stand-off. It is **very low-poly**: about 9×6 segments on FACETS, fewer on GLITCH. Each vertex gets hash jitter (.05) and a random outward "pop" of up to 9%, so the facets extrude.
- BROW, CHEEKS and CHIN deform the shell, and a nose ridge is always there.
- Features are placed by raycasting onto the shell and oriented to the face normal. They are extruded 0.06–0.1 deep so they stand off the shell.
- Crease lines: `EdgesGeometry(…, 26°)`, dashed, marching (or pulsing, or still), with opacity breathing. Parts carry no wireframe lines.

**Constructs** (all keep a dark core underneath, so the face is always covered):
- **EQUALIZER:** 13 vertical bars on an arc. Driven by the demo track:
  - in the drop, the centre bars hit on each kick (`exp(−ph·6)`), the outer bars flicker on offbeat hats, and the bars punch forward;
  - in the build, the height grows with the build and a sweep runs across;
  - the head nods on the kick and rolls to alternating sides every 2 beats.
- **VORTEX:** 8 counter-rotating hex rings recessing into the face, with a glowing core. About 420 particles spiral in with `pull = .35 + 2.4·build²`, burst outward on the drop edge (`vr = 3.5–8.5`), then get pulled back in. Without the demo drop it runs a 7s pull-and-burst loop.
- **SLICES:** 15 horizontal glass slices. A wave runs down them, and they punch out on the drop.
- **SHARDS, VOXELS, MONOLITH:** pieces drift slowly and scatter on the glitch downbeat.
- **SCREEN HEAD:** a box monitor whose screen is the raycast target for the eyes and mouth.

**Free-floating layer:** particles, the vortex and rays live in a separate group that **follows the head loosely**:
- a position spring with k ≈ 1.4/s;
- it takes only 35% of the head's yaw;
- plus its own slow drift (roll and pitch around .03–.04 rad, yaw .12 rad).
It must never feel rigidly tracked.

**FX:**
- **Glow:** accent emissive × a drop envelope. Build: `0.3 + 0.45·build²`. Drop: `0.55 + 0.6·exp(−ph·5) + 1.3·exp(−sinceDrop·2.2)`. STEADY breathes at .25Hz.
- **Halos:** additive sprites at the eyes, scaled by BLOOM.
- **Glitch:**
  - SLICE: shifts 1–3 horizontal bands of shell vertices;
  - SCATTER: jitters 40% of vertices;
  - RGB SPLIT: widens the additive red/cyan ghosts;
  - it never fires without the drop.
- **Particles:**
  - EMBERS rise;
  - DATA RAIN falls;
  - GLITCH is a field *behind* the head where 12% of the points (37% in the drop) teleport every 340ms, with a cyan ghost and an x-jitter.
- **Aura:** a back-face additive ellipsoid.
- **Shimmer:** an additive line texture scrolling on the shell.
- **Pixelate:** lowers the renderer's pixelRatio with `image-rendering:pixelated`.

**On every change:** one glowColor scan line runs down the mask (.6s), the glow gets a 1.8× boost that decays, and the idle head turns toward the change: side-on for ears and base, facing front for eyes and mouth.

**Hover preview:** while you hover a tile, swatch, palette, preset or FX preset, the preview renders `{...cfg, ...hoverPatch}`, and the patch clears on leave. This is required: "clicking and hovering actively changes the preview".

**Lineup acts** (random, never the same twice in a row): headbang (on the beat) · twirl · shake · look up · bounce · tilt · float · peek · drop (forces a drop every 4s) · burst.

**Thumbnails:** one shared offscreen renderer at 240², run one per frame, with an LRU cache of 500 keyed by `JSON.stringify([cfg, framing])`. Use blob URLs, not data URLs.

## Interactions and keys
| Action | Key |
|---|---|
| Flip parts | ← → |
| Category | ↑ ↓ |
| Randomize unlocked | R |
| Undo / redo | ⌘Z / ⇧⌘Z (80 steps; one step per slider drag) |
| Save | ⌘S (also Enter in the name field) |
| MODEL ↔ LIVE | Space (ignored on buttons, sliders and radios) |
| Lineup browse / start | ← → / ↵ |
| Close drawers and confirms | Esc |

**RANDOMIZE:**
- the unlocked categories shuffle **parts only** at 0/330/660ms, and the final state, including colours and an FX preset, lands at 1000ms, so colours never flash;
- unlocked slots and tiles shimmer amber, the tiles bob (`vbShuffle`), and the viewport chip reads `ROLLING · 6 UNLOCKED · 2 LOCKED`;
- the status afterwards: `ROLLED · 6 unlocked · 2 locked · ⌘Z to go back`;
- if everything is locked: `▲ EVERYTHING IS LOCKED`.

## State (see the prototype logic class)
- **Screen:** `screen: 'pick'|'edit'|'lib'`, `spot` (lineup index), `act` (lineup animation).
- **Editing:** `cat`, `cfg: MaskConfig`, `origin` (the preset it started from, which drives the "changed" dots), `savedCfg`, `maskId`, `name`, `presetName`, `locks{cat:bool}`, `hover: Partial<MaskConfig>|null`, `solo: {id,t}|null`.
- **Preview:** `view: 'turntable'|'live'|'clip'`, `live: 'idle'|'asking'|'on'|'denied'|'noface'`, `beat` (demo drop on), `ab`, `fx: 'full'|'reduced'`, `perf`.
- **Actions in progress:** `rolling`, `rollN`, `saveHint: null|'empty'|'dup'`, `justSaved`, `worn`, `wornCfg`.
- **Library:** `saved: (SavedMask|ImageMask)[]`, `confirmDel`, `renaming`, `importOpen`, `dropOver`, `impBad`.
- **History:** the `H`/`F` stacks (instance fields).
- **Types:** see `mask-config.ts` (`MaskConfig`, `DEFAULT_MASK`, `CATEGORY_KEYS`).

## Presets (exact configs are in `Masks.dc.html` → `static PRESETS`)
SUBWOOFER ★ · EVENT HORIZON · CHROME FOX · GLITCH SAINT · VOID RAVER · DEEP SCAN · DEAD PIXEL · TOXIC TV. The built-ins FOX and LOW-POLY map to the existing VISUALS face styles.

## Future: HEADS (not in 1.5.1)
The page grows by one slot, **09 HEADS**, under GLOW & FX. It reuses EYES, MOUTH, MATERIAL and COLOURS.
- The preview shows blinking (every 3.6s, 140ms) and talking.
- The panel lists what HEADS will add, each tagged LATER: FACE, EXPRESSIONS, LIP SYNC (with VOICE MASK), HAIR & HEADWEAR.
- Saved masks are unchanged.

## Design tokens
- `masks-tokens.css`: the new `--vb-mk-*` tokens (layout, surfaces, switches, 3D stage colours and lights, finish opacities, safety, motion).
- Everything else comes from TRANSMISSION plus the REMIX tokens (`remix-tokens.css`).
- Colours: bg `#0b0b0c`, panel `#101012`, raise `#18181b`, ink `#e9e5da`, dim `#8d8a82`, ember `#ff4b2b`, amber `#ffb23e`, ice `#7cc8ff`, ok `#7fd08a`.
- Mask swatches: `#ff4b2b #ffb23e #e8ff5a #8fe04a #7cc8ff #b48cff #f28ab3 #f1ede2 #8d8a82 #2c2c34 #141418`. The masks themselves may be as bold as a game's; the UI never uses neon gradients.
- Type:
  - Big Shoulders Display 700/800 for names, numbers and values;
  - JetBrains Mono 400/500/700 at 11–12px for everything else;
  - tracking: display .04–.2em, caps .04–.22em.

## Assets
- Fonts: `prototype/fonts/`, the app's own bundled woff2 files (OFL).
- The fox mark is drawn inline from `app/design/brand/foxbox-mark.svg`. The rail icons are simple strokes in the prototype.
- No images: every mask, thumbnail, waveform and particle is procedural.

## Files
- `prototype/Masks.dc.html`: the full prototype (template plus logic class). Component names are marked with `data-component`: MasksPage, CategoryTabs, CategoryLock, MaskPreview, TurntableView, LiveTryOn, BeatPreviewToggle, PartCarousel, PartTile, MaterialChips, ParamSlider, SwatchRow, GlowPanel, FxModule, HeadsPanel, PickStart, BackToLineup, RandomizeButton, SaveBar, WearButton, MyMasksGrid, MaskCard, ImportPanel. The prototype has no PresetStrip (the brief's bottom-strip preset cards); presets now live in the PickStart lineup.
- `prototype/mask-head.js`: the reference three.js renderer: `<mask-head cfg mode beat reduced trigger act>` plus `window.MaskKit.thumb(cfg, opt)`.
- `prototype/support.js`: the prototype runtime only; not needed in the app.
- `mask-config.ts`: the MaskConfig type, defaults and category key map.
- `masks-tokens.css`: the new tokens.
