import { describe, expect, it } from 'vitest'
import { handShapes, type HandShapes } from '@/components/camera/camMath'
import {
  BEAT_SNAP_MS, CALM_MS, CENTRE_CORNERS, createGlass, FLIP_MS, FLIP_SIDE, EXIT_HOLD_MS, FRAME_TIMING, fitGlass, GLASS_TYPES, glassSignal, LOOP_MAX_MS, loopClock, loopTime, loopWindow,
  quadOf, rectCorners, RESTYLE_MS, type FrameCorners, type GlassQuad,
} from '@/components/strings/glass'
import { invert3, squareToQuad } from '@/components/strings/glassPass'
import { synthHands, synthL } from '@/components/strings/strings'

const ASPECT = 16 / 9
const PANE: GlassQuad = { x: 0.5, y: 0.5, hw: 0.2, hh: 0.15, tilt: 0.1 }
const CORNERS = rectCorners(PANE, ASPECT)
const { edgeMs: EDGE, bloomMs: BLOOM, bloomDelayMs: DELAY, shatterMs: SHATTER } = FRAME_TIMING

/** Steps the glass at 60 fps from `t0` for `ms`, the frame held or not; returns the last frame. */
function run(g: ReturnType<typeof createGlass>, t0: number, ms: number, held: boolean) {
  let f = g.update(t0, held, held ? CORNERS : null)
  for (let t = t0 + 16; t <= t0 + ms; t += 16) f = g.update(t, held, held ? CORNERS : null)
  return f
}

describe('the FRAME: GLASS forms, holds and shatters', () => {
  it('a lit edge draws itself round the frame (0.45 s), the world blooming in from 0.35 s (0.7 s), one soft flash as it closes', () => {
    expect([EDGE, BLOOM, DELAY]).toEqual([450, 700, 350]) // the design's §8
    const g = createGlass({ aspect: ASPECT })
    expect(g.update(0, false, null)).toMatchObject({ mix: 0, corners: null })
    const first = g.update(16, true, CORNERS)
    expect(first).toMatchObject({ type: 'echo', changed: true, mix: 1, edge: 0, bloom: 0, flash: 0, crack: -1 })
    expect(g.update(16 + EDGE / 2, true, CORNERS).edge).toBeCloseTo(0.5, 5)
    expect(g.update(16 + DELAY, true, CORNERS).bloom).toBe(0)
    const closed = g.update(16 + EDGE, true, CORNERS)
    expect([closed.edge, closed.flash]).toEqual([1, 1])
    expect(closed.bloom).toBeGreaterThan(0) // already blooming as the edge closes
    const half = g.update(16 + DELAY + BLOOM / 2, true, CORNERS)
    expect(half.bloom).toBeCloseTo(0.875, 5) // eased out
    expect(half.flash).toBeLessThan(0.5)
    expect(g.update(16 + DELAY + BLOOM, true, CORNERS)).toMatchObject({ bloom: 1, flash: 0 })
    expect(glassSignal()).toMatchObject({ on: true, type: 'echo', onAt: 16, crackAt: 0 })
  })

  it('sits exactly in the frame (its corners), following them', () => {
    const g = createGlass({ aspect: ASPECT })
    g.update(0, true, CORNERS)
    const moved = CORNERS.map((p) => ({ x: p.x + 0.1, y: p.y })) as FrameCorners
    let f = g.update(16, true, moved)
    for (let t = 32; t < 400; t += 16) f = g.update(t, true, moved)
    f.corners!.forEach((p, i) => expect(p.x).toBeCloseTo(moved[i]!.x, 4))
    expect(f.quad!.x).toBeCloseTo(0.6, 4)
  })

  it('a frame lost for less than EXIT_HOLD_MS is the same glass: no flicker, no shatter, no new kind', () => {
    const g = createGlass({ aspect: ASPECT })
    run(g, 0, 600, true)
    const lost = run(g, 616, EXIT_HOLD_MS - 50, false)
    expect(lost).toMatchObject({ mix: 1, crack: -1, type: 'echo' })
    const back = run(g, 616 + EXIT_HOLD_MS - 34, 200, true)
    expect(back).toMatchObject({ mix: 1, crack: -1, type: 'echo', changed: false })
  })

  it('letting go shatters it: the shards are flung out within the shatter time, then it is gone at once', () => {
    const g = createGlass({ aspect: ASPECT })
    run(g, 0, 600, true) // last held at 592
    let gone = 608
    let start = g.update(gone, false, null)
    while (start.crack < 0) start = g.update((gone += 16), false, null)
    expect(gone - 592).toBeGreaterThanOrEqual(EXIT_HOLD_MS)
    expect(start.crack).toBe(0)
    expect(glassSignal()).toMatchObject({ on: false, crackAt: gone })
    const mid = g.update(gone + SHATTER / 2, false, null)
    expect(mid.crack).toBeCloseTo(0.5, 5)
    expect(mid.mix).toBe(1)
    const after = g.update(gone + SHATTER + 16, false, null)
    expect(after).toMatchObject({ mix: 0, corners: null, crack: -1 })
  })
})

