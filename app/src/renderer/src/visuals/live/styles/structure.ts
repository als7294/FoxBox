/**
 * Song structure and the bass line (registry.ts's 1.5 fields) turned into the smoothed signals every FOXBOX style
 * reads, so the seven react to a build, the held breath, the drop and the bass the same way, each in its own idiom.
 * Pure (no WebGL), so it's unit-tested. Every field is optional: while they're absent (TRACK without analysis, MIC)
 * each signal sits at its neutral value (0, or 1 for the scales) and a style adds or multiplies them in, so it looks
 * exactly as it did without them. Under reduced motion there's no burst and everything else is gentler.
 *
 * Also the AUTO-VJ director's params (StyleInstance.setParams): 'intensity', 'speed', 'zoom', 0–1 with 0.5 the
 * default look, eased into multipliers (1 at 0.5).
 */
import type { AudioFrame } from '../registry'
import { ease } from './audioKit'

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/** A director param (0–1) as a multiplier: `lo` at 0, 1 at 0.5, `hi` at 1 (geometric, so 0.5 is the middle). */
const scaleOf = (p: number, lo: number, hi: number): number => (p < 0.5 ? lo * Math.pow(1 / lo, p * 2) : Math.pow(hi, (p - 0.5) * 2))

/** The grade every style runs its colour through: `uGrade` = (heat, hue turn in radians, gain); (0, 0, 1) is a no-op. */
export const GRADE_GLSL = /* glsl */ `
vec3 grade(vec3 c, vec3 g) {
  if (abs(g.y) > 1e-4) {
    // Turn the hue about the grey axis (Rodrigues).
    const vec3 k = vec3(0.57735);
    float cs = cos(g.y), sn = sin(g.y);
    c = c * cs + cross(k, c) * sn + k * dot(k, c) * (1.0 - cs);
    c = max(c, 0.0);
  }
  // Heat: drained toward a hot white-amber (a build's tension).
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(c, l * vec3(1.3, 0.98, 0.72), g.x * 0.6);
  return c * g.z;
}
`

export class Structure {
  /** 0–1: a build's tension (buildProgress, eased), held through the held breath, released at the hit. */
  tension = 0
  /** 0–1: the held breath before the drop (motion freezes, the picture dims a touch). */
  hold = 0
  /**
   * True on the frame a drop lands (dropHit; or dropIndex / dropEnergy jumping, if that frame was missed). Styles skip
   * it when their own `drop` reaction already fired (Cues.drop high).
   * ponytail: if dropHit came a frame before `drop`, a style's drop reaction runs twice; key both on one edge if seen.
   */
  hit = false
  /** 0–1: the release at the hit, decaying over ~half a second. Always 0 under reduced motion. */
  burst = 0
  /** 0–1: the drop's heat (dropEnergy, with a floor while the section is the drop). */
  groove = 0
  /** 0–1: a second or later drop (eased); a style varies its look by `alt × groove`. */
  alt = 0
  /** 0–1: a held note (a long sub): up at the note, held exactly while it sounds, gone quickly after. */
  subHold = 0
  /** 0–1: how far through its expected length the held note is (a shape stretches with it). */
  subStretch = 0
  /** 0–1: a short bass stab (riddim, trap 808 hits): jumps on the note, gone within the note's length. */
  stab = 0
  /** 0–1: the bass LFO at its phase, scaled by its depth; 0 without one (wobble.div unset). */
  wobble = 0
  /** −1…1: an 808 glide's bend (±12 semitones), easing back after the slide. */
  glide = 0
  /** Motion's rate: 1 normally, slower in half-time, nearly still in the held breath, a touch faster up a build; × speed. */
  timeScale = 1
  /** The grade (GRADE_GLSL): heat 0–1, hue turn (radians), gain. */
  heat = 0
  hue = 0
  gain = 1
  /** The director's params as multipliers (1 at 0.5, today's look). */
  intensity = 1
  speed = 1
  zoom = 1

  private readonly target = { intensity: 1, speed: 1, zoom: 1 }
  private sinceHit = Infinity
  private lastIndex: number | null = null
  private lastEnergy = NaN
  private half = 1
  private bend = 0
  private depth = 0

  constructor(private readonly reduced: boolean) {}

