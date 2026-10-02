# Handoff: VISUALS refresh + PROD (TouchDesigner) — FoxBox 1.5.x

## Overview
Two pages of the FoxBox Electron app:

- **VISUALS (02)**: the live VJ console, redesigned. The stage is the hero. Layers show as a visible stack (face → text → effects → base). An inventory-style effect browser opens in a drawer. AUTO-VJ shows a section countdown. A performance mode shows big pads. The face-hiding state is always visible.
- **PROD (06) · TOUCHDESIGNER**: a new page where you play with TouchDesigner effects on the **raw camera**, reacting to the music. It has BODY looks and HANDS (finger-gesture) looks, a first-run setup checklist, MASK FIRST, and SEND TO VISUALS / SEND TO OUTPUT / RECORD A CLIP.

Rail (unchanged order): 01 STUDIO · 02 VISUALS · 03 MASKS · 04 REMIX (**greyed WIP**: opacity .45, disabled, amber WIP badge) · 05 VAULT · 06 PROD (**enabled, ice DEMO badge**) · 07 VOICES · 08 SETTINGS.

## About the design files
The files in `prototype/` are **design references built in HTML**. They are prototypes that show the intended look and behaviour, not production code to copy. Rebuild them in the existing app: **React + TypeScript + Vite in Electron (electron-vite), CSS Modules, the existing `--vb-*` tokens** (`app/src/renderer/src/styles/tokens.css`), Zustand stores and the existing visuals engines (`src/renderer/src/visuals/*`).

- `VisualsProd.dc.html` is the clickable prototype. Open it in a browser. The **STATES** button at the bottom of the rail jumps to every state and switches the frame between 1512×982, 1280×800 and FIT. The markup uses `data-component="…"` attributes that match the component names below.
- `fx-engine.js` is a **stand-in** canvas renderer: a simulated 140 BPM track, a drawn figure in place of the camera, and scripted hands. It exists only to show motion and reactivity. The real app uses the camera, MediaPipe (`vendor/mediapipe/gesture_recognizer.task`, `face_landmarker.task`, `selfie_segmenter.tflite`), the ISF/Milkdrop/text engines and TouchDesigner.
- `ComponentSheet.dc.html` shows component states: hover, focus, active, disabled and reacting.
- `support.js` is the prototype runtime. Ignore it.

## Fidelity
**High fidelity.** Colours, type, spacing and states are final. Match them pixel for pixel using CSS Modules and the tokens.

## Global rules (from the UX audit; strict)
- No text below **11px**. Dimmed text must be ≥ 4.5:1 (`#8d8a82` on `#101012` passes; secondary copy uses `#bdb8ac`).
- Every control is **≥ 24×24px**. Focus is always visible: `outline: 2px solid #ffb23e; outline-offset: 2px` (`:focus-visible`).
- **No modals.** Use inline panels, inline confirm strips and drawers only.
- **Destructive actions take two steps**, with a 3s window. The button changes label in place: `✕ → REMOVE?`, `ON → OFF?`, `LIVE → STOP?`, `● ON OUTPUT → STOP OUTPUT?`.
- Warnings always pair **▲ with words**. Face state uses ● (hidden) / ▲ (visible) / ○ (no camera) plus a label, never colour alone.
- **Photosensitivity:** at most **3 flashes per second**, as a global limiter shared by DROP FLASH, BEAT STROBE, DROP FX and drop bursts. `prefers-reduced-motion` turns off flashes, slows motion to about 25%, and disables CSS animation and transitions.
- **Wording:** one verb per action. Never use "AI" or "generate".
- **Brand:** TRANSMISSION palette with the REMIX/MASKS HARDWARE surfaces (recessed wells, no glass panels, no neon-gradient chrome). The visuals themselves can be loud.
- The window-mosaic art must use **no Apple or Microsoft marks**. The title bars are generic, with three small squares on the right.

