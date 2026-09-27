# FoxBox — Claude Design handoff brief

_For GUY FVWKS. Paste everything below into Claude Design. The build is running in parallel, and the app session is already building unstyled screens that use the component names listed here._


**Product.** FoxBox is a macOS desktop voice-mask studio for the anonymous DJ **GUY FVWKS**. You type a
line or record your voice. It comes back as a low, distorted, anonymous "transmission". Then you drag a
bar-exact, club-loud file straight into Rekordbox or Ableton.
- **Core loop:** type → hear → twist 4 knobs → export → drag out. It should take under 30 seconds.

**Audience and context.**
- One user: a DJ/producer, not an audio engineer.
- Prep happens at home, in the dark, on a MacBook Pro 14". Design at **1512×982**; the minimum window is 1280×800.
- The mouse is primary, with power-user keyboard shortcuts.
- Big, confident controls come first; the deep rack is second.

**Brand direction.**
- **Sources:**
  - GUY FVWKS is a Guy Fawkes pun.
  - Anonymous-style broadcast hijacks and "WE ARE ___" messaging.
  - The dark, masked bass-music world (Deathpact).
- **Mood words:** intercepted transmission, redacted dossier, black-ops console, gunpowder/ember, stage gear.
- **Explore 2 directions on the Studio screen first, and let me pick:**
  1. **TRANSMISSION:**
     - Near-black console panels, bone-white text and one ember/signal-red accent, with amber for meters.
     - Monospace data, condensed display type, restrained phosphor glow and very subtle scanlines.
  2. **DOSSIER:**
     - A dark declassified-file look: redaction bars, stencil/typewriter type, stamp marks, serial numbers ("TRANSMISSION #0042").
- **Rules:**
  - No stock neon-cyberpunk gradients or glassmorphism.
  - **Do not reproduce the V for Vendetta / Anonymous mask artwork**; it is Warner Bros-owned. Use an original abstract mark, or none.
  - Only open-license (OFL) fonts, because the app bundles them.

**Screens** (left rail navigation):
1. **STUDIO** (main; no scrolling at 1512×982):
   - **Top bar:**
     - App mark and engine status (READY / LOADING MODEL / OFFLINE).
     - BPM field with tap-tempo, KEY picker, BARS (1/2/4/8/16/FREE).
     - Output format chip (AIFF 24/44.1), loudness mode chip (CLUB / BAKE-IN).
     - RENDER button.
   - **SOURCE panel**, with tabs TYPE | RECORD | IMPORT:
     - TYPE:
       - A big monospace **Script editor** with markup highlighting: `|` shows as beat ticks, `[0.5]` as pause chips, `*word*` as a highlighted "throw".
       - A markup cheat-sheet popover.
       - **Voice picker**: cards with a 2 s audition button and tags.
       - Speed control.
     - RECORD:
       - Giant record button, input meter, 3-2-1 count-in, takes list.
     - IMPORT:
       - Drop zone.
   - **SIGNAL view** (center hero):
     - Output waveform over a **bar/beat grid** with numbered bars, segment regions, playhead, dry/wet **A/B** and loop.
     - **Fit indicator**, e.g. "speech 7.2 s → 4 bars @140 = 6.86 s: STRETCH 0.95× or go 8 BARS", with suggestion chips.
     - **Loudness meter** (short-term LUFS max, true peak) and a **Mask-strength badge** (SYNTHETIC / WEAK / MEDIUM / STRONG, with reasons on hover).
   - **RACK:**
     - Preset strip: PACT, LEGION, ABYSS, UNIT, GHOST, SIGNAL, RAW, plus user presets.
     - **4 macro knobs** as the visual hero: DEPTH, GRIT, MACHINE, SPACE. Each has a ring showing its mapped parameters.
     - "OPEN RACK" expands 13 module cards, each with a bypass switch and 3–6 controls: PREP, MASK, LAYERS, MACHINE, DRIVE, CRUSH, TONE, MOTION, DYNAMICS, SPACE, STEREO, ARRANGE, MASTER.
     - Save preset.
   - **Output cartridge:**
     - A draggable tile showing the file name, duration, BPM/key and a mini waveform.
     - Actions: EXPORT, REVEAL, ADD TO SETLIST.
