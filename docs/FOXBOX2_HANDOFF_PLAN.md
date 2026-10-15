# Applying the FoxBox 2.0 Claude Design handoff

The handoff is `app/design/foxbox-2/` (README.md is the spec; `foxbox-tokens.css`; prototypes `FoxBox Island.dc.html`, `FoxBox Onboarding.dc.html`; screenshots). The prototypes load React/Babel from unpkg, so they are design references only and never ship.

## The user's ruling: design for looks, chat for behaviour
- **The design wins** on layout, colours, type (Geist + Geist Mono, OFL), radii, motion, copy and structure.
  - That covers the notch Island, dock + popovers, Board, settings window, NotePop, launch screen, paused-waveform fox and library half-dome.
  - The primary mode is now called **SAUCE** (was PLAY). Internal code names may stay.
  - The note ladder and trail are gone (NotePop replaces them).
- **Chat decisions win** on behaviour where the two differ:
  - **Release** is the fast **glass fracture** (~140 ms, ~40 refracting shards, a glass-break sound), not the design's 6 shards over 0.85 s.
  - **The flip side stays:** turning the frame over card-flips to the style's partner, with the loop reversed.
  - **Frame styles:** the design's six front styles, ECHO TRAIL (Echo), PRISM (Shimmer), HALFTONE (Bitcrush), KALEIDO (Chorus), DATAMOSH (Glitch) and THERMAL (Warm drive), each with a flip-side partner (S2 + S3 pick the six partners from ICE, X-RAY, MIRROR and new ones).
  - **SAUCE's frame latches** (make it again to release); REMIX's is held; a pinch while framed never plucks or wobbles.
  - Camera always on, except REMIX with a Visual on (the design's own rule: "Camera hidden · hands still tracked").

## Owners
| Session | Work |
|---|---|
| S4 | Everything DOM: launch, Island, Dock, popovers (Sound, Melody, Hands + Edit shapes UI, Visual, Record, Song, Beat FX), Board UI, settings window, NotePop, toasts/badges, the library source bar; tokens + bundled Geist fonts; keys (adds F, V, B); PLAY → SAUCE copy; the GUIDE restyled after the onboarding motion. |
| S3 | WebGL/canvas: the `--string-*` / `--frame-*` mapping; the frame pane per the design (edge, bloom, name + effect pill, "4 beats · pinch to change", a sweep per loop, a pulse per beat) with the glass fracture and flip card; VISUALS (Off/Camera, Bars, Halo, Silk, Grain, Scope); REMIX's glass waveform, the wheel's fold into a red line, and the paused fox. |
| S2 | Audio: the Board parameters as an API (SAUCE tone/shape/motion/output; REMIX stems, bands, master); the 5 design presets (Night hook, Kitsune, Low rider, Lantern, Rolled) with an 8-note sequence; frame audio for the 6 styles plus partners; the library ring reshaped into the design's half-dome of square sleeves rising out of the waveform (Ring only; skip Halo unless asked). |
| S1 | A shape → action remap API (for Edit shapes, per mode), a left-handed layout (swap hand roles), pluck sensitivity. |
| S5 | A compact 1280×800 pass for the dock and library bar (not designed yet; propose in the design's language), then the audit of the build against the handoff using the generated hand clips. |