## Shell
- Root: CSS grid `76px minmax(0,1fr)`, `container-type: size`, background `#0a0a0b`, base font `500 12px/1.4 'JetBrains Mono'`. Each page sits at `inset: 12px` with `gap: 10px`.
- Rail button: height `clamp(60px,7.3cqh,72px)`. Code number in Big Shoulders 700 19px, label in Mono 500 11px with .08em tracking. Current item gets a 2px ember bar on the left, from 16px to 16px, with `0 0 10px #ff4b2b`. Badges use a 1px border and 11px Mono 700 text (WIP amber, DEMO ice).
- **Panel** (rack): `#101012`, `1px solid rgba(0,0,0,.7)`, radius 4, `box-shadow: inset 0 2px 10px rgba(0,0,0,.55), 0 1px 0 rgba(233,229,218,.05)`. Panel head: 40px, padding `0 8px 0 14px`, bottom border `rgba(233,229,218,.06)`, title Big Shoulders 800 14px with .2em tracking.
- **Well**: `#0b0b0c`/`#0e0e10` with `inset 0 2px 6px rgba(0,0,0,.6)`.
- **Ctl button**: 24–30px tall, radius 2, `rgba(233,229,218,.07)` (hover .14), Mono 700 11px.
- **Segmented**: well container with 2px padding. The selected segment is `#e9e5da` with `#0b0b0c` text; others are transparent with `#8d8a82` text.
- **Primary (hardware) button**: ember `#ff4b2b`, dark text, Big Shoulders 800, `box-shadow: 0 0 0 1px rgba(0,0,0,.65), 0 0 22px rgba(255,75,43,.28), inset 0 1px 0 rgba(255,255,255,.4), inset 0 -4px 0 rgba(0,0,0,.28)`, plus a top 50% gloss `linear-gradient(180deg, rgba(255,255,255,.14), transparent)`. Active: `translateY(2px)`.

---

## B. PROD · TOUCHDESIGNER — `ProdPage` (`TouchDesignerPage`)

### Header (48px)
`PROD · TOUCHDESIGNER` (Big Shoulders 800 34px) · `DemoBadge` (ice outline) · TD status chip in a well (● `TOUCHDESIGNER CONNECTED · 60 FPS` ok / `RECONNECTING…` amber blink / `▲ TOUCHDESIGNER STOPPED` ember / `NOT SET UP` dim) · spacer · **CameraChip** · **MaskFirstToggle**.

- **CameraChip** (34px, 1px border, radius 3, Mono 700 11px, .1em tracking):
  - Raw camera: `▲ FACE VISIBLE: RAW CAMERA`, amber border/text, background `rgba(255,178,62,.1)`. Shown whenever the camera feeds TD.
  - MASK FIRST: `● MASK FIRST: FACE HIDDEN`, ok green, background `rgba(127,208,138,.08)`.
  - Camera blocked: `○ CAMERA OFF: DEMO LOOP` / `… FOXBOX STAGE`, dim.
- **MaskFirstToggle**: a 34×20 switch (on: track `rgba(127,208,138,.18)` with ok edge, ok knob). Label `MASK FIRST` in Big Shoulders 15px, sub-line `face hiding runs first` / `off: raw camera`. Disabled at .45 when the camera is blocked. MASK FIRST runs FoxBox face hiding (LOW-POLY) **before** TouchDesigner.

### First run: setup (replaces the body until done)
Grid of two equal columns.

- **Left hero panel** (`#08080a`):
  - Background: the TD preview (plexus) at .34 opacity under a vertical fade.
  - Headline `SET UP<br>TOUCHDESIGNER`, Big Shoulders 800 `clamp(64px,10cqh,108px)/.84`.
  - Body text (13px Mono, `#bdb8ac`): "FoxBox drives your own free copy of TouchDesigner, hidden in the background. You set it up once. After that this page opens straight into the camera."
  - Primary button (56px, 24px text, nowrap). Its label follows the setup state: `GET TOUCHDESIGNER (FREE)` (not installed) / `SET UP TOUCHDESIGNER` / `SETTING UP…` (disabled, amber) / `OPEN TOUCHDESIGNER` (activation needed).
  - Note: "TouchDesigner's free licence is non-commercial. Effects made here are a demo."
