/**
 * The GUIDE's animated hand poses (S3, FoxBox 2.0): one small looping animation per step, wireframe hands in the
 * design's glyph style (a 12% palm, bones over a 16% underlay, fingertip dots, the active ones orange), moving as the
 * onboarding reference does (ease-out entrances, in-out draws, a little overshoot on a pop). One light canvas, no text.
 * Reduced motion: the move's start pose faint, its end pose, and an arrow between them (still).
 * ONE-HANDED (2.0.1, `hands={1}`): the two-hand moves with one hand. Its C reaches strands out (as PLAY draws one hand), its
 * L alone opens the frame after the hold ring fills (and lets it go the same way), and FLOW's filter is its thumb-index gap.
 */
import { useEffect, useRef } from 'react'

export type GuideMove =
  | 'c-pose' | 'pluck' | 'height' | 'twist' | 'shake' | 'point' | 'melody' | 'flow' | 'frame' | 'pinch' | 'frame-pinch' | 'flip' | 'record'
  | 'test-beat' | 'fist' | 'fold' | 'drop' | 'frame-glass' | 'shaka' | 'palm-tap'

type V = [number, number]
const W = 240 // the drawing's own units (3:2)
const H = 160
const INK = '246, 239, 230'
const ACC = '242, 112, 31'
const GLOW = '255, 122, 31'
const CREAM = '255, 241, 222'

const cl = (v: number) => Math.max(0, Math.min(1, v))
const lerp = (a: number, b: number, k: number) => a + (b - a) * k
const seg = (t: number, a: number, b: number) => cl((t - a) / (b - a))
const out3 = (k: number) => 1 - (1 - k) ** 3 // enter
const inOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2) // draw
const back = (k: number) => 1 + 2.70158 * (k - 1) ** 3 + 1.70158 * (k - 1) ** 2 // pop
const mixV = (a: V, b: V, k: number): V => [lerp(a[0], b[0], k), lerp(a[1], b[1], k)]
const rot = (a: number, [x, y]: V): V => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]

// ---------------------------------------------------------------------------------------------- the design's hand
const HAND: V[] = [[0, 0], [-0.35, -0.25], [-0.6, -0.5], [-0.78, -0.75], [-0.92, -0.98], [-0.28, -1], [-0.32, -1.45], [-0.34, -1.72], [-0.36, -1.98], [0, -1.05], [0, -1.55],
  [0, -1.85], [0, -2.12], [0.26, -0.98], [0.3, -1.42], [0.32, -1.7], [0.34, -1.94], [0.5, -0.85], [0.6, -1.2], [0.66, -1.42], [0.7, -1.62]]
const BONES: V[] = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17],
  [17, 18], [18, 19], [19, 20]]
// side on, curved into a C (the onboarding's), fingers pointing +x
const CPOSE: V[] = [[-0.3, 0.7], [0.05, 0.82], [0.34, 0.95], [0.62, 0.94], [0.86, 0.8], [0.12, -0.8], [0.52, -0.92], [0.83, -0.84], [1.04, -0.64], [0.04, -0.5], [0.48, -0.56],
  [0.8, -0.46], [1.04, -0.3], [0, -0.2], [0.43, -0.21], [0.73, -0.13], [0.96, 0], [0, 0.1], [0.37, 0.13], [0.6, 0.2], [0.8, 0.3]]
const TIPS = [4, 8, 12, 16, 20]

interface Front {
  x: number
  y: number
  s: number
  curls?: number[]
  tilt?: number
  /** the left hand: thumb on the other side */
  mirror?: boolean
  /** thumb and index tips meeting, 0-1 */
  pinch?: number
  /** a card turn about the hand's long axis (radians; past π/2 its back shows), through local x `turnAt` */
  turn?: number
  turnAt?: number
}
/** A hand from the front, fingers up (before `tilt`), its wrist at (x, y). */
function front(o: Front): V[] {
  const p = HAND.map(([x, y]) => [x, y] as V)
  for (let f = 0; f < 5; f++) {
    const b = 1 + f * 4
    const c = o.curls?.[f] ?? 0
    const base = f === 0 ? p[1]! : p[b]!
    for (let k = f === 0 ? 2 : 1; k < 4; k++) {
      const q = p[b + k]!
      q[0] = base[0] + (q[0] - base[0]) * (1 - 0.72 * c)
      q[1] = base[1] + (q[1] - base[1]) * (1 - 0.78 * c) + 0.32 * c * k
    }
  }
  if (o.pinch) {
    const m: V = [(p[4]![0] + p[8]![0]) / 2, (p[4]![1] + p[8]![1]) / 2]
    p[4] = mixV(p[4]!, [m[0] - 0.05, m[1]], o.pinch)
    p[8] = mixV(p[8]!, [m[0] + 0.05, m[1] - 0.04], o.pinch)
  }
  const cx = Math.cos(o.turn ?? 0)
  const ax = o.turnAt ?? 0
  return p.map(([x, y]) => {
    const [rx, ry] = rot(o.tilt ?? 0, [(ax + (x - ax) * cx) * (o.mirror ? -1 : 1), y])
    return [o.x + rx * o.s, o.y + ry * o.s]
  })
}
/** A hand side on in a C, its wrist at (x, y); `mirror`: fingers pointing left. `turn` 0-1: the good posture, the C
 *  turned ~30° toward the camera (so the folds show past the index). */
function sideC(x: number, y: number, s: number, mirror: boolean, curls: number[] = [], turn = 1): V[] {
  const p = CPOSE.map(([a, b]) => [a, b] as V)
  for (let f = 0; f < 5; f++) {
    const b = 1 + f * 4
    const c = curls[f] ?? 0
    const base = f === 0 ? p[2]! : p[b]!
    for (let k = f === 0 ? 2 : 1; k < 4; k++) {
      const q = p[b + k]!
      q[0] = base[0] + (q[0] - base[0]) * (1 - 0.62 * c)
      q[1] = lerp(q[1], base[1] * 0.6, 0.55 * c)
    }
  }
  // turned toward the camera it reads a little narrower (cos 30°), the turn's arrows saying which way
  const k = 1 - (1 - Math.cos(Math.PI / 6)) * turn
  return p.map(([a, b]) => [x + (mirror ? -a : a) * s * k, y + b * s] as V)
}

