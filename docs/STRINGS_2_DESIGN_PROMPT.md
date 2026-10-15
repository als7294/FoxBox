# Claude Design prompt: FoxBox 2.0 (STRINGS)

**Already pasted the first version?** Paste the "Addendum" at the very bottom as a follow-up message instead.

**How to use it:**
1. Paste everything below the line into Claude Design.
2. Attach the fox mark, the only brand asset that carries over: `app/design/brand/foxbox-mark.svg` and `app/design/brand/foxbox-icon-1024.png`. Don't attach old screens; the old dark look is retired.
3. When it's done, choose Export → **Handoff to Claude Code**, and give the zip to the PM session.

---

**Product.** FoxBox 2.0 is a macOS app (Electron) that turns your webcam into an instrument. Hold your hands up and strings of light stretch between matching fingertips, drawn over the live camera. Your hands play them.

It has two modes, joined by one switch:
- **PLAY** (primary; the app opens here): make sounds with your hands. No song, no beat, no tempo. Just the instrument.
- **REMIX** (secondary): load a song, then remix it live with hand shapes that lock to its beat.

**PLAY and REMIX must feel like two different apps**: their own layout, colour treatment, type moments and stage look. They share only the switch, the settings sheet and the fox mark. Switching is a whole-screen change with a short, deliberate transition.

**Who and where.**
- A bass-music producer and DJ, on a MacBook Pro 14".
- Design at **1512×982**; **1280×800** is the minimum and must keep every primary action visible.
- It's played from about a metre away with both hands in the air, so the screen is glanced at mid-performance. Big, legible and calm beats dense.
- Mouse and keyboard for setup; hands for playing.

**Visual direction, in the user's own words:** "less dark tech, more cream white / gradient orange, big and modern, kinda Japanese spiritual fox style." Also: "UI and fonts can and should be modernized."
- **Explore 3 genuinely different directions on PLAY first**, and let the user pick before designing everything else.
- **Already rejected, so don't repeat them:**
  - the old dark "tech console": near-black panels, monospace data, scanlines, LED meters;
  - four in-house attempts the user disliked:
    - washi paper with a vermilion torii gradient and a mon crest;
    - blurred foxfire orbs with pill-shaped everything;
    - a poster layout with a vermilion side band, big vertical Mincho kanji and a torii gate framing the camera;
    - near-white "zen" with hairlines and one sunset circle.
  - Interpret the brief freshly. Atmosphere, light, material and motion matter more than literal shrine props.
- Japanese text only if it's real and correct, never decorative fake kanji. Respectful, no caricature.
- Fonts must be OFL (they ship inside the app).
- Keep the fox mark (attached).

**The camera rule.** The live camera is always on and is always the hero in both modes. Effects on it are subtle overlays. Nothing replaces it or blacks it out.