- **`TdSetupChecklist` panel**:
  - Head: `SETUP` (18px) on the left, with a big count `N` (40px) and `/ 4` (24px, dim) on the right.
  - Below the head, a **16-segment LED bar** (4 per step; 7px tall in a well). Segments are ok green with a glow for done steps, chase amber for working steps, ember for steps that need the user, and `rgba(233,229,218,.08)` for steps not started.
  - Steps sit on a vertical **timeline**: 56px round nodes with a 2px border in the state colour, joined by a 2px line that turns green below done steps.
  - The **current step** (the first one not done) grows (`flex: 1.6`), sits in a card (well background, state-tinted border), and has a 36px title. Other steps have 26px titles. Steps not yet reached are at .6 opacity.
  - Each step row: number (13px Mono dim) · name · state chip on the right (`✓ DONE` / `… WORKING` / `! NEEDS YOU` / `○ WAITING`, 13px) · detail line (15px Mono `#cfcabd`) · actions (42px buttons, Big Shoulders 19px).

  | # | Name | todo | busy | ok | err (actions) |
  |---|---|---|---|---|---|
  | 01 | INSTALLED | Looking for TouchDesigner on this Mac. | Getting TouchDesigner… | TouchDesigner 2025.3 found. | TouchDesigner isn't on this Mac. It's free for non-commercial use. → **GET TOUCHDESIGNER (FREE)**, TRY AGAIN |
  | 02 | FOXBOX PATCH BUILT | FoxBox builds its own patch inside TouchDesigner. | Building the FoxBox patch… | Patch built: 10 effects ready. | The patch didn't build. → TRY AGAIN |
  | 03 | ACTIVATED | TouchDesigner needs one sign-in, once. | Waiting for you to sign in… | Signed in. | Open TouchDesigner once and sign in, then come back. → **OPEN TOUCHDESIGNER**, TRY AGAIN |
  | 04 | CONNECTED | FoxBox talks to TouchDesigner in the background. | Connecting… | Connected. Going live. | FoxBox can't reach TouchDesigner. → TRY AGAIN |

  Glyph per state: ✓ ok `#7fd08a` · … busy `#ffb23e` (breathing) · ! err `#ff4b2b` (filled ember node with dark glyph) · ○ todo (dim). Once all four steps pass, show a toast and go to live. **After the first time, the page skips setup.**

### Live layout
Body grid: `clamp(236px,19.5cqw,290px) minmax(0,1fr) clamp(276px,22cqw,320px)`, gap 10. Then an optional confirm strip, then the bottom strip (70px).

**Auto-collapse:** when the pointer rests on `TdPreview` for **450ms**, both side panels collapse to **46px** strips. The grid becomes `46px 1fr 46px` and `grid-template-columns` animates over .38s `cubic-bezier(.2,.9,.2,1)`. Moving onto a strip, or clicking it, expands the panels again. Collapsed strips:
- Left: `›`, vertical `EFFECTS`, a mode dot (ember for BODY, pink `#e79bd0` for HANDS), and the current effect name.
- Right: `‹`, vertical `PLAY`, six 30px mini knobs (value arc plus a reacts-to dot), and the current palette swatch.

#### `TdEffectBrowser` (left)
- Head: `EFFECTS` + count + a small `★ FAVS` toggle (amber when on).
- **`TdModeToggle`** (big two-way switch, in a well, 2 columns, 58px buttons): **BODY** (`10 LOOKS`, ember accent) / **HANDS** (`3 LOOKS`, pink `#e79bd0`). The selected side has a `#18181b` background, a 1px border in its accent, an `inset 0 -2px 0 <accent>` underline, a glowing dot, and a `clamp(20px,1.7cqw,26px)` label. Switching mode restores the last effect used in that mode (defaults: plexus / fwindows).
- Tile grid: 2 columns, gap 8, scrolls inside the panel.
- **`TdEffectTile`**: well, 1px border (`rgba(233,229,218,.08)`; hover .45; selected .7 plus `0 0 0 1px rgba(233,229,218,.25), 0 0 18px rgba(255,75,43,.18)`). Contents:
  - an **animated 4:3 thumbnail**;
  - an amber `NEW` tag top-left;
  - a 24px ★/☆ favourite button top-right (amber when on);
  - the name in Big Shoulders 14px, with a 3px LED bar on the left (ember with glow when selected).

