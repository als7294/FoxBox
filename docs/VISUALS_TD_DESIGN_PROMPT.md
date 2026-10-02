# Claude Design prompt: VISUALS refresh + the new PROD (TouchDesigner) page (1.5.x)

**How to use it:**
1. Paste everything below the line into a **new** Claude Design project.
2. Attach these screenshots as the style reference:
   - the REMIX and MASKS designs you already made (their HARDWARE look): `app/design/remix/prototype/Remix.dc.html` and `app/design/masks/prototype/Masks.dc.html`, or a few exported frames;
   - today's VISUALS page (a screenshot of VISUALS with the CAMERA base and LOW-POLY);
   - your two TouchDesigner reference reels: the threshold/plexus one and the window-mosaic one.
3. When it's done: Export → **Handoff to Claude Code**, and give the zip to the PM session.

---

**Product.** FoxBox is a macOS toolkit for bass producers who'd rather stay anonymous: VOICE MASK · REMIX · VISUALS.
- **VISUALS** is the live VJ side. A **base** layer (WAVEFORM, VOICE CORE, CAMERA, PHOTO, VIDEO, TOUCHDESIGNER) sits under stacked **effects**:
  - 16 generated shader layers;
  - 15 filters;
  - hundreds of Milkdrop presets;
  - a TEXT layer that decrypts, slams and shatters on the drop.
- **Face hiding (FACE ENCRYPTION)** covers the DJ's face live: LOW-POLY, DEPTH GLITCH (beta), POP-UPS, MOSAIC, GLITCH, any mask from MASKS, and more.
- **Audio reactivity:** everything reacts to the music. FoxBox knows the song's sections, builds, drops, BPM, stems and lyrics. **AUTO-VJ** follows the song by itself.
- **Output:** a projector window, at 9:16 / 16:9 / 1:1; SAVE CLIP; and REC LIVE.

**The rail (new):** 01 STUDIO · 02 VISUALS · 03 MASKS · 04 REMIX · 05 VAULT · 06 PROD · 07 VOICES · 08 SETTINGS.
- **REMIX is greyed out as WIP:** .45 opacity, disabled, with an amber WIP badge, exactly as PROD used to be.
- **PROD (Production) becomes the TouchDesigner page:** enabled, with a **DEMO** badge.

**This brief has two parts:**
- **A. Refresh VISUALS.** Same features, a much better live console.
- **B. The PROD page (Production), now TouchDesigner:** a playground where you play with TouchDesigner effects on your camera while they react to the music.

## A. VISUALS refresh

**What's wrong today.** Three dense columns: AUDIO SOURCE + BASE + FACE ENCRYPTION on the left, the stage in the middle, EFFECTS on the right.
- Many tiny equal-weight buttons, and the stage isn't the hero.
- Effects are a flat list behind "+ ADD EFFECT".
- It reads like a settings form, not an instrument you play during a set.

**Goals:**
- **The stage is the hero.** It's big, it always matches the chosen aspect (9:16 / 16:9 / 1:1), and the LIVE/OUTPUT state is unmistakable.
- **Layers you can see:**
  - a clear stack, base at the bottom, then effects, then TEXT, then the face layer on top;
  - drag to reorder, solo/mute, an opacity knob;
  - **REACTS TO** per layer (kick, snare, bass, the drop, the song section);
  - each layer's live meter pulses with what it reacts to.
- **Browse effects like a game inventory,** not a menu:
  - tiles with live animated thumbnails, grouped Generators / Filters / Milkdrop / Text / TouchDesigner;
  - hover to preview on the stage, click to add.
- **Performance mode:** a one-key toggle that hides everything but the stage plus a slim strip of big pads (8 scene slots, AUTO-VJ, BLACKOUT, FREEZE, DROP FX) for a dark booth.
- **AUTO-VJ** stays one switch, with LOCK on layers you want kept, and a visible "next change" countdown to the next section.
- **Face hiding** stays one tap away with its style picker, and is always shown as ON or OFF with a clear state. Anonymity is the point of FoxBox.
- **Audio source:** TRACK / LIVE INPUT / MIC, with the latency mode, as a compact header strip with a live level meter, not a panel.

