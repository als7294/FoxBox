import { describe, expect, it } from 'vitest'
import { headFromPose, OneEuro, type BodyPt } from '@/components/camera/camMath'
import { HOLD_MS, step } from '@/components/camera/faceTrack'
import { nextRoi } from '@/components/camera/vision'

/** BlazePose's first 13 points on a 1280x720 frame: a head facing the camera with its ears 160 px apart at (640, 300). */
function body(o: { turn?: number; v?: number; earsV?: number } = {}): BodyPt[] {
  const v = o.v ?? 0.9
  const p = (x: number, y: number, vis = v): BodyPt => ({ x: x / 1280, y: y / 720, v: vis })
  const b = Array.from({ length: 13 }, () => p(0, 0, 0))
  b[0] = p(640 + (o.turn ?? 0) * 80, 330) // nose
  b[2] = p(610, 300) // eyes
  b[5] = p(670, 300)
  b[7] = p(720, 305, o.earsV ?? v) // ears (the person's left is on the frame's right)
  b[8] = p(560, 305, o.earsV ?? v)
  b[11] = p(800, 480) // shoulders
  b[12] = p(480, 480)
  return b
}

describe('head-first tracking', () => {
  it("the body's head: a face-sized box round the ears, its turn from the nose, nothing without a head", () => {
    const h = headFromPose(body(), 1280, 720)!
    expect(h.box.x + h.box.w / 2).toBeCloseTo(640)
    expect(h.box.w).toBeCloseTo(176) // 1.1 x the ears' span (the shoulders' 0.45 x 320 is less)
    expect(h.pose.yaw).toBeCloseTo(0)
    expect(headFromPose(body({ turn: 0.5 }), 1280, 720)!.pose.yaw).toBeGreaterThan(0.4) // nose to the frame's right
    expect(headFromPose(body({ earsV: 0.1 }), 1280, 720)!.box.w).toBeCloseTo(144) // no ears: 0.45 x the shoulders
    expect(headFromPose(body({ v: 0.1 }), 1280, 720)).toBeNull()
    expect(headFromPose(null, 1280, 720)).toBeNull()
  })

  it('a track both finders lost is kept while the person is still there', () => {
    const t = [{ box: { x: 500, y: 200, w: 200, h: 240 }, seen: 0 }]
    expect(step(t, [], HOLD_MS + 100)).toEqual([])
    expect(step(t, [], HOLD_MS + 100, 0.25, () => true)).toEqual(t)
  })

  it("the lost face is looked for round the body's head first", () => {
    const r = nextRoi(null, { x: 0.1, y: 0.1, w: 0.3, h: 0.53 }, 1280, 720, 1, { x: 0, y: 0, w: 0.1, h: 0.1 }, { x: 0.5, y: 0.4, w: 0.1, h: 0.15 })
    expect(r.x + r.w / 2).toBeCloseTo(0.55, 2)
    expect(r.y + r.h / 2).toBeCloseTo(0.475, 2)
  })

  it('One Euro in face widths: the same shake is smoothed the same for a small far face and a big near one', () => {
    const run = (size: number) => {
      const f = new OneEuro(2, 2)
      let out = 0
      for (let i = 0; i <= 30; i++) out = f.filter([size * (i % 2 ? 0.05 : -0.05)], i * 33, size)[0]!
      return Math.abs(out) / size
    }
    expect(run(0.05)).toBeCloseTo(run(0.5), 3)
  })
})
