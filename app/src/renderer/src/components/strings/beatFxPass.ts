/**
 * The beat FX's one pass (beatFx.ts says which, how much and where on the grid): the strings' transparent layer through
 * a WebGL2 shader, warped and gated as the FX perform, both hands' at once; and under them, subtly, how the hands hold
 * the strings (S1's TENSION, TILT, SHAKE, spec v1.1): slack they droop and dim, taut they go tight and bright, the
 * 808's slide moves their glow up or down, a shake trembles them. Only while an FX shows or both hands are seen (else
 * the layer goes through untouched). Premultiplied in and out. The user: "should be super subtle": clean, taut lines
 * that shimmer, not wave; every move a hint of a few px, WOBBLE shown mostly by the glow and colour pulsing at the
 * LFO's rate. No flashes; RIDDIM gates by segment so the light stays about the same.
 */
import type { FxFrame, StringFeel } from './beatFx'

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uRes;
uniform vec2 uC;          // between the hands, 0-1 y down
uniform ivec2 uMode;      // per slot: 0 none, 1 tearout, 2 riddim, 3 wobble, 4 growl, 5 halftime, 6 subdrop, 7 buildroll
uniform vec2 uAmt, uPhase, uStep, uBuild;
uniform float uSnap, uTime;
uniform vec4 uFeel;       // tension 0-1, tilt -1..1 (clockwise +), shake 0-1, on (both hands seen)
out vec4 o;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

vec2 warp(vec2 uv, int mode, float amt, float ph, float st, float build) {
  vec2 d = uv - uC;
  if (mode == 3) {                       // WOBBLE: a hint of a travelling sine at the LFO's rate (the glow carries it)
    uv.y += amt * 0.006 * sin(6.28318 * (uv.x * 2.0 - ph));
  } else if (mode == 4) {                // GROWL: vowel mouths, a e i o u through the period
    float open[5] = float[5](0.9, 0.5, 0.25, 0.75, 0.4);
    float wide[5] = float[5](0.45, 0.55, 0.6, 0.3, 0.22);
    float v = ph * 5.0;
    int i = int(floor(v)) % 5;
    int j = (i + 1) % 5;
    float f = smoothstep(0.0, 1.0, fract(v));
    float op = mix(open[i], open[j], f);
    float wd = mix(wide[i], wide[j], f);
    float k = 1.0 - pow(clamp(abs(d.x) / wd, 0.0, 1.0), 2.0);
    uv.y = uC.y + d.y / (1.0 + amt * op * 0.7 * k);
  } else if (mode == 6) {                // SUB DROP: they sag and drop, half as tall
    float k = 1.0 - pow(clamp(abs(d.x) / 0.6, 0.0, 1.0), 2.0);
    uv.y -= amt * (0.025 + 0.04 * k);
    uv.y = uC.y + (uv.y - uC.y) * (1.0 + 0.3 * amt);
  } else if (mode == 7) {                // BUILD ROLL: tighter and quicker as it builds
    uv.y = uC.y + (uv.y - uC.y) * (1.0 + 0.45 * amt * build);
    uv.y += amt * (0.0015 + 0.0045 * build) * sin(uv.x * 90.0 + uTime * (20.0 + 170.0 * build));
  } else if (mode == 1) {                // TEAROUT: torn into blocks, each jolted its own way on the grid (jagged edges)
    float bs = mix(4.0, 22.0, amt) / uRes.y;
    vec2 cell = floor(vec2(uv.x * uRes.x / uRes.y, uv.y) / bs);
    uv += amt * vec2(0.01, 0.004) * (vec2(hash(cell + st), hash(cell.yx + st * 1.7)) - 0.5);
  }
  return uv;
}

vec4 shade(vec4 c, vec2 uv, int mode, float amt, float st, float ph) {
  if (mode == 2) {                       // RIDDIM: segments gated in the chop pattern
    float on = step(0.42, hash(vec2(floor(uv.x * 14.0), st + 3.0)));
    c *= mix(1.0, on, amt);
  } else if (mode == 1) {                // TEAROUT: crushed
    float lv = mix(48.0, 3.0, amt);
    c = floor(c * lv + 0.5) / lv;
  } else if (mode == 5) {                // HALFTIME: heavier
    c.rgb *= 1.0 + 0.25 * amt;
  } else if (mode == 3) {                // WOBBLE: the glow and the colour pulse at the LFO's rate (warmer on its peaks)
    float lfo = 0.5 + 0.5 * sin(6.28318 * ph);
    c.rgb = mix(c.rgb, c.rgb * vec3(1.25, 0.95, 0.75), 0.6 * amt * lfo) * (1.0 + 0.3 * amt * lfo);
  }
  return c;
}

