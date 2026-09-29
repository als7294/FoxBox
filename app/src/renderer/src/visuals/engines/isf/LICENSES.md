# SHADERS pack: licenses and sources

Every shader FoxBox ships in `shaders/` is recorded here. The pack is strictly MIT / CC0 / Apache-2.0. A shader whose
license or source is unclear is left out, including ports of glslsandbox or Shadertoy code, whose default license is
CC BY-NC-SA. Today every shader is original work written for FoxBox, released under MIT so it can travel as ISF.

| File | What it does | Source | License |
|---|---|---|---|
| `beat-rings.fs` | A ring leaves the centre on every beat; the bar's downbeat rings wider. | Original, written for FoxBox | MIT |
| `drop-flash.fs` | A calm field until the drop, then a wide flash that fades over the bar. | Original, written for FoxBox | MIT |
| `fog.fs` | Slow drifting fog lit from below by the lows. | Original, written for FoxBox | MIT |
| `glitch-blocks.fs` | Scanlines that tear into displaced blocks on each onset. | Original, written for FoxBox | MIT |
| `hex-lattice.fs` | A hexagon lattice, each ring of cells lit by its part of the spectrum. | Original, written for FoxBox | MIT |
| `kaleido.fs` | Kaleidoscope of drifting noise; the highs add mirror segments. | Original, written for FoxBox | MIT |
| `metaballs.fs` | Five blobs orbiting and merging; the bands size them. | Original, written for FoxBox | MIT |
| `plasma.fs` | A slow palette plasma; the level speeds it up. | Original, written for FoxBox | MIT |
| `radial-ring.fs` | A ring drawn by the spectrum around the centre; it swells with the lows. | Original, written for FoxBox | MIT |
| `scope.fs` | A CRT trace of the spectrum over soft scanlines. | Original, written for FoxBox | MIT |
| `spectrum-bars.fs` | Mirrored spectrum bars from the centre, accent to amber. | Original, written for FoxBox | MIT |
| `starfield.fs` | Stars streaming out of the centre; faster with the level, a burst on each onset. | Original, written for FoxBox | MIT |
| `synth-grid.fs` | A perspective floor grid scrolling on the beat under a glowing horizon. | Original, written for FoxBox | MIT |
| `tunnel.fs` | A ring tunnel moving on the beat; it brightens with the level. | Original, written for FoxBox | MIT |
| `voice-core.fs` | An orb sized by the voice, with a halo that follows the song. | Original, written for FoxBox | MIT |
| `vortex.fs` | A spiral that twists tighter with the mids. | Original, written for FoxBox | MIT |


### Filters (1.4: they transform the picture beneath, ISF `inputImage`)

| File | What it does | Source | License |
|---|---|---|---|
| `filters/datamosh.fs` | Blocks hold on to the previous frames and drift, more of them on each hit (a datamosh look). | Original, written for FoxBox | MIT |
| `filters/edge-glow.fs` | Outlines glow in the accent colour over a darkened picture; brighter on hits. | Original, written for FoxBox | MIT |
| `filters/feedback-trails.fs` | Echoing trails: each frame keeps a slowly zooming, fading copy of the last, longer with the level. | Original, written for FoxBox | MIT |
| `filters/halftone.fs` | A print halftone: dots sized by brightness, the screen turning slowly with the beat. | Original, written for FoxBox | MIT |
| `filters/kaleido-mirror.fs` | Mirrors the picture into a kaleidoscope; the highs add segments. | Original, written for FoxBox | MIT |
| `filters/pixel-sort.fs` | Bright pixels melt upwards in streaks, longer with the level (a pixel-sort look). | Original, written for FoxBox | MIT |
| `filters/rgb-split.fs` | Splits red and blue apart; wider on each hit. | Original, written for FoxBox | MIT |
| `filters/thermal.fs` | A thermal camera: brightness through ice, accent, amber to white; hotter with the level. | Original, written for FoxBox | MIT |
| `filters/vhs.fs` | Worn tape: tracking wobble on hits, colour bleed, scanlines and noise. | Original, written for FoxBox | MIT |
| `filters/zoom-pulse.fs` | Punches in on every hit and breathes with the beat. | Original, written for FoxBox | MIT |
| `filters/depth-focus.fs` | Depth focus: the near subject (S1's near mask) sharp, the rest racked out of focus through a build. | Original, written for FoxBox | MIT |
| `filters/motion-trails.fs` | Motion trails: only what moves leaves a trail (frame difference). | Original, written for FoxBox | MIT |
| `filters/palette-from-image.fs` | Palette from image: repaints the picture in its own main colours (Color Thief) and shares them. | Original, written for FoxBox | MIT |
| `filters/beat-strobe.fs` | Beat strobe: flashes on beats and drop hits, at most 3 a second. | Original, written for FoxBox | MIT |
| `filters/bass-wobble.fs` | Bass wobble: the wobble LFO warps the picture, a held sub stretches it. | Original, written for FoxBox | MIT |

## MIT license (the shaders above)

Copyright (c) 2026 SmittyTech

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

(Here "the Software" means the shader files listed above.)

## Adding a shader

Add a row above with its source URL and license (MIT, CC0 or Apache-2.0 only), and keep the author's notice in the
file's CREDIT. User shaders (imported into `<data dir>/shaders/`) stay on that Mac and aren't part of the pack.