describe('the FRAME: the shatter, a hard snap', () => {
  it('REMIX lands it on the beat when one is due within BEAT_SNAP_MS, else at once; never later', () => {
    const g = createGlass({ aspect: ASPECT })
    run(g, 0, 600, true)
    const release = 600 + EXIT_HOLD_MS + 16
    const waiting = g.update(release, false, null, { beat: { bpm: 120, phase: 0.9 } }) // the next beat in 50 ms
    expect(waiting).toMatchObject({ crack: -1, mix: 1 })
    expect(glassSignal()).toMatchObject({ on: false, crackAt: release + 50 })
    expect(g.update(release + 50, false, null).crack).toBe(0)
    expect(g.update(release + 50 + SHATTER, false, null)).toMatchObject({ mix: 0, corners: null })
    const h = createGlass({ aspect: ASPECT })
    run(h, 0, 600, true)
    expect(h.update(release, false, null, { beat: { bpm: 120, phase: 0.5 } }).crack).toBe(0) // 250 ms away: now
    expect(BEAT_SNAP_MS).toBe(60)
  })
})

describe('the FRAME: each new frame the next world', () => {
  it('the front styles in turn: THERMAL, X-RAY, HALFTONE, KALEIDO, then THERMAL again', () => {
    const g = createGlass({ aspect: ASPECT })
    const kinds: string[] = []
    let t = 0
    for (let i = 0; i < 7; i++) {
      kinds.push(run(g, t, 500, true).type)
      t += 516
      run(g, t, 1000, false)
      t += 1016
    }
    expect(kinds).toEqual([...GLASS_TYPES, 'echo'])
    expect(GLASS_TYPES).toEqual(['echo', 'prism', 'halftone', 'kaleido', 'datamosh', 'thermal']) // the design's six
  })

  it('reduced motion: the plain pane, the edge at once, no flash, a short fade in, a 60 ms cut out, no shards', () => {
    const g = createGlass({ aspect: ASPECT, reduced: true })
    const first = g.update(0, true, CORNERS)
    expect(first).toMatchObject({ type: 'plain', edge: 1, bloom: 1, flash: 0, mix: 0 })
    expect(run(g, 16, CALM_MS, true).mix).toBe(1)
    const out = run(g, 16 + CALM_MS + 16, EXIT_HOLD_MS + CALM_MS + 50, false)
    expect(out).toMatchObject({ crack: -1, mix: 0 })
  })
})