  /** The director's params; unknown names and non-numbers are ignored. */
  setParams(p: Record<string, number>): void {
    const v = (k: string) => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? clamp01(p[k]!) : null)
    const i = v('intensity')
    const s = v('speed')
    const z = v('zoom')
    if (i != null) this.target.intensity = scaleOf(i, 0.35, 1.7)
    if (s != null) this.target.speed = scaleOf(s, 0.4, 2)
    if (z != null) this.target.zoom = scaleOf(z, 0.75, 1.3)
  }

  step(a: AudioFrame, dtMs: number): this {
    const dt = Math.min(100, Math.max(0, dtMs))
    const on = a.active
    const calm = this.reduced
    const beatMs = a.bpm > 0 ? 60_000 / a.bpm : 500
    for (const k of ['intensity', 'speed', 'zoom'] as const) this[k] = ease(this[k], this.target[k], dt, 400)

    // The hit: dropHit, or (a frame dropped on the way) dropIndex stepping up / dropEnergy jumping; once per beat.
    const idx = a.dropIndex ?? null
    const energy = on ? clamp01(a.dropEnergy ?? 0) : 0
    const jumped = (idx != null && this.lastIndex != null && idx > this.lastIndex) || energy > this.lastEnergy + 0.5
    this.sinceHit += dt
    this.hit = on && (Boolean(a.dropHit) || jumped) && this.sinceHit > beatMs
    if (this.hit) this.sinceHit = 0
    this.lastIndex = idx
    this.lastEnergy = energy

    // The build: tension rises with it and holds through the held breath; at the hit it lets go.
    const pre = on && Boolean(a.preDrop)
    const build = on ? clamp01(a.buildProgress ?? 0) * (calm ? 0.6 : 1) : 0
    const tt = this.hit ? 0 : pre ? Math.max(build, this.tension) : build
    this.tension = ease(this.tension, tt, dt, calm ? 700 : tt > this.tension ? 300 : 180)
    this.hold = this.hit && !calm ? 0 : ease(this.hold, pre ? 1 : 0, dt, calm ? 350 : pre ? 110 : 160)
    this.burst = calm ? 0 : this.hit ? 1 : this.burst * Math.exp(-dt / 450)
    const g = on ? Math.max(energy, a.section === 'drop' ? 0.6 : 0) * (calm ? 0.5 : 1) : 0
    this.groove = ease(this.groove, g, dt, g > this.groove ? (calm ? 400 : 80) : 1500)
    this.alt = ease(this.alt, on && (idx ?? 1) >= 2 ? 1 : 0, dt, 800)

    // The bass: a held note, a stab, the wobble, a glide.
    const b = on ? a.bass : undefined
    const long = Boolean(b?.on && (b.expectBeats >= 1 || b.heldBeats >= 1))
    this.subHold = ease(this.subHold, long ? 0.55 + 0.45 * clamp01(b!.sub) : 0, dt, long ? (calm ? 200 : 50) : calm ? 300 : 120)
    this.subStretch = long ? clamp01(b!.heldBeats / Math.max(1, b!.expectBeats)) : ease(this.subStretch, 0, dt, 200)
    const expect = b ? Math.max(0, b.expectBeats) : 0
    this.stab *= Math.exp(-dt / (Math.min(240, Math.max(60, expect * beatMs * 0.5)) * (calm ? 2 : 1)))
    if (b?.noteOn && expect < 1) this.stab = Math.max(this.stab, (0.6 + 0.4 * clamp01(Math.max(b.growl, b.sub))) * (calm ? 0.35 : 1))
    this.depth = ease(this.depth, b?.on && b.wobble.div ? (0.35 + 0.65 * clamp01(b.growl)) * (calm ? 0.3 : 1) : 0, dt, 90)
    this.wobble = this.depth * (0.5 - 0.5 * Math.cos(2 * Math.PI * (b?.wobble.phase ?? 0)))
    if (b?.on && b.glide) this.bend = Math.min(12, Math.max(-12, this.bend + (b.glide * dt) / beatMs))
    else this.bend = ease(this.bend, 0, dt, 500)
    this.glide = (this.bend / 12) * (calm ? 0.5 : 1)

    this.half = ease(this.half, on && a.feel?.halfTime ? 0.6 : 1, dt, 900)
    this.timeScale = this.speed * this.half * (1 - 0.88 * this.hold) * (1 + 0.35 * this.tension)
    this.heat = this.tension * 0.7
    this.hue = this.glide * 0.45 + this.alt * this.groove * 0.6
    this.gain = (1 - 0.28 * this.hold) * (1 + 0.25 * this.burst)
    return this
  }
}
