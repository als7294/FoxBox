/**
 * VOICE CORE on the big screen: the Studio's particle sphere (visuals/core.ts's drawCore, with the Studio's current
 * preset for its motion, as the clips' coreSource does) drawn off-screen at the stage's full size, uploaded as a
 * texture and run through the shared post chain. The voice drives the sphere (its level, and the spectrum scaled to its
 * share of the mix when a song plays); the song drives the backdrop around it: a glow that breathes with its lows and
 * rings that ripple out on its kicks, wider on a new bar, and a surge on the drop. The voice's onsets add a touch of
 * chromatic aberration from the sphere's centre. The particles stay 1:1 with the canvas, so they stay crisp.
 */
import { CanvasTexture, LinearFilter, SRGBColorSpace, Vector2 } from 'three'
import { liveParam } from '@/components/signal/VoiceCore'
import { useStudio } from '@/state/studio'
import { coreLayout, drawCore } from '@/visuals/core'
import { motionTarget } from '@/visuals/motionProfile'
import { theme, type VbTheme } from '@/visuals/theme'
import { makePost, makeRenderer } from '../post'
import type { AudioFrame, StyleInstance, StyleOptions, VisualStyle } from '../registry'
import { Cues, ease, songBands } from './audioKit'
import { disposeScenes, paletteUniforms, quadCamera, quadMaterial, quadScene } from './feedback'

/** The most rings in flight at once. */
const RINGS = 6

const SHOW_FRAG = /* glsl */ `
uniform sampler2D uCore;
uniform vec2 uRes;
uniform vec2 uCenter;
uniform float uR;
uniform float uAb;
uniform float uGlow;
uniform float uLow;
uniform float uRingR[${RINGS}];
uniform float uRingA[${RINGS}];
uniform vec3 uBg;
uniform vec3 uAccent;
uniform vec3 uAmber;
varying vec2 vUv;
void main() {
  vec2 d = (vUv - uCenter) * uRes;
  float r = length(d) / uR;
  // The song's backdrop: a glow that breathes with its lows, and the rings its kicks send out.
  vec3 col = uBg + uAccent * exp(-r * r * 0.7) * (0.01 + 0.035 * uLow + 0.08 * uGlow);
  for (int i = 0; i < ${RINGS}; i++) {
    float a = uRingA[i];
    if (a > 0.002) {
      float w = 0.006 + 0.014 * max(0.0, uRingR[i] - 1.0);
      col += mix(uAccent, uAmber, 0.35) * exp(-pow((r - uRingR[i]) / w, 2.0)) * a * 0.3;
    }
  }
  // The core (premultiplied), split a little along the radius on the voice's onsets.
  vec4 c = texture2D(uCore, vUv);
  if (uAb > 0.0001) {
    vec2 dir = (vUv - uCenter) * uAb;
    c.r = texture2D(uCore, vUv + dir).r;
    c.b = texture2D(uCore, vUv - dir).b;
  }
  col = col * (1.0 - c.a) + c.rgb;
  gl_FragColor = vec4(col, 1.0);
}
`

/** The Studio theme with the stage's palette in it (the core draws in these). */
function themeFor(p: StyleOptions['palette']): VbTheme {
  return { ...theme(), bg: p.bg, accent: p.accent, amber: p.amber, ink: p.ink, ice: p.ice }
}

