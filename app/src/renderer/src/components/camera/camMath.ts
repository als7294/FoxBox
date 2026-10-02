/**
 * The smart camera's arithmetic, pure and unit-tested: who is near (calibrated against a resting baseline), what the
 * hands and head are doing, where AUTO-FRAME's crop goes, and the small geometry the face styles need. Points are
 * normalized to the camera frame (0-1) unless a function says otherwise.
 */

import type { HandGesture } from './vision'

export interface Pt {
  x: number
  y: number
}

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
export const smoothstep = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}
const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)

// ------------------------------------------------------------------------------------------------ calibration

/**
 * How near a face is, measured one of two ways: 'reach' is 1 / its distance (the landmarker's head pose: turning
 * doesn't change it), 'width' its width across the frame (the detector alone). Bigger is nearer either way.
 */
export type FaceMeasure = 'reach' | 'width'

/** The resting pose: how near the face is and how big the hands are when the DJ stands where they normally stand. */
export interface Baseline {
  measure: FaceMeasure
  /** The face's resting value in that measure. */
  face: number
  /** Palm length / face width (a hand held at the face's own depth). */
  hand: number
}

/** A palm (wrist to middle-finger knuckle) is about 0.7 of a face's width at the same distance. */
export const DEFAULT_HAND_RATIO = 0.7
/** How long the resting pose is sampled after the camera starts, or after RECALIBRATE. */
export const CALIBRATE_MS = 2000

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)]! : 0
}

/** Collects face and hand sizes for CALIBRATE_MS, then settles on their medians. */
export class Calibration {
  private faces: number[] = []
  private hands: number[] = []
  private since: number | null = null
  private measure: FaceMeasure | null = null
  /** The resting face width, kept when the baseline upgrades to head distance: only frames at rest may set that. */
  private widthAtRest: number | null = null
  baseline: Baseline | null = null

  /** RECALIBRATE: start over from nothing (the DJ is standing at rest now). */
  restart(): void {
    this.widthAtRest = null
    this.reset()
  }

  private reset(): void {
    this.faces = []
    this.hands = []
    this.since = null
    this.measure = null
    this.baseline = null
  }

  /**
   * One camera frame: the largest face in `measure` (or null), the palm/face ratios of the hands seen, and the face's
   * width across the frame (0-1, or null).
   */
  add(now: number, measure: FaceMeasure, face: number | null, handRatios: readonly number[], width: number | null = null): void {
    // The head-distance measure beats face width: upgrade to it once (the landmarker has started, a few seconds in).
    // The DJ may be leaning in just then, so the resting width is kept and the new baseline only takes frames at rest.
    if (face != null && measure === 'reach' && (this.baseline ?? { measure: this.measure })?.measure === 'width') {
      if (this.baseline) this.widthAtRest = this.baseline.face
      this.reset()
    }
    // A frame that falls back to width while distance is the measure (the landmarker lost the face) is skipped.
    if (measure === 'width' && (this.baseline?.measure === 'reach' || this.measure === 'reach')) return
    if (this.baseline) return
    if (this.widthAtRest && width != null && width / this.widthAtRest > 1.1) return
    if (face != null && face > 0) {
      this.measure = measure
      this.since ??= now
      this.faces.push(face)
      this.hands.push(...handRatios)
    }
    if (this.since != null && now - this.since >= CALIBRATE_MS && this.faces.length >= 5) {
      this.baseline = {
        measure: this.measure ?? 'width',
        face: median(this.faces),
        hand: this.hands.length >= 5 ? median(this.hands) : DEFAULT_HAND_RATIO,
      }
    }
  }

  get calibrating(): boolean {
    return this.baseline == null
  }
}

/** How near a face is: 0 at rest, 1 once it's 40 % nearer (leaning in); nothing until a baseline in its measure exists. */
export function faceNear(measure: FaceMeasure, value: number, b: Baseline | null): number {
  return b && b.face > 0 && b.measure === measure ? smoothstep(1.12, 1.4, value / b.face) : 0
}

/** How far a hand is pushed toward the camera: its palm against the face's size, compared with the resting ratio. */
export function handNear(palmOverFace: number, b: Baseline | null): number {
  return b ? smoothstep(1.3, 1.8, palmOverFace / (b.hand || DEFAULT_HAND_RATIO)) : 0
}

/** Attack fast, let go slower: a near level that doesn't flicker. `dt` in ms. */
export function follow(prev: number, target: number, dt: number, attackMs = 80, releaseMs = 260): number {
  const tau = target > prev ? attackMs : releaseMs
  return prev + (target - prev) * (1 - Math.exp(-Math.max(0, dt) / tau))
}

