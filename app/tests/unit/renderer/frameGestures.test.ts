import { describe, expect, it } from 'vitest'
import { handShapes, isAnL, isLPose, type HandShapes } from '@/components/camera/camMath'
import { FrameGestures, frameQuad, lPoints, palmFacing, setInwardFrames } from '@/components/camera/frameGestures'
import { FxShapes, rawShape } from '@/components/camera/fxShapes'
import { PlayGestures } from '@/components/camera/playGestures'
import { usePlayPrefs } from '@/components/camera/playPrefs'
import { hand3d } from './hand3d'

const ASPECT = 16 / 9
const L = [0, 0, 1, 1, 1] // thumb and index out, the rest folded

/** The two Ls of a frame turned `deg` (clockwise on screen) about the picture's middle: the performer's right hand (the
 *  picture's left) its bottom-left corner, index up and thumb right; the left the top-right. `roll`: both hands turned
 *  over that far in their corners (180: a card turned over; `roll2` the left's, if not the same); `k` its size. */
function frame(deg = 0, pinch: 'R' | null = null, roll = 0, roll2 = roll, fold = L, k = 1) {
  const r = (deg * Math.PI) / 180
  const at = (x: number, y: number) => {
    const [dx, dy] = [(x - 0.5) * ASPECT, y - 0.5]
    return [0.5 + (dx * Math.cos(r) - dy * Math.sin(r)) / ASPECT, 0.5 + dx * Math.sin(r) + dy * Math.cos(r)] as const
  }
  const [rx, ry] = at(0.5 - 0.14 * k, 0.5 + 0.22 * k)
  const [lx, ly] = at(0.5 + 0.14 * k, 0.5 - 0.22 * k)
  const right = hand3d(fold, rx, ry, ASPECT, { mirror: true, thumbSide: true, turn: deg, roll })
  const left = hand3d(fold, lx, ly, ASPECT, { mirror: true, thumbSide: true, turn: 180 + deg, roll: roll2 })
  if (pinch === 'R') {
    right.world[4] = { ...right.world[8]! } // the thumb's tip on the index's
    right.points[4] = { ...right.points[8]! }
  }
  return [right, left]
}

/** hand3d's L with its thumb turned `deg` toward the index (it starts about 70 degrees off it). */
function naturalL(deg: number) {
  const h = hand3d(L, 0.3, 0.6, ASPECT, { thumbSide: true })
  const r = (deg * Math.PI) / 180 // toward the index (up the picture)
  const turn = <P extends { x: number; y: number }>(p: P, o: P): P => ({ ...p, x: o.x + (p.x - o.x) * Math.cos(r) - (p.y - o.y) * Math.sin(r), y: o.y + (p.x - o.x) * Math.sin(r) + (p.y - o.y) * Math.cos(r) })
  for (const i of [3, 4]) {
    h.world[i] = turn(h.world[i]!, h.world[2]!)
    h.points[i] = { x: 0.3 + (h.world[i]!.x * 2) / ASPECT, y: 0.6 + h.world[i]!.y * 2 }
  }
  return h
}

function session() {
  const fx = new FxShapes()
  const play = new PlayGestures()
  const frames = new FrameGestures()
  let prev: HandShapes | null = null
  let t = 0
  let f = frames.step(handShapes([], 0), 0, ASPECT)
  const plucks: number[] = []
  const step = (hands: ReturnType<typeof hand3d>[], n = 1) => {
    for (let i = 0; i < n; i++) {
      t += 40
      prev = handShapes(hands, t, prev, ASPECT)
      const ev = play.step(prev, fx.step(prev, t, ASPECT), t, ASPECT, f)
      plucks.push(...ev.plucks.map((p) => p.finger))
      f = frames.step(prev, t, ASPECT)
    }
    return { f, play: play.signals() }
  }
  return { step, plucks, shapes: () => prev! }
}

