/**
 * The design's HANDS gestures as edges (PROD's GestureMap turns them into TouchDesigner commands):
 * - PINCH + PULL: both hands pinched, pulled apart; the rect between the pinch points is `pull` while it lasts, and one
 *   event when either lets go (if it opened to a real size). Two hands, so AIR DRAW's one-hand pinch never makes one.
 * - OPEN PALM: once each time a palm shows (the recognizer's sign, held 150 ms).
 * - FIST: once a hold (150 ms).
 * Rects are 0-1 of the camera frame, y down, from the top-left corner (as /foxbox/cmd new_window).
 */
import type { HandShapes, Pt } from './camMath'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}
export interface HandGestureEvent {
  kind: 'pinch_pull' | 'open_palm' | 'fist'
  /** performance.now() of the edge: a new `at` is one event. */
  at: number
  /** pinch_pull: the window pulled open. */
  rect?: Rect
}

export const HOLD_MS = 150
const MIN_SIDE = 0.05 // a pull smaller than this either way isn't a window

/** The pinch point: between the thumb and index tips. */
const pinchPoint = (p: readonly Pt[]): Pt => ({ x: (p[4]!.x + p[8]!.x) / 2, y: (p[4]!.y + p[8]!.y) / 2 })

export class HandGestures {
  /** The last edge, or null. */
  last: HandGestureEvent | null = null
  /** The window being pulled open (both hands pinched), or null. */
  pull: Rect | null = null
  private since: Record<'open_palm' | 'fist', number | null> = { open_palm: null, fist: null }
  private fired = { open_palm: false, fist: false }

  step(hands: HandShapes, now: number): HandGestureEvent | null {
    let event: HandGestureEvent | null = null
    const { left, right } = hands
    // PINCH + PULL
    if (left?.pinched && right?.pinched) {
      const a = pinchPoint(left.points)
      const b = pinchPoint(right.points)
      this.pull = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
    } else if (this.pull) {
      if (this.pull.w >= MIN_SIDE && this.pull.h >= MIN_SIDE) event = { kind: 'pinch_pull', at: now, rect: this.pull }
      this.pull = null
    }
    // OPEN PALM and FIST: a sign on either hand, held HOLD_MS, once until it goes.
    for (const kind of ['open_palm', 'fist'] as const) {
      const sign = kind === 'open_palm' ? 'open' : 'fist'
      const on = left?.gesture === sign || right?.gesture === sign
      if (!on) {
        this.since[kind] = null
        this.fired[kind] = false
        continue
      }
      const since = (this.since[kind] ??= now)
      if (!this.fired[kind] && now - since >= HOLD_MS) {
        this.fired[kind] = true
        event ??= { kind, at: now }
      }
    }
    if (event) this.last = event
    return event
  }
}
