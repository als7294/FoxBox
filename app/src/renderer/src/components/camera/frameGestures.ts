/**
 * The FRAME (2.0, PLAY and REMIX): two hands making an L each, the frame between them.
 * - Its geometry for S3's pane: a perspective quad (each L's corner, and where the hands' thumb and index tips meet),
 *   smoothed; its size.
 * - formed / formedAt: two Ls held (HandShapes.frame, camMath's FRAME_HOLD_MS); it stays formed until both hands are
 *   seen out of the L shape for RELEASE_MS (a corner's tap keeps one L; a hand lost a moment counts as last seen), or
 *   no hand is seen for LOST_MS.
 * - cycles: a tap at a corner while it's formed (one hand's L breaking, its thumb closing on its index, and coming back
 *   while the other's holds: the tracker's own pinch reading misfires where a thumb's hidden), or any PLAY pinch while
 *   PLAY's loop is latched: one each. PLAY doesn't play it as WOBBLE or pluck it (playGestures).
 * - flipped / flips: turned like a card, the frame upright and both hands turned over in their corners (palms to backs
 *   to the camera), with hysteresis; turned back, the front again. Which way a palm faces comes from the hand's own
 *   landmarks (palmFacing), whichever hand it is: MediaPipe's handedness can name both hands the same.
 * - latched: PLAY's loop, on with a frame and off with the next.
 */
import { type HandShape, type HandShapes, type Pt } from './camMath'
import { playingHand, SLOT } from './playGestures'
import { usePlayPrefs, WOBBLE_MS } from './playPrefs'

export interface FrameSignal {
  formed: boolean
  /** performance.now() it formed (0 before the first). */
  formedAt: number
  /** Its corners clockwise from the top-left, smoothed (cameraSignals: the stage's 0-1; here the camera's); held
   *  through the grace, null before the first frame. */
  corners: Pt[] | null
  /** Its diagonal, 0-1 of the picture's width. */
  size: number
  /** Pinches while formed (or while PLAY's loop is latched): one each. */
  cycles: number
  /** Turned over like a card (every hand seen facing the other way from how it formed), held FLIP_MS; false on a new
   *  frame. */
  flipped: boolean
  flips: number
  /** PLAY's loop: on with a frame, off with the next. */
  latched: boolean
  /** How long a hand has been an L with no frame formed (ms; 0 otherwise): a frame tried for and not found (the coach's
   *  "Frames need a little more light" in a dim room, where the second hand goes unseen). */
  lHeldMs: number
  /** One-handed: the single L held toward opening (or releasing) the frame, 0 … 1 at Hold time; 0 once it fires. */
  holdProgress: number
  /** One-handed: the L's corner (camera 0-1; cameraSignals maps it to the stage), where S3's pane opens from toward the
   *  picture's middle (glass oneLCorners); followed while the L's held, kept after; null with two hands. */
  corner: Pt | null
}

/** The frame's feel. */
export const FRAME = {
  /** Both hands seen out of the L shape this long: the frame's let go (PLAY: its next frame unlatches). */
  RELEASE_MS: 300,
  /** No hand seen this long: let go too. */
  LOST_MS: 2000,
  /** A corner's tap: one hand's L broken this long (the other holding), then back. */
  TAP_MIN_MS: 60,
  TAP_MAX_MS: 800,
  /** A tap's thumb-index gap closes under this share of the L's, and under TAP_GAP palm lengths (a corner's pinch closes
   *  to 0.1-0.55; an L misread for a moment at a wobble's turn, about 1.2). */
  TAP_CLOSE: 0.7,
  TAP_GAP: 0.8,
  /** A pinch counts once per this (its tap and its pinch reading are the same one). */
  CYCLE_GAP_MS: 400,
  /** Turned over (or back) this long before it counts: a hand caught mid-turn isn't. */
  FLIP_MS: 150,
  /** One-handed's frame: its sides, palm lengths. */
  ONE_SIZE: 2.2,
  /** Dropped and made again within this, every hand now facing the other way from its last L: the same frame turned
   *  over (its Ls unread edge-on for RELEASE_MS, a slow turn or a loaded tracker), not a new one. */
  REJOIN_MS: 1000,
  /** The corners' smoothing, each result. */
  SMOOTH: 0.45,
}

