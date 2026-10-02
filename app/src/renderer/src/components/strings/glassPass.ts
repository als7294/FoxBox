/**
 * The GLASS's one extra pass (glass.ts says when, which and where): a WebGL2 canvas the stage's size, transparent
 * outside the pane, drawn over the composite. Its source is the camera picture StringsStage draws (with FACE HIDING,
 * the hidden one: fail closed). One draw; the camera uploaded once a frame, only while the glass shows.
 * A pane of thick glass, never a zoom: a rounded rect whose bevel bends the picture strongly at its border while the
 * middle stays true, a little colour dispersion only there, a Fresnel rim (the kick glints it), a specular streak that
 * slides with the tilt, micro-frost; the bass runs ripples across it. Through it, a world:
 *   THERMAL   heat colours from the light       X-RAY     the negative, cold, its edges lit
 *   HALFTONE  dots on the pane's own grid        PRISM     a rainbow split across it
 *   KALEIDO   mirror segments (more as it tilts) DATAMOSH  blocks melting down, more the longer it's held
 * CRACK on letting go: pie shards from the centre fall and turn away as they fade, the world still in them (geometry,
 * no strobe). Reduced motion: the plain pane. Colour is premultiplied (the canvas's default).
 */
import type { GlassFrame, GlassType } from './glass'

const TYPE: Record<GlassType, number> = { thermal: 0, xray: 1, halftone: 2, prism: 3, kaleido: 4, datamosh: 5, plain: 6 }

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uRes;      // the canvas, px
uniform vec2 uC;        // the pane's centre, 0-1 of the picture, y down
uniform vec2 uHalf;     // its half width and height, picture heights
uniform float uTilt;    // radians, clockwise
uniform int uType;      // 0 thermal 1 xray 2 halftone 3 prism 4 kaleido 5 datamosh 6 plain
uniform float uMix;     // 0-1, eased
uniform float uCrack;   // -1, or 0-1 through the fall
uniform float uBass;    // 0-1, smoothed
uniform float uKick;    // 0-1, a decaying envelope
uniform float uTime;    // seconds
uniform float uAge;     // seconds since the pane came on
uniform float uReduced;
out vec4 o;

float aspect() { return uRes.x / uRes.y; }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
vec2 toUv(vec2 q) { vec2 p = rot(uTilt) * q; return uC + vec2(p.x / aspect(), p.y); }
vec3 src(vec2 uv) { return texture(uSrc, clamp(uv, 0.0, 1.0)).rgb; }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float hash1(float n) { return fract(sin(n * 127.1) * 43758.5453); }
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// The pane: a rounded rect (signed distance, picture heights; < 0 inside) and its outward normal.
float corner() { return 0.28 * min(uHalf.x, uHalf.y); }
float sdPane(vec2 q) { vec2 d = abs(q) - uHalf + corner(); return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - corner(); }
vec2 normalAt(vec2 q) {
  float e = 0.002;
  return normalize(vec2(sdPane(q + vec2(e, 0.0)) - sdPane(q - vec2(e, 0.0)), sdPane(q + vec2(0.0, e)) - sdPane(q - vec2(0.0, e))) + 1e-6);
}
float bevel() { return 0.24 * min(uHalf.x, uHalf.y); }

vec3 thermal(float t) {
  vec3 a = mix(vec3(0.02, 0.0, 0.12), vec3(0.45, 0.0, 0.6), smoothstep(0.0, 0.3, t));
  a = mix(a, vec3(0.95, 0.2, 0.15), smoothstep(0.3, 0.55, t));
  a = mix(a, vec3(1.0, 0.7, 0.1), smoothstep(0.55, 0.8, t));
  return mix(a, vec3(1.0, 1.0, 0.85), smoothstep(0.8, 1.0, t));
}
vec3 rainbow(float h) { return 0.5 + 0.5 * cos(6.28318 * (h + vec3(0.0, 0.33, 0.67))); }

