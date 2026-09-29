# Claude Design prompt: FoxBox MASKS page (1.5.1 flagship)

**How to use it:**
1. Paste everything below the line into a **new** Claude Design project.
2. Attach these screenshots as the style reference:
   - the REMIX design you already made (its HARDWARE look): export a few frames from that project, or use `app/design/remix/prototype/Remix.dc.html`;
   - `app/docs/screens/readme/14-visuals-auto.png` and `12-visuals-camera.png` (VISUALS and the camera);
   - a still of LOW-POLY and one of DEPTH GLITCH, from the mask audition clips.
3. When it's done: Export → **Handoff to Claude Code**, and give the zip to the PM session.

---

**Product.** FoxBox is a macOS toolkit for bass producers who'd rather stay anonymous: VOICE MASK · REMIX · VISUALS.
- In VISUALS, the camera hides the DJ's face in real time with **face styles** (LOW-POLY, DEPTH GLITCH, POP-UPS, MOSAIC…) and **masks** that track the head in 3D.
- **MASKS is a new page** in the left rail, right after VISUALS: 01 STUDIO · 02 VISUALS · **03 MASKS** · 04 REMIX · 05 VAULT · 06 PROD (greyed out, WIP badge) · 07 VOICES · 08 SETTINGS.
- It's the **biggest feature of 1.5.1**.

**What MASKS is: a video-game character creator for your mask.** It should feel like customising a character in a game, **not** like a paint program.
- You start from a base or a preset.
- You flip through parts, tune them with sliders, pick materials and colours, and add glow that pulses on the beat.
- You see it on a big 3D head that you can spin.
- Then you name it, save it, and **WEAR** it in VISUALS.
- Every mask always covers the whole face: that's the point of FoxBox. There are no eye or mouth holes; eyes and mouths are drawn features.

**Categories** (the tabs of the creator):
1. **BASE:** the shell silhouette. Full face, visor, half-mask with a hood feel, helmet. Sliders: brow, cheeks, chin, stand-off from the face.
2. **EYES:** styles such as slits, visor band, rings, X, pixel, glow dots, lenses. Sliders: size, spacing, tilt.
3. **MOUTH & JAW:** grille, teeth, stitched, speaker slots, none. Sliders: size, jaw drop (it follows the real jaw when you talk).
4. **EARS & HORNS:** fox ears, cat ears, horns, antennae, crests, fins, none. Sliders: size, tilt, spread.
5. **MATERIAL:** matte, metal, glossy lacquer, holo/iridescent, **LOW-POLY facets**, glitch. Slider: roughness/shine.
6. **COLOURS:** primary + secondary + accent, with palette presets (EMBER, ICE, TOXIC, BONE, VOID…) and a custom colour picker.
7. **PATTERN:** none, stripes, circuit lines, camo, halftone, war paint, plus a decal slot (a symbol or tag).
8. **GLOW & FX:** glow colour and strength, **beat reaction** (pulse on the kick / breathe / off), scanline or hologram shimmer. It must stay photosensitivity-safe: no strobing, and at most 3 flashes a second.

**Art direction (the user, after seeing the first engine preview): the masks should feel glitchier, more low-poly, and like opaque glass.**
- Faceted, low-poly shapes are the default language of every mask.
- The signature material is frosted, opaque glass or resin: glossy highlights, a sharp rim light, a subtle inner gradient, slight chromatic edges. It is never see-through, because the face must stay hidden.
- Glitch is part of the style: bands that slip in depth, RGB split on the edges, flickering facets, scanline shimmer. It pushes harder on the beat, without strobing.
- Design the tiles, preview lighting and backgrounds to show this off.

**The core loop.** Open MASKS → pick a preset or start from BASE → flip parts with ◀ ▶ or tiles → tweak sliders → change material and colours → **RANDOMIZE** (with a lock on each category, like game creators) → **SAVE** (name it) → **WEAR IN VISUALS**.

**Layout (1512×982 with no page scroll; 1280×800 must also work, with every primary action visible).**
- **No page title or header** (the app removed them; the rail names the page). Use the HARDWARE look from the REMIX design:
  - recessed wells, LED stripes, small spaced caps;
  - ember primary buttons, amber for automatic/beat things;
  - Big Shoulders Display for names and numbers, JetBrains Mono for data.
- **Left: CategoryTabs**, a vertical list of the 8 categories, each with an icon and a small "changed" dot. Plus **MY MASKS** at the bottom.
- **Centre, the hero: MaskPreview.** A big 3D head wearing the mask.
  - Drag to spin (it idles on a slow turntable).
  - Toggles: TURNTABLE | **LIVE** (try it on with your camera) | a stock DJ clip.
  - A **BEAT** preview toggle shows the glow pulsing to a demo beat.
  - A small A/B compares against the saved version.
