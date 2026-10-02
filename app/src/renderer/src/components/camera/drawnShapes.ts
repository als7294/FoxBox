/**
 * AIR DRAW's shapes: a stroke drawn with a pinch (pinched, the index tip's path, released) recognised by $Q (vendored,
 * New BSD) as a circle, triangle, star or zigzag. $Q also knows its own letters and symbols (less the ones that look like
 * ours), so a scribble lands on one of those or under the confidence floor and fires nothing. One event a stroke (a
 * new `at`), for S2's sound one-shots and TouchDesigner (S3's feed).
 */
import { Point, QDollarRecognizer } from '@/vendor/qdollar/qdollar.mjs'
import type { HandShape, HandShapes, Pt } from './camMath'

export type DrawnShape = 'circle' | 'triangle' | 'star' | 'zigzag'
export interface Drawn {
  shape: DrawnShape
  /** performance.now() of the release that drew it. */
  at: number
  /** $Q's score (1 / the clouds' distance, 1 at most). */
  score: number
}

/** Tuned on clean, wobbly (to ±10 % of the shape's size) and scribbled strokes: the shapes score 0.26-1, scribbles at
 *  most 0.17 against these four. */
const FLOOR = 0.25
const MIN_POINTS = 12
const MIN_LENGTH = 0.15 // frame heights

/** A path through `vs`, `n` points. */
function path(vs: [number, number][], n = 60): [number, number][] {
  const out: [number, number][] = []
  for (let k = 0; k < n; k++) {
    const t = (k / (n - 1)) * (vs.length - 1)
    const s = Math.min(vs.length - 2, Math.floor(t))
    const f = t - s
    out.push([vs[s]![0] + (vs[s + 1]![0] - vs[s]![0]) * f, vs[s]![1] + (vs[s + 1]![1] - vs[s]![1]) * f])
  }
  return out
}

export const TEMPLATES: Record<DrawnShape, [number, number][]> = {
  circle: Array.from({ length: 64 }, (_, i) => [Math.cos((i / 63) * 2 * Math.PI), Math.sin((i / 63) * 2 * Math.PI)]),
  triangle: path([[0, -1], [0.95, 0.7], [-0.95, 0.7], [0, -1]]),
  zigzag: path([[-1, -0.5], [-0.5, 0.5], [0, -0.5], [0.5, 0.5], [1, -0.5]]),
  star: path(
    [0, 1, 2, 3, 4, 0].map((k): [number, number] => {
      const a = -Math.PI / 2 + (k * 4 * Math.PI) / 5
      return [Math.cos(a), Math.sin(a)]
    }),
  ),
}

/** $Q's own templates that look like ours (a squashed circle reads as its D): left out. The rest stay, to catch scribbles. */
const LOOKALIKES = new Set(['D', 'P', 'null', 'six-point star'])

let recognizer: QDollarRecognizer | null = null
function shapes(): QDollarRecognizer {
  if (recognizer) return recognizer
  recognizer = new QDollarRecognizer()
  recognizer.PointClouds = recognizer.PointClouds.filter((c) => !LOOKALIKES.has(c.Name))
  const add = (name: string, pts: [number, number][]) => recognizer!.AddGesture(name, pts.map(([x, y]) => new Point(x * 100, y * 100, 1)))
  for (const [name, pts] of Object.entries(TEMPLATES)) add(name, pts)
  // Hands draw circles as ellipses: two more, wide and tall.
  for (const [sx, sy] of [[1, 0.7], [0.7, 1]]) add('circle', TEMPLATES.circle.map(([x, y]) => [x * sx!, y * sy!]))
  return recognizer
}

/** A stroke's shape (square-pixel points, any scale), or null: too short, a scribble, or one of $Q's own gestures. */
export function recognise(stroke: readonly Pt[]): { shape: DrawnShape; score: number } | null {
  if (stroke.length < MIN_POINTS) return null
  const r = shapes().Recognize(stroke.map((p) => new Point(p.x * 100, p.y * 100, 1)))
  const name = r.Name === 'five-point star' ? 'star' : r.Name
  return name in TEMPLATES && r.Score >= FLOOR ? { shape: name as DrawnShape, score: r.Score } : null
}

/** The strokes being drawn, one a hand; `step` each hands result, a new Drawn on a recognised release. */
export class StrokeShapes {
  private strokes: [Pt[], Pt[]] = [[], []]
  last: Drawn | null = null

  step(hands: HandShapes, now: number, aspect: number): Drawn | null {
    let drawn: Drawn | null = null
    ;([hands.left, hands.right] as (HandShape | null)[]).forEach((h, side) => {
      const stroke = this.strokes[side]!
      if (h?.pinched) {
        const tip = h.points[8]!
        stroke.push({ x: tip.x * aspect, y: tip.y })
        return
      }
      if (stroke.length) {
        let length = 0
        for (let i = 1; i < stroke.length; i++) length += Math.hypot(stroke[i]!.x - stroke[i - 1]!.x, stroke[i]!.y - stroke[i - 1]!.y)
        const r = length >= MIN_LENGTH ? recognise(stroke) : null
        if (r) drawn = this.last = { ...r, at: now }
        this.strokes[side] = []
      }
    })
    return drawn
  }
}