BODY looks: THRESHOLD + PLEXUS ★, WINDOW MOSAIC ★, DATA BODY (NEW), GLOW TRAILS, SLIT SCAN (NEW), POINT CLOUD, MIRROR TUNNEL, ASCII BODY, LINE SCAN (NEW), DOT SCREEN.
HANDS looks (all NEW): **FINGER WINDOWS**, **STRING HANDS**, **PINCH PORTAL**.

#### `TdPreview` (centre)
- Head: effect name (18px, never truncates) · one-line note (truncates) · `FEED` segmented (`DEMO LOOP` / `FOXBOX STAGE`, only when the camera is blocked) · aspect segmented `9:16 / 16:9 / 1:1`.
- The picture is **fitted to the aspect** inside the area with 14px padding, measured with a ResizeObserver. Width and height animate over .35s.
- **`DemoLabel`**, always burned in at bottom-left: `TOUCHDESIGNER · DEMO · NON-COMMERCIAL, NOT COPYRIGHT-SAFE` on `rgba(0,0,0,.78)`, Mono 700 11px, .08em tracking.
- Top chips: `REC 0:14 · ▲ FACE VISIBLE|FACE HIDDEN` (ember outline, blinking dot) · `ON OUTPUT · PROJECTOR · 16:9` (solid ember) · on hands looks, `2 HANDS TRACKED` (pink outline, breathing dot) on the right.
- **Hands looks only:** a gesture key card (top-right, under the chip) with `GESTURES` and three rows `PINCH + PULL → NEW WINDOW` / `OPEN PALM → CLEAR` / `FIST → FREEZE`, then "or drag on the picture". The cursor is a crosshair: dragging draws a window, clicking places a portal.
- When sent to output, the frame gets a 2px ember ring with the `vbLive` pulse (2.4s).
- Overlays:
  - **No music:** a centred card. "PLAY A TRACK TO MAKE IT REACT" (24px), help line, **▶ PLAY**. The effect keeps idling gently.
  - **TD quit or crashed:** the picture freezes (grayscale, .55). An inline card with ember border reads "▲ TOUCHDESIGNER STOPPED / It quit or crashed. Your effect, knobs and palette are kept…" with **RECONNECT** (→ `RECONNECTING…`). RECORD, SEND TO VISUALS and SEND TO OUTPUT are disabled at .45.
  - **Camera blocked:** an inline amber alert at the top of the area. "▲ CAMERA BLOCKED. macOS isn't letting FoxBox use the camera. Open System Settings → Privacy & Security → Camera and turn FoxBox on. Meanwhile the effect runs on a demo loop." with **TRY AGAIN**. The effect falls back to the demo loop or to the FoxBox stage, picked with FEED.

#### Play controls (right)
- Head: `PLAY` + RESET.
- **`MacroKnob` ×6** (3×2 grid): INTENSITY, COLOUR, CHAOS, TRAILS, LINES, SIZE.
  - Each cell is a well, radius 3.
  - The knob is 64px: body circle r21 `#17171a`, a 270° track (`M 12.91 51.09 A 27 27 0 1 1 51.09 51.09`, 3px, `rgba(233,229,218,.1)`), a value arc in ink, and a pointer line.
  - A 72px **mod ring** sits 4px outside the knob. It draws the *live modulated* value in the reacts-to colour, at opacity .35 + .65 × envelope. This is the "reacting/pulsing" state.
  - Drag vertically (160px = full range), use the arrow keys (±5%), double-click to reset.
  - Under the knob: label (Big Shoulders 14px), value %, and a **`ReactsTo` chip** (`● KICK ▾`).
  - Defaults: INTENSITY .6/DROP, COLOUR .5/SECTION, CHAOS .25/SNARE, TRAILS .15/OFF, LINES .45/OFF, SIZE .5/BASS. Values are stored per effect.