// ------------------------------------------------------------------------------------------------ hands

/** MediaPipe's 21 hand points: wrist 0, thumb 1-4, index 5-8, middle 9-12, ring 13-16, pinky 17-20. */
export const WRIST = 0
const TIPS = [8, 12, 16, 20] as const
const KNUCKLES = [5, 9, 13, 17] as const

/** Wrist to middle-finger knuckle: the hand's size, however the fingers are held. */
export const palm = (h: readonly Pt[]): number => dist(h[0]!, h[9]!)

export interface HandSignal {
  /** The palm's centre, in the points' units (cameraSignals: 0-1 across and down the drawn frame). */
  x: number
  y: number
  /** 1 with thumb and index tips together, 0 once they're apart. */
  pinch: number
  /** 1 for an open hand, 0 for a fist. */
  open: number
  /** 0-1: pushed toward the camera (see handNear). */
  near: number
  /** Fingers held out, 0-5. */
  fingers: number
}

/** Fingers held out, 0-5 (square-pixel points): a finger's tip well past its knuckle from the wrist; the thumb's tip
 *  well off the index knuckle. 2D: a finger pointed at the camera reads as folded. */
export function fingersUp(h: readonly Pt[]): number {
  let n = dist(h[4]!, h[5]!) > 0.6 * palm(h) ? 1 : 0
  for (let i = 0; i < 4; i++) if (dist(h[TIPS[i]!]!, h[WRIST]!) > 1.45 * dist(h[KNUCKLES[i]!]!, h[WRIST]!)) n++
  return n
}

export function handSignal(h: readonly Pt[], near: number): HandSignal {
  const p = palm(h) || 1e-6
  const pinch = 1 - smoothstep(0.25, 0.6, dist(h[4]!, h[8]!) / p)
  let ext = 0
  for (let i = 0; i < 4; i++) ext += dist(h[TIPS[i]!]!, h[WRIST]!) / (dist(h[KNUCKLES[i]!]!, h[WRIST]!) || 1e-6)
  const open = smoothstep(1.15, 1.75, ext / 4)
  const c = [0, 5, 9, 13, 17].reduce((a, i) => ({ x: a.x + h[i]!.x / 5, y: a.y + h[i]!.y / 5 }), { x: 0, y: 0 })
  return { x: c.x, y: c.y, pinch, open, near, fingers: fingersUp(h) }
}

export interface HandShape {
  pinch: number
  open: number
  fingers: number
  gesture: HandGesture | null
  /** MediaPipe's 21, as given (0-1 of the camera frame). */
  points: Pt[]
  /** Pinching, with hysteresis: on above 0.7, off below 0.4. */
  pinched: boolean
  /** TWIST, a pinch dial: how far the hand has turned since the pinch began (the knuckle line, 5 to 17, unwrapped),
   *  -1..1 over -90..90 degrees, clockwise on screen positive; 0 when not pinched. */
  twist: number
  /** The knuckle line's angle now and the turn so far (radians): TWIST's state. */
  angle: number
  turn: number
}

export interface HandShapes {
  /** The hand on the frame's left and on its right (unmirrored), null when unseen. A hand keeps its side until its
   *  wrist crosses the middle by a margin, so two crossing hands don't swap. */
  left: HandShape | null
  right: HandShape | null
  /** Wrist to wrist over the frame's width; 0 with fewer than two hands. */
  apart: number
  /** FRAME: both hands an L (thumb and index out, the rest folded, the two near square) with a real opening between
   *  them. The rect spanned by the four tips (camera frame) and its corners (clockwise from the top-left), its size
   *  (the diagonal over the frame's width); held once made for FRAME_HOLD_MS, and kept that long after it's lost (no
   *  flicker). `since` / `seen`: when it was first made / last seen (ms). */
  frame: { held: boolean; x0: number; y0: number; x1: number; y1: number; corners: Pt[]; size: number; since: number; seen: number }
  /** TRIANGLE: the index tips touching above the thumb tips touching, an opening between them. */
  triangle: boolean
}

export const FRAME_HOLD_MS = 150
const SIDE_MARGIN = 0.1
const NO_FRAME: HandShapes['frame'] = { held: false, x0: 0, y0: 0, x1: 0, y1: 0, corners: [], size: 0, since: 0, seen: -1e9 }