// What the pane shows at q (glass space): the picture bent by the bevel and the ripples, through its world.
vec3 pane(vec2 q) {
  float px = 1.0 / uRes.y;
  float e = -sdPane(q);
  float bend = pow(clamp(1.0 - e / bevel(), 0.0, 1.0), 2.0);
  vec2 n = normalAt(q);
  vec2 g = q;
  if (uType == 4) {                      // KALEIDO: folded about the pane's centre, the same scale
    float seg = 4.0 + 2.0 * floor(abs(uTilt) / 0.7854 * 3.0 + 0.5);
    float k = 6.28318 / seg;
    float a = atan(g.y, g.x) + uTime * 0.1;
    a = abs(mod(a, k) - 0.5 * k);
    g = vec2(cos(a), sin(a)) * length(g);
  } else if (uType == 5) {               // DATAMOSH: blocks sliding down, melting the longer it's held
    vec2 b = floor(g / (14.0 * px));
    float melt = min(uAge, 3.0) * (0.01 + 0.03 * hash(vec2(b.x, 1.0)));
    g.y -= melt + 0.01 * uBass * hash(b + floor(uTime * 4.0));
    g = (floor(g / (6.0 * px)) + 0.5) * 6.0 * px;
  }
  float r = uReduced > 0.5 ? 0.0 : 1.0;
  vec2 dir = vec2(cos(uTilt * 0.5 + 0.6), sin(uTilt * 0.5 + 0.6));
  g += dir * r * (0.0025 + 0.006 * uBass) * sin(dot(q, dir) * 55.0 - uTime * 7.0);      // the bass's ripples, running across
  g += r * (vec2(hash(floor(q / (2.0 * px))), hash(floor(q / (2.0 * px)) + 7.0)) - 0.5) * 0.0012;  // micro-frost
  vec2 off = -n * bend * 0.07;                                                           // the bevel's refraction
  vec2 split = uType == 3 ? vec2(cos(uTilt * 2.0), sin(uTilt * 2.0)) * (0.008 + 0.01 * uBass) : -n * bend * 0.012;
  vec2 uv = toUv(g + off);
  vec2 du = toUv(g + off + split) - uv;
  vec3 col = vec3(src(uv + du).r, src(uv).g, src(uv - du).b);
  if (uType == 0) col = thermal(clamp(lum(col) * 1.15, 0.0, 1.0));
  else if (uType == 1) {
    float ed = length(vec2(lum(src(uv + vec2(px, 0.0))) - lum(src(uv - vec2(px, 0.0))), lum(src(uv + vec2(0.0, px))) - lum(src(uv - vec2(0.0, px)))));
    col = (1.0 - vec3(lum(col))) * vec3(0.7, 0.88, 1.0) + vec3(0.6, 0.85, 1.0) * clamp(ed * 4.0, 0.0, 1.0);
  } else if (uType == 2) {
    float cell = 7.0 * px;
    vec2 h = rot(0.785) * g;
    vec2 c = (floor(h / cell) + 0.5) * cell;
    float l = lum(src(toUv(rot(-0.785) * c + off)));
    float dot_ = 1.0 - smoothstep(0.0, px, length(h - c) - 0.5 * cell * sqrt(1.0 - l));
    col = mix(vec3(0.94, 0.9, 0.82), vec3(0.06, 0.05, 0.05), dot_);
  } else if (uType == 3) col = mix(col, col * rainbow(dot(q, vec2(1.0, 0.4)) * 2.0 + uTime * 0.1) * 1.5, 0.45);
  // Surface: a faint smudge, the Fresnel rim (the kick glints it), a specular streak sliding with the tilt.
  col *= 0.97 + 0.06 * hash(floor(q / (40.0 * px)));
  float fres = pow(clamp(1.0 - e / (0.6 * bevel()), 0.0, 1.0), 3.0);
  col += vec3(1.0, 0.97, 0.92) * fres * (0.3 + 0.4 * r * uKick);
  float s = dot(q / uHalf, normalize(vec2(1.0, -0.7)));
  float s0 = clamp(uTilt / 0.7854, -1.0, 1.0) * 0.9;
  col += vec3(1.0) * (exp(-pow((s - s0) / 0.12, 2.0)) * 0.12 + exp(-pow((s - s0 - 0.22) / 0.035, 2.0)) * 0.1);
  return col;
}

