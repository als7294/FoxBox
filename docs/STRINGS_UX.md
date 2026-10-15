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

**SAUCE steps (11):**
1. Curve your hands into a C, turned a little toward the camera, thumb in front (the strings appear).
2. Raise or lower a hand to pick a note; curl a finger to pluck.
3. Pick a sound (Sound, or keys 1–7).
4. Twist to bend.
5. Shake for vibrato; point up or down for the octave.
6. Pinch for wobble.
7. Make a frame to loop the last 4 beats; pinch and hold for a moment to change the effect. Turn your hands over for the flip side.
8. Try FLOW.
9. Pick a melody, then pluck to play it (🎲 for a new one).
10. Record a take, then drag it into Ableton or Finder.
11. Send to output (a projector or stream).

The design's settings mock says "10 steps", a placeholder; the 11 above stand.

**REMIX steps (6):**
1. Load a track, or try the test beat.
2. Hold a fist (TEAROUT).
3. Fold a finger to cut a band.
4. Jump to the drop.
5. Frame a window: the last 4 beats loop; pinch and hold for a moment to change the effect. Turn your hands over for the flip side.
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
- **SAUCE's Frame is fixed to LOOP** *(chat)*, since latching, the pinch, the flip and the release depend on it. Edit shapes shows it locked, and LOOP isn't offered to other shapes.

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
- **Hands** (GestureLegend): PLUCK / FLOW (S), the gestures, the shapes and Edit shapes.
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

## SAUCE: melodies (MELODY: OFF · FOLLOW · FIT)
The user asked for "both, switchable": play a preset melody your own way, or keep free play.

**The Melody popover:**
- OFF / FOLLOW / FIT in its header, with a subtitle that explains the mode.
- **PRESETS:** Night hook · Kitsune · Low rider · Lantern · Rolled, each 8 notes, written by S2. They're never named after or copied from existing songs. **Rolled** holds the last 🎲 roll.
- **SEQUENCE:** the strip of 8 notes. In FOLLOW the next one is orange.
- **🎲 Roll a melody** (key D, with the "D rolls" chip): a new melody in the current key. It's rule-based (scale steps, contour, phrase length), never called AI or "generated".
- **Back to the start.**

**The modes:**
- **OFF:** free play. Height picks the note, and a curl plays it.
- **FOLLOW:**
  - each pluck (either hand) plays the preset's **next** note, so you supply the rhythm;
  - hand height shifts that note ±1 octave;
  - both hands advance the one phrase *(chat)*;
  - at the end, it wraps to the top.
- **FIT:** hand-height notes snap to the preset's notes, and each pluck advances the phrase.
- **What carries over:** changing the key transposes the preset; changing the sound keeps your place. Back to the start, a new preset or 🎲 starts from the top.
- **FLOW** *(chat)*: FIT snaps the right hand's pitch. FOLLOW needs plucks, so it's greyed out in FLOW ("FOLLOW plays with PLUCK").

## Frames: the last 4 beats, looping (both modes)
The user: "frames should show the last 4 beat loop with different effects and pinching while in a frame should change the frame style and audio effect", with the beat found automatically. This is the hero moment in both modes, and it replaces FREEZE.

**The look** (FramePane, FrameBadge):
- **The pane** sits exactly in the hands' frame and tilts with them (±10°).
- **Entrance:**
  - the lit edge draws itself (0.45 s), and the world blooms (0.7 s, from 0.35 s);
  - a name pill sits on the edge: the style + its effect, for example "THERMAL · Warm drive". It's `#FFB27A` in SAUCE and `#F2701F` in REMIX;
  - a hint pill: "● ● ● ● 4 beats · pinch and hold for a moment to change the effect".
- **While it loops:** a white sweep line passes once per loop, and the brightness pulses on each beat.
- **Sound:** a "lock" on the beat when the frame is made.

**Flow:**
1. **Make a frame** (thumbs and index fingers of both hands), or press **F**. On the next beat, the last 4 beats of the picture inside the frame and the sound start looping, beat-locked.
2. **Pinch and hold for a moment while framed** *(chat)*: a deliberate pinch held about a fifth of a second, because a flick-fast pinch can't be told from the resting C. It steps to the next style with its paired audio effect: ECHO TRAIL (Echo) → PRISM (Shimmer) → HALFTONE (Bitcrush) → KALEIDO (Chorus) → DATAMOSH (Glitch) → THERMAL (Warm drive) → round again.
   - The name flips on the edge, and the effect changes on the next beat.
   - REMIX: a pinch at either corner of the held frame, which holds through it. SAUCE: any pinch while it's latched.
