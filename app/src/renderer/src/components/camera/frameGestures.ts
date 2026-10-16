/**
 * The FRAME (2.1, docs/FRAMES_SIMPLE.md): held, it is; let go, it isn't. Two hands making an L each, the frame between
 * them (one-handed: one L, held Hold time), the same in PLAY and REMIX.
 * - Its geometry for S3's pane: a perspective quad (each L's corner, and where the hands' thumb and index tips meet),
 *   smoothed; its size; its amount (S2's effect depth): its size against its size as it formed, 0.5 then.
 * - formed / formedAt: two Ls held (HandShapes.frame, camMath's FRAME_HOLD_MS); it stays formed until both hands are
 *   seen out of the L shape for RELEASE_MS (a hand lost a moment counts as last seen), or no hand is seen for LOST_MS.
 *   A turn slow enough that its Ls go unread that long lets go too: no grace for hands seen edge-on, which is how a C
 *   comes back to play (S3's P19).
 * - flipped / flips: turned like a card, the frame upright and both hands turned over in their corners (palms to backs
 *   to the camera), with hysteresis; turned back, the front again. Which way a palm faces comes from the hand's own
 *   landmarks (palmFacing), whichever hand it is: MediaPipe's handedness can name both hands the same. Untaught.
 * - Melody's LOOP (2.1, setInwardFrames): any inward frame counts, the lenient test (inwardPair) in place of two Ls.
 */
import { FRAME_HOLD_MS, isLPose, type HandShape, type HandShapes, type Pt } from './camMath'
import { playingHand, SLOT } from './playGestures'
import { usePlayPrefs, WOBBLE_MS } from './playPrefs'

export interface FrameSignal {
  /** Held now (one-handed's L included). */
  formed: boolean
  /** performance.now() it formed (0 before the first): how long it's been held. */
  formedAt: number
  /** Its corners clockwise from the top-left, smoothed (cameraSignals: the stage's 0-1; here the camera's); held
   *  through the grace, null before the first frame. */
  corners: Pt[] | null
  /** Its diagonal, 0-1 of the picture's width. */
  size: number
  /** Its size against its size as it formed: 0.5 then, wider more (1 at twice), closer less. */
  amount: number
  /** Turned over like a card (every hand seen facing the other way from how it formed), held FLIP_MS; false on a new
   *  frame. */
  flipped: boolean
  flips: number
  /** How long a hand has been an L with no frame formed (ms; 0 otherwise): a frame tried for and not found (the coach's
   *  "Frames need a little more light" in a dim room, where the second hand goes unseen). */
  lHeldMs: number
  /** One-handed: the single L held toward the frame, 0 … 1 at Hold time; 0 once it's formed. */
  holdProgress: number
  /** One-handed: the L's corner (camera 0-1; cameraSignals maps it to the stage), where S3's pane opens from toward the
   *  picture's middle (glass oneLCorners); followed while the L's held, kept after; null with two hands. */
  corner: Pt | null
}

/** The frame's feel. */
export const FRAME = {
  /** Both hands seen out of the L shape this long: let go. */
  RELEASE_MS: 300,
  /** No hand seen this long: let go too. */
  LOST_MS: 2000,
  /** Turned over (or back) this long before it counts: a hand caught mid-turn isn't. */
  FLIP_MS: 150,
  /** One-handed's frame: its sides, palm lengths. */
  ONE_SIZE: 2.2,
  /** The corners' smoothing, each result. */
  SMOOTH: 0.45,
  /** Melody's LOOP: an inward frame's four fingertips bound this much of the picture at least. */
  INWARD_AREA: 0.02,
}

/** MELODY on LOOP (S2 sets it): any inward frame counts (inwardPair), not just two Ls. */
let inwardOnly = false
export const setInwardFrames = (on: boolean): void => void (inwardOnly = on)

/** The lenient inward frame (Melody's LOOP, FRAMES_SIMPLE): each hand's thumb and index out and apart, its other
 *  fingers anyhow (isLPose); each L's opening (between its thumb and index, from its corner) toward the other's corner;
 *  their four fingertips bounding INWARD_AREA of the picture. Any rotation, either hand on top. */