**FRAMES are the hero moment.** When the hands make a frame (REMIX and PLAY alike), the inside of the frame shows the **last 4 beats looping**, video and sound, beat-locked (the beat is detected automatically: the song's grid in REMIX, your plucking tempo in PLAY), through the current **frame style** (THERMAL, X-RAY, HALFTONE, PRISM, KALEIDO, DATAMOSH…). **Pinching while framed changes the style and its paired audio effect.** **Flipping the frame over** (turning it ~180°) switches to the style's **flip side**: a quick card-flip of the pane onto a clearly contrasting partner style and audio effect (e.g. THERMAL ↔ ICE), with the loop playing reversed. Flipping back returns to the front. Show the side on the edge (e.g. "ICE · flip side ⟲"). The pane matches the hands' frame exactly, with tilt and depth; a lit edge draws itself, then the loop blooms in, with the style's name on the edge and a "pinch to change" hint at first; release shatters it fast and tight (~120–150 ms). The camera stays clean outside the frame; inside it can be bold. Design entrance, looping, restyle and release states, plus `--frame-*` tokens.

**The strings are drawn live by the app's WebGL renderer, not by the UI.** Design their look as tokens rather than images:
- string colour per state (idle, plucked, cut, frozen) and line weight;
- glow, the pluck flash, and the note-label style;
- PLAY's strings and REMIX's strings should differ.

## PLAY
- **Stage:**
  - **The playing pose:** both hands curved into a C, facing each other (like holding a ball between them), with 5 strings joining matching fingertips;
  - **Each hand's HEIGHT picks its note** on a **note ladder** shown beside the stage (the scale's notes, in key, each hand's current note lit). Curl ANY finger to pluck that hand's note, so two hands can play two notes. A SPREAD option in Settings picks the note by the distance between the hands instead;
  - a plucked string flashes softly, and the note shows at the hand;
  - **a note trail** shows the last ~8 notes you played, so you can see and repeat a melody;
  - **MELODY presets: OFF / FOLLOW / FIT.**
    - FOLLOW: each pluck plays the preset melody's NEXT note (you supply the rhythm), and hand height shifts it an octave.
    - FIT: hand height picks notes, but they snap to the notes the preset allows at that point in its phrase.
    - A preset picker (~6 named, original melodies), a 🎲 ROLL button for a new random melody in your key (rule-based, not AI), and "back to the start".
    - The note ladder lights the NEXT note (FOLLOW) or the allowed notes (FIT).
    - OFF = free notes by hand height;
  - coach text when no hands are seen: "Curve your hands into a C, facing each other";
  - a live readout of the sound, key and the note just played (e.g. "808 · C# minor · E2").
- **SOUND:**
  - BASS: 808, REESE, GROWL, WOBBLE;
  - MELODY: PLUCK, LEAD, KEYS.
- **STYLE:** PLUCK or FLOW.
- **KEY + SCALE:** minor pentatonic by default. **OCTAVE:** − and +.
- **A gesture legend** that lights up whatever your hands are doing right now:
  - **PLUCK style:** move a hand up or down to pick its note · curl any finger to play it, and keep it curled to hold (on sounds that sustain) · twist your wrists to bend the note · shake for vibrato · OCTAVE −/+ or point up/down for the octave;
  - **FLOW style:** right-hand height sets the pitch · spread your hands to open the sound · a right-hand fist mutes. In FLOW, the shapes below are made with the LEFT hand;
  - **Shapes, in both styles:**
    - fist DRIVE · pinch WOBBLE (raise it to go faster);
    - peace ECHO · horns SPACE · point up or down for octave ±1;
    - **frame LOOP**: make a frame to loop the last 4 beats (picture and sound) inside it, and pinch while framed to change its style and audio effect. Show the frame's style and that it's looping.
- **RECORD:** records a WAV take of what you play and shows the running time. The finished take becomes a chip you can drag straight into Ableton or Finder; also show it in Finder. Show the last few takes.
- **SEND TO OUTPUT:** opens a second, picture-only window for a projector or stream.
- **FACE HIDING:** an optional switch, off by default.

## REMIX
- **Stage:** the same live camera. The strings now stand for the song's bands: SUB · LOW · MID · HIGH-MID · HIGH. Fold a finger to cut its band.
- **Song block:**
  - drop a track (WAV, AIFF, FLAC, MP3, M4A) or press **Try the test beat**;
  - title, BPM and key; ▶/❚❚ (▶ starts two bars before the drop);
  - **SECTION TIMELINE:** section chips (INTRO · BUILD · DROP 1 · BREAK · DROP 2 · OUTRO) over a mini waveform with the playhead. Click or drag to jump (it lands on the bar); ←/→ moves by section;
  - stems status: splitting into DRUMS · BASS · VOCALS · OTHER, with progress.
- **The first stem split** shows an inline notice before a one-time 84 MB download: "The stem splitter's weights are Meta's (Demucs), licensed for scientific use only." The buttons are Continue and Not now. It sits inline, never in a modal.
- **BEAT FX:** hold a shape and its effect plays, locked to the beat. Raise the hand for more depth; two hands play two effects.
  - fist TEAROUT · peace RIDDIM CHOPS · pinch WOBBLE · horns HALFTIME;
  - point down SUB DROP · point up BUILD ROLL (let go: the DROP);
  - live depth and beat indicators.
- **Strings:** stretch them for tension (slack builds dark, taut opens up) · tilt to slide the 808 · shake for vibrato · fold a finger to cut a band.
- **GLASS:** frame your hands and the song's last 4 beats loop inside the frame (picture and sound, on the song's beat) through a world: THERMAL, X-RAY, HALFTONE, PRISM, KALEIDO, DATAMOSH, each with its own audio effect. Pinch while framed to change the world. Let go and it shatters back to the live song.
- **RECORD:** a video (camera + strings + audio) or audio only (WAV). **SEND TO OUTPUT** as in PLAY.
- **Stem meters:** DRUMS · BASS · VOCALS · OTHER.

