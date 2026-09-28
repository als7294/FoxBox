/**
 * What the three.js FOXBOX styles (tunnel, point cloud, terrain) share: the palette as linear colours for uniforms,
 * a spectrum texture, a full-screen triangle, GLSL snippets (simplex noise and its curl) and the musical cues.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  LinearFilter,
  Mesh,
  RedFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
  type WebGLRenderer,
} from 'three'
import type { AudioFrame, Palette } from '../registry'
import { ease, easeBands, onsetEnvelope } from './audioKit'

/** The palette in three's linear working space (Color parses the sRGB CSS and converts). */
export interface GlPalette {
  bg: Color
  accent: Color
  amber: Color
  ink: Color
  ice: Color
}

export function glPalette(p: Palette): GlPalette {
  return { bg: new Color(p.bg), accent: new Color(p.accent), amber: new Color(p.amber), ink: new Color(p.ink), ice: new Color(p.ice) }
}

/** A Color as a Vector3, for vec3 uniforms. */
export const v3 = (c: Color): Vector3 => new Vector3(c.r, c.g, c.b)

/** A single triangle covering the screen (clip space; uv 0–1 across the visible part). */
export function fullscreenTriangle(): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
  g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2))
  return g
}

/** A width × height single-channel byte texture, linear-filtered (spectra and their history). */
export function byteTexture(width: number, height: number): DataTexture {
  const t = new DataTexture(new Uint8Array(width * height), width, height, RedFormat, UnsignedByteType)
  t.magFilter = LinearFilter
  t.minFilter = LinearFilter
  t.needsUpdate = true
  return t
}

/**
 * `fft` (0 Hz to Nyquist) resampled onto `out.length` log-spaced bands from `loHz` to `hiHz`, 0–1, with a gentle tilt
 * up the top end (music's spectrum falls ~3 dB/oct, so the highs would otherwise barely move). Silence without fft.
 */
export function logSpectrum(fft: Uint8Array | null, sampleRate: number, out: Float32Array, loHz = 30, hiHz = 16000): Float32Array {
  if (!fft) return out.fill(0)
  const n = out.length
  const hzPerBin = sampleRate / 2 / fft.length
  for (let i = 0; i < n; i++) {
    const f0 = loHz * Math.pow(hiHz / loHz, i / n)
    const f1 = loHz * Math.pow(hiHz / loHz, (i + 1) / n)
    const c0 = f0 / hzPerBin
    const c1 = f1 / hzPerBin
    let m = 0
    if (c1 - c0 < 1) {
      // Narrower than a bin (the low end): interpolate at the band's centre, so the lows curve instead of stepping.
      const c = Math.max(1, (c0 + c1) / 2)
      const j = Math.min(fft.length - 2, Math.floor(c))
      m = fft[j]! + (fft[j + 1]! - fft[j]!) * (c - j)
    } else {
      const b = Math.min(fft.length, Math.ceil(c1))
      for (let j = Math.max(1, Math.floor(c0)); j < b; j++) m = Math.max(m, fft[j]!)
    }
    out[i] = Math.min(1, (m / 255) * (1 + 0.35 * (i / n)))
  }
  return out
}

