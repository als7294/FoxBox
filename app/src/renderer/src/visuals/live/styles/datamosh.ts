/**
 * DATAMOSH: a glowing spectrum field (mirrored bars, lows in the middle, over a slow ember haze) run through a
 * broken-codec feedback loop. Each frame the picture is rebuilt from the last one: healthy macroblocks heal toward
 * the fresh source, moshed ones drag the old pixels along their motion vectors instead (the P-frames without an
 * I-frame look). A kick moshes a share of the blocks with a fresh set of vectors that persist and decay; a new bar
 * cuts the picture into shuffled blocks; the drop does both, hard. On screen an RGB split and a short burst of
 * pixel-sort streaks ride the hits. Between hits it heals. Under reduced motion a hit is only a gentle RGB split.
 *
 * Song structure (structure.ts): up a build the blocks shrink, a creeping mosh sets in and the light heats; the held
 * breath freezes the codec on its last frame; the drop hit shreds it with the ghosts flipped. A held sub drags the
 * blocks for exactly the note's length (then it heals), a stab cuts a few blocks, a wobble pumps the split, a glide
 * turns the hue.
 */
import { DataTexture, LinearFilter, RedFormat, UnsignedByteType, Vector2, Vector3 } from 'three'
import { makePost, makeRenderer } from '../post'
import type { AudioFrame, StyleInstance, StyleOptions, VisualStyle } from '../registry'
import { Cues, ease, easeBands, logBands } from './audioKit'
import { GRADE_GLSL, Structure } from './structure'
import {
  disposeScenes,
  floatType,
  GLSL_HASH,
  paletteUniforms,
  PingPong,
  quadCamera,
  quadMaterial,
  quadScene,
  renderTo,
  target,
} from './feedback'

/** Bars across half the screen (mirrored). */
const BARS = 30

/** The clean picture: mirrored spectrum bars, lows in the middle, over a drifting haze. */
const SRC_FRAG = /* glsl */ `
uniform sampler2D uSpec;
uniform vec2 uRes;
uniform float uTime;
uniform float uLow;
uniform float uLive;
uniform float uZoom;
uniform vec3 uBg;
uniform vec3 uAccent;
uniform vec3 uAmber;
uniform vec3 uInk;
varying vec2 vUv;
${GLSL_HASH}
void main() {
  vec2 p = (vUv - 0.5) / uZoom;
  float aspect = uRes.x / uRes.y;
  // The haze: slow fbm in deep ember, lifted by the lows.
  float n = fbm(vec2(p.x * aspect, p.y) * 2.2 + vec2(uTime * 0.05, -uTime * 0.03));
  vec3 col = uBg + uAccent * pow(n, 3.0) * (0.05 + 0.1 * uLow);
  // Bars: |x| picks the band (lows at the centre), mirrored up and down about the middle line.
  float ax = abs(p.x) * 2.0 * 1.04;
  float idx = floor(ax * ${BARS}.0);
  float within = fract(ax * ${BARS}.0);
  float v = texture2D(uSpec, vec2((idx + 0.5) / ${BARS}.0, 0.5)).r;
  // Idle, a slow shimmer runs through the bars instead.
  v += (1.0 - uLive) * 0.06 * vnoise(vec2(idx * 0.35 - uTime * 0.4, uTime * 0.2));
  float hgt = 0.02 + v * 0.44;
  float ay = abs(p.y);
  float barMask = smoothstep(0.1, 0.22, within) * smoothstep(0.9, 0.78, within) * step(ax, 1.0);
  float body = barMask * (1.0 - smoothstep(hgt - 0.004, hgt, ay));
  float tip = barMask * exp(-pow((ay - hgt) / 0.006, 2.0));
  float t = clamp(ay / max(hgt, 0.02), 0.0, 1.0);
  vec3 barCol = mix(uAccent, uAmber, smoothstep(0.35, 0.95, t));
  col += barCol * body * (0.2 + 0.55 * t) * (0.35 + 0.65 * uLive);
  col += mix(uAmber, uInk, 0.5) * tip * 0.9 * (0.3 + 0.7 * uLive);
  // A thin horizon through the middle.
  col += uAccent * exp(-pow(p.y * uRes.y / 1.5, 2.0)) * 0.25;
  gl_FragColor = vec4(col, 1.0);
}
`