- **`ReactsToMenu`**: an inline panel under the knobs (amber border), titled `LINES REACTS TO`, with a 4-column radio grid: KICK `#ff4b2b` · SNARE `#ffb23e` · BASS `#7cc8ff` · DROP `#ff4b2b` · SECTION `#e9e5da` · VOICE `#7fd08a` · **HANDS `#e79bd0`** (finger spread) · OFF. Modulation is `value + envelope × 0.45`, clamped.
- **Hands looks only: `GestureMap`**:
  - Title `HAND GESTURES` and a `SHOW HANDS` switch (overlays the hand skeleton).
  - Three rows `<gesture> → [action ⟳]`. Clicking cycles the action: PINCH + PULL: NEW WINDOW / PORTAL / PLUCK · OPEN PALM: CLEAR / RANDOMIZE / NOTHING · FIST: FREEZE / BLACKOUT / NOTHING.
  - Note "Tracking runs on your Mac. Set any knob to react to HANDS…" and a **CLEAR** button that removes drawn windows and portals.
- **`PaletteRow`**: 5 swatches (3-stop strip + label): EMBER `#050506 #f2efe6 #ff4b2b` · ICE `#03060a #e8f4ff #29a8ff` · TOXIC `#040602 #f1ffe0 #b6ff2e` · BONE `#0d0b08 #efe6d2 #c9b48a` · VOID `#000 #fff #8a5cff`.
- **RANDOMIZE** (44px, outline; the ⟳ glyph spins 360° each press; key **R**). It randomizes the knobs (0.15–0.95) and the palette.

#### Confirm strip (inline, amber)
Pressing RECORD or SEND TO OUTPUT while the face is visible shows this strip instead of acting: "▲ **FACE VISIBLE.** This clip will show your real face from the raw camera." · **MASK FIRST, THEN RECORD** (ok green) · **RECORD WITH MY FACE** (amber outline) · CANCEL. Same wording for SEND.

#### Bottom strip (70px)
- **Music block** (well):
  - ▶/❚❚ (40px);
  - title `GHOSTWIRE (VIP)` (19px) with the meta line `STUDIO TRACK · 140 BPM · F MINOR`;
  - section chip (section colour, dark text) with `DROP IN 0:07`;
  - a section map (8px canvas, coloured blocks plus playhead);
  - four 8-LED meters labelled K, S, B, D.
- **`RecordClip`**: `RECORD A CLIP` with sub-line `▲ FACE VISIBLE` (amber) / `● FACE HIDDEN` (ok) / `○ NO CAMERA IN CLIP`. While recording: `STOP · 0:14`, ember tint, square blinking dot. Stopping shows the toast `CLIP SAVED · 0:14 · face hidden · in VAULT`.
- **`SendToVisuals`**: `SEND TO VISUALS` / "adds a TOUCHDESIGNER layer". It puts the current effect (with its knobs, reacts-to and palette) at the top of the VISUALS stack. The button then reads `✓ ON VISUALS` / `OPEN VISUALS →` and navigates there on the next press.
- **`SendToOutput`**: hardware button, ink background when the face is hidden, **amber background when the face is visible** (sub-line `▲ FACE VISIBLE`). When live: `● ON OUTPUT` on ember with `● FACE HIDDEN · CLICK TO STOP`. Stopping takes two steps (`STOP OUTPUT?`).

---

## A. VISUALS — `VisualsPage`

### `AudioSourceStrip` (header, 48px)
`VISUALS` (34px), then one well (44px) holding:
- SOURCE segmented `TRACK / LIVE INPUT / MIC`;
- `LATENCY LOW / SAFE`;
- `IN` level meter (12 LEDs, last 2 ember);
- now playing (title 16px + meta);
- section chip;
- section map.

### Body
Grid `clamp(336px,24.5cqw,364px) minmax(0,1fr)`.

