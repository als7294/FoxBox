/**
 * SCOPE: an XY oscilloscope. The left channel drives the beam across, the right one up (a mono source plots against
 * a delayed copy of itself, so a tone draws an ellipse). The beam is a strip of thin quads whose brightness follows its
 * dwell time, like a real phosphor (slow corners burn, fast strokes fade), drawn additively into a feedback buffer that
 * decays each frame for the persistence. A faint graticule sits under it. Kicks flare the beam (the song's, when one
 * plays; the voice's syllables a little), each new bar turns the figure an eighth and swaps its hue between ember and
 * amber, and the drop surges: a wider, hotter beam with a longer afterglow.
 */
import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, Mesh, ShaderMaterial, Vector2 } from 'three'
import { makePost, makeRenderer } from '../post'
import type { AudioFrame, StyleInstance, StyleOptions, VisualStyle } from '../registry'
import { disposeScenes, floatType, paletteUniforms, PingPong, quadCamera, quadMaterial, quadScene, renderTo } from './feedback'
import { Cues, ease, lissajous, monoDelay, peakOf } from './audioKit'

/** Points per frame (the analyser's waveform length). */
const MAX = 1024

const BEAM_VERT = /* glsl */ `
attribute vec2 aA;
attribute vec2 aB;
attribute vec2 aSide;
attribute float aI;
uniform vec2 uRes;
uniform float uScale;
uniform float uWidth;
uniform float uRot;
varying float vAcross;
varying float vI;
void main() {
  vec2 c = uRes * 0.5;
  mat2 rot = mat2(cos(uRot), sin(uRot), -sin(uRot), cos(uRot));
  vec2 pa = c + rot * aA * uScale;
  vec2 pb = c + rot * aB * uScale;
  vec2 d = pb - pa;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec2 p = mix(pa, pb, aSide.x) + nrm * aSide.y * uWidth + dir * (aSide.x * 2.0 - 1.0) * uWidth * 0.5;
  vAcross = aSide.y;
  vI = aI;
  gl_Position = vec4(p / c - 1.0, 0.0, 1.0);
}
`

const BEAM_FRAG = /* glsl */ `
uniform vec3 uAccent;
uniform vec3 uAmber;
uniform vec3 uInk;
uniform float uGain;
uniform float uHue;
varying float vAcross;
varying float vI;
void main() {
  float x = abs(vAcross);
  float halo = exp(-x * x * 3.2);
  float core = exp(-x * x * 26.0);
  vec3 glow = mix(mix(uAccent, uAmber, 0.3), mix(uAmber, uInk, 0.15), uHue);
  vec3 col = glow * halo * 0.5 + mix(uAmber, uInk, 0.6) * core * 0.5;
  gl_FragColor = vec4(col * vI * uGain, 1.0);
}
`

/** The last frame, decayed (the phosphor's persistence). */
const FADE_FRAG = /* glsl */ `
uniform sampler2D uPrev;
uniform float uKeep;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(uPrev, vUv).rgb * uKeep;
  gl_FragColor = vec4(max(c - 0.0015, 0.0), 1.0);
}
`

/** The screen: background, graticule, the phosphor buffer. */
const SHOW_FRAG = /* glsl */ `
uniform sampler2D uTrail;
uniform vec2 uRes;
uniform float uScale;
uniform float uFlare;
uniform vec3 uBg;
uniform vec3 uInk;
uniform vec3 uAccent;
varying vec2 vUv;
float line(float d, float w) { return 1.0 - smoothstep(w * 0.5, w * 0.5 + 1.0, d); }
void main() {
  vec2 p = vUv * uRes - uRes * 0.5;
  float cell = uScale / 4.0;
  vec2 g = abs(fract(p / cell + 0.5) - 0.5) * cell;
  float grid = max(line(g.x, 1.0), line(g.y, 1.0)) * 0.55;
  // The axes, brighter, with minor ticks every fifth of a division.
  vec2 ax = abs(p);
  float axes = max(line(ax.x, 1.0), line(ax.y, 1.0));
  vec2 tk = abs(fract(p / (cell / 5.0) + 0.5) - 0.5) * (cell / 5.0);
  float ticks = max(line(tk.x, 1.0) * step(ax.y, 5.0), line(tk.y, 1.0) * step(ax.x, 5.0));
  float box = max(ax.x, ax.y);
  float inside = 1.0 - smoothstep(uScale * 1.02, uScale * 1.35, box);
  float gr = (grid + axes * 0.6 + ticks * 0.7) * inside;
  vec3 col = uBg + uInk * gr * 0.028;
  // A faint glow pooled in the middle, lifted on hits.
  float r = length(p) / uScale;
  col += uAccent * exp(-r * r * 2.2) * (0.018 + 0.05 * uFlare);
  col += texture2D(uTrail, vUv).rgb;
  gl_FragColor = vec4(col, 1.0);
}
`

