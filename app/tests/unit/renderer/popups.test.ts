import { describe, expect, it } from 'vitest'
import { popupStack } from '@/components/camera/faceStyles'

const area = { x: -9, y: -4, w: 18, h: 22 } // a face's oval box on the head's plane, cm

describe('POP-UPS', () => {
  it('spreads windows over the whole face at their own depths, and the beat pops more up nearest', () => {
    for (const seed of [1, 7, 42, 2024]) {
      const calm = popupStack(area, seed, 0)
      const hit = popupStack(area, seed, 1)
      expect(calm.tiles.reduce((s, c) => s + c.w * c.h, 0)).toBeCloseTo(area.w * area.h) // spread over all of it
      expect(new Set(calm.tiles.map((c) => c.z.toFixed(3))).size).toBeGreaterThan(2) // at different depths
      expect(calm.pops).toHaveLength(0)
      expect(hit.tiles).toEqual(calm.tiles) // the beat doesn't move them...
      expect(hit.pops).toHaveLength(4) // ...it pops four more up, nearer than all of them
      expect(Math.min(...hit.pops.map((w) => w.z))).toBeGreaterThan(Math.max(...calm.tiles.map((w) => w.z)))
    }
  })
})
