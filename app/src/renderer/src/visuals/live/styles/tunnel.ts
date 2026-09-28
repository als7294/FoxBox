/**
 * FEEDBACK TUNNEL: the last frame, zoomed in a touch and turned, under a fresh ring drawn from the sound, so every
 * ring flies outward into a spiral corridor. The ring is a regular polygon whose radius follows the lows and whose
 * edge count morphs with the mids, its outline pushed out by the spectrum (mirrored round it, lows at the top); the
 * highs add a thin inner halo. Rings go out in pulses on the eighth notes, so the corridor has ribs. Trails lose light
 * and drift toward the palette's ember as they age, with a hint of chromatic split. Kicks (the song's when one plays)
 * push the zoom and the spin, which changes direction every 16 beats; a new bar turns the corridor a step; the drop
 * throws it forward with a surge of glow. The voice is its own layer: it swells and lights the ring.
 *
 * Two half-float targets ping-pong (feedback + ring in one pass); the post chain draws the result.
 */
import {
  DataTexture,
  HalfFloatType,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
} from 'three'
import { makePost, makeRenderer } from '../post'
import type { AudioFrame, StyleInstance, StyleOptions, VisualStyle } from '../registry'
import { ease } from './audioKit'
import { byteTexture, Cues, fullscreenTriangle, glPalette, logSpectrum, v3 } from './gl'

const SPEC_BINS = 96

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

const FEEDBACK_FRAG = /* glsl */ `
uniform sampler2D uPrev;
uniform sampler2D uSpec;
uniform vec2 uRes;
uniform float uTime;
uniform float uZoom;
uniform float uRot;
uniform float uKeep;
uniform float uTint;
uniform float uSplit;
uniform float uRadius;
uniform float uSides;
uniform float uSpin;
uniform float uSpecAmt;
uniform float uGain;
uniform float uHigh;
uniform float uKick;
uniform float uWarp;
uniform vec3 uAccent;
uniform vec3 uAmber;
uniform vec3 uInk;
uniform vec3 uIce;
varying vec2 vUv;

const float PI = 3.14159265;

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

// The radius of a regular n-gon (circumradius 1) toward angle a.
float ngon(float a, float n) {
  float seg = 2.0 * PI / n;
  return cos(PI / n) / cos(mod(a + seg * 0.5, seg) - seg * 0.5);
}

vec3 prevAt(vec2 q, float aspect) {
  vec2 uv = q / vec2(aspect, 1.0) + 0.5;
  vec2 e = smoothstep(vec2(0.0), vec2(0.02), uv) * smoothstep(vec2(0.0), vec2(0.02), 1.0 - uv);
  return texture2D(uPrev, uv).rgb * e.x * e.y;
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);

  // Feedback: sample nearer the centre (so the picture grows outward), turned, with a slow liquid warp.
  vec2 q = rot(uRot) * p / uZoom;
  q += uWarp * vec2(sin(q.y * 5.3 + uTime * 0.31), cos(q.x * 4.7 - uTime * 0.27));
  float r0 = length(q);
  // A little chromatic split that grows toward the edges: red runs slightly ahead of blue.
  vec3 prev;
  prev.r = prevAt(q * (1.0 - uSplit * r0), aspect).r;
  prev.g = prevAt(q, aspect).g;
  prev.b = prevAt(q * (1.0 + uSplit * r0), aspect).b;
  prev *= uKeep;
  // Age toward the palette: older light keeps its energy but takes the ember's hue.
  float lum = dot(prev, vec3(0.2126, 0.7152, 0.0722));
  prev = mix(prev, lum * mix(uAccent, uAmber, 0.2) * 1.15, uTint);
  prev = max(prev - 0.0008, 0.0);

  // The ring: an n-gon (morphing between whole edge counts), pushed out by the mirrored spectrum.
  float a = atan(p.x, p.y) + uSpin;
  float n0 = floor(uSides);
  float poly = mix(ngon(a, n0), ngon(a, n0 + 1.0), smoothstep(0.0, 1.0, fract(uSides)));
  float s = abs(atan(p.x, p.y)) / PI;
  float spec = texture2D(uSpec, vec2(0.02 + s * 0.96, 0.5)).r;
  float R = uRadius * poly * (1.0 + uSpecAmt * spec * spec);
  float r = length(p);
  float d = abs(r - R);
  float px = 1.0 / uRes.y;
  float core = 1.0 - smoothstep(px * 0.4, px * 1.6, d);
  float halo = exp(-d / (px * 6.0)) * 0.22;
  vec3 ring = uInk * core * (0.25 + 0.75 * uKick) + mix(uAccent, uAmber, 0.15 + 0.6 * spec * spec) * (core * 0.6 + halo);
  // The highs: a thin cool halo inside, broken into dashes that crawl.
  float r2 = uRadius * 0.62;
  float dash = smoothstep(0.55, 0.95, sin(a * 14.0 - uTime * 1.3) * 0.5 + 0.5);
  float inner = (1.0 - smoothstep(px * 0.5, px * 1.8, abs(r - r2))) * dash;
  ring += mix(uIce, uInk, 0.3) * inner * uHigh * 0.45;

  gl_FragColor = vec4(prev + ring * uGain, 1.0);
}
`

