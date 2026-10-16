# FoxBox 2.0: STRINGS UX

FoxBox 2.0 is STRINGS only, in two modes that share a window:
- **SAUCE** (was PLAY; internal code names may stay) makes sounds with your hands: an air instrument, with no song involved.
- **REMIX** plays a song through your hands. It is the 1.5.5 STRINGS.

This document holds the behaviour, flows, copy and states that the build is audited against.

**The look is the Claude Design handoff:** `app/design/foxbox-2/` (README.md is its spec, plus `foxbox-tokens.css`, the prototypes and screenshots). `docs/FOXBOX2_HANDOFF_PLAN.md` holds the owners. The user's ruling is **design for looks, chat for behaviour**:
- The design wins on layout, colours, type, radii, motion, copy and structure.
- Chat decisions win on behaviour where the two differ. They're marked *(chat)* below.
- The compact layout for windows under 1440 × 900 is `docs/FOXBOX2_COMPACT.md`.
- The rejected in-house mocks live on `help/s5-2.0` (`app/design/strings-2/`) for reference only.

## Rules for both modes
- **No modals,** with two exceptions:
  - the GUIDE (the user's explicit choice);
  - the Settings window, which the design puts over a scrim.
  - Popovers, the Board, the library wheel and every message stay inline. Only one of a popover, the Board, the library wheel or Settings is open at a time; opening one closes the others.
- **The camera is always on, and the hero:** full-bleed, with the UI in glass chrome around it.
  - **The one exception:** in REMIX with a Visual on, the visual hides the camera. The hands are still tracked, and a chip says "Camera hidden · hands still tracked".
- **Face hiding is an optional extra, off by default** (Settings → Playing, or the dock's ··· menu).
  - RECORD and OUTPUT never ask first.
  - No screen shows a face-hidden tag unless face hiding is on.
- **Text, contrast and targets:**
  - text is never below 11 px;
  - contrast is AA on glass and over the camera;
  - every target is at least 24 × 24 px;
  - focus is always visible: `3px solid #F2701F`, offset 2 px.
- **Motion and flashes:**
  - at most 3 flashes a second;
  - every animation has a `prefers-reduced-motion` fallback, a cross-fade only;
  - the strings still move with the hands, because that's the instrument.
- **No file paths on screen,** only file names.
- **Words:** no AI, "generate", "smart" or "learning" wording.
- **Fonts:** Geist and Geist Mono (OFL), bundled.

## The mode switch: the notch Island
The Island (ModeSwitch) hangs from the top centre. It's the only top UI: there are no header controls.

**Collapsed (420 × 36):**
- On the left:
  - SAUCE: an orange dot and the last note;
  - REMIX: 4 beat dots and "Bar n";
  - while recording: a blinking red dot and the timer.
- On the right, "SAUCE ⇄" / "REMIX ⇄". **One click switches.**

**Expanded:**
- Clicking the Island's body opens two big mode pills, with the footer "M switches · notes release, the song pauses on the bar".

**Switching:**
- **Key:** M toggles SAUCE ⇄ REMIX. It's ignored while typing in a field.
- **The app always opens in SAUCE,** after the launch screen.
- **Audio never overlaps.**
  - Leaving SAUCE releases held notes, with the toast "Notes released".
  - Leaving REMIX pauses on the bar, with the toast "REMIX paused on bar n". Coming back resumes there, paused.
- **RECORD:** a running take stops and saves first, and the toast adds it: "Notes released · Take 3 saved".
- **What stays:** the camera, tracking, face hiding, the audio output, OUTPUT and updates.
- **The transition** is left to S4 (the prototype switches instantly). Until it's designed, it's a 200 ms cross-fade.

## First run: the first sound in under 10 seconds, then the GUIDE
SAUCE never waits for the REMIX engine and never downloads anything.

| t | What happens | What the screen says |
|---|---|---|
| 0 s | The launch screen (LaunchScreen) *(the user)*: their looping video plays full-bleed. It's 10 s and seamless, a fox in a night-time producer's bedroom. Under reduced motion, its first frame is a still. The UI sits in a right-hand column: the fox mark, the wordmark + 2.0, the status, the progress bar, the update states and click to skip. The same screen serves loading and the boot update. It **ends when the camera and audio are ready**: at least 1.5 s, at most the design's 4.3 s, and never on a fixed timer while something is still loading *(chat)*. Click to skip. SAUCE never waits for the REMIX engine. | "Starting your camera…" → "Warming the audio engine…" → "Ready. Curve your hands into a C." · "2.0 · CLICK TO SKIP" |
| ready | SAUCE, set to 808, PLUCK, C♯ minor pentatonic, octave 2. If the camera isn't allowed yet, the camera states below show. | Coach pill: **"Curve your hands into a C, turned a little toward the camera"** |
| camera on | **The GUIDE opens on step 1.** | GUIDE step 1, with its demo |
| hands seen | The strings light up between the C-shaped hands. | GUIDE step 2: pick a note with height, curl to play |
| first curl | **The first note plays.** | The string flashes, and a NotePop rises at the plucking fingertip. |

**The camera states:** these aren't in the design. They use the coach pill's glass at the centre:

| State | Copy |
|---|---|
| not allowed yet | **"Play with your hands"** · "FoxBox needs the camera to see them. Nothing leaves this Mac." · **Turn on the camera** · "macOS asks once. You can change it later in Settings." |
| refused | **"The camera is off"** · "FoxBox plays from your hands, so it needs the camera." · **Open camera settings** (the macOS Privacy pane, not a dialog) · **Try again** |
| busy | "Another app is using the camera" · "Close it, and FoxBox picks it up." |

- The GUIDE waits and opens once the camera is on.
- There's no keyboard fallback for notes in 2.0.
- REMIX's first visit is covered by the GUIDE's REMIX chapter. The stem model downloads (84 MB, once) on the first split, never at launch.

## First-run setup (2.1)
The user: "during first time setup foxbox strings should ask if you prefer your face hidden by default, as well as a few other simple setup questions".

**Where:** after the launch screen and before the camera request, so no camera is needed yet. Then comes the camera, then the GUIDE. It runs once. Every answer can be changed later in Settings.

**The cards** are five quick ones, each a single big choice:

| # | Title | Choices (the default is preselected) | Sets |
|---|---|---|---|
| 1 | **Your language** | English · Español · Português (Brasil) · Français · Deutsch · 日本語 (the system language preselected) | Settings → Language |
| 2 | **Hide your face by default?** | **Show it** · Hide my face | Face hiding (off by default) |
| 3 | **Which hand leads?** | **Right** · Left | Left-handed layout |
| 4 | **One hand or two?** | **Two hands** · One hand | One-handed mode (the one-handed GUIDE follows) |
| 5 | **Where's your music?** | A folder… · Rekordbox XML… · Serato · **Later** | REMIX's library sources |

- **The lines under each title** (13–15 px, not animation text):
  - 2: "FoxBox can cover your face in takes and on outputs."
  - 3: "Your lead hand plays the pitch in FLOW and spins the library."
  - 4: "One-handed mode plays everything with either hand."
  - 5: "For REMIX's library. Nothing leaves this Mac."
  - All cards: "You can change this anytime in Settings."
- **The look:**
  - one centred glass card in the 2.0 style, with the title Geist 700 at ≥ 36 px;
  - choices as big pills (≥ 64 px tall), with a tap choosing and moving on;
  - progress dots (1 / 5), and "Skip setup" top right, which keeps the defaults;
  - the music card's choices open the native pickers, and "Later" skips;
  - reduced motion: cross-fades only.
- **Keys:** arrows move between choices, Enter picks, and Esc skips setup.
- **No modal stack:** it's the first screen, not a dialog over the app.

## The GUIDE: the in-app tutorial
A premium, motion-animated step flow over the live app. It uses real strings, real sound and the user's own camera, with "now you try" steps. It isn't a video.
- **Its motion follows the onboarding video:** `FoxBox Onboarding.dc.html`, with kinetic type and orange slash wipes.
- **WHAT'S NEW 2.0** is separate (Settings → Guide & shortcuts → "What's new in 2.0 · Show again").

**When it runs:**
- SAUCE's chapter on first launch, once the camera is on;
- REMIX's chapter the first time REMIX opens;
- either one any time, from G, the dock's ··· menu, or Settings → Guide & shortcuts ("SAUCE guide · Continue from step n" · "REMIX guide").

**A step:**
- a short title and one line;
- an animated hand-pose demo that plays the move's **real sound** quietly (−12 dB, ducked as soon as the user plays);
- "now you try" feedback;
- progress dots;
- Back · Next · Skip;
- it celebrates when the camera sees the move.

**Behaviour:**
- **"Now you try" never blocks.** Next is always on, and a success moves on by itself after ~1.2 s.
- **Detection** uses the app's own signals, so what passes in the GUIDE works for real.
- **Keys:** → / ← are Next / Back while it's open, and Esc closes it.
- **Focus** stays in the card, and returns to where it was on close.
- **Closing early** remembers the step, and the GUIDE then offers "Continue from step n". A skipped first run still counts: the GUIDE never opens by itself again.
- **Reduced motion:** the demo shows the start and end poses with an arrow, and "Play the demo" plays its sound once.

**SAUCE steps (12 in 2.1):**
1. Curve your hands into a C, turned a little toward the camera, thumb in front (the strings appear).
2. Raise or lower a hand to pick a note; curl a finger to pluck.
3. Pick a sound (Sound, or keys 1–7).
4. Twist to bend.
5. Shake for vibrato; point up or down for the octave.
6. Pinch for wobble.
7. Make a frame with both hands. It loops the last 4 beats. Pull wider for more. Let go to stop.
8. Try FLOW.
9. Turn on a melody: it plays by itself. Raise your right hand for brighter, your left for higher. (2.1)
10. Spread your hands for space. Make a fist to drop it, on the beat. Frame it for an effect. (2.1)
11. Record a take, then drag it into Ableton or Finder.
12. Send to output (a projector or stream).

The design's settings mock says "10 steps", a placeholder; the 11 above stand.

**REMIX steps (6):**
1. Load a track, or try the test beat.
2. Hold a fist (TEAROUT).
3. Fold a finger to cut a band.
4. Jump to the drop.
5. Make a frame with both hands. It loops the last 4 beats. Pull wider for more. Let go to stop.
6. Hold the shaka 🤙 for your library.

## Empty states and copy
| Mode | State | Copy | Where |
|---|---|---|---|
| SAUCE | no hands seen | "Curve your hands into a C, turned a little toward the camera" | coach pill, centre |
| SAUCE | one hand | That hand plays normally. The coach adds "Raise your other hand". | coach pill |
| SAUCE | the room is too dark | "Hard to see your hands" · "More light on your hands, or step closer." | toast |
| SAUCE | the audio output is gone | "Your speakers went away. Playing on MacBook Pro Speakers." | toast |
| both | a take was saved | "Take 3 saved" | toast |
| REMIX | no track | Song popover: **Open library · L** · **Try the test beat**. Dropping a file on the window loads it too (WAV · AIFF · FLAC · MP3 · M4A). | Song popover |
| REMIX | reading the track | **Reading** (sections / BPM + key / drops) | Song popover |
| REMIX | the first stem split | First time only, inline before the download: "The stem splitter's weights are Meta's (Demucs), licensed for scientific use only." · **Continue** · **Not now**. Then "Downloading the stem model · 84 MB · once", then the split's progress, then the green "Stems ready" bar. | Song popover |
| REMIX | bad file | "Can't read notes.txt: use WAV, AIFF, FLAC, MP3 or M4A" · **Pick another** | toast |
| REMIX | engine not ready yet | "Getting REMIX ready…". Only loading a song waits; SAUCE never does. | Song popover |
| REMIX | stems failed | "Stem split failed" · **Try again** · **Play without stems** | Song popover |
| REMIX | paused | The waveform flattens into a thin red line, and the geometric fox walks along it · "PAUSED · SPACE TO PLAY" | stage |

**Toasts:**
- a glass pill under the notch, shown for 2.6 s;
- the badge for a held Beat FX: "TEAROUT · Depth 70% · locked to the beat".

## Gesture legends: the Hands popover (SAUCE) and Beat FX (REMIX)
Each lights the move it sees right now, with a LIVE tag.

**SAUCE · PLUCK:**
- **The pose:** both hands curved into a C, turned a little toward the camera (about 30°; a side-on C hides the middle and ring folds), with the strings between matching fingertips.
- **A hand's height picks its note,** in key, with hysteresis so a note doesn't flicker.
- **Curl a finger to pluck: Play note.** Faster is louder, and keeping it curled holds the note on sounds that sustain.
- **Two hands play two notes.**
- **Twist wrists: Bend.**
- **Shake: Vibrato.**
- **Octave: point up / down,** or − / + (↑ / ↓). **Never hand height** *(chat)*.
  - The design's legend says "Raise / lower" for Octave. The copy must say "Point up / down".
- **SPREAD** (Settings → Playing → NOTE PICKING HEIGHT / SPREAD): the note is picked by the distance between the hands instead (close = low, far apart = high).

**SAUCE · FLOW:**
- **Right-hand height: Pitch,** snapped to the key.
- **Spread hands: Open.**
- **Right-hand fist: Mute.**
- **Left hand: Shapes.** Only the left hand's shapes count.

**SAUCE shapes** (either hand in PLUCK, the left hand in FLOW):

| Shape | Default action |
|---|---|
| Fist | DRIVE |
| Pinch ↑ | WOBBLE (raise it to go faster) |
| Peace | ECHO |
| Horns | SPACE |
| Point ↑↓ | OCT ±1 |
| Frame | LOOP: the last 4 beats loop (see "Frames") |

The both-hands-open playing pose never fires anything.

**REMIX:**
- **Stretch:** tension.
- **Tilt:** slides the 808.
- **Shake:** vibrato.
- **Fold a finger:** cut its band. The strings are labelled SUB · LOW · MID · HI-MID · HIGH, and a cut band is dashed, with "· CUT".
- **Six beat FX shapes,** held, locked to the beat:

  | Shape | Default action |
  |---|---|
  | Fist | TEAROUT |
  | Peace | RIDDIM CHOPS |
  | Pinch | WOBBLE |
  | Horns | HALFTIME |
  | Point ↓ | SUB DROP |
  | Point ↑ | BUILD ROLL (let go: the DROP) |

  Hand height sets the depth, and two hands play two effects.
- **Frame:** the last 4 beats loop (see "Frames").
- **Shaka 🤙:** the library wheel.

### Edit shapes (both modes)
**Edit shapes** is in the Hands popover (SAUCE) and the Beat FX popover (REMIX). It opens an inline panel:
- Pick a shape, then an action chip. Chips show "current" or "on <shape>".
- Picking an action that another shape has **swaps** the two.
- **Reset all** restores the defaults.
- The maps are per mode, and they persist. S1 owns the remap API.
- **SAUCE's Frame is fixed to LOOP** *(chat)*, since holding, sizing and the flip depend on it. Edit shapes shows it locked, and LOOP isn't offered to other shapes.

**Actions:**
- **SAUCE:** DRIVE · WOBBLE · ECHO · SPACE · OCT ±1 · LOOP · BEND · VIBRATO · MUTE · RECORD · OFF.
- **REMIX:** TEAROUT · RIDDIM CHOPS · WOBBLE · HALFTIME · SUB DROP · BUILD ROLL · ECHO OUT · STUTTER · LOOP 1 BAR · FILTER SWEEP · OFF. All of them are beat-locked, and S2 builds the four new ones (ECHO OUT, STUTTER, LOOP 1 BAR, FILTER SWEEP).

**Settled:**
- **Neither mode's frame, nor the shaka, is remappable.**
- **Left-handed layout** (Settings → Playing) swaps the hand roles:
  - in FLOW, the left hand takes pitch and the right makes the shapes;
  - in the library wheel, the left index dials and the right hand grabs.

## The screens
The component names follow the design's README.

**Shared:**
- **CameraStage:** full-bleed, with the strings drawn by the WebGL renderer from the `--string-*` tokens.
  - SAUCE: cream strings with an orange glow, and a pluck flash.
  - REMIX: thin white labelled strings over the glass waveform.
- **CoachText:** a centred glass pill.
- **Dock:** centred at the bottom, 7 buttons, each showing a label and its current value. It rises above the Board when the Board is open.
  - **SAUCE:** Sound · Melody · Hands · Visual · Board · Record · Settings.
  - **REMIX:** Song · Beat FX · Library · Visual · Board · Record · Settings.
  - **Settings (···)** opens a short menu: Guide (G) · Send to output (projector / stream) · Face hiding · Settings (⌘,).
- **Popovers** rise from just above the dock, the same width as the dock, and each has a round × top right. The sound's tint colours SAUCE's popovers, and REMIX's are orange, red while a Beat FX is held.
- **The Board** (key B) slides up from the bottom, and the dock rises above it.
  - It has presets (SAUCE: Init / Warm / Wide / Dirty; REMIX: Clean / Club / Tearout / Lo-fi), **Reset all** and ×.
  - Knobs drag vertically (180 px for the full range), and a double-click resets one.
  - A knob a hand also drives carries an orange tag naming that gesture: Cutoff "Spread", Vibrato "Shake", Bend "Twist", Wobble "Pinch", Drive "Fist", Echo "Peace", Space "Horns", Bands "Fold", FX depth "Hand height".
  - **SAUCE:** SOURCE (sounds, PLUCK/FLOW, octave, key, FRAME, a live mini spectrum) · TONE (Cutoff, Resonance, Drive, Sub) · SHAPE (Attack, Release, Glide, Bend range) · MOTION (Vibrato, Wobble rate, Echo, Space) · OUTPUT (meter + Volume).
  - **REMIX:** STEMS (Drums / Bass / Vocals / Other: meter, fader, filter LP / Off / HP, M / S) · BANDS (5 knobs ±dB + Cut) · BEAT FX (6 hold pads; it folds away in compact) · MASTER (Tempo, FX depth, volume).
  - S2 owns the parameters as an API.
- **Visual** (VisualPicker, key V for the next one): 6 tiles with live previews: Off / Camera, Bars, Halo, Silk, Grain, Scope. **Off by default.**
  - In SAUCE the visual draws over the camera.
  - In REMIX it hides the camera and wraps around the waveform (see the camera rule).
- **Record** (RecordButton, key R): a big record button, its label and the timer, then the TAKES list.
  - Each row has a drag handle, the file name, the duration and "Show in Finder". Takes drag into Ableton or Finder.
  - SAUCE records WAV, named `FoxBox take 3 - 808 - C#m.wav`. REMIX records video + audio.
- **Toasts and the FrameBadge.**

**SAUCE (internally PlayPage):**
- **The note at each hand** *(the user)*: a faint note label at each hand, dim and always there, so a player can see which note a hand is on before plucking. In FOLLOW it shows the next note.
- **NotePop:** on every pluck, a glass pill rises just above the plucking fingertip, with a glowing dot and the note. It lasts 1.6 s.
  - In FOLLOW it adds the hint "next E3".
  - It **replaces the note ladder and the note trail**, which are gone. There's no keyboard strip.
- **Sound** (SoundPicker, keys 1–7):
  - BASS 808 · REESE · GROWL · WOBBLE;
  - MELODY PLUCK · LEAD · KEYS;
  - the key picker ("C# minor pentatonic ▾");
  - the octave stepper (− · OCTAVE n · +, with ↑ / ↓ or point up / down).
- **Melody** (MelodyPicker): see below.
- **Hands** (GestureLegend): the play style **PLUCK · FLOW · LOOP** (S; 2.1), the gestures, the shapes and Edit shapes.
- **Never shown in SAUCE:** a track, the test beat, BPM, a timeline, stems or beat FX.

**REMIX (RemixPage):**
- **Song** (SongBlock):
  - a play button (Space), the title, BPM and key;
  - JUMP TO: section buttons sized by their bar length (←/→). A jump lands on the bar, and ▶ starts 2 bars before the drop;
  - the stems status;
  - **Open library · L** · **Try the test beat**.
- **The stage waveform:** glass, with the section labels and the playhead. Paused, it's the red line and the walking fox.
- **Beat FX** (BeatFxSheet): 6 hold pads, Edit shapes, and BANDS (5 cut toggles).
- **Library:** the wheel (see below).

**The shell:**
- **LaunchScreen:** the user's looping video, with the UI in a right-hand column. It also shows loading and the boot update.
- **Settings** (SettingsSheet): see below.
- **WhatsNew,** shown once: "FoxBox is now an instrument for your hands", the 16:9 film, and "Looking for STUDIO, VISUALS or MASKS? They live on in FoxBox 1.5.5", with a link.
- **OutputWindow:** the picture only, full screen.

## SAUCE: Melody mode (2.1)
The user: "when melody mode is on it should use a different control style to adjust the sounds of the melody and auto loop it… modified on beat by your hand motions or frames". So MELODY becomes a **performance mode**: the melody plays by itself, and your hands shape it.

**Turning it on** *(the user's structure call)*: SAUCE's play style is **one visible switch, PLUCK · FLOW · LOOP**, in the dock (Hands) and the Island, and S cycles it. **LOOP is Melody mode.** PLUCK stays the default. The **Melody popover becomes LOOP's preset picker and tempo**, with no OFF / LOOP switch of its own.
- Picking a preset (Night hook · Kitsune · Low rider · Lantern · Rolled, 8 notes each), or 🎲 (D), **starts it looping at once**, with no plucking needed.
- **Tempo** is 120 BPM by default, or Link's tempo when Link is on (2.1). The popover has a − 120 + stepper ("LINK 124" when Link is on).
- **OFF** returns to plucking, as before.
- FOLLOW and FIT are cut: the loop replaces them.

**The four controls** (the ones the GUIDE teaches):

| Hand | Does | How it lands |
|---|---|---|
| **Right hand up / down** | brightness (the filter) | smooth, live |
| **Left hand up / down** | register: low · mid · high octave | on the next beat |
| **Hands apart / together** | space (reverb and width) | smooth, live |
| **A fist** (either hand) | drops the melody; open it and it comes back | on the next beat |

**Extras (not taught):**
- **Twist:** bends, ±2 semitones.
- **🤏 ✌️ 🤘:** WOBBLE · ECHO · SPACE, starting on the next beat.
- **An open palm held ~0.5 s:** plays a variation for the next bar (the 🎲 rules, in key).

**Frames:** any inward frame works on the loop (see "Frames"). It's on the next beat, it holds while you hold, its size sets the amount, and letting go ends it.

**The look** (it reads differently from plucking):
- **No pluck strings.** A glass **loop ring** sits centred between the hands: the 8 notes are dots around it, a playhead circles once per bar, and each note glows as it plays.
- **The ring reacts:** brightness makes it glow, register raises or lowers it, space widens and softens it, and a drop dims it to an outline.
- **The hands:** a small handle at each palm, labelled while you learn it ("BRIGHTER" right, "HIGHER" left). The labels fade after a few uses. **Big text or no text** *(the user)*: they're animation text, so they're at least 28 px at 1280 or not shown at all, never small.
- **The Island** shows "LOOP · Night hook · 120". The dock's Hands shows "LOOP", and its Melody shows the preset ("Night hook").
- **Hands popover (in LOOP):** the legend lists the four controls first, then the extras.

**The loop strip** *(the user: "a soft DAW-like overlay at the bottom showing the loop… make it impossible for it to sound bad")*:
- **At rest:** a soft glass strip just above the dock, as wide as the dock and ~84 px tall (72 px in compact).
  - It shows the loop as note blocks over 2 bars: time runs left to right, pitch goes up.
  - A playhead sweeps it, and each block lights as it plays.
  - The four hand controls show as a gentle tint: brightness warms the strip's top glow, register shifts the blocks up or down a row band, space softens them, and a drop dims the strip.
- **On hover** (mouse only; the hands keep playing), it eases up to ~180 px (150 in compact). The 16th grid shows, with the beats stronger and faint scale-note rows. Then:
  - **drag a block** up or down for pitch, or left or right to move it;
  - **drag its right edge** for length;
  - **click an empty spot** to add a note (an 8th);
  - **double-click** a block to delete it;
  - **⌘Z / ⇧⌘Z** undo and redo, **Reset to preset** puts the original back, and Esc or moving away collapses the strip.
  - The first hover shows one hint: "Drag the notes. Whatever you do stays in key."
- **Keyboard:** Tab to a block; ↑↓ change pitch, ←→ move it, ⇧←→ change its length, and Delete removes it.
- **It can't sound bad (S2's rules):**
  - pitch snaps to the key's scale, and to chord tones on the strong beats;
  - start times snap to the 16th grid, and lengths to musical values (1/16, 1/8, dotted 1/8, 1/4, 1/2);
  - the range is held to one comfortable octave and a half;
  - no two notes clash;
  - a leap bigger than a 6th resolves by step;
  - density is capped (no more than ~3 notes a beat);
  - a deleted downbeat is replaced by a gentle default (the root, short);
  - a move that would break a rule slides the block to the nearest allowed spot. There are no error messages.
- **Timing:** edits land on the next pass of the loop, never mid-note. A pending edit shows as an outline until it lands.
- **Saving:** edits save per preset on this Mac. An edited preset's tile gets a small dot, and Reset to preset clears it. 🎲 makes a new Rolled, which you can edit too.

**GUIDE** (replacing SAUCE step 9; two steps):
1. **"Turn on a melody: it plays by itself.** Raise your right hand for brighter, your left for higher." Now you try: move the right hand up.
2. **"Spread your hands for space. Make a fist to drop it,** on the beat. Frame it for an effect." Now you try: a fist drop.

**Who changes what (Melody mode):**
- **S1, the gestures:**
  - in LOOP, no pluck events;
  - the signals: right and left palm height (0–1, smoothed), spread (hand distance ÷ hand size), twist, a fist on either hand, an open palm held 0.5 s, and the shapes;
  - the lenient inward-L frame (FRAMES_SIMPLE.md, "Melody mode").
- **S2, the loop engine and the loop strip's rules:**
  - an edit API: propose an edit, get back the adjusted edit, and apply it on the next pass. It runs the rules above;
  - the preset loops at the tempo (120, or Link);
  - brightness → cutoff (~80 ms smoothing);
  - register → −1 / 0 / +1 octave, on the next beat;
  - space → reverb/delay send + stereo width;
  - a fist → mute on the next beat (with a short tail), and back on the next beat;
  - twist → ±2 st;
  - shapes → their FX on the next beat;
  - an open palm → a variation for the next bar (the 🎲 rules);
  - a frame → its effect on the loop, amount by size, on the next beat.
- **S3, the visuals:**
  - the loop strip's glass styling: the blocks, the light on the playing block, the playhead and the control tints;
  - the loop ring (8 dots, a playhead per bar) reacting to the four controls;
  - no strings in LOOP;
  - the palm handles with their fading labels, at ≥ 28 px at 1280 or not shown (big text or no text);
  - the frame pane as usual.
- **S4, the UI:**
  - the loop strip: rest and hover states, drag, stretch, add, delete, undo/redo, Reset to preset, the keyboard, per-preset saving and the one-time hint;
  - the play-style switch PLUCK · FLOW · LOOP (Hands and Island; S cycles it). The Melody popover is LOOP's preset picker with 🎲 and the tempo stepper (LINK when on), and FOLLOW/FIT are removed;
  - the Island and dock text;
  - the Hands legend in LOOP;
  - GUIDE steps 9–10.

## Frames: the last 4 beats, looping (both modes)
The user: "frames should show the last 4 beat loop with different effects and pinching while in a frame should change the frame style and audio effect", with the beat found automatically. This is the hero moment in both modes, and it replaces FREEZE.

**2.1 simplifies it to one rule** (the user: "frames are insanely confusing"; docs/FRAMES_SIMPLE.md): **hold a frame and it loops; let go and it stops.** It's the same in SAUCE, REMIX and one-handed mode.

**The look** (FramePane, FrameBadge):
- **The pane** sits exactly in the hands' frame and tilts with them (±10°).
- **Entrance:**
  - the lit edge draws itself (0.45 s), and the world blooms (0.7 s, from 0.35 s);
  - a name pill sits on the edge: the style + its effect, for example "THERMAL · Warm drive". It's `#FFB27A` in SAUCE and `#F2701F` in REMIX;
  - **the effect names itself big** for about a second, centred in the pane (Geist 800, about 70 px, e.g. "PRISM"; no small subline, per "big text or no text". The pill carries "Shimmer · 80%"), then it shrinks into the name pill;
  - a hint chip under the frame: "Hold to loop · let go to stop", then after a second "Pull wider for more · closer for less".
- **While it loops:** a white sweep line passes once per loop, and the brightness pulses on each beat.
- **Sound:** a "lock" on the beat when the frame is made.

**Flow (2.1):**
1. **Make a frame** with both hands (two L's: thumbs and index fingers). On the next beat, the last 4 beats of the picture inside the frame and the sound start looping, beat-locked, **for as long as you hold it**. The pane is only ever inside the fingers *(the user, 2.1.1)*: what each L's thumb tip, crotch and index tip bound (S1's outline), tracked every frame in both modes; nothing is drawn past them (the big name sits just above).
2. **Pull wider for more, closer for less.** The frame's size is the effect's amount, relative to its size when made (which starts at 50 %), shown as a thin bar along the frame's bottom edge.
3. **Let go:** the pane's gone that moment *(the user, 2.1.1: nothing stays in place)*, with the glass-break sound, and the live picture back at once. A frame counts as let go once both hands have been out of the L for 300 ms (S1).
4. **Each new frame brings the next effect:** ECHO TRAIL (Echo) → PRISM (Shimmer) → HALFTONE (Bitcrush) → KALEIDO (Chorus) → DATAMOSH (Glitch) → THERMAL (Warm drive) → round again. On letting go, a toast under the Island says what's next: "Next frame: HALFTONE". The Board's FRAME control picks one directly.
5. **The flip side, an untaught bonus** *(the user; kept as is)*: turning both hands over like a card, palms ↔ backs with the L corners kept, card-flips the pane onto the style's partner with the loop reversed. "flip side ⟲" shows in the name pill. It has no cue and no GUIDE step; this line is its only mention.

**In Melody mode (LOOP), any inward frame counts** *(the user)*. Any two L's that enclose space between the hands, in any orientation, make the frame: tilted, sideways or upside-down. It applies its effect to the melody loop on the next beat, with the same rules (hold = on, size = amount, let go = off).

**The always-visible "how":** while no frame has been made yet, a quiet chip above the dock says "Make a frame with both hands to loop the last 4 beats". It goes after 3 frames.

**Keys:** **F** toggles a frame on and off, for anyone who can't hold the pose, and as the way to play over a loop. **P** picks the next effect.

**Per mode:**
- **REMIX:**
  - the loop sits on the song's grid;
  - the song keeps running underneath (slip, like a loop roll), so letting go returns to where the song is now.
- **SAUCE:**
  - the beat comes from your **plucking tempo**. Before one is found it's **120 BPM**, and the chip says "120 · pluck to set the tempo";
  - your hands are holding the frame, so you can't pluck over it; with **F** you can.

**Both modes:**
- While framed, other shapes and finger cuts pause, and a pinch is never WOBBLE or a pluck.
- RECORD captures the loop and what's played over it.
- A mode switch ends the frame.

**Cut in 2.1:**
- the SAUCE latch ("make it again to release");
- pinch-and-hold to change the style;
- the per-mode differences.
The flip side stays as above.

| State | What shows |
|---|---|
| locking | the edge drawing and the bloom, then the lock on the beat |
| looping | the big name for ~1 s, then the name pill, the amount bar and the hint chip, with the sweep and the beat pulse |
| sizing | the amount bar follows the frame's width ("PRISM · Shimmer · 80%") |
| flipped (bonus) | the card-flip onto the partner, the loop reversed, and "flip side ⟲" in the name pill |
| SAUCE, no tempo yet | "120 · pluck to set the tempo" in the chip |
| let go | the pane gone at once, live again, and "Next frame: HALFTONE" |

## REMIX: the library wheel
The full spec is `docs/LIBRARY_WHEEL.md`. Its components are LibraryWheel, WheelCard, WheelPointer and LibrarySources.

**The look (Ring):**
- **The dome:** an upright half-dome of square record sleeves fans up out of the waveform line. It rises and spins into place as it opens.
- **The waveform folds** into a thin red line with a 68 px fox disc at its centre, and unfolds on close.
- **Labels:** titles and 3-digit index numbers radiate out on thin lines down both sides.
- **The pointer:** an orange line up to the selected sleeve, which stands at the top centre with a white outline. Beside it:
  - on the left, the dial angle ("212°") and "RIGHT INDEX · n / N";
  - on the right, the title, artist and BPM.
- **The hint** under the line: "Right index spins · close your left hand to grab · hold to load · Beat FX paused".
- **The source bar** (top centre):
  - Search;
  - All sources / Music folder / Rekordbox / Serato, each with its count;
  - "n of N";
  - playlists, crates or folders on a shelf row under it.
- **Covers:** embedded artwork from the tags, or a neutral card with initials when there's none.

**Flows:**
- **Open:** hold the 🤙 shaka for ~0.5 s, the Library button, or L. Typing searches.
- **While it's open:** the song keeps playing. Beat FX and finger cuts pause. Single-letter keys go to the search.
- **Spin:**
  - the right index is the dial (≈140°–280°). A ~140° sweep is one page of ~40 tracks, and holding near either end scrolls on;
  - it snaps after 180 ms idle;
  - the mouse wheel or a drag spins too, and ← / → step one track.
- **Grab:** closing the left hand pulls the selected sleeve out big (full size from ~0.7).
  - At the full pull, a 20 s preview plays from 40% in, ducking the deck.
  - Opening the hand puts it back.
  - A click previews too.
- **Load:**
  - hold the full grab for 0.8 s (a fill ring shows it), or double-click;
  - the sleeve shrinks onto the line, stretches into a bar across the width, and the waveform unfolds from it;
  - the track then loads like a dropped file.
- **Close:** the shaka again, or Esc.

**States** (the design's copy):

| State | What shows |
|---|---|
| no library | "Add your music" · "Pick a folder, import a Rekordbox XML export (File → Export Collection in xml format), or read your Serato library. Nothing leaves this Mac." · **Choose a folder…** · **Rekordbox XML…** · **Use Serato** |
| scanning | "Scanning your Music folder…" · "1,284 of 3,902 tracks · tags and artwork. The wheel fills in as tracks are found." · progress · **Hide** |
| a track's file is missing | "Can't find ember-ritual.flac" · "It was moved or deleted since the last scan." · **Locate…** · **Remove from list** |
| no artwork | a neutral card with initials |
| a huge library | it opens in under 1 s after the first scan, for 10k+ tracks |
| an unreadable XML | "That file isn't a Rekordbox collection export" · **Pick another** |
| no results | "Nothing matches "<query>"" · **Clear search** |

**Rules:**
- file names only;
- no network;
- the engine reads only user-picked folders and Serato's standard folder;
- the hands' holds have fill feedback, so nothing loads by surprise.

## Shortcuts
They're listed in Settings → Guide & shortcuts.

| Key | Does |
|---|---|
| M | SAUCE ⇄ REMIX |
| G | GUIDE |
| R | record, or stop and save |
| Space | play / pause (REMIX) |
| ← / → | section (REMIX), track (wheel), Back / Next (GUIDE) |
| 1–7 | sounds (SAUCE): 808, REESE, GROWL, WOBBLE, PLUCK, LEAD, KEYS |
| ↑ / ↓ | octave (SAUCE) |
| S | play style: PLUCK → FLOW → LOOP |
| D | 🎲 roll a melody (SAUCE) |
| L | library wheel (REMIX) |
| F | frame on / off |
| P | the next frame effect |
| V | next visual |
| B | Board |
| ⌘, | Settings |
| Esc | closes, in order: Settings → frame → wheel → popover / Board (and the GUIDE) |

Single-letter keys are ignored while typing in a field, and Space is ignored on focused buttons and sliders.

## Settings: a centred window
Settings is a 1200 × 780 window over a blurred scrim, opened from ⌘, or the dock's ···. Esc closes it.

**The nav:**
- **Playing:**
  - NOTE PICKING, HEIGHT / SPREAD;
  - Face hiding (off by default);
  - Left-handed layout (off by default);
  - Pluck sensitivity (Low / Medium / High, Medium by default; S1 maps it to the pluck thresholds).
  - *2.0.1:* One-handed (off by default), Hold time (0.3–1.2 s, 0.5 s by default), Wobble tolerance (Low / Medium / High) and Calibrate reach (see "One-handed mode").
- **Output & recording:**
  - Send to output (opens a picture-only window);
  - Clip watermark;
  - Takes folder ("Music › FoxBox Takes ▾").
- **Library** *(chat; not in the design, built in its row style)*:
  - each source with its track count and when it was last scanned, with **Rescan** and **Remove**;
  - **Add folder…** · **Rekordbox XML…** · **Use Serato** (or "Serato not found").
- **Devices & engine:**
  - camera;
  - audio output (falls back to the built-in speakers on a disconnect);
  - latency;
  - engine and tracking status;
  - REMIX stems.
- **Guide & shortcuts:**
  - SAUCE guide ("Continue from step n");
  - REMIX guide;
  - KEYBOARD;
  - "What's new in 2.0 · Show again".
- **About:**
  - the version and **Check now**;
  - credits and licences, including "The stem splitter's weights are Meta's (Demucs), licensed for scientific use only.";
  - "Looking for STUDIO, VISUALS or MASKS? They live on in FoxBox 1.5.5 on GitHub."

## One-handed mode (2.0.1)
For accessibility: FoxBox plays with one hand *(the user's decision; it ships right after 2.0)*. S1–S4 build it after 2.0 ships. No new libraries.

**Turning it on:**
- **The setting:** Settings → Playing → **One-handed**, off by default. Either hand plays.
- **Two hands in view:** the Left-handed setting picks which hand plays. The other hand is ignored, with no strings and no shapes.
- **First turn-on:** the reach calibration and the one-handed GUIDE run (see below).

**SAUCE · PLUCK:**
- **Height picks the note,** and a curled finger plucks, as now.
- **Shapes toggle:** ✊ DRIVE · 🤏 WOBBLE · ✌️ ECHO · 🤘 SPACE are **hold to toggle**. Hold the shape for the hold time (default 0.5 s) and its effect latches on; hold it again and it turns off. The same hand can't hold a shape and pluck at once, so this is the one-handed way.
- **What's on:** a small pill by the hand lists what's on, e.g. "DRIVE · ECHO".
- **Momentary shapes:** point up or down stays momentary; only ✊ 🤏 ✌️ 🤘 latch.
- **Back to two hands:** latched effects turn off when One-handed is switched off.
- **Twist** bends, and **point up or down** changes octave, as now.

**SAUCE · FLOW:**
- **Height** is the pitch.
- **The thumb–index gap** is the filter: open is bright, closed is dark.
- **A fist** mutes.

**Frames *(the user's pick)*:**
- **Opening:** hold **one L** (thumb and index out) for the hold time, and a pane opens between its thumb and index (2.1.1: only there). It loops while you hold the L, and stops when you let go (2.1).
- **Changing:** each new frame brings the next effect (2.1). Turning the hand over gives the flip side, untaught.
- **Releasing:** hold the L again, and the pane's gone.

**REMIX:**
- **Beat FX shapes and finger cuts** work as now, with one hand.
- **The library wheel:** the shaka opens it and the index dials. Closing the hand grabs and previews, and holding a fist ~0.8 s loads. The shaka again, or Esc, closes it.

**Keys, as the fallback** (to confirm with S4): F frame · P next style · L library.

**Holds, for every hold above:**
- **Hold time:** Settings → Playing → **Hold time**, 0.3–1.2 s, default 0.5 s. It applies to the L-frame and the shape toggles; S2's toggle reads it instead of a fixed 400 ms.
- **Hold feedback:** nothing for the first ~200 ms, so passing shapes stay quiet. Then a small ring fills at the hand until the hold fires. Then a short confirm sound and a glow: a soft two-note pip, rising for on and falling for off, quiet (~−22 dB, S2).
- **Wobble tolerance:** a little hand movement doesn't break a hold. Settings → Playing → **Wobble tolerance**, Low / Medium / High, Medium by default.

**Reach calibration:**
- **When it runs:** on turning One-handed on, and again from Settings, with "Calibrate reach".
- **What it asks:** "Raise your hand to your highest comfortable note", then "now your lowest". The note range maps onto that reach.
- **The default** without calibration sits around chest height, and no note needs the hand above the shoulder.

**The one-handed GUIDE** (Settings → Guide & shortcuts, and on first turn-on):
1. Hold one hand up, curved into a C, turned a little toward the camera.
2. Raise or lower it to pick a note; curl a finger to pluck.
3. Show us your reach: raise your hand to your highest comfortable note, then your lowest.
4. **Practice the shapes, one at a time.** Each one gets a tick when it reads: "Hold a fist to turn on DRIVE" → "Hold a pinch for WOBBLE" → "Hold peace for ECHO" → "Hold horns for SPACE". Hold it again to turn it off.
5. Twist to bend; point up or down for the octave.
6. Hold an L to make a frame. It loops while you hold it, and letting go stops it.
7. Try FLOW: height for pitch, open and close your thumb and index for the filter, a fist to mute.

REMIX's one-handed chapter is the same as the two-handed one, except for step 6: "Hold the shaka 🤙 for your library: your index spins it, close your hand to preview, hold a fist to load."

The GUIDE keeps its rules: "Now you try" never blocks, and the demos use one hand.

## Type and surfaces
- **Everything visual comes from `app/design/foxbox-2/foxbox-tokens.css`:** colour, type, space, radii, blur and shadow, motion, `--string-*`, `--frame-*` and `--wheel-*`.
- **Key values:**
  - ink `#F6EFE6`, secondary `#B5A798`;
  - accent `#F2701F`, accent soft `#FFB27A`, fox `#FF4D2E`;
  - background `#15100D`, glass `rgba(28,22,18,.74)`.
- **The frame shatter tokens** (850 ms, 6 shards) aren't used: since 2.1.1 a let-go frame is simply gone *(the user)*.
- **Under 1440 × 900:** `docs/FOXBOX2_COMPACT.md`.

## Settled
- **SAUCE is the primary mode's name** (was PLAY).
- **No keyboard fallback** for notes in 2.0.
- **One hand alone plays** its own note.
- **SAUCE's pose and notes** (the user, 2026-10-15):
  - C-shaped hands, turned a little toward the camera (~30°);
  - each hand's height picks its note, and you curl a finger to pluck;
  - two hands play two notes, and holding sustains;
  - SPREAD is in Settings.
- **Notes on screen:** a faint, always-there note label at each hand, plus the glass NotePop on each pluck. The note ladder and the trail are gone.
- **The looper was cancelled.** MELODY OFF · FOLLOW · FIT replaced it, with 5 presets and 🎲 Roll (D). **In 2.1, LOOP is the third play style (PLUCK · FLOW · LOOP):** the melody plays by itself, shaped by four hand controls on the beat (see "Melody mode").
- **The octave** is − / + (↑ / ↓) and point up / down, never hand height.
- **Frames loop the last 4 beats in both modes,** replacing FREEZE:
  - six front styles, each with a flip-side partner;
  - **2.1:** hold to loop, let go to stop; wider = more; each new frame is the next effect; the name big for a second; the how-chips; F and P;
  - the flip side (turn both hands over like a card, the loop reversed) stays as an untaught bonus;
  - no roll;
  - the release: gone at once, nothing past the fingers (2.1.1);
  - a pinch while framed never plucks;
  - REMIX's loop slips under the song; SAUCE no longer latches (2.1).
- **The camera is hidden only** in REMIX with a Visual on.
- **Edit shapes:** SAUCE's Frame is fixed to LOOP and shown locked. REMIX's four new actions are S2's, beat-locked.
- **The launch screen** is the user's looping fox-bedroom video (10 s, seamless; a still under reduced motion), with the UI in a right-hand column. It also shows loading and the boot update, and it ends when the camera and audio are ready (1.5–4.3 s, click to skip). Painterly prompt #3 is superseded.
- **Library sources** are managed in Settings → Library.
- **The library wheel** also opens from the Library button and L, and GUIDE REMIX step 6 teaches the shaka.

## Open
- **The six flip-side partners** for the design's front six: S2 (sound) and S3 (picture) settle them. This doc gets updated when they land.