## B. The PROD page: TouchDesigner

**What it is.** A playground for TouchDesigner effects, driven by **your camera** and reacting to **the music playing in the background**. It should feel fun and toy-like, like the reference reels:
- high-contrast black/white/red threshold looks on the person, with tracked points joined by glowing lines ("plexus") and small number labels;
- glow bursts on the drop;
- the person rebuilt from many small desktop-style windows that pop on the beat.

FoxBox runs the user's own free TouchDesigner hidden in the background. They never see TouchDesigner itself.

**Where it lives.** It's the **06 PROD** rail item (Production), which was greyed out until now. Its header names it **PROD · TOUCHDESIGNER**, with a **DEMO** badge. The rail order doesn't change.

**Layout (1512×982, no page scroll; 1280×800 must work):**
- **Centre:** a big live preview of the camera through the chosen TD effect, reacting to the music. It has an aspect switch and a small, always-legible burned-in label: **"TOUCHDESIGNER · DEMO · NON-COMMERCIAL, NOT COPYRIGHT-SAFE"**.
- **Left: the effect browser.** Big tiles with animated thumbnails:
  - THRESHOLD + PLEXUS and WINDOW MOSAIC today; design for 8–12 (e.g. DATA BODY, GLOW TRAILS, SLIT SCAN, POINT CLOUD, MIRROR TUNNEL, ASCII BODY);
  - favourites, and a "NEW" tag.
- **Right: play controls for the chosen effect:**
  - 4–6 big macro knobs (INTENSITY, COLOUR, CHAOS, TRAILS, LINES, SIZE);
  - per-macro **REACTS TO** (kick, snare, bass, drop, section, voice);
  - a palette row (EMBER, ICE, TOXIC, BONE, VOID);
  - RANDOMIZE.
- **Bottom strip:**
  - the music: what's playing, BPM, section, a kick/snare/drop meter;
  - RECORD A CLIP;
  - **SEND TO VISUALS:** puts this effect on the VISUALS stack as a TOUCHDESIGNER layer;
  - **SEND TO OUTPUT** (the projector).
