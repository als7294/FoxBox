/**
 * SPECTRAL TERRAIN: a 3D spectrogram waterfall to fly over. Each new spectrum rises as a ridge on the horizon (lows in
 * the middle, highs mirrored out to both sides) and rolls toward the camera as the rows behind it age, so the last
 * three seconds of sound lie out as a landscape. It's drawn as glowing contour lines on a dark surface that hides
 * what's behind the peaks. Kicks (the song's when one plays) flash the newest row and the flash rides the ridge all
 * the way in; each bar leaves a brighter row line; the drop surges the glow and dips the camera. The voice is the sun
 * low on the horizon behind it all.
 *
 * Song structure (structure.ts): up a build the land rises, the flight speeds and dips lower and the light heats; the
 * held breath stops the land; the drop hit throws the ridges up in ice. A held sub raises the canyon walls for the
 * note's length (spreading as it holds), a stab flashes the newest row, a wobble pumps the heights, a glide sways the
 * flight.
 *
 * The rows are a 128 × 128 RGBA byte texture used as a ring buffer (height, kick flash, bar line), written at 40 rows/s;
 * the heights and the lines are all in the shaders.
 */
import {
  DataTexture,
  LinearFilter,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
} from 'three'
import { makePost, makeRenderer } from '../post'
import type { AudioFrame, StyleInstance, StyleOptions, VisualStyle } from '../registry'
import { ease } from './audioKit'
import { Cues, fullscreenTriangle, glPalette, logSpectrum, v3 } from './gl'
import { GRADE_GLSL, Structure } from './structure'

const FREQ = 128
const ROWS = 128
const ROW_RATE = 40
const WIDTH = 4.6
const DEPTH = 6
const FAR_Z = -DEPTH

const TERRAIN_VERT = /* glsl */ `
uniform sampler2D uRows;
uniform float uHead;
uniform float uFrac;
uniform float uAmp;
uniform float uTime;
uniform float uSub;
uniform float uSubW;
varying float vAge;
varying float vH;
varying vec3 vRow;
varying float vX;
varying float vDist;

void main() {
  // uv.y: 1 at the far (newest) edge, 0 at the near one; the rows slide toward the camera between writes.
  float age = (1.0 - uv.y) * ${(ROWS - 1).toFixed(1)} + uFrac;
  // The lows are the canyon walls at both sides, the highs its floor down the middle.
  float s = 1.0 - abs(uv.x * 2.0 - 1.0);
  float v = (uHead - age + 0.5) / ${ROWS.toFixed(1)};
  vec4 t = texture2D(uRows, vec2(0.01 + s * 0.98, v));
  // Heights: peaks stand up, the floor stays low; the far edge rises out of the ground as a row arrives.
  float rise = smoothstep(0.0, 1.5, age);
  float h = pow(t.r, 2.2) * uAmp * rise;
  // A held sub: the canyon walls stand up, spreading inward as the note holds.
  h += uSub * 0.3 * pow(1.0 - s, uSubW) * rise;
  vec3 p = vec3(position.x, h, ${FAR_Z.toFixed(1)} + age * ${(DEPTH / (ROWS - 1)).toFixed(5)});
  vAge = age;
  vH = h;
  vRow = t.rgb;
  vX = uv.x * ${(FREQ * 2 - 2).toFixed(1)};
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`

const TERRAIN_FRAG = /* glsl */ `
uniform vec3 uBg;
uniform vec3 uAccent;
uniform vec3 uAmber;
uniform vec3 uInk;
uniform vec3 uIce;
uniform float uAmp;
uniform float uGain;
uniform float uFlash;
uniform float uFlip;
uniform vec3 uGrade;
varying float vAge;
varying float vH;
varying vec3 vRow;
varying float vX;
varying float vDist;

${GRADE_GLSL}

// An anti-aliased line on the integer values of c, fading out where the lines get denser than ~2 px.
float lines(float c, float width) {
  float fw = fwidth(c);
  float d = abs(fract(c - 0.5) - 0.5) / max(fw, 1e-4);
  return (1.0 - smoothstep(width - 0.5, width + 0.5, d)) * (1.0 - smoothstep(0.25, 0.6, fw));
}

void main() {
  float hN = clamp(vH / max(uAmp, 1e-3), 0.0, 1.0);
  vec3 col = mix(uAccent * 0.8, uAmber, smoothstep(0.2, 0.7, hN));
  col = mix(col, uInk, smoothstep(0.75, 1.0, hN) * 0.7);
  col = mix(col, mix(uIce, uInk, 0.4), uFlip);
  // Row lines (the contour of each spectrum) and sparser lines across them.
  float row = lines(vAge, 0.7);
  float across = lines(vX / 8.0, 0.5) * 0.28;
  float k = vRow.g;
  float bar = vRow.b;
  float line = max(row, across) * (0.1 + 0.85 * hN * hN + 1.2 * k);
  vec3 c = col * line;
  c += mix(uAmber, uInk, 0.5) * row * k * 1.2;
  c += mix(uIce, uInk, 0.5) * row * bar * 0.9;
  // The surface itself: near black, warmed a touch by height, so peaks hide the rows behind them.
  c += uAccent * hN * 0.05 + uAccent * k * 0.04;
  c *= uGain;
  // Fog: distance softens the horizon a little; the oldest rows melt away before they pass under the camera.
  float fog = (1.0 - 0.5 * smoothstep(3.5, 7.5, vDist)) * (1.0 - smoothstep(${(ROWS * 0.5).toFixed(1)}, ${(ROWS * 0.95).toFixed(1)}, vAge));
  gl_FragColor = vec4(uBg + grade(c * fog * (1.0 + 0.5 * uFlash), uGrade), 1.0);
}
`

