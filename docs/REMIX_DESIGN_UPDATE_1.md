# Claude Design update 1: FoxBox REMIX (only what's new since the final prompt)

**How to use it:** paste everything below the line into the same Claude Design chat that's running the REMIX page. It lists changes only. Everything in `REMIX_DESIGN_PROMPT.md` still stands unless this update changes it.

---

**REMIX brief, update 1.** This only covers changes. Everything in the earlier brief still stands unless it's changed here. Keep every existing component name; new names are listed at the end. The earlier rules all still apply: no page title, 11 px text floor, 4.5:1 contrast, 24 px hit areas, no modals, file names only (never paths), and no AI or "generate" wording.

**The big shift.** REMIX is now "a lite DAW, not a toy". It should make **tons of different remixes of any track** quickly, and then let you shape the one you like. The DJ's own priority order:
1. TAKES / ROLL;
2. editing the arrangement;
3. swapping sounds per clip.

A full mixer comes later.

### 1. TAKES and ROLL (new, top priority)
- **Every BUILD makes a take.** Each take has a number and a seed, e.g. `TAKE 3 · SEED 4821` (in JetBrains Mono).
  - The same seed always rebuilds the same take.
  - A new seed is a new take: different voices, drum variations, switch-ups and pauses, from the same recipe.
