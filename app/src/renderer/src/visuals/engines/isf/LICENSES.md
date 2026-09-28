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
