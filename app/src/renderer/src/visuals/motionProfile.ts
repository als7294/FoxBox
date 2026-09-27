/**
 * How the voice core moves. A profile is derived from the sound itself (the four macros and the resolved rack
 * chain), so user presets get their own feel, and each factory preset adds a signature on top. The draw loop
 * eases the live profile toward its target over ~400 ms, so preset changes crossfade.
 *
 *   DEPTH   → mass, size, gravity: slower, heavier, pulled inward by low-end energy
 *   GRIT    → turbulence, jitter, sharper particles
 *   MACHINE → quantisation and geometric order: lattice snapping, beat-locked stepped rotation
 *   SPACE   → trails, diffusion, spread
 */
import type { Macros } from '@/api/types'
import { clamp } from './canvas'

export interface MotionProfile {
  /** 0..1 heavier = slower rotation, bigger particles. */
  mass: number
  /** Base rotation speed, rad/s. */
  rot: number
  /** Particle size multiplier. */
  size: number
  /** Inward pull on low-band energy. */
  gravity: number
  /** Noise displacement and jitter. */
  turbulence: number
  /** 0 = soft particles, 1 = crisp squares snapped to the pixel grid. */
  sharp: number
  /** Latitude rings + azimuth snapping. */
  lattice: number
  /** Beat-locked stepped rotation (0 = smooth). */
  step: number
  /** Trail persistence 0..1. */
  trails: number
  /** Outer diffusion shell / radius growth. */
  spread: number
  /** Orbiting clusters instead of one sphere (the voice collage). */
  clusters: number
  /** Radio scan-line jitter. */
  scan: number
  /** Static speckle. */
  speckle: number
  /** Slow downward drift of the particles through the sphere. */
  drift: number
  /** Growl-driven tremor while playing. */
  tremor: number
  /** Frame stutter + slice displacement on transients. */
  glitch: number
  /** RGB split during glitches. */
  rgb: number
  /** Pale, desaturated palette. */
  pale: number
  /** Warm ember palette. */
  ember: number
  /** Faint satellite shells, one per stack voice. */
  satellites: number
  /** Gentle breathing when idle. */
  breathing: number
  /** Darker, larger, lower-alpha particles. */
  darkness: number
  /** Sub pulses on low end and beats. */
  subPulse: number
}

export const KEYS = [
  'mass', 'rot', 'size', 'gravity', 'turbulence', 'sharp', 'lattice', 'step', 'trails', 'spread', 'clusters', 'scan',
  'speckle', 'drift', 'tremor', 'glitch', 'rgb', 'pale', 'ember', 'satellites', 'breathing', 'darkness', 'subPulse',
] as const satisfies readonly (keyof MotionProfile)[]

export interface MotionInputs {
  presetId: string | null
  /** Effective macro amounts 0..1 (all 0 on the dry side of A/B). */
  macros: Macros
  /** A resolved chain param (macro-driven values included), or undefined when unknown / module off. */
  param(module: string, param: string): number | undefined
  /** Stack voices in the chain. */
  stackCount: number
  /** A/B dry: the raw voice, so no signature either. */
  dry?: boolean
}

const norm = (v: number | undefined, lo: number, hi: number, fallback = 0) =>
  v == null || !Number.isFinite(v) ? fallback : clamp((v - lo) / (hi - lo))

type Flavor = (p: MotionProfile, i: MotionInputs) => void