#### `LayerStack` (left panel)
- Head: `LAYERS` + `N ON STAGE` + **+ ADD EFFECT** (ember; when open it becomes `✕ CLOSE BROWSER`).
- The list has a 1px vertical **spine** (`rgba(233,229,218,.12)` at left 20px), and every layer shows its **order number** (Big Shoulders 15px): top = N … base = 01.
- **`FaceHideControl`** (always the top layer):
  - Card with a 3px inset left edge (ok green when on, ember when off), number plus `⊤`.
  - 46px live thumbnail of the chosen hiding style.
  - `FACE ENCRYPTION` label, then a big state line: `● FACE HIDDEN` (ok) or `▲ FACE VISIBLE` (ember), in `clamp(18px,1.45cqw,22px)`.
  - Sub-line `COVERS EVERY FACE` / `ARMED · NO CAMERA` / `TOP LAYER · OFF`.
  - Switch button (`ON` / `OFF?` / `OFF`).
  - Style picker as a 3-column grid in a well: LOW-POLY · DEPTH GLITCH β · POP-UPS · MOSAIC · GLITCH · MASK (from MASKS).
  - Turning it off takes two steps: the first click shows `OFF?` and the line "▲ Click OFF again to show your real face on the stage." When off, the warning reads "▲ Face hiding is off. Your real face is on the stage (and on the projector)."
- **TEXT row** (pinned above the effects): thumbnail, `TEXT · SLAM "GHOSTWIRE"`, `MOVE ⟳` (DECRYPT → SLAM → COUNTDOWN → SHATTER → STENCIL), reacts chip, meter, M.
- Section label `EFFECTS · 4 · TOP → BOTTOM ……… DRAG · ALT+↑↓`.
- **`LayerRow`** (min 56px; grid `18px 52px 1fr 30px 28px`; gap 8):
  - number + ⋮⋮ handle;
  - animated 52×38 thumbnail;
  - line 1: name (Big Shoulders 15px, ellipsis) and ✕ / `REMOVE?`;
  - line 2: kind tag (`GEN` ice / `FX` amber / `MD` `#e79bd0` / `TD` ember), **`ReactsTo`** chip (`● KICK ▾`, `STEADY` when off), live meter (6 LEDs, pulses with its source), and, when AUTO-VJ is on, `□ LOCK` / `■ LOCKED` (amber);
  - **opacity knob** (30px, amber arc; drag or ↑↓);
  - M (amber when on) / S (ice when on).
  - Muted, or not soloed while something else is soloed: .5 opacity.
  - Drag: the source row is at .5 with an amber border, and a 2px amber insertion line shows on the top or bottom half of the target. Keyboard: Alt+↑/↓ moves the focused row.
  - Reacts menu: inline 3-column radio grid under the row.
- Empty: a dashed **+ ADD EFFECT** card: "No effects yet. Shaders, filters, Milkdrop and TouchDesigner stack here."
- Section label `BASE ……… DRAWN FIRST`.
- **BASE row** (01 `⊥`): thumbnail, name, a one-line description, and a 4-column picker NONE / WAVE / CORE / CAMERA / PHOTO / VIDEO / TD.

#### `StageView` (right column)
- **Bar (44px)**: aspect segmented · **`AutoVjControl`** (well, min 252px, max 380px; switch `● AUTO-VJ` amber when on; status `DROP IN 0:07 · 4 BARS` plus 4 LED bar dots that turn ember on the last bar; `OFF` when off; `WAITS FOR A TRACK` with no music) · spacer · SAVE CLIP · REC LIVE (→ `STOP 0:12`, ember) · `PERFORM P` · **OUTPUT** (hardware ink; live = ember `LIVE` with blinking dot; stop takes two steps `STOP?`).
- Going live while face hiding is off shows an inline confirm strip (ember): "▲ **FACE HIDING IS OFF.** The projector will show your real face." · **HIDE FACE, THEN GO LIVE** (ok) · **GO LIVE WITH MY FACE** · CANCEL.
- **Stage**: always fitted to the aspect. Ring `0 0 0 1px rgba(233,229,218,.12)`; live = 2px ember plus the `vbLive` pulse. Chips:
  - top-left `OUTPUT OFF · 16:9` (dim) or `LIVE ON OUTPUT · PROJECTOR · 16:9` (solid ember);
  - `PREVIEW · HEX LATTICE · CLICK TO ADD` (amber dashed) while hovering a tile;
  - `REC LIVE 0:12`;
  - top-right `BLACKOUT · FROZEN · DROP FX` flags;
  - bottom-left face chip `● FACE HIDDEN · LOW-POLY` (ok) / `▲ FACE VISIBLE: FACE HIDING OFF` (solid ember) / `○ NO CAMERA ON STAGE`.