export const NO_FRAME_SIGNAL: FrameSignal = { formed: false, formedAt: 0, corners: null, size: 0, cycles: 0, flipped: false, flips: 0, latched: false, lHeldMs: 0, holdProgress: 0, corner: null }

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

/** Four corners in order, clockwise from the top-left. */
function clockwise(quad: Pt[], aspect: number): Pt[] {
  const c = { x: quad.reduce((s, p) => s + p.x, 0) / 4, y: quad.reduce((s, p) => s + p.y, 0) / 4 }
  // Clockwise on screen (y down) is increasing angle; start at the top-left (the least x + y).
  const sorted = quad.sort((p, q) => Math.atan2(p.y - c.y, (p.x - c.x) * aspect) - Math.atan2(q.y - c.y, (q.x - c.x) * aspect))
  const first = sorted.reduce((best, p, i) => (p.x * aspect + p.y < sorted[best]!.x * aspect + sorted[best]!.y ? i : best), 0)
  return [...sorted.slice(first), ...sorted.slice(0, first)]
}

/** A hand's thumb tip to its index tip in the picture, in palm lengths. */
const thumbGap = (h: HandShape, aspect: number) => {
  const p = (i: number) => ({ x: h.points[i]!.x * aspect, y: h.points[i]!.y })
  const [t, i, w, m] = [p(4), p(8), p(0), p(9)]
  return Math.hypot(t.x - i.x, t.y - i.y) / (Math.hypot(m.x - w.x, m.y - w.y) || 1e-6)
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
  private tap = -1 // since one hand's L broke (the other's holding)
  private tapGap = { start: 0, least: 0 } // that hand's thumb-index gap (palm lengths) as it broke, and its least since
  private tapFacing = { was: 0, turned: false } // that hand's palm facing as it broke, and whether it's turned since
  private gaps = { left: 1, right: 1 } // each hand's thumb-index gap while it was last an L
  private cycled = -1e9
  /** The flip: each hand's palm facing as it formed, a candidate's start. */
  private facing0 = { left: 0, right: 0 }
  private lastFacing = { left: 0, right: 0 } // each hand's palm facing as last seen in its L
  private dropped = { at: -1e9, facing: { left: 0, right: 0 } } // when it last dropped, its hands' last L facings then
  private flipSince = -1
  private tapping = { left: false, right: false }
  private lSince = -1 // a hand an L, no frame formed, since
  /** One-handed: the L's hold (since, last seen, fired: it toggles once per hold; its palm facing as it began, and
   *  whether the hand's turned since: a turn is the flip side, not a toggle). */
  private hold = { since: -1, seen: -1e9, fired: false, facing: 0, turned: false }

  /** One hands result. `taps`: PLAY's quick pinch per performer hand (playGestures), for cycles while latched. */
  step(shapes: HandShapes, now: number, aspect: number, taps: Record<'left' | 'right', boolean> = { left: false, right: false }): FrameSignal {
    const { oneHanded, holdMs, wobble } = usePlayPrefs.getState()
    if (oneHanded) return this.oneStep(shapes, now, aspect, taps, holdMs, WOBBLE_MS[wobble])
    const { left, right } = shapes
    const detected = shapes.frame.held && shapes.frame.seen === now && !!left && !!right
    if (left || right) this.anyAt = now
    const ls = { left: !!left && left.isL, right: !!right && right.isL }
    // Out: both hands out of their L (a hand lost a moment as it was last seen), timed from the first result without an
    // L: hands leaving one fast are often lost a result or two on the way.
    if (left) this.wasL.left = ls.left
    if (right) this.wasL.right = ls.right
    if (ls.left || ls.right) this.noL = -1
    else if (this.noL < 0) this.noL = now
    if (ls.left && left) this.lastFacing.left = palmFacing(left) || this.lastFacing.left
    if (ls.right && right) this.lastFacing.right = palmFacing(right) || this.lastFacing.right
    const outNow = (!!left || !!right) && !this.wasL.left && !this.wasL.right
    this.out = outNow ? this.noL : -1
    let { formed, cycles } = this.s
    if (!formed && detected) {
      formed = true
      const now0 = { left: palmFacing(left), right: palmFacing(right) }
      const d = this.dropped.facing
      const turned = now - this.dropped.at <= FRAME.REJOIN_MS && !!d.left && !!d.right && now0.left === -d.left && now0.right === -d.right
      if (turned) {
        // The same frame, turned over while its Ls went unread: the latch stays; flipped as it now faces.
        const flipped = now0.left === -this.facing0.left
        this.s = { ...this.s, flipped, flips: this.s.flips + (flipped !== this.s.flipped ? 1 : 0) }
      } else {
        // A new frame: PLAY's loop toggles; it starts the right way up, its corners where they are.
        this.s = { ...this.s, formedAt: now, latched: !this.s.latched, flipped: false }
        this.facing0 = now0
        this.tap = -1
      }
      this.flipSince = -1
    } else if (formed && ((this.out >= 0 && now - this.out >= FRAME.RELEASE_MS) || now - this.anyAt > FRAME.LOST_MS)) {
      formed = false
      this.dropped = { at: now, facing: { ...this.lastFacing } }
    }

    if (formed) {
      if (detected) {
        const quad = frameQuad(left, right, aspect)
        const was4 = this.s.corners
        const corners = was4 && this.s.formed ? was4.map((p, i) => ({ x: p.x + (quad[i]!.x - p.x) * FRAME.SMOOTH, y: p.y + (quad[i]!.y - p.y) * FRAME.SMOOTH })) : quad
        this.s = { ...this.s, corners, size: Math.hypot(corners[2]!.x - corners[0]!.x, (corners[2]!.y - corners[0]!.y) / aspect) }
      }
      this.turnOver(ls.left ? left : null, ls.right ? right : null, now)
      // A corner's tap: one L broken (the other holding) for a moment, then back...
      // ... its thumb closing on its index (the gap under TAP_CLOSE of the L's and TAP_GAP): a wobble breaks an L, not
      // that; nor a hand turning over (its palm facing changing on the way: a flip's start foreshortens the gap).
      const side = ls.left && right && !ls.right ? 'right' : ls.right && left && !ls.left ? 'left' : null
      if (side) {
        const g = thumbGap(shapes[side]!, aspect)
        const facing = palmFacing(shapes[side]!)
        if (this.tap < 0) [this.tap, this.tapGap, this.tapFacing] = [now, { start: this.gaps[side], least: g }, { was: facing, turned: false }]
        else {
          this.tapGap.least = Math.min(this.tapGap.least, g)
          if (facing !== this.tapFacing.was) this.tapFacing.turned = true
        }
      } else {
        const lasted = this.tap < 0 ? 0 : now - this.tap
        const closed = this.tapGap.least < Math.min(FRAME.TAP_CLOSE * this.tapGap.start, FRAME.TAP_GAP)
        const tapped = closed && !this.tapFacing.turned && lasted >= FRAME.TAP_MIN_MS && lasted <= FRAME.TAP_MAX_MS
        if (ls.left && ls.right && tapped) cycles = this.cycle(cycles, now)
        this.tap = -1
      }
      if (ls.left && left) this.gaps.left = thumbGap(left, aspect)
      if (ls.right && right) this.gaps.right = thumbGap(right, aspect)
    }
    // PLAY: a pinch while the loop's latched (the hands back to playing) is a cycle too.
    for (const hand of ['left', 'right'] as const) {
      if (!formed && this.s.latched && taps[hand] && !this.tapping[hand]) cycles = this.cycle(cycles, now)
      this.tapping[hand] = taps[hand]
    }
    this.lSince = !formed && (ls.left || ls.right) ? (this.lSince < 0 ? now : this.lSince) : -1
    this.s = { ...this.s, formed, cycles, lHeldMs: this.lSince < 0 ? 0 : now - this.lSince, holdProgress: 0, corner: null }
    return this.s
  }

  /** One-handed (2.0.1): the playing hand's L held Hold time opens the frame (PLAY's loop latches) with the L as its
   *  corner, and held again lets it go; a misread shorter than Wobble tolerance doesn't break a hold. An L turned over
   *  (palm to back) is the flip side instead, and back the front: a turning hand's hold never toggles. Back to playing,
   *  a pinch while it's latched cycles it, as with two hands. */
  private oneStep(shapes: HandShapes, now: number, aspect: number, taps: Record<'left' | 'right', boolean>, holdMs: number, wobbleMs: number): FrameSignal {
    const hand = playingHand(shapes)
    const slot = hand ? SLOT[hand] : null
    const h = slot ? shapes[slot] : null
    if (h) this.anyAt = now
    if (h?.isL) {
      const facing = palmFacing(h)
      if (this.hold.since < 0) this.hold = { since: now, seen: now, fired: false, facing, turned: false }
      this.hold.seen = now
      if (facing !== this.hold.facing) this.hold.turned = true
    } else if (now - this.hold.seen > wobbleMs) this.hold = { since: -1, seen: this.hold.seen, fired: false, facing: 0, turned: false }
    let { formed, cycles } = this.s
    let holdProgress = 0
    if (this.hold.since >= 0 && !this.hold.fired && !this.hold.turned) {
      holdProgress = Math.min(1, (now - this.hold.since) / holdMs)
      if (holdProgress >= 1 && h && slot) {
        this.hold.fired = true
        holdProgress = 0
        formed = true
        this.facing0 = { left: 0, right: 0, [slot]: palmFacing(h) }
        this.flipSince = -1
        this.s = { ...this.s, formedAt: now, latched: !this.s.latched, flipped: false, corners: null, corner: null }
      }
    }
    if (formed && this.hold.since < 0) formed = false // the L let go
    // Turned over in an L while it's latched: the flip side (and back: the front), however the hold began.
    if (this.s.latched && !formed && h && slot && h.isL && this.hold.turned) this.turnOver(slot === 'left' ? h : null, slot === 'right' ? h : null, now)
    if (formed && h && slot && h.isL) {
      const quad = oneQuad(h, aspect)
      const was4 = this.s.corners
      const corners = was4 ? was4.map((p, i) => ({ x: p.x + (quad[i]!.x - p.x) * FRAME.SMOOTH, y: p.y + (quad[i]!.y - p.y) * FRAME.SMOOTH })) : quad
      const v = lVertex(h, aspect)
      const was = this.s.corner
      const corner = was ? { x: was.x + (v.x - was.x) * FRAME.SMOOTH, y: was.y + (v.y - was.y) * FRAME.SMOOTH } : v
      this.s = { ...this.s, corners, corner, size: Math.hypot(corners[2]!.x - corners[0]!.x, (corners[2]!.y - corners[0]!.y) / aspect) }
      this.turnOver(slot === 'left' ? h : null, slot === 'right' ? h : null, now)
    }
    for (const side of ['left', 'right'] as const) {
      if (!formed && this.s.latched && taps[side] && !this.tapping[side]) cycles = this.cycle(cycles, now)
      this.tapping[side] = taps[side]
    }
    this.s = { ...this.s, formed, cycles, lHeldMs: 0, holdProgress }
    return this.s
  }

  private cycle(cycles: number, now: number): number {
    if (now - this.cycled < FRAME.CYCLE_GAP_MS) return cycles
    this.cycled = now
    return cycles + 1
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
