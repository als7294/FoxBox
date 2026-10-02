import { describe, expect, it } from 'vitest'
import { FRAME_HOLD_MS, handShapes, type Pt } from '@/components/camera/camMath'

const ASPECT = 16 / 9

/** A synthetic hand (0-1 of a 16:9 frame): its wrist at (x, y), `s` tall in frame heights, fingers up the frame. `out`:
 *  thumb, index, middle, ring, pinky held out; `mirror` flips it (thumb to the right), `turn` rotates it by half a turn. */
function hand(x: number, y: number, out: boolean[], { s = 0.1, mirror = false, turn = false, rot = 0, thumb = [-1, -0.3] } = {}) {
  const p: [number, number][] = Array.from({ length: 21 }, () => [0, 0])
  p[1] = [-0.25, -0.2]
  p[2] = [-0.4, -0.4]
  const d = Math.hypot(thumb[0]!, thumb[1]!)
  if (out[0]) {
    p[3] = [-0.4 + (0.3 * thumb[0]!) / d, -0.4 + (0.3 * thumb[1]!) / d]
    p[4] = [-0.4 + (0.6 * thumb[0]!) / d, -0.4 + (0.6 * thumb[1]!) / d]
  } else {
    p[3] = [-0.2, -0.6]
    p[4] = [-0.05, -0.75]
  }
  ;[[-0.25, -1.0], [0, -1.05], [0.22, -1.0], [0.42, -0.9]].forEach(([kx, ky], i) => {
    const k = 5 + i * 4
    p[k] = [kx!, ky!]
    const up = out[i + 1] ? [-0.35, -0.6, -0.85] : [-0.25, -0.05, 0.1]
    up.forEach((dy, j) => (p[k + 1 + j] = [kx!, ky! + dy]))
  })
  return p.map(([px, py]): Pt => {
    let [u, v] = [mirror ? -px : px, py]
    if (turn) [u, v] = [-u, -v]
    ;[u, v] = [u * Math.cos(rot) - v * Math.sin(rot), u * Math.sin(rot) + v * Math.cos(rot)]
    return { x: x + (u * s) / ASPECT, y: y + v * s }
  })
}
const H = (points: Pt[]) => ({ points, gesture: null })
const ALL = [true, true, true, true, true]
const FIST = [false, false, false, false, false]
const L = [true, true, false, false, false]

