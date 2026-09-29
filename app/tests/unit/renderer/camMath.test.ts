import { describe, expect, it } from 'vitest'
import {
  autoFrame,
  Calibration,
  faceNear,
  follow,
  handNear,
  handSignal,
  headPose,
  needsAutoFrame,
  OneEuro,
  orthonormalize,
  poseFromMatrix,
  permutation,
  triangulate,
  type Pt,
} from '@/components/camera/camMath'

/** A hand in camera px: wrist at (x, y), fingers up, `spread` 1 open, 0.4 a fist; thumb tip `pinch` px from the index tip. */
function hand(x: number, y: number, size: number, spread = 1, pinch = size): Pt[] {
  const p: Pt[] = Array.from({ length: 21 }, () => ({ x, y }))
  const knuckle = (i: number, dx: number) => (p[i] = { x: x + dx * size, y: y - size })
  ;[5, 9, 13, 17].forEach((k, j) => knuckle(k, -0.3 + j * 0.2))
  ;[8, 12, 16, 20].forEach((k, j) => (p[k] = { x: x + (-0.3 + j * 0.2) * size, y: y - size * (1 + 0.9 * spread) }))
  p[4] = { x: p[8]!.x + pinch, y: p[8]!.y }
  return p
}

describe('calibration and near', () => {
  it('learns the resting face over 2 s, then leaning in reads as near', () => {
    const c = new Calibration()
    for (let t = 0; t <= 2100; t += 100) c.add(t, 'reach', 1, [0.7])
    expect(c.baseline).toEqual({ measure: 'reach', face: 1, hand: 0.7 })
    expect(faceNear('reach', 1.0, c.baseline)).toBe(0)
    expect(faceNear('reach', 1.5, c.baseline)).toBe(1)
    expect(faceNear('width', 1.5, c.baseline)).toBe(0) // another measure: no answer until recalibrated
  })
  it('upgrades once to head distance (the landmarker has started), and keeps it when the landmarker blinks', () => {
    const c = new Calibration()
    for (let t = 0; t <= 2100; t += 100) c.add(t, 'width', 0.2, [])
    expect(c.baseline?.measure).toBe('width')
    c.add(2200, 'reach', 1, [])
    expect(c.baseline).toBeNull()
    for (let t = 2300; t <= 4500; t += 100) c.add(t, 'reach', 1, [])
    expect(c.baseline?.measure).toBe('reach')
    c.add(4600, 'width', 0.2, [])
    expect(c.baseline?.measure).toBe('reach')
  })
  it('the upgrade to head distance waits for the resting pose (the DJ leaning in when the landmarker arrives)', () => {
    const c = new Calibration()
    for (let t = 0; t <= 2100; t += 100) c.add(t, 'width', 0.2, [], 0.2)
    for (let t = 2200; t <= 6000; t += 100) c.add(t, 'reach', 1.5, [], 0.3) // leaning in: 1.5x the resting width
    expect(c.baseline).toBeNull()
    for (let t = 6100; t <= 8300; t += 100) c.add(t, 'reach', 1, [], 0.2) // back at rest
    expect(c.baseline).toEqual({ measure: 'reach', face: 1, hand: 0.7 })
  })
  it('a hand pushed forward: its palm grows against the face', () => {
    const b = { measure: 'reach' as const, face: 1, hand: 0.7 }
    expect(handNear(0.7, b)).toBe(0)
    expect(handNear(1.4, b)).toBe(1)
  })
  it('eases in faster than out', () => {
    expect(follow(0, 1, 80)).toBeGreaterThan(1 - follow(1, 0, 80))
  })
})