- **ROLL** makes another take of the same recipe with a new seed. It's the main creative loop: BUILD → listen → ROLL, ROLL → keep the best. ROLL sits next to BUILD and is just as easy to reach, but it's the secondary button: BUILD stays the one ember primary.
- **TAKES strip** (TakesStrip, with a TakeCard for each take):
  - It holds about 6 takes, and switching between them is instant (they're already prepared).
  - Each TakeCard shows the number, seed, style, a loudness readout (`−7.0 LUFS`) and its rating (§2). It shimmers with PREPARING while it builds.
  - Actions: A/B any two takes, star to keep, rename, and delete (two steps, placed away from the switch targets).
  - Keys: **R** rolls, **1–6** jump to a take.
- Placement is your call (the top row, or above the timeline), but the strip must be visible at 1280×800 with nothing scrolling.

### 2. Rate a take (new; ROLL leans toward what you rate up)
- **On every TakeCard:** thumbs up / thumbs down (TakeRating), then optional **reason chips** (ReasonChip): GROWLS · RHYTHM · MIX · ARRANGEMENT · SOUNDS LIKE TRAP · TOO LONG · WHINY · BORING · LOVE IT.
- **Keyboard-first:** **+** and **−** rate the current take, then the chips are one click each. Inline only, never a dialog.
- **What ratings do:** ROLL then favours the options you rated up. This is plain counting over designed options, not AI, so never call it AI, "smart" or "learning".
  - Show it quietly: a small **TasteReadout**, e.g. "ROLL leans on 12 ratings · RIDDIM".
  - **RESET** clears the ratings for one style, in two steps.

### 3. Lite-DAW editing (new)
- **Gestures:**

  | Action | Keys / how |
  |---|---|
  | Undo / redo | ⌘Z / ⇧⌘Z |
  | Multi-select | shift-click, or drag a box |
  | Copy / paste / duplicate (sections and clips) | ⌘C / ⌘V / ⌘D |
  | Split at the playhead | S |
  | Delete | ⌫ |
  | Snap | BAR / BEAT / 1/16, as a segmented control |
  | Zoom | ⌘+ / ⌘−, plus FIT |
  | Loop region | L |

- **Design:** a compact **EditToolbar** (undo/redo, SnapControl, ZoomControl), multi-clip selection states, the split cursor, and a **ShortcutsOverlay** (the **?** key) that lists every key.
- Editing stays instant. Only a new sound re-prepares a clip (unchanged).

### 4. SWAP SOUND per clip (changed: it moves from the lane to the clip)
- Click a bass clip to open an inline **SwapSoundPopover** (glass is allowed on this small popover).
  - It shows sound families → sounds, each with a 2 s audition.
  - Picking one re-prepares **only that clip**, with the PREPARING shimmer on that clip. It takes about 1 s.
- On a drum clip, the popover swaps the kit instead.
- The lane's SwapMenu stays, as "swap every clip on this lane".

### 5. Sounds: the patch picker changes
- FoxBox now designs its own bass voices: synths and resampling, no AI and no samples of other artists. PatchPicker tabs become **TEAROUT · RIDDIM · 808 · WOBBLE · REESE · GROWL**:

  | Tab | Sounds |
  |---|---|
  | TEAROUT (new) | CHOMP, TALKER, DISPERSER (machine gun), DIVE, PWM RESO, METAL: short metallic hits |
  | RIDDIM | WUB (square-FM), YOI (formant), plus the library's riddim sounds |
  | 808 | 808 LINE (held, with glides), DARK HIT (a drop's first hit), plus the library 808s |
  | WOBBLE / REESE / GROWL | as before |

- The 17 library sounds from the first brief stay, sorted into these tabs. Each keeps its SURGE or FOXBOX tag and a 2 s audition.
- **New small section: TOP (ear candy)** holds ARP, POWER-UP and COIN: 8-bit hooks in the track's key that sit above the bass.
- The macro knobs (GRIT, WOBBLE, SUB, GLIDE) are unchanged.

### 6. Styles (changed)
- **The three headline sounds:**
  - **TEAROUT:** short metallic "gun-shot" hits in call and response, with real silence between them.
  - **RIDDIM:** one repeating wub, minimal, over a kick/clap groove.
  - **TRAP-HYBRID:** the track's own held 808, with gritty hip-hop drums and hat rolls.
- **GENRE FLIP cards:** TRAP-HYBRID and RIDDIM first, then HALF-TIME, 140 DUBSTEP, FOUR-ON-THE-FLOOR, DNB.
- **VIP / DROP SWAP gets a BASS row with three modes:**
  - **HYBRID** (default): the track's held 808 stays, and designed growls (e.g. TEAROUT) answer it.
  - **RESAMPLE:** the track's own bass is chopped into new hits in a style (TEAROUT or RIDDIM).
  - **ONE PATCH:** the original way, where one patch plays the groove.
- Never show artist names in the UI.

### 7. The drop anatomy (new markers on the timeline)
The engine now follows the DJ's drop rules. Show them so the edits make sense:
- **GAP:** at most about 1 beat of silence right before each drop. **No breakdown is inserted:** the original pre-drop hook plays, then the gap, then the new drop.
- **FIRST HIT:** the drop's first bass hit is always the hardest: an impact plus a dark, long first note.
- **PAUSE:** a 1–2 beat pause inside a drop (around bar 8 or 12), for effect.
- **SWITCH:** switch-ups every 4 or 8 bars; TRAP-HYBRID has a 2-beat switch-up.

Design small labelled markers (GapMarker, FirstHitMarker, PauseMarker, SwitchMarker) on the ruler or the DropMarker. They're read-only in 1.5, but design them so dragging can come later. Colour-blind safe, always labelled.
- BREAK blocks still exist for the song's own breaks.

### 8. The bass reads as layers
- **"The sub holds, the mids chop."**
  - In HYBRID and RESAMPLE takes, the **BASS** lane keeps the song's long held 808 (bars lasting seconds).
  - **SYNTH BASS** carries the short growl hits above it.
  - Design the pair so the picture reads at a glance: long bars under short hits.
- The BOUNCE curve (sidechain) is unchanged; it now dips at every kick **and** snare.

### 9. REMIX ALL (new, batch)
- Multi-select tracks in "pick a track" → **REMIX ALL** → one take per track, as queued jobs.
- **RemixAllQueue:** an inline list with per-track progress, living in the ProgressStrip or the bottom drawer. You can keep working meanwhile.
- The results arrive as takes on each track.

### 10. Smaller changes
- **Kits:** every kit in KitPicker gets a 2 s audition, like patches. The FOXBOX KIT is rebuilt (layered kick, clap-led snare).
- **Loudness:** every take is mastered club-safe (−7 LUFS short-term, −1 dBTP). Show it on the TakeCard and in the transport readout, in the style of STUDIO's LoudnessMeter.
- **Mixer:** later. Keep per-lane gain, mute and solo as in the first brief, and don't design a mixer page.

**Elsewhere in FoxBox since the first brief (context only, don't redesign these):**
- No modals anywhere now. Save preset, export options and the rekordbox steps all live inline in their panels.
- Palette swatches show their names (EMBER, ICE…).
- Chips wrap instead of cutting words off.
- The camera's FACE ENCRYPTION picker gained + MASK, TEMPLATE and REMOVE (the user's own SVG/PNG/WebP masks), and the FOX mask is now lit in 3D.

**New component names:** TakesStrip, TakeCard, RollButton, TakeRating, ReasonChip, TasteReadout, EditToolbar, SnapControl, ZoomControl, ShortcutsOverlay, SwapSoundPopover, GapMarker, FirstHitMarker, PauseMarker, SwitchMarker, RemixAllQueue.

**Add to the deliverables:**
1. The TAKES strip with 4–6 takes: one PREPARING, one rated up with chips, one starred, and A/B active.
2. The SwapSoundPopover open on a growl clip.
3. Multi-select with the EditToolbar, plus the ShortcutsOverlay.
4. The drop anatomy markers on a real drop.
5. The REMIX ALL queue mid-run.
6. The updated PatchPicker tabs and the VIP BASS row.
7. A prototype pass: BUILD → ROLL twice → rate take 2 up (GROWLS) → switch to take 2 → swap one clip's sound → export.