export function inwardPair(a: HandShape, b: HandShape, aspect: number): boolean {
  if (!isLPose(a, aspect) || !isLPose(b, aspect)) return false
  const sq = (p: Pt) => ({ x: p.x * aspect, y: p.y })
  const opening = (h: HandShape) => {
    const v = sq(lVertex(h, aspect))
    const out = [4, 8].map((i) => {
      const p = sq(h.points[i]!)
      const n = Math.hypot(p.x - v.x, p.y - v.y) || 1
      return { x: (p.x - v.x) / n, y: (p.y - v.y) / n }
    })
    return { v, d: { x: out[0]!.x + out[1]!.x, y: out[0]!.y + out[1]!.y } }
  }
  const [oa, ob] = [opening(a), opening(b)]
  const faces = (o: typeof oa, at: Pt) => o.d.x * (at.x - o.v.x) + o.d.y * (at.y - o.v.y) > 0
  if (!faces(oa, ob.v) || !faces(ob, oa.v)) return false
  const q = clockwise([a.points[4]!, a.points[8]!, b.points[4]!, b.points[8]!].map((p) => ({ ...p })), aspect)
  const area = Math.abs(q.reduce((s, p, i) => s + p.x * q[(i + 1) % 4]!.y - q[(i + 1) % 4]!.x * p.y, 0)) / 2
  return area >= FRAME.INWARD_AREA
}

export const NO_FRAME_SIGNAL: FrameSignal = { formed: false, formedAt: 0, corners: null, size: 0, amount: 0.5, flipped: false, flips: 0, lHeldMs: 0, holdProgress: 0, corner: null }

/** An L's corner (camera 0-1): where its thumb's line (2 to 4) meets its index's (5 to 8); the index's knuckle when the
 *  lines are near parallel. `aspect`: the frame's width over its height. */
export function lVertex(h: HandShape, aspect: number): Pt {
  const p = (i: number) => ({ x: h.points[i]!.x * aspect, y: h.points[i]!.y })
  const [a, b, c, d] = [p(2), p(4), p(5), p(8)]
  const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x)
  const len = Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(d.x - c.x, d.y - c.y)
  if (Math.abs(den) < 0.2 * len) return h.points[5]!
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den
  return { x: (a.x + t * (b.x - a.x)) / aspect, y: a.y + t * (b.y - a.y) }
}

/** The frame's four corners (camera 0-1): each L's corner, and between them where one hand's thumb and index tips meet
 *  the other's (the nearer pairing), clockwise from the top-left. */
export function frameQuad(a: HandShape, b: HandShape, aspect: number): Pt[] {
  const d = (p: Pt, q: Pt) => Math.hypot((p.x - q.x) * aspect, p.y - q.y)
  const mid = (p: Pt, q: Pt) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 })
  const [a4, a8, b4, b8] = [a.points[4]!, a.points[8]!, b.points[4]!, b.points[8]!]
  const crossed = d(a4, b8) + d(a8, b4) <= d(a4, b4) + d(a8, b8)
  return clockwise([lVertex(a, aspect), mid(a4, crossed ? b8 : b4), lVertex(b, aspect), mid(a8, crossed ? b4 : b8)], aspect)
}

/** One-handed's frame (2.0.1): its corner the L's, its sides along the index and the thumb, FRAME.ONE_SIZE palm lengths
 *  each (camera 0-1), clockwise from the top-left. */
export function oneQuad(h: HandShape, aspect: number): Pt[] {
  const p = (i: number) => ({ x: h.points[i]!.x * aspect, y: h.points[i]!.y })
  const unit = (a: Pt, b: Pt) => {
    const n = Math.hypot(b.x - a.x, b.y - a.y) || 1
    return { x: (b.x - a.x) / n, y: (b.y - a.y) / n }
  }
  const [ui, ut] = [unit(p(5), p(8)), unit(p(2), p(4))]
  const len = FRAME.ONE_SIZE * Math.hypot(p(9).x - p(0).x, p(9).y - p(0).y)
  const c = lVertex(h, aspect)
  const at = (i: number, t: number) => ({ x: (c.x * aspect + (ui.x * i + ut.x * t) * len) / aspect, y: c.y + (ui.y * i + ut.y * t) * len })
  return clockwise([at(0, 0), at(1, 0), at(1, 1), at(0, 1)], aspect)
}

/** Two points' distance, of the picture's width. */
const dist = (p: Pt, q: Pt, aspect: number) => Math.hypot(q.x - p.x, (q.y - p.y) / aspect)