describe('the FRAME', () => {
  it('forms after the two Ls hold, its corners a quad clockwise from the top-left, its amount 0.5; making it plucks nothing', () => {
    const { step, shapes, plucks } = session()
    step(frame(0, null, 0, 0, [0, 0, 0, 0, 0]), 10) // open hands where the Ls will be
    expect(step(frame(), 2).f.formed).toBe(false)
    const { f } = step(frame(), 5)
    expect(f.formed).toBe(true)
    expect(f.amount).toBe(0.5)
    const q = frameQuad(shapes().left!, shapes().right!, ASPECT)
    expect(q[0]!.x + q[0]!.y).toBeLessThan(Math.min(q[1]!.x + q[1]!.y, q[2]!.x + q[2]!.y, q[3]!.x + q[3]!.y)) // top-left first
    expect(q[1]!.x).toBeGreaterThan(q[0]!.x) // then clockwise: the top-right
    expect(q[2]!.y).toBeGreaterThan(q[1]!.y)
    expect(f.corners).toHaveLength(4)
    for (const r of [30, -30, 30, -30]) step(frame(0, null, r), 3) // held, rocking
    expect(plucks).toHaveLength(0)
  })

  it('an L held with no frame counts up (the coach: a frame tried for); a frame formed, 0', () => {
    const { step } = session()
    const [right] = frame()
    expect(step([right!], 25).f.lHeldMs).toBeGreaterThanOrEqual(960) // one L for a second: its other hand unseen
    expect(step(frame(), 8).f.lHeldMs).toBe(0)
  })

  it('pulled wider the amount rises (1 at twice its size), closer it falls; a pinch at a corner never drops it', () => {
    const { step } = session()
    step(frame(), 8)
    expect(step(frame(0, null, 0, 0, L, 1.6), 12).f.amount).toBeGreaterThan(0.7)
    expect(step(frame(0, null, 0, 0, L, 0.7), 12).f.amount).toBeLessThan(0.4)
    expect(step(frame(0, 'R'), 4).f.formed).toBe(true) // a 160 ms pinch at the bottom-left corner
    expect(step(frame(), 10).f.formed).toBe(true)
  })

  it("an L's thumb and index read before its other three fold; a C, a point or an open hand never", () => {
    const shape = (fold: number[], thumbSide = true) => handShapes([hand3d(fold, 0.3, 0.6, ASPECT, { thumbSide })], 0, null, ASPECT).left!
    expect(isLPose(shape([0, 0, 0, 0, 0]), ASPECT)).toBe(true) // its thumb out sideways, the other three not folded yet
    expect(isAnL(shape([0, 0, 0, 0, 0]), ASPECT)).toBe(false)
    expect(isAnL(shape(L), ASPECT)).toBe(true)
    for (const fold of [[0.5, 0.5, 0.5, 0.5, 0.5], [1, 0, 1, 1, 1], [0, 0, 0, 0, 0]]) expect(isLPose(shape(fold, false), ASPECT)).toBe(false)
  })

  it("a hand folding two while the other's L shows just after: a frame being made, no chord; without it, a chord", () => {
    for (const lShows of [true, false]) {
      const { step, plucks } = session()
      const open = [0, 0, 0, 0, 0]
      const right = (anL: boolean) => hand3d(anL ? L : open, 0.36, 0.72, ASPECT, { mirror: true, thumbSide: anL })
      for (let i = 0; i < 10; i++) step([right(false), hand3d(open, 0.64, 0.6, ASPECT)])
      step([right(false), hand3d([0, 0, 1, 1, 0], 0.64, 0.6, ASPECT)]) // the left folds two
      for (let i = 0; i < 4; i++) step([right(lShows), hand3d([0, 0, 1, 1, 0], 0.64, 0.6, ASPECT)]) // the L 40 ms on
      expect(plucks).toEqual(lShows ? [] : [2, 3])
    }
  })

  it("a C turned to the camera (its thumb and index read as an L's) plucks: its other fingers are out, not an L's", () => {
    const { step, plucks } = session()
    const c = (fold: number[]) => [hand3d(fold, 0.36, 0.6, ASPECT, { mirror: true, thumbSide: true }), hand3d([0, 0.2, 0.2, 0.2, 0.2], 0.64, 0.6, ASPECT)]
    expect(isLPose(handShapes([c([0, 0.2, 0.2, 0.2, 0.2])[0]!], 0, null, ASPECT).left!, ASPECT)).toBe(true)
    for (let i = 0; i < 10; i++) step(c([0, 0.2, 0.2, 0.2, 0.2]))
    step(c([0, 0.2, 1, 0.2, 0.2]), 2) // the middle folds
    for (let i = 0; i < 4; i++) step(c([0, 0.2, 0.2, 0.2, 0.2]))
    step(c([0, 0.2, 0.2, 1, 0.2]), 2) // the ring
    expect(plucks).toEqual([2, 3])
  })

  it("a natural L (the thumb about 60 degrees from the index, not straight out) is an L and no POINT; the old one too", () => {
    const natural = (deg: number) => handShapes([naturalL(deg)], 0, null, ASPECT).left!
    for (const deg of [0, 30]) {
      expect(isAnL(natural(deg), ASPECT)).toBe(true)
      expect(rawShape(natural(deg), ASPECT)).toBeNull()
    }
    expect(isLPose(natural(70), ASPECT)).toBe(false) // the thumb along the index: no L
  })

  it('an L wobbling a little past its limits stays one (a dim room); the same hand fresh is none', () => {
    const was = handShapes([naturalL(0)], 0, null, ASPECT)
    expect(was.left!.isL).toBe(true)
    expect(handShapes([naturalL(42)], 40, was, ASPECT).left!.isL).toBe(true) // the thumb 28 degrees off the index
    expect(handShapes([naturalL(42)], 0, null, ASPECT).left!.isL).toBe(false)
  })

  it("a palm's facing, whichever hand: turned over the other way, edge-on unsure", () => {
    const f = (roll: number, mirror = false) => palmFacing(handShapes([hand3d(L, 0.3, 0.6, ASPECT, { roll, mirror })], 0, null, ASPECT).left!)
    expect(f(0)).not.toBe(0)
    expect(f(0, true)).toBe(f(0)) // the other hand, facing the same way
    expect(f(180)).toBe(-f(0))
    expect(f(180, true)).toBe(-f(0))
    expect(f(90)).toBe(0)
  })

  it('a flip: both hands turned over like a card in their corners, and back; a frame turned on screen or rocked never flips', () => {
    const { step } = session()
    step(frame(), 8)
    for (const d of [10, 20, -25, -10, 25, 0]) expect(step(frame(d), 3).f.flipped).toBe(false)
    for (const r of [30, -50, 50, 0]) expect(step(frame(0, null, r), 3).f.flipped).toBe(false)
    for (let r = 0; r <= 180; r += 30) step(frame(0, null, r), 1) // a quick turn over
    let s = step(frame(0, null, 180), 6)
    expect(s.f.flipped).toBe(true)
    expect(s.f.formed).toBe(true)
    expect(step(frame(0, null, 180), 20).f.flips).toBe(1) // one flip per turn
    for (let r = 180; r >= 0; r -= 30) step(frame(0, null, r, 180), 1) // back, one hand and then the other
    for (let r = 180; r >= 0; r -= 30) step(frame(0, null, 0, r), 1)
    s = step(frame(), 6)
    expect(s.f.flipped).toBe(false)
    expect(s.f.flips).toBe(2)
    expect(s.f.formed).toBe(true) // a flip isn't a release
    for (let d = 0; d <= 180; d += 20) step(frame(d), 1) // turned right round on screen: not a flip
    expect(step(frame(180), 6).f.flips).toBe(2)
  })

  it('a release: both hands out of their L for 0.3 s, one of them lost a moment on the way; a hand lost in its L holds it', () => {
    const { step } = session()
    step(frame(), 8)
    const [right] = frame()
    expect(step([right!], 15).f.formed).toBe(true) // the other hand lost while an L: no release
    const open = frame(0, null, 0, 0, [0, 0, 0, 0, 0])
    step(open, 2)
    let s = step([open[0]!], 3) // out, the other lost
    expect(s.f.formed).toBe(true)
    s = step(open, 4) // 320 ms out
    expect(s.f.formed).toBe(false)
  })

  it('a release with both hands lost a moment as they leave their Ls: timed from the first result without one', () => {
    const { step } = session()
    step(frame(), 8)
    step([], 3) // both lost, 120 ms
    const open = frame(0, null, 0, 0, [0, 0, 0, 0, 0])
    expect(step(open, 3).f.formed).toBe(true) // 200 ms since the first result without an L
    expect(step(open, 3).f.formed).toBe(false) // 320 ms
  })

  it('turned over slowly: still an L edge-on on the looser limits, the same frame flipped; misread out of it 0.3 s, let go', () => {
    const { step } = session()
    step(frame(), 8)
    expect(step(frame(0, null, 90), 10).f.formed).toBe(true) // edge-on 400 ms: still an L on the looser limits
    let s = step(frame(0, null, 180), 8)
    expect(s.f).toMatchObject({ formed: true, flipped: true, flips: 1 })
    s = step(frame(0, null, 90, 90, [0, 0, 0, 0, 0]), 9) // misread as open hands mid-turn 0.32 s: let go
    expect(s.f.formed).toBe(false)
    s = step(frame(0, null, 180), 8) // made again: a new frame, the right way up
    expect(s.f).toMatchObject({ formed: true, flipped: false })
  })

  it("held only: let go, it's gone (no latch); made again, a new frame; while held PLAY names no shape", () => {
    const { step } = session()
    const was = step(frame(), 8).f.formedAt
    expect(step(frame(), 1).play.shapes.right?.shape ?? null).toBeNull()
    expect(step([hand3d([0, 0, 0, 0, 0], 0.3), hand3d([0, 0, 0, 0, 0], 0.7)], 15).f.formed).toBe(false)
    const s = step(frame(), 8)
    expect(s.f.formed).toBe(true)
    expect(s.f.formedAt).toBeGreaterThan(was)
  })

  it("Melody's LOOP: two real Ls at any rotation, either hand on top, form in 0.15 s; open palms (thumbs out) or facing out, never", () => {
    const palm = [0, 0, 0, 0, 0] // an open hand, its thumb out: thumb and index read as an L's (2.1.1, S3)
    setInwardFrames(true)
    try {
      for (const deg of [0, 45, 90, 180]) {
        const { step } = session()
        expect(step(frame(deg), 3).f.formed).toBe(false)
        expect(step(frame(deg), 3).f).toMatchObject({ formed: true, amount: 0.5 })
        expect(step(frame(deg, null, 0, 0, [0.6, 0, 1, 1, 1]), 9).f.formed).toBe(false) // out of the L 0.32 s: let go
        expect(session().step(frame(deg, null, 0, 0, palm), 12).f.formed).toBe(false) // LOOP's own moves: open palms
      }
      // The same Ls swapped round, their openings facing away from each other: no frame.
      const out = () => [hand3d(L, 0.64, 0.28, ASPECT, { mirror: true, thumbSide: true }), hand3d(L, 0.36, 0.72, ASPECT, { mirror: true, thumbSide: true, turn: 180 })]
      expect(session().step(out(), 10).f.formed).toBe(false)
    } finally {
      setInwardFrames(false)
    }
  })

  it("the outline is the fingers' own (2.1.1): each L's index tip, thumb/index base and thumb tip, followed live; gone on release", () => {
    const { step, shapes } = session()
    const at = (q: { x: number; y: number }[], h: NonNullable<HandShapes['left']>) => {
      const own = lPoints(h)
      expect(own[0]).toEqual(h.points[8]) // the index tip
      expect(own[2]).toEqual(h.points[4]) // the thumb tip
      expect(own[1]!.x).toBeCloseTo((h.points[2]!.x + h.points[5]!.x) / 2, 9) // between the thumb's and index's bases
      return own.every((p) => q.some((v) => Math.hypot(v.x - p.x, v.y - p.y) < 1e-4))
    }
    const clockwise = (q: { x: number; y: number }[]) => q.reduce((sum, p, k) => sum + p.x * ASPECT * q[(k + 1) % q.length]!.y - q[(k + 1) % q.length]!.x * ASPECT * p.y, 0) > 0
    let s = step(frame(), 20)
    expect(s.f.outline).toHaveLength(6)
    expect(at(s.f.outline!, shapes().left!) && at(s.f.outline!, shapes().right!)).toBe(true) // its 6 vertices: theirs
    expect(clockwise(s.f.outline!)).toBe(true)
    s = step(frame(0, null, 0, 0, L, 1.3), 20) // pulled wider: it follows
    expect(at(s.f.outline!, shapes().left!) && at(s.f.outline!, shapes().right!)).toBe(true)
    s = step(frame(0, null, 0, 0, [0, 0, 0, 0, 0]), 3) // let go, 120 ms: still formed (the grace), but nothing drawn
    expect(s.f.formed).toBe(true)
    expect(s.f.outline).toBeNull()
    expect(step(frame(0, null, 0, 0, [0, 0, 0, 0, 0]), 6).f.formed).toBe(false)
    usePlayPrefs.setState({ controlStyle: 'one', holdMs: 500 })
    try {
      const one = session()
      const [right] = frame()
      const f = one.step([right!], 30).f
      const h = one.shapes().left ?? one.shapes().right!
      expect(f.outline).toHaveLength(3) // one hand: between its thumb and index
      expect(at(f.outline!, h)).toBe(true)
      expect(clockwise(f.outline!)).toBe(true)
      expect(at(f.corners!, h)).toBe(true) // its pane's quad: the parallelogram on those three (no 2.2-palm square)
    } finally {
      usePlayPrefs.setState({ controlStyle: 'curl' })
    }
  })

  it('one-handed: one L held the Hold time is the frame on its corner, as long as it is held; turned over, the flip side', () => {
    usePlayPrefs.setState({ controlStyle: 'one', holdMs: 500, wobble: 'medium' })
    try {
      const { step } = session()
      const [right] = frame()
      const open = hand3d([0, 0, 0, 0, 0], 0.36, 0.72, ASPECT, { mirror: true })
      for (let i = 0; i < 5; i++) step([open])
      let s = step([right!], 6) // 240 ms
      expect(s.f.formed).toBe(false)
      expect(s.f.holdProgress).toBeGreaterThan(0.3)
      s = step([right!], 8) // 560 ms
      expect(s.f).toMatchObject({ formed: true, holdProgress: 0, amount: 0.5 })
      expect(s.f.corners).toHaveLength(4)
      expect(s.f.corner!.x).toBeCloseTo(0.36, 1) // the L's corner, about where the hand is
      s = step([open], 10) // let go
      expect(s.f.formed).toBe(false)
      expect(s.f.corner).not.toBeNull() // kept where it was
      s = step([right!], 14) // held again: a new frame
      expect(s.f).toMatchObject({ formed: true, flipped: false })
      for (const r of [45, 90, 135]) step([frame(0, null, r)[0]!])
      s = step([frame(0, null, 180)[0]!], 15) // turned over in its corner: the flip side, still held
      expect(s.f).toMatchObject({ formed: true, flipped: true })
      for (const r of [135, 90, 45]) step([frame(0, null, r)[0]!])
      s = step([right!], 10) // and back: the front
      expect(s.f).toMatchObject({ formed: true, flipped: false })
      expect(step([open], 10).f.formed).toBe(false)
      const both = step(frame(), 14).f // the other hand's L too: still the one hand's frame (its corner)
      expect(both.formed).toBe(true)
      expect(both.corner).not.toBeNull()
    } finally {
      usePlayPrefs.setState({ controlStyle: 'curl' })
    }
  })
})