/** One codec step: heal toward the source, or drag the last frame along a block's motion vector; a cut shuffles blocks. */
const MOSH_FRAG = /* glsl */ `
uniform sampler2D uPrev;
uniform sampler2D uSrc;
uniform vec2 uRes;
uniform float uBlock;
uniform float uAmt;
uniform float uHeal;
uniform float uSeed;
uniform float uCut;
varying vec2 vUv;
${GLSL_HASH}
void main() {
  vec2 px = vUv * uRes;
  vec2 blk = floor(px / uBlock);
  vec2 uv = vUv;
  if (uCut > 0.0 && hash12(blk * 0.37 + uSeed * 1.3) < uCut) {
    // A cut: this block shows another block's pixels (a lost I-frame).
    vec2 grid = floor(uRes / uBlock);
    vec2 other = floor(hash22(blk + uSeed * 2.1) * grid);
    uv = (other + fract(px / uBlock)) * uBlock / uRes;
  }
  vec3 prev = texture2D(uPrev, uv).rgb;
  vec3 src = texture2D(uSrc, vUv).rgb;
  float h = hash12(blk + uSeed);
  vec3 col;
  if (h < uAmt) {
    // Moshed: last frame's pixels slide along the block's vector (mostly sideways, a few steep).
    vec2 mv = (hash22(blk * 1.7 + uSeed) - 0.5) * vec2(2.0, 0.7);
    mv += vec2(0.6, 0.0) * sign(hash12(vec2(uSeed, blk.y)) - 0.5);
    col = texture2D(uPrev, uv - mv * uBlock * 0.16 / uRes).rgb;
    col = mix(col, max(col, src), 0.08);
  } else {
    col = mix(prev, src, uHeal);
  }
  gl_FragColor = vec4(col, 1.0);
}
`

/** The screen: RGB split and, for a moment after a hit, pixel-sort streaks along some rows. */
const SHOW_FRAG = /* glsl */ `
uniform sampler2D uMosh;
uniform vec2 uRes;
uniform float uSplit;
uniform float uSort;
uniform float uSeed;
uniform float uFlip;
uniform vec3 uAccent;
uniform vec3 uIce;
uniform vec3 uGrade;
varying vec2 vUv;
${GLSL_HASH}
${GRADE_GLSL}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  // The split, in the palette rather than a rainbow: an accent ghost one way, an ice ghost the other.
  vec2 d = vec2(uSplit / uRes.x, 0.0);
  vec3 c0 = texture2D(uMosh, vUv).rgb;
  float s = clamp(uSplit / 5.0, 0.0, 1.0);
  // The drop hit flips them: ice leads, the accent trails.
  vec3 ga = mix(uAccent * 1.5, uIce * 1.3, uFlip);
  vec3 gb = mix(uIce * 0.9, uAccent * 1.1, uFlip);
  vec3 ghosts = luma(texture2D(uMosh, vUv + d).rgb) * ga + luma(texture2D(uMosh, vUv - d).rgb) * gb;
  vec3 col = c0 * (1.0 - 0.45 * s) + ghosts * 0.45 * s;
  if (uSort > 0.01) {
    // Rows (bands 3 px tall) picked by the hit smear their bright pixels rightward: a sort by luminance, approximated.
    float row = floor(vUv.y * uRes.y / 3.0);
    float on = step(hash12(vec2(row, uSeed)), uSort * 0.45);
    if (on > 0.0) {
      float len = (40.0 + 220.0 * hash12(vec2(uSeed, row * 1.31))) * uSort;
      vec3 best = vec3(0.0);
      for (int i = 1; i <= 24; i++) {
        float f = float(i) / 24.0;
        vec3 c = texture2D(uMosh, vUv - vec2(f * len / uRes.x, 0.0)).rgb;
        float keep = step(0.12, luma(c)) * (1.0 - f);
        best = max(best, c * keep);
      }
      col = max(col, best * 0.9);
    }
  }
  gl_FragColor = vec4(grade(col, uGrade), 1.0);
}
`

