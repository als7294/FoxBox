import { beforeEach, describe, expect, it } from 'vitest'
import { handShapes, type HandShapes, type Pt } from '@/components/camera/camMath'
import { fingerCurls, rawShape } from '@/components/camera/fxShapes'
import { usePlayPrefs } from '@/components/camera/playPrefs'
import { isShaka, setWheelOpen, WheelGestures } from '@/components/camera/wheelGestures'
import { hand3d } from './hand3d'

const ASPECT = 16 / 9
const OPEN = [0, 0, 0, 0, 0]
const SHAKA = [0, 1, 1, 1, 0]
const shape = (fold: number[], gesture: 'love' | null = null) => handShapes([{ ...hand3d(fold), gesture }], 0, null, ASPECT).left!

/** A hand's picture points turned `deg` clockwise on screen about its wrist (its world landmarks as they were). */
function turned(fold: number[], deg: number, x: number) {
  const h = hand3d(fold, x)
  const w = h.points[0]!
  const r = (deg * Math.PI) / 180
  h.points = h.points.map((p): Pt => {
    const dx = (p.x - w.x) * ASPECT
    const dy = p.y - w.y
    return { x: w.x + (dx * Math.cos(r) - dy * Math.sin(r)) / ASPECT, y: w.y + dx * Math.sin(r) + dy * Math.cos(r) }
  })
  return h
}

/** The wheel on synthetic hands, a result every 40 ms: the performer's right hand is the picture's left (x 0.3). */
function session() {
  const wheel = new WheelGestures()
  let prev: HandShapes | null = null
  let t = 0
  return (right: ReturnType<typeof hand3d> | null, left: ReturnType<typeof hand3d> | null, n = 1) => {
    let out = wheel.signals()
    for (let i = 0; i < n; i++) {
      t += 40
      prev = handShapes([right, left].filter((h) => !!h), t, prev, ASPECT)
      out = wheel.step(prev, t, ASPECT)
    }
    return out
  }
}

beforeEach(() => setWheelOpen(false))

