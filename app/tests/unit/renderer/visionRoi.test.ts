import { describe, expect, it } from 'vitest'
import { nextRoi, type Roi } from '@/components/camera/vision'

const face = (cx: number, cy: number, r: number) =>
  Array.from({ length: 8 }, (_, k) => ({ x: cx + r * Math.cos(k), y: cy + r * Math.sin(k) * (16 / 9) }))
const FULL: Roi = { x: 0, y: 0, w: 1, h: 1 }

describe('the face crop', () => {
  it('zooms on a small face, holds while it stays inside, re-centres once it nears the edge', () => {
    const a = nextRoi(face(0.6, 0.3, 0.03), FULL, 1280, 720, 0)
    expect(a.w * 1280).toBeCloseTo(a.h * 720) // square
    expect(a.w).toBeLessThan(0.3) // zoomed in
    expect(nextRoi(face(0.61, 0.3, 0.03), a, 1280, 720, 0)).toBe(a) // held: the landmarker keeps tracking
    const b = nextRoi(face(0.75, 0.3, 0.03), a, 1280, 720, 0)
    expect(b.x + b.w / 2).toBeCloseTo(0.75, 2)
  })
  it('a big face gets the whole frame, kept until it is well smaller', () => {
    const big = nextRoi(face(0.5, 0.5, 0.15), { x: 0.4, y: 0.3, w: 0.3, h: 0.53 }, 1280, 720, 0)
    expect(big).toEqual(FULL)
    // A face whose crop would be ~77 % of the height: whole while it was whole, a crop coming from a crop.
    expect(nextRoi(face(0.5, 0.5, 0.09), big, 1280, 720, 0)).toBe(big)
    expect(nextRoi(face(0.5, 0.5, 0.09), { x: 0.3, y: 0.2, w: 0.4, h: 0.71 }, 1280, 720, 0).w).toBeLessThan(1)
    // Lost from the whole frame: looked for there (not in the head's crop, which would bounce back), then round the head.
    const head = { x: 0.45, y: 0.3, w: 0.15, h: 0.35 }
    expect(nextRoi(null, big, 1280, 720, 1, null, head)).toBe(big)
    expect(nextRoi(null, big, 1280, 720, 4, null, head).w).toBeLessThan(1)
  })
  it('a lost face: looked for where it was (widening), then a scan of tiles', () => {
    const a = nextRoi(face(0.6, 0.3, 0.03), FULL, 1280, 720, 0)
    const w1 = nextRoi(null, a, 1280, 720, 1)
    expect(w1.w).toBeCloseTo(a.w * 1.25)
    expect(w1.x + w1.w / 2).toBeCloseTo(a.x + a.w / 2)
    const tiles = [4, 5, 6, 7].map((lost) => nextRoi(null, w1, 1280, 720, lost))
    expect(new Set(tiles.map((t) => t.x.toFixed(3))).size).toBeGreaterThan(2) // centre, left, right, top
  })
})
