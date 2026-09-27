# Claude Design handoff: "Motion-focused UI design"
_Added by the coordinator. The user delivered this bundle on 2026-09-26 as the approved frontend design. The export included no README, so this note stands in for one._

## Files
| File | What it is | Use it for |
|---|---|---|
| `VoiceBox.dc.html` | The design itself, as a Claude Design canvas (`<x-dc>`, `{{ }}` bindings, `<sc-if>`, and an inline `text/x-dc` component script). The frame presets are fluid, 1512×982 and 1280×800. | **The spec**: layout, spacing, colour, type, states, and the copy on every screen. |
| `voicebox-engine.js` | The prototype's motion and visual engine (`window.VB`). It defines the two themes (`transmission` = default, `dossier`), the preset macro positions, and the canvas drawing and animation (noise, reveals, meters). It honours `prefers-reduced-motion`. | **Port the visuals and motion into React.** Reuse its drawing and animation code where it fits: it was generated for this project. Don't ship its fake audio or state logic; the real engine replaces those. |
| `support.js` | The generated Claude Design runtime. It loads React 18, ReactDOM and Babel from unpkg. | Previewing only. **Don't ship it.** |
| `uploads/*.md` | Our two briefs, unchanged. | Reference. |
| `.thumbnail` | WebP preview. | n/a |

## Preview the prototype locally (needs internet for unpkg and Google Fonts)
`cd app/design && python3 -m http.server 8777`, then open `http://localhost:8777/VoiceBox.dc.html`, or screenshot it with Playwright to keep reference images for a visual comparison.

## Implementation rules
- **Fonts:** Big Shoulders Display and JetBrains Mono for `transmission`; Courier Prime and Saira Stencil One for `dossier`. All four are OFL. **Bundle them locally as woff2** (no Google Fonts CDN in the app; CSP).
- **Tokens:** lift the theme values from `voicebox-engine.js` `THEMES` into CSS variables (`--vb-bg`, `--vb-panel`, `--vb-ink`, `--vb-dim`, `--vb-accent`, `--vb-amber`, `--vb-font-mono`, `--vb-font-display`). Offer both themes, with `transmission` as the default and a theme switch in SETTINGS.
- **Engine-driven content:**
  - Real engine data replaces the prototype's mock data: rack from `GET /api/rack`, presets, voices, library.
  - Keep the generic ModuleCard, now styled from the design.
  - Macro rings come from each preset's `macro_map`.
- **Motion:**
  - Keep the reveals and meter/waveform motion.
  - Respect `prefers-reduced-motion`.
  - Nothing may block input or add latency to the render loop.
  - Canvas animation runs on requestAnimationFrame and pauses when hidden.
- **Keep what already works:** component names, the IPC proxy, `vbx://` audio, drag-out, shortcuts, and all e2e tests. Update the selectors if the DOM changes.