- **Right: the options for the current category.**
  - A **PartCarousel** of big tiles, each with a small 3D thumbnail of that part; the selected tile has an ember LED.
  - **ParamSlider**s under it.
  - **SwatchRow**s and **MaterialChips** where they apply.
- **Bottom strip:**
  - **PresetStrip** (horizontal cards: NEON ONI, CHROME FOX, BONE VISOR, GLITCH SAINT, VOID RAVER…);
  - **RandomizeButton** (a dice icon; R key);
  - the name field;
  - **SAVE**;
  - **WEAR IN VISUALS** (the ember primary).

**MY MASKS (a mode of the same page, not a modal).**
- A grid of saved masks with thumbnails: open to edit, duplicate, rename, delete (two steps).
- **+ IMPORT** keeps the existing image-mask import (SVG, PNG or WebP drawn on the face TEMPLATE), with the TEMPLATE download beside it.
- The built-in masks (FOX, LOW-POLY…) are shown as read-only presets you can duplicate to customise.

**Interactions.**
- ◀ ▶ or the arrow keys flip parts.
- Sliders: drag, Shift for fine control, double-click to reset.
- **R** randomizes the unlocked categories, with a quick dice roll and the parts shuffling in.
- **⌘Z / ⇧⌘Z** undo/redo; **⌘S** saves; **Space** toggles TURNTABLE/LIVE.
- Changes preview instantly, and the 3D head never goes blank.

**States to design.**
- **First open:** "PICK A STARTING MASK" with the presets, big and inviting.
- **Editing:** each category open at least once, with sliders mid-drag.
- **RANDOMIZE:** mid-roll, with some categories locked.
- **LIVE try-on:**
  - working;
  - camera permission denied: an inline message, with the turntable kept;
  - no face found: the mask holds on the head model.
- **Saving:** name empty or a duplicate name, with an inline hint.
- **Saved:** the WEAR IN VISUALS call to action.
- **MY MASKS:** empty, full, a delete confirmation.
- **Performance:** a "reduced effects" state for slower Macs.
- **Future state (design it, but it doesn't ship in 1.5.1):** **HEADS**, full animated avatar heads that blink and talk with you. Show how the page grows into it, e.g. a BASE option or a mode switch.

**Rules from FoxBox's UX audit (follow strictly).**
- **Text:** nothing below **11 px**; loosen the tracking on tiny caps.
- **Contrast:** dimmed text ≥ **4.5:1**; only truly disabled controls look disabled.
- **Hit areas:** every control ≥ **24×24 px**.
- **Destructive actions** take two steps, or sit apart.
- **No modals:** inline panels and drawers only. Toasts don't cover the next button.
- **One verb per action:** SAVE, WEAR, RANDOMIZE, DUPLICATE. No AI or "generate" wording.
- **Accessibility:**
  - visible focus everywhere;
  - warnings never rely on colour alone;
  - motion respects `prefers-reduced-motion`: the turntable stops and the dice don't animate.
- **Brand:** the TRANSMISSION palette (`--vb-bg #0b0b0c`, ember `#ff4b2b`, amber `#ffb23e`, ice `#7cc8ff`, ok `#7fd08a`, ink `#e9e5da`, dim `#8d8a82`) with the HARDWARE surfaces from REMIX.
  - No neon gradients.
  - The masks themselves can be as bold and colourful as a game's.

**Component names (keep them; the code will use them).**
- Page and categories: MasksPage, CategoryTabs.
- Preview: MaskPreview (TurntableView, LiveTryOn), BeatPreviewToggle.
- Options: PartCarousel, PartTile, ParamSlider, SwatchRow, MaterialChips, GlowPanel.
- Bottom strip: PresetStrip, RandomizeButton, CategoryLock, SaveBar, WearButton.
- Library: MyMasksGrid, MaskCard, ImportPanel.

**Deliverables.**
1. The MASKS page at 1512×982 and 1280×800, covering every state above, plus the HEADS future state.
2. A component sheet with states (hover, focus, active, disabled, locked, changed).
3. A clickable prototype of the core loop: open → pick NEON ONI → flip EYES and EARS & HORNS → set MATERIAL to LOW-POLY → change COLOURS → lock BASE and RANDOMIZE twice → SAVE as "MY ONI" → WEAR IN VISUALS.
4. Any new tokens as CSS variables in the `--vb-*` family.
5. **Handoff to Claude Code**, targeting React + TypeScript + Vite in Electron, with CSS Modules and the existing `--vb-*` tokens. The 3D preview is three.js; design its frame, lighting mood and background, not the renderer.
