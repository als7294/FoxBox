# FoxBox UX audit (1.5.0, S5)

**Update (2026-09-29): every finding below is fixed** on `help/s5-ux`, apart from those listed under "Left" with the reason. The user overrode the report-only brief ("fix all your findings, in coordination with the PM"). Each fix is one commit tagged `S5 #n`, with typecheck and vitest passing, and S4 merged each batch into `session/s4-app`. The fix log is at the end.

Branch `help/s5-ux`. The first pass ran on `session/s4-app` 007b095. The second pass and the fix re-check ran on be63014 (S4's fixes merged in). REMIX is skipped (mid-build).

**Method**
- The dev build was driven over CDP with an isolated profile: a temp HOME, `FVWKS_SKIP_BOOT_UPDATE=1`, and a fake mic/camera. No real camera, mic or screen capture was used.
- CAMERA and the Setup scenarios ran against the mock engine in a sandboxed headless browser with a fake camera.
- Sizes checked: 1512×982 (the 14" default; CSS px = pt) and 1280×800 (the minimum window).
- Numbers come from in-page scripts:
  - text size and WCAG contrast per element (alpha composited);
  - the visual weight of each button (fill and edge contrast × size);
  - hit-target sizes;
  - a 45-step Tab walk comparing each element's style before and after focus;
  - axe-core 4.13 for the non-contrast rules.
- Each P0 below was measured twice, on both builds.

**Severity**
- **P0:** broken, blocks the main flow, or dangerous. Also P0 on the user's call: **text too small** and **button hierarchy**. And on the PM's call: **any on-screen home folder or absolute path**, because the act is anonymous (streams, screenshots, REC LIVE).
- **P1:** confusing, or a common-sense failure.
- **P2:** polish.

**Status:** OPEN, FIXED (re-checked on be63014), STILL BROKEN (re-checked, still there), or ROUTED (with S4).

Screenshots, from the dev build at 1280×800 with no private data: [studio](ux-audit/studio-1280.png), [rack open](ux-audit/rack-1280.png), [visuals](ux-audit/visuals-1280.png).

## P0

| # | Status | Where | What's wrong, and why it matters (a DJ prepping at home, in the dark, on a 14" MBP) | Smallest fix |
|---|---|---|---|---|
| 18 | FIXED ad1f9cd | **The page header repeats itself** (flagged by the user: "i hate the header and it's repetitive"). VISUALS, VAULT, VOICES, SETTINGS | Each page opened with a giant "0N / KICKER · TITLE" that repeats the rail, and VISUALS also showed BPM and KEY a second time (they're in the top bar), with an unlabeled OFF pill. That cost vertical space, above all VISUALS' stage. | ScreenHeader `compact`: only the screen's own controls, in a 34 px row, with an sr-only h1. VISUALS' live strip (LIVE OFF / ● LIVE, latency, IN/OUT, HEADPHONES) moves into the top bar, and the duplicates are gone. REMIX keeps the default header. |
| 4 | FIXED 653e90d | **Text too small.** All screens. `styles/tokens.css` has `--text-2xs` 9.5 px and `--text-xs` 10.5 px, and ~262 `font:` shorthands in the module CSS hard-code sizes under 11 px (104×10, 65×9.5, 40×9, 34×10.5, 15×8.5, 4×8), bypassing the tokens. | Measured twice. The smallest text on every screen is **7 px**. Share of text under 10 px: STUDIO 42–45%, rack open **55–56%**, VISUALS 44–49%, VAULT 27%, VOICES 32–35%, SETTINGS 32%. Under 11 px: 47–78%. About 30–54% is also letter-spaced all-caps mono, which reads smaller still. The worst offenders:<br>- the main nav labels (STUDIO, VISUALS…) are **9 px**;<br>- the VISUALS panel titles (AUDIO SOURCE, BASE, EXPORT) are **8.5 px**;<br>- 44 rack knob labels and values are 9 px;<br>- the cartridge DUR/BPM/KEY/LUFS and the arrange beat numbers are 8.5 px;<br>- the FX pad keys and lexicon SPELL are 8.5 px.<br><br>All of this is below the 10 pt floor of Apple's macOS text styles. In a dark room at arm's length, the labels that name every control can't be read. The app's own **Setup window already meets the bar**: smallest text 10–12 px, 0% under 10 px, no contrast failures. So can the dialogs (the shortcut sheet is ≥ 10 px). | Set an 11 px floor:<br>- raise `--text-2xs` to 11 px and `--text-xs` to 12 px;<br>- codemod the sub-11 px `font:` literals onto the tokens;<br>- cap the letter-spacing on small caps at about 0.08em.<br><br>Then re-check the fit at 1280×800 (the rack, VISUALS' left column and SETTINGS are the tight spots). |
| 13 | FIXED 0bb5f05 | **Button hierarchy, across screens.** TopBar, StudioScreen, LiveScreen, VaultScreen, VoicesScreen | Ranking every button by visual weight shows the loudest control is often not the screen's job:<br>- **STUDIO** has 18 filled controls. The loudest is the **OPEN RACK bar** (738×40, amber fill), then EXPORT (192×38 cream; "EXPORT AGAIN", in white, after an export), then RENDER (157×38 accent). The drawer toggle outshouts both real actions (and see #1).<br>- On **VAULT, VOICES and SETTINGS** the loudest control is the top-bar **RENDER ⌘↩**, which renders the Studio line from screens where no line is visible. The top bar alone carries 4 filled chips (AUTO bars, AIFF, CLUB, RENDER).<br>- **VAULT** with rows selected: EXPORT TO REKORDBOX PLAYLIST and the top-bar RENDER are both accent-filled.<br>- **VOICES:** GENERATE 3 (140×64 accent) competes with RENDER.<br>- **VISUALS MIC:** GO LIVE (274×32) and all 7 preset pads (83×38) are filled at the same weight. Recording the set (● REC) is a 56×26 grey outline, disabled, with the reason only in a tooltip.<br><br>When everything shouts, the DJ hunts for the one action that matters. | One filled primary per screen:<br>- RENDER on STUDIO; OPEN RACK becomes an outline bar;<br>- the top-bar RENDER is ghost, or hidden, off STUDIO;<br>- the preset pads become outline;<br>- REC LIVE gets the weight once audio is running. |
| 1 | FIXED 4cdcf3a | STUDIO → OUTPUT (`components/output/Cartridge.tsx`, `state/renderController.ts` `exportNow`) | RENDER already writes the final AIFF to the export folder ("FINAL RENDER COMPLETE"). EXPORT on the same file writes nothing new: it re-announces it, and after an export it becomes a bright "EXPORT AGAIN". That makes two loud primaries for one job, plus a third verb ("not printed yet", "⌘↵ PRINTS THE FILE"). | Once a final exists, turn the cartridge's big button into **DRAG / REVEAL**; move EXPORT (other formats) into ▾. Use one verb, RENDER, and drop "print". |
| 6 | FIXED 7fdf69d (the ARRANGE word handles: see Left) | **Important buttons too small, or out of sight.** `rack/PresetStrip`, `signal/ArrangeView`, `source/VoicePicker`, `layout/KeyPicker`, `rack/ModuleCard`, `visuals/EffectsPanel`, `VaultTable`, the stage bar, `LiveScreen` | Measured twice, against WCAG 2.2 2.5.8's 24×24 px minimum:<br>- rack **✦ SAVE: 40×12**, the only on-screen way to save a preset;<br>- the **arrange word handles: 6–33 px wide** ("We" and "are" are 6 px), which are the controls for placing words on the beat;<br>- voice list **"5 OF 28 · ALL": 101×13**;<br>- the top-bar **KEY** picker's hit area: 64×17;<br>- rack module headers 128×16, module on/off 34×18;<br>- effect layer on/off 26×16, and lock/▲/▼/**×** 22×22, with the destructive × beside the move arrows and no undo;<br>- VAULT checkboxes 14×14, palette swatches 18×18, VISUALS segment rows 20 px tall.<br><br>With the **CAMERA** base on, the left column grows and **SAVE CLIP / REC LIVE drop below the fold**, even at 1512×982. | Give each a min 24 px hit area through padding or a `::after` hit pad (no layout change). Move × away from ▲▼. Collapse the camera options, or pin EXPORT at the top of the left column. |
| 12a | FIXED | STUDIO EXPORT toast | It showed the full absolute path. Since 567724e it shows only the file name, with REVEAL kept. | — |
| 12b | FIXED (not re-driven) | EXPORT ▾ sheet toast (`ExportSheet.tsx:61`) | It showed the full path. It now goes through the toast-level `hideHome()`. | — |
| 12c | FIXED | VAULT → EXPORT TO REKORDBOX PLAYLIST steps dialog (`VaultScreen.tsx:281`) | It showed the XML's absolute path. It now shows only `guy-fvwks-drops_rekordbox.xml`. | — |
| 12d | FIXED | SETTINGS → EXPORT FOLDER field and its tooltip | Re-checked with the folder under `/Users/<name>/…`: it now shows `~/…`. | — |
| 12e | FIXED 6fb68bd | SETTINGS → ENGINE "free disk" (`SettingsScreen.tsx:835`, `title={health.data_dir}`) | Hovering shows the full `/Users/<name>/…` data path. Re-checked on be63014. | `title={hideHome(health.data_dir)}` |
| 12f | FIXED 6fb68bd | VISUALS → SAVE CLIP result (`components/clips/SavedClip.tsx:59`, `title={path ?? name}`) | Hovering the saved clip's name shows its full path. | `title={name}`, or `hideHome(path)` |
| 12g | FIXED (as far as tested) | Engine errors (`lastError` on the boot error screen, the SETTINGS engine row, the status chip, the banner, Setup) | A forced engine failure under `/Users/<name>/…` showed no path ("engine setup failed (Installing the engine (uv sync)…, exit error)"). `hideHome()` now covers engine and bridge errors. | — |
| 12h | FIXED (by design) | Error toasts with a raw `err.message` | They now pass through the toast-level `hideHome()`. A bad file drop shows only the file name ("Can't read notes.txt…"). | — |

## P1

| # | Status | Where | What's wrong | Smallest fix |
|---|---|---|---|---|
| 3 | FIXED 04c019f | STUDIO → SOURCE `● RECORD →` | It's a red record-styled pill in the tab row, but it jumps to VISUALS. The shortcut sheet still lists "Record (Record tab) R" and nothing for VISUALS (1–7 presets, A S D F G FX). The empty output still says "TYPE OR RECORD A LINE". | Make it a quiet link: "RECORD ON VISUALS →". Fix the ShortcutOverlay rows and the empty-state copy. |
| 5 | FIXED 6b46be1 (BAKE-IN PEAK stays dim: it's a disabled field) | Empty cartridge, SETTINGS LOUDNESS, rack module summaries, SIGNAL song hint, the stage bar | Contrast failures, measured twice (11–23 per screen state): the empty cartridge (NO DROP YET, DUR/BPM/KEY/LUFS, "TYPE OR RECORD A LINE, THEN RENDER") is **2.48:1**. BAKE-IN PEAK and dBFS are 2.25:1, and so are the rack's off-module summaries. The song hint (10 px), the arrange beat numbers, the aspect buttons and LINK are 3.9:1. This compounds #4. | Keep dimmed text at ≥ 4.5:1 (`--vb-dim` on panel, no extra opacity), and grey out only truly disabled controls. |
| 7 | FIXED b95b60b | Top bar, EFFECTS, ADD EFFECT, VOICE FX | "AUTO" means four things: BARS AUTO (fit the length), AUTO-VJ, "AUTO · every 4/8/16 bars" (Milkdrop cycling), and FX quantize AUTO. | Label them AUTO-VJ, CYCLE 4/8/16, and SNAP AUTO. |
| 8 | FIXED 4caa6b5 | VISUALS → AUDIO SOURCE (`LiveScreen.tsx` ~l.600) | Starting the source is ▶ START AUDIO, ● LISTEN or ● GO LIVE depending on the tab. START AUDIO is the filled primary even with no song, and does nothing visible. | Use one verb (START / STOP), and disable START on TRACK until a song is picked. |
| 9 | FIXED 1de8ae7 | VISUALS → EXPORT → SAVE CLIP copy | "Attach a song in the Studio…", although TRACK above now takes a picked or dropped song (one song across the app). | "Pick or drop a song (TRACK above)". |
| 11 | FIXED 6b84f13 | Save preset (`rack/SavePresetModal.tsx`), EXPORT ▾ (`output/ExportSheet.tsx`), Rekordbox steps (`feedback/StepsModal.tsx`) | These are still centred modals, although the user rejected modals. Save preset is the only sentence-case title ("Save preset"). | Name the preset inline in the rack's USER slot, and put the export options in an inline drawer under EXPORT. |
| 14 | FIXED 37da465 | Toasts, now top-right under the top bar | They cover the SIGNAL transport for ~5 s after every render or export: ▶ PLAY, A DRY / B WET, LOOP and CLICK, which is exactly what you reach for next. | Anchor them below the SIGNAL header row (top ≥ 120 px), or bottom-left. |
| 15 | FIXED 8abadcc (copy; the smart "use as the SONG" offer is in Left) | STUDIO IMPORT "DROP AUDIO" vs the SONG strip | Two drop targets take the same files with different meanings. A 35 s music file dropped on IMPORT's giant zone gets vocal-masked as a 21-bar "speech" line; the small SONG strip is where it belonged. | IMPORT copy: "DROP A VOICE TAKE". If the dropped file is long or musical, offer "Use as the SONG" inline. |
| 16 | FIXED 00b2743 | VISUALS TRACK card, STUDIO SONG strip | Dropping a file on TRACK now attaches the song, and a bad file gets an inline "Can't read notes.txt: use WAV, AIFF, FLAC, MP3 or M4A". But **dragging a file over TRACK shows no highlight**, the SONG strip's highlight is faint, and IMPORT's zone lights up for a .txt too. The "can't read" line is dim hint text, not an error colour. | Reuse ImportDropzone's drag-over style on TRACK and SONG, and give the can't-read line the warn tone. |
| 17 | FIXED 4caa6b5 | VISUALS voice panel | The FX pads (THROW…DROP OUT), MUTE, TAKE, REC SET and REC are disabled with no visible reason; most have no tooltip either. | One inline hint: "GO LIVE to use the pads and REC". |
| 2 | FIXED | STUDIO → `+ SETLIST` | It was a dead end while PROD is WIP. It's hidden since ad8ddf0. | — |
| 10 | FIXED | WHAT'S NEW at 1280×800 | LET'S GO was below the fold (y = 804). Since ad8ddf0 it's pinned (y 701–753). | — |

## P2

| Where | What | Fix |
|---|---|---|
| Rack header | "12 MODULES" over 13 numbered cards (01–13) | Count the cards |
| STUDIO macros | The SPACE card sits ~8 px lower than DEPTH, GRIT and MACHINE | Align the baselines |
| STUDIO empty | "6.86 S", "00.00 / 6.86" and "END 6.86s" show beside NO SIGNAL; the placeholder length looks like data | Show "—" until a signal exists |
| Truncation | "WAITING FOR YOU TO S…", RENDER → "SYNTH…" during a reconnect, "_Geiss - Artifact (", BLEND "SCREE", "THERMAL VOI…", model sizes "REQUIRED · 342 …", defaults BARS "A…" | Wrap, or give them a wider min-width |
| Engine reconnect | The preview says "SYNTHESIZING…" while the engine is down | "WAITING FOR ENGINE…" |
| Copy jargon and grammar | "Stretched 1.080x (R3)… Beat-Lock", "TP -1.0", "MASK SYNTHETIC", "F0 206 Hz", "McADAMS", the boot failure's "uv sync… exit error"; "1 BARS", "1 OF 1 DROPS", "1 tracks" | Plain words; pluralise |
| Same thing, two names | ▶ PLAY (STUDIO voice list) vs AUDITION (VOICES); RACK (STUDIO) vs PRESETS (VISUALS); render vs "print" | Pick one each |
| ARRANGE lane | The word chips overlap and truncate ("FAWKE", "EXPI US") | Min width, or stagger |
| VISUALS header | BPM and KEY are shown twice (top bar and stage strip); an unlabeled "OFF" pill | Keep one; label the pill |
| VISUALS aspect | Switching 9:16 ↔ 16:9 moves the EFFECTS and VOICE panels | Keep the panels fixed |
| ADD EFFECT → MILKDROP | 100 raw third-party preset names (underscores, "$$$", one crude title) with no preview | A curated list, cleaned names |
| Voice list → ALL | The selected voice isn't kept in view | Scroll to the selected voice |
| Script editor | After a relaunch, the last line shows as a ghost placeholder while SIGNAL says NO SIGNAL | A neutral placeholder |
| SETTINGS at 1280×800 | The sample-rate control is clipped by the card edge; the "Fields:" hint spills outside NAMING; a STUDIO DEFAULTS switch overlaps the UPDATES header; TP CEILING "-1" renders like "-\|" in the display font | Grid rows auto; the mono font for numbers |
| Tooltip-only | 27 VISUALS controls explain themselves only through a hover `title`; the palette swatches have no visible label | Short visible labels |
| Icons | Unicode glyphs stand in for icons (▶ ● ▸ ▾ ✦ ⠿ ☆ × ⏎ ⏸︎ ✺), up to 29 per screen, and render unevenly | One icon set |
| Casing | WHAT'S NEW card titles mix "AUTO-VJ" / "TEXT" with "Bass music" / "Camera" | Uppercase throughout |
| Rekordbox steps | "choose the file below", but the file is named above | "choose the file above" |
| Formats copy | IMPORT lists "WAV · AIFF · MP3 · M4A", but FLAC works (and TRACK's error lists FLAC) | Align the list |
| Song | The attached song is gone after a relaunch | Keep it, or say so |

**P2 status**
- Fixed in 25a265c:
  - plurals (1 DROP / 1 track / 1 BAR);
  - the Rekordbox steps wording;
  - WHAT'S NEW titles in one case;
  - ▶ Play on VOICES, as in the Studio;
  - the Studio strip is titled PRESETS;
  - plain engine-failure text.
- Fixed in a17b865:
  - the 13 MODULES count;
  - macro tops aligned;
  - WAITING FOR THE ENGINE… and TYPING…;
  - the loudness numbers in mono (no "-|");
  - ALL keeps the chosen voice in view.
- Fixed in ff857fe: the camera face-style chips wrap.
- Fixed in 653e90d: the SETTINGS clipping at 1280.
- Fixed in 8abadcc: the formats copy.
- Fixed in ad1f9cd: VISUALS' duplicate BPM/KEY and the OFF pill.
- Not findings after all:
  - the TP and MASK chips already explain themselves on hover;
  - the "ghost" placeholder is the line an empty editor renders;
  - the length shown before a render is the default 4-bar target (a tested design).

**The "Left" items: settled.** The user said "handle everything you can", so each has a decision and, where it needed one, a fix:
- **ARRANGE word handles:** fixed in 6287331. The lane picks the word nearest the pointer (inside its block or within 12 px), so every word can be grabbed and none is covered by a neighbour. ←/→ still works.
- **IMPORT "use as the SONG":** fixed in d78920e. A file of 30 s or more gets "35 s: a whole track? USE AS THE SONG →", which moves it to SONG, clears the import and returns to TYPE.
- **Milkdrop names:** fixed in a069f5e. No `_`/`$$$` prefixes, sorted by clean name, the crude title unlisted; slugs unchanged. S3 reviewed it: fine.
- **Song after relaunch:** fixed in ed3b484. It's remembered and restored from the engine; REMOVE forgets it.
- **Palette swatches:** fixed in c1bac3c. The chosen palette's name (EMBER…) shows beside them.
- **Arrange fit chip:** fixed in 7585f0a. A short form in a narrow header ("▲0.98×", "◇ WAIT", "⇥ BEAT"); the title keeps the full text.
- **VISUALS aspect switch:** kept as designed. The 1.5 spec asks for the largest possible stage in each aspect, so the panels re-flow.
- **Unicode glyph icons:** kept. They're part of the TRANSMISSION look, and swapping in an icon set would be a redesign.

## REMIX pass 1 (TAKES landed; editing not yet), 2026-09-29
REMIX is walked unstyled (Claude Design styles it later), so this checks flow, not looks. It ran in mock mode at 1280×800: pick a track → BUILD → + → R → 1 → ? → DELETE.

**Works**
- BUILD and ROLL wait for a track; the empty state says what to do.
- MASHUP says "Pick B, or LINE IT UP from MASH RADAR" inline.
- R rolls, 1–6 switch takes (with the PREPARING shimmer), + / − rate the current take, and the reasons and taste readout follow.
- DELETE is two-step ("DELETE?").
- The TAKES strip is fully visible at 1280×800, and no text is under 11 px.

| # | Sev | What | Fix (owner) |
|---|---|---|---|
| R1 | P1 · in S4's M3.2 (REMIX ShortcutsOverlay) | **? on REMIX lists the wrong keys.** It shows STUDIO/VISUALS keys, including "Presets 1–7" and "R · Record a take (VISUALS)", which mean something else here, and it misses R (roll), 1–6 (takes) and + / − (rate). | A REMIX section in the shortcut sheet, or the planned REMIX ShortcutsOverlay (S4) |
| R2 | P1 · FIXED (checked in-app) | **Two BPMs and keys on screen.** The top bar keeps STUDIO's BPM / KEY / BARS / AIFF / CLUB / RENDER on REMIX (e.g. Am), while the remix's transport shows its own (Fm). | Hide the Studio-only top-bar controls on REMIX, as on VISUALS (S4) |
| R3 | P1 · in S4's M3.2 | Every REMIX control is **21 px tall** (recipe tabs, BUILD, ROLL, take title, ☆, A/B, DELETE, M/S), under the 24 px rule in the REMIX brief. | `min-height: 24px` in remix.module.css (S4 / design) |
| R4 | P1 · FIXED (checked: chips are outside the cards; cards 113 px). The chips' own line: b7be8db (S4), so A/B and the readout no longer wrap | **Reason chips** inside a rated TakeCard stretch it to ~780 px, so six takes can't fit at 1280. | Done on my side: 2bc4b47, chips only for the current take. Remaining: render ReasonChips once, on a full-width line under the strip, not in `extra` (S4) |
| R5 | P2 · FIXED (compact header, kicker LAB) | The header reads "03 / STUDIO · REMIX": the kicker says STUDIO, and it's the big title the other screens dropped (#18). | The design package's call; at least fix the kicker (S4) |
| R6 | P2 | 40 low-contrast texts (unstyled grey on grey). | The design package |
| R7 | P2 · in S4's M3.2 | The bar ruler's "49" and "DROP 2" overlap. | Offset the drop label (S4) |
| R8 | P2 · needs a contract field (RemixTake.lufs, asked of the PM) | TakeCard has no loudness readout (brief §1: "−7.0 LUFS"). | S4 |
| R9 | P2 · moves with the design package | DELETE sits in the same row as A/B (the brief says away from the switch targets). The two-step softens this. | S4 / design |

## REMIX pass 2 (editing, M3.2), 2026-09-29
Run in mock mode at 1280×800: BUILD, then click-select, ⌘D, ⌫, ⌘Z / ⇧⌘Z, S, the KEYS list, and a keyboard-conflict sweep.

**Pass 1 re-checked:** R1 (the REMIX KEYS list), R2, R3 (24 px buttons), R4, R5 and R7 (the ruler) are all fixed.

**Works**
- The EditToolbar: UNDO / REDO / SPLIT have the keys in their tooltips; SNAP BAR / BEAT / 1/16 / OFF; zoom − / FIT / +; "KEYS ?".
- The REMIX KEYS list shows every REMIX key, inline, not as a dialog.
- Select, duplicate, delete, undo and redo work and keep UNDO / REDO accurate.
- REMIX claims SPACE and L, so the Studio player and loop don't react.

| # | Sev | What | Fix (owner) |
|---|---|---|---|
| R10 | **P0** | **The app-wide preset keys 1–7 navigate to STUDIO.** On VISUALS, where the pads say "PRESETS 1–7", a preset press mid-set leaves the stage, and the output freezes on its last frame (checked: 3 → STUDIO, preset ABYSS). On REMIX, 7 jumps to STUDIO and switches the Studio preset (to RAW). | App.tsx `run()`: ignore preset keys on REMIX; on VISUALS apply the preset without navigating (patch sent; S4) |
| R11 | P1 | Other Studio keys leak on REMIX: ⌘S jumps to STUDIO's save form; `\` silently flips the Studio A/B to dry. | Studio-only actions (save-preset, A/B, loop, metronome) act only on STUDIO (S4) |
| R12 | P2 | S with nothing to split (e.g. the playhead at 0:00) does nothing and says nothing. | A short "nothing to split here" note, or a flash on SPLIT (S4) |

## REMIX pass 3 (M3.5 HARDWARE look vs the design handoff), 2026-09-29
Run on S4's web mock (headless Chromium, 1512×982 and 1280×800) after the M3.5 timeline merge (5db5d4e), against `app/design/remix/README.md` and the prototype's STATES. Screenshots: `docs/ux-audit/remix-p3-1512.png` (2×, anatomy markers) and `remix-p3-1280.png` (compact). REMIX ALL and the TEAROUT card are hidden in 1.5 by design, so they aren't findings.

**Matches the handoff:**
- **Shell:** no top bar; the fox mark, engine status and ? sit at the foot of the rail.
- **Top row:** RecipeStrip with its status line (blocked reason in amber), BUILD with the 12-LED strip, ROLL with its TasteReadout.
- **Takes:** TakeCards (196×54, ▲ ★, the A/B chip, the key, style, seed · LUFS, PREPARING dims).
- **Rating row:** name · ▲ UP ▼ DOWN · 9 reason chips once rated · KEEP · A/B · RESET · DELETE…, two-step.
- **SourceSlot and timeline head:** ↶ ↷, SNAP, FOLLOW, `FIT · 72` or `4× · 18 BARS`.
- **Ruler:** labels every 16 bars at FIT and every 4 at 4×.
- **Anatomy markers:** at FIT, GAP ▸ and ◆ FIRST HIT as glyphs; at 2× all four with labels (GAP ▸, ◆ FIRST HIT, ‖ PAUSE, ⇄ SWITCH).
- **Timeline body:**
  - sections with LED stripes;
  - the section tool row ("2 SELECTED ◀ ▶ DUPLICATE SPLIT LOOP CUT… ESC"), with ← → moving the selection;
  - lanes in order, M/S, and SWAP ALL ▾ plus a gain fader on the selected lane;
  - PREPARING hatch with PREP / PREPARING labels;
  - the overview strip.
- **SWAP card:** docked at the top of the context panel with ← BACK.
- **BASS DNA:**
  - VIP BASS (HYBRID · RESAMPLE · ONE PATCH, with its explanation line);
  - GrooveRoll, WobbleLane with TRIP, BOUNCE/GROWL;
  - PatchPicker 3×2 tabs with ▶ 2s rows;
  - TOP (ARP · POWER-UP · COIN);
  - MacroKnob ×4 (GRIT · WOBBLE · SUB · GLIDE);
  - COMPARE.
- **MASH RADAR:** BORROW FROM B, the style chips, KEY-COMPATIBLE ONLY, the BPM range, and a result with its score ring, reason chips, ▶ PREVIEW and LINE IT UP.
- **GENRE FLIP:** cards with 16×2 kick/snare grids, KIT with ▶ 2s, SWING, DRUMS READ.
- **Export:** the inline drawer (four LED cards, NAME with preview, EXPORT 1), progress in the status display (EXPORTING → MIXING DOWN → WRITING FILES), then the tiles.
- **Keys:** the table is an inline region with every row of the README's table. R, L, ⌘↩, 1–6, + / −, ← →, ⌘= / ⌘0, ? and Esc all work.
- **Compact (1280×800):** VIP / MASHUP / FLIP; ORIG / T2 / T1; the transport drops the beat LEDs, meters and LUFS; the short status.
- **Global rules:**
  - no dialogs and no toasts on REMIX in any step;
  - the 11 px floor holds (0% of text under 11 px at both sizes);
  - a focus ring on every stop of a 40-step Tab walk;
  - contrast fails only on the PREPARING dims, which are by design.

| # | Sev | What | Fix (owner) |
|---|---|---|---|
| R13 | P1 | **Raw patch ids shown to the DJ.** SYNTH BASS clip tags read "hybrid:tearout" (ellipsized "hybrid:te…"), and the swap card's sub-line reads "NOW HYBRID:TEAROUT". The handoff has the sound name (e.g. "NOW WUB"). The default patch id isn't one of the picker's sounds, so nothing maps it. | Show the sound's display name; for a default `mode:family` id, show the family ("TEAROUT"). (S4) |
| R14 | P1 | **The status display prints raw developer errors, and they stick.** In the mock: "▲ NOT DONE Playback: @waveform-playlist/playout (and its peer `tone`) is required… Install with: npm install…", and with the deps pre-bundled, "Failed to construct 'BiquadFilterNode'…". The error stays until ✕, so it also hides the live position and other notices (no export-done notice showed). | Map playback and load errors to user copy ("▲ CAN'T PLAY · restart FoxBox"), log the detail, and time errors out like other notices or yield to newer ones. (S4) |
| R15 | P1 | **22 px targets** (the rule is 24): SNAP BAR / BEAT / 1/16, VIP BASS HYBRID / RESAMPLE / ONE PATCH, COMPARE OLD / NEW BASS. | `min-height: 24px` on those segmented options. (S4) |
| R16 | P2 | **The web mock can't play REMIX.** vite answers the dynamic `import('@waveform-playlist/playout')` with 504 Outdated Optimize Dep. With `optimizeDeps.include` for playout and tone, a second copy of Tone breaks the context (the BiquadFilterNode error). The packaged bundle includes the playout chunk; a packaged playback check follows once the heavy slot is free. | vite.web.config.ts (and the electron-vite renderer for dev): pre-bundle `@waveform-playlist/browser`, playout and tone together, or `resolve.dedupe: ['tone']`. (S4) |
| R17 | P2 | **Tabs without tabpanels:** 9 `role=tab` in 2 tablists, but no `role=tabpanel` and no `aria-controls` (the context panel and the PatchPicker families). | Add `role=tabpanel`, `aria-labelledby` and `aria-controls`. (S4) |
| R18 | P2 | **Compact mode:** DELETE… stays DELETE… below 1420w (the handoff says ✕). **Empty page:** the transport shows only PLAY, LOOP, the time and "PRESS BUILD" (the prototype keeps BPM, KEY, COMPARE, LINK and EXPORT, disabled), and the centre panel isn't the prototype's dashed drop zone. | Per the handoff. (S4) |
| R19 | P2 | **GENRE FLIP shows 5 cards; the handoff has 6.** TRAP-HYBRID is missing. Is it out of 1.5, like the TEAROUT card? | Confirm, or add it. (S4 / PM) |
| R20 | P2 | **MASH RADAR:** "5 TRACKS · 0 GOOD MATCHES" sits over a listed 72-score match, and the no-good-matches suggestions (WIDEN BPM, ALLOW KEY SHIFTS, ALL BASS STYLES) don't show. | Count close matches too ("0 GOOD · 1 CLOSE") and show the suggestions. (S4) |
| R21 | P2 | **Export:** there's no REVEAL beside the done tiles. The default name "SUBTERRANEAN VIP.aiff" doesn't say which take, where the handoff has `NIGHTSHIFT (RIDDIM VIP · TAKE 2).aiff`, so two takes export under one name. | Per the handoff. (S4) |
| R22 | P2 | **Smaller gaps:** a collapsed empty lane reads "EMPTY", not a hint of how to fill it. LINK shows in the REMIX transport although 1.5 hides LINK on REMIX (per S4). The mock's takes all have style MASHUP, so the TasteReadout reads "LEANS MASHUP" (mock data only). | S4 |

## Live-set safety, 2026-09-29
The question: can anything a DJ does by accident mid-set stop, freeze, black out or jump the stage output?

**Setup.** A packaged 1.5.0 built from help/s5-ux @ f2f550b, running as the `.test.s5` copy with a temp HOME and `FVWKS_SKIP_BOOT_UPDATE=1`. On VISUALS: TRACK playing the demo, its audio routed to a silent sink, and ▸ OUTPUT on. I counted the frames the output window actually shows per second (its `transferFromImageBitmap` calls).

**Limits.**
- This Mac has only its built-in display, so the output ran windowed. The external-display fullscreen cases come from the code.
- CDP can't press native menu accelerators (⌘W, ⌘Q, ⌘H, ⌘R, ⌘M), so those rows come from the menu roles in code.
- The run stopped early at the PM's call (the machine was under load). "Run" means measured; "code" means read from the code.

| # | Sev | Hazard: repro → what happens | Evidence | Owner file · smallest fix |
|---|---|---|---|---|
| LS1 | **P0 · fixed in e2dcf79** (re-run: the output kept drawing on STUDIO, 12 fps vs 0 before; the track kept playing) | **Leaving VISUALS freezes the output and stops the track.** With OUTPUT on and TRACK playing, any of these leaves VISUALS: a rail click (STUDIO, REMIX, VAULT, VOICES, SETTINGS), 1–7 (R10), ⌘S, ⌘↩, ⌘⇧E, or ⌘, (Settings…). The output drops from 41 fps to 0 and holds its last frame. The live engine closes, and on return the page reads LIVE OFF. The output resumes on return, but the track has to be restarted by hand. | run (each key and rail click) | `App.tsx:189-194` mounts LiveScreen only while the screen is `live`. Its unmount stops the stage and closes the LiveEngine (`LiveScreen.tsx:176-192, 282-290`). **Fix:** keep LiveScreen mounted but hidden while the output is open or the engine runs, outside the per-screen ErrorBoundary key. The top-slot portal must re-find its node on return. Cheap guard on top: ⌘S, ⌘↩ and ⌘⇧E don't navigate from VISUALS, like R10. (S4) |
| LS2 | **P0 · fixed in 0e852b3** (code-reviewed) | **⌘W, or the red close button, quits FoxBox mid-set.** With the main window in front: File ▸ Close (role `close`), or the traffic light next to the logo. The main window's `closed` handler closes the output, then `window-all-closed` calls `app.quit()`. No confirmation. | run: `window.close()` on the main window (the path ⌘W takes) quit the app; main.log: "quitting: stopping the engine" | `main/index.ts:262-266, 1070`. **Fix:** while the output is open or the engine runs, the main window's `close` asks first: "The visuals output is live." with [Keep running] as the default and [Quit] as the other choice. (S4) |
| LS3 | **P0 · fixed in 0e852b3** (code-reviewed) | **⌘Q quits with no confirmation while the output is live.** | code | `main/index.ts:1072` (`before-quit`). **Fix:** the same prompt as LS2, one helper. (S4) |
| LS4 | **P0 · fixed in 0e852b3** (code-reviewed) | **⌘H hides every FoxBox window, the output included.** The projector then shows the desktop. | code (`role: 'appMenu'` includes Hide ⌘H) | `main/menu.ts:21`. **Fix:** build the app menu by hand and keep Hide FoxBox without ⌘H, at least while the output is open. (S4) |
| LS5 | **P0 · fixed in 0e852b3** (code-reviewed) | **The displays sleep mid-set, the projector included.** A DJ playing on CDJs doesn't touch the laptop. With the output on and a track playing, FoxBox holds no display-sleep assertion: `pmset -g assertions` shows PreventUserIdleDisplaySleep 0 and lists no FoxBox process. This Mac's display sleep is 10 min, and the screen saver can start first. | run | `main/index.ts` `openOutput()` has no `powerSaveBlocker`. **Fix:** call `powerSaveBlocker.start('prevent-display-sleep')` when the output opens, and `stop()` in its `closed`. (S4) |
| LS6 | **P0 · fixed in 0e852b3** (code-reviewed) | **Esc in the output window closes the output, and the output window takes focus when it opens.** Click ▸ OUTPUT, then press Esc. Or click the projector picture once (the cursor disappears over it) and press Esc. The output closes, and on a projector the desktop shows. While the output has focus, Space, the FX keys and R do nothing, and ⌘W / ⌘M close or minimize the output instead of the main window. | run (Esc closed the output mid-run) + code (`win.show()` gives focus) | `OutputWindow.tsx:37-41`, `main/index.ts:374-377`. **Fix:** open it with `win.showInactive()`, and on an external display ignore Esc. Keep Esc only when the output covers the controls' own display, where it is the way out. (S4) |
| LS7 | **P0 · fixed in 0e852b3** (code-reviewed) | **⌘R reloads the app mid-set.** View ▸ Reload (role `reload`) ships in packaged builds too. The main renderer restarts: boot screen, then STUDIO (the screen isn't persisted, `state/ui.ts:61`). The output holds its last frame until VISUALS is reopened, and TRACK has to be restarted. With the output window in focus, ⌘R reloads the output instead: black until it's back. | code | `main/menu.ts:42`. **Fix:** Reload, Force Reload and DevTools in dev builds only. (S4) |
| LS8 | P1 | **A file dropped on the SONG strip replaces the playing song.** For example, a track drag that misses Rekordbox. Run: "foxbox-demo" became "demo". Code: the old deck is stopped and disposed, and the new one waits for ▶ PLAY. Stray drops anywhere else are safe (run: nothing changed). | run + code | `LiveSongStrip.tsx` drop props, `LiveScreen.tsx:176-192`. **Fix:** while the deck plays, a drop queues the song ("LOADS ON STOP") instead of replacing it. (S4) |
| LS9 | **P0 · fixed in cea5d5c** (runtime check pending) | **SAVE CLIP freezes the output for the whole render.** Run: RENDER 0:35 with the output on → 0 fps for the render ("Rendered in 46 s" at load ~6). The 14 min I first reported included ~13 min of the Mac asleep (pmset: Sleep 07:54:35 → DarkWake 08:07:57 local); nothing in FoxBox held the pause past the render. S4's fix: while the output is open, the stage draws at 30 fps during a render. The VISUALS stage pauses while a clip renders, and the output window only shows frames the stage sends, so the projector holds one frame until the clip is done. The comment at `CompositeStage.tsx:74` ("the output window keeps drawing") dates from before the output stopped drawing itself. Deliberate, but it holds the projector for the whole render. | run + code | `CompositeStage.tsx:74-78`. **Fix:** while the output is open, keep the stage drawing during a render (e.g. at 30 fps), or disable RENDER with "OUTPUT is live: SAVE CLIP would pause it". (S4) |
| LS10 | P1 | **Unplugging or replugging the projector isn't handled.** Main has no `display-removed` / `display-added` listener. On unplug, macOS moves the fullscreen output onto the laptop display, over the controls, with the cursor hidden over it. On replug it stays there, and the projector shows the desktop until OUTPUT is turned off and on. VISUALS also reads the display list only once (`VisualsStage.tsx:74-79`). | code (one display here) | `main/index.ts`. **Fix:** remember the output's display. When that display is removed, close the output and say "PROJECTOR UNPLUGGED" on the page. When it comes back, reopen the output on it. Send the display list whenever it changes. (S4) |
| LS11 | P1 | **CAMERA without camera access puts "CAMERA OFF" on the projector.** Pick BASE ▸ CAMERA with access denied, or hit the first-time macOS prompt mid-set. The base draws the plain palette ground while it waits, then a "CAMERA OFF" card into the stage, which the audience sees. | code (no TCC prompts in tests) | `smartCameraBase.ts` (open, then the `quietCard`). **Fix:** if the camera can't open, keep the previous base on stage and say why in the BASE panel only. Ask for access when CAMERA is first picked with the output off. (S1) |
| LS12 | P2 | **No WebGL context-loss handling.** A GPU reset (wake from sleep, a display change) or Chromium's cap of about 16 contexts (the base, each effect, and a SAVE CLIP render's own set) leaves that layer black until it's picked again. | code | `compositorEngine.ts`, `engines/isf`, `engines/milkdrop`. **Fix:** on `webglcontextlost`, mark the layer gone and rebuild it on the next frame. (S4) |
| LS13 | P2 | **After a sleep or an audio-device change, nothing watches the live AudioContext.** It is resumed once at start and never again. | code | `audio/live/engine.ts:180`. **Fix:** `ctx.onstatechange` resumes it when it isn't running or closed. (S2) |
| LS14 | P2 | **⌃⌘F with the output window in focus takes the output out of fullscreen,** so the menu-bar strip shows on the projector. | code | LS6's `showInactive()` covers it. |
| LS15 | P1 · **fixed in cea5d5c** (re-run: "● LIVE 32 MS IN OUT" is back after STUDIO → VISUALS; the output held 39–51 fps) | **After leaving VISUALS and coming back, the top bar's LIVE strip is gone** (a regression from e2dcf79). Run: STUDIO → VISUALS with TRACK playing leaves the top slot empty (0 children). TopBar renders a new slot node on each visit (`TopBar.tsx:133`), but LiveScreen, now mounted once, looks the slot up only on mount (`LiveScreen.tsx:85`). | run + code | **Fix:** re-find the node when VISUALS is shown: `const onPage = useUi((u) => u.screen === 'live'); useEffect(() => setTopSlot(onPage ? document.getElementById(TOP_SLOT_ID) : null), [onPage])`. (S4) |

**Safe (run):**
- Space: push-to-talk on VISUALS; the stage and the track carry on.
- Tab and the arrow keys: palette and aspect held.
- ? and Esc on the main window: the overlay only.
- ⌘+ / ⌘− / ⌘0: page zoom only. The output stays 1080×1920 at the same fps.
- A stray file drop: nothing happens.
- ⌘N: nothing is bound to it.

**Engine failure (run):** SIGKILL on the engine mid-track. The output kept drawing (12 fps), the track kept playing, a "RECONNECTING" note showed, and the engine was ready again 2.6 s later. Safe.

**Covered main window (run):** the output window resized over the whole main window. The output went 13 → 11 fps (main-window rAF 15 → 12), so covering FoxBox doesn't throttle it. The low baseline was machine load (1-min load ~6 from other sessions' jobs). The output's frame rate follows load, 55–60 fps on a quiet machine and ~12 here, but it never stalled.

**Test conditions:** the runs happened while the Mac was lid-closed in DarkWake. pmset shows "Dark Wake Thermal Emergency" sleeps at 08:11, 08:31 and 08:51 local, and run 3's SAVE CLIP sampling was cut by the 08:51 one. GPU runs wait for a full wake with the lid open.

**0e852b3 review notes:** the quit confirm is a synchronous dialog, which blocks the main process while it's up (the output's frames go renderer to renderer, so they should keep coming; to check). Nit: the packaged View menu now starts with a separator.

**Still to run** (after S2's heavy job, per the PM):
- LS9's fix: the output during a render.
- LS2/LS3's confirm, and whether the output keeps drawing while it's up.
- LS5's display-sleep assertion.
- The PM will ask the user to press ⌘H, ⌘M (the output with the main window minimized) and ⌘R. CDP can't press menu keys, and a main-process inspector on the test copy was refused as a security weakening, so LS4 and LS7 stay code-only.

## Key issues: second pass (per screen, both window sizes)

| Screen / state | Smallest | < 10 px | < 11 px | Contrast fails | Filled buttons | Loudest control | Key hit targets < 24 px |
|---|---|---|---|---|---|---|---|
| STUDIO (preview) | 7 px | 45% / 42% | 62% / 60% | 11 | 18 | OPEN RACK 738×40 | SAVE 40×12, ALL 101×13, word handles 6–33 px wide |
| STUDIO (rack open) | 7 px | 56% / 55% | 68% / 67% | 23 / 19 | 21 | OPEN RACK | module headers ×16 px, module switches 34×18 |
| VISUALS (MIC) | 7 px | 49% / 47% | 73% / 72% | 4 | 19 | GO LIVE, 7 preset pads | swatches 18×18, segments 20 px, layer × 22×22 |
| VISUALS (TRACK) | 7 px | 44% / 44% | 78% / 78% | 4 | 9 | START AUDIO (no song) | as MIC |
| VAULT | 7 px | 27% / 28% | 53% / 53% | 2 | 5 | top-bar RENDER | checkboxes 14×14 |
| VOICES | 7 px | 32% / 35% | 47% / 51% | 2 | 6 | GENERATE 3, RENDER | SPELL 43×20, RECOMMENDED/ALL 20 px |
| SETTINGS | 7 px | 32% / 32% | 48% / 48% | 4 | 7 | top-bar RENDER | switch rows 22 px |
| Engine offline | 7 px | 36% / 33% | 59% / 56% | 15 / 14 | 7 | RENDER (engine offline), RECONNECT | segments 20 px |
| Setup window (benchmark) | 10–12 px | 0% | 0–3% | 0 | 1 | START / INSTALL | none |

Where a cell has two values, they are 1512×982 / 1280×800.

## Top 10 quick wins (high value, small diff)
1. **Type floor at 11 px:** raise `--text-2xs` and `--text-xs`, and codemod the ~262 sub-11 px `font:` literals onto the tokens. It's mechanical; then do one fit pass at 1280×800. (#4, P0)
2. **One filled primary per screen:** OPEN RACK becomes an outline; the top-bar RENDER is ghost off STUDIO; after a final, the cartridge's EXPORT becomes DRAG/REVEAL. (#13, #1, P0)
3. **24 px minimum hit areas** through padding or a `::after` hit pad: SAVE, ALL, KEY, the word handles, the module headers and switches, the effect-layer buttons, the checkboxes and the swatches. (#6, P0)
4. **The last two path tooltips:** `hideHome()` at `SettingsScreen.tsx:835` and `SavedClip.tsx:59`, two lines. (#12e/f, P0)
5. **Toasts below the SIGNAL header**, so PLAY, A/B and LOOP stay clickable. (#14)
6. **Dim text at ≥ 4.5:1:** no extra opacity on `--vb-dim` for labels (the empty cartridge, BAKE-IN PEAK, module summaries). (#5)
7. **Rename the four AUTOs:** AUTO-VJ, CYCLE 4·8·16, SNAP. (#7)
8. **VISUALS start:** one verb; START disabled until there's a song; an inline reason on the disabled pads and REC; the SAVE CLIP copy. (#8, #9, #17)
9. **RECORD → as a quiet link**, "RECORD ON VISUALS →", and fix the shortcut sheet. (#3)
10. **Drop-zone clarity:** IMPORT copy "DROP A VOICE TAKE"; the drag-over highlight on TRACK and SONG. (#15, #16)

## Passes (worth keeping)
- **Focus:** the Tab walk shows a visible focus change on every control except the script editor, where the caret is the cue.
- **Accessible names:** axe (non-contrast rules) finds 1 moderate issue in the whole app: an unnamed duplicate landmark on VISUALS.
- **`prefers-reduced-motion`:** the running CSS animations drop from 1 to 0 on STUDIO and during screen changes.
- **Stray file drops** never blank the app: the navigation lock, plus be63014's no-drop guard.
- **Engine crash:** SIGKILL → RECONNECTING → ready in about 4 s, and the typed line then previewed with no user action.
- **VAULT delete** is a two-step (CONFIRM DELETE n) and keeps the exported files.
- **PROD** is properly disabled (`aria-disabled`).
- **Setup** meets the type and hierarchy bar (see the table), and shows the models folder as `~/…`.

## AI-UI mistake checklist (from the sources below): FoxBox result
| Typical mistake of generated UIs | FoxBox |
|---|---|
| Important buttons too small | **Fails**, #6 |
| Several equally loud primary buttons / unclear hierarchy | **Fails**, #13, #1 |
| Tiny, low-contrast grey text | **Fails**, #4, #5 |
| Same action, different names; same name, different actions | Fails: #7, #8, P2 |
| Dead-end or do-nothing actions | Partly fixed: #2 fixed; #8 open |
| Modals where inline would do | Fails, #11 |
| Tooltip-only explanations, hover-only controls | Fails (P2): 27 on VISUALS |
| Status shown by colour alone | Mostly passes: states carry text (READY, OFFLINE, STALE); the LOW/MID/HIGH legend is colour plus text |
| Missing states (empty, loading, error, offline) | Passes where checked: the empty STUDIO and OUTPUT, the empty EFFECTS, persona candidates, reconnect, engine offline, the boot failure |
| Missing focus rings | Passes |
| No reduced-motion support | Passes |
| Unicode glyphs as icons | Fails (P2) |

Sources:
- [21st.dev review checklist](https://21st.dev/blog/ai-generated-ui-review-checklist)
- [Pre-ship checklist for AI UI](https://uxskill.laithjunaidy.com/blog/ai-ui-design-review-checklist.html)
- [15 AI UI mistakes (gendesigns)](https://gendesigns.ai/blog/ai-generated-ui-mistakes-how-to-fix)
- [AI slop in UX design (Foundey)](https://foundey.com/blog/ai-slop-in-ux-design)
- [AI slop web design guide (925 Studios)](https://www.925studios.co/blog/ai-slop-web-design-guide)
- [5 worst UI mistakes vibe coders make](https://www.skillsui.app/blog/worst-ui-design-mistakes-vibe-coders-make)

## Fix log (help/s5-ux; S4 merged each batch)
| Commit | Finding |
|---|---|
| 6fb68bd | #12e/f: path tooltips via hideHome |
| 653e90d | #4: the 11 px type floor (`--vb-text-min`), 261 literals, fit pass (SETTINGS rows, rack labels, VISUALS chips, VOICES meta) |
| 0bb5f05 | #13: one filled primary per screen (quiet RENDER off STUDIO, quiet OPEN RACK, REC red when armed) |
| 4cdcf3a | #1: RENDER writes the file; the cartridge's EXPORT… opens the options |
| ad1f9cd | #18 (user): no repetitive page header; the VISUALS live strip is in the top bar |
| 7fdf69d | #6: 24 px hit areas; the VISUALS EXPORT card is sticky |
| 37da465 | #14: no render toast; toasts clear of the transport |
| 00b2743 | #16: song drop targets (TRACK dashed target; can't-read line in amber) |
| 04c019f | #3: RECORD → as a link; the shortcut sheet lists the VISUALS keys |
| b95b60b | #7: AUTO-VJ / CYCLE / EACH (BARS AUTO unchanged) |
| 4caa6b5 | #8 + #17: START/STOP TRACK · INPUT · MIC; START TRACK needs a song; disabled controls say why |
| 1de8ae7 | #9: SAVE CLIP points at TRACK |
| 6b46be1 | #5: dimmed text ≥ 4.5:1 |
| 8abadcc | #15: DROP A VOICE; songs → SONG |
| 6b84f13 | #11: no modals (save preset, export options, Rekordbox steps inline; Modal.tsx removed) |
| 25a265c | P2: copy (plurals, one name per thing, engine failure) |
| a17b865 | P2: layout and states |
| ff857fe | P2: camera chips wrap |
| 6287331 | #6 follow-up: ARRANGE nearest-word pick |
| 7585f0a | P2: the fit chip fits (short form in a narrow header) |
| c1bac3c | P2: the palette name beside the swatches |
| a069f5e | P2: Milkdrop display names (S3 reviewed) |
| ed3b484 | P2: the song survives a relaunch |
| d78920e | #15 follow-up: IMPORT's "USE AS THE SONG" offer |