const SHOW_FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform vec3 uBg;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(uTex, vUv).rgb;
  // A soft shoulder so stacked trails glow instead of clipping to flat white.
  c = c / (1.0 + 0.18 * c);
  gl_FragColor = vec4(uBg + c, 1.0);
}
`

function target(w: number, h: number): WebGLRenderTarget {
  const filter = LinearFilter
  return new WebGLRenderTarget(w, h, { type: HalfFloatType, format: RGBAFormat, minFilter: filter, magFilter: filter, depthBuffer: false })
}

function create(canvas: HTMLCanvasElement, opts: StyleOptions): StyleInstance {
  const { reduced } = opts
  const renderer = makeRenderer(canvas, opts)
  const pal = glPalette(opts.palette)
  let w = Math.max(1, canvas.width)
  let h = Math.max(1, canvas.height)
  let read = target(w, h)
  let write = target(w, h)
  const clear = () => {
    for (const t of [read, write]) {
      renderer.setRenderTarget(t)
      renderer.setClearColor(0x000000, 1)
      renderer.clear()
    }
    renderer.setRenderTarget(null)
    renderer.setClearColor(pal.bg, 1)
  }
  clear()

  const spec: DataTexture = byteTexture(SPEC_BINS, 1)
  const specLevels = new Float32Array(SPEC_BINS)
  const specNow = new Float32Array(SPEC_BINS)
  const tri = fullscreenTriangle()
  const cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1)

  const u = {
    uPrev: { value: read.texture },
    uSpec: { value: spec },
    uRes: { value: new Vector2(w, h) },
    uTime: { value: 0 },
    uZoom: { value: 1 },
    uRot: { value: 0 },
    uKeep: { value: 0.95 },
    uTint: { value: 0.04 },
    uSplit: { value: 0.004 },
    uRadius: { value: 0.2 },
    uSides: { value: 6 },
    uSpin: { value: 0 },
    uSpecAmt: { value: 0.35 },
    uGain: { value: 1 },
    uHigh: { value: 0 },
    uKick: { value: 0 },
    uWarp: { value: 0.0012 },
    uAccent: { value: v3(pal.accent) },
    uAmber: { value: v3(pal.amber) },
    uInk: { value: v3(pal.ink) },
    uIce: { value: v3(pal.ice) },
  }
  const fbMat = new ShaderMaterial({ vertexShader: VERT, fragmentShader: FEEDBACK_FRAG, uniforms: u, depthTest: false, depthWrite: false })
  const fbScene = new Scene()
  const fbMesh = new Mesh(tri, fbMat)
  fbMesh.frustumCulled = false
  fbScene.add(fbMesh)

  const showU = { uTex: { value: write.texture }, uBg: { value: v3(pal.bg) } }
  const showMat = new ShaderMaterial({ vertexShader: VERT, fragmentShader: SHOW_FRAG, uniforms: showU, depthTest: false })
  const scene = new Scene()
  const showMesh = new Mesh(tri, showMat)
  showMesh.frustumCulled = false
  scene.add(showMesh)
  const post = makePost(renderer, scene, cam, opts, { bloom: 1.05, grain: 0.2, vignette: 0.66 })

  const cues = new Cues(reduced)
  let clock = 0
  let spin = 0
  let spinVel = 0
  let rotVel = 0
  let rotStep = 0
  let zoomKick = 0
  let sides = 5

  return {
    frame(a: AudioFrame, dt: number) {
      const step = Math.min(100, Math.max(0, dt))
      const s = step / 1000
      clock += s
      cues.update(a, step)
      const { bands, kick, live, voice, drop } = cues

      // The spectrum round the ring: log bands, fast attack, slower release.
      logSpectrum(a.active ? a.fft : null, a.sampleRate, specNow)
      const data = spec.image.data as Uint8Array
      for (let i = 0; i < SPEC_BINS; i++) {
        // A 3-tap blur across bands keeps the outline a smooth curve rather than a saw.
        const t = (specNow[Math.max(0, i - 1)]! + 2 * specNow[i]! + specNow[Math.min(SPEC_BINS - 1, i + 1)]!) / 4
        specLevels[i] = ease(specLevels[i]!, t, step, t > specLevels[i]! ? 30 : 180)
        data[i] = Math.round(Math.min(1, specLevels[i]!) * 255)
      }
      spec.needsUpdate = true

      // Spin: a slow drift, pushed on hits, reversing every 16 beats (every 12 s when idle).
      const bar16 = a.active && a.bpm > 0 ? Math.floor(((a.time * a.bpm) / 60 / 16) % 2) : Math.floor((clock / 12) % 2)
      const dir = bar16 ? -1 : 1
      const calm = reduced ? 0.35 : 1
      if (cues.hit && !reduced) {
        rotVel += dir * 0.9 * Math.min(1.5, kick)
        spinVel += dir * 1.6 * Math.min(1.5, kick)
        zoomKick = Math.max(zoomKick, Math.min(1.5, kick))
      }
      // A new bar turns the corridor a step (a twelfth of a turn, eased in over ~a beat); the drop kicks everything.
      if (cues.bar) rotStep += (dir * Math.PI) / (reduced ? 24 : 6)
      if (cues.dropHit) {
        zoomKick = reduced ? 0.6 : 2.5
        spinVel += dir * (reduced ? 0.4 : 3)
      }
      const turn = rotStep * (1 - Math.exp(-step / 180))
      rotStep -= turn
      rotVel = ease(rotVel, dir * (0.08 + 0.12 * bands.mid * live) * calm, step, 700)
      spinVel = ease(spinVel, dir * (0.12 + 0.3 * bands.high * live) * calm, step, 900)
      zoomKick = ease(zoomKick, 0, step, 260)
      spin += spinVel * s

      // Zoom per second: a steady glide, faster with the lows and on a kick.
      const zoomRate = 1 + (0.45 + 0.5 * bands.low * live + (reduced ? 0.2 : 1.4) * zoomKick) * calm
      // Rings go out in pulses on the eighth notes (every half second idle), so the corridor has ribs, not a smear.
      const eighths = a.active && a.bpm > 0 ? (a.time * a.bpm) / 30 : clock * 2
      const pulse = Math.exp(-(eighths - Math.floor(eighths)) * 16)
      // The ring's edge count follows the mids (the song's, when one plays); the voice swells it and lights it.
      sides = ease(sides, 3 + Math.round(bands.mid * live * 5.99), step, 450)
      const breath = 0.5 + 0.5 * Math.sin(clock * 0.6)

      u.uPrev.value = read.texture
      u.uTime.value = clock
      u.uZoom.value = Math.pow(zoomRate, s)
      u.uRot.value = rotVel * s + turn
      // Trails last ~0.55 s at 60 fps; idle darker and shorter.
      u.uKeep.value = Math.exp(-step / (a.active ? 420 : 260))
      u.uTint.value = 1 - Math.exp(-step / 400)
      u.uSplit.value = (0.0002 + 0.0012 * Math.min(1, kick + drop) * calm) * (reduced ? 0.5 : 1)
      u.uRadius.value = 0.13 + 0.015 * breath + (0.07 * bands.low + 0.05 * voice + 0.04 * Math.min(1, kick) * calm) * live
      u.uSides.value = sides
      u.uSpin.value = spin
      u.uSpecAmt.value = 0.1 + 0.45 * live
      const hitGain = (reduced ? 0.1 : 0.55) * Math.min(1, kick)
      u.uGain.value = 0.04 + 0.02 * live + (0.08 + 0.45 * live) * pulse + (0.35 * voice + hitGain) * live + 0.8 * drop
      u.uHigh.value = bands.high * live * (0.3 + 0.7 * pulse)
      u.uKick.value = Math.min(1, kick + drop) * calm
      u.uWarp.value = 0.0008 + 0.0014 * bands.mid * live

      renderer.setRenderTarget(write)
      renderer.render(fbScene, cam)
      renderer.setRenderTarget(null)
      showU.uTex.value = write.texture
      const t = read
      read = write
      write = t
      post.render(dt, Math.min(1, (0.45 * Math.min(1, kick) + 0.4 * a.rms) * live + drop))
    },
    resize(width: number, height: number) {
      w = Math.max(1, Math.round(width))
      h = Math.max(1, Math.round(height))
      read.setSize(w, h)
      write.setSize(w, h)
      clear()
      u.uRes.value.set(w, h)
      post.setSize(w, h)
    },
    dispose() {
      post.dispose()
      read.dispose()
      write.dispose()
      spec.dispose()
      tri.dispose()
      fbMat.dispose()
      showMat.dispose()
      renderer.dispose()
    },
  }
}

export const tunnelStyle: VisualStyle = { id: 'foxbox.tunnel', label: 'FEEDBACK TUNNEL', create }