2. **VAULT** (library):
   - Rows showing play, the script with a redaction-style reveal, preset, voice, BPM/key/bars, LUFS, date, tags and a star.
   - Filters. Every row is draggable.
   - Multi-select → export to a Rekordbox playlist, or re-render with another preset.
   - Open in Studio.
3. **SETLIST** (batch):
   - Rows of lines, each with its own preset, voice, BPM and bars, plus a status.
   - Paste-many, render all with progress, export a folder plus rekordbox.xml under a playlist name.
4. **VOICES:**
   - Installed voices.
   - An optional "Persona designer": describe a voice → 3 candidates → audition → save. This needs a download, so show its size and the free disk space.
   - Lexicon editor (FVWKS → "Fawkes").
5. **SETTINGS:**
   - Export folder, format, sample rate.
   - Loudness mode and targets.
   - Filename pattern, artist tag.
   - Rekordbox options: hot cue at first word, memory cue at tail, target path root.
   - Audio output.

**States to design.**
- **Startup:** first run / engine starting; model downloading, with progress and free disk.
- **Studio flow:** empty studio (placeholder script "WE ARE GUY FVWKS | EXPECT *US*"); stale while editing; synthesizing; preview rendering; final rendering.
- **Export:** export success toast with a draggable cartridge; Rekordbox XML exported, with import steps.
- **Problems:**
  - Engine offline, with reconnect.
  - TTS or render error.
  - Fit overflow.
  - True-peak warning.
  - Mic permission denied.
  - Low disk (under 3 GB).
  - Batch partial failure.

**Interactions.**
- **Knobs:** vertical drag; Shift for fine control; double-click to reset; scroll; arrow keys; a value tooltip.
- **Rendering:** re-render on release. The waveform dims while stale.
- **Shortcuts:**

  | Key | Action |
  |---|---|
  | Space | Play |
  | ⌘↩ | Final render |
  | ⌘E | Export |
  | `\` | A/B |
  | L | Loop |
  | 1–7 | Presets |
  | ⌘S | Save preset |
  | ? | Shortcut overlay |

- **Accessibility:** AA contrast, visible focus, knobs work as ARIA sliders, and warnings never rely on colour alone.

**Mock data:**
- **Voices:** Fenrir (US male), Michael (US male), Puck (US male), George (UK male), Heart (US female).
- **Numbers:** 140 BPM, A minor / 8A, 4 bars, −7.0 LUFS, −1.0 dBTP, 6.86 s.
- **File:** `GUYFVWKS_PACT_we-are-guy-fvwks_140bpm_4bar_Am_wet_v01.aiff`.

**Deliverables:**
1. Two direction explorations of Studio.
2. Every screen and state above in the chosen direction.
3. A component sheet with states. Use these names:
   - Layout: AppShell, TopBar, EngineStatus, TempoField, KeyPicker, BarsPicker, SourceTabs.
   - Source: ScriptEditor, VoicePicker, Recorder, ImportDropzone.
   - Signal: SignalView, BarGrid, FitIndicator, LoudnessMeter, MaskBadge.
   - Rack: PresetStrip, MacroKnob, Knob, Fader, Switch, Segmented, ModuleCard, RackPanel.
   - Output and tables: Cartridge, ExportSheet, VaultTable, SetlistTable.
   - Voices: PersonaDesigner, ModelCard, LexiconEditor.
   - Feedback: Toast, ProgressOverlay, EmptyState, ErrorState.
4. **Design tokens as CSS variables**: colour, type scale, spacing, radii, shadows/glows, motion durations and easings.
5. A clickable prototype of the core loop.
6. **Handoff to Claude Code** targeting **React + TypeScript + Vite inside Electron**, with CSS variables and CSS Modules. Data fields should follow `contracts/openapi.yaml`.

**Handing the design back:** in Claude Design choose Export → Handoff to Claude Code and download the zip. Give it
(or its handoff prompt) to me. I'll unzip it into S4's `app/design/` and tell S4 to start Phase 2. S4 builds
unstyled screens with these exact component names in the meantime, so keep the names stable.

