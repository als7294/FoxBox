// The design's wireframe hands (app/design/foxbox-2 prototype, glyph()): a 21-point hand, each finger curled 0-1, a 12%
// palm, bones (1.8px over a 16% underlay), fingertip dots (the hot ones orange), and accent strokes for motion.
const HAND: [number, number][] = [
  [0, 0],
  [-0.35, -0.25],
  [-0.6, -0.5],
  [-0.78, -0.75],
  [-0.92, -0.98],
  [-0.28, -1],
  [-0.32, -1.45],
  [-0.34, -1.72],
  [-0.36, -1.98],
  [0, -1.05],
  [0, -1.55],
  [0, -1.85],
  [0, -2.12],
  [0.26, -0.98],
  [0.3, -1.42],
  [0.32, -1.7],
  [0.34, -1.94],
  [0.5, -0.85],
  [0.6, -1.2],
  [0.66, -1.42],
  [0.7, -1.62],
]
const BONES: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20],
]

export interface GlyphOpts {
  /** Size in px (the svg's box). */
  w?: number
  /** Scale of the hand inside it. */
  s?: number
  tilt?: number
  ox?: number
  oy?: number
  pinch?: boolean
  /** Fingertip indexes drawn orange. */
  hot?: number[]
  /** Accent paths (arrows, frame corners), in the glyph's -34..34 box. */
  extra?: string[]
  col?: string
  acc?: string
}

export function HandGlyph({ curls, ...o }: { curls: number[] } & GlyphOpts) {
  const out = HAND.map(([x, y]) => [x, y] as [number, number])
  for (let f = 0; f < 5; f++) {
    const b = 1 + f * 4
    const c = curls[f] ?? 0
    const base = f === 0 ? out[1]! : out[b]!
    for (let k = f === 0 ? 2 : 1; k < 4; k++) {
      const p = out[b + k]!
      p[0] = base[0] + (p[0] - base[0]) * (1 - 0.72 * c)
      p[1] = base[1] + (p[1] - base[1]) * (1 - 0.78 * c) + 0.32 * c * k
    }
  }
  if (o.pinch) {
    out[4] = [(out[4]![0] + out[8]![0]) / 2 - 0.05, (out[4]![1] + out[8]![1]) / 2]
    out[8] = [out[4]![0] + 0.1, out[4]![1] - 0.04]
  }
  const s = o.s ?? 22
  const t = o.tilt ?? 0
  const ox = o.ox ?? 0
  const oy = o.oy ?? 26
  const [ct, st] = [Math.cos(t), Math.sin(t)]
  const P = out.map(([x, y]) => [ox + (x * ct - y * st) * s, (x * st + y * ct) * s + oy])
  const col = o.col ?? '#F6EFE6'
  const acc = o.acc ?? '#F2701F'
  const w = o.w ?? 64
  return (
    <svg width={w} height={w} viewBox="-34 -34 68 68" style={{ overflow: 'visible' }} aria-hidden="true">
      <polygon points={[0, 1, 2, 5, 9, 13, 17].map((i) => P[i]!.join(',')).join(' ')} fill={col} fillOpacity={0.12} />
      {BONES.map(([a, b], i) => (
        <line
          key={`u${i}`}
          x1={P[a]![0]}
          y1={P[a]![1]}
          x2={P[b]![0]}
          y2={P[b]![1]}
          stroke={col}
          strokeOpacity={0.16}
          strokeWidth={s * 0.32}
          strokeLinecap="round"
        />
      ))}
      {BONES.map(([a, b], i) => (
        <line key={`b${i}`} x1={P[a]![0]} y1={P[a]![1]} x2={P[b]![0]} y2={P[b]![1]} stroke={col} strokeWidth={1.8} strokeLinecap="round" />
      ))}
      {[4, 8, 12, 16, 20].map((i) => (
        <circle key={i} cx={P[i]![0]} cy={P[i]![1]} r={3.2} fill={(o.hot ?? []).includes(i) ? acc : col} />
      ))}
      {(o.extra ?? []).map((d, i) => (
        <path key={i} d={d} fill="none" stroke={acc} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  )
}

/** The design's poses for the shapes (glyph curls + options). */
export const SHAPE_POSE: Record<string, [number[], GlyphOpts]> = {
  fist: [[1, 1, 1, 1, 1], {}],
  pinch: [[0.5, 0.45, 0, 0, 0], { pinch: true, hot: [8], extra: ['M24 -6 v-22', 'M24 -28 l-5 6 M24 -28 l5 6'] }],
  peace: [[0.85, 0, 0, 1, 1], { hot: [8, 12] }],
  horns: [[0.85, 0, 1, 1, 0], { hot: [8, 20] }],
  point: [[0.85, 0, 1, 1, 1], { hot: [8], extra: ['M24 -30 v40', 'M24 -30 l-5 6 M24 -30 l5 6', 'M24 10 l-5 -6 M24 10 l5 -6'] }],
  point_down: [[0.85, 0, 1, 1, 1], { hot: [8], tilt: Math.PI, oy: -10, extra: ['M24 10 v-30', 'M24 10 l-5 -6 M24 10 l5 -6'] }],
  frame: [[0, 0, 1, 1, 1], { tilt: -0.25, hot: [4, 8], extra: ['M-30 -40 h22 M-30 -40 v18', 'M30 34 h-22 M30 34 v-18'] }],
  shaka: [[0, 1, 1, 1, 0], { hot: [4, 20] }],
}