void main() {
  vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1.0 - gl_FragCoord.y / uRes.y);
  vec2 p = uv - uC;
  p.x *= aspect();
  vec2 q = rot(-uTilt) * p;
  float px = 1.0 / uRes.y;
  vec3 col = vec3(0.0);
  float a = 0.0;
  if (uCrack < 0.0) {
    float d = sdPane(q);
    if (d > px) discard;
    a = smoothstep(px, -px, d);
    col = pane(q);
  } else {
    // Seven pie shards from the centre, each falling and turning its own way: for this pixel, the shard (if any)
    // whose moved shape covers it, and where it came from.
    float c = uCrack;
    for (int i = 0; i < 7; i++) {
      float fi = float(i);
      float a0 = (fi + 0.4 * hash1(fi + 1.0)) * 0.8976;   // 2pi / 7
      float a1 = (fi + 1.0 + 0.4 * hash1(fi + 2.0)) * 0.8976;
      vec2 drop = vec2((hash1(fi + 3.0) - 0.5) * 0.25 * c, (0.35 + 0.5 * hash1(fi + 4.0)) * c * c);
      vec2 q0 = rot(-(hash1(fi + 5.0) - 0.5) * 0.8 * c) * (q - rot(-uTilt) * drop);
      float ang = atan(q0.y, q0.x);
      ang = ang < 0.0 ? ang + 6.28318 : ang;
      float lo = mod(a0, 6.28318), hi = mod(a1, 6.28318);
      bool within = lo < hi ? (ang >= lo && ang < hi) : (ang >= lo || ang < hi);
      float d = -sdPane(q0);
      if (within && d > 0.0) {
        float edge = min(min(abs(ang - lo), abs(ang - hi)) * length(q0), d);
        col = mix(pane(q0), vec3(1.0), exp(-edge / (2.0 * px)) * 0.8);
        a = 1.0 - c;
        break;
      }
    }
    if (a <= 0.0) discard;
  }
  a *= uMix;
  o = vec4(col * a, a);
}`

export interface GlassAudio {
  bass: number
  kick: number
  time: number
}

/** The pass, `width` x `height`: draw(source, frame, audio) renders the pane (or nothing) and returns its canvas. */
export function createGlassPass(width: number, height: number, opts: { reduced?: boolean } = {}) {
  const canvas = document.createElement('canvas')
  Object.assign(canvas, { width, height })
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false })
  if (!gl) return { canvas, draw: () => null as HTMLCanvasElement | null, dispose() {} }
  const shader = (kind: number, text: string) => {
    const s = gl.createShader(kind)!
    gl.shaderSource(s, text)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn('glass shader:', gl.getShaderInfoLog(s))
    return s
  }
  const prog = gl.createProgram()!
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT))
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(prog)
  const ok = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean
  gl.useProgram(prog)
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'aPos')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]] as const)
    gl.texParameteri(gl.TEXTURE_2D, k, v)
  const u = (name: string) => gl.getUniformLocation(prog, name)
  const U = Object.fromEntries(['uRes', 'uC', 'uHalf', 'uTilt', 'uType', 'uMix', 'uCrack', 'uAge', 'uBass', 'uKick', 'uTime', 'uReduced'].map((n) => [n, u(n)]))
  gl.uniform1i(u('uSrc'), 0)
  gl.uniform2f(U.uRes!, width, height)
  gl.uniform1f(U.uReduced!, opts.reduced ? 1 : 0)
  return {
    canvas,
    /** The pane over `source` (the camera picture, the canvas's size), or null when there's nothing to draw. */
    draw(source: CanvasImageSource, f: GlassFrame, audio: GlassAudio): HTMLCanvasElement | null {
      if (!ok || !f.quad || f.mix <= 0) return null
      gl.viewport(0, 0, width, height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource)
      const q = f.quad
      gl.uniform2f(U.uC!, q.x, q.y)
      gl.uniform2f(U.uHalf!, q.hw, q.hh)
      gl.uniform1f(U.uTilt!, q.tilt)
      gl.uniform1i(U.uType!, TYPE[f.type])
      gl.uniform1f(U.uMix!, f.mix)
      gl.uniform1f(U.uCrack!, f.crack)
      gl.uniform1f(U.uAge!, f.age)
      gl.uniform1f(U.uBass!, audio.bass)
      gl.uniform1f(U.uKick!, audio.kick)
      gl.uniform1f(U.uTime!, audio.time)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      return canvas
    },
    dispose() {
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}
