import { describe, expect, it } from 'vitest'
import { rigFace } from '@/components/camera/faceMask'
import { CANON_UV } from '@/components/camera/faceMeshData'

/** A face straight on to the camera: the canonical UV layout as 400 px points. */
const face = (): Float32Array => {
  const m = new Float32Array(478 * 3)
  for (let i = 0; i < 468; i++) m.set([CANON_UV[i * 2]! * 400, CANON_UV[i * 2 + 1]! * 400, 0], i * 3)
  return m
}
const y = (m: Float32Array, i: number) => m[i * 3 + 1]!
const still = { jaw: 0, blinkL: 0, blinkR: 0, browUp: 0, browDown: 0 }

describe('face masks', () => {
  it('a blink folds that painted eye shut, the other stays open', () => {
    const open = rigFace(face(), still)
    const blink = rigFace(face(), { ...still, blinkR: 1 })
    expect(y(open, 145) - y(open, 159)).toBeGreaterThan(5) // their right eye: lower lid below upper
    expect(Math.abs(y(blink, 145) - y(blink, 159))).toBeLessThan(0.5)
    expect(y(blink, 374) - y(blink, 386)).toBeCloseTo(y(open, 374) - y(open, 386))
  })
  it('brows lift the forehead; the skirt hangs outside the outline, most over the forehead', () => {
    const up = rigFace(face(), { ...still, browUp: 1 })
    expect(y(up, 10)).toBeLessThan(y(face(), 10) - 10)
    const rigged = rigFace(face(), still) // the skirt: 468 on, one point under each outline point (10 first, 152 18th)
    expect(y(rigged, 468)).toBeLessThan(y(face(), 10) - 30)
    expect(y(rigged, 468 + 18)).toBeGreaterThan(y(face(), 152) + 5)
  })
})