function create(canvas: HTMLCanvasElement, opts: StyleOptions): StyleInstance {
  const renderer = makeRenderer(canvas, opts)
  const cam = quadCamera()
  let w = Math.max(1, canvas.width)
  let h = Math.max(1, canvas.height)
  const res = new Vector2(w, h)

  // Off the page, drawCore keeps the canvas's size and draws at 2× (so the layout is in half-size px).
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const tex = new CanvasTexture(cv)
  tex.colorSpace = SRGBColorSpace
  tex.premultiplyAlpha = true
  tex.generateMipmaps = false
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter

  const ringR = new Float32Array(RINGS)
  const ringA = new Float32Array(RINGS)
  const u = {
    ...paletteUniforms(opts.palette),
    uCore: { value: tex },
    uRes: { value: res },
    uCenter: { value: new Vector2(0.5, 0.5) },
    uR: { value: 100 },
    uAb: { value: 0 },
    uGlow: { value: 0 },
    uLow: { value: 0 },
    uRingR: { value: ringR },
    uRingA: { value: ringA },
  }
  const { scene } = quadScene(quadMaterial(SHOW_FRAG, u))
  const post = makePost(renderer, scene, cam, opts, { bloom: 0.9, grain: 0.16, vignette: 0.6 })

  const th = themeFor(opts.palette)
  const sm = new Float32Array(64)
  const bins = new Uint8Array(512)
  const cues = new Cues(opts.reduced)
  const rings: { age: number; k: number }[] = []
  let now = 0
  let beat = -1
  let lastPhase = 0
  let low = 0

  const ring = (k: number) => {
    rings.push({ age: 0, k: opts.reduced ? k * 0.4 : k })
    if (rings.length > RINGS) rings.shift()
  }

  return {
    frame(a: AudioFrame, dt: number) {
      const step = Math.min(100, Math.max(0, dt))
      now += step
      cues.step(a, step)
      if (a.active && a.beatPhase < lastPhase - 0.5) beat++
      lastPhase = a.beatPhase
      if (!a.active) beat = -1
      else if (beat < 0) beat = 0

      // The voice drives the sphere: its level, and the spectrum scaled to its share of the mix when a song plays.
      const voiceLvl = a.voice ? a.voice.rms : a.rms
      let spectrum = a.fft
      if (a.fft && a.song && a.voice) {
        const share = Math.min(1, a.voice.rms / Math.max(0.02, a.rms))
        const n = Math.min(bins.length, a.fft.length)
        for (let i = 0; i < n; i++) bins[i] = a.fft[i]! * share
        spectrum = bins
      }
      const s = useStudio.getState()
      const lay = drawCore(cv, {
        th,
        t: now / 1000,
        now,
        dt: step || 16,
        playing: a.active,
        lvl: Math.min(1, voiceLvl * 1.5),
        bins: a.active ? spectrum : null,
        sampleRate: a.sampleRate,
        beatPulse: a.active ? Math.exp(-a.beatPhase * 5) : 0,
        beat,
        stMix: 0,
        sm,
        motion: motionTarget({
          presetId: s.presetId,
          macros: s.macros,
          param: (module, param) => liveParam(s, module, param),
          stackCount: s.stack.length,
          dry: false,
        }),
        stackCount: s.stack.length,
        reduced: opts.reduced,
        track: null,
        gain: 1.8,
      })
      tex.needsUpdate = true
      const L = lay ?? coreLayout(w / 2, h / 2)
      u.uCenter.value.set(L.cx / (w / 2), 1 - L.cy / (h / 2))
      u.uR.value = L.r * 2

      // The song's rings: out on each kick, a wider one on a new bar, a big one on the drop.
      const kick = a.song ? a.song.onset : a.onset
      if (cues.dropStart) ring(1.6)
      else if (cues.newBar) ring(1)
      else if (a.active && kick >= 1) ring(0.35 * Math.min(1.5, kick))
      const speed = opts.reduced ? 0.5 : 1.3
      for (const r of rings) r.age += step / 1000
      while (rings.length && rings[0]!.age > 2.5) rings.shift()
      ringR.fill(0)
      ringA.fill(0)
      rings.forEach((r, i) => {
        ringR[i] = 1.15 + r.age * speed * (0.7 + 0.3 * Math.min(1, r.k))
        ringA[i] = r.k * Math.exp(-r.age * (r.k >= 1 ? 1.6 : 3.2)) * Math.min(1, r.age * 7)
      })
      low = ease(low, a.active ? songBands(a).low : 0, step, 120)
      u.uLow.value = low
      u.uGlow.value = Math.max(cues.kick * 0.5, cues.drop)
      u.uAb.value = opts.reduced ? 0 : 0.0025 * cues.voice + 0.004 * cues.drop
      post.render(dt, Math.min(1, voiceLvl * 0.5 + cues.voice * 0.25 + cues.drop * 0.8))
    },
    resize(width: number, height: number) {
      w = Math.max(1, Math.round(width))
      h = Math.max(1, Math.round(height))
      res.set(w, h)
      cv.width = w
      cv.height = h
      tex.dispose() // a new size needs new storage
      post.setSize(w, h)
    },
    dispose() {
      post.dispose()
      tex.dispose()
      disposeScenes(scene)
      renderer.dispose()
    },
  }
}

export const coreStyle: VisualStyle = { id: 'foxbox.core', label: 'VOICE CORE', create }