/**
 * The hands' shapes from the recognizer's hands (0-1 of the camera frame, `aspect` its width over height), computed
 * once for the signals (S2's sound) and TouchDesigner (S3). `prev`: last time's, for the sides and FRAME's hold.
 */
export function handShapes(
  hands: readonly { points: readonly Pt[]; gesture: HandGesture | null }[],
  now: number,
  prev: HandShapes | null = null,
  aspect = 16 / 9,
): HandShapes {
  const sq = (h: readonly Pt[]) => h.map((p) => ({ x: p.x * aspect, y: p.y }))
  const shaped: HandShape[] = hands.slice(0, 2).map((h) => {
    const s = handSignal(sq(h.points), 0)
    return { pinch: s.pinch, open: s.open, fingers: s.fingers, gesture: h.gesture, points: h.points.map((p) => ({ x: p.x, y: p.y })), pinched: false, twist: 0, angle: 0, turn: 0 }
  })
  // Sides: last time's (the closer hand, all 21 points; for two, the closer pairing) unless its wrist crossed the
  // middle by the margin; else by where it is.
  const near = (h: HandShape, p: HandShape | null | undefined) =>
    p ? h.points.reduce((a, q, i) => a + Math.hypot(q.x - p.points[i]!.x, q.y - p.points[i]!.y), 0) / 21 : 1e9
  const kept = (h: HandShape, s: 0 | 1) => (s === 0 ? h.points[WRIST]!.x < 0.5 + SIDE_MARGIN : h.points[WRIST]!.x > 0.5 - SIDE_MARGIN)
  const where = (h: HandShape): 0 | 1 => (h.points[WRIST]!.x < 0.5 ? 0 : 1)
  let left: HandShape | null = null
  let right: HandShape | null = null
  if (shaped.length === 2) {
    const [a, b] = shaped as [HandShape, HandShape]
    const swap = near(a, prev?.right) + near(b, prev?.left) < near(a, prev?.left) + near(b, prev?.right)
    const [l, r] = prev?.left && prev?.right ? (swap ? [b, a] : [a, b]) : a.points[WRIST]!.x <= b.points[WRIST]!.x ? [a, b] : [b, a]
    ;[left, right] = kept(l, 0) && kept(r, 1) ? [l, r] : a.points[WRIST]!.x <= b.points[WRIST]!.x ? [a, b] : [b, a]
  } else if (shaped.length === 1) {
    const h = shaped[0]!
    const was = prev?.left || prev?.right ? (near(h, prev.left) <= near(h, prev.right) ? 0 : 1) : where(h)
    if (was === 0 ? kept(h, 0) : !kept(h, 1)) left = h
    else right = h
  }
  // TWIST: each hand against its own side's last shape.
  const wrap = (d: number) => ((((d + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI
  const twisted = (h: HandShape | null, was: HandShape | null | undefined): HandShape | null => {
    if (!h) return null
    const q = sq(h.points)
    const angle = Math.atan2(q[17]!.y - q[5]!.y, q[17]!.x - q[5]!.x)
    const pinched = was?.pinched ? h.pinch > 0.4 : h.pinch > 0.7
    const turn = pinched && was?.pinched ? was.turn + wrap(angle - was.angle) : 0
    return { ...h, pinched, angle, turn, twist: pinched ? Math.max(-1, Math.min(1, turn / (Math.PI / 2))) : 0 }
  }
  left = twisted(left, prev?.left)
  right = twisted(right, prev?.right)
  const apart = left && right ? Math.hypot((right.points[WRIST]!.x - left.points[WRIST]!.x) * aspect, right.points[WRIST]!.y - left.points[WRIST]!.y) / aspect : 0

  // FRAME: an L each, and the tips' rect open at least half a palm each way.
  const isL = (h: HandShape) => {
    const q = sq(h.points)
    const u = { x: q[4]!.x - q[2]!.x, y: q[4]!.y - q[2]!.y }
    const v = { x: q[8]!.x - q[5]!.x, y: q[8]!.y - q[5]!.y }
    const cos = (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y) || 1)
    const out = (i: number) => dist(q[TIPS[i]!]!, q[WRIST]!) > 1.45 * dist(q[KNUCKLES[i]!]!, q[WRIST]!)
    return dist(q[4]!, q[5]!) > 0.6 * palm(q) && out(0) && !out(1) && !out(2) && !out(3) && Math.abs(cos) < 0.65
  }
  let frame = prev && now - prev.frame.seen <= FRAME_HOLD_MS ? prev.frame : NO_FRAME
  if (left && right && isL(left) && isL(right)) {
    const tips = [left.points[4]!, left.points[8]!, right.points[4]!, right.points[8]!]
    const r = { x0: Math.min(...tips.map((p) => p.x)), y0: Math.min(...tips.map((p) => p.y)), x1: Math.max(...tips.map((p) => p.x)), y1: Math.max(...tips.map((p) => p.y)) }
    const span = 0.5 * Math.min(palm(sq(left.points)), palm(sq(right.points)))
    if ((r.x1 - r.x0) * aspect > span && r.y1 - r.y0 > span) {
      const since = frame !== NO_FRAME ? frame.since : now
      const corners = [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }]
      const size = Math.hypot((r.x1 - r.x0) * aspect, r.y1 - r.y0) / aspect
      frame = { ...r, corners, size, since, seen: now, held: now - since >= FRAME_HOLD_MS }
    }
  }
  // TRIANGLE: the two contacts (within a third of a palm), the index pair above the thumbs by over half a palm.
  let triangle = false
  if (left && right) {
    const [l, r] = [sq(left.points), sq(right.points)]
    const p = (palm(l) + palm(r)) / 2
    const mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
    const top = mid(l[8]!, r[8]!)
    const bottom = mid(l[4]!, r[4]!)
    triangle = dist(l[8]!, r[8]!) < p / 3 && dist(l[4]!, r[4]!) < p / 3 && bottom.y - top.y > p / 2
  }
  return { left, right, apart, frame, triangle }
}

// ------------------------------------------------------------------------------------------------ head

export interface HeadPose {
  /** -1 (turned to the frame's left) … 1 (to its right); 0 facing the camera. */
  yaw: number
  /** Radians: the eye line's tilt. */
  roll: number
  /** Radians, looking up positive: only from the landmarker's transformation matrix. */
  pitch?: number
}

/**
 * From the landmarker's facial transformation matrix (column-major 4×4; camera space x right, y up, z toward the
 * viewer): the head's real yaw (±45° is ±1), pitch and roll (the eye line's tilt in the picture).
 */
export function poseFromMatrix(m: ArrayLike<number>): HeadPose {
  const [fx, fy, fz] = [m[8]!, m[9]!, m[10]!] // where the face points
  return {
    yaw: Math.max(-1, Math.min(1, Math.atan2(fx, fz) / (Math.PI / 4))),
    pitch: Math.atan2(fy, Math.hypot(fx, fz)),
    roll: -Math.atan2(m[1]!, m[0]!),
  }
}

/** A 4×4 whose rotation drifted (a smoothed matrix): its axes made unit and square again, in place. */
export function orthonormalize(m: Float32Array): Float32Array {
  const x = [m[0]!, m[1]!, m[2]!]
  const y = [m[4]!, m[5]!, m[6]!]
  const nx = Math.hypot(...x) || 1
  for (let i = 0; i < 3; i++) x[i]! /= nx
  const d = x[0]! * y[0]! + x[1]! * y[1]! + x[2]! * y[2]!
  for (let i = 0; i < 3; i++) y[i] = y[i]! - d * x[i]!
  const ny = Math.hypot(...y) || 1
  for (let i = 0; i < 3; i++) y[i]! /= ny
  const z = [x[1]! * y[2]! - x[2]! * y[1]!, x[2]! * y[0]! - x[0]! * y[2]!, x[0]! * y[1]! - x[1]! * y[0]!]
  m.set(x, 0)
  m.set(y, 4)
  m.set(z, 8)
  return m
}

/**
 * The One Euro filter (Casiez et al., 2012) over n values at once: steady when still (a `min` Hz cutoff), quick when
 * moving (the cutoff rises `beta` Hz per unit/s of speed). The face mesh and the head's matrix go through it.
 * `size` scales the speed (MediaPipe's value scaling: the mesh's speed in face widths a second, so a small far face
 * isn't over-smoothed and a close one doesn't shake). `filter` returns its own buffer: copy it to keep it.
 */
export class OneEuro {
  private x: Float32Array | null = null
  private dx = new Float32Array(0)
  private t = 0

  constructor(
    private readonly min = 1,
    private readonly beta = 0,
    private readonly dmin = 1,
  ) {}

  filter(v: ArrayLike<number>, ms: number, size = 1): Float32Array {
    if (!this.x || this.x.length !== v.length) {
      this.x = Float32Array.from(v)
      this.dx = new Float32Array(v.length)
      this.t = ms
      return this.x
    }
    const dt = Math.max(1e-3, (ms - this.t) / 1000)
    this.t = ms
    const alpha = (hz: number) => 1 / (1 + 1 / (2 * Math.PI * hz * dt))
    const ad = alpha(this.dmin)
    for (let i = 0; i < v.length; i++) {
      this.dx[i]! += ad * ((v[i]! - this.x[i]!) / dt - this.dx[i]!)
      this.x[i]! += alpha(this.min + (this.beta * Math.abs(this.dx[i]!)) / size) * (v[i]! - this.x[i]!)
    }
    return this.x
  }

  /** The filtered speed of each value (units per second): where it's heading between updates. */
  get velocity(): Float32Array {
    return this.dx
  }
}

/** From the eyes and nose (the face detector's keypoints or the landmarker's): where the nose sits between the eyes. */
export function headPose(leftEye: Pt, rightEye: Pt, nose: Pt): HeadPose {
  const a = leftEye.x < rightEye.x ? leftEye : rightEye
  const b = a === leftEye ? rightEye : leftEye
  const span = b.x - a.x || 1e-6
  const yaw = Math.max(-1, Math.min(1, ((nose.x - a.x) / span - 0.5) * 2.4))
  return { yaw, roll: Math.atan2(b.y - a.y, b.x - a.x) }
}

// ------------------------------------------------------------------------------------------------ AUTO-FRAME

export interface Crop {
  x: number
  y: number
  w: number
  h: number
  scale: number
}

/**
 * AUTO-FRAME: a camera much wider than the output (16:9 into 9:16) is cropped to the output's shape, and the crop's
 * centre follows the person (`target`, 0-1 across the camera frame; null: stay) with a dead zone and a smooth ease,
 * never leaving the frame. In camera pixels, like coverCrop. `prevX` is the last crop's centre (camera px, or null).
 */
export function autoFrame(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  target: number | null,
  prevX: number | null,
  dtMs: number,
  tauMs = 450,
): Crop {
  const scale = Math.max(dstW / srcW, dstH / srcH)
  const w = dstW / scale
  const h = dstH / scale
  const half = w / 2
  const lo = half
  const hi = srcW - half
  let x = prevX ?? srcW / 2
  if (target != null) {
    const goal = Math.min(hi, Math.max(lo, target * srcW))
    const dead = w * 0.06
    const off = goal - x
    if (Math.abs(off) > dead) x += (off - Math.sign(off) * dead) * (1 - Math.exp(-Math.max(0, dtMs) / tauMs))
  }
  x = Math.min(hi, Math.max(lo, x))
  return { x: x - half, y: (srcH - h) / 2, w, h, scale }
}

/** Worth auto-framing: the camera is at least 1.3 times wider (in shape) than the output. */
export const needsAutoFrame = (srcW: number, srcH: number, dstW: number, dstH: number): boolean => srcW / srcH > (dstW / dstH) * 1.3

// ------------------------------------------------------------------------------------------------ styles' geometry

/** A small, seeded random stream (mulberry32): the same seed, the same glitch. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A seeded shuffle of 0..n-1. */
export function permutation(n: number, seed: number): number[] {
  const r = rng(seed)
  const p = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[p[i], p[j]] = [p[j]!, p[i]!]
  }
  return p
}

/** Delaunay triangles (Bowyer-Watson) of a few dozen points: index triples into `pts`. */
export function triangulate(pts: readonly Pt[]): [number, number, number][] {
  if (pts.length < 3) return []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  const d = Math.max(maxX - minX, maxY - minY) * 20 || 1
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const all: Pt[] = [...pts, { x: cx - d, y: cy - d }, { x: cx + d, y: cy - d }, { x: cx, y: cy + d }]
  const n = pts.length
  type Tri = { a: number; b: number; c: number; x: number; y: number; r2: number }
  const circum = (a: number, b: number, c: number): Tri => {
    const A = all[a]!
    const B = all[b]!
    const C = all[c]!
    const D = 2 * (A.x * (B.y - C.y) + B.x * (C.y - A.y) + C.x * (A.y - B.y)) || 1e-12
    const ux = ((A.x ** 2 + A.y ** 2) * (B.y - C.y) + (B.x ** 2 + B.y ** 2) * (C.y - A.y) + (C.x ** 2 + C.y ** 2) * (A.y - B.y)) / D
    const uy = ((A.x ** 2 + A.y ** 2) * (C.x - B.x) + (B.x ** 2 + B.y ** 2) * (A.x - C.x) + (C.x ** 2 + C.y ** 2) * (B.x - A.x)) / D
    return { a, b, c, x: ux, y: uy, r2: (A.x - ux) ** 2 + (A.y - uy) ** 2 }
  }
  let tris: Tri[] = [circum(n, n + 1, n + 2)]
  for (let i = 0; i < n; i++) {
    const p = all[i]!
    const bad = tris.filter((t) => (p.x - t.x) ** 2 + (p.y - t.y) ** 2 <= t.r2 * (1 + 1e-9))
    const edges = new Map<string, [number, number]>()
    for (const t of bad) {
      for (const [u, v] of [
        [t.a, t.b],
        [t.b, t.c],
        [t.c, t.a],
      ] as const) {
        const k = u < v ? `${u},${v}` : `${v},${u}`
        if (edges.has(k)) edges.delete(k)
        else edges.set(k, [u, v])
      }
    }
    tris = tris.filter((t) => !bad.includes(t))
    for (const [u, v] of edges.values()) tris.push(circum(u, v, i))
  }
  return tris.filter((t) => t.a < n && t.b < n && t.c < n).map((t) => [t.a, t.b, t.c])
}

/** The thermal palette: 0 (cold, near black) → deep violet → red → orange → white-hot yellow. */
const HEAT: readonly [number, number, number][] = [
  [8, 6, 20],
  [72, 14, 110],
  [196, 28, 66],
  [255, 122, 28],
  [255, 236, 150],
]
export function heat(v: number): [number, number, number] {
  const t = clamp01(v) * (HEAT.length - 1)
  const i = Math.min(HEAT.length - 2, Math.floor(t))
  const f = t - i
  const a = HEAT[i]!
  const b = HEAT[i + 1]!
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

// ------------------------------------------------------------------------------------------------ the body's head

/** A body keypoint from the pose model: 0-1 across the frame, and how visible (0-1). */
export interface BodyPt extends Pt {
  v: number
}

/**
 * The head from BlazePose's first 13 keypoints (0 nose, 2 / 5 eyes, 7 / 8 ears, 11 / 12 shoulders; 0-1 of the frame):
 * a face-sized box round the ears' line (camera px), its turn and tilt, and how sure (the least visible point used).
 * It holds where the face finders don't: looking down at the decks, a big turn, a hand in front, a dark frame. The
 * width is the ears' span, or 0.45 of the shoulders' when the ears aren't both seen (`ears` false: a rougher box, as
 * the frame can cut the shoulders off). `pitch` is raw (the caller zeroes it against the landmarker's). Null without a
 * head to go on.
 */
export function headFromPose(
  body: readonly BodyPt[] | null | undefined,
  vw: number,
  vh: number,
): { box: { x: number; y: number; w: number; h: number }; pose: HeadPose; score: number; ears: boolean } | null {
  if (!body || body.length < 13) return null
  const P = (i: number) => ({ x: body[i]!.x * vw, y: body[i]!.y * vh, v: body[i]!.v })
  const [nose, eyeA, eyeB, earA, earB, shA, shB] = [P(0), P(2), P(5), P(7), P(8), P(11), P(12)]
  const ears = earA.v >= 0.3 && earB.v >= 0.3
  const shoulders = shA.v >= 0.3 && shB.v >= 0.3
  if (nose.v < 0.5 && !ears) return null
  const earSpan = ears ? Math.hypot(earB.x - earA.x, earB.y - earA.y) : 0
  const w = Math.max(1.1 * earSpan, shoulders ? 0.45 * Math.hypot(shB.x - shA.x, shB.y - shA.y) : 0)
  if (!(w > 8)) return null
  const c = ears ? { x: (earA.x + earB.x) / 2, y: (earA.y + earB.y) / 2 } : { x: nose.x, y: nose.y }
  const [l, r] = eyeA.x < eyeB.x ? [eyeA, eyeB] : [eyeB, eyeA]
  return {
    box: { x: c.x - w / 2, y: c.y - 0.65 * w, w, h: 1.25 * w }, // brow to chin round the ears' line
    pose: {
      yaw: ears ? Math.max(-1, Math.min(1, (nose.x - c.x) / (earSpan / 2 || 1))) : 0,
      roll: Math.atan2(r.y - l.y, r.x - l.x),
      pitch: Math.max(-1, Math.min(1, ((c.y - nose.y) / w) * 2)),
    },
    score: Math.min(nose.v, ears ? Math.min(earA.v, earB.v) : 1),
    ears,
  }
}