const SKY_FRAG = /* glsl */ `
uniform vec3 uBg;
uniform vec3 uAccent;
uniform vec3 uAmber;
uniform vec3 uInk;
uniform float uHorizon;
uniform float uAspect;
uniform float uSun;
uniform float uGlow;
uniform vec3 uGrade;
varying vec2 vUv;
${GRADE_GLSL}
void main() {
  vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y - uHorizon);
  float band = exp(-p.y * p.y * 60.0);
  vec3 c = uAccent * band * uGlow;
  // The sun: a soft ember disc on the horizon that grows and warms with the voice.
  float r = length(p - vec2(0.0, 0.02));
  float size = 0.05 + 0.05 * uSun;
  float core = exp(-r * r / (size * size) * 2.5);
  float halo = exp(-r * r / (size * size) * 0.35);
  c += mix(uAccent, uAmber, 0.3 + 0.5 * uSun) * (core * (0.1 + 0.45 * uSun) + halo * (0.025 + 0.1 * uSun));
  c += uInk * core * uSun * uSun * 0.2;
  gl_FragColor = vec4(uBg + grade(c, uGrade), 1.0);
}
`

const SKY_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`

function create(canvas: HTMLCanvasElement, opts: StyleOptions): StyleInstance {
  const { reduced } = opts
  const renderer = makeRenderer(canvas, opts)
  // The sky paints the background; a black clear keeps the post chain's clear from lifting it.
  renderer.setClearColor(0x000000, 1)
  const pal = glPalette(opts.palette)
  let w = Math.max(1, canvas.width)
  let h = Math.max(1, canvas.height)

  const rows = new DataTexture(new Uint8Array(FREQ * ROWS * 4), FREQ, ROWS, RGBAFormat, UnsignedByteType)
  rows.magFilter = LinearFilter
  rows.minFilter = LinearFilter
  rows.wrapT = RepeatWrapping
  rows.needsUpdate = true
  const spec = new Float32Array(FREQ)
  const smooth = new Float32Array(FREQ)

  const colours = {
    uBg: { value: v3(pal.bg) },
    uAccent: { value: v3(pal.accent) },
    uAmber: { value: v3(pal.amber) },
    uInk: { value: v3(pal.ink) },
  }
  const u = {
    ...colours,
    uIce: { value: v3(pal.ice) },
    uRows: { value: rows },
    uHead: { value: 0 },
    uFrac: { value: 0 },
    uAmp: { value: 0.9 },
    uTime: { value: 0 },
    uGain: { value: 1 },
    uFlash: { value: 0 },
    uSub: { value: 0 },
    uSubW: { value: 6 },
    uFlip: { value: 0 },
    uGrade: { value: new Vector3(0, 0, 1) },
  }
  const geo = new PlaneGeometry(WIDTH, 1, FREQ * 2 - 2, ROWS - 1)
  const mat = new ShaderMaterial({ vertexShader: TERRAIN_VERT, fragmentShader: TERRAIN_FRAG, uniforms: u })
  const terrain = new Mesh(geo, mat)
  terrain.frustumCulled = false

  const skyU = {
    ...colours,
    uHorizon: { value: 0.6 },
    uAspect: { value: w / h },
    uSun: { value: 0 },
    uGlow: { value: 0.03 },
    uGrade: u.uGrade,
  }
  const skyMat = new ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: skyU, depthTest: false })
  const tri = fullscreenTriangle()
  const sky = new Mesh(tri, skyMat)
  sky.frustumCulled = false
  sky.renderOrder = -1

  const scene = new Scene()
  scene.add(sky, terrain)
  const camera = new PerspectiveCamera(46, w / h, 0.05, 40)
  const post = makePost(renderer, scene, camera, opts, { bloom: 1.15, grain: 0.2, vignette: 0.68 })

  const cues = new Cues(reduced)
  const st = new Structure(reduced)
  const horizon = new Vector3()
  let clock = 0
  let head = 0
  let rowClock = 0
  let barMark = 0
  let dip = 0

  return {
    frame(a: AudioFrame, dt: number) {
      const step = Math.min(100, Math.max(0, dt))
      cues.update(a, step)
      st.step(a, step)
      // Structure's time: the flight speeds up a build and stops in the held breath; half-time slows it.
      const s = (step / 1000) * st.timeScale
      clock += s
      const { bands, kick, live, voice, drop } = cues
      const calm = reduced ? 0.4 : 1
      const k = st.intensity * (1 + 0.4 * st.groove)

      // The newest row: the log spectrum (silence when idle, plus a slow swell so the land never lies dead flat).
      logSpectrum(a.active ? a.fft : null, a.sampleRate, spec)
      for (let i = 0; i < FREQ; i++) {
        const swell = 0.1 + 0.06 * Math.sin(clock * 0.35 + i * 0.09) * Math.sin(clock * 0.21 - i * 0.05)
        const t = Math.max(spec[i]!, swell * (1 - live))
        smooth[i] = ease(smooth[i]!, t, step, t > smooth[i]! ? 20 : 90)
      }
      if (cues.bar) barMark = 1
      rowClock += s * ROW_RATE
      const data = rows.image.data as Uint8Array
      while (rowClock >= 1) {
        rowClock -= 1
        head = (head + 1) % ROWS
        // The flash: kicks, the drop, the hit's burst and bass stabs.
        const flash = Math.round(Math.min(1, (kick * calm * k) / 1.2 + drop * 0.6 + st.burst + st.stab * 0.8 * calm) * 255)
        const bar = Math.round(barMark * 255)
        barMark = 0
        for (let i = 0; i < FREQ; i++) {
          const o = (head * FREQ + i) * 4
          data[o] = Math.round(Math.min(1, smooth[i]!) * 255)
          data[o + 1] = flash
          data[o + 2] = bar
          data[o + 3] = 255
        }
        rows.needsUpdate = true
      }

      // The camera: flying down the canyon, drifting side to side; the drop punches the lens in.
      if (cues.dropHit || (st.hit && cues.drop < 0.5)) dip = calm
      dip = ease(dip, 0, step, 900)
      const fov = (46 - 7 * dip) / st.zoom
      if (Math.abs(camera.fov - fov) > 0.01) {
        camera.fov = fov
        camera.updateProjectionMatrix()
      }
      const sway = reduced ? 0.06 : 0.16
      // Up a build the flight dips toward the ridges; a glide sways it off the line.
      const bend = st.glide * 0.25
      camera.position.set(Math.sin(clock * 0.09) * sway + bend, 0.78 + 0.04 * Math.sin(clock * 0.13) - 0.08 * st.tension, 0.9)
      camera.lookAt(Math.sin(clock * 0.09 + 0.8) * sway * 0.4 + bend * 0.5, 0.12, FAR_Z * 0.8)
      camera.rotateZ(Math.sin(clock * 0.07) * (reduced ? 0.005 : 0.018))
      camera.updateMatrixWorld()
      horizon.set(0, 0, FAR_Z - 30).project(camera)

      u.uHead.value = head
      u.uFrac.value = rowClock
      u.uTime.value = clock
      u.uAmp.value = (0.3 + 0.6 * live) * (1 + 0.3 * st.tension + 0.15 * st.groove + 0.25 * st.burst + 0.15 * st.wobble)
      u.uGain.value = (0.45 + 0.5 * live + 0.35 * drop) * (1 + 0.25 * st.groove)
      u.uFlash.value = drop
      u.uSub.value = st.subHold * live
      u.uSubW.value = 6 - 4 * st.subStretch
      u.uFlip.value = 0.7 * st.burst
      u.uGrade.value.set(st.heat, st.hue, st.gain)
      skyU.uHorizon.value = horizon.y * 0.5 + 0.5
      skyU.uSun.value = voice * live
      skyU.uGlow.value = 0.012 + 0.025 * bands.low * live + 0.06 * drop + 0.05 * st.subHold * live + 0.04 * st.groove
      post.render(dt, Math.min(1, (0.35 * Math.min(1, kick) + 0.3 * a.rms) * live + 0.8 * drop + 0.6 * st.burst))
    },
    resize(width: number, height: number) {
      w = Math.max(1, Math.round(width))
      h = Math.max(1, Math.round(height))
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      skyU.uAspect.value = w / h
      post.setSize(w, h)
    },
    dispose() {
      post.dispose()
      geo.dispose()
      mat.dispose()
      tri.dispose()
      skyMat.dispose()
      rows.dispose()
      renderer.dispose()
    },
    setParams: (p) => st.setParams(p),
  }
}

export const terrainStyle: VisualStyle = { id: 'foxbox.terrain', label: 'SPECTRAL TERRAIN', create }
