# Handoff: FoxBox 2.0 (SAUCE / REMIX)

## Overview
FoxBox 2.0 is a macOS (Electron) app that turns the webcam into an instrument. Both hands are held up in a **C shape facing each other**; strings of light stretch between matching fingertips over the live camera. Two modes share one notch switch:
- **SAUCE** (primary, opens here): make sounds with your hands.
- **REMIX**: load a song and remix it live with hand shapes locked to its beat.

This bundle covers: launch screen, SAUCE, REMIX, notch "Island" mode switch, dock + popovers, the Board (knobs/faders), the frame loop pane, the library wheel, settings, toasts/badges, and the onboarding video.

Target: **React + TypeScript + Vite inside Electron, CSS variables + CSS Modules.**

## About the design files
The files in this bundle are **design references built in HTML** — interactive prototypes showing the intended look and behaviour, not production code. Recreate them in the app's codebase with its own patterns. The camera, hand tracking, audio and track data are simulated in the prototype; the strings, visualizers, waveform and library wheel are drawn to `<canvas>` here, but in the real app the strings come from the WebGL renderer (see string tokens).

Open `FoxBox Island.dc.html` in a browser (it needs `support.js` beside it). Tweaks in the host panel: `showLaunch`, `startMode`, `stageState` (Playing / No hands / One hand), `wheelStyle` (Halo / Ring), `libState` (Ready / No library / Scanning / Missing file), `demoHands`, `boardOpen`.

