# Claude Design prompt: FoxBox REMIX page (1.5, final)

**How to use it:**
1. Paste everything below the line into Claude Design.
2. Attach these screenshots as the style reference (all in `app/docs/screens/readme/`): `14-visuals-auto.png` (VISUALS), `01-studio.png` (STUDIO) and `15-whats-new.png`.
3. Attach FoxBox's original design bundle (TRANSMISSION) if you still have it.
4. When it's done: Export → **Handoff to Claude Code**, and give the zip to the PM session.

---

**Product.** FoxBox is a macOS studio for the anonymous bass-music DJ **GUY FVWKS** (dubstep, riddim, trap, deep bass).
- The left rail: 01 STUDIO · 02 VISUALS · **03 REMIX** (new: this page) · 04 VAULT · 05 PROD (greyed out, WIP badge) · 06 VOICES · 07 SETTINGS.
- A working but unstyled REMIX page already exists in code, with the component names listed below. **Design its final look, and keep those names.**
- Match the attached screens' style:
  - **NO big page title or header** (the user finds it repetitive; the rail already names the page, and the app removed page titles everywhere);
  - panel headers in small spaced caps;
  - segmented controls;
  - ember-orange primary buttons, and the amber chip for automatic modes.

**What REMIX does.** It makes bass-music remixes fast, from the DJ's own tracks or bounced stems.
- **No AI, and no "generate" wording**: use BUILD, SWAP, FLIP and LINE UP.
- Everything is local; there's no online search.

There are three recipes:
1. **VIP / DROP SWAP:**
   - keep the track, and rebuild its drop with a new bass sound playing the *exact same groove*;
   - optionally double the last drop as a VIP drop.
2. **MASHUP:**
   - track A's build or vocals into track B's drop, with key and tempo matched automatically;
   - **MASH RADAR** finds the partner among the DJ's own tracks, instantly.
3. **GENRE FLIP:**
   - the same track in another style: **HALF-TIME**, **RIDDIM**, **140 DUBSTEP**, **FOUR-ON-THE-FLOOR**, **DNB**;
   - FoxBox reads the track's kick, snare and hats and re-programs them into the new style on a kit. Silent bars stay silent, and build rolls stay as played;
   - the bass re-times to the new feel.

**The workflow: recipe + timeline on ONE screen.**
- **Getting tracks in:** drag audio files in from Finder (WAV, AIFF, FLAC, MP3, M4A), or pick from your tracks.
  - Dropping two files fills A, then B.
  - A drop highlight appears only on real drop targets.
- **BUILD:** pick a recipe and press BUILD.
  - A draft appears and **starts playing within ~5 seconds**: the opening and the first drop are ready first, and the rest fills in behind the playhead.
  - Clips still being prepared show a subtle **PREPARING** shimmer, on that clip only.
- **Editing:** drag, cut and duplicate sections instantly. Only a *new* sound (a patch, kit or key shift) re-prepares a clip.

**Layout (1512×982 with no page scroll; 1280×800 must also work, with every primary action visible).**
- **Top row (no page title):** the recipe as a segmented control (VIP / DROP SWAP · MASHUP · GENRE FLIP) and a big **BUILD** button. BPM/KEY live in the app's top bar, so don't repeat them.
- **SOURCES strip** with slot **A**, and slot **B** in MASHUP.
  - Each slot:
    - a drop zone, or "pick a track";
    - title, BPM, key (e.g. "C#m · 12A"), length;
    - a mini waveform with DROP / BUILD markers;
    - a one-time stem-split progress row (DRUMS · BASS · VOCALS · OTHER).
  - Between the slots in MASHUP: a match badge ("+2 st · 0.97× · 86").
- **Centre hero: the REMIX TIMELINE.**
  - It's built on a canvas multitrack editor (waveform-playlist), so design lane colours, clip bodies and headers, selection, trim handles and the playhead as themeable tokens that editor can draw.
  - A bar ruler with 8-bar phrase lines, and a loop region.
  - A **section lane** of colour-coded blocks: INTRO / BUILD / DROP / BREAK / OUTRO. You can reorder them, duplicate a drop or cut a break, and they snap to phrases. Each block shows its source (e.g. "A · bar 33").
  - **Lanes:** DRUMS, BASS, VOCALS, OTHER (tinted by source A/B), plus **SYNTH BASS** (BASS DNA) and **KIT** (FLIP drums).
  - Each lane has a **SWAP** menu (e.g. "BASS → BASS DNA", "DRUMS → FLIP KIT"), gain, mute and solo.
  - Clips show waveforms, fades and shift/stretch badges ("+2 st", "0.97×").
- **Right: a context panel** that changes with the recipe or selection.
  - **BASS DNA** shows how the bass *moves*:
    - a **groove roll**: notes as bars on a pitch grid, with **808 glide curves** between notes. Read-only in 1.5, but design the look so editing can come later;
    - a **wobble lane**, per bar: the LFO division (1/4T, 1/8, 1/8T, 1/16, 1/16T), its **shape (sine / square / saw)** and depth, as a small wave;
    - two thin curves: **BOUNCE** (the sidechain pump) and **GROWL**;
    - a **patch picker** with 5 tabs, WOBBLE · REESE · GROWL · 808 · RIDDIM, and 17 sounds in total, 2–4 per tab. Each sound has a small engine tag (SURGE or FOXBOX) and a **2-second audition** button;
    - 4 macro knobs (reuse the existing MacroKnob): GRIT, WOBBLE, SUB, GLIDE;
    - **A/B**: the original bass vs the new one.
  - **MASH RADAR:**
    - the part to borrow: BUILD / DROP / VOCALS;
    - filters: bass style (deep / trap / dubstep), BPM range, "key-compatible only";
    - result rows show title, the section used, a **score ring 0–100**, and reasons as small chips ("key +2 st", "tempo 0.97×", "bass style match", "fills the gap"), plus PREVIEW and **LINE IT UP** (drops it into slot B and aligns it).
  - **GENRE FLIP:**
    - style cards with target BPM;
    - a kit picker: **FOXBOX KIT** plus **4 TR-808 kits** (classic 1994 samples);
    - SWING;
    - a "drums read" row showing the detected kick / snare / hat hits per bar.