3. **Turn your hands over, like turning a card,** for the **flip side** *(the user)*. The frame stays upright, and both hands turn over (palms ↔ backs to the camera) while keeping their L corners. An upside-down turn of the frame can't be tracked, so it isn't the gesture. The pane does a quick card-flip onto the current style's **partner**, a clearly contrasting picture and sound, with the loop **reversed**. The name pill adds "flip side ⟲".
   - Turn the hands back and it returns to the front style, forwards.
   - A pinch cycles styles **on the side you're on**.
   - **The six partners:** S2 (sound) and S3 (picture) pick them from ICE, X-RAY, MIRROR and new ones. That's open until they land.
4. **Release:** a **glass fracture** *(chat)*, the only release style. It's ~140 ms: a crack, ~40 refracting shards and a glass-break sound, with the live picture back at once. That replaces the design's 6 shards over 0.85 s.
   - REMIX: let go, because the frame is **held**.
   - SAUCE: **make the frame again**, because it **latches** *(chat)*.
   - F or Esc also releases it.

**Per mode:**
- **REMIX:**
  - the loop sits on the song's grid;
  - the song keeps running underneath (slip, like a loop roll), so a release returns to where the song is now;
  - beat-FX shapes and finger cuts pause while framed.
- **SAUCE:**
  - the beat comes from your **plucking tempo**. Before one is found it's **120 BPM**, and the hint pill says "120 · pluck to set the tempo";
  - the latched pane stays where the frame was made, and new plucks **play on top**, with MELODY carrying on;
  - the flip reads while the hands still hold the frame they latched;
  - **a release needs both hands out of the L for 300 ms** (S1's sha B), so turning the hands over is never a release.

**Both modes** *(chat)*:
- **A pinch while framed belongs to the frame:** never WOBBLE, and never a pluck, even though a pinch curls the fingers.
- RECORD captures the loop and what's played over it.
- A mode switch releases the frame.

| State | What shows |
|---|---|
| locking | the edge drawing and the bloom, then the lock on the beat |
| looping | the name pill ("THERMAL · Warm drive") and the hint pill, with the sweep and the beat pulse |
| restyled | the new name flips in, and the effect changes on the beat |
| flipped | the card-flip onto the partner, the loop reversed, and "flip side ⟲" in the name pill |
| SAUCE, no tempo yet | "120 · pluck to set the tempo" in the hint pill |
| SAUCE, latched | the pane stays where it was made · "frame again to release" (once, on first use) |
| released | the glass fracture, then live again |

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
| S | PLUCK ⇄ FLOW |
| D | 🎲 roll a melody (SAUCE) |
| L | library wheel (REMIX) |
| F | frame: make or release it |
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

## Type and surfaces
- **Everything visual comes from `app/design/foxbox-2/foxbox-tokens.css`:** colour, type, space, radii, blur and shadow, motion, `--string-*`, `--frame-*` and `--wheel-*`.
- **Key values:**
  - ink `#F6EFE6`, secondary `#B5A798`;
  - accent `#F2701F`, accent soft `#FFB27A`, fox `#FF4D2E`;
  - background `#15100D`, glass `rgba(28,22,18,.74)`.
- **The frame shatter tokens** (850 ms, 6 shards) are overridden by the glass fracture (~140 ms, ~40 shards) *(chat)*.
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
- **The looper was cancelled.** MELODY OFF · FOLLOW · FIT replaces it, with 5 presets and 🎲 Roll (D).
- **The octave** is − / + (↑ / ↓) and point up / down, never hand height.
- **Frames loop the last 4 beats in both modes,** replacing FREEZE:
  - six front styles, each with a flip-side partner;
  - the flip side: turn both hands over like a card (palms ↔ backs), and the loop plays reversed;
  - no roll;
  - the glass-fracture release;
  - a pinch while framed never plucks;
  - SAUCE's frame latches, and REMIX's is held and slips.
- **The camera is hidden only** in REMIX with a Visual on.
- **Edit shapes:** SAUCE's Frame is fixed to LOOP and shown locked. REMIX's four new actions are S2's, beat-locked.
- **The launch screen** is the user's looping fox-bedroom video (10 s, seamless; a still under reduced motion), with the UI in a right-hand column. It also shows loading and the boot update, and it ends when the camera and audio are ready (1.5–4.3 s, click to skip). Painterly prompt #3 is superseded.
- **Library sources** are managed in Settings → Library.
- **The library wheel** also opens from the Library button and L, and GUIDE REMIX step 6 teaches the shaka.

## Open
- **The six flip-side partners** for the design's front six: S2 (sound) and S3 (picture) settle them. This doc gets updated when they land.