// ---------------------------------------------------------------------------------------------- drawing
interface G {
  c: CanvasRenderingContext2D
  t: number
  /** ONE-HANDED: the performer's right hand alone */
  one?: boolean
}
function hand(g: G, P: V[], s: number, hot: number[] = [], backSide = false) {
  const c = g.c
  c.lineCap = 'round'
  c.lineJoin = 'round'
  c.beginPath()
  ;[0, 1, 2, 5, 9, 13, 17].forEach((i, k) => (k ? c.lineTo(...P[i]!) : c.moveTo(...P[i]!)))
  c.closePath()
  c.fillStyle = `rgba(${INK}, ${backSide ? 0.05 : 0.12})`
  c.fill()
  for (const [w, style] of [[s * 0.32, `rgba(${INK}, 0.16)`], [Math.max(1.8, s * 0.07), `rgba(${INK}, ${backSide ? 0.55 : 1})`]] as const) {
    c.beginPath()
    for (const [a, b] of BONES) {
      c.moveTo(...P[a]!)
      c.lineTo(...P[b]!)
    }
    c.lineWidth = w
    c.strokeStyle = style
    c.stroke()
  }
  for (const i of TIPS) {
    c.beginPath()
    c.arc(P[i]![0], P[i]![1], Math.max(3.2, s * 0.12), 0, Math.PI * 2)
    c.fillStyle = hot.includes(i) ? `rgb(${ACC})` : `rgb(${INK})`
    c.fill()
  }
}
/** A string a → b, bowed `bow` (units) down, flashing `lit` 0-1; `cut` dashes it (REMIX's cut band); `white`: REMIX's. */
function string(g: G, a: V, b: V, o: { bow?: number; lit?: number; cut?: boolean; white?: boolean; draw?: number } = {}) {
  const c = g.c
  const k = o.draw ?? 1
  const end = mixV(a, b, k)
  const m: V = [(a[0] + end[0]) / 2, (a[1] + end[1]) / 2 + (o.bow ?? 0)]
  const path = () => {
    c.beginPath()
    c.moveTo(...a)
    c.quadraticCurveTo(m[0], m[1], end[0], end[1])
  }
  c.lineCap = 'round'
  if (o.cut) {
    path()
    c.setLineDash([2, 6])
    c.strokeStyle = 'rgba(255, 255, 255, 0.4)'
    c.lineWidth = 1.4
    c.stroke()
    c.setLineDash([])
    return
  }
  path()
  c.strokeStyle = `rgba(${GLOW}, ${0.22 + 0.6 * (o.lit ?? 0)})`
  c.lineWidth = o.white ? 4 : 6
  c.stroke()
  path()
  c.strokeStyle = o.white ? 'rgb(255, 255, 255)' : `rgb(${CREAM})`
  c.lineWidth = (o.white ? 1.1 : 1.6) + 1.6 * (o.lit ?? 0)
  c.stroke()
}
function arrow(g: G, a: V, b: V, alpha = 1) {
  const c = g.c
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0])
  c.strokeStyle = `rgba(${ACC}, ${alpha})`
  c.lineWidth = 2.4
  c.lineCap = 'round'
  c.lineJoin = 'round'
  c.beginPath()
  c.moveTo(...a)
  c.lineTo(...b)
  for (const s of [-1, 1]) {
    c.moveTo(...b)
    c.lineTo(b[0] - 7 * Math.cos(ang + s * 0.5), b[1] - 7 * Math.sin(ang + s * 0.5))
  }
  c.stroke()
}
/** A curved arrow round (x, y): from angle a0 to a1 (radians, clockwise on screen). */
function arc(g: G, x: number, y: number, r: number, a0: number, a1: number, alpha = 1) {
  const c = g.c
  c.strokeStyle = `rgba(${ACC}, ${alpha})`
  c.lineWidth = 2.4
  c.lineCap = 'round'
  c.beginPath()
  c.arc(x, y, r, Math.min(a0, a1), Math.max(a0, a1))
  c.stroke()
  const e: V = [x + r * Math.cos(a1), y + r * Math.sin(a1)]
  const tang = a1 + (a1 > a0 ? Math.PI / 2 : -Math.PI / 2)
  c.beginPath()
  for (const s of [-1, 1]) {
    c.moveTo(...e)
    c.lineTo(e[0] - 7 * Math.cos(tang + s * 0.5), e[1] - 7 * Math.sin(tang + s * 0.5))
  }
  c.stroke()
}

type PaneStyle = 'echo' | 'prism' | 'halftone' | 'slitscan'
/** ONE-HANDED's hold ring (the stage's holdRing.ts): a faint track, the accent filling clockwise from 12 o'clock. */
function holdRing(g: G, [x, y]: V, fill: number, alpha = 1) {
  if (fill <= 0 || alpha <= 0) return
  const c = g.c
  c.save()
  c.globalAlpha *= alpha
  c.lineWidth = 3
  c.lineCap = 'round'
  c.beginPath()
  c.arc(x, y, 13, 0, Math.PI * 2)
  c.strokeStyle = 'rgba(255, 255, 255, 0.18)'
  c.stroke()
  c.beginPath()
  c.arc(x, y, 13, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * fill)
  c.strokeStyle = `rgb(${ACC})`
  c.stroke()
  c.restore()
}

