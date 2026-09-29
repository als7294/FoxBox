/**
 * POINT CLOUD: ~50k points on concentric rings (spaced evenly, so the disc has no dense spokes), seen from a slow
 * orbit. The spectrum history rises out of it: the newest frame at the centre, older ones ripple outward ring by
 * ring, with the spectrum mirrored round each ring. Curl noise keeps every point drifting, a shockwave rolls out on
 * each kick (the song's when one plays), a new bar re-seeds one from somewhere off-centre, and the drop sends a big
 * one with a camera punch. The voice is its own layer: it lifts and lights the core. Additive palette colours.
 *
 * Song structure (structure.ts): up a build the disc draws in and its light heats; the held breath freezes it; the drop
 * hit throws it wide in ice. A held sub raises a dome for the note's length (wider as it holds), a stab rolls a quick
 * wave, a wobble pumps the heights, an 808 glide swings the orbit.
 *
 * The history is a 128 × 64 byte texture (a ring buffer written at 30 rows/s); all displacement is in the vertex shader.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  PerspectiveCamera,
  Points,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  Vector3,
  Vector4,
} from 'three'
import { makePost, makeRenderer } from '../post'
import type { AudioFrame, StyleInstance, StyleOptions, VisualStyle } from '../registry'
import { ease, hash1 } from './audioKit'
import { backdrop, byteTexture, Cues, glPalette, logSpectrum, NOISE_GLSL, v3 } from './gl'
import { GRADE_GLSL, Structure } from './structure'

const FREQ = 128
const ROWS = 64
const ROW_RATE = 30
const RINGS = 180
const RADIUS = 1.6
const WAVES = 4

const VERT = /* glsl */ `
${NOISE_GLSL}
attribute float aSeed;
uniform sampler2D uHist;
uniform float uHead;
uniform float uFrac;
uniform float uTime;
uniform float uAmp;
uniform float uDrift;
uniform float uVoice;
uniform float uPx;
uniform float uLive;
uniform float uHigh;
uniform float uSquash;
uniform float uSub;
uniform float uSubW;
uniform float uFlip;
uniform vec4 uWaves[${WAVES}];
uniform vec3 uAccent;
uniform vec3 uAmber;
uniform vec3 uInk;
uniform vec3 uIce;
varying vec3 vCol;
varying float vAlpha;

void main() {
  vec3 p = position;
  float r = length(p.xz) / ${RADIUS.toFixed(1)};
  // The spectrum: frequency round the ring (mirrored), age outward from the centre.
  float s = abs(atan(p.z, p.x)) / 3.14159265;
  float age = max(0.0, r * ${(ROWS - 2).toFixed(1)} - uFrac);
  float v = (uHead - age + 0.5) / ${ROWS.toFixed(1)};
  float spec = texture2D(uHist, vec2(0.02 + s * 0.96, v)).r;
  float h = pow(spec, 2.4) * uAmp * (1.0 - 0.5 * r);
  // A slow swell under everything, so even silence breathes.
  h += 0.035 * snoise(vec3(p.xz * 1.3, uTime * 0.07));
  // The voice: the core lifts and brightens.
  float core = exp(-r * r * 90.0);
  h += uVoice * 0.38 * core;
  // A held sub: a broad dome, widening as the note holds.
  h += uSub * 0.3 * exp(-r * r * uSubW);
  // Shockwaves: a ring of lift travelling out from each origin, fading as it goes.
  float shock = 0.0;
  for (int i = 0; i < ${WAVES}; i++) {
    vec4 w = uWaves[i];
    float t = uTime - w.z;
    if (w.w <= 0.0 || t < 0.0 || t > 3.0) continue;
    float d = length(p.xz - w.xy);
    float front = t * 1.25;
    float k = exp(-pow((d - front) / 0.07, 2.0)) * exp(-t * 1.4) * w.w;
    shock += k;
  }
  shock = min(shock, 1.6);
  h += shock * 0.2;
  p.y += h;
  // A build draws the disc in; the drop hit throws it out.
  p.xz *= uSquash;
  // Curl drift: every point wanders a little, more with the mids.
  p += curl(p * 1.1 + vec3(0.0, uTime * 0.05, 0.0)) * uDrift;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float lift = clamp(h * 2.4, 0.0, 1.0);
  gl_PointSize = max(1.0, uPx * (1.0 + 0.8 * lift + 1.2 * shock + 1.5 * core * uVoice) / -mv.z);

  vec3 col = mix(uAccent * 0.7, uAmber, smoothstep(0.15, 0.7, lift));
  col = mix(col, uInk, smoothstep(0.7, 1.0, lift) * 0.7);
  col += uInk * min(shock, 1.0) * 0.4 + uInk * core * uVoice * 0.5;
  // A few points catch the highs in the cool colour.
  float glint = step(0.965, aSeed) * uHigh;
  col = mix(col, uIce * 1.4, glint * 0.8);
  col = mix(col, mix(uIce, uInk, 0.4), uFlip);
  vCol = col;
  float edge = 1.0 - smoothstep(0.82, 1.0, r);
  vAlpha = edge * (0.07 + 0.08 * uLive + 0.3 * lift + 0.25 * min(shock, 1.0) + 0.6 * glint + 0.3 * core * uVoice);
}
`