describe("the library wheel's gestures", () => {
  it("a shaka is none of REMIX's shapes, and none of them is a shaka", () => {
    expect(isShaka(fingerCurls(shape(SHAKA), ASPECT))).toBe(true)
    for (const other of [[1, 0, 1, 1, 0], [0, 0, 1, 1, 0], [1, 0, 0, 1, 1], [1, 0, 1, 1, 1], [1, 1, 1, 1, 1], OPEN])
      expect(isShaka(fingerCurls(shape(other), ASPECT))).toBe(false) // horns, ILoveYou, peace, point, fist, open
    expect(rawShape(shape(SHAKA, 'love'), ASPECT)).toBeNull() // the recognizer's ILoveYou on a shaka: no HORNS
  })

  it('a shaka held half a second opens the wheel, once; held again it closes it', () => {
    const step = session()
    expect(step(hand3d(SHAKA, 0.3), null, 10).open).toBe(false) // held 360 ms
    expect(step(hand3d(SHAKA, 0.3), null, 4).open).toBe(true) // 520
    expect(step(hand3d(SHAKA, 0.3), null, 30).open).toBe(true) // still held: no flicker
    step(hand3d(OPEN, 0.3), null, 10)
    expect(step(hand3d(SHAKA, 0.3), null, 14).open).toBe(false)
    expect(step(hand3d([0, 0, 1, 1, 0], 0.3), null, 30).open).toBe(false) // ILoveYou held: nothing
  })

  it("the dial: the right index's angle as in a mirror, rising as it sweeps across the body, up, and outward", () => {
    const step = session()
    const point = [1, 0, 1, 1, 1]
    const dial = (deg: number) => step(turned(point, deg, 0.3), null, 10).dial!
    const sweep = [100, 60, 20, 0, -20, -60].map(dial) // clockwise on screen is across the performer's body
    for (let i = 1; i < sweep.length; i++) expect(sweep[i]!).toBeGreaterThan(sweep[i - 1]!)
    const lean = (Math.atan2(0.03, 0.085) * 180) / Math.PI // hand3d's index leans out along its knuckle
    expect(dial(lean)).toBeCloseTo(270, 0) // turned straight up
    expect(step(turned(point, 145, 0.3), null, 10).edge).toBe(-1) // ~145°, held at the low end: keep scrolling
    expect(step(turned(point, lean, 0.3), null, 10).edge).toBe(0) // held up: resting, no scroll
    expect(step(turned(point, -15, 0.3), null, 10).edge).toBe(1) // out past upright
    expect(step(turned([1, 1, 1, 1, 1], 0, 0.3), null, 1).dial).toBeNull() // not pointing
  })

  it('the grab: the left hand closing 0 to 1, a full grab held 0.8 s loads once', () => {
    const step = session()
    const grabs = [0, 0.4, 0.6, 0.8, 1].map((f) => step(null, hand3d([0, f, f, f, f], 0.7), 8).grab)
    expect(grabs[0]).toBeCloseTo(0)
    for (let i = 1; i < grabs.length; i++) expect(grabs[i]!).toBeGreaterThanOrEqual(grabs[i - 1]!)
    expect(grabs[4]).toBeGreaterThan(0.95)
    const full = step(null, hand3d([0, 1, 1, 1, 1], 0.7), 25)
    expect(full.loads).toBe(1)
    expect(step(null, hand3d([0, 1, 1, 1, 1], 0.7), 30).loads).toBe(1) // still held: once
    step(null, hand3d(OPEN, 0.7), 10)
    expect(step(null, hand3d([0, 1, 1, 1, 1], 0.7), 30).loads).toBe(2)
  })

  it('left-handed: the left index dials (the same angles, mirrored), the right hand grabs', () => {
    usePlayPrefs.getState().setLeftHanded(true)
    try {
      const step = session()
      const point = [1, 0, 1, 1, 1]
      expect(step(turned(point, 0, 0.3), null, 10).dial).toBeNull() // the right index: no dial
      const left = (turn: number) => hand3d(point, 0.7, 0.6, ASPECT, { mirror: true, turn })
      const sweep = [-60, -20, 0, 20, 60].map((t) => step(null, left(t), 10).dial!) // across the body to outward
      for (let i = 1; i < sweep.length; i++) expect(sweep[i]!).toBeGreaterThan(sweep[i - 1]!)
      expect(Math.min(...sweep.map((d) => Math.abs(d - 270)))).toBeLessThan(25)
      expect(step(hand3d([0, 1, 1, 1, 1], 0.3), null, 30).loads).toBe(1) // the right hand's full grab loads
    } finally {
      usePlayPrefs.getState().setLeftHanded(false)
    }
  })

  it('one-handed: the one hand dials with its index, closes to grab, and a fist held 0.8 s loads', () => {
    usePlayPrefs.setState({ controlStyle: 'one' })
    try {
      const step = session()
      const point = [1, 0, 1, 1, 1]
      expect(step(turned(point, 0, 0.3), null, 10).dial).not.toBeNull() // the right hand alone: it dials
      expect(step(turned(point, 0, 0.3), null, 1).grab).toBeLessThan(0.85) // pointing isn't a full grab
      expect(step(hand3d([0, 0.7, 0.7, 0.7, 0.7], 0.3), null, 30).loads).toBe(0) // closed round a grab: a preview, no load
      step(turned(point, 0, 0.3), null, 5)
      expect(step(hand3d([0, 1, 1, 1, 1], 0.3), null, 30).loads).toBe(0) // fingers folded, the thumb out: not a fist
      const fist = hand3d([1, 1, 1, 1, 1], 0.3) // the thumb wrapped over the middle finger's middle joint
      fist.world[4] = { ...fist.world[10]!, z: fist.world[10]!.z - 0.01 }
      fist.points[4] = { ...fist.points[10]! }
      expect(step(fist, null, 25).loads).toBe(1) // the same hand's fist: a load
      expect(step(hand3d([0, 0, 0, 0, 0], 0.3), null, 10).loads).toBe(1) // opening after it doesn't load again
    } finally {
      usePlayPrefs.setState({ controlStyle: 'curl' })
    }
  })
})