## REMIX: the LIBRARY WHEEL
A gesture track browser over the live camera, opened by holding the shaka sign 🤙 (and closed the same way, or with Esc).
- **The look:** a big 3D ring of thin cover cards fanned around a hollow centre, in perspective. Each card's title and index number radiate outward on thin lines, and a pointer line shows the current angle in degrees. A light, airy ring; the camera stays visible behind it.
- **The right index finger is a dial:** its angle spins the ring, and the selected card snaps to the pointer.
- **Closing the left hand pulls the selected card out,** big, toward you, and a preview plays. Hold the full grab for ~0.8 s to load it into REMIX (a fill ring shows the hold); open the hand to put it back.
- **A visible LIBRARY button** in REMIX (and the key L) also opens it, for mouse users.
- **A small source panel:** Music folder / Rekordbox / Serato, plus a playlist or crate, and type-to-search. The mouse works too: scroll to spin, click to preview, double-click to load.
- **States:** no library yet (add a folder, or point to your rekordbox.xml export), scanning, a huge library, a track with no artwork, a preview playing, loading.
- **Components:** LibraryWheel, WheelCard, WheelPointer, LibrarySources, plus `--wheel-*` tokens.

## GUIDE: the tutorial
A premium, motion-animated, popup-style step flow over the live app. It is the one place where pop-ups are wanted.
- **When it runs:** on first launch, from a GUIDE link at any time, and REMIX's part the first time you open REMIX.
- **Every step is interactive ("now you try"):** a short title, one line of copy, an animated hand-pose illustration, progress dots, and Back / Next / Skip. The step celebrates when the camera sees you do it.
- **PLAY steps:**
  1. Curve your hands into a C, facing each other (the strings appear).
  2. Fold a finger (a note plays).
  3. Pick a sound (the picker, or keys 1–7).
  4. Twist to bend.
  5. Shake for vibrato; point up or down for the octave.
  6. Pinch for wobble.
  7. Make a frame to loop the last 4 beats; pinch to change the effect.
  8. Try FLOW.
  9. Pick a melody, then pluck to play it (🎲 for a new one).
  10. Record a take, then drag it into Ableton or Finder.
  11. Send to output (a projector or stream).
- **REMIX steps:**
  1. Load a track or the test beat.
  2. Hold a fist (TEAROUT).
  3. Fold a finger to cut a band.
  4. Jump to the drop.
  5. Frame for GLASS (the last 4 beats loop); pinch to change the world.
  6. Hold the shaka 🤙 for your library.

- **Behaviour that shapes the design:**
  - "Now you try" never blocks: Next is always live, and a success auto-advances after about 1.2 s.
  - Each step's demo plays the real sound quietly, and ducks when you play.
  - Skip or Esc remembers the step; GUIDE then offers "Continue from step n".
  - While the camera is off or refused, the GUIDE waits with its own state.
  - Focus is trapped in the card and returns on close.
  - Reduced motion: the demo shows the start and end poses with an arrow, plus a "play the demo" button.

## Other screens
- **WHAT'S NEW 2.0:** shown once after the update.
  - "FoxBox is now an instrument for your hands";
  - a short 16:9 film slot;
  - "Looking for STUDIO, VISUALS or MASKS? They live on in FoxBox 1.5.5", with a link.
- **SETTINGS:** a side sheet on ⌘,, not a page and not a modal. Camera, audio output, the clip watermark, engine status, updates (version, check now), and credits and licences (including the Demucs notice).
- **Start-up:** the app opens straight into PLAY with the camera, and the first sound is possible within 10 seconds. The audio engine for REMIX warms up in the background; only loading a song waits for it ("Getting REMIX ready…").
- **The output window:** the picture only, full screen.

## States to design
- **PLAY:**
  - camera permission needed (how to allow it, TRY AGAIN) · camera busy in another app · camera starting;
  - no hands (the coach) · one hand only · the room too dark to track;
  - playing · a frame looping · FLOW style;
  - recording · take saved · no takes yet;
  - the audio output disconnected (it falls back to the built-in speakers).
- **REMIX:**
  - empty (drop a track / try the test beat);
  - analysing a song · the first-split notice and download · splitting stems;
  - playing with a beat FX held · GLASS open;
  - nothing loaded (▶ disabled, "Drop a track or try the test beat");
  - stems failed (Try again / Play without stems);
  - engine not ready yet · a bad file ("Can't read notes.txt: use WAV, AIFF, FLAC, MP3 or M4A").
- **GUIDE:** every step, its success state, skip, resume, and waiting for the camera.
- **The mode switch while things are running:** leaving PLAY releases held notes, leaving REMIX pauses on the bar, and a running RECORD stops and saves ("Take 3 saved").