function beamGeometry(): BufferGeometry {
  const segs = MAX - 1
  const g = new BufferGeometry()
  const side = new Float32Array(segs * 8)
  const index = new Uint32Array(segs * 6)
  for (let s = 0; s < segs; s++) {
    side.set([0, -1, 0, 1, 1, -1, 1, 1], s * 8)
    const v = s * 4
    index.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], s * 6)
  }
  g.setAttribute('position', new BufferAttribute(new Float32Array(segs * 12), 3))
  g.setAttribute('aA', new BufferAttribute(new Float32Array(segs * 8), 2))
  g.setAttribute('aB', new BufferAttribute(new Float32Array(segs * 8), 2))
  g.setAttribute('aSide', new BufferAttribute(side, 2))
  g.setAttribute('aI', new BufferAttribute(new Float32Array(segs * 4), 1))
  g.setIndex(new BufferAttribute(index, 1))
  return g
}

function create(canvas: HTMLCanvasElement, opts: StyleOptions): StyleInstance {
  const renderer = makeRenderer(canvas, opts)
  const cam = quadCamera()
  const pal = paletteUniforms(opts.palette)
  let w = Math.max(1, canvas.width)
  let h = Math.max(1, canvas.height)
  const trail = new PingPong(w, h, floatType(renderer))
  trail.clear(renderer)

  // The feedback pass: the decayed last frame, then the beam on top (additive).
  const fade = quadMaterial(FADE_FRAG, { uPrev: { value: null }, uKeep: { value: 0.8 } })
  const { scene: trailScene, mesh: fadeMesh } = quadScene(fade)
  fadeMesh.renderOrder = 0
  const res = new Vector2(w, h)
  const beamU = {
    ...pal,
    uRes: { value: res },
    uScale: { value: 1 },
    uWidth: { value: 1.6 },
    uGain: { value: 1 },
    uRot: { value: 0 },
    uHue: { value: 0 },
  }
  const beamMat = new ShaderMaterial({
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    uniforms: beamU,
    blending: AdditiveBlending,
    side: DoubleSide,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const geo = beamGeometry()
  const beam = new Mesh(geo, beamMat)
  beam.frustumCulled = false
  beam.renderOrder = 1
  trailScene.add(beam)

  const showU = { ...pal, uTrail: { value: trail.read.texture }, uRes: { value: res }, uScale: { value: 1 }, uFlare: { value: 0 } }
  const { scene } = quadScene(quadMaterial(SHOW_FRAG, showU))
  const post = makePost(renderer, scene, cam, opts, { bloom: 1.25, grain: 0.18, vignette: 0.7 })

  const xy = new Float32Array(MAX * 2)
  const aA = geo.getAttribute('aA') as BufferAttribute
  const aB = geo.getAttribute('aB') as BufferAttribute
  const aI = geo.getAttribute('aI') as BufferAttribute
  const cues = new Cues(opts.reduced)
  let gain = 1
  /** The figure's turn and hue: each new bar moves the targets, the values ease after them. */
  let rot = 0
  let rotTo = 0
  let hue = 0
  let hueTo = 0
  let idleT = 0
  let live = 0

  /** Fills the segment attributes from `n` points; brightness per segment is its dwell time (1 / its length in px). */
  function upload(n: number, scale: number, bright: number): void {
    const A = aA.array as Float32Array
    const B = aB.array as Float32Array
    const I = aI.array as Float32Array
    const segs = Math.max(0, n - 1)
    for (let s = 0; s < segs; s++) {
      const x0 = xy[s * 2]! * gain
      const y0 = xy[s * 2 + 1]! * gain
      const x1 = xy[s * 2 + 2]! * gain
      const y1 = xy[s * 2 + 3]! * gain
      const len = Math.hypot(x1 - x0, y1 - y0) * scale
      const i = Math.min(1.3, 1.5 / (len + 0.9)) * bright
      for (let v = 0; v < 4; v++) {
        const k = s * 4 + v
        A[k * 2] = x0
        A[k * 2 + 1] = y0
        B[k * 2] = x1
        B[k * 2 + 1] = y1
        I[k] = i
      }
    }
    aA.needsUpdate = true
    aB.needsUpdate = true
    aI.needsUpdate = true
    geo.setDrawRange(0, segs * 6)
  }

  return {
    frame(a: AudioFrame, dt: number) {
      const step = Math.min(100, Math.max(0, dt))
      cues.step(a, step)
      const env = Math.min(1.5, cues.kick + 0.35 * cues.voice + cues.drop)
      if (cues.newBar || cues.dropStart) {
        if (!opts.reduced) rotTo += Math.PI / 8
        hueTo = 1 - hueTo
      }
      rot = ease(rot, rotTo, step, 70)
      hue = ease(hue, hueTo, step, opts.reduced ? 600 : 90)
      beamU.uRot.value = rot
      beamU.uHue.value = hue
      live = ease(live, a.active ? 1 : 0, step, 400)
      const scale = Math.min(w, h) * 0.42
      let n = a.active ? lissajous(a.waveL, a.waveR, xy, monoDelay(a.sampleRate)) : 0
      if (n > 1) {
        // Auto-gain: a quiet voice still fills the screen, a loud master doesn't clip it.
        const target = Math.min(3, 0.88 / Math.max(0.12, peakOf(xy, n)))
        gain = ease(gain, target, step, target < gain ? 60 : 500)
        upload(n, scale, 0.35 + 0.65 * live)
      } else {
        // Idle: a small, slow 3:2 figure drifting in the middle, dim.
        idleT += (step / 1000) * (opts.reduced ? 0.25 : 0.6)
        n = 360
        for (let i = 0; i < n; i++) {
          const u = idleT + (i / n) * Math.PI * 2
          xy[i * 2] = 0.1 * Math.sin(u * 3 + idleT * 0.7)
          xy[i * 2 + 1] = 0.1 * Math.sin(u * 2)
        }
        gain = ease(gain, 1, step, 300)
        upload(n, scale, 0.22)
      }
      // Persistence: ~110 ms (longer, softer under reduced motion).
      fade.uniforms.uKeep!.value = Math.exp(-step / ((opts.reduced ? 200 : 110) * (1 + 1.5 * cues.drop)))
      fade.uniforms.uPrev!.value = trail.read.texture
      beamU.uScale.value = scale
      beamU.uWidth.value = Math.max(1.4, Math.min(w, h) / 560) * (1 + 1.1 * env)
      beamU.uGain.value = 1 + 1.6 * env
      renderTo(renderer, trail.write, trailScene, cam)
      trail.swap()
      showU.uTrail.value = trail.read.texture
      showU.uScale.value = scale
      showU.uFlare.value = env
      post.render(dt, Math.min(1, env * 0.45 + a.rms * 0.4 * live + cues.drop * 0.6))
    },
    resize(width: number, height: number) {
      w = Math.max(1, Math.round(width))
      h = Math.max(1, Math.round(height))
      res.set(w, h)
      trail.setSize(w, h)
      trail.clear(renderer)
      post.setSize(w, h)
    },
    dispose() {
      post.dispose()
      trail.dispose()
      disposeScenes(trailScene, scene)
      renderer.dispose()
    },
  }
}

export const scopeStyle: VisualStyle = { id: 'foxbox.scope', label: 'SCOPE', create }