/** Ashima's 3D simplex noise (MIT) and a curl of it: `snoise(vec3)`, `curl(vec3)`. */
export const NOISE_GLSL = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
// Curl of a potential made of three decorrelated noise fields (central differences).
vec3 curl(vec3 p) {
  const float e = 0.1;
  vec3 dx = vec3(e, 0.0, 0.0), dy = vec3(0.0, e, 0.0), dz = vec3(0.0, 0.0, e);
  vec3 o1 = vec3(31.4, 0.0, 0.0), o2 = vec3(0.0, 47.2, 0.0);
  float x0 = snoise(p + o2 - dy), x1 = snoise(p + o2 + dy), x2 = snoise(p + o1 - dz), x3 = snoise(p + o1 + dz);
  float y0 = snoise(p - dz), y1 = snoise(p + dz), y2 = snoise(p + o2 - dx), y3 = snoise(p + o2 + dx);
  float z0 = snoise(p + o1 - dx), z1 = snoise(p + o1 + dx), z2 = snoise(p - dy), z3 = snoise(p + dy);
  return vec3((x1 - x0) - (x3 - x2), (y1 - y0) - (y3 - y2), (z1 - z0) - (z3 - z2)) / (2.0 * e);
}
`

/**
 * The musical cues a style reacts to, read from a frame the same way in every style: the kick (the song's onsets
 * when a song plays, else the mix's), the field's bands (the song's, else the mix's), the voice's own level (its
 * layer, the centre element), a new bar and the drop. Everything is an envelope that eases, calmer under reduced
 * motion, and zero while nothing sounds.
 */
export class Cues {
  /** 0–1.5, jumps on a hit. */
  kick = 0
  /** True on the frame a hit lands. */
  hit = false
  readonly bands = { low: 0, mid: 0, high: 0 }
  /** The voice's level (eased), 0–1. */
  voice = 0
  /** 0–1: fades in with the sound, out over ~0.6 s after it stops. */
  live = 0
  /** True on the frame a new bar starts (while sounding). */
  bar = false
  /** 0–1: 1 on the drop's frame, easing out over its bar. */
  drop = 0
  /** True on the frame the drop lands. */
  dropHit = false
  private lastBar = NaN
  private wasDrop = false

  constructor(private readonly reduced: boolean) {}

  update(a: AudioFrame, dt: number): void {
    const step = Math.min(100, Math.max(0, dt))
    const before = this.kick
    this.kick = onsetEnvelope(this.kick, { onset: a.song ? a.song.onset : a.onset, active: a.active }, step, 220, this.reduced)
    this.hit = this.kick > before + 0.3
    easeBands(this.bands, a.song ? { ...a, bands: a.song.bands } : a, step)
    const v = a.active ? (a.voice?.rms ?? a.rms) : 0
    this.voice = ease(this.voice, Math.min(1, v * 2.5), step, v * 2.5 > this.voice ? 50 : 300)
    this.live = ease(this.live, a.active ? 1 : 0, step, 600)
    // The bar: the source's count when it has one, else four beats of the session tempo.
    const bar = a.bar ?? (a.bpm > 0 ? Math.floor((a.time * a.bpm) / 240) : 0)
    this.bar = a.active && Number.isFinite(this.lastBar) && bar !== this.lastBar
    this.lastBar = bar
    const drop = Boolean(a.active && a.drop)
    this.dropHit = drop && !this.wasDrop
    this.wasDrop = drop
    this.drop = this.dropHit ? (this.reduced ? 0.4 : 1) : ease(this.drop, 0, step, drop ? 900 : 400)
  }
}

/**
 * The backdrop for a 3D scene: the palette's background with a faint glow (`glow` at screen height `y`, 0 = bottom),
 * drawn first as a full-screen triangle. The renderer's clear colour is set to black so the post chain's clear
 * can't lift the blacks (under the composer it would be encoded twice and read as a grey).
 */
export function backdrop(renderer: WebGLRenderer, pal: GlPalette, y = 0.5): { mesh: Mesh; glow: { value: number }; dispose(): void } {
  renderer.setClearColor(0x000000, 1)
  const glow = { value: 0 }
  const mat = new ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 1.0, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uBg;
      uniform vec3 uGlowCol;
      uniform float uGlow;
      uniform float uY;
      varying vec2 vUv;
      void main() {
        float d = abs(vUv.y - uY);
        gl_FragColor = vec4(uBg + uGlowCol * uGlow * exp(-d * d * 18.0), 1.0);
      }
    `,
    uniforms: { uBg: { value: v3(pal.bg) }, uGlowCol: { value: v3(pal.accent) }, uGlow: glow, uY: { value: y } },
    depthTest: false,
    depthWrite: false,
  })
  const geo = fullscreenTriangle()
  const mesh = new Mesh(geo, mat)
  mesh.frustumCulled = false
  mesh.renderOrder = -1
  return {
    mesh,
    glow,
    dispose() {
      geo.dispose()
      mat.dispose()
    },
  }
}