## Rules
- Text is never below 11 px, and bigger is welcome: it's read from a metre away.
- AA contrast, including on cream and over the camera.
- Hit areas ≥ 24 px, a visible focus state, and a `prefers-reduced-motion` version of every animation.
- No repeated page titles or headers. No modals except the GUIDE.
- Show file names, never full paths.
- **Keyboard:**

  | Key | Action |
  |---|---|
  | Space | Play/pause (REMIX) |
  | R | Record |
  | ←/→ | Previous/next section in REMIX; Back/Next inside the GUIDE |
  | 1–7 | Sounds (PLAY) |
  | D | Roll a new melody (PLAY) |
  | L | Library (REMIX) |
  | ↑/↓ | Octave (PLAY) |
  | S | PLUCK/FLOW |
  | M | PLAY/REMIX |
  | G | GUIDE |
  | Esc | Close the GUIDE or the settings sheet |
  | ⌘, | Settings |
  | ? | Shortcuts |

  Single-letter keys are ignored while typing in a field.

## Component names (keep these, so the handoff maps to code)
- **Shell:** AppShell, ModeSwitch, SettingsSheet, WhatsNew, OutputWindow.
- **Shared:** CameraStage, CoachText, RecordButton, TakeChip, OutputButton, FaceHidingToggle.
- **PLAY:** PlayPage, SoundPicker, StyleSwitch, KeyPicker, OctaveStepper, GestureLegend, LiveReadout, FrameBadge, NoteLadder, NoteTrail, MelodyPicker.
- **REMIX:** RemixPage, SongBlock, SectionTimeline, StemsStatus, StemsNotice, BeatFxSheet, StemMeters, GlassBadge.
- **GUIDE:** Guide, GuideStep, HandPose.

## Deliverables
1. Three PLAY directions; the user picks one.
2. In the chosen direction: PLAY, REMIX, GUIDE, WHAT'S NEW, SETTINGS and the output window, with every state above, at 1512×982 and 1280×800.
3. A component sheet with states.
4. **Design tokens as CSS variables:** colour, type scale, spacing, radii, shadows/glows, motion durations and easings, plus the string tokens.
5. Motion specs for the mode switch, the GUIDE steps and a pluck.
6. A clickable prototype of the core loop: open → raise hands → pluck → twist → switch to REMIX → try the test beat → hold a fist.
7. A handoff to Claude Code targeting **React + TypeScript + Vite inside Electron**, using CSS variables and CSS Modules.

---

## Addendum (only if you pasted the first version)
Add these to the FoxBox 2.0 brief:
- **GUIDE:**
  - **PLAY steps,** in order: raise hands · fold a finger · pick a sound (1–7) · twist · shake and octave · pinch · frame · FLOW · record and drag the take into Ableton/Finder · send to output.
  - **"Now you try" never blocks:** Next is always live, and a success auto-advances after ~1.2 s.
  - **Demos play the real sound quietly** and duck when you play.
  - **Skip remembers the step,** and GUIDE offers "Continue from step n".
  - **It waits while the camera is off.**
  - **Focus is trapped in the card.**
  - **Reduced motion** shows start and end poses with an arrow.
- **More states:**
  - **PLAY:** camera busy in another app · one hand only · too dark to track · no takes yet · audio output disconnected.
  - **REMIX:** nothing loaded · stems failed (Try again / Play without stems).
  - **Mode switch:** releases notes, pauses REMIX on the bar, and saves a running take ("Take 3 saved").
- **FLOW:** a right-hand fist mutes; in FLOW the shapes (fist DRIVE etc.) are made with the left hand.
- **REMIX library wheel:** hold the shaka 🤙 to open a 3D ring of your tracks (folder, Rekordbox XML, Serato). The right index finger dials, a left-hand grab pulls a card out and previews it, and holding the grab loads it. Design the ring, the source panel and its states (empty, scanning, no artwork, preview, loading); components LibraryWheel, WheelCard, WheelPointer, LibrarySources; tokens `--wheel-*`.
- **Keys:**
  - ←/→ are Back/Next inside the GUIDE; ↑/↓ change the octave; S switches PLUCK/FLOW; Esc closes the GUIDE or settings.
  - Single-letter keys are ignored while typing in a field.

---