describe('hand shapes', () => {
  it('counts the fingers held out', () => {
    const n = (out: boolean[]) => handShapes([H(hand(0.3, 0.6, out))], 0, null, ASPECT).left!.fingers
    expect(n(FIST)).toBe(0)
    expect(n(ALL)).toBe(5)
    expect(n(L)).toBe(2)
    expect(n([false, true, false, false, false])).toBe(1)
  })

  it('keeps each hand on its side until it crosses the middle by a margin', () => {
    const a = handShapes([H(hand(0.7, 0.4, ALL)), H(hand(0.3, 0.7, FIST))], 0, null, ASPECT)
    expect(a.left!.fingers).toBe(0)
    expect(a.right!.fingers).toBe(5)
    expect(a.apart).toBeCloseTo(Math.hypot(0.4, 0.3 / ASPECT), 2)
    // The hands cross a little (one above the other): they keep their sides.
    const step = handShapes([H(hand(0.55, 0.4, ALL)), H(hand(0.45, 0.7, FIST))], 50, a, ASPECT)
    const b = handShapes([H(hand(0.45, 0.4, ALL)), H(hand(0.55, 0.7, FIST))], 100, step, ASPECT)
    expect(b.left!.fingers).toBe(0)
    expect(b.right!.fingers).toBe(5)
    // One hand alone keeps its side too.
    expect(handShapes([H(hand(0.45, 0.4, ALL))], 120, b, ASPECT).right!.fingers).toBe(5)
    // Well across: by where they are.
    const c = handShapes([H(hand(0.25, 0.4, ALL)), H(hand(0.75, 0.7, FIST))], 150, b, ASPECT)
    expect(c.left!.fingers).toBe(5)
    expect(c.right!.fingers).toBe(0)
    expect(handShapes([H(hand(0.3, 0.6, ALL))], 0, null, ASPECT).apart).toBe(0)
  })

  it('FRAME: two Ls facing, held after a moment, kept a moment after it goes', () => {
    const frame = () => [H(hand(0.3, 0.7, L, { mirror: true, thumb: [-1, 0] })), H(hand(0.7, 0.3, L, { mirror: true, turn: true, thumb: [-1, 0] }))]
    const f0 = handShapes(frame(), 0, null, ASPECT)
    expect(f0.frame.corners).toHaveLength(4)
    expect(f0.frame.held).toBe(false)
    expect(f0.frame.x0).toBeLessThan(0.35)
    expect(f0.frame.x1).toBeGreaterThan(0.65)
    const f1 = handShapes(frame(), FRAME_HOLD_MS + 10, handShapes(frame(), 80, f0, ASPECT), ASPECT) // results ~10/s
    expect(f1.frame.held).toBe(true)
    expect(f1.frame.size).toBeGreaterThan(0.3)
    expect(handShapes([], FRAME_HOLD_MS + 100, f1, ASPECT).frame.held).toBe(true) // a dropped result
    expect(handShapes([], 2 * FRAME_HOLD_MS + 50, f1, ASPECT).frame.held).toBe(false)
    // Open hands, or one L: no frame.
    expect(handShapes([H(hand(0.3, 0.7, ALL)), H(hand(0.7, 0.3, ALL, { turn: true }))], 0, null, ASPECT).frame.corners).toHaveLength(0)
    expect(handShapes(frame().slice(0, 1), 0, null, ASPECT).frame.corners).toHaveLength(0)
  })

  it('TWIST: how far the hand turned while pinched, from where the pinch began', () => {
    const pinchAt = (rot: number, pinch = true) => {
      const h = hand(0.5, 0.6, ALL, { rot })
      if (pinch) h[4] = { ...h[8]! }
      return [H(h)]
    }
    const a = handShapes(pinchAt(0.3), 0, null, ASPECT)
    expect(a.right!.pinched).toBe(true)
    expect(a.right!.twist).toBe(0)
    const b = handShapes(pinchAt(0.3 + Math.PI / 4), 50, a, ASPECT)
    expect(b.right!.twist).toBeCloseTo(0.5, 2)
    const c = handShapes(pinchAt(0.3 - Math.PI / 4), 100, b, ASPECT)
    expect(c.right!.twist).toBeCloseTo(-0.5, 2)
    // turned on past the end (in steps a hand can make between results): held at 1
    const d = handShapes(pinchAt(0.3 + (3 * Math.PI) / 4), 175, handShapes(pinchAt(0.3 + Math.PI / 4), 150, c, ASPECT), ASPECT)
    expect(d.right!.twist).toBe(1)
    const open = handShapes(pinchAt(1, false), 200, d, ASPECT)
    expect([open.right!.pinched, open.right!.twist]).toEqual([false, 0])
  })

  it('TRIANGLE: index tips touching above thumb tips touching', () => {
    const pair = (thumbGap: number) => {
      const l = hand(0.4, 0.7, FIST)
      const r = hand(0.6, 0.7, FIST, { mirror: true })
      l[8] = r[8] = { x: 0.5, y: 0.4 }
      l[4] = { x: 0.5 - thumbGap, y: 0.5 }
      r[4] = { x: 0.5 + thumbGap, y: 0.5 }
      return [H(l), H(r)]
    }
    expect(handShapes(pair(0), 0, null, ASPECT).triangle).toBe(true)
    expect(handShapes(pair(0.05), 0, null, ASPECT).triangle).toBe(false)
  })
})
