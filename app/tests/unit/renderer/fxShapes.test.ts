import { describe, expect, it } from 'vitest'
import { handShapes, type HandShape, type Pt } from '@/components/camera/camMath'
import { FxShapes, HOLD_MS, fingerCurls, rawShape, tremble } from '@/components/camera/fxShapes'
import type { HandGesture } from '@/components/camera/vision'
import { hand3d } from './hand3d'

const ASPECT = 16 / 9

/** A synthetic hand (0-1 of a 16:9 frame), as handShapes.test's: its wrist at (x, y), fingers up the frame; `out` thumb,
 *  index, middle, ring, pinky held out; `turn` a half turn (fingers pointing down). */
function hand(x: number, y: number, out: boolean[], { s = 0.1, turn = false } = {}): Pt[] {
  const p: [number, number][] = Array.from({ length: 21 }, () => [0, 0])
  p[1] = [-0.25, -0.2]
  p[2] = [-0.4, -0.4]
  if (out[0]) {
    p[3] = [-0.4 - 0.28, -0.4 - 0.08]
    p[4] = [-0.4 - 0.57, -0.4 - 0.17]
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
  return p.map(([u, v]) => (turn ? [-u, -v] : [u, v])).map(([u, v]): Pt => ({ x: x + (u! * s) / ASPECT, y: y + v! * s }))
}
const shapeOf = (points: Pt[], gesture: HandGesture | null = null): HandShape => {
  const s = handShapes([{ points, gesture }], 0, null, ASPECT)
  return (s.left ?? s.right)!
}
const O = true
const _ = false

describe("STRINGS' BEAT FX hand shapes", () => {
  it('reads each shape off the landmarks where the recognizer says nothing', () => {
    expect(rawShape(shapeOf(hand(0.3, 0.6, [_, _, _, _, _])), ASPECT)).toBe('fist')
    expect(rawShape(shapeOf(hand(0.3, 0.6, [O, O, O, O, O])), ASPECT)).toBeNull() // open: the playing pose, never an FX
    expect(rawShape(shapeOf(hand(0.3, 0.6, [O, O, O, O, O]), 'open'), ASPECT)).toBeNull()
    expect(rawShape(shapeOf(hand(0.3, 0.6, [_, O, O, _, _])), ASPECT)).toBe('peace')
    expect(rawShape(shapeOf(hand(0.3, 0.6, [_, O, _, _, O])), ASPECT)).toBe('horns') // 🤘
    expect(rawShape(shapeOf(hand(0.3, 0.6, [O, O, _, _, O])), ASPECT)).toBe('horns') // ILoveYou
    expect(rawShape(shapeOf(hand(0.3, 0.6, [_, O, _, _, _])), ASPECT)).toBe('point_up')
    expect(rawShape(shapeOf(hand(0.3, 0.6, [O, O, _, _, _])), ASPECT)).toBeNull() // an L: FRAME's half, no point
    expect(rawShape(shapeOf(hand(0.3, 0.6, [O, O, _, _, _]), 'point'), ASPECT)).toBeNull()
    expect(rawShape(shapeOf(hand(0.3, 0.3, [_, O, _, _, _], { turn: true })), ASPECT)).toBe('point_down')
    const thumbDown = hand(0.3, 0.6, [_, _, _, _, _])
    thumbDown[3] = { x: thumbDown[2]!.x, y: thumbDown[2]!.y + 0.04 } // the thumb out, pointing down the frame
    thumbDown[4] = { x: thumbDown[2]!.x, y: thumbDown[2]!.y + 0.08 }
    expect(rawShape(shapeOf(thumbDown), ASPECT)).toBe('point_down')
    expect(rawShape(shapeOf(hand(0.3, 0.6, [_, _, _, _, _]), 'thumbs-up'), ASPECT)).toBeNull() // no FX
  })

  it("a pinch is the thumb on the index's tip; a fist's thumb on the index stays a fist", () => {
    const pinch = hand(0.3, 0.6, [_, O, _, _, _])
    pinch[4] = { ...pinch[8]! } // the thumb's tip on the index's
    expect(rawShape(shapeOf(pinch), ASPECT)).toBe('pinch')
    expect(rawShape(shapeOf(pinch, 'fist'), ASPECT)).toBe('pinch') // the recognizer reads the curled rest as a fist
    const side = hand3d([0, 0, 1, 1, 1]) // in 3D the tips touch, in the picture they're apart (a hand side-on)
    side.world[4] = { ...side.world[8]! }
    expect(handShapes([side], 0, null, ASPECT).left!.pinch).toBeCloseTo(1)
    const fist = hand(0.3, 0.6, [_, _, _, _, _])
    fist[4] = { ...fist[8]! } // a fist: the thumb over the curled index
    expect(rawShape(shapeOf(fist), ASPECT)).toBe('fist')
  })

  it("the recognizer's sign wins where it's sure", () => {
    const vague = hand(0.3, 0.6, [O, O, O, _, _])
    expect(rawShape(shapeOf(vague, 'victory'), ASPECT)).toBe('peace')
    expect(rawShape(shapeOf(vague, 'love'), ASPECT)).toBe('horns')
    expect(rawShape(shapeOf(vague, 'thumbs-down'), ASPECT)).toBe('point_down')
    expect(rawShape(shapeOf(hand(0.3, 0.6, [O, O, O, O, O]), 'fist'), ASPECT)).toBe('fist')
  })

  it(`holds a shape after ${HOLD_MS} ms, lets it go ${HOLD_MS} ms after it's gone, ignores a flicker`, () => {
    const fx = new FxShapes()
    const fist = hand(0.3, 0.6, [_, _, _, _, _])
    const peace = hand(0.3, 0.6, [_, O, O, _, _])
    const at = (points: Pt[] | null, t: number) =>
      fx.step(points ? handShapes([{ points, gesture: null }], t, null, ASPECT) : handShapes([], t), t, ASPECT).hands?.left ?? null
    expect(at(fist, 0)?.shape).toBeNull()
    expect(at(fist, 100)?.shape).toBeNull()
    expect(at(fist, HOLD_MS + 10)).toMatchObject({ shape: 'fist', since: HOLD_MS + 10 })
    expect(at(peace, 230)?.shape).toBe('fist') // a flicker of another shape...
    expect(at(fist, 300)?.shape).toBe('fist') // ...doesn't switch it
    expect(at(peace, 400)?.shape).toBe('fist')
    expect(at(peace, 400 + HOLD_MS + 10)?.shape).toBe('peace') // held long enough: it does
    expect(at(null, 700)?.shape).toBe('peace') // a dropped frame keeps it
    expect(fx.step(handShapes([], 1100), 1100, ASPECT).hands).toBeNull() // gone
  })

  it('the height and across of each hand, and the spread between two', () => {
    const fx = new FxShapes()
    const pair = (gap: number, t: number) =>
      fx.step(handShapes([{ points: hand(0.5 - gap, 0.7, [O, O, O, O, O]), gesture: null }, { points: hand(0.5 + gap, 0.7, [O, O, O, O, O]), gesture: null }], t, null, ASPECT), t, ASPECT)
    let near = pair(0.05, 0)
    for (let t = 66; t < 600; t += 66) near = pair(0.05, t)
    let far = near
    for (let t = 666; t < 1300; t += 66) far = pair(0.3, t)
    expect(far.spread).toBeGreaterThan(near.spread + 0.4)
    expect(far.spread).toBeLessThanOrEqual(1)
    const left = far.hands!.left!
    expect(left.height).toBeGreaterThan(0.3) // the palm's centre, above the wrist at 0.7 down
    expect(left.height).toBeLessThan(0.45)
    expect(left.x).toBeLessThan(0.25)
    expect(far.hands!.right!.x).toBeGreaterThan(0.75)
  })

  /** Two open hands, 15 results a second for `ms`: `at(t)` each hand's wrist offset. */
  function run(ms: number, at: (t: number) => { l: [number, number]; r: [number, number] }) {
    const fx = new FxShapes()
    let out = fx.signals()
    for (let t = 0; t <= ms; t += 1000 / 15) {
      const { l, r } = at(t)
      out = fx.step(handShapes([{ points: hand(l[0], l[1], [O, O, O, O, O]), gesture: null }, { points: hand(r[0], r[1], [O, O, O, O, O]), gesture: null }], t, null, ASPECT), t, ASPECT)
    }
    return out
  }

  it("the strings' tension and tilt (clockwise positive), 0 with one hand", () => {
    const slack = run(1000, () => ({ l: [0.45, 0.7], r: [0.55, 0.7] }))
    const taut = run(1000, () => ({ l: [0.1, 0.7], r: [0.9, 0.7] }))
    expect(slack.tension).toBeLessThan(0.3)
    expect(taut.tension).toBeGreaterThan(0.95)
    expect(Math.abs(taut.tilt)).toBeLessThan(0.02)
    // 45°: the right hand as far down the frame (square pixels) as it's across: clockwise on screen.
    expect(run(1000, () => ({ l: [0.3, 0.2], r: [0.7, 0.2 + 0.4 * ASPECT] })).tilt).toBeGreaterThan(0.95)
    expect(run(1000, () => ({ l: [0.3, 0.9], r: [0.7, 0.9 - 0.2 * ASPECT] })).tilt).toBeLessThan(-0.4)
    const fx = new FxShapes()
    const one = fx.step(handShapes([{ points: hand(0.3, 0.6, [O, O, O, O, O]), gesture: null }], 0, null, ASPECT), 0, ASPECT)
    expect([one.tension, one.tilt, one.spread]).toEqual([0, 0, 0])
  })

  it('shake: 0 on still hands with tracker jitter and on a steady sweep; up on a 5 Hz tremble', () => {
    let seed = 7
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.004 // ±0.2% of the frame
    const still = run(3000, () => ({ l: [0.3 + noise(), 0.7 + noise()], r: [0.7 + noise(), 0.7 + noise()] }))
    expect(still.shake).toBe(0)
    const sweep = run(3000, (t) => ({ l: [0.1 + t / 6000, 0.7], r: [0.6 + t / 6000, 0.7] }))
    expect(sweep.shake).toBe(0)
    const shaking = run(3000, (t) => ({ l: [0.3 + 0.012 * Math.sin((2 * Math.PI * 5 * t) / 1000), 0.7], r: [0.7, 0.7] }))
    expect(shaking.shake).toBeGreaterThan(0.3)
    // Playing: a fist pumped to the beat (140 and 174 BPM, a palm and more up and down) and a fast reach aren't shake.
    for (const hz of [2.33, 2.9]) expect(run(3000, (t) => ({ l: [0.3, 0.6 + 0.08 * Math.sin((2 * Math.PI * hz * t) / 1000)], r: [0.7, 0.7] })).shake).toBe(0)
    const reach = (t: number) => Math.min(1, Math.max(0, (t - 1000) / 300)) ** 2 * (3 - 2 * Math.min(1, Math.max(0, (t - 1000) / 300)))
    expect(run(1400, (t) => ({ l: [0.2 + 0.15 * reach(t), 0.7], r: [0.7, 0.7] })).shake).toBe(0) // just after it
    expect(tremble([{ t: 0, x: 0, y: 0 }, { t: 60, x: 1, y: 2 }, { t: 140, x: 2.33, y: 4.67 }, { t: 200, x: 3.33, y: 6.67 }])).toBeCloseTo(0, 1) // a steady move, uneven results
  })

  const curlsOf = (fold: number[]) => {
    const h = hand3d(fold)
    return fingerCurls(handShapes([h], 0, null, ASPECT).left!, ASPECT)
  }

  it("FINGER FILTERS: each finger's curl on its own, a relaxed hand straight", () => {
    for (let f = 0; f < 5; f++) {
      const c = curlsOf([0, 1, 2, 3, 4].map((i) => (i === f ? 1 : 0)))
      expect(c[f]).toBeGreaterThan(0.9)
      c.forEach((v, i) => i !== f && expect(v).toBeLessThan(0.05))
    }
    expect(curlsOf([0.25, 0.25, 0.25, 0.25, 0.25])).toEqual([0, 0, 0, 0, 0]) // relaxed, a little curled: the deadband
    expect(curlsOf([0, 0.5, 0, 0, 0])[1]).toBeGreaterThan(0.3) // half folded: on its way
    expect(curlsOf([0, 0.5, 0, 0, 0])[1]).toBeLessThan(0.7)
  })

  it('STRINGS MODE: both hands open; a held shape wins; a new hand starts straight', () => {
    const fx = new FxShapes()
    const step = (l: number[], r: number[], t: number) => fx.step(handShapes([hand3d(l, 0.3), hand3d(r, 0.7)], t, null, ASPECT), t, ASPECT)
    const open = [0, 0, 0, 0, 0]
    let out = step([0, 1, 1, 1, 1], open, 0)
    expect(out.fingers!.left).toEqual([0, 0, 0, 0, 0]) // a new hand's first result: not trusted
    for (let t = 66; t <= 400; t += 66) out = step(open, open, t)
    expect(out.stringsMode).toBe(true)
    out = step(open, [0, 0, 0, 1, 1], 466) // the right hand folds ring and pinky: the bands go at once...
    expect(out.fingers!.right![3]).toBeGreaterThan(0.85)
    expect(out.stringsMode).toBe(true)
    for (let t = 532; t <= 800; t += 66) out = step(open, [0, 0, 0, 1, 1], t)
    expect(out.hands!.right!.shape).toBe('peace') // ...until it's held a PEACE: the shape wins
    expect(out.stringsMode).toBe(false)
    for (let t = 866; t <= 1200; t += 66) out = step(open, open, t) // opened again: the PEACE lets go
    expect(out.stringsMode).toBe(true)
    expect(fx.step(handShapes([hand3d(open, 0.3)], 1266, null, ASPECT), 1266, ASPECT).stringsMode).toBe(true) // a dropped frame
    expect(fx.step(handShapes([hand3d(open, 0.3)], 1700, null, ASPECT), 1700, ASPECT).stringsMode).toBe(false) // one hand
  })
})