## Addendum 3 (paste this if you already sent the brief; it replaces Addendum 2's PLAY notes)
Update the FoxBox 2.0 design (PLAY, frames and REMIX's library):
- **The playing pose is C-shaped hands facing each other** (like holding a ball). The coach and GUIDE step 1 say "Curve your hands into a C, facing each other".
- **Notes:**
  - each hand's HEIGHT picks its note on a **note ladder** beside the stage (in key, each hand's note lit);
  - curl ANY finger to pluck it; two hands can play two notes; hold to sustain;
  - a SPREAD option in Settings picks by the distance between the hands;
  - keep the **note trail** (the last ~8 notes);
  - no per-finger notes and no keyboard strip.
- **MELODY presets: OFF / FOLLOW / FIT** (no looper).
  - FOLLOW: each pluck plays the preset's next note, and height shifts it an octave.
  - FIT: height notes snap to the preset's allowed notes.
  - A preset picker, 🎲 ROLL (a new random melody in your key, rule-based), "back to the start", and the ladder lighting the next or allowed notes.
  - GUIDE PLAY step: "Pick a melody, then pluck to play it".
  - Octave is OCTAVE −/+ or point up/down, never hand height.
- **FRAMES:** inside a frame, the **last 4 beats loop** (picture and sound, beat auto-detected: the song's grid in REMIX, your plucking tempo in PLAY) through a frame style; **pinch while framed to change the style and its audio effect.** **Flipping the frame over** (turning it ~180°) switches to the style's **flip side**: a quick card-flip of the pane onto a clearly contrasting partner style and audio effect (e.g. THERMAL ↔ ICE), with the loop playing reversed. Flipping back returns to the front. Show the side on the edge (e.g. "ICE · flip side ⟲"). The pane matches the hands' frame exactly (tilt, depth), with a lit-edge entrance, the style name on the edge, a "pinch to change" hint, and a very quick, tight shatter on release (~120–150 ms: a crack, a few sharp shards, the live picture back instantly). This replaces FREEZE's drone in PLAY. Plus `--frame-*` tokens.
- **REMIX library wheel** (new): holding the 🤙 shaka, the LIBRARY button or L opens a big 3D ring of your tracks over the camera.
  - It's thin cover cards fanned round a hollow centre, with titles and index numbers radiating out and a pointer with the angle in degrees.
  - The right index finger is a dial that spins the ring. Closing the left hand pulls the selected card out big and previews it; holding the grab ~0.8 s (a fill ring) loads it into REMIX.
  - A small source panel: Music folder / Rekordbox (XML export) / Serato, plus a playlist or crate, and search.
  - States: no library yet, scanning, no artwork, preview, loading, a missing file.
  - GUIDE REMIX step 6: "Hold the shaka for your library". Components LibraryWheel, WheelCard, WheelPointer, LibrarySources; `--wheel-*` tokens.
- **Keys added:** D rolls a melody (PLAY), L opens the library (REMIX), ↑/↓ change the octave.

## Addendum 2 (paste this if you already sent the brief)
Update the FoxBox 2.0 PLAY design:
- **The default playing pose is ALL FINGERS POINTING IN at each other** (both hands up, fingertips facing, strings between them).
  - The coach says "Point your fingers at each other".
  - GUIDE step 1 and its hand-pose illustration show this pose.
- **Easier melodies:**
  - the notes run left to right like a keyboard across all 10 fingertips (left pinky lowest → right pinky highest);
  - big, always-readable note labels at the fingertips;
  - a slim **note strip** of the 10 notes that lights as you play;
  - a **note trail** of the last ~8 notes;
  - keeping a finger folded holds its note on sustaining sounds.
- **REMIX library wheel** (if you haven't added it yet): see the "REMIX: the LIBRARY WHEEL" section.
- **FRAMES:** inside a frame, the **last 4 beats loop** (picture and sound, beat auto-detected: the song's grid in REMIX, your plucking tempo in PLAY) through a frame style; **pinch while framed to change the style and its audio effect.** **Flipping the frame over** (turning it ~180°) switches to the style's **flip side**: a quick card-flip of the pane onto a clearly contrasting partner style and audio effect (e.g. THERMAL ↔ ICE), with the loop playing reversed. Flipping back returns to the front. Show the side on the edge (e.g. "ICE · flip side ⟲"). The pane matches the hands' frame exactly (tilt, depth), with a lit-edge entrance, the style name on the edge, a "pinch to change" hint, and a very quick, tight shatter on release (~120–150 ms: a crack, a few sharp shards, the live picture back instantly). This replaces FREEZE's drone in PLAY. Plus `--frame-*` tokens.
- **REMIX:** a visible LIBRARY button (and the key L) also opens the wheel. GUIDE adds REMIX step 6: "Hold the shaka for your library".
