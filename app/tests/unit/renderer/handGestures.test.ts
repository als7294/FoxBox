import { describe, expect, it } from 'vitest'
import type { HandShape, HandShapes, Pt } from '@/components/camera/camMath'
import { HandGestures, HOLD_MS } from '@/components/camera/handGestures'

const hand = (at: Pt, { pinched = false, gesture = null as HandShape['gesture'] } = {}): HandShape => ({
  pinch: pinched ? 1 : 0,
  open: 0,
  fingers: 0,
  gesture,
  points: Array.from({ length: 21 }, () => ({ ...at })),
  pinched,
  twist: 0,
  angle: 0,
  turn: 0,
})
const hands = (left: HandShape | null, right: HandShape | null): HandShapes => ({
  left,
  right,
  apart: 0,
  frame: { held: false, x0: 0, y0: 0, x1: 0, y1: 0, corners: [], size: 0, since: 0, seen: -1e9 },
  triangle: false,
})

describe('HANDS gestures as edges', () => {
  it('PINCH + PULL: the rect while pulling, one event on letting go', () => {
    const g = new HandGestures()
    expect(g.step(hands(hand({ x: 0.45, y: 0.5 }, { pinched: true }), hand({ x: 0.5, y: 0.52 }, { pinched: true })), 0)).toBeNull()
    expect(g.step(hands(hand({ x: 0.3, y: 0.3 }, { pinched: true }), hand({ x: 0.6, y: 0.55 }, { pinched: true })), 100)).toBeNull()
    expect(g.pull).toEqual({ x: 0.3, y: 0.3, w: expect.closeTo(0.3), h: expect.closeTo(0.25) })
    const e = g.step(hands(hand({ x: 0.3, y: 0.3 }), hand({ x: 0.6, y: 0.55 }, { pinched: true })), 200)
    expect(e?.kind).toBe('pinch_pull')
    expect(e?.rect?.x).toBeCloseTo(0.3)
    expect(g.pull).toBeNull()
    expect(g.step(hands(hand({ x: 0.3, y: 0.3 }), null), 300)).toBeNull() // once
    // Too small a pull: no window.
    g.step(hands(hand({ x: 0.5, y: 0.5 }, { pinched: true }), hand({ x: 0.52, y: 0.51 }, { pinched: true })), 400)
    expect(g.step(hands(null, null), 500)).toBeNull()
  })

  it('OPEN PALM and FIST: once a hold, after the hold time', () => {
    const g = new HandGestures()
    const palm = hands(hand({ x: 0.5, y: 0.5 }, { gesture: 'open' }), null)
    expect(g.step(palm, 0)).toBeNull()
    expect(g.step(palm, HOLD_MS + 1)?.kind).toBe('open_palm')
    expect(g.step(palm, HOLD_MS + 100)).toBeNull()
    g.step(hands(null, null), 1000)
    const fist = hands(null, hand({ x: 0.5, y: 0.5 }, { gesture: 'fist' }))
    expect(g.step(fist, 1100)).toBeNull()
    expect(g.step(fist, 1100 + HOLD_MS)?.kind).toBe('fist')
    expect(g.last?.kind).toBe('fist')
  })
})