describe('the FRAME: pinch to restyle, the last 4 beats on a loop', () => {
  it('a pinch while framed (S1\'s cycles going up) wipes to the next style; one before the frame does nothing', () => {
    const g = createGlass({ aspect: ASPECT })
    g.update(0, false, null, { cycles: 3 })
    expect(g.update(16, true, CORNERS, { cycles: 4 }).type).toBe('echo') // counted before the frame formed
    const pinched = g.update(500, true, CORNERS, { cycles: 5 })
    expect(pinched).toMatchObject({ type: 'prism', prev: 'echo', restyle: 0, changed: true })
    expect(g.update(500 + RESTYLE_MS / 2, true, CORNERS, { cycles: 5 }).restyle).toBeCloseTo(0.5, 5)
    expect(g.update(500 + RESTYLE_MS, true, CORNERS, { cycles: 5 })).toMatchObject({ type: 'prism', restyle: 1, changed: false })
    expect(g.update(900, true, CORNERS, { cycles: 6 }).type).toBe('halftone')
  })

  it('loops the last 4 whole beats before the lock, on the beat, from where the beat is now', () => {
    const w = loopWindow(10_000, { bpm: 120, phase: 0.25 }) // a beat is 500 ms; the last one began at 9875
    expect(w).toEqual({ start: 7875, end: 9875, length: 2000, beats: 4 })
    expect(loopTime(w, 10_000)).toBe(7875 + 125) // a quarter of a beat in, as the song is
    expect(loopTime(w, 9875 + 2000)).toBe(7875) // round again, on the beat
    expect(loopTime(w, 9875 + 2000 + 750)).toBe(7875 + 750)
    // too slow for the ring: 2 beats; too little history yet: what there is; no beat: 120 from the lock
    expect(loopWindow(0, { bpm: 50, phase: 0 }).length).toBe(2400)
    expect(loopWindow(0, { bpm: 50, phase: 0 }).length).toBeLessThanOrEqual(LOOP_MAX_MS)
    expect(loopWindow(10_000, { bpm: 120, phase: 0 }, 8_500)).toMatchObject({ length: 1000, beats: 2 })
    expect(loopWindow(10_000, null)).toEqual({ start: 8000, end: 10_000, length: 2000, beats: 4 })
    // the sweep, the beat and the pulse's phase: a quarter of a beat in; on the flip side the sweep runs back
    expect(loopClock(w, 10_000)).toEqual({ progress: 0.0625, beat: 0, beats: 4 })
    expect(loopClock(w, 9875 + 1250)).toMatchObject({ progress: 0.625, beat: 2 })
    expect(loopClock(w, 9875 + 1250, true)).toMatchObject({ progress: 0.375, beat: 1 })
    // PLAY settles 250 ms (S2's audio): the boundary at or before the lock - 250
    expect(loopWindow(10_000, { bpm: 120, phase: 0.25 }, -Infinity, LOOP_MAX_MS, 250).end).toBe(9375) // the beat began 125 ms ago
    expect(loopWindow(10_000, { bpm: 120, phase: 0.75 }, -Infinity, LOOP_MAX_MS, 250).end).toBe(9625)
  })

  it('PLAY\'s FREEZE frame: on while frozen, locked where it formed, the loop windowed at the lock', () => {
    const g = createGlass({ aspect: ASPECT, follow: false, exitHoldMs: 0 })
    const lock = g.update(1000, true, CORNERS, { beat: { bpm: 100, phase: 0 }, oldest: -Infinity })
    expect(lock).toMatchObject({ mix: 1, loop: { end: 1000, length: 2400, start: -1400, beats: 4 } })
    const elsewhere = CORNERS.map((p) => ({ x: p.x + 0.2, y: p.y })) as FrameCorners
    expect(g.update(1500, true, elsewhere).corners).toEqual(CORNERS) // it stays: the hands play on
    expect(g.update(1516, false, null).crack).toBe(0) // unfrozen: it shatters at once (no hold)
    const none = createGlass({ follow: false, exitHoldMs: 0 })
    expect(none.update(0, true, null).corners).toEqual(CENTRE_CORNERS) // a hand unseen: the middle of the picture
  })

  it('reduced motion: a still of the lock moment, no wipe', () => {
    const g = createGlass({ aspect: ASPECT, reduced: true })
    const f = g.update(1000, true, CORNERS, { beat: { bpm: 120, phase: 0.5 }, cycles: 0 })
    expect(f.loop!.length).toBe(1)
    expect(g.update(1300, true, CORNERS, { cycles: 1 })).toMatchObject({ type: 'plain', restyle: 1 })
  })
})

