# Guided mode entry (S5, 2026-10-16)

The user, on the real 2.1 app: "this is confusing and needs work and should be more guided going into melody, sauce,
or remix mode." This is the spec for S4. Mocks: [docs/mode-entry/mocks.html](mode-entry/mocks.html) (`?v=hands|chooser|island|melody|sauce|remix`),
rendered at 1512×982 and 1280×800. Nothing gets built before the user has seen them.

## What's wrong today

1. **Three modes, two doors.** The Island offers SAUCE · REMIX. MELODY (LOOP) sits third in a PLUCK · FLOW · LOOP row
   inside SAUCE, so the one mode that plays by itself is the hardest to find.
2. **The Island's open state crams three jobs into 168 px:** the mode pills, the style row, and a 14 px foot drawn over the row.
   (S4's b9bf218b moved the foot under the row. That fixes the overlap, not the crowding.)
3. **Two instructions at once.** The big C-pose coach and the frame pill showed together. b9bf218b fixed that
   for SAUCE (`SauceGuide`). MELODY's rotating hints and REMIX's cue still run on their own.
4. **The first run opens the whole SAUCE GUIDE** (11 steps) before anyone has chosen what they came for.

## The model: three modes

| Mode | One line | Under the hood (no engine change) |
|---|---|---|
| **SAUCE** | Pluck notes between your hands. | `ui.mode 'play'`, style PLUCK or FLOW |
| **MELODY** | A loop plays. Your hands shape it. | `ui.mode 'play'`, `melodyMode 'loop'` (today's LOOP) |
| **REMIX** | Remix any song with your hands. | `ui.mode 'remix'` |

- **The derived mode:** `topMode()` = `remix` if `ui.mode === 'remix'`, `melody` if `melodyMode === 'loop'`, else `sauce`.
- **One way in:** `enterMode(m)` does the switching:
  - SAUCE: `switchMode('play')` plus the last PLUCK/FLOW style;
  - MELODY: `switchMode('play')` plus `setPlayMode('loop')`, rolling a preset if none is picked;
  - REMIX: `switchMode('remix')`.
- **Switching rules stay as they are:** a running take saves first, held notes release, and REMIX pauses on the bar.
- **FLOW is a style inside SAUCE.** `PLAY_MODES` for the S key becomes `['pluck', 'flow']`; LOOP leaves the row.
- **The dock follows the mode.** SAUCE: Sound · Hands · Visual · Board · Record · Settings (Melody moves out). MELODY:
  Melody · Sound · Visual · Board · Record · Settings. REMIX: unchanged.
- **Windows:** the REMIX card says "Coming to Windows" and has no Start (today's RemixSoon).

## 0 · How you play, asked once (mock `hands`)

The user's ask: "ask during setup what type of controls are best (1 hand, 2 hand curl, palms), explaining it's like
being a lefty or riding goofy". The style card exists (setup card 4), but setup only runs on new installs, so anyone
updating from 2.0.x never saw it.

**When it's asked:**
- **New installs:** setup's cards 3 and 4 merge into this one. The setup becomes language → face → **How do you play?** →
  music → **What are we playing?** (5 dots).
- **Updating:** once, right after WHAT'S NEW, in setup's screen: **How do you play?** → **What are we playing?** (2 dots).
- **Never again once answered.** The key is `foxbox-style-asked`. Next sets it, and so do Esc and Skip, which keep the current style.

**The card:**
- **Text:** the title "How do you play?" and the line "Like being a lefty or riding goofy: there's no right way, just
  your way." The foot says "Switch any time in Settings → Playing."
- **Three picks, each a live demo:** S3's strings-pluck, strings-palm and strings-one loops, muted, with posters under
  reduced motion. The label comes in two parts ("Two hands ·" / "curl a finger"), with one short line under it.
- **The current style** (CURL by default) has the accent ring and a ✓. Picking doesn't advance the card; Next does,
  because the card asks two things.
- **The lead hand** sits under the picks as a Left | Right toggle: "It plays the pitch in FLOW and spins the library."
- **Keys:** arrows move between the picks, Tab reaches the toggle, Enter is Next.

**"Try it" (camera picks for you): skipped.** It isn't cheap or reliable enough:
- Setup runs before the camera is on, so it would pull the macOS camera prompt into setup.
- The choice is about how the moves feel, not which style the camera tracks best, and 3 s of tracking can't tell those apart.
- The intro's step 2 is the real try, and Settings → Playing switches any time.

**The copy in six languages** (it adapts the existing `setup.style.*` / `setup.hand.*` wording; the Settings paths are
the ones already shipped):

| Key | EN | ES | PT | FR | DE | JA |
|---|---|---|---|---|---|---|
| `hands.title` | How do you play? | ¿Cómo tocas? | Como você toca? | Tu joues comment ? | Wie spielst du? | どうやって弾く？ |
| `hands.line` | Like being a lefty or riding goofy: there's no right way, just your way. | Como ser zurdo o ir en goofy: no hay una forma correcta, solo la tuya. | Como ser canhoto ou andar de goofy: não existe jeito certo, só o seu. | Comme être gaucher ou rider en goofy : pas de bonne façon, juste la tienne. | Wie Linkshänder sein oder goofy fahren: Es gibt keinen richtigen Weg, nur deinen. | 左利きやグーフィースタンスと同じ。正解はなくて、あなたのやり方があるだけ。 |
| `hands.foot` | Switch any time in Settings → Playing. | Cámbialo cuando quieras en Ajustes → Tocar. | Troque quando quiser em Ajustes → Tocar. | Change quand tu veux dans Réglages → Jouer. | Wechsle jederzeit unter Einstellungen → Spielen. | 設定 → 演奏 でいつでも切り替えられます。 |
| `hands.two` | Two hands · | Dos manos · | Duas mãos · | Deux mains · | Zwei Hände · | 両手 · |
| `hands.curl` · `.feel` | curl a finger · Small, precise moves. | curva un dedo · Movimientos pequeños y precisos. | curve um dedo · Movimentos pequenos e precisos. | plie un doigt · Des gestes petits et précis. | Finger beugen · Kleine, präzise Bewegungen. | 指を曲げる · 小さく正確な動き。 |
| `hands.palm` · `.feel` | tap with your palm · Bigger and looser, like a drum pad. | toca con la palma · Más amplio y suelto, como un pad de batería. | bata com a palma · Maior e mais solto, como um pad de bateria. | tape de la paume · Plus ample, plus libre, comme un pad. | mit der Handfläche tippen · Größer und lockerer, wie ein Drum-Pad. | 手のひらでタップ · 大きくゆったり、ドラムパッドのように。 |
| `hands.one` · `.feel` | One hand · Everything with either hand. | Una mano · Todo con cualquiera de las dos manos. | Uma mão · Tudo com qualquer mão. | Une main · Tout avec l’une ou l’autre main. | Eine Hand · Alles mit einer Hand, egal welcher. | 片手 · どちらの手でも、すべて片手で。 |
| `hands.lead` | Lead hand | Mano principal | Mão principal | Main principale | Führungshand | メインの手 |

**Reused keys:** `setup.hand.line`, `setup.hand.left` / `.right` and `guide.next`. **Retired:** `setup.style.title` and
`setup.style.foot`, and `setup.hand.title` once the cards merge. The `style.*.sub` lines stay for Settings → Playing.

## 1 · The mode chooser

The mode chooser is one component, `ModeCards`, with two hosts. Neither host is a modal.

**Card anatomy:**
- **Demo:** a tiny looping demo, 16:9, muted, from S3's captures (`strings-pluck`, `strings-loop`, `strings-remix` in
  s3-keep/strings-site2). Re-encode them at 480 px wide, about 150 KB each. With reduced motion, show the poster still.
- **Key:** a `1` / `2` / `3` key chip on the demo.
- **Text:** the name in caps (24/28 px) and the one line (16/18 px), wrapping to at most three lines.
- **Start:** one button, at least 44 px tall.
- **The mode you're in** shows a "Playing now" chip, and its button reads "You're here" (disabled).

**First run (mock `chooser`)** is the setup's last card (5 of 5 on a new install, 2 of 2 after an update):
- **Look:** the same full-window glass as Setup, widened to 1040 px.
- **Copy:** title "What are we playing?", line "Pick one. Switch any time from the top of the screen, or press M.", foot
  "Not sure? Start with SAUCE."
- **Default:** SAUCE has the focus ring.
- **Skipping:** "Skip setup" skips the questions, not this card. Esc on this card starts SAUCE.
- **Existing installs** (setup already done) see it once after WHAT'S NEW, right after "How do you play?" (§0). Key:
  `foxbox-mode-chosen`.

**The Island's Switch (mock 2):**
- Clicking the Island, Switch, or pressing M grows the Island into the chooser: 780 px wide, or 720 px in compact.
- The foot sits on its own row: "1, 2 or 3 to pick · Esc to close".
- **What leaves the open Island:** the old mode pills, the PLUCK · FLOW · LOOP row (PLUCK · FLOW stays in the Hands
  popover and on S) and the "notes release, the song pauses on the bar" foot. Those are behaviour, not instructions.

## 2 · The Island, collapsed

`[MODE] [status] [Switch M]`, all 16 px, on one 36 px row (mocks 3, 4, 5):

| Mode | Status |
|---|---|
| SAUCE | `PLUCK · ● C#4` (or FLOW) |
| MELODY | `Night Drive · 124` (`LINK` when linked) |
| REMIX | the four beat dots and `Bar 12`, or `No song yet` |
| any, while recording | the red dot and the clock |

The mode name is accent-soft, 800 weight. **Switch** replaces "SAUCE ⇄". It's a labelled button with its key.

## 3 · Entering a mode: a 3-step intro

**The card (mocks 3 and 5)** is the GUIDE's card and machinery (`Guide` / `GuideStep`):
- **Position:** right, above the dock. In MELODY it sits above LOOP's strip.
- **Demo:** S3's GuideHands, and the camera checks a step and moves on by itself.
- **Header:** the chapter, the count and "Skip". Back / Next.
- **Size:** the demo box is 196 px (down from 222) so the card fits above the strip at 1280×800. All its type is at least 16 px.

**When it shows:**
- On the first entry to each mode, after the chooser.
- **Remembered:** `foxbox-mode-intro` stores `{sauce, melody, remix}`. Skip and Esc count as seen.
- **Replay:** from the GUIDE panel (the ? panel's "GUIDE: MELODY") and from Settings → Help.
- **The full GUIDE (G) stays:** every move, for the curious. `useGuideFirstRun` opens the intro, not the full GUIDE.
- **Camera off:** the card waits ("Turn on the camera to start"), as the GUIDE does today.

| | SAUCE (CURL) | MELODY | REMIX |
|---|---|---|---|
| 1 | **Curve your hands into a C** · Turned a little toward the camera. The strings appear between them. (c-pose; done: both hands seen) | **It's already playing** · A melody loops on the beat. Your hands shape it. Want another? Press D. (🎲 Another one; done: hands seen, or Next) | **Load a song, or try the test beat** · Or drop a file on the window. L opens your library. (Load a song… · Try the test beat; done: the deck plays. Skipped if a song already plays) |
| 2 | **Curl a finger to pluck** · Higher hand, higher note. Now you try: play three notes. (pluck ×3) | **Right hand up for brighter, left hand up for higher** · Now you try: raise your right hand. (melody; right hand +0.25) | **Hold a fist for TEAROUT** · Locked to the beat. Raise it for more. (fist; fx tearout) |
| 3 | **Hold a frame to loop it** · An L with each hand loops the last 4 beats. Let go to stop. (frame; held 1 s) | **Close a fist to drop it** · It drops on the beat. Open up to bring it back. (fist; `loop.dropped`) | **Fold a finger to cut a band** · SUB · LOW · MID · HI-MID · HIGH. (fold; a cut > 0.5) |

**The other ways to play** (`stepsFor` by style, as today):
- **PALM**, step 2: **Tap the air with an open palm** · Like a drum pad. Higher hand, higher note. Play three.
- **ONE HAND**, step 1: **Curve one hand into a C** · Turned a little toward the camera.
- **ONE HAND**, step 3: **Hold one L to loop it** · It loops the last 4 beats. Let go to stop.

## 4 · One coach line at a time

After the intro, the stage says one thing at most (mock 4). S4's `SauceGuide` (b9bf218b) is the slot. It extends to
MELODY and REMIX, and the per-mode tips go into it as a queue.

**Priority** (the first that applies wins; nothing else shows):
1. **Blockers:** no graphics, too dark, the light hint. The camera-off alert is the stage's own.
2. **The intro card is open.** The card is the instruction, so the stage stays quiet.
3. **No hands seen** → the big centre coach: "Curve your hands into a C…". This is the only big one: it means "you can't play yet".
4. **Feedback on a move in progress:** a frame is held ("Hold to loop · let go to stop", "Pull wider for more").
5. **The mode's tip queue,** in the pill above the dock.
   - **Shown:** one at a time, each once ever, for 6 s or until it's done, at least 20 s apart.
   - **Started:** only after 20 s of playing.
   - **Replaces:** LOOP's rotating `loop.hint.*` and the "Make a frame…" how-to.

**The queues:**
- **SAUCE:** Twist a wrist to bend → Shake for vibrato → Press S for FLOW: your hand's height plays → Pick a sound: Sound
  in the dock, or 1–7 → More moves in the GUIDE · G
- **MELODY:** Spread your hands for space → Make a frame to add an effect → Drag the notes in the strip → More moves in the GUIDE · G
- **REMIX:** Jump to the drop: ← / → → Hold a frame to loop the last 4 beats → Hold the shaka 🤙 for your library → More moves in the GUIDE · G

**Storage:** `foxbox-coach-seen` holds the tip ids. A replayed intro doesn't reset it.

## 5 · Keys

| Key | Does |
|---|---|
| **M** | Opens or closes the chooser in the Island |
| **1 · 2 · 3** | Picks SAUCE · MELODY · REMIX **while the chooser is open** (outside it, 1–7 stay SAUCE's sounds) |
| **⌘1 · ⌘2 · ⌘3** | Goes straight to a mode from anywhere. Also in the menu bar (View → SAUCE / MELODY / REMIX), so it's discoverable. Free today: menu.ts uses only ⌘, and ⌘0/+/− |
| **S** | SAUCE: PLUCK ⇄ FLOW. No effect elsewhere |
| **D** | MELODY: a new melody (🎲). Today it's "SAUCE" |
| **G** | The full GUIDE for the mode you're in |
| **Esc** | Closes the chooser, then the rest as today |

**Update `keys()` in ModeSwitch.tsx to match:**
- M: "Switch mode";
- ⌘1–3: "SAUCE · MELODY · REMIX";
- S: "Play style: PLUCK ⇄ FLOW (SAUCE)";
- D: "🎲 A new melody (MELODY)".

## 6 · Copy and keys

The copy follows BRAND_VOICE: the step comes first, with one wink at most ("What are we playing?"). Nothing is under 16 px.
These are the new and changed `t()` keys. I'll write ES · PT · FR · DE · JA once the user OKs the English, so
nothing gets translated twice.

| Key | English |
|---|---|
| `modes.title` | What are we playing? |
| `modes.line` | Pick one. Switch any time from the top of the screen, or press M. |
| `modes.foot` | Not sure? Start with SAUCE. |
| `modes.sauce` · `modes.melody` · `modes.remix` | Pluck notes between your hands. · A loop plays. Your hands shape it. · Remix any song with your hands. |
| `modes.start` · `modes.here` · `modes.now` | Start · You're here · Playing now |
| `modes.windows` | Coming to Windows |
| `island.switch` (changed) | Switch |
| `island.pick` (replaces `island.foot`) | 1, 2 or 3 to pick · Esc to close |
| `island.noSong` | No song yet |
| `intro.sauce.1–3.title/text`, `intro.melody.1–3…`, `intro.remix.1–3…` | as in §3 (where a GUIDE key already says the same thing, reuse it) |
| `intro.palm.2…`, `intro.one.1…`, `intro.one.3…` | as in §3 |
| `intro.melody.another` | 🎲 Another one |
| `remix.loadSong` | Load a song… |
| `coach.tip.*` | the queues in §4 |
| `keys.mode` · `keys.modes` · `keys.style` (changed) · `keys.roll` (changed) | as in §5 |
| `menu.sauce` · `menu.melody` · `menu.remix` | SAUCE · MELODY · REMIX (stay English) |

## 7 · States

- **Camera off:** the chooser works. The intro waits with "Turn on the camera to start".
- **Recording:** switching saves the take, as today ("Take 3 saved").
- **The Board, a popover or the wheel open:** opening the chooser closes them (`closeAll`).
- **The GUIDE open:** Switch closes it, keeping its place.
- **Reduced motion:** the card demos show posters, the GuideHands draw their still, there's no slash, and the Island
  changes size without the spring.
- **Long languages:** the card line must wrap to three lines at most in the Island's 222 px cards (1280). Not checked
  yet, because the translations come after the user's OK. Check DE and JA at 1280×800 before the RC, as for 2.1.
- **A notched display, full screen:** the Island is the notch's black, and the open chooser hangs from it (mock 2 at 1512×982).

## 8 · Build notes for S4

- **The intro** reuses `Guide` / `GuideStep`:
  - `Chapter` grows `'sauce' | 'melody' | 'remix'` intros next to the full chapters;
  - the intro lists are short arrays alongside `playSteps` / `remixSteps`, reusing their `watch`es.
- **The chooser** is new: `ModeCards` (about 60 lines), hosted by `Setup` (a `cards()` entry with a custom body) and by
  `Island` (`data-open`).
- **The tip queue** is one small function in Shell next to `useSauceCoach`, reading `foxbox-coach-seen`.
- **The demos** are 5 webm at about 150 KB each, ~0.75 MB together, in `assets/modes/`: pluck (SAUCE and CURL),
  palm, one, loop and remix. They go in engine-code, not
  engine-runtime (no new dependencies).
- **The hand demos** in the mocks come from the app's own `drawGuideMove`, bundled with
  `esbuild <entry exporting drawGuideMove> --bundle --format=iife --global-name=GH` into `mode-entry/guide-hands.js`.

## Open question for the user

- **The first-run chooser's title.** "What are we playing?" carries the wink; the straight version is "Pick a mode to
  start". I recommend the wink.