- Empty stage: "AN EMPTY STAGE / Pick a BASE on the left, then add effects…" and **+ ADD EFFECT**.
- **`EffectBrowser`** (drawer under the stage, `clamp(232px,29cqh,280px)`, slides up over .28s):
  - Tabs `GENERATORS 16 · FILTERS 15 · MILKDROP 500+ · TEXT 5 · TOUCHDESIGNER 10`.
  - Hint `HOVER TO PREVIEW · CLICK TO ADD`, and ✕.
  - Two rows of `EffectTile`s (`clamp(118px,9.6cqw,140px)` wide) that scroll sideways.
  - Each tile has an **animated thumbnail**, the name, and a badge (`▲ FLASH` amber on DROP FLASH / BEAT STROBE, `NEW` on TD). Tiles already on the stack show `ON`.
  - Hover raises the tile by 2px with an amber border and **previews it on the stage**. Click adds it to the top of the stack. Tiles stagger in at 18ms each.
  - Milkdrop ends with a "+488 more presets" card.
  - GEN: BEAT RINGS, DROP FLASH, FOG, GLITCH BLOCKS, HEX LATTICE, KALEIDO, METABALLS, PLASMA, RADIAL RING, SCOPE, SPECTRUM BARS, STARFIELD, SYNTH GRID, TUNNEL, VOICE CORE, VORTEX.
  - FILTERS: BASS WOBBLE, BEAT STROBE, DATAMOSH, DEPTH FOCUS, EDGE GLOW, FEEDBACK TRAILS, HALFTONE, KALEIDO MIRROR, MOTION TRAILS, PALETTE FROM IMAGE, PIXEL SORT, RGB SPLIT, THERMAL, VHS, ZOOM PULSE.
  - The Milkdrop preset names in the prototype are placeholders.

#### Performance mode — `PerformanceStrip`
Press **P** (or PERFORM) to enter, **Esc** or P to exit.
- The rail, header, stack and bar hide. The stage background turns black, and a small `← EXIT · ESC` plus `DROP · BREAK IN 0:12` sit top-right.
- Strip (`clamp(108px,14cqh,132px)`): **8 `ScenePad`s** and 4 function pads.
- `ScenePad`: number key top-left, LED top-right, name (Big Shoulders `clamp(17px,2.4cqh,22px)`), sub-line.
  - Active: ink background, dark text, ember LED.
  - Empty: `EMPTY / TAP TO SAVE THIS LOOK` (tapping saves the current stack).
  - Keys 1–8 fire the pads.
- Function pads:
  - **AUTO-VJ** (A, amber when on, shows the countdown);
  - **BLACKOUT** (B, ink);
  - **FREEZE** (F, ice);
  - **DROP FX** (D, *hold*, ember, "MAX 3 FLASH/S"; momentary zoom + RGB split + one capped flash).
- Scenes never change face hiding.

### AUTO-VJ behaviour
At each section boundary (INTRO/BUILD/DROP/BREAK) it swaps every **unlocked** effect layer for another of the same kind, and shows the toast `AUTO-VJ · New look for the DROP: 3 layers changed, locked ones kept.` The countdown shows time and bars to the next section.