describe('the FRAME: turned over, the flip side', () => {
  it('flips (a card-flip) to the style\'s partner, the loop backwards; a pinch cycles that side; back again forwards', () => {
    const g = createGlass({ aspect: ASPECT })
    g.update(0, true, CORNERS, { turned: false, cycles: 0 })
    const over = g.update(500, true, CORNERS, { turned: true, cycles: 0 })
    expect(over).toMatchObject({ type: 'slitscan', flipped: true, flip: 0, flipFrom: 'echo', changed: true })
    expect(g.update(500 + FLIP_MS / 2, true, CORNERS, { turned: true, cycles: 0 }).flip).toBeCloseTo(0.5, 5)
    expect(glassSignal()).toMatchObject({ on: true, type: 'slitscan', flipped: true })
    expect(g.update(900, true, CORNERS, { turned: true, cycles: 1 })).toMatchObject({ type: 'xray', prev: 'slitscan', flipped: true }) // PRISM's partner
    const back = g.update(1300, true, CORNERS, { turned: false, cycles: 1 })
    expect(back).toMatchObject({ type: 'prism', flipped: false, flipFrom: 'xray', flip: 0 })
    expect(GLASS_TYPES.map((t) => FLIP_SIDE[t])).toEqual(['slitscan', 'xray', 'scanlines', 'mirror', 'liquid', 'ice']) // S2's pairs
    const loop = { start: 0, end: 2000, length: 2000, beats: 4 }
    expect(loopTime(loop, 2500)).toBe(500)
    expect(loopTime(loop, 2500, true)).toBe(1500) // the flip side runs it backwards
  })

  it('a new frame starts on the front; reduced motion flips with no card', () => {
    const g = createGlass({ aspect: ASPECT, reduced: true })
    g.update(0, true, CORNERS, { turned: false })
    expect(g.update(300, true, CORNERS, { turned: true })).toMatchObject({ flipped: true, flip: 1 })
    const h = createGlass({ aspect: ASPECT })
    run(h, 0, 300, true)
    h.update(320, true, CORNERS, { turned: true })
    run(h, 336, EXIT_HOLD_MS + SHATTER + 200, false)
    expect(h.update(2000, true, CORNERS, { turned: false })).toMatchObject({ flipped: false, type: 'prism' })
  })
})

describe('the FRAME: its geometry', () => {
  it('corners round trip through the quad, and the homography maps the unit square onto them', () => {
    const q = quadOf(CORNERS, ASPECT)
    for (const k of ['x', 'y', 'hw', 'hh', 'tilt'] as const) expect(q[k]).toBeCloseTo(PANE[k], 6)
    const skew: FrameCorners = [{ x: 0.3, y: 0.25 }, { x: 0.72, y: 0.3 }, { x: 0.68, y: 0.8 }, { x: 0.33, y: 0.7 }]
    const H = squareToQuad(skew)
    const at = (m: number[], u: number, v: number) => {
      const w = m[6]! * u + m[7]! * v + m[8]!
      return { x: (m[0]! * u + m[1]! * v + m[2]!) / w, y: (m[3]! * u + m[4]! * v + m[5]!) / w }
    }
    ;[[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], i) => {
      expect(at(H, u!, v!).x).toBeCloseTo(skew[i]!.x, 9)
      expect(at(H, u!, v!).y).toBeCloseTo(skew[i]!.y, 9)
    })
    const back = at(invert3(H), 0.5, 0.5)
    expect(at(H, back.x, back.y).x).toBeCloseTo(0.5, 9)
  })
})

describe('the FRAME: the fallback pane between the hands', () => {
  const frameHands = (t: number) => synthHands(t, ASPECT).hands

  it('the scripted frame is S1\'s FRAME (an L each), held after its hold', () => {
    let prev: HandShapes | null = null
    let now = 0
    for (let t = 8.1; t < 8.6; t += 1 / 30) {
      const h = frameHands(t)
      prev = handShapes([h.left!, h.right!].map((points) => ({ points, gesture: null })), (now += 33), prev, ASPECT, h.body)
    }
    expect(prev!.frame.held).toBe(true)
  })

  it('sits between the four fingertips, its tilt the hands\' (folded to ±45°)', () => {
    const level = fitGlass(synthL(0.4, 0.62, 0.3, 0, ASPECT), synthL(0.6, 0.38, 0.3, Math.PI, ASPECT), ASPECT)
    expect(level.tilt).toBeCloseTo(0, 5)
    expect(level.x).toBeCloseTo(0.5, 1)
    expect(level.y).toBeCloseTo(0.5, 1)
    expect(level.hw).toBeGreaterThan(level.hh * 0.5)
    // the scripted frame turns by 0.3 sin(0.9 t)
    const t = 9.2
    const tilted = fitGlass(frameHands(t).left!, frameHands(t).right!, ASPECT)
    expect(tilted.tilt).toBeCloseTo(0.3 * Math.sin(0.9 * t), 2)
  })
})
