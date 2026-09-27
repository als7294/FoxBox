/**
 * The voice core: a particle sphere driven by the output spectrum and the sound's motion profile
 * (visuals/motionProfile.ts). Ported from the design's drawCore and extended per the user's brief:
 * DEPTH weighs it down, GRIT roughens it, MACHINE locks it to a lattice and the beat, SPACE leaves trails, and
 * each factory preset adds its signature (embers + satellites, orbiting clusters, drift, lattice, ghost trails,
 * glitch, breathing).
 *
 * Particles draw into an offscreen layer that fades rather than clears, which is where the trails come from;
 * the visible canvas composites that layer (sliced and split during SIGNAL glitches) over the glow. The text around
 * the core (caption, band labels, readouts) is DOM over the canvas (components/signal/VoiceCore.tsx), so it stays
 * crisp; the sphere is laid out to leave it room (coreLayout).
 */
import { clamp, f2, HX, nz, prep } from './canvas'
import type { Geom, Word } from './draw'
import type { MotionProfile } from './motionProfile'
import type { MotionSample } from './motionTrack'
import type { VbTheme } from './theme'
import { wordAt } from './wordLabels'

/**
 * The panel edges the HUD keeps for itself (CSS px; signal.module.css places the HUD inside them): the VOICE CORE
 * kicker at the top, the caption (word + BAR, up to ~42 px tall from 30 px up) and the PITCH / RMS readouts at the
 * bottom, the HIGH / MID / LOW column on the right (56 px, plus a 4 px gap to the sphere).
 */
export const CORE_HUD = { top: 30, bottom: 74, left: 20, right: 20 } as const

/** The sphere's silhouette at rest in core radii: the perspective bulge plus the idle spectrum's push. */
export const CORE_REST = 1.12

export interface CoreLayout {
  /** Centre of the sphere and its radius at rest (CSS px). */
  cx: number
  cy: number
  r: number
}

/** Where the sphere sits in a w×h panel: centred in what the HUD leaves, its resting silhouette filling that. */
export function coreLayout(w: number, h: number): CoreLayout {
  const x0 = CORE_HUD.left
  const x1 = w - CORE_HUD.right
  const y0 = CORE_HUD.top
  const y1 = h - CORE_HUD.bottom
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, r: Math.max(26, Math.min(x1 - x0, y1 - y0) / (2 * CORE_REST)) }
}

export interface CoreCaption {
  /** Changes when the caption does: a new word (even the same text again), a pause, or the stopped line. */
  key: string
  word: string
  /** A thrown word (drawn in the accent). */
  thrown: boolean
  bar: string
}

/** The caption under the core: the word being said and the beat while playing, else the file's length and bars. */
export function coreCaption(playT: number | null, words: readonly Word[], g: Geom): CoreCaption {
  if (playT == null) {
    const word = `${f2(g.target)} S`
    return { key: `stop ${word}`, word, thrown: false, bar: '' }
  }
  const i = wordAt(words, playT)
  const wd = i >= 0 ? words[i]! : null
  return {
    key: wd ? `word ${i}` : 'pause',
    word: wd ? wd.w.toUpperCase() : '·',
    thrown: Boolean(wd?.th),
    bar: `BAR ${Math.floor(playT / g.barDur) + 1}.${Math.floor((playT % g.barDur) / (g.barDur / 4)) + 1}`,
  }
}

export interface CoreInputs {
  th: VbTheme
  /** Seconds (frozen when idle under Reduce Motion). */
  t: number
  /** performance.now() and the time since the last frame, ms. */
  now: number
  dt: number
  playing: boolean
  lvl: number
  bins: Uint8Array | null
  sampleRate: number
  beatPulse: number
  /** Beat index while playing, -1 when stopped (stepped rotation locks to it). */
  beat: number
  stMix: number
  sm: Float32Array
  motion: MotionProfile
  /** Stack voices in the chain (satellite shells). */
  stackCount: number
  /** Reduce Motion: decorative motion stops (the sphere still answers the audio). */
  reduced: boolean
  /** RenderInfo.motion (v0.5) at the playhead while the wet side plays; null = chain-driven motion only. */
  track?: MotionSample | null
  /** Brightness over the calm default (a camera clip's picture wants more than the Studio panel). Default 1. */
  gain?: number
}