## State (suggested Zustand slices)
- `prod`: `setup: {steps: ('todo'|'busy'|'ok'|'err')[4], done: boolean}` (persisted), `tdConn: 'ok'|'conn'|'down'`, `cam: 'ok'|'denied'`, `camFallback: 'demo'|'stage'`, `fx`, `mode: 'body'|'hands'` (derived from fx), `lastFxByMode`, `favs: Record<id,bool>`, `favOnly`, `macros[fx]`, `reacts[fx]`, `palette`, `maskFirst`, `showHands`, `gestures: {pinch, palm, fist}`, `rec: {on, t0}`, `output: boolean`, `confirm: 'rec'|'out'|'stopOut'|null`, `sentFx`, `aspect`, `panelsCollapsed`.
- `visuals` (extends the existing `state/visuals.ts`): `source`, `latency`, `aspect`, `base`, `layers: {id, cat:'gen'|'fil'|'milk'|'td', fx, name, op, reacts, mute, solo, lock, td?}[]` (top → bottom), `text: {on, mode, word, op, reacts, mute}`, `face: {on, style}`, `faceConfirm`, `browser: {open, tab, hover}`, `perf`, `autoVj`, `output`, `outConfirm`, `recLive`, `blackout`, `freeze`, `dropFx`, `scenes[8]`, `activeScene`.
- Audio analysis needed per frame: kick, snare, bass, drop (decays from the drop onset), section (pulse on each new section), voice, level, and section/next/time-to-next. These come from the existing song analysis and stems. **hand** = normalised thumb–index distance from MediaPipe hand landmarks (21 per hand).

## Motion
- Easing: `--vb-ease (.2,.8,.2,1)`, glide `(.2,.9,.2,1)`, snap `(.2,1.3,.3,1)`.
- Rise in .3s (8px). Pop .18–.3s. Drawer slide-up .28s. Panel collapse .38s.
- `vbLive` output pulse 2.4s. REC blink 1s `steps(2)`.
- All CSS animation is off under reduced motion.

## Design tokens
Use the existing `tokens.css` (TRANSMISSION + REMIX HARDWARE + MASKS). New tokens are in **`visuals-td-tokens.css`**: layout sizes, stage rings, reacts-to colours, layer-kind colours, face-state colours, TD palettes, flash cap and two-step window. Add one more from this round: `--vb-hands: #e79bd0` (HANDS mode, HANDS reacts-to, gesture UI).

Core palette: bg `#0b0b0c`/`#0a0a0b`, chrome `#0d0d0f`, rack `#101012`, well `#0b0b0c`, raise `#18181b`, card `#141417`, knob `#17171a`, ink `#e9e5da`, secondary `#bdb8ac`, dim `#8d8a82`, ember `#ff4b2b`, amber `#ffb23e`, ice `#7cc8ff`, ok `#7fd08a`, milkdrop/hands `#e79bd0`. Sections: INTRO `#9aa3b5`, BUILD `#d9c46a`, DROP `#ff4b2b`, BREAK `#6fc2b0`.
Type: **Big Shoulders Display** 700/800 for names and numbers; **JetBrains Mono** 400/500/700 for data. Both are already in `src/renderer/src/assets/fonts`.
Radii: 2 (controls), 3 (cards/chips), 4 (panels).

## Assets
No new raster assets. The FoxBox mark is the existing `app/design/brand/foxbox-mark.svg`. Fonts are already in the repo (copies are in `prototype/fonts`). All visuals are generated live.

## Clickable flow to verify
1. Open PROD → **SET UP TOUCHDESIGNER** → the patch builds → OPEN TOUCHDESIGNER → connected → live.
2. Pick THRESHOLD + PLEXUS, then drag **CHAOS** up.
3. Click LINES' reacts chip → **KICK**.
4. Switch to **WINDOW MOSAIC**, then turn on **MASK FIRST**.
5. **SEND TO VISUALS** → OPEN VISUALS →.
6. On VISUALS, drag a layer to reorder, press **P**, and fire a scene pad (1–8).

## Files
- `screenshots/`: one capture per state (`prod-01…13`, `visuals-01…07`) at 1512×982. Canvas visuals are live in the prototype; some captures may show them blank.
- `prototype/VisualsProd.dc.html`: both pages, every state (STATES menu), and the clickable flow.
- `prototype/ComponentSheet.dc.html`: component states.
- `prototype/fx-engine.js`: stand-in renderer and simulated audio clock (reference for envelopes, the flash limiter and gesture timing only).
- `visuals-td-tokens.css`: new `--vb-*` tokens.