/** Four corners in order, clockwise from the top-left. */
function clockwise(quad: Pt[], aspect: number): Pt[] {
  const c = { x: quad.reduce((s, p) => s + p.x, 0) / 4, y: quad.reduce((s, p) => s + p.y, 0) / 4 }
  // Clockwise on screen (y down) is increasing angle; start at the top-left (the least x + y).
  const sorted = quad.sort((p, q) => Math.atan2(p.y - c.y, (p.x - c.x) * aspect) - Math.atan2(q.y - c.y, (q.x - c.x) * aspect))
  const first = sorted.reduce((best, p, i) => (p.x * aspect + p.y < sorted[best]!.x * aspect + sorted[best]!.y ? i : best), 0)
  return [...sorted.slice(first), ...sorted.slice(0, first)]
}

/** Which way a hand's palm faces: 1 the camera, -1 away, 0 unsure (edge-on). From its world landmarks, whichever hand
 *  it is: the hand's plane (wrist, index and pinky knuckles), its palm the side its middle, ring and pinky tips curl to
 *  (folded in an L or a C). */
export function palmFacing(h: HandShape): number {
  const w = h.world
  if (!w) return 0
  const v = (b: number) => [w[b]!.x - w[0]!.x, w[b]!.y - w[0]!.y, w[b]!.z - w[0]!.z]
  const [a, c] = [v(5), v(17)]
  const n = [a[1]! * c[2]! - a[2]! * c[1]!, a[2]! * c[0]! - a[0]! * c[2]!, a[0]! * c[1]! - a[1]! * c[0]!]
  const tips = [12, 16, 20].map(v).reduce((s, t) => s.map((x, i) => x + t[i]!), [0, 0, 0])
  const side = Math.sign(tips[0]! * n[0]! + tips[1]! * n[1]! + tips[2]! * n[2]!)
  const z = (side * n[2]!) / (Math.hypot(...n) || 1e-9) // the palm's normal, z (smaller is nearer)
  return z < -0.3 ? 1 : z > 0.3 ? -1 : 0
}

export class FrameGestures {
  private s: FrameSignal = { ...NO_FRAME_SIGNAL }
  private out = -1 // since both hands were out of the L shape
  private noL = -1 // since the first result with no L seen (no hand seen counts), -1 while one is
  private wasL = { left: false, right: false } // each hand as last seen: an L
  private anyAt = -1e9 // a hand last seen
  private span = 0 // its span (amount's measure), smoothed
  private span0 = 0 // …as it formed
  /** The flip: each hand's palm facing as it formed, a candidate's start. */
  private facing0 = { left: 0, right: 0 }
  private flipSince = -1
  private lSince = -1 // a hand an L, no frame formed, since
  private inSince = -1 // Melody's LOOP: an inward pair since
  /** One-handed: the L's hold (since, last seen). */
  private hold = { since: -1, seen: -1e9 }

  /** One hands result. */
  step(shapes: HandShapes, now: number, aspect: number): FrameSignal {
    const { controlStyle, holdMs, wobble } = usePlayPrefs.getState()
    if (controlStyle === 'one') return this.oneStep(shapes, now, aspect, holdMs, WOBBLE_MS[wobble])
    const { left, right } = shapes
    // LOOP's lenient frame: an inward pair held FRAME_HOLD_MS, its hands out of it when out of their L pose.
    const inward = inwardOnly && !!left && !!right && inwardPair(left, right, aspect)
    this.inSince = inward ? (this.inSince < 0 ? now : this.inSince) : -1
    const detected = inwardOnly ? inward && now - this.inSince >= FRAME_HOLD_MS : shapes.frame.held && shapes.frame.seen === now && !!left && !!right
    if (left || right) this.anyAt = now
    const isL = (h: HandShape | null) => !!h && (inwardOnly ? isLPose(h, aspect) : h.isL)
    const ls = { left: isL(left), right: isL(right) }
    // Out: both hands out of their L (a hand lost a moment as it was last seen), timed from the first result without an
    // L: hands leaving one fast are often lost a result or two on the way.
    if (left) this.wasL.left = ls.left
    if (right) this.wasL.right = ls.right
    if (ls.left || ls.right) this.noL = -1
    else if (this.noL < 0) this.noL = now
    const outNow = (!!left || !!right) && !this.wasL.left && !this.wasL.right
    this.out = outNow ? this.noL : -1
    let formed = this.s.formed
    if (!formed && detected && left && right) {
      // A new frame: the right way up, its corners where they are.
      formed = true
      this.facing0 = { left: palmFacing(left), right: palmFacing(right) }
      this.flipSince = -1
      this.s = { ...this.s, formedAt: now, flipped: false, corners: null }
    } else if (formed && ((this.out >= 0 && now - this.out >= FRAME.RELEASE_MS) || now - this.anyAt > FRAME.LOST_MS)) {
      formed = false
    }
    if (formed) {
      if (detected && left && right) this.place(frameQuad(left, right, aspect), aspect, dist(lVertex(left, aspect), lVertex(right, aspect), aspect))
      this.turnOver(ls.left ? left : null, ls.right ? right : null, now)
    }
    this.lSince = !formed && (ls.left || ls.right) ? (this.lSince < 0 ? now : this.lSince) : -1
    this.s = { ...this.s, formed, lHeldMs: this.lSince < 0 ? 0 : now - this.lSince, holdProgress: 0, corner: null }
    return this.s
  }

