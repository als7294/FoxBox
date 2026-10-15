# Landing page handoff: FoxBox Strings + FoxBox Voice

**How to use it:**
1. Paste everything below the line into Claude Design (or your site builder).
2. Attach the assets listed at the bottom.
3. If you want code, export → Handoff to Claude Code and give the PM the zip.

---

**What this page is.** One landing page for two sibling Mac apps from the same maker:
- **FoxBox Strings**, the flagship: an instrument you play with your hands in front of your webcam.
- **FoxBox Voice** (beta): a voice studio that turns a typed line or your own voice into a processed, club-ready vocal drop.

The page should make you want to try Strings right away, and want an invite to Voice.

**Audience.** Bass-music producers and DJs (dubstep, riddim, trap, deep bass), creators, and anyone curious about playing music with their hands. Mostly on laptops, plenty on phones (social links), so it must work well at 375 px.

**Tone.** Warm, playful, confident, a little magical. Short sentences and plain words. No hype words like "revolutionary" or "AI-powered". Both apps run entirely on your Mac.

## Brand system: two foxes, one family
- **FoxBox Strings, the warm fox:**
  - **UI and colour:** dark warm glass; background `#15100D`, ink `#F6EFE6`, secondary `#B5A798`, accent `#F2701F`, accent-soft `#FFB27A`, fox red `#FF4D2E`. Glass surfaces are `rgba(28,22,18,.74)` with a 40 px blur, and the hairline is `rgba(255,255,255,.12)`.
  - **Illustration:** a painterly anime-style red fox in a sunlit pink and orange autumn forest, plus a night-time producer's bedroom loop (attached).
  - **Logo:** the "FoxBox Strings" wordmark (attached SVG), with no icon.
- **FoxBox Voice, the arctic fox:**
  - **Colour:** snow white, ice blue, pale silver and deep night navy, with one aurora accent (teal → violet).
  - **Illustration:** a painterly arctic fox on a snowy night under an aurora (art coming).
  - Always labelled **BETA**.
- **Shared:**
  - **Type:** Geist (400–800) and Geist Mono (OFL).
  - **Corners:** generous and rounded (pills, 18–34 px).
  - **Motion:** soft, springy, never flashy.
  - The two brands sit side by side like day and night: warm amber vs cool aurora.

## Page structure (suggested)
1. **Hero: two foxes.** A split screen, warm on the left and cool on the right.
   - Headline across both: "Make music with your hands. Make your voice a drop."
   - Two cards:
     - **FoxBox Strings** "An instrument for your hands." [Download for Mac] (free).
     - **FoxBox Voice · BETA** "Your voice, as a club-ready drop." [Get an invite] · [I have a code].
   - The background plays the Strings bedroom loop on the warm side and an aurora snowfall on the cool side.
2. **FoxBox Strings: how it plays.** A big looping clip of hands playing (attached shots and film) and three beats:
   - "Curve your hands into a C." Strings of light stretch between your fingertips.
   - "Raise a hand to pick a note. Curl a finger to pluck." Always in key, with the note popping at your fingertip.
   - "Make a frame." The last 4 beats loop inside your hands. Pinch to change the effect, and turn your hands over for the flip side.
3. **Strings, mode 1: SAUCE (make sounds).**
   - 7 sounds: BASS (808, REESE, GROWL, WOBBLE) and MELODY (PLUCK, LEAD, KEYS).
   - Pluck or Flow (theremin-style).
   - Hand shapes add effects: ✊ drive, 🤏 wobble, ✌️ echo, 🤘 space. You can remap any shape.
   - Melody presets: Follow plays the preset's next note with each pluck, Fit keeps you in its notes, and 🎲 rolls a new one.
   - Twist to bend, shake for vibrato, point up or down for the octave.
   - The Board of knobs, and Visuals.
   - Record a take and drag the WAV straight into Ableton.
4. **Strings, mode 2: REMIX (remix any song).**
   - Drop in any track, or try the test beat. FoxBox splits the stems on your Mac.
   - Hold a hand shape for beat-locked FX: ✊ TEAROUT, ✌️ RIDDIM CHOPS, 🤏 WOBBLE, 🤘 HALFTIME, 👇 SUB DROP, ☝️ BUILD ROLL (let go: the drop).
   - Fold a finger to cut a band, and jump to any section on the bar.
   - **The library wheel:** hold 🤙 to spin through your music folder, Rekordbox (XML export) or Serato library with one finger, grab to preview, hold to load.
5. **FoxBox Voice · BETA.** The cool half.
   - Type a line, or record yourself. Pick a built-in voice.
   - Shape it with a rack: presets PACT, LEGION, ABYSS, UNIT, GHOST, SIGNAL, RAW, and four big macros, DEPTH · GRIT · MACHINE · SPACE.
   - Script tricks: `|` lands each part on the beat, `*word*` throws a word into delay.
   - **Export bar-exact, club-loud files** (AIFF 24-bit or WAV, with BPM/key tags) plus a rekordbox.xml with a hot cue on the first word. Drag the file into Rekordbox or Ableton.
   - **The beta:** Mac only, invite code required. CTA: [Get an invite] (a form or email; the PM wires it up) · [I have a code → Download].
6. **Made for your Mac.**
   - Everything runs on-device: your camera, songs and voice never leave your Mac.
   - Requirements: macOS 14+ and Apple silicon. Strings also needs a camera.
   - Free updates are built in. Strings is open source (GPL-3.0).
7. **FAQ** (short):
   - "Do I need a MIDI controller?" No, just your hands and a webcam.
   - "Which hand shapes?" (Link to the Strings guide.)
   - "Does it work with Rekordbox and Serato?" Yes: library browsing in Strings, and rekordbox.xml export in Voice.
   - "Is Voice free?" It's a free beta by invite.
   - "Where's the old FoxBox toolkit (Studio, Visuals, Masks)?" FoxBox 1.5.5 is still on GitHub.
8. **Footer:** GitHub (Strings), the FoxBox 1.5.5 archive link, credits, and the note "The stem splitter's weights are Meta's (Demucs), licensed for scientific use only."

## Links (use these exactly)
- **FoxBox Strings download:** https://github.com/als7294/FoxBox/releases/latest
- **FoxBox Strings source:** https://github.com/als7294/FoxBox
- **FoxBox 1.5.5 (old toolkit):** https://github.com/als7294/FoxBox/releases/tag/v1.5.5
- **FoxBox Voice:** the repo is not public yet. Use a placeholder `#voice-invite` until the PM sends the link.

## States and details to design
- The hero at 1440 / 1024 / 375 widths. On mobile, the two cards stack (Strings first).
- The download button notes "macOS 14+ · Apple silicon".
- A "Get an invite" form: email plus "what do you make?", with success and error states.
- Video placeholders (attached clips), with a still poster for reduced motion.
- Dark only. Text ≥ 14 px body, AA contrast, visible focus states.

## Attach these
- `foxbox-launch-loop-master.mp4`: the Strings bedroom loop (in ~/Movies/FoxBox/brand/; 10 s seamless).
- The README screenshots (docs/readme/ on branch help/s5-release-text): SAUCE playing, a frame loop, REMIX Beat FX, the Board, the library wheel (when shot).
- `foxbox-banner.png` (2.0) and the Strings design tokens: app/design/foxbox-2/foxbox-tokens.css.
- The "FoxBox Strings" wordmark SVG: the option the user picks from S5's three.
- The painterly fox art (Strings) and the arctic fox art (Voice), once generated from docs/BRANDING_PROMPTS.md and docs/VOICE_BRANDING_PROMPTS.md.
- The explainer films (Codex) when ready.
