# TouchDesigner presets (1.6)

Each folder here is one look on VISUALS → BASE → TOUCHDESIGNER. **Every one draws on the person: their body and their
hands** (the user's rule; `app/tests/unit/main/tdSession.test.ts` fails a preset that doesn't declare and read both). Add a folder and FoxBox picks it up: it builds one
GLSL TOP per preset into its TouchDesigner network (`../foxbox_setup.py`, through `app/src/main/bridge/tdProject.ts`),
lists it in the panel, and sends its index as `/foxbox/td_preset`. Folders sort by `order`, then name.

Preview without the app: `cd app && npx electron ../touchdesigner/dev/preview.cjs [ids...]` (its own hidden
TouchDesigner, a DJ clip as the camera; PNGs per preset).

## v3: a preset is a TouchDesigner network (`<id>/build.py`)

The user's rule: effects are TouchDesigner workflows. A preset folder holds `preset.json` and a `build.py` that builds
its network out of TouchDesigner operators (a GLSL TOP is fine as one node, not as the whole effect). FoxBox's
`foxbox_setup.py` runs it inside the preset's own Base COMP, `comp`, which already holds the standard inputs:

| Operator | | |
| --- | --- | --- |
| `in_cam` | TOP | the camera, cover-fitted to 1280 × 720 (upright), the person matte in its alpha |
| `in_matte` | TOP | the person matte as grey |
| `in_ch` | CHOP | every FoxBox channel by name: `kick`, `snare`, `dropenergy`, `beat`, `beatphase`, `kickcount`, … |
| `in_shapes` | CHOP | the hands' shapes: `hlon hron hlgest hrgest hlpinch hlopen hlfingers hrpinch hropen hrfingers apart fsize triangle fheld` |
| `in_body` / `in_hands` / `in_face` / `in_frame` | CHOP | one sample a point (33 / 42: left 0–20, right 21–41 / 28 / the FRAME's 4): `u v` the picture's uv (y up, after the cover fit: where it is in out1), `tx ty tz` the same in world units for `ortho()`, `on` 0/1 |
| `in_body_pts` / `in_hands_pts` / `in_face_pts` / `in_frame_pts` | SOP | the same as points (CHOP to SOP) |
| `out1` | Out TOP | the build connects its picture here: `comp.op('out1').inputConnectors[0].connect(last)` |

`comp`'s parameters are the design's play controls (app/design/visuals-td §B), live: `Intensity`, `Colour`, `Chaos`,
`Trails`, `Lines`, `Size` (0–1, FoxBox's knobs with their reacts-to already applied, sent as `/foxbox/knob_<name>`), the
palette's three stops `Bg`, `Ink`, `Accent` (rgb: `parent().par.Inkr` …; EMBER, ICE, TOXIC, BONE or VOID by
`/foxbox/palette`), and `Active`. Read them by expression from the operators you make (`parent().par.Trails`).

What `build.py` gets besides `comp` and `preset` (its preset.json): `setp(node, par, value, expr=False)` (notes a
parameter this TouchDesigner doesn't have), `place`, `W`, `H`, and every TouchDesigner global, plus these helpers:
- `ortho(parent)`: an orthographic camera whose world is the points' `tx ty`; `render(parent, name, geometry, camera)`.
- `shader(parent, name, code, inputs, header=False)`: a GLSL TOP node (`header=True` adds the shader helpers below);
  `uniforms(glsl, vecs, arrays)`; `track` (the tracking CHOPs, for a GLSL node's arrays).
- `skeleton(parent, name, material, parts)`: the bones as lines (a numpy CHOP of segment ends, CHOP to POP: no Python
  geometry a frame); `instances(parent, name, picks, size, material, shape)`: a circle or bracket on chosen points;
  `bare_geo(parent, name, material)`.
- `glow(parent, name, src, intensity, res='quarter')`: Bloom on what's bright, at `res`, added back with its alpha.
- `windows(parent, name, wins)` and `WINDOW_DESK` (S3's): desktop windows from a CHOP of centres and sizes.
touchdesigner/dev/td-2025.33230-params.json lists the parameter and menu names of the operators in the user's build;
`python3 touchdesigner/dev/check_build.py [ids]` checks a build offline against it.

The budget: 12 ms of cooking a frame at 1280 x 720 (preview.cjs reports each preset's, its dearest operators, fps,
frame intervals, flashes a second and motion). Python that runs every frame is the dear part: keep it to one numpy
script a preset, or native operators. Only the preset showing cooks; its Feedback TOPs reset when it's switched to, and
every preset's Feedback and Texture 3D TOPs reset when MASK FIRST switches (`/foxbox/maskfirst`: no trail may keep an
unmasked face). What reaches FoxBox is laid over opaque black. A build that raises shows the camera, and the error is in
the preview's `errors`. No `'''` in build.py (use `"""`).

`preset.json` for a v3 preset: `label`, `title`, `how`, `order`, `mode` (`"body"` or `"hands"`: the design's BODY / HANDS
switch), `tracks` (`["body", "hands"]`: the build reads `in_body*` and a hands input), `sound`, and optionally
`gestures` and `new`. The v1–2 fields
(`macros`, `reacts_to`, `palette`, `feedback`) are for `frag.glsl` presets only. Example: `databody/`.

## `<id>/preset.json`

| Field | | |
| --- | --- | --- |
| `label` | string | the chip, caps, 20 characters at most |
| `title` | string | one sentence, the chip's tooltip |
| `how` | string | how to play it, 60 characters at most, shown under its name: "Raise your hands to bend the tunnel" |
| `order` | number | the chips' order, lowest first |
| `tracks` | `["body", "hands"]` | required, and the frag must read a body and a hand accessor (below) |
| `macros` | `[{id, label, default}]` | 0 to 4 sliders, 0..1, as `uMacro.x/y/z/w` in this order |
| `reacts_to` | string | a `TE_CHANNELS` name (`app/src/shared/touchengine.ts`): its value is `uReact.x` |
| `palette` | `["#rrggbb", ...]` | up to 4 colours, as `uPal0`..`uPal3` |
| `feedback` | bool | wires `prev(uv)`: this preset's own last output |
| `sound` | `null` or `{changes_sound, map}` | drives the track's live FX (S2): see below |
| `gestures` | `{pinch_pull, open_palm, fist}` | optional, any preset: the look's defaults for PROD's gesture map (the user's own pick for the look wins). `pinch_pull`: `new_window`, `portal`, `pluck` or `nothing`; `open_palm`: `clear`, `randomize` or `nothing`; `fist`: `freeze`, `blackout` or `nothing`. A key left out keeps the design's default; an unknown value is dropped |
| `new` | bool | optional, any preset: PROD's NEW tag on its tile |

`sound.map` entries: `{target, source, min, max, curve, smooth_ms?, dead?}`, value = min + (max − min) ·
curve(source); `dead` (0–0.5) is a dead zone at the source's bottom (around the middle for `gesture.head_tilt`), so
dancing in place doesn't move the mix.

- **target:** `fx.filter`, `fx.resonance`, `fx.echo`, `fx.echo_beats`, `fx.stutter`, `fx.stutter_div`, `fx.tape`,
  `fx.crush`, `fx.wash`, `fx.pan`.
- **source:** `macro.<id>`, `ch.<TE_CHANNELS name>`, `gesture.hand_height | head_tilt | jaw_open | motion`.
- **curve:** `lin`, `exp` or `gate`. Several entries on one target take the highest.

## `<id>/frag.glsl`

One fragment shader: 1280 × 720, 8-bit RGBA. No Python and no other operators. FoxBox prepends the header (don't
redeclare it). Write `fragColor = TDOutputSwizzle(vec4(rgb, 1.0));`. `vUV.st` is the screen, y up; everything arrives
upright.

| Uniform | |
| --- | --- |
| `uAudio` | kick envelope, snare envelope, drop energy, seconds |
| `uGrid` | beat count, beat phase, kick count, snare count |
| `uCam` | x: someone found (0 or 1) |
| `uMacro` | the macros, 0..1 |
| `uReact` | x: the REACTS TO channel |
| `uPal0`..`uPal3` | the palette (rgba, 0..1) |
| `uPts[32]` | the face's landmarks: 0..1 of the camera frame, y down, x < 0 is off |
| `uBody[33]` | BlazePose's 33: x, y (camera frame, y down), z visibility; x < 0 is off |
| `uHands[42]` | the hands, MediaPipe's 21 each: 0–20 the left of the screen, 21–41 the right; x < 0 is off |
| `uHand` | left on, right on, left gesture, right gesture (0 none, 1 fist, 2 open, 3 point, 4 thumbs-up, 5 thumbs-down, 6 victory, 7 love) |
| `uShapeL`, `uShapeR` | pinch 0..1, open 0..1, fingers up 0–5 |
| `uShape` | hands apart (0..1 of the width), FRAME size (0 unless held), TRIANGLE 0/1, FRAME held 0/1 |
| `uFrame[4]` | the FRAME's corners while held, clockwise from the top-left (camera frame); x < 0 none |

The body and the hands arrive at 10–15 Hz and are eased per frame in TouchDesigner (they snap when they appear).
Sides are the screen's (the camera isn't mirrored), and a hand keeps its side while hands cross.

`uPts` with a face: 0–11 the outline, clockwise from the forehead; 12–15 the brows; 16–21 the eyes (right outer,
right inner, right lid, left inner, left outer, left lid); 22 between the eyes; 23 the nose tip; 24–27 the mouth
(left corner, right corner, upper, lower). With no face: the body's nose, eyes, ears, mouth and shoulders, if seen.

Helpers (screen uv in and out, y up; distances in screen heights, aspect-corrected, 1e3 when there's nothing):

- **The body:** `joint(i)` (joint i on screen), `jointOn(i)` (visible ≥ 0.5), `bones(uv)` (distance to the arms and
  torso: shoulders 11–12, elbows 13–14, wrists 15–16, hips 23–24), `bone(uv, a, b)`.
- **The hands:** `handPt(side, i)` (side 0 left, 1 right; i in MediaPipe's 21: tips 4, 8, 12, 16, 20; 9 the middle
  knuckle), `handOn(side)`, `fingers(uv)` (distance to every finger bone of both hands), `nearestHand(uv)` (vec2:
  distance, side; side −1 with no hands).
- **Shapes:** `frameHeld()`, `frameCorner(i)`, `inFrame(uv)`; the pinch, open and fingers in `uShapeL` / `uShapeR`.
- `scr(uv)`: uv with x scaled by the aspect (for your own distances).
- `cam(uv)`: the camera's colour at a screen point (cover fit, black before its first frame). `hasCam()`.
- `person(uv)`: 0..1, the person matte; 0 with no camera or before the first matte.
- `ptToUV(pt)`: a landmark → screen uv.
- `prev(uv)`: with `"feedback": true` only. 8-bit: fade with a subtraction too (`prev * 0.96 - 0.004`), or the tail
  never quite goes.
- `hash(vec2)`, `noise(vec2)`, `fbm(vec2)`, `segment(p, a, b)` (distance to a line), `digit(int d, vec2 c)` (a 3×5
  glyph in a 0..1 box).

TouchDesigner's free licence is non-commercial: every picture from it carries FoxBox's DEMO label.