## Fidelity
**High-fidelity.** Colours, type, radii, spacing, motion timings and copy are final unless noted. Recreate pixel-accurately at **1512×982** (MacBook Pro 14"); **1280×800** must keep every primary action visible (the 840px REMIX dock and library bar need a compact pass — not designed yet).

## Global rules
- Camera is always the hero, full-bleed. The UI collapses into glass chrome; nothing replaces the camera except REMIX with a Visual on (camera hidden, hands still tracked; show "Camera hidden · hands still tracked").
- Only one of these is open at a time: a popover, the Board, the Library wheel, Settings. Opening one closes the others.
- Text ≥ 11px; AA contrast on glass and over the camera; hit areas ≥ 24px; visible focus (`3px solid #F2701F`, offset 2px); every animation has a `prefers-reduced-motion` fallback (cross-fade only).
- No header controls. The only top UI is the notch Island.
- Fonts (OFL): **Geist** 400–800, **Geist Mono** 400–500.

## Screens / views

### 1. Launch (`LaunchScreen`)
Full-window `#0B0806`, ~5s, click to skip.
- Breathing radial glow `rgba(255,77,46,.24)` 1100px, 3s loop.
- Thin ensō ring 520px `inset 0 0 0 1px rgba(255,77,46,.35)`, draws in 2.2s from 0.2s.
- Fox tile 220px springs in (0.3s, `cubic-bezier(.3,1.4,.4,1)`), chevron pops up at 0.9s.
- Wordmark "FoxBox" Geist 800 64px, −0.04em, at 1.0s.
- Progress bar 280×4px, gradient `#FF4D2E→#FFB27A`, fills over 2.6s from 1.2s.
- Status (Geist 500 15px `#B5A798`): "Starting your camera…" (1.3s) → "Warming the audio engine…" (2.2s) → "Ready. Curve your hands into a C." (3.1s, `#F6EFE6`).
- Footer: "2.0 · CLICK TO SKIP" Geist Mono 12px, 0.14em, 40% ink.
- Exit at 4.3s: fade + scale 1.04 over 0.7s.

### 2. Stage (`CameraStage`)
- Full-bleed camera. SAUCE adds a warm under-glow `radial-gradient(60% 50% at 80% 110%, rgba(255,140,50,.35), transparent)`; REMIX adds `linear-gradient(180deg, rgba(255,120,40,.06), rgba(255,90,20,.26))`. Bottom scrim 300px `rgba(15,10,6,.6)→0`.
- Strings: 5, between matching fingertips. SAUCE strings cream with orange glow; a pluck flashes (glow opacity 1→.4 over 0.9s, core 7→3px over 0.5s). REMIX strings are thin white and labelled SUB · LOW · MID · HI-MID · HIGH; a cut band is dashed `4 12` at 40% white with "· CUT".
- Coach (`CoachText`), centred glass pill, Geist 600 36px: "Curve your hands into a C, facing each other" / "Raise your other hand".

### 3. Notch Island (`ModeSwitch`)
Black, hangs from the top centre.
- Collapsed 420×36, radius 0 0 16 16. Left: orange dot + last note (SAUCE), or 4 beat dots + "Bar n" (REMIX), or a blinking red dot + timer while recording. Right: mode label button "SAUCE ⇄" / "REMIX ⇄" (Geist 600 13px, 0.1em, `#FFB27A`) — **one click switches**.
- Clicking the island body expands to 480×168, radius 34 (spring `cubic-bezier(.3,1.2,.4,1)` 0.5s): two pills 68px tall, radius 18, label Geist 800 24px 0.05em. Selected pill `#F2701F` with `#1C1611` ink; other `rgba(255,255,255,.1)`. Each pill has a faint (18%) icon behind the label, clipped by the pill: sound bars (SAUCE), vinyl (REMIX). Footer 12px: "M switches · notes release, the song pauses on the bar".
- Switching: leaving SAUCE releases held notes; leaving REMIX pauses on the bar; a running take stops and saves. Toast e.g. "Notes released · Take 3 saved".

### 4. Dock (`Dock`)
Centred, bottom 28px (360px when the Board is open, 0.5s `--fb-ease-inout`). Width 840px. Padding 8, radius 32, `linear-gradient(180deg, rgba(255,255,255,.07), transparent 40%), rgba(24,18,14,.82)`, blur 30 + saturate 1.8, shadow `0 24px 60px -18px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.14), inset 0 0 0 1px rgba(255,255,255,.08)`.
- Buttons flex 1, 68px, radius 24, label Geist 600 12px 0.04em at 72%, value Geist 700 18px. Active: `#F6EFE6` fill, `#1C1611` ink, `inset 0 1px 0 rgba(255,255,255,.6), 0 6px 18px -6px rgba(0,0,0,.5)`. Pressed: scale .97.
- SAUCE: Sound · Melody · Hands · Visual · Board · Record · Settings. REMIX: Song · Beat FX · Library · Visual · Board · Record · Settings.

### 5. Popovers (`Popover` + content)
Same width as the dock (840px), rise from just above it: closed `translateY(40px) scale(.96)` opacity 0 → open, 0.5s `--fb-ease-inout`. Padding 28, radius 34, gap 18. Background: two tints keyed to the selection + `rgba(28,22,18,.78)`: `radial-gradient(110% 120% at 0 0, rgba(C,.26), transparent 62%), radial-gradient(90% 90% at 100% 100%, rgba(C,.10), transparent 70%)`. Tint C per sound: 808 `242,112,31` · REESE `139,92,246` · GROWL `229,64,43` · WOBBLE `34,195,181` · PLUCK `245,177,61` · LEAD `236,72,153` · KEYS `79,142,247`. REMIX: orange; red while a Beat FX is held.

Shared parts:
- Header: title Geist 700 24px −0.02em; subtitle 14px `#B5A798`; right: controls + key chip (28px, radius 9, Geist Mono 600 12px, `inset 0 0 0 1px rgba(255,255,255,.14)`).
- Section label: Geist 700 12px 0.12em `#B5A798`.
- Tile: radius 18, idle `rgba(255,255,255,.06)` + `inset 0 0 0 1px rgba(255,255,255,.05)`; selected `#F6EFE6`/`#1C1611` + `inset 0 1px 0 #fff, 0 8px 20px -8px rgba(0,0,0,.6)`; pressed scale .97.
- Segmented: track `rgba(255,255,255,.07)` radius 16 pad 4; segment 40px radius 12, Geist 700 14px 0.05em; active `rgba(255,255,255,.16)` + `0 2px 8px rgba(0,0,0,.35)`.

Contents:
- **Sound** (`SoundPicker`, keys 1–7): BASS 808/REESE/GROWL/WOBBLE (4 cols, 64px tiles, Geist 800 19px + key in mono); MELODY PLUCK/LEAD/KEYS; divider; Key picker "C# minor pentatonic ▾" (56px) + Octave stepper (− · OCTAVE n · +; ↑/↓ or point up/down; **never hand height**).
- **Melody** (`MelodyPicker`): header segmented OFF / FOLLOW / FIT, subtitle explains the mode. PRESETS (5 tiles: Night hook, Kitsune, Low rider, Lantern, Rolled) + key chip "D rolls". SEQUENCE strip (8 notes; the next note is orange in FOLLOW). "🎲 Roll a melody" (orange, rule-based, in key) + "Back to the start".
  - FOLLOW: each pluck plays the preset's next note; hand height shifts it ±octave. FIT: hand-height notes snap to the preset's notes.
- **Hands** (`GestureLegend`): header segmented PLUCK / FLOW + "S". GESTURES: 4 cards, each a 60px glyph tile + action (Geist 800 16px) + gesture (13px). SHAPES (left hand in FLOW): 6 cards, 84px glyph, shape + action. **Edit shapes** button → edit panel (`rgba(242,112,31,.07)`, `inset 0 0 0 1px rgba(242,112,31,.45)`, radius 22): action chips show "current" / "on <shape>"; picking a taken action swaps; Reset all. Glyphs are wireframe hands (palm fill 12%, bones 1.8px + 16% 7px underlay, fingertip dots; active fingertips orange).
- **Visual** (`VisualPicker`, V): 6 tiles 100px tall with live previews: Off/Camera, Bars, Halo, Silk, Grain, Scope. Selected ring `0 0 0 3px #F2701F`. SAUCE draws over the camera; in REMIX a visual hides the camera and wraps around the waveform. **Off by default.**
- **Record** (`RecordButton`, R): 76px button (dot 30px → rounded square 22px while recording) + label + 40px timer. TAKES list: 60px rows, drag handle ⋮⋮, file name, duration, "Show in Finder". SAUCE records WAV; REMIX records video + audio.
- **Song** (`SongBlock`): 68px cream play button (Space), title, BPM · key. JUMP TO: section buttons sized by bar length (INTRO 8 · BUILD 16 · DROP 1 24 · BREAK 12 · DROP 2 24 · OUTRO 16), ←/→; lands on the bar; ▶ starts 2 bars before the drop. Stems ready bar (green tint). "Open library · L" / "Try the test beat".
- **Beat FX** (`BeatFxSheet`): 6 hold pads 80px (Fist TEAROUT, Peace RIDDIM CHOPS, Pinch WOBBLE, Horns HALFTIME, Point ↓ SUB DROP, Point ↑ BUILD ROLL) + Edit shapes. BANDS: 5 cut toggles.

### 6. Note pop (`NotePop`)
On every pluck, a glass pill appears just above the plucking fingertip: radius 999, `linear-gradient(180deg, rgba(255,255,255,.16), rgba(255,255,255,.04)), rgba(28,22,18,.42)`, blur 22 + saturate 1.8, `inset 0 1px 0 rgba(255,255,255,.35), inset 0 0 0 .5px rgba(255,255,255,.22), 0 12px 32px -10px rgba(0,0,0,.55)`. Glowing dot `#FF9C5C`, note Geist 600 24px; in FOLLOW a "next E3" hint 12px. Motion 1.6s `cubic-bezier(.22,1,.36,1)`: blur 6→0 + rise in, float 6px, blur out −16px. No note ladder, no keyboard strip, no trail.

### 7. Board (`Board`)
Slides up from the bottom (16px inset, 332px tall, radius 30, `rgba(26,20,16,.8)`), dock rises above it.
- Knob 62px: conic arc 270° from 225°, `#F2701F` value, `rgba(255,255,255,.14)` track; cap 48px `linear-gradient(#4B3F37,#2A221D)` with a 3×13 indicator. Drag vertically (180px = full range), double-click resets. Fader: 6px track, 40×20 cap with an orange line.
- SAUCE: SOURCE (sounds, PLUCK/FLOW, octave, key, FRAME) · TONE (Cutoff, Resonance, Drive, Sub) · SHAPE (Attack, Release, Glide, Bend range) · MOTION (Vibrato, Wobble rate, Echo, Space) · OUTPUT (stereo meter + Volume).
- REMIX: STEMS (Drums/Bass/Vocals/Other: meter, fader, filter knob LP/Off/HP, M/S) · BANDS (5 knobs ±dB + Cut) · BEAT FX (6 hold pads) · MASTER (Tempo, FX depth, volume).

### 8. Frame loop (`FramePane`, `FrameBadge`)
Make a frame with both hands (F in the prototype; **pinch while framed** cycles the style; release shatters). Replaces FREEZE.
- The pane sits exactly in the hands' frame and tilts with them (perspective rotateX/Y ±10°). In the prototype it is fixed at 440×330 with two wireframe L-hands on its corners.
- Inside, the **last 4 beats loop** (picture and sound), with a white sweep line per loop and a brightness pulse per beat. Beat source: REMIX = the song's grid; SAUCE = your plucking tempo.
- Entrance: lit edge draws around (0.45s), world blooms (0.7s from 0.35s), name pill on the edge (SAUCE `#FFB27A`, REMIX `#F2701F`, Geist 800 17px 0.08em + effect name), hint pill "● ● ● ● 4 beats · pinch to change".
- Styles → audio: ECHO TRAIL (Echo) · PRISM (Shimmer) · HALFTONE (Bitcrush) · KALEIDO (Chorus) · DATAMOSH (Glitch) · THERMAL (Warm drive).
- Release: 6 shards fly out, rotate and fade over 0.85s.
- Sound: a "lock" on the beat when framed; a crisp shatter on release.

### 9. Library wheel (`LibraryWheel`, `WheelCard`, `WheelPointer`, `LibrarySources`) — see `screenshots/15-remix-library-wheel.png`
Open: hold 🤙 shaka ~0.5s, the Library button, or L. Close: shaka again, Esc. Beat FX and finger filters pause; the song keeps playing. Only one menu is open at a time.
- **Look (default `Ring`):** an upright **half dome of square record sleeves** fanning up out of the waveform line, like the TouchDesigner reference: 72 square cards (side 220px, inner radius 200, outer 430) arranged on a ring tilted 34°, each blade turned 76° so most read as thin edge-on slivers of cover art; perspective f=1100, D=1500. Everything below the waveform line is clipped. Each card shows its full cover (projective texture map). The selected sleeve stands at the top centre with a white outline.
- **Labels:** titles + 3-digit index numbers radiate outward on thin lines down both sides (Geist 12px / 16px selected).
- **Pointer:** a 2px orange line rises from the waveform to the selected sleeve's inner edge; left of it the dial angle (Geist 600 30px "212°") and "RIGHT INDEX · n / N" (Geist Mono 12px); right of it the selected title, artist and BPM.
- **Open:** the dome rises up out of the waveform (y offset 460px → 0) and spins ~0.6 rad into place as it fades in (open factor eased with smoothstep, ~7/s).
- **Waveform fold:** on open, the glass waveform flattens into a 2px red line `#FF4D2E` with soft glow and a 68px fox disc in the centre; it unfolds on close.
- **Dial:** right index angle (≈140°–280°); a ~140° sweep = one page of ~40 tracks; edge-scroll near the ends. Critically-damped spring (k=140), snaps after 180ms idle. Mouse: scroll/drag spins, click previews, double-click loads, typing searches.
- **Grab:** close the left hand (0→1) to pull the selected sleeve out big (DOM card, full size from 0.7); at full pull a 20s preview from 40% plays, ducking the deck; hold 0.8s (fill ring) to load.
- **Load transition:** the sleeve shrinks onto the waveform line, stretches into a 4px bar across the width (0.95s ease-in-out cubic), and the waveform unfolds from it.
- **Covers:** embedded artwork from tags; neutral card with initials when missing. (Prototype covers are generated.)
- **Source bar** (top centre, glass): Search · All / Music folder / Rekordbox / Serato with counts · playlists or crates · "n of N".
- **States:** No library ("Add your music" + Choose a folder… / Rekordbox XML… / Use Serato), Scanning (progress), no artwork, preview, loading, missing file ("Can't find ember-ritual.flac" + Locate… / Remove from list).
- **Alternative (`wheelStyle: Halo`):** a flat half-dome of ~9 record sleeves on a gentle arc; clicking one fades the rest, brings it to the centre at 330px with its vinyl sliding 60% out and spinning, the title types in above (Geist 800, blinking orange caret), chips for artist/BPM/key/source below, white preview ring and orange load ring.
- **Engine:** only reads user-picked folders or Serato's standard folder; tracks by id; no network; 10k+ tracks open in < 1s after the first scan.

### 9b. Paused waveform
When REMIX is paused, the glass waveform flattens (ease ~0.25s) into the same thin red line, and a small geometric fox (the fox mark as its head, a block body, four stepping legs, a wagging tail with a cream tip) walks back and forth along it, turning at the ends. "PAUSED · SPACE TO PLAY" (Geist Mono 12px) sits under the line. Section labels and the playhead hide. Pressing play unfolds the waveform again.

### 10. Settings (`SettingsSheet`, ⌘, or the dock's Settings)
Centred 1200×780 window, radius 40, `rgba(22,17,13,.94)` + top sheen, scrim `rgba(8,5,3,.55)` + blur 18. Enters from `translateY(40px) scale(.96)`, 0.55s `cubic-bezier(.2,.9,.25,1)`. Left nav 280px (Geist 800 34px "Settings"; 52px items): Playing · Output & recording · Devices & engine · Guide & shortcuts · About. Rows 56px, radius 18, `rgba(255,255,255,.05)`, Geist 600 17px; toggles 52×32 (on `#F2701F`).
- Playing: NOTE PICKING HEIGHT / SPREAD (SPREAD: hands close = low, far apart = high); Face hiding; Left-handed layout; Pluck sensitivity.
- Output & recording: Send to output (opens a picture-only window); Clip watermark; Takes folder.
- Devices & engine: camera, audio output (falls back to built-in speakers on disconnect), latency, engine/tracking status, REMIX stems.
- Guide & shortcuts: SAUCE guide ("Continue from step n"), REMIX guide, shortcuts, What's new.
- About: version, Check now, credits incl. "The stem splitter's weights are Meta's (Demucs), licensed for scientific use only."

### 11. Toasts and badges
Glass pill under the notch (Geist 600 15px), 2.6s. Badge for a held Beat FX: "TEAROUT · Depth 70% · locked to the beat".

## Keyboard
Space play/pause (REMIX) · R record · ←/→ section (REMIX) or track (wheel) · 1–7 sounds · ↑/↓ octave · S PLUCK/FLOW · D roll melody (SAUCE) · L library (REMIX) · F frame · V next visual · B board · M SAUCE/REMIX · G guide · ⌘, settings · Esc closes (settings → frame → wheel → popover/board). Single-letter keys are ignored while typing in a field.

## State (suggested)
`mode`, `pop`, `board`, `settings`, `setTab`, `lib`, `open` (island), `sound`, `style`, `oct`, `melMode`, `preset`, `melStep`, `rolled`, `pickBy`, `frame {style, released}`, `rec`, `recS`, `takes[]`, `playing`, `bar`, `beat`, `fxHeld`, `cuts[5]`, `mute[4]`, `solo[4]`, `visS`, `visR`, `mapS{}`, `mapR{}` (shape → action), `editMap`, `editShape`, `knobs{}`, library `src`, `crate`, `q`, `sel`, `grab`, `loadP`.

## Design tokens
See `foxbox-tokens.css` (colour, type, spacing, radii, blur/shadow, motion, `--string-*`, `--frame-*`, `--wheel-*`). Key values: ink `#F6EFE6`, secondary `#B5A798`, accent `#F2701F`, accent soft `#FFB27A`, fox `#FF4D2E`, background `#15100D`, glass `rgba(28,22,18,.74)`, hairline `rgba(255,255,255,.12)`.

## Onboarding video
`FoxBox Onboarding.dc.html` (+ `foxbox-onboarding.jsx`, `animations-v3.jsx`): ~56s, 1920×1080, kinetic type with orange slash wipes. Welcome (fox assembles) → 01 Raise your hands → 02 Curve your hands into a C → 03 Hand height picks the note → 04 Curl any finger to pluck (glass note pops at the fingertip) → 05 Hold to sustain → 06 Make a shape (DRIVE, WOBBLE; frame loops the last 4 beats, pinch changes style, release shatters) → 07 Switch to REMIX → 08 Frame a window (THERMAL, locks on the beat, shatters) → Let's play. Use as the motion reference for the GUIDE steps.

## Assets
- Fox mark: rebuild from the supplied `foxbox-mark.svg` / `foxbox-icon-1024.png`; the prototype traces it as polygons (1024 grid).
- Album art in the prototype is generated gradients; use embedded artwork from tags, neutral card when missing.
- No other images; all icons are inline SVG.

## Screenshots
All in `screenshots/` (1512×982 frame, scaled):
- `01-launch.png` — launch screen
- `02-sauce-stage.png` — SAUCE, camera + strings + dock
- `03-sauce-sound.png` · `04-sauce-melody.png` · `05-sauce-hands.png` · `06-sauce-visual.png` · `07-sauce-record.png` — SAUCE popovers
- `08-sauce-board.png` — SAUCE Board
- `09-settings.png` — Settings
- `10-sauce-frame-loop.png` — frame loop pane
- `11-remix-stage.png` — REMIX stage with glass waveform
- `12-remix-song.png` · `13-remix-beatfx.png` — REMIX popovers
- `14-remix-board.png` — REMIX Board
- `15-remix-library-wheel.png` — library wheel
- `16-remix-paused-fox.png` — paused waveform with the walking fox
Canvas layers (strings, visuals, waveform, wheel) are captured as stills; open the HTML prototype to see them animate.

## Recent additions
- **Board:** header with title + context, presets (SAUCE: Init / Warm / Wide / Dirty; REMIX: Clean / Club / Tearout / Lo-fi), Reset all, ×. Sections are cards (radius 24, `rgba(255,255,255,.035)`). Knobs 60px with a domed cap, glowing pointer and an arc glow that grows with value; knobs a hand also drives carry an orange tag (Cutoff "Spread", Vibrato "Shake", Bend "Twist", Wobble "Pinch", Drive "Fist", Echo "Peace", Space "Horns", Bands "Fold", FX depth "Hand height"). Faders have tick marks and a gradient fill. SAUCE source card has a live mini spectrum. REMIX stem strips have colour stripes (Drums `#FF8A3D`, Bass `#E5402B`, Vocals `#F5B13D`, Other `#8B5CF6`).
- **Every panel** has a 30px round × top-right.
- **Dock:** a very slow orange holographic tint (48s drift, 14s edge pulse). **Notch:** a small soft holographic glow under it (60s drift, 16s breathe). Notch mode pills: the *non-selected* mode is orange; hover lifts 1px, scales 1.035 and sweeps a shine.
- **Hands popover:** two columns — PLAY gestures (4 rows with glyph, action, gesture, LIVE tag) and SHAPES (3×2 cards with glyph and action pill); Edit shapes panel below.
- **Paused REMIX:** the waveform becomes a red line and a fox drawn as part of that waveform line (rippling outline, waveform-bar legs and trail) walks along it.
- **Mode transition:** intentionally left for you to design; the prototype switches instantly (a parked draft can be enabled with the `modeTransition` tweak).

## Files
- `FoxBox Island.dc.html` — the full interactive app prototype (SAUCE, REMIX, all overlays).
- `FoxBox Onboarding.dc.html`, `foxbox-onboarding.jsx`, `animations-v3.jsx` — onboarding video.
- `foxbox-tokens.css` — design tokens as CSS variables.
- `support.js` — prototype runtime (needed only to open the HTML files).