  /** One-handed: the playing hand's L held Hold time is the frame, with the L as its corner, for as long as it's held
   *  (a misread shorter than Wobble tolerance doesn't break the hold); let go as two hands' is. An L turned over (palm
   *  to back) is the flip side, and back the front. */
  private oneStep(shapes: HandShapes, now: number, aspect: number, holdMs: number, wobbleMs: number): FrameSignal {
    const hand = playingHand(shapes)
    const slot = hand ? SLOT[hand] : null
    const h = slot ? shapes[slot] : null
    if (h) this.anyAt = now
    if (h?.isL) this.hold = { since: this.hold.since < 0 ? now : this.hold.since, seen: now }
    const grace = this.s.formed ? Math.max(FRAME.RELEASE_MS, wobbleMs) : wobbleMs
    if ((h && !h.isL && now - this.hold.seen > grace) || now - this.anyAt > FRAME.LOST_MS) this.hold = { since: -1, seen: this.hold.seen }
    let formed = this.s.formed && this.hold.since >= 0
    let holdProgress = 0
    if (!formed && this.hold.since >= 0 && h?.isL && slot) {
      holdProgress = Math.min(1, (now - this.hold.since) / holdMs)
      if (holdProgress >= 1) {
        formed = true
        holdProgress = 0
        this.facing0 = { left: 0, right: 0, [slot]: palmFacing(h) }
        this.flipSince = -1
        this.s = { ...this.s, formedAt: now, flipped: false, corners: null, corner: null }
      }
    }
    if (formed && h && slot && h.isL) {
      const quad = oneQuad(h, aspect)
      this.place(quad, aspect, dist(quad[0]!, quad[2]!, aspect))
      const v = lVertex(h, aspect)
      const was = this.s.corner
      this.s = { ...this.s, corner: was ? { x: was.x + (v.x - was.x) * FRAME.SMOOTH, y: was.y + (v.y - was.y) * FRAME.SMOOTH } : v }
      this.turnOver(slot === 'left' ? h : null, slot === 'right' ? h : null, now)
    }
    this.s = { ...this.s, formed, lHeldMs: 0, holdProgress }
    return this.s
  }

  /** The frame's quad this result: its corners smoothed (the first as they are) and its size; its amount from `span`
   *  (two hands: corner to corner, the Ls' own; pulled apart, the tips' meeting points barely move). */
  private place(quad: Pt[], aspect: number, span: number): void {
    const was = this.s.corners
    const corners = was ? was.map((p, i) => ({ x: p.x + (quad[i]!.x - p.x) * FRAME.SMOOTH, y: p.y + (quad[i]!.y - p.y) * FRAME.SMOOTH })) : quad
    if (!was) this.span = this.span0 = span
    else this.span += (span - this.span) * FRAME.SMOOTH
    this.s = { ...this.s, corners, size: dist(corners[0]!, corners[2]!, aspect), amount: Math.min(1, (0.5 * this.span) / (this.span0 || 1e-9)) }
  }

  /** Every hand seen in its L facing the other way from how the frame formed (and none still the same): flipped; all
   *  back: the front. Held FLIP_MS. Hands out of their L don't count (a release, a hand mid-turn). */
  private turnOver(left: HandShape | null, right: HandShape | null, now: number): void {
    const seen = (['left', 'right'] as const)
      .map((side) => ({ was: this.facing0[side], is: side === 'left' ? left && palmFacing(left) : right && palmFacing(right) }))
      .filter((h) => h.was && h.is)
    if (!seen.length) return
    const over = seen.every((h) => h.is === -h.was!)
    const front = seen.every((h) => h.is === h.was)
    const wants = over ? true : front ? false : this.s.flipped
    if (wants === this.s.flipped) this.flipSince = -1
    else if (this.flipSince < 0) this.flipSince = now
    else if (now - this.flipSince >= FRAME.FLIP_MS) {
      this.s = { ...this.s, flipped: wants, flips: this.s.flips + 1 }
      this.flipSince = -1
    }
  }
}
