import { describe, expect, it } from 'vitest'
import { handShapes, type HandShapes } from '@/components/camera/camMath'
import { FxShapes } from '@/components/camera/fxShapes'
import { rawShape } from '@/components/camera/fxShapes'
import { usePlayPrefs } from '@/components/camera/playPrefs'
import { PlayGestures, wristRoll, type PluckEvent, type ReleaseEvent } from '@/components/camera/playGestures'
import { hand3d } from './hand3d'

const ASPECT = 16 / 9
const OPEN = [0, 0, 0, 0, 0]
const FIST = [1, 1, 1, 1, 1]
/** A finger's fold (hand3d) for a PLUCK curl: its bends add up to 260° a full fold; PLUCK's curls read 75° (0) …
 *  240° (1). */
const F = (c: number) => (75 + 165 * c) / 260
/** A C: the fingers half curled (about 0.25 of PLUCK's curl), the thumb part way round. */
const C = [0.3, F(0.25), F(0.25), F(0.25), F(0.25)]

/** PLAY on synthetic hands, a result every `dt` ms: the performer's right hand is the picture's left (x 0.3). */
function session({ pointedIn = false, roll = 0, noise = 0 } = {}) {
  const fx = new FxShapes()
  const play = new PlayGestures()
  const plucks: PluckEvent[] = []
  const releases: ReleaseEvent[] = []
  let prev: HandShapes | null = null
  let t = 0
  // Pointed in: the right hand's fingers to the picture's right, the left's to its left (fingertips facing).
  const pose = (side: 1 | -1) => ({ roll, turn: pointedIn ? 90 * side : 0 })
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * noise
  /** The tracker's jitter: every landmark off by up to `noise` (world metres; picture 0-1 at twice that). */
  const shaky = (h: ReturnType<typeof hand3d>) =>
    noise ? { ...h, world: h.world.map((q) => ({ x: q.x + rnd(), y: q.y + rnd(), z: q.z + rnd() })), points: h.points.map((q) => ({ x: q.x + 2 * rnd(), y: q.y + 2 * rnd() })) } : h
  const step = (right: number[] | null, left: number[] | null, { ry = 0.6, ly = 0.6, dt = 40, rx = 0.3, lx = 0.7, turn = 0 } = {}) => {
    t += dt
    const hands = [
      right && shaky(hand3d(right, rx, ry, ASPECT, { ...pose(1), turn: pose(1).turn + turn })),
      left && shaky(hand3d(left, lx, ly, ASPECT, { ...pose(-1), turn: pose(-1).turn - turn })),
    ].filter((h) => !!h)
    prev = handShapes(hands, t, prev, ASPECT)
    const ev = play.step(prev, fx.step(prev, t, ASPECT), t, ASPECT)
    plucks.push(...ev.plucks)
    releases.push(...ev.releases)
    return play.signals()
  }
  return { step, plucks, releases, shapes: () => prev! }
}