- **Bottom: transport + EXPORT**, as an inline drawer, never a modal.
  - Transport: play/stop, loop, **A/B original vs remix**, BPM and key readout, Link sync dot.
  - Export options, pick any:
    - **AIFF + rekordbox cues** (cues at the drops);
    - **MP3 320**;
    - **Ableton Live set** with a small **BETA** tag ("opens in Live 11 and 12");
    - **SEND TO VISUALS** (the remix becomes a track in VISUALS with its drops known).
  - The result is a draggable file tile (like the existing Cartridge) plus REVEAL. **Show file names only, never a full path or folder**: the DJ is anonymous and streams.

**States to design.**
- **Empty:** one big drop zone, plus the three recipes explained in a line each.
- **A dragged file that can't be read:** an inline message on the slot.
- **First-time track:** splitting stems, then reading the track (drops, BASS DNA, drums), with calm progress.
- **BUILDING:**
  - the timeline fills in, section by section;
  - playback starts early;
  - PREPARING clips shimmer.
- **Draft ready:** playing, A/B toggled, a patch change re-preparing one clip.
- **MASH RADAR:** results, and "no good matches" (with suggestions: widen the BPM range, allow key shifts).
- **Keys too far apart to mash:** an inline warning with a suggested shift.
- **Export:** in progress, success (file tiles, "Opens in Ableton Live 11+ · BETA", "Added to VISUALS").
- **Errors:** stem split failed, engine offline, low disk.

**Rules from FoxBox's UX audit (please follow them strictly).**
- **Text:** nothing below **11 px** (the app now enforces this with a `--vb-text-min` token), including labels and small caps; loosen the tracking on tiny caps.
- **Contrast:**
  - dimmed text keeps **≥ 4.5:1** contrast;
  - only truly disabled controls look disabled;
  - no grey-on-grey.
- **Hit areas:** every control is at least **24×24 px**. Destructive actions (delete, clear) sit away from move/arrange controls, or take two steps.
- **One verb per action, one meaning per word.**
  - Don't reuse "AUTO" for different things; use AUTO-VJ, CYCLE and SNAP where needed.
  - Don't have two primary buttons for the same job.
- **No dead ends:** never a button that leads somewhere unreachable.
- **No modals:** use inline panels and drawers.
- **Toasts:** top-right, under the top bar, and never covering the next button to press.
- **Brand:**
  - **Theme: TRANSMISSION dark console.**
    - `--vb-bg #0b0b0c`, `--vb-panel #111113`, `--vb-raise #18181b`, `--vb-card #141417`.
    - Ink `#e9e5da`, dim `#8d8a82`.
    - Ember `#ff4b2b` (the primary action), amber `#ffb23e` (meters, automatic modes), ice `#7cc8ff`, ok `#7fd08a`.
  - **Type:** Big Shoulders Display 800 for display, JetBrains Mono for data and labels.
  - **Texture and glass:** subtle scanlines and restrained glow. Glass only on small popovers and cards.
  - **No:**
    - mascot or fox character (the small fox logo mark is fine);
    - neon gradients.
- **Accessibility:**
  - visible focus on every control;
  - warnings never rely on colour alone;
  - lane colours are colour-blind-safe and always labelled;
  - motion respects `prefers-reduced-motion`.

**Component names (the code already uses these; keep them).**
- Page and sources: RemixPage, SourceSlot, MatchBadge, RecipeStrip, BuildButton.
- Timeline: RemixTimeline, RemixPlaylist (the canvas editor wrapper), BarRuler, SectionLane, SectionBlock, StemLane, Clip, DropMarker, SwapMenu.
- BASS DNA: BassDnaPanel, GrooveRoll, WobbleLane, BounceCurve, PatchPicker.
- MASH RADAR and GENRE FLIP: MashRadar, RadarResult, MashScore, FlipCards, KitPicker, DrumsRead.
- Transport and export: RemixTransport, RemixExport, ProgressStrip.

**Deliverables.**
1. The REMIX page at 1512×982 and 1280×800, covering every state above.
2. A component sheet with states (hover, focus, active, disabled, preparing, drop-target).
3. A clickable prototype of the core loop: drag in a track → VIP / DROP SWAP → BUILD (it starts playing early) → pick a REESE patch in BASS DNA → A/B → export. Also a MASHUP pass (MASH RADAR → LINE IT UP → BUILD) and a GENRE FLIP pass (RIDDIM + a TR-808 kit → BUILD).
4. Any new tokens as CSS variables in the `--vb-*` family.
5. **Handoff to Claude Code**, targeting React + TypeScript + Vite in Electron, with CSS Modules and the existing `--vb-*` tokens. Keep the component names above.