type RGB = [number, number, number]
const blend = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const css = (c: RGB, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a.toFixed(3)})`
const easeOut = (p: number) => 1 - Math.pow(1 - clamp(p), 3)
const hash = (v: number) => {
  const s = Math.sin(v * 12.9898) * 43758.5453
  return s - Math.floor(s)
}

const N = 820
/** Overall particle intensity (the core is a calm readout, not a light show). */
const CALM = 0.6
const NB = 48
const TAU = Math.PI * 2
let pts: Float32Array | null = null // x, y, z, phase per point (a Fibonacci sphere)
let seeds: Float32Array | null = null // 4 per point: size jitter, cluster, phase, drift speed

function init(): void {
  if (pts) return
  pts = new Float32Array(N * 4)
  seeds = new Float32Array(N * 4)
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N
    const r = Math.sqrt(1 - y * y)
    const ph = i * 2.39996
    pts.set([Math.cos(ph) * r, y, Math.sin(ph) * r, ph], i * 4)
    seeds.set([hash(i + 0.1), hash(i + 7.3), hash(i + 13.7), hash(i + 21.1)], i * 4)
  }
}

interface Layer {
  cv: HTMLCanvasElement
  x: CanvasRenderingContext2D
}
const layers = new WeakMap<HTMLCanvasElement, Layer>()

/** The fading particle layer behind a core canvas (same backing size; a resize clears it). */
function layerFor(cv: HTMLCanvasElement, w: number, h: number): Layer | null {
  let L = layers.get(cv)
  if (!L) {
    const c = document.createElement('canvas')
    const x = c.getContext('2d')
    if (!x) return null
    L = { cv: c, x }
    layers.set(cv, L)
  }
  if (L.cv.width !== cv.width || L.cv.height !== cv.height) {
    L.cv.width = cv.width
    L.cv.height = cv.height
  }
  L.x.setTransform(cv.width / w, 0, 0, cv.height / h, 0, 0)
  return L
}

// Motion state integrated frame to frame (so speed changes never jump the phase).
const S = {
  rot: 0,
  drift: 0,
  cluster: 0,
  stepFrom: 0,
  stepTo: 0,
  stepT0: 0,
  lastStep: Number.NaN,
  prevLvl: 0,
  glitchUntil: 0,
  glitchSeed: 0,
  frame: 0,
  /** The pitch ring (RenderInfo.motion f0): its latitude and how visible it is, eased. */
  f0y: 0,
  f0a: 0,
  /** Reactivity (1.2.3): band envelopes, spectral-flux onsets, a spring-loaded burst, spin kicks, shockwaves. */
  lowE: 0,
  midE: 0,
  highE: 0,
  fluxAvg: 0,
  lastOnset: 0,
  burst: 0,
  burstV: 0,
  spinV: 0,
  waves: [] as { t0: number; k: number }[],
  /** The last onset's strength (0 when none this frame): SIGNAL glitches on it, UNIT's lattice snaps a step. */
  hit: 0,
  /** ABYSS: the latitudes' accumulated twist (a swirl the low end drives). */
  swirl: 0,
  /** In and out with the voice: 0 in a gap (the core draws in), 1 on a loud word (it swells out). */
  swell: 0,
  /** The last frame's loudness envelope (a sudden drop is a word cutting off: an inward kick). */
  prevE: 0,
  /** The in/out scale, eased (so starting or stopping playback never jumps it). */
  io: 1,
}
/** The last frame's raw spectrum (onsets are rises against it). */
const prevRaw = new Float32Array(NB)
/** The main shell's projected particles this frame (the plexus lines join neighbours). */
const projX = new Float32Array(N)
const projY = new Float32Array(N)
const projD = new Float32Array(N)
const projE = new Float32Array(N)

/** Draws a frame; returns the layout it used (the HUD follows it), or null when the canvas isn't showing. */
export function drawCore(cv: HTMLCanvasElement | null, o: CoreInputs): CoreLayout | null {
  const P = prep(cv)
  if (!P || !cv) return null
  const { x, w, h } = P
  const { th, t } = o
  const M = o.motion
  const calm = o.reduced
  const pl = o.playing
  const lv = o.lvl
  const tr = pl ? (o.track ?? null) : null
  const lay = coreLayout(w, h)
  const { cx, cy } = lay
  const R0 = lay.r
  const dts = Math.min(0.1, o.dt / 1000)
  init()
  const sm = o.sm

  // Spectrum → 48 smoothed bands (idle: a quiet shimmer).
  let flux = 0
  for (let k = 0; k < NB; k++) {
    let v: number
    if (pl && o.bins) {
      const b = Math.min(511, Math.max(1, Math.round((70 * Math.pow(140, k / (NB - 1))) / (o.sampleRate / 1024))))
      v = o.bins[b]! / 255
    } else v = 0.045 + 0.012 * nz(k * 0.22 + t * 0.35)
    sm[k]! += (v - sm[k]!) * (v > sm[k]! ? 0.45 : 0.08)
    if (pl) flux += Math.max(0, v - prevRaw[k]!) * (k < 12 ? 1.4 : 1)
    prevRaw[k] = v
  }
  flux /= NB
  let low = 0
  for (let k = 0; k < 8; k++) low += sm[k]!
  low /= 8
  // Band envelopes: fast attack, slow release (lows swell the core, mids ripple it, highs sparkle it).
  let mid = 0
  let high = 0
  for (let k = 12; k < 30; k++) mid += sm[k]!
  for (let k = 30; k < NB; k++) high += sm[k]!
  mid /= 18
  high /= NB - 30
  const env = (cur: number, v: number) => cur + (v - cur) * (v > cur ? 0.5 : Math.min(1, dts * 3.2))
  S.lowE = env(S.lowE, pl ? low : 0)
  S.midE = env(S.midE, pl ? mid : 0)
  S.highE = env(S.highE, pl ? high : 0)
  // Onsets (spectral flux over its running average): a burst, a spin kick and a shockwave per hit.
  S.fluxAvg += (flux - S.fluxAvg) * 0.06
  if (!calm && pl && flux > S.fluxAvg * 1.7 + 0.01 && o.now - S.lastOnset > 105) {
    const k = clamp((flux - S.fluxAvg) * 14)
    S.lastOnset = o.now
    S.hit = k
    S.burstV += 3.2 * k
    S.spinV += (M.rot >= 0 ? 1 : -1) * 0.9 * k * (1 - clamp(M.step))
    if (k > 0.18) {
      S.waves.push({ t0: o.now, k })
      if (S.waves.length > 6) S.waves.shift()
    }
  }
  else S.hit = 0
  // In and out: the core swells with the voice (fast in, slower out) and draws in through the gaps; a word
  // cutting off kicks it inward, so the spring pulls it in past rest before it settles.
  // The render's own voicing (RenderInfo.motion f0) says word or gap even when a loud master keeps the bands up;
  // without it, the loudness decides.
  const loud = pl ? clamp((S.lowE * 0.6 + S.midE * 1.2) * 2.2) : 0
  const target = !pl ? 0 : tr ? (tr.f0 != null ? 0.6 + 0.4 * loud : 0.05) : loud
  S.swell += (target - S.swell) * (target > S.swell ? Math.min(1, dts * 16) : Math.min(1, dts * 5))
  if (!calm && pl && S.prevE - target > 0.3) S.burstV -= 1.4 * (S.prevE - target)
  S.prevE = target
  // The burst is a damped spring: out on the hit, back with a little overshoot.
  S.burstV += (-95 * S.burst - 12 * S.burstV) * dts
  S.burst += S.burstV * dts
  if (calm || !pl) S.burst *= 0.9
  S.spinV *= Math.exp(-dts * 3)

  // Integrated motion: rotation, drift, cluster orbits (all stop under Reduce Motion).
  // Tape-stop (RenderInfo.motion): the rotation brakes to a standstill with the tape.
  const brake = tr?.tapeStop != null ? 1 - tr.tapeStop : 1
  if (!calm) {
    S.rot += (M.rot + S.spinV) * dts * brake
    S.drift += M.drift * 0.05 * dts
    S.cluster += (0.45 + 0.2 * (1 - M.mass)) * dts
    S.swirl += M.drift * (0.25 + S.lowE * 2.6 + clamp(S.burst) * 1.5) * dts
  }
  // MACHINE / UNIT: rotation that steps on the beat (every 0.8 s when stopped), snapping in ~90 ms.
  const stepA = Math.PI / 8
  const stepIndex = calm ? 0 : o.beat >= 0 ? o.beat : Math.floor(o.now / 800)
  if (stepIndex !== S.lastStep) {
    const current = S.stepFrom + (S.stepTo - S.stepFrom) * easeOut((o.now - S.stepT0) / 90)
    S.stepFrom = current
    // Each new beat turns the lattice one more step (the very first frame just settles).
    S.stepTo = Number.isNaN(S.lastStep) ? current : S.stepTo + stepA
    S.stepT0 = o.now
    S.lastStep = stepIndex
  }
  // UNIT: a hit snaps the lattice another step (two on a strong one), between the beats too.
  if (S.hit > 0 && M.lattice > 0.45) {
    S.stepFrom = S.stepFrom + (S.stepTo - S.stepFrom) * easeOut((o.now - S.stepT0) / 90)
    S.stepTo += stepA * (S.hit > 0.45 ? 2 : 1)
    S.stepT0 = o.now
  }
  const stepRot = S.stepFrom + (S.stepTo - S.stepFrom) * easeOut((o.now - S.stepT0) / 90)
  // Beat lock (MACHINE, or the arrange plan's beat_lock event): the rotation steps on the beat.
  const stepMix = Math.max(clamp(M.step), tr?.beatLock ? 1 : 0)
  const rot = S.rot + o.beatPulse * 0.02 * (1 - stepMix) + (stepRot - S.rot) * stepMix

  // SIGNAL: a transient (a jump in level) starts a short glitch: stutter, displaced slices, RGB split.
  const jump = lv - S.prevLvl
  S.prevLvl = lv
  if (!calm && pl && M.glitch > 0.2 && (jump > 0.05 || S.hit > 0.12) && o.now > S.glitchUntil + 70) {
    S.glitchUntil = o.now + 90 + (90 + 120 * S.hit) * M.glitch
    S.glitchSeed = Math.random() * 1000
  }
  // The arrange plan's stutter glitches SIGNAL for as long as it repeats.
  const glitching = !calm && M.glitch > 0.2 && (o.now < S.glitchUntil || Boolean(tr?.stutter))
  S.frame++

  // Global scale: breathing (RAW), sub pulses (PACT, DEPTH), and the tremor that growl drives (ABYSS).
  const breathe = calm ? 0 : M.breathing * 0.03 * Math.sin(t * 1.2)
  const pulse = M.subPulse * (low * 0.22 + o.beatPulse * 0.05)
  // Playing, the core breathes with the voice: drawn in to 0.84 in the gaps, out to 1.1 on loud words, plus the hits.
  S.io += ((calm || !pl ? 1 : 0.84 + 0.26 * S.swell) - S.io) * Math.min(1, dts * 12)
  const inOut = S.io
  const scale0 = (1 + breathe) * (1 + pulse) * (1 + M.spread * 0.06) * inOut * (1 + clamp(S.burst, -0.4, 1) * 0.1)
  const shake = !calm && pl ? M.tremor * (0.35 + lv) * R0 * 0.045 : 0
  const ox = shake ? (Math.random() - 0.5) * shake : 0
  // Tape-stop: the core sags as it slows.
  const sag = !calm && tr?.tapeStop != null ? tr.tapeStop * tr.tapeStop * R0 * 0.22 : 0
  const oy = (shake ? (Math.random() - 0.5) * shake : 0) + sag

  // Palette: LOW accent, MID amber, HIGH ink, then ember / pale / darkness / stale.
  const bg = HX(th.bg)
  const ink = HX(th.ink)
  // Darkness sinks toward a deep ember rather than grey, so ABYSS reads dark red, not dim white.
  const deep = blend(bg, HX(th.accent), 0.38)
  const tint = (c: RGB): string => {
    let v = blend(c, blend(HX(th.accent), HX(th.amber), 0.55), M.ember * 0.6)
    v = blend(v, blend(HX(th.ice), ink, 0.55), M.pale * 0.75)
    v = blend(v, deep, M.darkness * 0.6)
    return css(blend(v, ink, o.stMix * 0.7))
  }
  const cLo = tint(HX(th.accent))
  const cMi = tint(HX(th.amber))
  const cHi = tint(M.ember > 0.5 ? HX(th.amber) : ink)
  // A calm instrument readout (user feedback: "too bright"): ~60% of the old intensity, flaring only on strong words.
  const alphaK = Math.min(1, CALM * (o.gain ?? 1)) * (1 - M.darkness * 0.4) * (1 - M.pale * 0.4) * (1 - o.stMix * 0.5)

  const layer = layerFor(cv, w, h)
  if (!layer) return null
  const T = layer.x
  // Hold frames: SIGNAL's glitch, and the arrange plan's stutter (freeze-frames on the repeats).
  const stutter = (glitching && S.frame % 2 === 0) || (!calm && Boolean(tr?.stutter) && S.frame % 3 !== 0)
  // Trails: keep part of the last frame instead of clearing it. `keep60` is the share kept per 60 Hz frame,
  // scaled to the real frame time (ProMotion runs at 120 Hz). Each frame then adds only enough light that a
  // still particle settles at most ~1.5x its trail-less brightness: the additive layer never whites out, and
  // anything moving leaves a faint wake.
  // The returns envelope (reverb, delay and throws ringing on) lengthens the trails once the voice stops (unvoiced),
  // so the core dissolves into its tail after the last word without smearing the words themselves.
  const tailing = tr && tr.f0 == null ? tr.returns : 0
  // GHOST: a hit smears the trails out further.
  const keep60 = calm ? 0 : clamp(M.trails + tailing * 0.45 * (1 - M.trails) + clamp(S.burst) * 0.35 * M.trails) * 0.9
  const keep = keep60 > 0 ? Math.pow(keep60, clamp(o.dt / 16.7, 0.25, 3)) : 0
  const gain = keep > 0 ? (1 + 0.6 * keep60) * (1 - keep) : 1
  if (!stutter) {
    T.globalCompositeOperation = 'destination-out'
    T.globalAlpha = 1
    T.fillStyle = `rgba(0,0,0,${(1 - keep).toFixed(3)})`
    T.fillRect(0, 0, w, h)
    T.globalCompositeOperation = 'lighter'

    const cr = Math.cos(rot)
    const sr = Math.sin(rot)
    const tilt = 0.38
    const ct = Math.cos(tilt)
    const st = Math.sin(tilt)
    const rings = M.lattice > 0.05 ? Math.round(26 - 19 * clamp(M.lattice)) : 0
    const az = Math.round(48 - 36 * clamp(M.lattice))
    const snap = clamp(M.lattice * 1.6)
    const K = 3
    const split = glitching ? (2.5 + 5 * clamp(S.burst)) * M.rgb : 0
    const sharp = M.sharp >= 0.5
    const soft = 1 - clamp(M.sharp * 2)

    /** Rotates, tilts and projects a point in sphere units; returns [sx, sy, depth 0..1]. */
    const project = (X: number, Y: number, Z: number, R: number): [number, number, number] => {
      const x1 = X * cr + Z * sr
      const z1 = -X * sr + Z * cr
      const y2 = Y * ct - z1 * st
      const z2 = Y * st + z1 * ct
      const f = 2.8 / (2.8 - z2)
      let sx = cx + ox + x1 * R * f
      const sy = cy + oy - y2 * R * f
      // LEGION: radio scan lines sweep down the core and jolt the particles they cross.
      if (M.scan > 0.01 && !calm) {
        const band = (((sy / h) * 9 + t * 0.6) % 1 + 1) % 1
        if (band < 0.12) sx += M.scan * R * 0.1 * nz(sy * 0.3 + t * 7)
      }
      return [sx, sy, (z2 + 1.2) / 2.4]
    }

    const dot = (sx: number, sy: number, size: number, alpha: number, color: string) => {
      if (sharp) {
        sx = Math.round(sx)
        sy = Math.round(sy)
      }
      alpha *= gain
      T.globalAlpha = Math.min(1, alpha)
      T.fillStyle = color
      T.fillRect(sx - size / 2, sy - size / 2, size, size)
      if (soft > 0.2) {
        // Soft particles: a faint halo (GHOST, PACT embers).
        T.globalAlpha = Math.min(1, alpha * 0.16 * soft)
        const hs = size * 2.4
        T.fillRect(sx - hs / 2, sy - hs / 2, hs, hs)
      }
      if (split) {
        // SIGNAL RGB split while glitching.
        T.globalAlpha = Math.min(1, alpha * 0.6)
        T.fillStyle = '#ff2a3c'
        T.fillRect(sx - size / 2 - split, sy - size / 2, size, size)
        T.fillStyle = '#29e8ff'
        T.fillRect(sx - size / 2 + split, sy - size / 2, size, size)
      }
    }

    const shell = (scale: number, alphaMul: number, stride: number) => {
      const R = R0 * scale0
      for (let n = 0; n < N; n += stride) {
        const i4 = n * 4
        let py = pts![i4 + 1]!
        let ph = pts![i4 + 3]!
        const s1 = seeds![i4]!
        const s2 = seeds![i4 + 1]!
        const s3 = seeds![i4 + 2]!
        const s4 = seeds![i4 + 3]!
        // ABYSS: particles sink slowly through the sphere and come back in at the top.
        if (M.drift > 0.01) py = ((((py + 1 - S.drift * (0.6 + s4 * 0.8)) % 2) + 2) % 2) - 1
        // ABYSS: the latitudes twist against each other, a slow swirl the low end winds up.
        if (M.drift > 0.01) ph += S.swirl * py * 2.2
        // MACHINE / UNIT: latitude rings and azimuth steps.
        if (rings) {
          py += (Math.round(py * rings) / rings - py) * snap
          ph += ((Math.round((ph / TAU) * az) * TAU) / az - ph) * snap
        }
        const r = Math.sqrt(Math.max(0, 1 - py * py))
        let px = Math.cos(ph) * r
        let pz = Math.sin(ph) * r
        const band = Math.min(NB - 1, Math.floor(((py + 1) / 2) * NB))
        const e = sm[band]!
        // DEPTH pulls inward on low-end energy; GRIT turbulence; the spectrum pushes out.
        // Loud masters keep the bands high, so the spectrum's push is compressed: the sphere holds its shape and
        // the hits (burst, below) are what throw it out.
        let d =
          Math.sqrt(e) * 0.2 * (1 - 0.4 * M.gravity) -
          M.gravity * low * (py < 0 ? 0.45 : 0.2) +
          0.014 * nz(px * 2.2 + py * 1.7 + t * 0.4) +
          M.turbulence * 0.05 * nz(px * 3.3 + py * 2.1 + t * 1.9 + s3 * 7)
        if (pl && M.turbulence > 0.05 && !calm) d += (Math.random() - 0.5) * M.turbulence * 0.12 * e
        if (!calm) {
          // Mids ripple across the surface; hits throw the particles out (each by its own amount) and back.
          d += S.midE * 0.13 * Math.sin(py * 9 - t * 7 + s3 * 6) * (1 - 0.7 * clamp(M.lattice))
          d += S.burst * 0.28 * (0.5 + s1)
        }
        const rr = scale * (1 + d)
        let X = px * rr
        let Y = py * rr * (1 - M.mass * 0.08)
        let Z = pz * rr
        // LEGION: the collage — the sphere splits into clusters orbiting the centre.
        if (M.clusters > 0.01) {
          const k = Math.floor(s2 * K)
          const a = S.cluster + (k * TAU) / K
          const ccx = Math.cos(a) * 0.58
          const ccy = Math.sin(k * 2.1 + S.cluster * 0.7) * 0.3
          const ccz = Math.sin(a) * 0.58
          X += (ccx + px * 0.36 * (1 + d) - X) * M.clusters
          Y += (ccy + py * 0.36 * (1 + d) - Y) * M.clusters
          Z += (ccz + pz * 0.36 * (1 + d) - Z) * M.clusters
        }
        const [sx, sy, depth] = project(X, Y, Z, R)
        // Smaller, softer particles; energy squared, so only strong words flare.
        let size = (0.6 + depth * 1.2) * (1 + e * e * 0.45) * M.size * (0.85 + s1 * 0.3)
        let alpha = (0.1 + depth * 0.5 + e * e * 0.45) * alphaMul * alphaK
        // Highs: a few particles sparkle (a different few every ~50 ms).
        if (!calm && S.highE > 0.04 && hash(n * 1.7 + Math.floor(t * 20)) < S.highE * 0.25) {
          size *= 1.4
          alpha *= 2
        }
        if (scale === 1 && alphaMul === 1) {
          projX[n] = sx
          projY[n] = sy
          projD[n] = depth
          projE[n] = e
        }
        dot(sx, sy, size, alpha, py < -0.34 ? cLo : py < 0.34 ? cMi : cHi)
      }
    }

    // SPACE: a diffuse outer shell.
    if (M.spread > 0.05) shell(1.22 + M.spread * 0.2, 0.22 * M.spread, 2)
    // Reverse swell (RenderInfo.motion): the halo inhales toward the core until the first word.
    if (tr?.swell != null && !calm) shell(1.62 - 0.55 * tr.swell, 0.1 + 0.3 * tr.swell, 2)
    shell(1, 1, 1)

    // Plexus: when the voice pushes, near neighbours on the sphere link up (Fibonacci offsets are neighbours).
    const push = clamp((S.midE + S.lowE) * 1.6 + clamp(S.burst) * 0.6 - 0.12)
    if (!calm && push > 0.02 && M.clusters < 0.5) {
      // Batched: each link goes into one of four alpha buckets, stroked once each (a stroke per line costs 60 fps).
      const buckets: Path2D[] = [new Path2D(), new Path2D(), new Path2D(), new Path2D()]
      const maxD = R0 * 0.32
      for (let n = 0; n < N; n++) {
        for (const off of [21, 34]) {
          const m = n + off
          if (m >= N) continue
          const dz = Math.min(projD[n]!, projD[m]!)
          if (dz < 0.4) continue
          const dx = projX[n]! - projX[m]!
          const dy = projY[n]! - projY[m]!
          const dd = dx * dx + dy * dy
          if (dd > maxD * maxD || dd < 1) continue
          const a = push * (projE[n]! + projE[m]!) * 0.5 * dz
          if (a < 0.02) continue
          const b = buckets[Math.min(3, Math.floor(a * 8))]!
          b.moveTo(projX[n]!, projY[n]!)
          b.lineTo(projX[m]!, projY[m]!)
        }
      }
      T.lineWidth = 0.6
      T.strokeStyle = cMi
      buckets.forEach((b, i) => {
        T.globalAlpha = Math.min(1, ((i + 0.5) / 8) * 0.55 * alphaK * gain)
        T.stroke(b)
      })
    }

    // PACT: stack voices as faint satellite shells.
    const sats = M.satellites > 0.05 ? Math.min(3, o.stackCount) : 0
    for (let sIdx = 0; sIdx < sats; sIdx++) {
      const a = S.cluster * 0.4 + (sIdx * TAU) / Math.max(1, sats)
      const scx = Math.cos(a) * 1.42
      const scy = Math.sin(a * 1.3 + sIdx) * 0.28
      const scz = Math.sin(a) * 1.42
      for (let n = 0; n < N; n += 7) {
        const i4 = n * 4
        const [sx, sy, depth] = project(scx + pts![i4]! * 0.22, scy + pts![i4 + 1]! * 0.22, scz + pts![i4 + 2]! * 0.22, R0 * scale0)
        dot(sx, sy, 0.9 + depth, (0.08 + depth * 0.25) * M.satellites * alphaK, cMi)
      }
    }

    // UNIT: the lattice's rings as crisp lines.
    if (rings && M.lattice > 0.45 && M.clusters < 0.5) {
      T.globalCompositeOperation = 'source-over'
      T.globalAlpha = 0.1 * clamp((M.lattice - 0.45) * 2) * alphaK
      T.strokeStyle = cHi
      T.lineWidth = 1
      const R = R0 * scale0
      for (let rIdx = 1; rIdx < rings * 2; rIdx++) {
        const yy = -1 + rIdx / rings
        const rr = Math.sqrt(Math.max(0, 1 - yy * yy))
        T.beginPath()
        for (let j = 0; j <= az; j++) {
          const a = (j / az) * TAU
          const [sx, sy] = project(Math.cos(a) * rr, yy * (1 - M.mass * 0.08), Math.sin(a) * rr, R)
          if (j === 0) T.moveTo(sx, sy)
          else T.lineTo(sx, sy)
        }
        T.stroke()
      }
    }
    T.globalCompositeOperation = 'source-over'
    T.globalAlpha = 1
  }

  /** A latitude ring on the visible canvas (`yy` in sphere units, `scale` x the core radius). */
  const ring = (yy: number, scale: number, alpha: number, color: string) => {
    const R = R0 * scale0 * scale
    const rr = Math.sqrt(Math.max(0, 1 - yy * yy))
    const cr = Math.cos(rot)
    const sr = Math.sin(rot)
    const ct = Math.cos(0.38)
    const st = Math.sin(0.38)
    x.globalAlpha = Math.min(1, alpha)
    x.strokeStyle = color
    x.lineWidth = 1
    x.beginPath()
    for (let j = 0; j <= 64; j++) {
      const a = (j / 64) * TAU
      const X = Math.cos(a) * rr
      const Z = Math.sin(a) * rr
      const x1 = X * cr + Z * sr
      const z1 = -X * sr + Z * cr
      const y2 = yy * ct - z1 * st
      const z2 = yy * st + z1 * ct
      const f = 2.8 / (2.8 - z2)
      const sx = cx + ox + x1 * R * f
      const sy = cy + oy - y2 * R * f
      if (j === 0) x.moveTo(sx, sy)
      else x.lineTo(sx, sy)
    }
    x.stroke()
    x.globalAlpha = 1
  }

  // ---- visible canvas: glow, the particle layer, speckle (the text is the DOM HUD's)
  x.clearRect(0, 0, w, h)
  const glowA = 1 - M.darkness * 0.5
  const ret = tr?.returns ?? 0
  const gl = x.createRadialGradient(cx, cy, 0, cx, cy, R0 * (1.5 + ret * 0.35))
  const warm = blend(HX(th.amber), blend(HX(th.ice), ink, 0.5), M.pale)
  // Less bloom: a faint glow that lifts a little on loud passages.
  gl.addColorStop(0, css(warm, (0.025 + lv * 0.12 + clamp(S.burst) * 0.1 + ret * 0.07 + (tr?.squelch ? 0.06 : 0)) * glowA))
  gl.addColorStop(0.6, css(HX(th.accent), (0.01 + lv * 0.04) * glowA))
  gl.addColorStop(1, css(HX(th.accent), 0))
  x.fillStyle = gl
  x.fillRect(0, 0, w, h)

  const L = layer.cv
  if (glitching) {
    // SIGNAL: horizontal slices knocked sideways.
    const slices = 7
    const ky = L.height / h
    for (let sIdx = 0; sIdx < slices; sIdx++) {
      const y0 = (sIdx * h) / slices
      const hh = h / slices + 1
      const dx = (hash(S.glitchSeed + sIdx) - 0.5) * R0 * 0.35 * M.glitch
      x.drawImage(L, 0, y0 * ky, L.width, hh * ky, dx, y0, w, hh)
    }
  } else x.drawImage(L, 0, 0, w, h)

  // Pitch ring (RenderInfo.motion f0): a thin ring at the height of the output pitch while voiced; steady on
  // monotone presets, moving with a natural or talkbox voice.
  const voiced = tr?.f0 != null
  if (voiced) S.f0y += (clamp((tr!.f0! - 57) / 24, -1, 1) * 0.72 - S.f0y) * (calm ? 1 : 0.25)
  S.f0a += ((voiced ? 1 : 0) - S.f0a) * (calm ? 1 : 0.2)
  if (S.f0a > 0.02) ring(S.f0y, 1, CALM * S.f0a * (0.06 + 0.2 * (0.4 + lv)), tint(ink))
  // Throw echoes: a ring that flashes and widens as each echo sounds.
  if (tr && tr.echo > 0.01 && !calm) ring(0, 1.06 + (1 - tr.echo) * 0.45, tr.echo * 0.45, cMi)
  // Shockwaves: each hit sends an equatorial ring out from the core that fades as it widens.
  if (!calm) {
    S.waves = S.waves.filter((wv) => o.now - wv.t0 < 700)
    for (const wv of S.waves) {
      const age = (o.now - wv.t0) / 700
      const a = (1 - age) * (1 - age) * wv.k * 0.55 * Math.min(1, CALM * (o.gain ?? 1) * 1.4)
      ring(0, 1.02 + easeOut(age) * 0.95, a, age < 0.25 ? tint(ink) : cMi)
    }
  }

  // LEGION: radio scanlines rolling down the panel, flaring on hits and hiss.
  if (M.scan > 0.05 && !calm) {
    x.fillStyle = cMi
    for (let i = 0; i < 3; i++) {
      const yy = ((t * 0.18 + i / 3) % 1) * h
      x.globalAlpha = Math.min(1, M.scan * (0.05 + S.highE * 0.5 + clamp(S.burst) * 0.35) * alphaK * 2)
      x.fillRect(0, Math.round(yy), w, 1)
    }
    x.globalAlpha = Math.min(1, 0.035 * M.scan)
    for (let yy = 0; yy < h; yy += 3) x.fillRect(0, yy, w, 1)
    x.globalAlpha = 1
  }

  // LEGION: static speckle over the core (still under Reduce Motion); the plan's squelch bursts it.
  const specks = Math.round(90 * M.speckle) + (tr?.squelch ? 110 : 0)
  if (specks) {
    x.fillStyle = th.ink
    for (let i = 0; i < specks; i++) {
      const r1 = calm ? hash(i + 3.1) : Math.random()
      const r2 = calm ? hash(i + 9.7) : Math.random()
      x.globalAlpha = 0.12 + (calm ? hash(i) : Math.random()) * 0.25
      x.fillRect(Math.round(r1 * w), Math.round(r2 * h), 1, 1)
    }
    x.globalAlpha = 1
  }
  return lay
}