function create(canvas: HTMLCanvasElement, opts: StyleOptions): StyleInstance {
  const renderer = makeRenderer(canvas, opts)
  const cam = quadCamera()
  const pal = paletteUniforms(opts.palette)
  let w = Math.max(1, canvas.width)
  let h = Math.max(1, canvas.height)
  const res = new Vector2(w, h)
  const type = floatType(renderer)

  const specData = new Uint8Array(BARS)
  const spec = new DataTexture(specData, BARS, 1, RedFormat, UnsignedByteType)
  spec.magFilter = LinearFilter
  spec.minFilter = LinearFilter
  spec.needsUpdate = true
  const srcRT = target(w, h, type)
  const srcU = {
    ...pal,
    uSpec: { value: spec },
    uRes: { value: res },
    uTime: { value: 0 },
    uLow: { value: 0 },
    uLive: { value: 0 },
    uZoom: { value: 1 },
  }
  const { scene: srcScene } = quadScene(quadMaterial(SRC_FRAG, srcU))

  const mosh = new PingPong(w, h, type)
  mosh.clear(renderer)
  const moshU = {
    uPrev: { value: mosh.read.texture },
    uSrc: { value: srcRT.texture },
    uRes: { value: res },
    uBlock: { value: 32 },
    uAmt: { value: 0 },
    uHeal: { value: 0.2 },
    uSeed: { value: 0 },
    uCut: { value: 0 },
  }
  const { scene: moshScene } = quadScene(quadMaterial(MOSH_FRAG, moshU))

  const showU = {
    uAccent: pal.uAccent,
    uIce: pal.uIce,
    uMosh: { value: mosh.read.texture },
    uRes: { value: res },
    uSplit: { value: 0 },
    uSort: { value: 0 },
    uSeed: { value: 0 },
    uFlip: { value: 0 },
    uGrade: { value: new Vector3(0, 0, 1) },
  }
  const { scene } = quadScene(quadMaterial(SHOW_FRAG, showU))
  const post = makePost(renderer, scene, cam, opts, { bloom: 1.05, grain: 0.24, vignette: 0.64 })

  const cues = new Cues(opts.reduced)
  const st = new Structure(opts.reduced)
  let stab = 0
  const bands = { low: 0, mid: 0, high: 0 }
  const levels = new Float32Array(BARS)
  let time = 0
  let live = 0
  /** The mosh: the share of blocks dragging (jumps on a hit, decays), and the pixel-sort burst (short). */
  let amt = 0
  let sort = 0
  let seed = 1

  return {
    frame(a: AudioFrame, dt: number) {
      const step = Math.min(100, Math.max(0, dt))
      cues.step(a, step)
      st.step(a, step)
      easeBands(bands, a, step)
      live = ease(live, a.active ? 1 : 0, step, 350)
      // Structure's time (the held breath, half-time, a build, the director's speed) runs the haze and the decays.
      const ts = st.timeScale
      time += (step / 1000) * (opts.reduced ? 0.5 : 1) * ts
      logBands(a.active ? a.fft : null, a.sampleRate, levels, step, 0.03)
      for (let k = 0; k < BARS; k++) specData[k] = Math.round(Math.min(1, levels[k]! * (0.4 + 0.6 * live)) * 255)
      spec.needsUpdate = true

      const kick = a.song ? a.song.onset : a.onset
      const hit = a.active && kick >= 1
      const landed = cues.dropStart || (st.hit && cues.drop < 0.5)
      const stabbed = st.stab > stab + 0.3
      stab = st.stab
      if (!opts.reduced) {
        // A hit re-rolls the vectors and moshes a share of the blocks (more in the drop); the drop moshes most of them.
        if (hit || landed || stabbed) {
          seed = (seed * 1.618 + 0.37) % 97
          const k = st.intensity * (1 + 0.6 * st.groove)
          amt = Math.max(amt, landed ? 0.45 + 0.15 * st.burst : hit ? Math.min(0.3 * k, 0.16 * Math.min(1.5, kick) * k) : 0)
          sort = Math.max(sort, landed ? 1 : hit ? 0.4 : 0)
        }
        amt *= Math.exp(-(step * ts) / 380)
        sort *= Math.exp(-(step * ts) / 90)
        // A build creeps in a mosh; a held sub drags the blocks for exactly as long as it sounds.
        amt = Math.max(amt, 0.12 * st.tension, (0.16 + 0.1 * st.subStretch) * st.subHold)
      } else {
        amt = 0
        sort = 0
      }

      srcU.uTime.value = time
      srcU.uLow.value = bands.low
      srcU.uLive.value = live
      renderTo(renderer, srcRT, srcScene, cam)

      moshU.uPrev.value = mosh.read.texture
      // In the held breath the codec freezes: no drag, no healing, the last frame holds.
      moshU.uAmt.value = amt * (1 - st.hold)
      // Healing speeds up as the mosh fades (per 60 fps frame; scaled for the real step).
      const heal = opts.reduced ? 0.45 : 0.04 + 0.3 * Math.pow(1 - Math.min(1, amt / 0.2), 2)
      moshU.uHeal.value = (1 - Math.pow(1 - heal, step / 16.7)) * (1 - 0.95 * st.hold)
      moshU.uSeed.value = seed
      const cut = cues.newBar || landed ? (landed ? 0.3 + 0.15 * st.burst : 0.14) : stabbed ? 0.06 : 0
      moshU.uCut.value = !opts.reduced ? cut : 0
      // Up a build the blocks shrink (the picture gets finer, tighter).
      moshU.uBlock.value = Math.round(Math.max(16, h / 24) * (1 - 0.45 * st.tension))
      renderTo(renderer, mosh.write, moshScene, cam)
      mosh.swap()

      showU.uMosh.value = mosh.read.texture
      // The split: a few px on a hit (gentle under reduced motion), a touch on the voice's syllables.
      showU.uSplit.value =
        (h / 720) *
        (opts.reduced
          ? 2 * cues.kick
          : (3.5 * cues.kick + 1.5 * cues.voice + 7 * cues.drop) * st.intensity * (1 + 0.5 * st.groove) + 4 * st.wobble + 3 * st.stab)
      showU.uSort.value = sort
      showU.uSeed.value = seed
      showU.uFlip.value = st.burst
      showU.uGrade.value.set(st.heat, st.hue, st.gain)
      srcU.uZoom.value = st.zoom
      post.render(dt, Math.min(1, cues.kick * 0.35 + bands.low * 0.25 * live + cues.drop * 0.8 + 0.5 * st.burst))
    },
    resize(width: number, height: number) {
      w = Math.max(1, Math.round(width))
      h = Math.max(1, Math.round(height))
      res.set(w, h)
      srcRT.setSize(w, h)
      mosh.setSize(w, h)
      mosh.clear(renderer)
      post.setSize(w, h)
    },
    dispose() {
      post.dispose()
      srcRT.dispose()
      mosh.dispose()
      spec.dispose()
      disposeScenes(srcScene, moshScene, scene)
      renderer.dispose()
    },
    setParams: (p) => st.setParams(p),
  }
}

export const datamoshStyle: VisualStyle = { id: 'foxbox.datamosh', label: 'DATAMOSH', create }