const FRAG = /* glsl */ `
uniform vec3 uGrade;
varying vec3 vCol;
varying float vAlpha;
${GRADE_GLSL}
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float d = dot(q, q) * 4.0;
  if (d > 1.0) discard;
  float a = (1.0 - d);
  gl_FragColor = vec4(grade(vCol, uGrade) * a * a * vAlpha, 1.0);
}
`

/** Concentric rings, each with points in proportion to its radius (an even density), and a seed per point. */
function ringGeometry(): BufferGeometry {
  const counts: number[] = []
  for (let k = 0; k < RINGS; k++) counts.push(Math.max(8, Math.round(((k + 0.5) / RINGS) * 560)))
  const total = counts.reduce((a, b) => a + b, 0)
  const pos = new Float32Array(total * 3)
  const seed = new Float32Array(total)
  let n = 0
  for (let k = 0; k < RINGS; k++) {
    const r = ((k + 0.5) / RINGS) * RADIUS
    const c = counts[k]!
    const off = hash1(k) * Math.PI * 2
    for (let j = 0; j < c; j++) {
      const a = off + (j / c) * Math.PI * 2
      pos[n * 3] = Math.cos(a) * r
      pos[n * 3 + 2] = Math.sin(a) * r
      seed[n] = hash1(n * 1.618 + 0.3)
      n++
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('aSeed', new BufferAttribute(seed, 1))
  return g
}

function create(canvas: HTMLCanvasElement, opts: StyleOptions): StyleInstance {
  const { reduced } = opts
  const renderer = makeRenderer(canvas, opts)
  const pal = glPalette(opts.palette)
  let w = Math.max(1, canvas.width)
  let h = Math.max(1, canvas.height)

  const hist: DataTexture = byteTexture(FREQ, ROWS)
  hist.wrapT = RepeatWrapping
  const row = new Float32Array(FREQ)
  const smooth = new Float32Array(FREQ)
  const waves = Array.from({ length: WAVES }, () => new Vector4(0, 0, -99, 0))
  let nextWave = 0

  const u = {
    uHist: { value: hist },
    uHead: { value: 0 },
    uFrac: { value: 0 },
    uTime: { value: 0 },
    uAmp: { value: 0.6 },
    uDrift: { value: 0.02 },
    uVoice: { value: 0 },
    uPx: { value: 1 },
    uLive: { value: 0 },
    uHigh: { value: 0 },
    uSquash: { value: 1 },
    uSub: { value: 0 },
    uSubW: { value: 14 },
    uFlip: { value: 0 },
    uGrade: { value: new Vector3(0, 0, 1) },
    uWaves: { value: waves },
    uAccent: { value: v3(pal.accent) },
    uAmber: { value: v3(pal.amber) },
    uInk: { value: v3(pal.ink) },
    uIce: { value: v3(pal.ice) },
  }
  const geo = ringGeometry()
  const mat = new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: u,
    blending: AdditiveBlending,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const points = new Points(geo, mat)
  points.frustumCulled = false
  const scene = new Scene()
  const back = backdrop(renderer, pal, 0.52)
  scene.add(back.mesh, points)
  const camera = new PerspectiveCamera(36, w / h, 0.05, 40)
  const post = makePost(renderer, scene, camera, opts, { bloom: 1.2, grain: 0.2, vignette: 0.7 })

  const cues = new Cues(reduced)
  const st = new Structure(reduced)
  let stab = 0
  let clock = 0
  let head = 0
  let rowClock = 0
  let orbit = 0.6
  let punch = 0

  const pixelScale = () => {
    // World-space point size → pixels at distance 1 (the projection's focal length in pixels).
    u.uPx.value = (0.0055 * h) / (2 * Math.tan((camera.fov * Math.PI) / 360))
  }
  pixelScale()

  const shock = (x: number, z: number, strength: number) => {
    waves[nextWave]!.set(x, z, clock, strength)
    nextWave = (nextWave + 1) % WAVES
  }

  return {
    frame(a: AudioFrame, dt: number) {
      const step = Math.min(100, Math.max(0, dt))
      cues.update(a, step)
      st.step(a, step)
      // Structure's time: the held breath freezes the drift, the ripples and the orbit; half-time slows them.
      const ts = st.timeScale
      const s = (step / 1000) * ts
      clock += s
      const { bands, kick, live, voice, drop } = cues
      const k = st.intensity * (1 + 0.5 * st.groove)

      // The history: a new ring of spectrum every 1/30 s (silence when idle).
      logSpectrum(a.active ? a.fft : null, a.sampleRate, row)
      for (let i = 0; i < FREQ; i++) smooth[i] = ease(smooth[i]!, row[i]!, step, row[i]! > smooth[i]! ? 25 : 120)
      rowClock += s * ROW_RATE
      const data = hist.image.data as Uint8Array
      while (rowClock >= 1) {
        rowClock -= 1
        head = (head + 1) % ROWS
        for (let i = 0; i < FREQ; i++) data[head * FREQ + i] = Math.round(Math.min(1, smooth[i]!) * 255)
        hist.needsUpdate = true
      }

      // Kicks roll a wave out from the centre; a bar re-seeds one off-centre; the drop sends the big one.
      const calm = reduced ? 0.4 : 1
      if (cues.hit) shock(0, 0, Math.min(1.4, kick) * calm * k)
      // A bass stab rolls a quick wave of its own.
      if (st.stab > stab + 0.3) shock(0, 0, 0.8 * st.stab * calm * st.intensity)
      stab = st.stab
      if (cues.bar) {
        const ang = hash1(clock * 7.13) * Math.PI * 2
        const rad = 0.35 + 0.5 * hash1(clock * 3.7 + 1)
        shock(Math.cos(ang) * rad, Math.sin(ang) * rad, 0.9 * calm)
      }
      if (cues.dropHit || (st.hit && cues.drop < 0.5)) {
        shock(0, 0, 2 * calm)
        punch = calm
      }
      punch = ease(punch, 0, step, 700)

      // The camera: a slow orbit, lower and closer while it's loud; the drop punches in.
      orbit += s * (reduced ? 0.012 : 0.045 + 0.03 * bands.mid * live)
      const dist = (4.1 - 0.2 * bands.low * live - 0.8 * punch) / st.zoom
      const height = 1.55 + 0.2 * Math.sin(clock * 0.07)
      const swing = orbit + st.glide * 0.5
      camera.position.set(Math.cos(swing) * dist, height, Math.sin(swing) * dist)
      camera.lookAt(0, 0.12, 0)

      u.uHead.value = head
      u.uFrac.value = rowClock
      u.uTime.value = clock
      u.uAmp.value = (0.2 + 0.5 * live) * (reduced ? 0.8 : 1) * (1 + 0.3 * st.groove + 0.35 * st.wobble)
      u.uDrift.value = (0.014 + 0.03 * bands.mid * live) * (reduced ? 0.6 : 1) * (1 + 1.2 * st.tension) * (1 - 0.9 * st.hold)
      u.uSquash.value = (1 - 0.3 * st.tension) * (1 + 0.3 * st.burst)
      u.uSub.value = st.subHold * live
      u.uSubW.value = 14 - 9 * st.subStretch
      u.uFlip.value = 0.7 * st.burst
      u.uGrade.value.set(st.heat, st.hue, st.gain)
      u.uVoice.value = voice * live
      u.uLive.value = live
      back.glow.value = 0.012 + 0.03 * live + 0.06 * drop
      u.uHigh.value = bands.high * live
      post.render(dt, Math.min(1, (0.35 * Math.min(1, kick) + 0.35 * a.rms) * live + 0.8 * drop + 0.6 * st.burst))
    },
    resize(width: number, height: number) {
      w = Math.max(1, Math.round(width))
      h = Math.max(1, Math.round(height))
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      pixelScale()
      post.setSize(w, h)
    },
    dispose() {
      post.dispose()
      back.dispose()
      geo.dispose()
      mat.dispose()
      hist.dispose()
      renderer.dispose()
    },
    setParams: (p) => st.setParams(p),
  }
}

export const pointCloudStyle: VisualStyle = { id: 'foxbox.pointcloud', label: 'POINT CLOUD', create }