void main() {
  vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1.0 - gl_FragCoord.y / uRes.y);
  // BUILD ROLL's SNAP: a burst outward that settles, and a ring
  if (uSnap > 0.0) {
    vec2 d = uv - uC;
    uv = uC + d * (1.0 - 0.15 * uSnap * sin(uSnap * 3.14159));
    uv.y += 0.01 * uSnap * sin(length(d) * 40.0 - (1.0 - uSnap) * 24.0);
  }
  if (uFeel.w > 0.5) {                   // how the hands hold them, under the FX
    float k = 1.0 - pow(clamp(abs(uv.x - uC.x) / 0.6, 0.0, 1.0), 2.0);
    uv.y -= (1.0 - uFeel.x) * 0.015 * k;                        // slack: they droop
    uv.y = uC.y + (uv.y - uC.y) * (1.0 + 0.06 * uFeel.x);       // taut: tighter
    uv.y += uFeel.z * 0.002 * sin(uv.x * 120.0 + uTime * 45.0); // a shake: they tremble
  }
  uv = warp(uv, uMode.y, uAmt.y, uPhase.y, uStep.y, uBuild.y);
  uv = warp(uv, uMode.x, uAmt.x, uPhase.x, uStep.x, uBuild.x);
  vec4 c = texture(uSrc, uv);
  // HALFTIME: thicker (the strings dilated)
  float thick = (uMode.x == 5 ? uAmt.x : 0.0) + (uMode.y == 5 ? uAmt.y : 0.0);
  if (thick > 0.0) {
    vec2 r = vec2(2.5 * thick) / uRes;
    c = max(c, max(max(texture(uSrc, uv + vec2(r.x, 0.0)), texture(uSrc, uv - vec2(r.x, 0.0))),
                   max(texture(uSrc, uv + vec2(0.0, r.y)), texture(uSrc, uv - vec2(0.0, r.y)))));
  }
  if (uFeel.w > 0.5) {
    c *= 0.75 + 0.4 * uFeel.x;                                  // slack dim … taut bright
    vec2 up = vec2(0.0, uFeel.y * 0.025);                       // the slide's glow, down as it bends down (tilt +)
    vec2 r = vec2(3.0) / uRes;
    vec4 glow = 0.25 * (texture(uSrc, uv + up + vec2(r.x, 0.0)) + texture(uSrc, uv + up - vec2(r.x, 0.0)) +
                        texture(uSrc, uv + up + vec2(0.0, r.y)) + texture(uSrc, uv + up - vec2(0.0, r.y)));
    c += glow * 0.35 * abs(uFeel.y);
  }
  c = shade(c, uv, uMode.x, uAmt.x, uStep.x, uPhase.x);
  c = shade(c, uv, uMode.y, uAmt.y, uStep.y, uPhase.y);
  // Reduced motion (mode 0 with an amount): a held dim, no moves
  float dim = (uMode.x == 0 ? uAmt.x : 0.0) + (uMode.y == 0 ? uAmt.y : 0.0);
  c *= 1.0 - 0.35 * clamp(dim, 0.0, 1.0);
  o = c;
}`

/** The pass, the strings layer's size: draw(layer, frame, centre, time) returns the FX'd layer (or the layer itself). */
export function createBeatFxPass(width: number, height: number) {
  const canvas = document.createElement('canvas')
  Object.assign(canvas, { width, height })
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false })
  const through = (layer: HTMLCanvasElement) => layer
  if (!gl) return { draw: through, dispose() {} }
  const shader = (kind: number, text: string) => {
    const s = gl.createShader(kind)!
    gl.shaderSource(s, text)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn('beat fx shader:', gl.getShaderInfoLog(s))
    return s
  }
  const prog = gl.createProgram()!
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT))
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { draw: through, dispose() {} }
  gl.useProgram(prog)
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'aPos')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture())
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]] as const)
    gl.texParameteri(gl.TEXTURE_2D, k, v)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true) // the 2D layer as it's stored: premultiplied
  const u = (n: string) => gl.getUniformLocation(prog, n)
  const U = Object.fromEntries(['uRes', 'uC', 'uMode', 'uAmt', 'uPhase', 'uStep', 'uBuild', 'uSnap', 'uTime', 'uFeel'].map((n) => [n, u(n)]))
  gl.uniform1i(u('uSrc'), 0)
  gl.uniform2f(U.uRes!, width, height)
  return {
    draw(layer: HTMLCanvasElement, f: FxFrame, centre: { x: number; y: number }, time: number, feel: StringFeel | null = null): HTMLCanvasElement {
      if (!f.active && !feel) return layer
      const [a, b] = f.slots
      gl.viewport(0, 0, width, height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layer)
      gl.uniform2f(U.uC!, centre.x, centre.y)
      gl.uniform2i(U.uMode!, a.mode, b.mode)
      gl.uniform2f(U.uAmt!, a.amount, b.amount)
      gl.uniform2f(U.uPhase!, a.phase, b.phase)
      gl.uniform2f(U.uStep!, a.step, b.step)
      gl.uniform2f(U.uBuild!, a.build, b.build)
      gl.uniform1f(U.uSnap!, f.snap)
      gl.uniform1f(U.uTime!, time)
      gl.uniform4f(U.uFeel!, feel?.tension ?? 0, feel?.tilt ?? 0, feel?.shake ?? 0, feel ? 1 : 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      return canvas
    },
    dispose() {
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}