/** The frame's pane in quad q (clockwise from the top-left): its style, its edge drawn so far (0-1), bloomed (0-1). */
function pane(g: G, q: V[], style: PaneStyle, edge = 1, bloom = 1) {
  const c = g.c
  const ctr: V = [(q[0]![0] + q[2]![0]) / 2, (q[0]![1] + q[2]![1]) / 2]
  if (bloom > 0) {
    c.save()
    c.globalAlpha *= bloom
    c.beginPath()
    q.forEach((p, i) => {
      const s = mixV(ctr, p, 0.6 + 0.4 * bloom)
      if (i) c.lineTo(...s)
      else c.moveTo(...s)
    })
    c.closePath()
    c.clip()
    const [x0, y0] = [Math.min(...q.map((p) => p[0])), Math.min(...q.map((p) => p[1]))]
    const [x1, y1] = [Math.max(...q.map((p) => p[0])), Math.max(...q.map((p) => p[1]))]
    c.fillStyle = 'rgba(42, 33, 28, 0.85)'
    c.fillRect(x0, y0, x1 - x0, y1 - y0)
    if (style === 'echo') {
      c.lineWidth = 3
      for (let r = 4; r < 60; r += 9) {
        c.strokeStyle = `rgba(255, 150, 70, ${0.55 - r / 130})`
        c.beginPath()
        c.arc(ctr[0], ctr[1] + 4, r + ((g.t * 12) % 9), 0, Math.PI * 2)
        c.stroke()
      }
    } else if (style === 'prism') {
      const gr = c.createLinearGradient(x0, y0, x1, y1)
      ;['rgba(255,90,31,.75)', 'rgba(255,210,74,.7)', 'rgba(74,214,255,.65)', 'rgba(164,74,255,.7)'].forEach((s, i) => gr.addColorStop(i / 3, s))
      c.fillStyle = gr
      c.fillRect(x0, y0, x1 - x0, y1 - y0)
    } else if (style === 'halftone') {
      c.fillStyle = 'rgba(255, 178, 122, 0.85)'
      c.fillRect(x0, y0, x1 - x0, y1 - y0)
      c.fillStyle = 'rgba(20, 10, 6, 0.75)'
      for (let x = x0 + 4; x < x1; x += 8) for (let y = y0 + 4; y < y1; y += 8) {
        c.beginPath()
        c.arc(x, y, 2.4, 0, Math.PI * 2)
        c.fill()
      }
    } else {
      for (let x = x0; x < x1; x += 5) {
        c.fillStyle = `rgba(110, 190, 255, ${0.2 + 0.35 * Math.abs(Math.sin(x * 0.3 + g.t * 3))})`
        c.fillRect(x, y0, 4, y1 - y0)
      }
    }
    c.restore()
  }
  if (edge <= 0) return
  // the edge: white with an orange glow, drawn round from the top-left
  const len = q.map((p, i) => Math.hypot(q[(i + 1) % 4]![0] - p[0], q[(i + 1) % 4]![1] - p[1]))
  let left = edge * len.reduce((a, b) => a + b, 0)
  c.save()
  c.shadowColor = `rgba(${ACC}, 0.9)`
  c.shadowBlur = 10
  c.strokeStyle = '#FFFFFF'
  c.lineWidth = 1.8
  c.lineJoin = 'round'
  c.beginPath()
  c.moveTo(...q[0]!)
  for (let i = 0; i < 4 && left > 0; i++) {
    const k = Math.min(1, left / len[i]!)
    c.lineTo(...mixV(q[i]!, q[(i + 1) % 4]!, k))
    left -= len[i]!
  }
  c.stroke()
  c.restore()
}

