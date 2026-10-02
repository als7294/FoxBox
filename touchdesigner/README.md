# FoxBox ⇄ TouchDesigner (the free route, 1.6)

[TouchDesigner](https://derivative.ca) is separate software that you install yourself. Its free licence is
non-commercial, so FoxBox labels everything it draws **TOUCHDESIGNER · DEMO · NON-COMMERCIAL, NOT COPYRIGHT-SAFE**,
in the corner of every picture and in the BASE panel. The free licence also caps the picture at 1280 × 1280, and
FoxBox's network renders at 1280 × 720. FoxBox never bundles TouchDesigner, and works fully without it.

## Use it

1. **VISUALS → BASE → TOUCHDESIGNER**, then **SET UP TOUCHDESIGNER**. The panel walks a checklist, inline:
   - **Installed:** finds TouchDesigner and its version. If it's missing: *Get TouchDesigner (free)*; FoxBox notices
     by itself once it's installed.
   - **FoxBox patch built:** FoxBox writes `FoxBox.toe` as TouchDesigner's text form (`app/src/main/bridge/tdProject.ts`)
     into its data folder and collapses it with your TouchDesigner's own `toecollapse`. Nothing to copy or paste.
   - **Activated:** FoxBox opens its own hidden TouchDesigner with `FoxBox.toe`; on start that runs `foxbox_setup.py`,
     which builds `/project1/foxbox` and writes `status.json` back. If it never reports (your TouchDesigner is waiting on
     its first sign-in), the panel says *Open TouchDesigner once and sign in*, and carries on by itself once you have.
   - **Connected:** its Syphon picture arrives. The presets unlock.
2. **From then on,** picking the base runs the same steps without the button. FoxBox never opens TouchDesigner at app
   start, quits only the TouchDesigner it opened (OSC `/foxbox/quit`, then its pid) when the base changes, and never
   touches one you opened yourself.
3. **Presets** (in the panel once it's live):
   - **THRESHOLD + PLEXUS:** black, white and red, with glowing numbered points joined by lines.
   - **WINDOW MOSAIC:** the frame built from small windows that pop on the beat.

## How it's wired

| | Port / name | What |
| --- | --- | --- |
| FoxBox → TD | UDP 7000 | the channels, one OSC bundle a frame: `/foxbox/<name>` for each of `app/src/shared/touchengine.ts`'s `TE_CHANNELS` (rms, low, mid, high, onset, kick/snare/hat envelopes and counts, bpm, beat, beatphase, bar, barphase, section, build, predrop, dropin, drop, dropenergy, dropcount, the stems and their hits, voice), the macros, and `/foxbox/td_preset` |
| FoxBox → TD | UDP 7002 | text and control: `/foxbox/word`, `/sectionname`, `/preset`, and `/foxbox/quit` |
| TD → FoxBox | UDP 7001 | controls, as in 1.3: `/foxbox/preset <id>`, `/macro/<name> <0..1>`, `/fx/<name>`, `/ptt <0\|1>` |
| TD → FoxBox | Syphon `FoxBox` | the picture (a Syphon Spout Out TOP). FoxBox receives it zero-copy (`app/native/syphon`) and shows it on the stage and the output window |

Text goes on its own port because a TouchDesigner OSC In CHOP and an OSC In DAT can't share one.