describe("PLAY's gestures", () => {
  it('folding a finger plucks its string once per fold, its velocity from how fast', () => {
    const { step, plucks } = session()
    for (let i = 0; i < 5; i++) step(OPEN, OPEN)
    step([0, 1, 0, 0, 0], OPEN) // the right index folds in one result: full velocity...
    expect(plucks).toHaveLength(0)
    step([0, 1, 0, 0, 0], OPEN) // ...still folded on the next (a single result's jump isn't a fold)
    expect(plucks).toMatchObject([{ hand: 'right', finger: 1, velocity: 1 }])
    for (const c of [0.6, 1, 0.45, 0.9, 0.4]) step([0, F(c), 0, 0, 0], OPEN) // it wavers, folded: no more
    expect(plucks).toHaveLength(1)
    for (let i = 0; i < 4; i++) step(OPEN, OPEN) // straight again (80 ms, two results at least): re-armed
    for (const c of [0.2, 0.4, 0.6, 0.6]) step([0, F(c), 0, 0, 0], OPEN) // a slower fold
    expect(plucks).toHaveLength(2)
    expect(plucks[1]!.velocity).toBeCloseTo(0.5, 1)
  })

  it("a single result's jump (a fast-moving hand misread) isn't a fold; one hand over the other doesn't pluck", () => {
    const { step, plucks } = session()
    for (let i = 0; i < 5; i++) step(OPEN, OPEN)
    step([0, 1, 0, 0, 0], OPEN) // up for one result...
    step(OPEN, OPEN) // ...and straight back
    for (let i = 0; i < 5; i++) step(OPEN, OPEN)
    expect(plucks).toHaveLength(0)
    for (let i = 0; i < 5; i++) step(OPEN, OPEN, { rx: 0.45, lx: 0.5 }) // the hands overlapping
    step(OPEN, [0, 1, 0, 0, 0], { rx: 0.45, lx: 0.5 })
    step(OPEN, [0, 1, 0, 0, 0], { rx: 0.45, lx: 0.5 })
    expect(plucks).toHaveLength(0)
  })

  it('one fold misread as fold, dip, fold plucks once; a fold while the hand moves fast (a blur) plucks none', () => {
    const { step, plucks } = session()
    for (let i = 0; i < 5; i++) step(OPEN, null)
    for (const c of [1, 1, 0, 0, 1, 1]) step([0, F(c), 0, 0, 0], null) // a 40 ms-apart dip of two results
    expect(plucks).toHaveLength(1)
    for (let i = 0; i < 5; i++) step(OPEN, null)
    for (let i = 0; i < 3; i++) step([0, 1, 0, 0, 0], null, { rx: 0.3 + 0.06 * (i + 1) }) // ~6 palms a second
    expect(plucks).toHaveLength(1)
  })

  it('a quick fold plucks early (part folded, folding fast); a slow one at the fold', () => {
    const quick = session()
    for (let i = 0; i < 5; i++) quick.step(OPEN, null)
    quick.step([0, F(0.35), 0, 0, 0], null) // 0.35 in one result (40 ms): about 9 curl/s
    quick.step([0, F(0.35), 0, 0, 0], null)
    expect(quick.plucks).toHaveLength(1)
    quick.step([0, 1, 0, 0, 0], null) // the rest of the same fold: no second pluck
    expect(quick.plucks).toHaveLength(1)
    const slow = session()
    for (let i = 0; i < 5; i++) slow.step(OPEN, null)
    for (const c of [0.1, 0.2, 0.3]) slow.step([0, F(c), 0, 0, 0], null) // 2.5 curl/s
    expect(slow.plucks).toHaveLength(0)
    slow.step([0, F(0.5), 0, 0, 0], null)
    slow.step([0, F(0.5), 0, 0, 0], null)
    expect(slow.plucks).toHaveLength(1)
  })

  it('the C (fingers half curled, like holding a ball) is the rest: still or swaying it never plucks, folds past it do', () => {
    const { step, plucks, releases, shapes } = session({ pointedIn: true, noise: 0.0015 })
    for (let i = 0; i < 75; i++) step(C, C) // 3 s, the tracker jittering
    for (let i = 0; i < 75; i++) step(C, C, { ry: 0.6 + 0.05 * Math.sin(i / 3), rx: 0.3 + 0.03 * Math.sin(i / 4), turn: 15 * Math.sin(i / 5) })
    expect(plucks).toHaveLength(0)
    let s = step(C, C)
    expect(s.shapes.right?.shape ?? null).toBeNull() // a C is no FIST (nor anything)
    expect(s.shapes.left?.shape ?? null).toBeNull()
    expect(shapes().frame.held).toBe(false)
    s = step([0.3, 1, F(0.25), F(0.25), F(0.25)], C) // the right index folds on from its C
    s = step([0.3, 1, F(0.25), F(0.25), F(0.25)], C)
    expect(plucks.map((p) => [p.hand, p.finger])).toEqual([['right', 1]])
    expect(s.held.right[1]).toBe(true)
    for (let i = 0; i < 3; i++) step(C, C) // back to the C (80 ms, two results at least): let go
    expect(releases.map((r) => [r.hand, r.finger])).toEqual([['right', 1]])
    const tighter = (k: number) => [0.3, ...[1, 2, 3, 4].map(() => F(0.25 + 0.25 * k))]
    for (let i = 1; i <= 15; i++) step(tighter(i / 15), C) // a tighter C settling in over 0.6 s (its rest rises)...
    for (let i = 0; i < 150; i++) step(tighter(1), C)
    expect(plucks).toHaveLength(1)
    step([0.3, 1, F(0.5), F(0.5), F(0.5)], C) // ...and still plucks on a fold past it
    step([0.3, 1, F(0.5), F(0.5), F(0.5)], C)
    expect(plucks).toHaveLength(2)
  })

  it("PLAY's PINCH is the C closing: a thumb resting near the index tip isn't one, the tips meeting is", () => {
    const fx = new FxShapes()
    const play = new PlayGestures()
    let prev: HandShapes | null = null
    const c = (gap: number) => {
      const h = hand3d(C, 0.3)
      const [i, w] = [h.world[8]!, h.world[0]!]
      const palm = Math.hypot(h.world[9]!.x - w.x, h.world[9]!.y - w.y, h.world[9]!.z - w.z)
      h.world[4] = { x: i.x, y: i.y + gap * palm, z: i.z } // the thumb's tip `gap` palm lengths under the index's
      h.points[4] = { x: h.points[8]!.x, y: h.points[8]!.y + gap * palm * 2 }
      return h
    }
    let t = 0
    const hold = (gap: number, ms: number) => {
      for (const end = t + ms; t < end; t += 40) {
        prev = handShapes([c(gap)], t, prev, ASPECT)
        play.step(prev, fx.step(prev, t, ASPECT), t, ASPECT)
      }
      return play.signals().shapes.right?.shape ?? null
    }
    expect(hold(0.26, 1500)).toBeNull() // a C, the thumb a quarter palm from the index tip (as the tracker saw one)
    expect(hold(0.03, 300)).toBe('pinch') // the tips meet
    expect(hold(0.26, 300)).toBeNull()
  })

  it("a hand playing (its fingers folding into a shape's pattern on the way) is no shape; one held quietly is", () => {
    const { step, plucks } = session()
    for (let i = 0; i < 10; i++) step(OPEN, OPEN)
    const peace = [1, 0, 0, 1, 1] // ring and pinky fold: plucks...
    let s = step(peace, OPEN)
    expect(plucks).toHaveLength(0) // two at once wait 120 ms (no L showing: not a frame being made)
    for (let i = 0; i < 4; i++) s = step(peace, OPEN)
    expect(plucks.map((p) => p.finger)).toEqual([3, 4])
    for (let i = 0; i < 1; i++) s = step(peace, OPEN) // ...200 ms on: fxShapes holds PEACE already, PLAY doesn't
    expect(s.shapes.right?.shape ?? null).toBeNull()
    for (let i = 0; i < 6; i++) s = step(peace, OPEN) // held on quietly
    expect(s.shapes.right?.shape).toBe('peace')
    const uneven = session() // a resting C, ring and pinky curled more than index and middle: never a shape
    let u = uneven.step([0.3, F(0.1), F(0.1), F(0.45), F(0.45)], null)
    for (let i = 0; i < 40; i++) u = uneven.step([0.3, F(0.1), F(0.1), F(0.45), F(0.45)], null)
    expect(u.shapes.right?.shape ?? null).toBeNull()
    expect(uneven.plucks).toHaveLength(0)
  })

  it("each hand's height and the spread are steady: a re-found hand's first result doesn't move them", () => {
    const { step } = session()
    let s = step(OPEN, OPEN, { ry: 0.5 })
    for (let i = 0; i < 20; i++) s = step(OPEN, OPEN, { ry: 0.5 })
    const [height, spread] = [s.height.right!, s.spread]
    expect(height).toBeCloseTo((1 - 0.5 + 0.17 - 0.15) / 0.7, 0) // the palm's centre, normalised
    step(OPEN, null, { ry: 0.5 }) // the left hand missing a result...
    s = step(OPEN, OPEN, { ry: 0.5, lx: 0.95 }) // ...re-found misplaced
    expect(s.spread).toBeCloseTo(spread, 3)
    step(null, OPEN) // the right missing...
    s = step(OPEN, OPEN, { ry: 0.1 }) // ...re-found high
    expect(s.height.right).toBeCloseTo(height, 3)
  })

  it('only a fold seen rising plucks: a misread after a stall on a moving hand, or a gap, never does', () => {
    const { step, plucks } = session()
    for (let i = 0; i < 5; i++) step(OPEN, null)
    step(FIST, null, { dt: 200, rx: 0.4 }) // a stall while the hand moved: the catch-up result misreads it folded...
    step(FIST, null, { rx: 0.4 }) // ...and the misread holds a result
    step(OPEN, null, { rx: 0.4 }) // it was open all along
    step(OPEN, null, { rx: 0.4 })
    step(null, null) // missing from a result
    step(FIST, null, { rx: 0.4 }) // re-found misread...
    step(FIST, null, { rx: 0.4 }) // ...holding
    step(OPEN, null, { rx: 0.4 })
    step(OPEN, null, { rx: 0.4 })
    expect(plucks).toHaveLength(0)
    step([0, 1, 0, 0, 0], null, { rx: 0.4, dt: 200 }) // a real fold through a slow result, the hand still: it plucks
    step([0, 1, 0, 0, 0], null, { rx: 0.4 })
    expect(plucks.map((p) => p.finger)).toEqual([1])
  })

  it("each hand's fingers: the performer's left hand is the picture's right", () => {
    const { step, plucks } = session()
    for (let i = 0; i < 5; i++) step(OPEN, OPEN, { ly: 0.4 })
    step(OPEN, [0, 0, 0, 0, 1], { ly: 0.4 })
    step([1, 1, 0, 0, 0], [0, 0, 0, 0, 1], { ly: 0.4 }) // the thumb folds too: it doesn't pluck (PLUCK.PLUCKS)
    step([1, 1, 0, 0, 0], [0, 0, 0, 0, 1], { ly: 0.4 })
    expect(plucks.map(({ hand, finger }) => [hand, finger])).toEqual([['left', 4], ['right', 1]])
    expect(plucks[0]!.height).toBeGreaterThan(plucks[1]!.height) // the left hand is higher
  })

  it("two fingers flicked and back within a chord's wait: neither a pluck nor a release (no note left hanging)", () => {
    const { step, plucks, releases } = session()
    for (let i = 0; i < 5; i++) step(OPEN, OPEN, { dt: 20 })
    step([0, 0, 1, 1, 0], OPEN, { dt: 20 })
    for (let i = 0; i < 4; i++) step(OPEN, OPEN, { dt: 20 })
    expect(plucks).toHaveLength(0)
    expect(releases).toHaveLength(0)
  })

  it("a fold held while its rest creeps up never plucks as it drifts past the line: a pluck is a fold", () => {
    const { step, plucks } = session()
    for (let i = 0; i < 5; i++) step(OPEN, null)
    for (let c = 0; c <= 0.42; c += 0.02) step([0, F(c), 0, 0, 0], null) // 0.5 curl a second
    for (let i = 0; i < 20; i++) step([0, F(0.42), 0, 0, 0], null)
    expect(plucks).toHaveLength(0)
  })

  it('a hand that comes up folded never plucks; a fist from open is a shape going in: silent', () => {
    const { step, plucks } = session()
    for (let i = 0; i < 5; i++) step(FIST, null)
    expect(plucks).toHaveLength(0)
    step(OPEN, null)
    step(OPEN, null)
    for (let i = 0; i < 6; i++) step(FIST, null) // four at once: no strum
    expect(plucks).toHaveLength(0)
    for (let i = 0; i < 5; i++) step(OPEN, null)
    step([0, 0, 1, 1, 0], null) // two, and a third 40 ms on: a shape going in all the same
    for (let i = 0; i < 6; i++) step([0, 0, 1, 1, 1], null)
    expect(plucks).toHaveLength(0)
    for (let i = 0; i < 5; i++) step(OPEN, null)
    step([0, 1, 1, 1, 0], null) // three at once, dropped as a shape...
    step([0, 1, 1, 1, 0], null)
    for (let i = 0; i < 6; i++) step([0, 1, 1, 1, 1], null) // ...and the fourth a result behind: its straggler
    expect(plucks).toHaveLength(0)
  })

  it('FLOW: pitch the right hand, octave the left, tilt up when the right is higher, a right fist mutes', () => {
    const { step } = session()
    let s = step(OPEN, OPEN, { ry: 0.3, ly: 0.6 })
    for (let i = 0; i < 10; i++) s = step(OPEN, OPEN, { ry: 0.3, ly: 0.6 })
    expect(s.flow.pitch).toBeGreaterThan(s.flow.octave)
    expect(s.flow.tilt).toBeGreaterThan(0.3)
    expect(s.flow.mute).toBe(false)
    expect(step(FIST, OPEN, { ry: 0.3, ly: 0.6 }).flow.mute).toBe(true) // at once, before the shape's hold
    const pitch = s.flow.pitch
    for (let i = 0; i < 10; i++) s = step(null, OPEN, { ly: 0.6 })
    expect(s.flow.mute).toBe(true) // no right hand
    expect(s.flow.pitch).toBeCloseTo(pitch, 2) // and the pitch stays where it was
  })

  it('left-handed: the left hand pitches and mutes, the right the octave and the shapes', () => {
    usePlayPrefs.getState().setLeftHanded(true)
    try {
      const { step } = session()
      let s = step(OPEN, OPEN, { ry: 0.6, ly: 0.3 })
      for (let i = 0; i < 10; i++) s = step(OPEN, OPEN, { ry: 0.6, ly: 0.3 })
      expect(s.flow.pitch).toBeGreaterThan(s.flow.octave)
      expect(s.flow.tilt).toBeGreaterThan(0.3) // the left the higher
      expect(s.flow.shapeHand).toBe('right')
      expect(s.flow.mute).toBe(false)
      expect(step(OPEN, FIST, { ry: 0.6, ly: 0.3 }).flow.mute).toBe(true)
    } finally {
      usePlayPrefs.getState().setLeftHanded(false)
    }
  })

  it('pluck sensitivity: a slow fold 0.4 past its rest plucks on MEDIUM and HIGH, not on LOW', () => {
    const got = (sens: 'low' | 'medium' | 'high') => {
      usePlayPrefs.getState().setSensitivity(sens)
      const { step, plucks } = session()
      for (let i = 0; i < 5; i++) step(OPEN, OPEN)
      for (let c = 0.1; c <= 0.401; c += 0.1) step([0, F(c), 0, 0, 0], OPEN) // 2.5 a second: no early fire
      for (let i = 0; i < 3; i++) step([0, F(0.4), 0, 0, 0], OPEN)
      return plucks.length
    }
    try {
      expect([got('low'), got('medium'), got('high')]).toEqual([0, 1, 1])
    } finally {
      usePlayPrefs.getState().setSensitivity('medium')
    }
  })

  it("PLAY's shapes: held with a depth (the hand's height); open hands are none", () => {
    const { step } = session()
    let s = step(OPEN, OPEN)
    for (let i = 0; i < 8; i++) s = step(OPEN, OPEN)
    expect(s.shapes.right).toMatchObject({ shape: null })
    for (let i = 0; i < 12; i++) s = step([1, 0, 0, 1, 1], OPEN, { ry: 0.5 }) // held 250 ms past fxShapes' 150, quietly
    expect(s.shapes.right!.shape).toBe('peace')
    expect(s.shapes.right!.depth).toBeGreaterThan(0.5)
    expect(s.shapes.left).toMatchObject({ shape: null })
  })

  /** A hand rolled `deg` about its long axis, its thumb end toward the camera for +deg (smaller z is nearer). */
  const rolled = (deg: number, x = 0.3) => {
    const h = hand3d(OPEN, x)
    const r = (deg * Math.PI) / 180
    h.world = h.world.map((p) => ({ x: p.x * Math.cos(r), y: p.y, z: p.x * Math.sin(r) + p.z * Math.cos(r) }))
    return h
  }

  it("TWIST: the wrist's roll from its own rest (square or edge-on), the thumb end toward the camera +", () => {
    for (const deg of [-50, -20, 0, 30, 120, 170]) expect(wristRoll(handShapes([rolled(deg)], 0, null, ASPECT).left!)).toBeCloseTo(deg, -1)
    const twisting = (rest: number) => {
      const fx = new FxShapes()
      const play = new PlayGestures()
      let prev: HandShapes | null = null
      let t = 0
      return (deg: number, ms: number) => {
        for (const end = t + ms; t < end; t += 40) {
          prev = handShapes([rolled(rest + deg)], t, prev, ASPECT)
          play.step(prev, fx.step(prev, t, ASPECT), t, ASPECT)
        }
        return play.signals().twist.right
      }
    }
    for (const rest of [0, 80]) {
      const at = twisting(rest) // palms to the camera, then edge-on (pointing in, palms down)
      expect(at(0, 1200)).toBe(0) // its resting roll
      expect(at(10, 400)).toBe(0) // a little: the dead zone
      expect(at(40, 400)).toBeGreaterThan(0.4)
      expect(at(-40, 400)).toBeLessThan(-0.4)
    }
  })

  it('SUSTAIN: a pluck holds until the finger straightens (or the hand is lost), then releases', () => {
    const { step, plucks, releases } = session()
    for (let i = 0; i < 5; i++) step(OPEN, null)
    step([0, 1, 0, 0, 0], null)
    let s = step([0, 1, 0, 0, 0], null)
    expect(plucks).toMatchObject([{ hand: 'right', finger: 1, held: true }])
    expect(s.held.right).toEqual([false, true, false, false, false])
    s = step([0, F(0.4), 0, 0, 0], null) // relaxing a little: still held
    expect(releases).toHaveLength(0)
    s = step(OPEN, null)
    expect(releases).toHaveLength(0) // one result open: maybe a misread
    s = step(OPEN, null)
    s = step(OPEN, null)
    expect(releases).toMatchObject([{ hand: 'right', finger: 1 }])
    expect(s.held.right[1]).toBe(false)
    step([0, 0, 1, 0, 0], null)
    step([0, 0, 1, 0, 0], null)
    for (let i = 0; i < 10; i++) step(null, null) // the hand lost: its note ends
    expect(releases.map((r) => r.finger)).toEqual([1, 2])
  })

  for (const roll of [0, 75])
    it(`pointed in (fingertips facing, ${roll ? 'edge-on' : 'palms to the camera'}): folds pluck and release, the pose is no shape`, () => {
      const { step, plucks, releases, shapes } = session({ pointedIn: true, roll })
      for (let i = 0; i < 10; i++) step(OPEN, OPEN)
      expect(plucks).toHaveLength(0)
      const right = shapes().left!
      expect(rawShape(right, ASPECT)).toBeNull() // not POINT, not anything
      expect(shapes().frame.held).toBe(false)
      step([0, 1, 0, 0, 0], OPEN)
      step([0, 1, 0, 0, 0], [0, 0, 0, 0, 1])
      step([0, 1, 0, 0, 0], [0, 0, 0, 0, 1])
      expect(plucks.map((p) => [p.hand, p.finger])).toEqual([['right', 1], ['left', 4]])
      for (let i = 0; i < 3; i++) step(OPEN, OPEN)
      expect(releases.map((r) => [r.hand, r.finger])).toEqual(expect.arrayContaining([['right', 1], ['left', 4]]))
      let s = step([0, 0, 1, 1, 1], OPEN) // the index alone left out, sideways: no POINT
      for (let i = 0; i < 6; i++) s = step([0, 0, 1, 1, 1], OPEN)
      expect(['point_up', 'point_down']).not.toContain(rawShape(shapes().left!, ASPECT))
      expect(['point_up', 'point_down']).not.toContain(s.shapes.right?.shape)
    })

  it("the GUIDE's progress: each move's count goes up once per time it's done", () => {
    const { step } = session()
    let s = step(OPEN, null)
    expect(s.progress.hands).toBe(0)
    for (let i = 0; i < 4; i++) s = step(OPEN, OPEN)
    expect(s.progress.hands).toBe(1) // both up (once, however long)
    s = step([0, 1, 0, 0, 0], OPEN)
    s = step([0, 1, 0, 0, 0], OPEN)
    expect(s.progress.pluck).toBe(1)
    for (let i = 0; i < 10; i++) s = step(OPEN, OPEN, { ry: 0.3 }) // the right hand raised a third
    expect(s.progress.octave).toBeGreaterThanOrEqual(1)
    expect(s.progress.pitch).toBeGreaterThanOrEqual(1)
    const pinch = [0, 0, 1, 1, 1]
    const pinched = () => {
      const h = hand3d(pinch, 0.3)
      h.world[4] = { ...h.world[8]! }
      h.points[4] = { ...h.points[8]! }
      return h
    }
    const fx = new FxShapes()
    const play = new PlayGestures()
    let prev: HandShapes | null = null
    for (let t = 0; t < 800; t += 40) {
      prev = handShapes([t < 400 ? hand3d(pinch, 0.3) : pinched()], t, prev, ASPECT) // open, then the pinch
      play.step(prev, fx.step(prev, t, ASPECT), t, ASPECT)
    }
    expect(play.signals().progress.pinch).toBe(1)
    expect(play.signals().shapes.right?.shape).toBe('pinch')
  })
})
