import { describe, expect, it } from 'vitest'
import { lowpolyFacets } from '@/components/camera/faceStyles'
import { posedFace } from '@/components/camera/faceMask'

// A pair of glasses on the canonical head (cm; x right, y up, z forward): lenses ~1.6 cm in front of the eyes, the
// hinges at the temples, the first half of each arm. Posed the way posedFace poses the face (no pitch).
const GLASSES: number[][] = [-1, 1].flatMap((sx) => [
  ...Array.from({ length: 12 }, (_, k) => [sx * 3.2 + 2.6 * Math.cos((k * Math.PI) / 6), 2.6 + 1.9 * Math.sin((k * Math.PI) / 6), 5.4]),
  [sx * 6.4, 3.0, 4.6],
  [sx * 6.65, 2.85, 3.1],
  [sx * 6.9, 2.7, 1.55],
])
// The lower face past the mesh's edge: the lips a little proud of it, and a short beard along the jaw (1.2 cm out,
// 0.8 cm forward): on a turned head both sit in front of the far cheek line.
const LIPS: number[][] = [[-2.46, -4.34, 4.28], [-1.91, -3.8, 5.03], [0, -3.41, 5.98], [1.91, -3.8, 5.03], [2.46, -4.34, 4.28], [1.84, -4.83, 4.82], [0, -5.37, 5.54], [-1.84, -4.83, 4.82]].map(([x, y, z]) => [x!, y!, z! + 0.5])
const BEARD: number[][] = [[7.27, -2.89, -2.25], [5.94, -6.22, -0.63], [4.07, -7.99, 1.93], [2.31, -8.97, 3.61]].flatMap(([x, y, z]) => {
  const k = 1 + 1.2 / Math.hypot(x!, y! + 1)
  return [1, -1].map((sx) => [sx * x! * k, -1 + (y! + 1) * k, z! + 0.8])
})
// face-03's case: wide frames on a slight turn, the hinge wide of the face and just under the eye line.
const WIDE: number[][] = [-1, 1].flatMap((sx) => [
  ...Array.from({ length: 12 }, (_, k) => [sx * 3.6 + 3.2 * Math.cos((k * Math.PI) / 6), 2.4 + 2.0 * Math.sin((k * Math.PI) / 6), 5.2]),
  [sx * 8.8, 1.2, 4.2],
])
const onScreen = ([x, y, z]: number[], yaw: number, s: number) => [300 + s * (x! * Math.cos(yaw) + z! * Math.sin(yaw)), 300 - s * y!]
const inside = (p: number[], [a, b, c]: number[][]) => {
  const d = (u: number[], v: number[]) => (p[0]! - v[0]!) * (u[1]! - v[1]!) - (u[0]! - v[0]!) * (p[1]! - v[1]!)
  const [d1, d2, d3] = [d(a!, b!), d(b!, c!), d(c!, a!)]
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
}

describe('LOW-POLY over glasses and a beard', () => {
  it('covers both lenses, the hinges, the arms, the lips and a beard, head-on and turned up to 0.8 rad either way', () => {
    const g = { cols: 1, rows: 1, px: new Uint8ClampedArray([0, 0, 0, 255]) }
    for (const yaw of [-0.8, -0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6, 0.8]) {
      const { faces } = lowpolyFacets(posedFace(300, 300, 10, yaw, 0), g as never, { x: 200, y: 200, w: 200, h: 200 })
      const shown = [...GLASSES, ...LIPS, ...BEARD].filter((p) => !faces.some((f) => inside(onScreen(p, yaw, 10), f)))
      expect(shown, `yaw ${yaw}`).toEqual([])
    }
  })

  it('covers wide frames on a slight turn (face-03: the far side must not pull in before it reaches forward)', () => {
    const g = { cols: 1, rows: 1, px: new Uint8ClampedArray([0, 0, 0, 255]) }
    for (const yaw of [-0.35, -0.3, -0.25, -0.2, 0.2, 0.25, 0.3, 0.35]) {
      const { faces } = lowpolyFacets(posedFace(300, 300, 10, yaw, 0), g as never, { x: 200, y: 200, w: 200, h: 200 })
      expect(WIDE.filter((p) => !faces.some((f) => inside(onScreen(p, yaw, 10), f))), `yaw ${yaw}`).toEqual([])
    }
  })
})