- **The camera chip:** this page uses the **raw camera**, so your real face is visible in these effects (the user's choice).
  - Show a persistent amber chip, **"▲ FACE VISIBLE: RAW CAMERA"**, whenever the camera feeds TouchDesigner.
  - Include a one-click **MASK FIRST** toggle that runs FoxBox's face hiding before TouchDesigner, for when it goes to the projector or a clip.
  - SEND TO OUTPUT and RECORD should show the face state clearly before you commit.
- **Setup lives here too.** The first time, the page shows **SET UP TOUCHDESIGNER**, then a checklist:
  1. Installed: with GET TOUCHDESIGNER (FREE) if it's missing.
  2. FoxBox patch built.
  3. Activated: "Open TouchDesigner once and sign in", with OPEN TOUCHDESIGNER.
  4. Connected.
  Each step shows ✓ / … / ! / ○ with a TRY AGAIN. After the first time, the page goes straight to live.

**Some effects change the song's sound** (the user: "some should adjust the sound of the song"):
- **Audio-coupled presets** carry a **"CHANGES THE SOUND"** chip.
- **Body controls:** while one plays, your body drives audio effects on the track:
  - raise a hand → FILTER SWEEP;
  - open your mouth → ECHO THROW;
  - tilt your head → REVERB WASH;
  - a quick move → STUTTER;
  - also TAPE STOP and BITCRUSH.
- **Show the mapping live:** e.g. a "HAND → FILTER" meter that moves as you move.
- **Controls:** one big **AUDIO FX** on/off, and a small safety-limiter indicator. Everything resets when you leave the effect.
- **Effect browser:** design for 8–12 effects, a few of them audio-coupled.

**Some effects are played with your hands** (the user: "making shapes with your fingers"):
- **The presets:**
  - ENERGY BALL: an orb between your hands;
  - STRINGS: strings between matching fingertips;
  - PORTAL: another world inside a frame you make with your thumbs and index fingers;
  - AIR DRAW: pinch to draw in the air.
- **Tiles:** each one shows a small hand-shape pictogram and a one-line how-to ("Make a frame with your thumbs and index fingers").
- **Live detection:** the preview shows a chip while a shape is held, e.g. "FRAME ✓" or "PINCH".
- **Signs** can switch modes or change the sound: a fist → TAPE STOP, a peace sign → BEAT REPEAT.

**States to design** (and show REMIX greyed out as WIP in the rail in every frame):
- **PROD (TouchDesigner) page:**
  - first visit: not installed, installed-not-set-up, mid-setup, activate needed;
  - live with the camera;
  - camera permission denied (inline help; the effects fall back to a demo loop or the FoxBox stage);
  - no music playing (the effects idle gently, with a "play a track to make it react" hint);
  - TouchDesigner quit or crashed ("RECONNECT");
  - FACE VISIBLE vs MASK FIRST;
  - recording;
  - sent to OUTPUT.
- **VISUALS:**
  - empty (no layers);
  - a busy stack (base + 4 effects + TEXT + face);
  - the effect browser open with hover-preview;
  - performance mode;
  - AUTO-VJ running with a section countdown;
  - face hiding off (a clear warning);
  - OUTPUT live.

**Rules from FoxBox's UX audit (follow strictly):**
- **Text and contrast:** nothing below **11 px**, and dimmed text ≥ **4.5:1**.
- **Controls:** every control ≥ **24×24 px**, with visible focus everywhere.
- **No modals:** inline panels and drawers only. Destructive actions take two steps.
- **Warnings** always pair ▲ with text, never colour alone.
- **Photosensitivity:** at most **3 flashes a second**, and respect `prefers-reduced-motion`.
- **Wording:** one verb per action, and no "AI" or "generate" wording.
- **Brand:**
  - the TRANSMISSION palette (`--vb-bg #0b0b0c`, ember `#ff4b2b`, amber `#ffb23e`, ice `#7cc8ff`, ok `#7fd08a`, ink `#e9e5da`, dim `#8d8a82`) with REMIX/MASKS HARDWARE surfaces;
  - Big Shoulders Display for names and numbers, JetBrains Mono for data;
  - no neon-gradient UI chrome; the visuals themselves can be as loud as you like;
  - no Apple or Microsoft logos or names in the window-mosaic art.

**Component names (keep them; the code will use them):**
- VISUALS: VisualsPage, StageView, LayerStack, LayerRow, ReactsTo, EffectBrowser, EffectTile, PerformanceStrip, ScenePad, AutoVjControl, FaceHideControl, AudioSourceStrip.
- PROD (TouchDesigner): ProdPage (TouchDesignerPage), TdPreview, TdEffectBrowser, TdEffectTile, MacroKnob, ReactsToMenu, PaletteRow, CameraChip, MaskFirstToggle, SendToVisuals, SendToOutput, RecordClip, TdSetupChecklist, DemoLabel, HandShapeHint, ShapeChip.

**Deliverables:**
1. Both pages at 1512×982 and 1280×800, covering every state above.
2. A component sheet with states: hover, focus, active, disabled, reacting/pulsing.
3. A clickable prototype:
   1. open PROD and SET UP TOUCHDESIGNER;
   2. pick THRESHOLD + PLEXUS and turn CHAOS up;
   3. set LINES to react to the kick;
   4. switch to WINDOW MOSAIC, then MASK FIRST;
   5. pick an effect that CHANGES THE SOUND, raise a hand to sweep the filter, and turn AUDIO FX off;
   6. pick PORTAL and make a frame with your fingers (FRAME ✓);
   7. SEND TO VISUALS;
   8. on VISUALS, reorder the stack, enter performance mode, and fire a scene pad.
4. Any new tokens as `--vb-*` CSS variables.
5. **Handoff to Claude Code**, targeting React + TypeScript + Vite in Electron, with CSS Modules and the existing `--vb-*` tokens.