/** The two L hands making a frame w x h at (cx, cy), tilted `th` (the onboarding's framePose); `turn` turns both over. */
function frameHands(cx: number, cy: number, w: number, h: number, th: number, s: number, turn = 0, curls: number[] = [0, 0, 1, 1, 1]) {
  const q = ([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as V[]).map((p) => {
    const r = rot(th, p)
    return [cx + r[0], cy + r[1]] as V
  })
  const crook: V = [0.45 * s, -0.75 * s]
  const lo = rot(th, crook)
  const ro = rot(th + Math.PI, crook)
  // each hand turns about its own corner, so the frame's corners stay put
  const L = front({ x: q[3]![0] - lo[0], y: q[3]![1] - lo[1], s, mirror: true, curls, tilt: th, turn, turnAt: -0.45 })
  const R = front({ x: q[1]![0] - ro[0], y: q[1]![1] - ro[1], s, mirror: true, curls: [0, 0, 1, 1, 1], tilt: th + Math.PI, turn, turnAt: -0.45 })
  return { q, L, R }
}
/** The quad narrowed across by |cos(turn)| about its middle (a card turning). */
function cardQuad(q: V[], turn: number): V[] {
  const ctr: V = [(q[0]![0] + q[2]![0]) / 2, (q[0]![1] + q[2]![1]) / 2]
  const u = [q[1]![0] - q[0]![0], q[1]![1] - q[0]![1]]
  const l = Math.hypot(u[0]!, u[1]!) || 1
  const [ux, uy] = [u[0]! / l, u[1]! / l]
  const k = 1 - Math.abs(Math.cos(turn))
  return q.map(([x, y]) => {
    const along = (x - ctr[0]) * ux + (y - ctr[1]) * uy
    return [x - ux * along * k, y - uy * along * k]
  })
}

// ---------------------------------------------------------------------------------------------- the moves
interface Move {
  /** the loop, seconds */
  period: number
  /** reduced motion: the start and end moments */
  still: [number, number]
  /** draws the move at t; returns where its motion is (the reduced arrow runs between the two) */
  draw(g: G, t: number): V
}
const S = 26 // a front hand's size
const SC = 30 // a side-on hand's size
const C_L = 62 // the C hands' wrists
const C_R = 178
const C_Y = 86
const C_ONE = 160 // the one C hand's wrist
const cTips = (P: V[]) => TIPS.map((i) => P[i]!)

/** Two C hands with strings between them; `curl(side, finger)` and a pluck's flash per string. */
function cHands(g: G, y: number, o: { curl?: (side: 0 | 1, f: number) => number; lit?: (f: number) => number; draw?: number; white?: boolean; cut?: (f: number) => boolean; turn?: number } = {}) {
  const curls = (s: 0 | 1) => [0, 1, 2, 3, 4].map((f) => o.curl?.(s, f) ?? 0)
  if (g.one) { // one hand: a short strand from each fingertip, reaching for the other hand
    const R = sideC(C_ONE, y, SC, true, curls(1), o.turn ?? 1)
    cTips(R).forEach((p, f) => string(g, p, [p[0] - 64, p[1] + (f - 2) * 4], { lit: o.lit?.(f) ?? 0, bow: 1 + 4 * (o.lit?.(f) ?? 0), draw: 0.75 * (o.draw ?? 1), white: o.white, cut: o.cut?.(f) }))
    hand(g, R, SC * 0.9, TIPS.filter((_, f) => (o.curl?.(1, f) ?? 0) > 0.3))
    return { L: R, R }
  }
  const L = sideC(C_L, y, SC, false, curls(0), o.turn ?? 1)
  const R = sideC(C_R, y, SC, true, curls(1), o.turn ?? 1)
  const [a, b] = [cTips(L), cTips(R)]
  a.forEach((p, f) => string(g, p, b[f]!, { lit: o.lit?.(f) ?? 0, bow: 2 + 6 * (o.lit?.(f) ?? 0), draw: o.draw ?? 1, white: o.white, cut: o.cut?.(f) }))
  const hot = (s: 0 | 1) => TIPS.filter((_, f) => (o.curl?.(s, f) ?? 0) > 0.3)
  hand(g, L, SC * 0.9, hot(0))
  hand(g, R, SC * 0.9, hot(1))
  return { L, R }
}
const pulse = (t: number, at: number, up = 0.12, down = 0.32) => (t < at - up ? 0 : t < at ? (t - (at - up)) / up : cl(1 - (t - at) / down))

const MOVES: Record<GuideMove, Move> = {
  'c-pose': {
    period: 3.8, still: [0.05, 2.6],
    draw(g, t) {
      const rise = out3(seg(t, 0, 0.9))
      const turn = inOut(seg(t, 0.9, 1.4)) // turned a little toward the camera: the folds show
      const fade = 1 - seg(t, 3.4, 3.8)
      g.c.globalAlpha *= fade
      const y = lerp(H + 40, C_Y, rise)
      cHands(g, y, { draw: inOut(seg(t, 1.4, 2.0)), turn })
      const show = seg(t, 0.85, 1.0) * (1 - seg(t, 1.5, 1.7))
      const arcs = g.one ? ([[C_ONE, -0.74, -1.84]] as const) : ([[C_L, -2.4, -1.3], [C_R, -0.74, -1.84]] as const)
      if (show > 0) for (const [x, a0, a1] of arcs) arc(g, x, y - 6, 34, a0, a1, show)
      return [W / 2, y]
    },
  },
  pluck: {
    period: 2.5, still: [0, 0.12],
    draw(g, t) {
      const f = Math.floor(t / 0.5) % 5
      const side = (g.one ? 1 : Math.floor(t / 0.5) % 2) as 0 | 1
      const k = pulse(t % 0.5, 0.12)
      const { L, R } = cHands(g, C_Y, { curl: (s, i) => (s === side && i === f ? k : 0), lit: (i) => (i === f ? k : 0) })
      return (side ? R : L)[TIPS[f]!]!
    },
  },
  height: {
    period: 4, still: [0.3, 2.3],
    draw(g, t) {
      const steps = [0, 2, 4, 1, 3]
      const at = (i: number) => 128 - steps[i % 5]! * 22
      const i = Math.floor(t / 0.8)
      const y = lerp(at(i), at(i + 1), inOut(seg(t % 0.8, 0.45, 0.8)))
      for (let n = 0; n < 5; n++) { // the notes' ladder
        const ny = 128 - n * 22 - 18
        const on = Math.abs(ny - (y - 18)) < 6
        g.c.beginPath()
        g.c.arc(56, ny, on ? 5 : 3.5, 0, Math.PI * 2)
        g.c.fillStyle = on ? `rgb(${ACC})` : `rgba(${INK}, 0.3)`
        g.c.fill()
      }
      hand(g, sideC(130, y, SC, true), SC * 0.9)
      return [130, y - 18]
    },
  },
  twist: {
    period: 2.8, still: [0.7, 2.1],
    draw(g, t) {
      const tilt = 0.45 * Math.sin((t / 2.8) * Math.PI * 2)
      const P = front({ x: W / 2, y: 140, s: S, tilt })
      hand(g, P, S, [12])
      const dir = Math.cos((t / 2.8) * Math.PI * 2) >= 0 ? 1 : -1 // the way it's turning
      arc(g, W / 2, 140, 72, -Math.PI / 2 - 0.35 * dir, -Math.PI / 2 + 0.35 * dir, 0.8)
      return P[12]!
    },
  },
  shake: {
    period: 2.2, still: [0.1, 0.9],
    draw(g, t) {
      const k = seg(t, 0.3, 0.45) * (1 - seg(t, 1.5, 1.65))
      const dx = k * 4 * Math.sin(t * Math.PI * 2 * 7)
      const P = front({ x: W / 2 + dx, y: 140, s: S, tilt: dx * 0.01 })
      hand(g, P, S)
      if (k > 0.1) for (const sgn of [-1, 1]) for (let n = 0; n < 3; n++) { // the tremble's lines
        const x = W / 2 + sgn * (44 + n * 7)
        g.c.strokeStyle = `rgba(${ACC}, ${k * (0.9 - n * 0.25)})`
        g.c.lineWidth = 2
        g.c.beginPath()
        g.c.moveTo(x, 70 + n * 4)
        g.c.lineTo(x, 100 - n * 4)
        g.c.stroke()
      }
      return [W / 2 + (t > 0.5 ? 6 : 0), 90]
    },
  },
  point: {
    period: 3.4, still: [0.6, 2.3],
    draw(g, t) {
      const down = inOut(seg(t, 1.45, 1.75)) * (1 - inOut(seg(t, 3.1, 3.4)))
      const y = lerp(118, 46, down)
      const P = front({ x: W / 2 - 20, y, s: S, curls: [0.85, 0, 1, 1, 1], tilt: Math.PI * down })
      hand(g, P, S, [8])
      const tip = P[8]!
      const up = down < 0.5
      const show = up ? seg(t, 0.2, 0.5) * (1 - seg(t, 1.3, 1.45)) : seg(t, 1.9, 2.2) * (1 - seg(t, 2.9, 3.1))
      if (show > 0) arrow(g, [W / 2 + 34, up ? 100 : 54], [W / 2 + 34, up ? 54 : 100], show)
      return tip
    },
  },
  melody: {
    period: 4, still: [0, 0.62],
    draw(g, t) {
      const n = Math.floor(t / 0.5)
      const k = pulse(t % 0.5, 0.12)
      const heights = [10, 18, 14, 22, 8, 20, 12, 16]
      heights.forEach((h, i) => { // the melody's 8 notes, the next one orange (FOLLOW)
        const x = 70 + i * 13
        g.c.fillStyle = i === n % 8 ? `rgba(${ACC}, ${0.6 + 0.4 * k})` : i < n % 8 ? `rgba(${INK}, 0.55)` : `rgba(${INK}, 0.2)`
        g.c.beginPath()
        g.c.roundRect(x, 34 - h, 8, h, 3)
        g.c.fill()
      })
      const f = (n * 3 + 1) % 5
      const side = (g.one ? 1 : n % 2) as 0 | 1
      cHands(g, C_Y + 14, { curl: (s, i) => (s === side && i === f ? k : 0), lit: (i) => (i === f ? k : 0) })
      return [70 + (n % 8) * 13 + 4, 20]
    },
  },
  flow: {
    period: 3.6, still: [0.3, 1.5],
    draw(g, t) {
      const mute = seg(t, 2.6, 2.75) * (1 - seg(t, 3.3, 3.45))
      const y = 96 - 34 * Math.sin((Math.min(t, 2.6) / 2.6) * Math.PI * 2)
      if (g.one) { // its height the pitch, its thumb-index gap the filter (open: bright), a fist mutes
        const gap = 0.5 + 0.5 * Math.cos(t * 4.8)
        const R = front({ x: 160, y: y + 26, s: S, curls: mute > 0.5 ? [1, 1, 1, 1, 1] : [0.3 * (1 - gap), 0.3 * (1 - gap), 0.6, 0.6, 0.6], pinch: mute > 0.5 ? 0 : 1 - gap })
        string(g, R[9]!, [R[9]![0] - 110, R[9]![1] + 4], { bow: -(96 - y) * 0.6, lit: 0.1 + 0.7 * gap, cut: mute > 0.5, draw: 0.85 })
        hand(g, R, S, mute > 0.5 ? [] : [4, 8])
        return R[8]!
      }
      const L = sideC(C_L, C_Y + 6, SC, false)
      const R = mute > 0.5 ? front({ x: C_R, y: y + 30, s: S, curls: [1, 1, 1, 1, 1] }) : sideC(C_R, y, SC, true)
      const a = L[9]!
      const b = R[9]!
      string(g, a, b, { bow: -(96 - y) * 0.6, lit: 0.3, cut: mute > 0.5 })
      hand(g, L, SC * 0.9)
      hand(g, R, mute > 0.5 ? S : SC * 0.9, mute > 0.5 ? [] : [12])
      return b
    },
  },
  frame: {
    period: 3.6, still: [0, 2.2],
    draw(g, t) {
      const k = g.one ? 1 : inOut(seg(t, 0, 0.9)) * (1 - inOut(seg(t, 3.1, 3.6)))
      const th = 0.06 * Math.sin(t * 1.3)
      const F = frameHands(W / 2, H / 2 + 6, lerp(60, 110, k), lerp(40, 74, k), th, 22)
      pane(g, F.q, 'echo', seg(t, 0.9, 1.35) * (1 - seg(t, 3.1, 3.2)), out3(seg(t, 1.15, 1.85)) * (1 - seg(t, 3.0, 3.3)))
      g.c.save()
      if (g.one) g.c.globalAlpha *= seg(t, 0, 0.3) * (1 - seg(t, 3.1, 3.6))
      hand(g, F.L, 22, [4, 8])
      if (!g.one) hand(g, F.R, 22, [4, 8])
      g.c.restore()
      if (g.one) holdRing(g, F.q[3]!, seg(t, 0.3, 0.9), 1 - seg(t, 0.9, 1.1)) // one L held: the ring, then the pane
      return F.q[3]!
    },
  },
  pinch: {
    period: 3.2, still: [0.5, 1.9],
    draw(g, t) {
      const k = inOut(seg(t, 0.1, 0.4)) * (1 - inOut(seg(t, 2.8, 3.1)))
      const rise = inOut(seg(t, 0.6, 1.9)) * (1 - inOut(seg(t, 2.2, 2.8)))
      const y = lerp(150, 110, rise)
      const P = front({ x: 96, y, s: S, curls: [0.5 * k, 0.45 * k, 0, 0, 0], pinch: k })
      hand(g, P, S, k > 0.5 ? [4, 8] : [])
      // the wobble, faster as the pinch rises
      g.c.strokeStyle = `rgba(${ACC}, ${0.3 + 0.6 * k})`
      g.c.lineWidth = 2
      g.c.beginPath()
      for (let x = 0; x <= 70; x += 2) {
        const yy = 80 + 10 * k * Math.sin(x * (0.15 + 0.25 * rise) - t * 8)
        if (x) g.c.lineTo(150 + x, yy)
        else g.c.moveTo(150 + x, yy)
      }
      g.c.stroke()
      return P[8]!
    },
  },
  'frame-pinch': {
    period: 3.2, still: [0.5, 1.2],
    draw(g, t) {
      const taps = [0.8, 2.2]
      const tap = Math.max(...taps.map((a) => pulse(t, a, 0.1, 0.2)))
      const n = taps.filter((a) => t > a).length
      const F = frameHands(W / 2, H / 2 + 6, 110, 74, 0.05 * Math.sin(t * 1.3), 22, 0, [tap * 0.6, tap * 0.4, 1, 1, 1])
      const styles: PaneStyle[] = ['echo', 'prism', 'halftone']
      pane(g, F.q, styles[n % 3]!)
      if (t - Math.max(...taps.filter((a) => t > a), -9) < 0.3) { // the new style wipes out from the middle
        const k = (t - Math.max(...taps.filter((a) => t > a))) / 0.3
        g.c.save()
        g.c.globalAlpha *= 1 - k
        pane(g, F.q, styles[(n + 2) % 3]!, 0)
        g.c.restore()
      }
      hand(g, F.L, 22, tap > 0.3 ? [4, 8] : [8])
      if (!g.one) hand(g, F.R, 22, [4, 8])
      return F.L[8]!
    },
  },
  flip: {
    period: 4.4, still: [0.4, 2.2],
    draw(g, t) {
      const turn = Math.PI * (inOut(seg(t, 1.0, 1.6)) - inOut(seg(t, 2.8, 3.4)))
      const F = frameHands(W / 2, H / 2 + 6, 110, 74, 0.04 * Math.sin(t * 1.3), 22, turn)
      pane(g, cardQuad(F.q, turn), Math.cos(turn) >= 0 ? 'echo' : 'slitscan')
      const backSide = Math.cos(turn) < 0
      hand(g, F.L, 22, [4, 8], backSide)
      if (!g.one) hand(g, F.R, 22, [4, 8], backSide)
      if (t > 0.6 && t < 1.0) arc(g, W / 2, H / 2 + 6, 70, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5, (t - 0.6) / 0.4)
      return [W / 2 + 40 * Math.cos(turn), H / 2]
    },
  },
  record: {
    period: 2.6, still: [0.1, 1.2],
    draw(g, t) {
      const on = out3(seg(t, 0.4, 0.7)) * (1 - out3(seg(t, 2.0, 2.3)))
      const c = g.c
      c.beginPath()
      c.arc(W / 2, H / 2, 30, 0, Math.PI * 2)
      c.fillStyle = `rgba(${INK}, 0.08)`
      c.fill()
      c.strokeStyle = `rgba(${INK}, 0.25)`
      c.lineWidth = 1.5
      c.stroke()
      if (on > 0) { // the ring while it records
        c.beginPath()
        c.arc(W / 2, H / 2, 36 + 3 * Math.sin(t * 6), -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * seg(t, 0.7, 2.0))
        c.strokeStyle = `rgba(229, 64, 43, ${on})`
        c.lineWidth = 2.5
        c.stroke()
      }
      const r = lerp(12, 8, on)
      c.beginPath()
      c.roundRect(W / 2 - r, H / 2 - r, 2 * r, 2 * r, lerp(r, 3, on))
      c.fillStyle = 'rgb(229, 64, 43)'
      c.fill()
      return [W / 2, H / 2]
    },
  },
  'test-beat': {
    period: 2, still: [0.05, 0.55],
    draw(g, t) {
      const beat = Math.floor(t / 0.5)
      const k = 1 - seg(t % 0.5, 0, 0.35)
      for (let i = 0; i < 4; i++) {
        g.c.beginPath()
        g.c.arc(W / 2 - 36 + i * 24, 46, i === beat ? 6 + 2 * k : 5, 0, Math.PI * 2)
        g.c.fillStyle = i === beat ? `rgba(${ACC}, ${0.5 + 0.5 * k})` : `rgba(${INK}, 0.25)`
        g.c.fill()
      }
      // a strip of the waveform scrolling under a playhead
      g.c.fillStyle = 'rgba(255, 140, 70, 0.55)'
      for (let x = 30; x < W - 30; x += 4) {
        const h = 6 + 14 * Math.abs(Math.sin((x + t * 60) * 0.09) * Math.sin((x + t * 60) * 0.023))
        g.c.fillRect(x, 104 - h, 2.5, 2 * h)
      }
      g.c.fillStyle = '#FFFFFF'
      g.c.fillRect(W * 0.38, 80, 2, 48)
      return [W / 2 - 36 + beat * 24, 46]
    },
  },
  fist: {
    period: 3.2, still: [0.2, 2.1],
    draw(g, t) {
      const k = back(seg(t, 0.35, 0.7)) * (1 - inOut(seg(t, 2.7, 3.0)))
      const rise = inOut(seg(t, 0.9, 2.1)) * (1 - inOut(seg(t, 2.4, 2.9)))
      const y = lerp(140, 108, rise)
      const P = front({ x: 100, y, s: S, curls: [k, k, k, k, k].map((v) => Math.min(1, v)) })
      hand(g, P, S, k > 0.5 ? [8] : [])
      for (let i = 0; i < 4; i++) { // TEAROUT on the beat: deeper as it rises
        const on = 1 - seg(t % 0.5, 0, 0.3)
        const hgt = (10 + 30 * rise) * (i === Math.floor(t / 0.5) % 4 ? 0.6 + 0.4 * on : 0.5)
        g.c.fillStyle = `rgba(${ACC}, ${k > 0.5 ? 0.8 : 0.2})`
        g.c.beginPath()
        g.c.roundRect(158 + i * 14, 110 - hgt, 9, hgt, 4)
        g.c.fill()
      }
      return [100, y - 30]
    },
  },
  fold: {
    period: 3.6, still: [0.3, 1.6],
    draw(g, t) {
      const k = inOut(seg(t, 0.6, 0.9)) * (1 - inOut(seg(t, 2.5, 2.8)))
      const { R } = cHands(g, C_Y, { white: true, curl: (s, f) => (s === 1 && f === 2 ? k : 0), cut: (f) => f === 2 && k > 0.6 })
      return R[12]!
    },
  },
  drop: {
    period: 3.4, still: [0.5, 1.6],
    draw(g, t) {
      const chips: [number, number, boolean][] = [[24, 36, false], [62, 58, false], [124, 52, true], [180, 38, false]] // x, width, the drop
      const press = pulse(t, 1.2, 0.08, 0.25)
      const jump = out3(seg(t, 1.25, 1.5))
      const px = t < 1.25 ? lerp(70, 112, t / 1.25) : lerp(112, 126, jump) + (t - 1.5 > 0 ? (t - 1.5) * 12 : 0)
      chips.forEach(([x, w, drop]) => {
        const hot = drop && t > 1.15
        g.c.fillStyle = hot ? `rgba(${ACC}, ${0.85 - 0.3 * press})` : 'rgba(20, 12, 8, 0.75)'
        g.c.beginPath()
        g.c.roundRect(x, 40, w * (drop ? 1 - 0.03 * press : 1), 14, 7)
        g.c.fill()
        g.c.strokeStyle = `rgba(${INK}, 0.3)`
        g.c.lineWidth = 1
        g.c.stroke()
      })
      g.c.fillStyle = 'rgba(255, 140, 70, 0.55)'
      for (let x = 24; x < 218; x += 4) {
        const loud = x >= 124 && x < 176 ? 1 : 0.45
        const h = (5 + 18 * loud) * (0.6 + 0.4 * Math.abs(Math.sin(x * 0.21)))
        g.c.fillRect(x, 104 - h, 2.5, 2 * h)
      }
      g.c.fillStyle = '#FFFFFF'
      g.c.fillRect(px, 70, 2, 64)
      return [px, 72]
    },
  },
  'frame-glass': {
    period: 5.2, still: [0.2, 3.4],
    draw(g, t) {
      const form = g.one ? 1 : inOut(seg(t, 0, 0.8)) // one hand holds its L where it is (the ring), not apart
      const tap = pulse(t, 2.0, 0.1, 0.2)
      const turn = Math.PI * inOut(seg(t, 2.6, 3.2))
      const gone = seg(t, 4.0, 4.6)
      const th = 0.05 * Math.sin(t * 1.3)
      const apart = g.one ? 0 : inOut(seg(t, 3.9, 4.6)) // one hand lets go by holding the L again (the ring)
      const F = frameHands(W / 2, H / 2 + 6, lerp(60, 110, form) + 50 * apart, lerp(40, 74, form) + 30 * apart, th, 22, turn, [tap * 0.6, tap * 0.4, 1, 1, 1])
      if (gone <= 0) pane(g, cardQuad(F.q, turn), Math.cos(turn) < 0 ? 'slitscan' : t > 2.0 ? 'prism' : 'echo', seg(t, 0.8, 1.2), out3(seg(t, 1.0, 1.6)))
      else { // letting go: it shatters
        const ctr: V = [W / 2, H / 2 + 6]
        const q = frameHands(W / 2, H / 2 + 6, 110, 74, th, 22).q // the pane as it was held
        const mid = (a: V, b: V): V => mixV(a, b, 0.5)
        const tris: V[][] = [[q[0]!, mid(q[0]!, q[1]!), ctr], [mid(q[0]!, q[1]!), q[1]!, ctr], [q[1]!, mid(q[1]!, q[2]!), ctr], [mid(q[1]!, q[2]!), q[2]!, ctr],
          [q[2]!, mid(q[2]!, q[3]!), ctr], [mid(q[2]!, q[3]!), q[3]!, ctr], [q[3]!, mid(q[3]!, q[0]!), ctr], [mid(q[3]!, q[0]!), q[0]!, ctr]]
        tris.forEach((tri, i) => {
          const c0: V = [(tri[0]![0] + tri[1]![0] + tri[2]![0]) / 3, (tri[0]![1] + tri[1]![1] + tri[2]![1]) / 3]
          const d: V = [(c0[0] - ctr[0]) * 1.6 * out3(gone), (c0[1] - ctr[1]) * 1.6 * out3(gone) + 40 * gone * gone]
          const a = (i % 2 ? 1 : -1) * 1.2 * gone
          g.c.save()
          g.c.globalAlpha *= 1 - gone
          g.c.beginPath()
          tri.forEach((p, j) => {
            const r = rot(a, [p[0] - c0[0], p[1] - c0[1]])
            const x = c0[0] + r[0] + d[0]
            const y = c0[1] + r[1] + d[1]
            if (j) g.c.lineTo(x, y)
            else g.c.moveTo(x, y)
          })
          g.c.closePath()
          g.c.fillStyle = 'rgba(110, 190, 255, 0.45)'
          g.c.fill()
          g.c.strokeStyle = '#FFFFFF'
          g.c.lineWidth = 1.2
          g.c.stroke()
          g.c.restore()
        })
      }
      const backSide = Math.cos(turn) < 0
      g.c.save()
      g.c.globalAlpha *= 1 - seg(t, 4.6, 5.2)
      hand(g, F.L, 22, tap > 0.3 ? [4, 8] : [8], backSide)
      if (!g.one) hand(g, F.R, 22, [4, 8], backSide)
      g.c.restore()
      if (g.one) holdRing(g, F.q[3]!, t < 2 ? seg(t, 0.2, 0.75) : seg(t, 3.45, 3.95), t < 2 ? 1 - seg(t, 0.75, 0.9) : 1 - seg(t, 3.95, 4.1))
      return [W / 2 + 40 * Math.cos(turn), H / 2]
    },
  },
  // PALM (2.1): an open palm to the camera taps down fast (the wrist flexing ≤ 25°, so the fingers foreshorten), stops
  // (the note: a pulse at the palm, its fingertips lit), then rebounds; S1's detector fires at the stop
  'palm-tap': {
    period: 2, still: [0.3, 0.74],
    draw(g, t) {
      const down = seg(t, 0.6, 0.72) ** 2 // accelerating into the tap
      const up = out3(seg(t, 0.82, 1.15)) // the rebound
      const k = down * (1 - up)
      const hit = t >= 0.72 && t < 1.15 ? 1 - seg(t, 0.72, 1.15) : 0
      const P0 = front({ x: W / 2, y: 128 + 16 * k, s: S, curls: [0, 0, 0, 0, 0] })
      const wrist = P0[0]!
      const flex = 1 - 0.18 * k // ~25° of flex: the hand foreshortens toward the camera
      const P = P0.map(([x, y]): V => [x, wrist[1] + (y - wrist[1]) * flex])
      if (down > 0.15 && down < 1) for (const dx of [-30, 30]) arrow(g, [W / 2 + dx, 30 + 8 * down], [W / 2 + dx, 46 + 8 * down], 0.5) // the strike's speed
      if (hit > 0) { // the note: a pulse at the palm
        const c = P[9]!
        g.c.beginPath()
        g.c.arc(c[0], c[1], 14 + 26 * (1 - hit), 0, Math.PI * 2)
        g.c.strokeStyle = `rgba(${ACC}, ${0.8 * hit})`
        g.c.lineWidth = 2.5
        g.c.stroke()
      }
      hand(g, P, S, hit > 0.3 ? TIPS : [])
      return P[12]!
    },
  },
  shaka: {
    period: 3.6, still: [0.1, 1.9],
    draw(g, t) {
      const k = back(seg(t, 0.3, 0.6)) * (1 - inOut(seg(t, 3.1, 3.5)))
      const fill = seg(t, 0.6, 1.1)
      const dome = out3(seg(t, 1.1, 1.9)) * (1 - seg(t, 3.0, 3.4))
      for (let i = 0; i < 9; i++) { // the library's half dome of sleeves
        const a = Math.PI * (0.1 + (0.8 * i) / 8)
        const r = 70
        const x = W / 2 - Math.cos(a) * r
        const y = 120 - Math.sin(a) * r * dome
        g.c.save()
        g.c.globalAlpha *= dome * (i === 4 ? 1 : 0.6)
        g.c.translate(x, y)
        g.c.rotate(-Math.cos(a) * 0.6)
        g.c.fillStyle = i === 4 ? `rgba(${ACC}, 0.9)` : `rgba(${INK}, 0.35)`
        g.c.fillRect(-7, -7, 14, 14)
        g.c.restore()
      }
      const c = Math.min(1, k)
      const P = front({ x: W / 2, y: 150, s: S, curls: [0, c, c, c, 0] })
      hand(g, P, S, c > 0.5 ? [4, 20] : [])
      if (fill > 0 && dome < 1) { // hold to fill the ring
        g.c.strokeStyle = `rgba(${ACC}, 0.9)`
        g.c.lineWidth = 3
        g.c.beginPath()
        g.c.arc(W / 2, 112, 40, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * fill)
        g.c.stroke()
      }
      return [W / 2, 60]
    },
  },
}
export const GUIDE_MOVES = Object.keys(MOVES) as GuideMove[]

/** Draws `move` at loop time `t` (seconds; null: its reduced-motion still) into a W x H-unit context. */
export function drawGuideMove(c: CanvasRenderingContext2D, move: GuideMove, t: number | null, hands: 1 | 2 = 2): void {
  const m = MOVES[move]
  const one = hands === 1
  c.clearRect(0, 0, W, H)
  if (t !== null) {
    c.save()
    m.draw({ c, t: t % m.period, one }, t % m.period)
    c.restore()
    return
  }
  c.save()
  c.globalAlpha = 0.35
  const a = m.draw({ c, t: m.still[0], one }, m.still[0])
  c.restore()
  c.save()
  const b = m.draw({ c, t: m.still[1], one }, m.still[1])
  c.restore()
  const d = Math.hypot(b[0] - a[0], b[1] - a[1])
  const g = { c, t: 0 }
  if (d > 14) arrow(g, mixV(a, b, 0.15), mixV(a, b, 0.85))
  else arc(g, b[0], b[1], 14, -Math.PI * 0.9, -Math.PI * 0.2)
}

/** One step's animation (decorative: the step's words say it), `width` px wide (3:2); `hands={1}`: ONE-HANDED's. */
export function GuideHands({ move, width = 240, className, hands = 2 }: { move: GuideMove; width?: number; className?: string; hands?: 1 | 2 }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const c = canvas?.getContext('2d')
    if (!canvas || !c) return
    const dpr = window.devicePixelRatio || 1
    Object.assign(canvas, { width: Math.round(width * dpr), height: Math.round((width * H * dpr) / W) })
    c.setTransform((width * dpr) / W, 0, 0, (width * dpr) / W, 0, 0)
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      drawGuideMove(c, move, null, hands)
      return
    }
    const t0 = performance.now()
    let raf = 0
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      drawGuideMove(c, move, (now - t0) / 1000, hands)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [move, width, hands])
  return <canvas ref={ref} className={className} aria-hidden="true" style={{ width, height: (width * H) / W }} />
}
