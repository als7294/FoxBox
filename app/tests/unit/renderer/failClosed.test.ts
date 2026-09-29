import { describe, expect, it } from 'vitest'
import { maskRegion } from '@/components/camera/compose'
import { lowpolyFacets, onMesh, standInMesh } from '@/components/camera/faceStyles'
import { beatSafe } from '@/components/camera/maskBuild'

const inside = (p: number[], [a, b, c]: number[][]) => {
  const d = (u: number[], v: number[]) => (p[0]! - v[0]!) * (u[1]! - v[1]!) - (u[0]! - v[0]!) * (p[1]! - v[1]!)
  const [d1, d2, d3] = [d(a!, b!), d(b!, c!), d(c!, a!)]
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
}

describe('masks fail closed', () => {
  it('the whole frame hidden with a mesh style is covered by the privacy grid, not left bare', () => {
    const drawn: unknown[][] = []
    const ctx = { save() {}, restore() {}, drawImage: (...a: unknown[]) => drawn.push(a) } as unknown as CanvasRenderingContext2D
    const scratch = { width: 0, height: 0, getContext: () => ({ drawImage() {} }) } as unknown as HTMLCanvasElement
    const dst = { x: 0, y: 0, w: 1280, h: 720 }
    for (const style of ['lowpoly', 'fox', 'depthglitch', 'recipe:abc', 'mask:abc'] as const) {
      drawn.length = 0
      expect(onMesh(style)).toBe(true)
      maskRegion(ctx, {} as CanvasImageSource, dst, dst, { style, strength: 50 } as never, scratch, true, { t: 0, pulse: 0, seed: 1 })
      expect(drawn.at(-1)?.slice(5), style).toEqual([0, 0, 1280, 720]) // the grid, stretched over the whole frame
    }
  })

  it("a face the landmarker lost wears a stand-in head that fills the tracker's box, turned or tilted", () => {
    const g = { cols: 1, rows: 1, px: new Uint8ClampedArray([0, 0, 0, 255]) }
    const box = { x: 400, y: 200, w: 240, h: 300 }
    for (const pose of [null, { yaw: 0.6, roll: 0 }, { yaw: -0.6, roll: 0.3 }, { yaw: 0, roll: -0.3, pitch: 0.3 }]) {
      const { faces } = lowpolyFacets(standInMesh(box, pose), g as never, box)
      let hit = 0
      let n = 0
      for (let x = box.x + box.w * 0.2; x <= box.x + box.w * 0.8; x += box.w / 20)
        for (let y = box.y + box.h * 0.15; y <= box.y + box.h * 0.85; y += box.h / 20, n++) if (faces.some((f) => inside([x, y], f))) hit++
      expect(hit / n, JSON.stringify(pose)).toBeGreaterThan(0.97) // the box's middle, where the face is
    }
  })

  it('the beat stays beat-safe: fast hats flash at most 3 times a second, a kick at 145 comes through', () => {
    const rises = (hz: number) => {
      const safe = beatSafe()
      let last = 0
      let n = 0
      for (let t = 0; t < 4; t += 1 / 60) {
        const v = safe(Math.exp(-((t * hz) % 1) * 6), t) // a hit every 1/hz s, decaying
        if (v > last + 0.15) n++
        last = v
      }
      return n / 4
    }
    expect(rises(174 / 60 * 4)).toBeLessThanOrEqual(3) // 1/16 hats at 174 BPM: 11.6 a second
    expect(rises(145 / 60)).toBeCloseTo(145 / 60, 0) // every kick
  })
})
