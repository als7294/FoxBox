import { describe, expect, it } from 'vitest'
import { recognise, StrokeShapes, TEMPLATES, type DrawnShape } from '@/components/camera/drawnShapes'
import { NO_PAIRS, type HandShape, type HandShapes, type Pt } from '@/components/camera/camMath'

let seed = 99
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
/** A shape drawn by hand: turned a little, squashed a little, wobbling by `amt` of its size. */
const drawn = (shape: DrawnShape, amt: number): Pt[] => {
  const rot = (rnd() - 0.5) * 0.4
  const sx = 0.8 + rnd() * 0.4
  return TEMPLATES[shape].map(([x, y]) => ({
    x: (x * Math.cos(rot) - y * Math.sin(rot)) * sx + (rnd() - 0.5) * amt,
    y: x * Math.sin(rot) + y * Math.cos(rot) + (rnd() - 0.5) * amt,
  }))
}

describe('AIR DRAW shapes ($Q)', () => {
  it('knows a circle, a triangle, a star and a zigzag drawn by hand', () => {
    for (const shape of Object.keys(TEMPLATES) as DrawnShape[]) {
      for (const amt of [0, 0.1, 0.2]) expect(recognise(drawn(shape, amt))?.shape, `${shape} ±${amt}`).toBe(shape)
    }
  })

  it('a scribble, a line or a dot fires nothing', () => {
    for (let k = 0; k < 12; k++) {
      let [x, y] = [0, 0]
      expect(recognise(Array.from({ length: 50 }, () => ({ x: (x += (rnd() - 0.5) * 0.5), y: (y += (rnd() - 0.5) * 0.5) })))).toBeNull()
    }
    expect(recognise(Array.from({ length: 40 }, (_, i) => ({ x: i / 20, y: 0.05 * i / 40 })))).toBeNull()
    expect(recognise([{ x: 0, y: 0 }])).toBeNull()
  })

  it('one event a stroke: pinch, draw, release', () => {
    const hand = (pinched: boolean, tip: Pt): HandShape => {
      const points = Array.from({ length: 21 }, () => ({ ...tip }))
      return { pinch: pinched ? 1 : 0, open: 0, fingers: 1, gesture: null, points, pinched, twist: 0, angle: 0, turn: 0 }
    }
    const frame = (h: HandShape | null): HandShapes => ({
      left: null,
      right: h,
      apart: 0,
      frame: { held: false, x0: 0, y0: 0, x1: 0, y1: 0, corners: [], size: 0, since: 0, seen: -1e9 },
      triangle: false,
      pairs: NO_PAIRS,
    })
    const s = new StrokeShapes()
    const circle = TEMPLATES.circle.map(([x, y]) => ({ x: 0.6 + 0.1 * x, y: 0.5 + 0.18 * y })) // 0-1 of a 16:9 frame
    circle.forEach((p, i) => expect(s.step(frame(hand(true, p)), i * 30, 16 / 9)).toBeNull())
    expect(s.step(frame(hand(false, circle[0]!)), 2000, 16 / 9)?.shape).toBe('circle')
    expect(s.step(frame(hand(false, circle[0]!)), 2030, 16 / 9)).toBeNull() // once
    expect(s.last?.at).toBe(2000)
  })
})