describe('hand and head signals', () => {
  it('open vs fist, pinch', () => {
    expect(handSignal(hand(100, 300, 100, 1), 0).open).toBe(1)
    expect(handSignal(hand(100, 300, 100, 0.2), 0).open).toBeLessThan(0.05)
    expect(handSignal(hand(100, 300, 100, 1, 5), 0).pinch).toBe(1)
    expect(handSignal(hand(100, 300, 100, 1, 100), 0).pinch).toBe(0)
  })
  it('yaw from the nose between the eyes, roll from the eye line', () => {
    expect(headPose({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 3 }).yaw).toBeCloseTo(0)
    expect(headPose({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 9, y: 3 }).yaw).toBeGreaterThan(0.8)
    expect(headPose({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 5, y: 5 }).roll).toBeCloseTo(Math.PI / 4)
  })
})

describe('AUTO-FRAME', () => {
  it('only for a camera much wider than the output', () => {
    expect(needsAutoFrame(1920, 1080, 1080, 1920)).toBe(true)
    expect(needsAutoFrame(1920, 1080, 1920, 1080)).toBe(false)
  })
  it('eases toward the person, never leaves the frame, holds inside the dead zone', () => {
    let c = autoFrame(1920, 1080, 1080, 1920, 0.9, null, 16)
    expect(c.w).toBeCloseTo(607.5)
    for (let i = 0; i < 200; i++) c = autoFrame(1920, 1080, 1080, 1920, 0.95, c.x + c.w / 2, 16)
    // Right up to the edge, less the dead zone (6 % of the crop) that keeps it from chasing every sway.
    expect(c.x + c.w).toBeGreaterThan(1920 - c.w * 0.061)
    expect(c.x + c.w).toBeLessThanOrEqual(1920)
    const held = autoFrame(1920, 1080, 1080, 1920, 0.5 + 0.01, 960, 16)
    expect(held.x + held.w / 2).toBe(960)
  })
})

describe('style geometry', () => {
  it('triangulates a grid into two triangles a cell', () => {
    const pts: Pt[] = []
    for (let j = 0; j <= 2; j++) for (let i = 0; i <= 2; i++) pts.push({ x: i + j * 0.001, y: j })
    expect(triangulate(pts)).toHaveLength(8)
  })
  it('a seeded shuffle is a permutation, and repeatable', () => {
    const p = permutation(50, 7)
    expect([...p].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i))
    expect(permutation(50, 7)).toEqual(p)
  })
})

describe('smoothing and the head matrix', () => {
  it('One Euro: steadies jitter at rest, still follows a move', () => {
    const f = new OneEuro(1, 5)
    let out = 0
    for (let i = 0; i < 60; i++) out = f.filter([0.5 + (i % 2 ? 0.01 : -0.01)], i * 33)[0]!
    expect(Math.abs(out - 0.5)).toBeLessThan(0.003) // ±0.01 jitter, mostly gone
    for (let i = 60; i < 75; i++) out = f.filter([0.8], i * 33)[0]!
    expect(out).toBeGreaterThan(0.78) // half a second later it's there
  })
  it('the matrix: yaw, pitch and roll; a smoothed matrix squared up again', () => {
    const a = Math.PI / 8
    const yawed = [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, -50, 1]
    expect(poseFromMatrix(yawed).yaw).toBeCloseTo(0.5)
    expect(poseFromMatrix(yawed).pitch).toBeCloseTo(0)
    const rolled = [Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1, 0, 0, 0, -50, 1]
    expect(poseFromMatrix(rolled).roll).toBeCloseTo(-a) // counter-clockwise in camera space: the eye line rises to the right in the picture
    const m = orthonormalize(Float32Array.from([2, 0.1, 0, 0, 0.1, 3, 0, 0, 0, 0, 0.5, 0, 1, 2, -40, 1]))
    expect(Math.hypot(m[0]!, m[1]!, m[2]!)).toBeCloseTo(1)
    expect(m[0]! * m[4]! + m[1]! * m[5]! + m[2]! * m[6]!).toBeCloseTo(0)
    expect(m[10]).toBeCloseTo(1)
    expect(m[14]).toBe(-40)
  })
})