/** Signature per factory preset, applied on top of the derived motion. */
const FLAVORS: Record<string, Flavor> = {
  // Dense, slow ember mass; heavy sub pulses; stack voices as faint satellite shells.
  pact: (p, i) => {
    p.ember = 1
    p.mass = Math.max(p.mass, 0.65)
    p.subPulse = Math.max(p.subPulse, 0.9)
    p.satellites = i.stackCount > 0 ? 1 : 0.6
    p.sharp *= 0.5
  },
  // Several orbiting clusters (the collage), radio scan-line jitter, static speckle.
  legion: (p) => {
    p.clusters = 1
    p.scan = 0.85
    p.speckle = 0.7
  },
  // Very slow downward drift, large dark particles, growl-driven tremor.
  abyss: (p) => {
    p.drift = 1
    p.darkness = 0.8
    p.size += 0.5
    p.mass = Math.max(p.mass, 0.8)
    p.tremor = Math.max(p.tremor, 0.85)
  },
  // Rigid lattice, beat-locked stepped rotation, crisp lines.
  unit: (p) => {
    p.lattice = Math.max(p.lattice, 0.92)
    p.step = 1
    p.sharp = 1
    p.turbulence *= 0.3
    p.trails *= 0.3
  },
  // Wispy, diffuse, long fading trails, pale.
  ghost: (p) => {
    p.trails = Math.max(p.trails, 0.88)
    p.pale = 1
    p.spread = Math.max(p.spread, 0.7)
    p.sharp = 0
    p.size *= 0.8
  },
  // Glitch: frame stutter and displacement on transients, RGB split.
  signal: (p) => {
    p.glitch = 1
    p.rgb = 1
    p.sharp = Math.max(p.sharp, 0.7)
  },
  // Minimal, natural breathing sphere.
  raw: (p) => {
    p.breathing = 1
    for (const k of ['turbulence', 'lattice', 'step', 'trails', 'spread', 'tremor', 'gravity'] as const) p[k] *= 0.25
    p.sharp = 0.2
  },
}

/** The motion a sound should have (the draw loop eases toward it). */
export function motionTarget(i: MotionInputs): MotionProfile {
  const { depth, grit, machine, space } = i.macros
  const sub = norm(i.param('layers', 'sub_gain_db'), -60, 0)
  const growl = norm(i.param('mask', 'growl'), 0, 1)
  const vocoder = norm(i.param('machine', 'vocoder_mix'), 0, 1)
  const ring = norm(i.param('machine', 'ring_mix'), 0, 1)
  const drive = norm(i.param('drive', 'drive_db'), 0, 24)
  const bits = 1 - norm(i.param('crush', 'bits'), 4, 24, 1)
  const verb = norm(i.param('space', 'reverb_mix'), 0, 1)
  const decay = norm(i.param('space', 'reverb_decay_s'), 0.2, 8)
  const mass = clamp(0.12 + 0.62 * depth + 0.25 * sub)
  const p: MotionProfile = {
    mass,
    rot: 0,
    size: 0.85 + 0.55 * depth + 0.25 * grit,
    gravity: clamp(0.85 * depth + 0.2 * sub),
    turbulence: clamp(0.75 * grit + 0.3 * drive + 0.25 * bits),
    sharp: clamp(0.55 * grit + 0.45 * machine + 0.35 * bits),
    lattice: clamp(0.8 * machine + 0.3 * vocoder + 0.2 * ring),
    step: clamp((machine - 0.55) / 0.45),
    trails: clamp(0.65 * space + 0.25 * verb + 0.2 * decay),
    spread: clamp(0.75 * space + 0.25 * verb),
    clusters: 0,
    scan: 0,
    speckle: 0,
    drift: 0,
    tremor: clamp(0.6 * growl),
    glitch: 0,
    rgb: 0,
    pale: 0,
    ember: 0,
    satellites: i.stackCount > 0 ? 0.5 : 0,
    breathing: 0.35,
    darkness: 0,
    subPulse: clamp(0.3 + 0.6 * sub),
  }
  if (!i.dry && i.presetId) FLAVORS[i.presetId]?.(p, i)
  // Heavier is slower: 0.34 rad/s light → 0.07 rad/s at full mass.
  p.rot = 0.34 - 0.27 * clamp(p.mass)
  return p
}

/** Moves `live` toward `target` in place; `k` = 0..1 of the remaining distance (1 = jump). */
export function easeProfile(live: MotionProfile, target: MotionProfile, k: number): void {
  for (const key of KEYS) live[key] += (target[key] - live[key]) * k
}

/** Per-frame easing factor for a ~400 ms crossfade (95% after 400 ms), from the frame time in ms. */
export const crossfade = (dtMs: number): number => 1 - Math.exp(-Math.max(0, dtMs) / 133)
