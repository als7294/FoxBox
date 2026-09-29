/**
 * The face encryption styles beyond MOSAIC / BLUR / SOLID (1.5): GLITCH, ASCII, REDACTED, LOW-POLY, FOX MASK,
 * STATIC, HALFTONE and THERMAL VOID. Live and in clips they're drawn by the same code (compose.maskRegion).
 *
 * All of them are irreversible, by construction. The face is first reduced to a grid no finer than MOSAIC's at the
 * same strength (at most 16 cells across; the privacy floor), and a style draws only from that grid. REDACTED and
 * STATIC use no picture at all; FOX MASK is a face mask (faceMask.ts) with a rim of that grid round its edge. Nothing
 * is a light filter over the real face.
 *
 * Each can move with the music: `pulse` (0-1, a stem's level and hits, chosen in the MASK panel) drives the glitch's
 * rate, the dots, the static, the stamp and the mask.
 */
import { theme } from '@/visuals/theme'
import { clamp01, heat, permutation, rng, smoothstep, type HeadPose } from './camMath'
import { drawFaceMask, headFrame, maskReady, rigFace } from './faceMask'
import { LOWFOX_COLORS, LOWFOX_PALETTE, LOWFOX_SKIRT_COLORS, LOWFOX_TRIS, LOWPOLY_RING, LOWPOLY_TRIS } from './faceMeshData'
import type { FaceShapes } from './vision'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** What a style may use beyond the picture: time, the beat, a stable seed per face, and the head when it's known. */
export interface StyleFx {
  /** Seconds (for animation). */
  t: number
  /** 0-1 from the chosen stem. */
  pulse: number
  /** Stable per face (the glitch pattern and low-poly grid don't jump between faces). */
  seed: number
  pose?: HeadPose | null
  /** The face mesh on the canvas when the landmarker is running (smoothed): x, y, z per point, px (z smaller is
   *  nearer). LOW-POLY is built on it and a face mask is drawn on it. */
  mesh?: Float32Array | null
  /** The expression (blendshapes), when the landmarker is running. */
  shapes?: FaceShapes | null
  /** 0-1: a face the landmarker has just lost fades out (the mesh-drawn styles), instead of a box. */
  alpha?: number
}

export type StyleName = 'glitch' | 'ascii' | 'redacted' | 'lowpoly' | 'depthglitch' | 'fox' | 'static' | 'halftone' | 'thermal'

interface Grid {
  cols: number
  rows: number
  px: Uint8ClampedArray
}

let sampler: CanvasRenderingContext2D | null = null
/** The last grid, and the video frame and box it sampled (the sampler canvas still holds it). */
let last: { source: CanvasImageSource; key: string; grid: Grid } | null = null

/** The face as a cols×rows grid of averaged colours: all an image style ever sees of it. */
function grid(source: CanvasImageSource, src: Rect, cols: number, rows: number): Grid | null {
  if (!sampler) {
    const c = document.createElement('canvas')
    sampler = c.getContext('2d', { willReadFrequently: true })
  }
  const g = sampler
  if (!g) return null
  cols = Math.max(2, Math.min(16, Math.round(cols)))
  rows = Math.max(2, Math.min(24, Math.round(rows)))
  // The camera brings 30 frames a second and the stage draws 60-120: the same frame and box reuse the last grid (a
  // downscale in software, ~2-4 ms, that FOX's rim paid on every stage frame).
  const key =
    source instanceof HTMLVideoElement
      ? [source.currentTime, Math.round(src.x), Math.round(src.y), Math.round(src.w), Math.round(src.h), cols, rows].join()
      : ''
  if (key && last?.source === source && last.key === key) return last.grid
  if (g.canvas.width !== cols || g.canvas.height !== rows) {
    g.canvas.width = cols
    g.canvas.height = rows
  }
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  g.drawImage(source, src.x, src.y, src.w, src.h, 0, 0, cols, rows)
  last = { source, key, grid: { cols, rows, px: g.getImageData(0, 0, cols, rows).data } }
  return last.grid
}

const luma = (px: Uint8ClampedArray, i: number): number => (0.2126 * px[i * 4]! + 0.7152 * px[i * 4 + 1]! + 0.0722 * px[i * 4 + 2]!) / 255
const rgb = (px: Uint8ClampedArray, i: number): string => `rgb(${px[i * 4]},${px[i * 4 + 1]},${px[i * 4 + 2]})`

/** Luma stretched to the face's own range, so a dim face still reads. */
function lumas(g: Grid): Float32Array {
  const n = g.cols * g.rows
  const v = new Float32Array(n)
  let lo = 1
  let hi = 0
  for (let i = 0; i < n; i++) {
    v[i] = luma(g.px, i)
    lo = Math.min(lo, v[i]!)
    hi = Math.max(hi, v[i]!)
  }
  const span = hi - lo || 1
  for (let i = 0; i < n; i++) v[i] = (v[i]! - lo) / span
  return v
}

const rowsFor = (cols: number, d: Rect, cellAspect = 1): number => Math.round(cols * (d.h / d.w) * cellAspect)

// ------------------------------------------------------------------------------------------------ the styles

function glitch(ctx: CanvasRenderingContext2D, source: CanvasImageSource, src: Rect, d: Rect, cols: number, fx: StyleFx): void {
  const g = grid(source, src, cols, rowsFor(cols, d))
  if (!g) return
  const n = g.cols * g.rows
  // Reshuffled a few times a second, faster on the beat.
  const tick = Math.floor(fx.t * (3 + 18 * fx.pulse))
  const perm = permutation(n, fx.seed ^ (tick * 2654435761))
  const cw = d.w / g.cols
  const ch = d.h / g.rows
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = rgb(g.px, perm[i]!)
    ctx.fillRect(d.x + (i % g.cols) * cw, d.y + Math.floor(i / g.cols) * ch, Math.ceil(cw), Math.ceil(ch))
  }
  // Torn scanlines and colour fringes (over the scrambled cells only).
  const r = rng(fx.seed + tick)
  ctx.save()
  ctx.beginPath()
  ctx.rect(d.x, d.y, d.w, d.h)
  ctx.clip()
  const slices = 2 + Math.round(4 * fx.pulse)
  for (let k = 0; k < slices; k++) {
    const y = d.y + r() * d.h
    const h = ch * (0.25 + r() * 0.9)
    const shift = (r() - 0.5) * d.w * (0.25 + 0.35 * fx.pulse)
    ctx.drawImage(ctx.canvas, d.x, y, d.w, h, d.x + shift, y, d.w, h)
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = 0.18 + 0.2 * fx.pulse
    ctx.fillStyle = k % 2 ? '#00e5ff' : '#ff2bd6'
    ctx.fillRect(d.x, y, d.w, h * 0.5)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
  }
  ctx.restore()
}

const RAMP = ' .:-=+*#%@'

function ascii(ctx: CanvasRenderingContext2D, source: CanvasImageSource, src: Rect, d: Rect, cols: number, fx: StyleFx): void {
  // Characters are about twice as tall as wide: half as many rows.
  const g = grid(source, src, cols, Math.max(2, rowsFor(cols, d, 0.55)))
  if (!g) return
  const v = lumas(g)
  const cw = d.w / g.cols
  const ch = d.h / g.rows
  ctx.fillStyle = '#040806'
  ctx.fillRect(d.x, d.y, d.w, d.h)
  ctx.save()
  ctx.font = `700 ${Math.round(ch * 0.95)}px ${theme().mono}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const flicker = 0.85 + 0.15 * Math.sin(fx.t * 40) * fx.pulse
  for (let i = 0; i < v.length; i++) {
    const c = RAMP[Math.min(RAMP.length - 1, Math.floor(v[i]! * RAMP.length))]!
    if (c === ' ') continue
    ctx.globalAlpha = clamp01((0.35 + 0.65 * v[i]!) * flicker + 0.2 * fx.pulse)
    ctx.fillStyle = '#6dff8e'
    ctx.fillText(c, d.x + ((i % g.cols) + 0.5) * cw, d.y + (Math.floor(i / g.cols) + 0.5) * ch)
  }
  // Scanlines.
  ctx.globalAlpha = 0.22
  ctx.fillStyle = '#000'
  for (let y = d.y; y < d.y + d.h; y += Math.max(2, ch / 3)) ctx.fillRect(d.x, y, d.w, Math.max(1, ch / 8))
  ctx.restore()
}

function redacted(ctx: CanvasRenderingContext2D, d: Rect, fx: StyleFx): void {
  ctx.fillStyle = '#070707'
  ctx.fillRect(d.x, d.y, d.w, d.h)
  // Dossier bars, overhanging the box like a marker pen.
  const r = rng(fx.seed)
  ctx.fillStyle = '#000'
  for (let k = 0; k < 4; k++) {
    const y = d.y + d.h * (0.12 + k * 0.22)
    const over = d.w * (0.04 + r() * 0.08)
    ctx.fillRect(d.x - over, y, d.w + over * 2 * (0.6 + r() * 0.4), d.h * 0.13)
  }
  // The stamp.
  const size = Math.max(10, d.w / 6.2) * (1 + 0.1 * fx.pulse)
  ctx.save()
  ctx.translate(d.x + d.w / 2, d.y + d.h / 2)
  ctx.rotate(-0.18)
  ctx.font = `${theme().displayWeight} ${size}px ${theme().display}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = Math.max(1.5, size / 14)
  ctx.strokeStyle = theme().accent
  ctx.globalAlpha = 0.9
  ctx.strokeText('REDACTED', 0, 0)
  const tw = ctx.measureText('REDACTED').width
  ctx.strokeRect(-tw / 2 - size * 0.25, -size * 0.62, tw + size * 0.5, size * 1.24)
  ctx.restore()
}

type V3 = [number, number, number]

/** The light the facets catch: up-left, in front (x right, y down, z away from the camera). */
const LIGHT = ((v: V3) => v.map((c) => c / Math.hypot(...v)))([-0.45, -0.6, -1])
/** LOW-POLY's rim: the outline pushed out this much from the face's middle (hairline, jaw and ears covered). */
const RIM_OUT = 1.16
/** Glasses: the rim's extra reach at eye level (cm; the eyes sit ~2 cm above the ears' line): out to the ear line
 *  along the head's right, and back along its forward axis (the arms run back to the ears). Back is what covers the
 *  far hinge and lens on a turned head (it's depth, so it never widens a face seen head-on). */
const GLASSES_UP_CM = 2.0
const GLASSES_BAND_CM = 2.2
const GLASSES_OUT_CM = 2.6
const GLASSES_BACK_CM = 5.0

/** Flat facets lit by their real normals, far ones first, each in its colour (0-255); amber edges on the beat. */
function paintFacets(ctx: CanvasRenderingContext2D, faces: V3[][], colors: readonly (readonly number[])[], fx: StyleFx): void {
  const order = faces.map((_, i) => i).sort((p, q) => {
    const z = (f: V3[]) => f[0]![2] + f[1]![2] + f[2]![2]
    return z(faces[q]!) - z(faces[p]!) // far first: a turned head's far cheek goes under its nose
  })
  ctx.save()
  ctx.globalAlpha = fx.alpha ?? 1
  ctx.lineWidth = 1
  ctx.lineJoin = 'round'
  for (const i of order) {
    const [A, B, C] = faces[i]!
    const u = [B![0] - A![0], B![1] - A![1], B![2] - A![2]]
    const v = [C![0] - A![0], C![1] - A![1], C![2] - A![2]]
    let n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]
    const len = Math.hypot(...n) || 1
    n = n.map((c) => c / len)
    if (n[2]! > 0) n = n.map((c) => -c) // face the camera
    const shade = 0.5 + 0.65 * Math.max(0, n[0]! * LIGHT[0]! + n[1]! * LIGHT[1]! + n[2]! * LIGHT[2]!)
    const c = colors[i]!
    const col = `rgb(${Math.min(255, c[0]! * shade) | 0},${Math.min(255, c[1]! * shade) | 0},${Math.min(255, c[2]! * shade) | 0})`
    ctx.fillStyle = col
    ctx.strokeStyle = col // the seams closed
    ctx.beginPath()
    ctx.moveTo(A![0], A![1])
    ctx.lineTo(B![0], B![1])
    ctx.lineTo(C![0], C![1])
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  }
  if (fx.pulse > 0.02) {
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = 0.25 * fx.pulse * (fx.alpha ?? 1)
    ctx.strokeStyle = theme().amber
    for (const [A, B, C] of faces) {
      ctx.beginPath()
      ctx.moveTo(A![0], A![1])
      ctx.lineTo(B![0], B![1])
      ctx.lineTo(C![0], C![1])
      ctx.closePath()
      ctx.stroke()
    }
  }
  ctx.restore()
}

const point = (m: Float32Array, i: number): V3 => [m[i * 3]!, m[i * 3 + 1]!, m[i * 3 + 2]!]

/**
 * LOW-POLY: MediaPipe's face mesh cut down to a fixed coarse topology (faceMeshData: the facets never flip), each facet
 * one colour from the privacy grid (at most 16 cells across) lit by its real normal, and a rim of facets along the
 * outline. Clean edges and nothing else: no box. Without landmarks nothing is drawn (a lost face fades out first).
 */
/** LOW-POLY's facets and their privacy-grid colours: the mesh a little over the face, and the rim. */
function lowpolyFacets(mesh: Float32Array, g: Grid, d: Rect): { faces: V3[][]; colors: number[][] } {
  let cx = 0
  let cy = 0
  for (const i of LOWPOLY_RING) {
    cx += mesh[i * 3]! / LOWPOLY_RING.length
    cy += mesh[i * 3 + 1]! / LOWPOLY_RING.length
  }
  // The whole face, a little over (forehead to chin, temple to temple), like the fox.
  const m = mesh.map((v, i) => (i % 3 === 0 ? cx + (v - cx) * FOX_SCALE : i % 3 === 1 ? cy + (v - cy) * FOX_SCALE : v * FOX_SCALE))
  // The rim: the outline pushed out, and at eye level out to the ear line (the head's own right and back), so a pair of
  // glasses' frame and arms stay under it, the far side too as the head turns; tight above and below the eyes.
  const hf = headFrame(m)
  const rim = LOWPOLY_RING.map((i): V3 => {
    const [x, y, z] = point(m, i)
    const rel = [x - hf.o[0]!, y - hf.o[1]!, z - hf.o[2]!]
    const up = (rel[0]! * hf.u[0]! + rel[1]! * hf.u[1]! + rel[2]! * hf.u[2]!) / hf.s // cm above the ears' line
    const across = (rel[0]! * hf.r[0]! + rel[1]! * hf.r[1]! + rel[2]! * hf.r[2]!) / hf.s // cm to the right
    const reach = Math.exp(-(((up - GLASSES_UP_CM) / GLASSES_BAND_CM) ** 2)) * Math.min(1, Math.abs(across) / 5) // eye band, at the sides
    const side = Math.sign(across) * GLASSES_OUT_CM * reach * hf.s
    const back = -GLASSES_BACK_CM * reach * hf.s
    return [
      cx + (x - cx) * RIM_OUT + side * hf.r[0]! + back * hf.f[0]!,
      cy + (y - cy) * RIM_OUT + side * hf.r[1]! + back * hf.f[1]!,
      z + 0.08 * d.w + side * hf.r[2]! + back * hf.f[2]!,
    ]
  })
  const faces: V3[][] = []
  for (let k = 0; k < LOWPOLY_TRIS.length; k += 3) faces.push([point(m, LOWPOLY_TRIS[k]!), point(m, LOWPOLY_TRIS[k + 1]!), point(m, LOWPOLY_TRIS[k + 2]!)])
  LOWPOLY_RING.forEach((a, k) => {
    const b = LOWPOLY_RING[(k + 1) % LOWPOLY_RING.length]!
    faces.push([point(m, a), point(m, b), rim[(k + 1) % rim.length]!], [point(m, a), rim[(k + 1) % rim.length]!, rim[k]!])
  })
  const colors = faces.map(([A, B, C]) => {
    const gx = Math.min(g.cols - 1, Math.max(0, Math.floor((((A![0] + B![0] + C![0]) / 3 - d.x) / d.w) * g.cols)))
    const gy = Math.min(g.rows - 1, Math.max(0, Math.floor((((A![1] + B![1] + C![1]) / 3 - d.y) / d.h) * g.rows)))
    const i = (gy * g.cols + gx) * 4
    return [g.px[i]!, g.px[i + 1]!, g.px[i + 2]!]
  })
  return { faces, colors }
}

function lowpoly(ctx: CanvasRenderingContext2D, source: CanvasImageSource, src: Rect, d: Rect, cols: number, fx: StyleFx): void {
  if (!fx.mesh || fx.mesh.length < 468 * 3) return
  const g = grid(source, src, cols, rowsFor(cols, d))
  if (!g) return
  const { faces, colors } = lowpolyFacets(fx.mesh, g, d)
  paintFacets(ctx, faces, colors, fx)
}

/** DEPTH GLITCH's bands across the head (forehead to chin), and how often their offsets change (s). */
const GLITCH_BANDS = 11
const GLITCH_TICK_S = 0.09

/**
 * DEPTH GLITCH: LOW-POLY's face cut into bands across the head, each band pushed in or out along the head's forward
 * axis and a little sideways (so the cuts wrap round the head as it turns, not a flat rectangle), an RGB split that
 * grows the nearer a band sits, dark scanlines at the cuts, and short bursts that throw one band hard: seeded per face,
 * stepped every 90 ms, stronger on the beat. Colours are LOW-POLY's (the privacy grid); the split stays soft (the
 * stage's flash guard is never the thing holding it back).
 */
function depthGlitch(ctx: CanvasRenderingContext2D, source: CanvasImageSource, src: Rect, d: Rect, cols: number, fx: StyleFx): void {
  if (!fx.mesh || fx.mesh.length < 468 * 3) return
  const g = grid(source, src, cols, rowsFor(cols, d))
  if (!g) return
  const { faces, colors } = lowpolyFacets(fx.mesh, g, d)
  const hf = headFrame(fx.mesh)
  const tick = Math.floor(fx.t / GLITCH_TICK_S)
  const r = rng(fx.seed * 7919 + tick)
  const burst = r() < 0.12 + 0.3 * fx.pulse ? Math.floor(r() * GLITCH_BANDS) : -1
  const push = Array.from({ length: GLITCH_BANDS }, (_, k) => {
    const hard = k === burst
    const depth = (r() - 0.5) * (hard ? 3.2 : 0.9 + 1.2 * fx.pulse) // cm along the head's forward axis
    const side = (r() - 0.5) * (hard ? 2.4 : 0.35) // cm along its right
    return { depth, side }
  })
  const band = (f: V3[]) => {
    const up = ((f[0]![0] + f[1]![0] + f[2]![0]) / 3 - hf.o[0]!) * hf.u[0]! + ((f[0]![1] + f[1]![1] + f[2]![1]) / 3 - hf.o[1]!) * hf.u[1]!
    return Math.min(GLITCH_BANDS - 1, Math.max(0, Math.floor((up / (hf.s * 19) + 0.55) * GLITCH_BANDS))) // chin (0) .. brow
  }
  const moved = faces.map((f) => {
    const { depth, side } = push[band(f)]!
    const off = [0, 1, 2].map((a) => hf.s * (depth * hf.f[a]! + side * hf.r[a]!))
    return f.map((p): V3 => [p[0] + off[0]!, p[1] + off[1]!, p[2] + off[2]!])
  })
  paintFacets(ctx, moved, colors, fx)
  // The RGB split: red one way, cyan the other along the head's right, wider the nearer the band is pushed.
  ctx.save()
  ctx.globalAlpha = 0.32 * (fx.alpha ?? 1)
  ctx.globalCompositeOperation = 'lighter'
  for (const [tint, sign] of [
    [[1, 0, 0], 1],
    [[0, 1, 1], -1],
  ] as const) {
    moved.forEach((f, i) => {
      const k = sign * hf.s * (0.25 + 0.35 * Math.max(0, push[band(f)]!.depth))
      const [dx, dy] = [k * hf.r[0]!, k * hf.r[1]!]
      const c = colors[i]!
      ctx.fillStyle = `rgb(${(c[0]! * tint[0]) | 0},${(c[1]! * tint[1]) | 0},${(c[2]! * tint[2]) | 0})`
      ctx.beginPath()
      ctx.moveTo(f[0]![0] + dx, f[0]![1] + dy)
      ctx.lineTo(f[1]![0] + dx, f[1]![1] + dy)
      ctx.lineTo(f[2]![0] + dx, f[2]![1] + dy)
      ctx.closePath()
      ctx.fill()
    })
  }
  ctx.restore()
  // Scanlines at the cuts, drawn across the head and clipped to the face.
  ctx.save()
  ctx.globalAlpha = 0.28 * (fx.alpha ?? 1)
  ctx.beginPath()
  for (const f of moved) {
    ctx.moveTo(f[0]![0], f[0]![1])
    ctx.lineTo(f[1]![0], f[1]![1])
    ctx.lineTo(f[2]![0], f[2]![1])
    ctx.closePath()
  }
  ctx.clip()
  ctx.strokeStyle = '#000'
  ctx.lineWidth = Math.max(1, hf.s * 0.18)
  const span = hf.s * 12
  for (let k = 1; k < GLITCH_BANDS; k++) {
    const up = (k / GLITCH_BANDS - 0.55) * hf.s * 19
    const cx = hf.o[0]! + up * hf.u[0]!
    const cy = hf.o[1]! + up * hf.u[1]!
    ctx.beginPath()
    ctx.moveTo(cx - span * hf.r[0]!, cy - span * hf.r[1]!)
    ctx.lineTo(cx + span * hf.r[0]!, cy + span * hf.r[1]!)
    ctx.stroke()
  }
  ctx.restore()
}

const hex = (h: string): number[] => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16))
/** The fox's colours, taken down to mid-tones: the light shades them instead of clipping at white. */
const FOX_RGB = LOWFOX_PALETTE.map((h) => hex(h).map((c) => c * 0.8))
const EAR_TIP = hex('#0b0b0c')
/** The fox a little bigger than the face: its facets reach over the jaw and forehead. */
const FOX_SCALE = 1.08

/** One low-poly ear on the head's frame (cm; x right, y up, z forward): two ember sides meeting on a forward ridge,
 *  and black tips. `side` -1 / 1 mirrors it; `lift` raises it (the brows). */
function foxEar(side: number, lift: number): { pts: V3[]; tris: [number, number, number, number[]][] } {
  const A: V3 = [-2.6, 0, 0]
  const B: V3 = [2.6, 0, 0]
  const C: V3 = [0.3, 6.2, -0.4]
  const M: V3 = [0.1, 0.3, 1.3]
  const at = (p: V3, q: V3, k: number): V3 => [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k]
  const [QA, QB, QM] = [at(A, C, 0.62), at(B, C, 0.62), at(M, C, 0.62)]
  const cz = Math.cos(-0.35 * side)
  const sz = Math.sin(-0.35 * side)
  const cx = Math.cos(-0.25)
  const sx = Math.sin(-0.25)
  const place = ([x, y, z]: V3): V3 => {
    x *= side
    const y1 = y * cx - z * sx // lean back, then tilt out
    const z1 = y * sx + z * cx
    return [5.2 * side + x * cz - y1 * sz, 6.5 + lift + x * sz + y1 * cz, 0.6 + z1]
  }
  const pts = [A, B, C, M, QA, QB, QM].map(place)
  const ember = FOX_RGB[0]!
  return { pts, tris: [[0, 3, 6, ember], [0, 6, 4, ember], [3, 1, 5, ember], [3, 5, 6, ember], [4, 6, 2, EAR_TIP], [6, 5, 2, EAR_TIP]] }
}

/**
 * FOX MASK: LOW-POLY's character in a fox's colours. A slightly finer facet mesh (faceMeshData LOWFOX: snapped to the
 * fox art, a palette colour per facet), a little bigger than the face, a faceted snout (rigFace's sculpt), the
 * expression (blinks, brows, jaw), and low-poly ears with black tips on the head's frame. Clean edges, no box; a lost
 * face fades out.
 */
function fox(ctx: CanvasRenderingContext2D, source: CanvasImageSource, src: Rect, d: Rect, cols: number, fx: StyleFx): void {
  if (!fx.mesh || fx.mesh.length < 468 * 3) return
  const g = grid(source, src, cols, rowsFor(cols, d))
  const m = rigFace(fx.mesh, fx.shapes ?? null, true)
  let cx = 0
  let cy = 0
  for (const i of LOWPOLY_RING) {
    cx += m[i * 3]! / LOWPOLY_RING.length
    cy += m[i * 3 + 1]! / LOWPOLY_RING.length
  }
  for (let i = 0; i < m.length; i += 3) {
    m[i] = cx + (m[i]! - cx) * FOX_SCALE
    m[i + 1] = cy + (m[i + 1]! - cy) * FOX_SCALE
    m[i + 2] = m[i + 2]! * FOX_SCALE
  }
  const faces: V3[][] = []
  const colors: number[][] = []
  for (let k = 0; k < LOWFOX_TRIS.length; k += 3) {
    faces.push([point(m, LOWFOX_TRIS[k]!), point(m, LOWFOX_TRIS[k + 1]!), point(m, LOWFOX_TRIS[k + 2]!)])
    colors.push(FOX_RGB[LOWFOX_COLORS[k / 3]!]!)
  }
  // The skirt along LOW-POLY's outline (rigFace's skirt points follow the full outline: every other one here).
  LOWPOLY_RING.forEach((a, j) => {
    const b = LOWPOLY_RING[(j + 1) % LOWPOLY_RING.length]!
    const sa = 468 + 2 * j
    const sb = 468 + 2 * ((j + 1) % LOWPOLY_RING.length)
    const col = FOX_RGB[LOWFOX_SKIRT_COLORS[j]!]!
    faces.push([point(m, a), point(m, b), point(m, sb)], [point(m, a), point(m, sb), point(m, sa)])
    colors.push(col, col)
  })
  const hf = headFrame(m)
  for (const side of [-1, 1]) {
    const away = smoothstep(0.35, 0.75, side * hf.f[0]!) // the far ear folds away as the head turns
    if (away > 0.99) continue
    const ear = foxEar(side, fx.shapes ? 0.9 * fx.shapes.browUp : 0)
    const toCanvas = ([x, y, z]: V3): V3 => {
      const k = hf.s * (1 - away)
      return [0, 1, 2].map((a) => hf.o[a]! + k * (x * hf.r[a]! + y * hf.u[a]! + z * hf.f[a]!)) as V3
    }
    const pts = ear.pts.map(toCanvas)
    for (const [a, b, c, col] of ear.tris) {
      faces.push([pts[a]!, pts[b]!, pts[c]!])
      colors.push(col)
    }
  }
  paintFacets(ctx, faces, g ? inTheRoom(faces, colors, g, d) : colors, fx)
}

/**
 * The fox lit like LOW-POLY: each facet's colour takes the room's light on the face under it (the privacy grid's
 * brightness, stretched to the face's own range: its shadows and highlights, 0.45-1.2x) and a quarter of its hue (a
 * blue club reads blue on the fox too), plus a small fixed variation per facet, so it isn't one solid colour.
 */
function inTheRoom(faces: V3[][], colors: number[][], g: Grid, d: Rect): number[][] {
  const light = lumas(g)
  return faces.map(([A, B, C], i) => {
    const gx = Math.min(g.cols - 1, Math.max(0, Math.floor((((A![0] + B![0] + C![0]) / 3 - d.x) / d.w) * g.cols)))
    const gy = Math.min(g.rows - 1, Math.max(0, Math.floor((((A![1] + B![1] + C![1]) / 3 - d.y) / d.h) * g.rows)))
    const k = gy * g.cols + gx
    const room = [g.px[k * 4]!, g.px[k * 4 + 1]!, g.px[k * 4 + 2]!]
    const peak = Math.max(...room, 1)
    const lift = (0.45 + 0.75 * light[k]!) * (0.94 + 0.12 * (((i * 2654435761) >>> 0) / 4294967296))
    return colors[i]!.map((c, j) => c * lift * (0.75 + (0.25 * room[j]!) / peak))
  })
}

/** A face mask the user imported (faceMask.ts), worn on the face with clean edges; a lost face fades out. */
function wornMask(id: string, ctx: CanvasRenderingContext2D, fx: StyleFx): void {
  if (!fx.mesh || fx.mesh.length < 468 * 3 || !maskReady(id)) return
  ctx.save()
  ctx.globalAlpha = fx.alpha ?? 1
  drawFaceMask(ctx, id, rigFace(fx.mesh, fx.shapes ?? null))
  ctx.restore()
}

let noise: { c: HTMLCanvasElement; g: CanvasRenderingContext2D; img: ImageData } | null = null

function staticNoise(ctx: CanvasRenderingContext2D, d: Rect, fx: StyleFx): void {
  if (!noise) {
    const c = document.createElement('canvas')
    c.width = 48
    c.height = 64
    const g = c.getContext('2d')
    if (!g) return
    noise = { c, g, img: g.createImageData(48, 64) }
  }
  const r = rng(fx.seed + Math.floor(fx.t * 30))
  const px = noise.img.data
  const gain = 0.55 + 0.45 * fx.pulse
  for (let i = 0; i < px.length; i += 4) {
    const v = r() * 255 * gain
    px[i] = v
    px[i + 1] = v * 0.96
    px[i + 2] = v * 0.92
    px[i + 3] = 255
  }
  noise.g.putImageData(noise.img, 0, 0)
  ctx.save()
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(noise.c, 0, 0, 48, 64, d.x, d.y, d.w, d.h)
  // A rolling bar, like a bad channel.
  const y = d.y + ((fx.t * 0.7) % 1) * d.h
  ctx.globalAlpha = 0.18
  ctx.fillStyle = '#fff'
  ctx.fillRect(d.x, y, d.w, d.h * 0.08)
  ctx.restore()
}

function halftone(ctx: CanvasRenderingContext2D, source: CanvasImageSource, src: Rect, d: Rect, cols: number, fx: StyleFx): void {
  const g = grid(source, src, cols, rowsFor(cols, d))
  if (!g) return
  const v = lumas(g)
  const cw = d.w / g.cols
  const ch = d.h / g.rows
  ctx.fillStyle = '#0b0b0d'
  ctx.fillRect(d.x, d.y, d.w, d.h)
  ctx.fillStyle = theme().ink
  const boost = 0.95 + 0.3 * fx.pulse
  for (let i = 0; i < v.length; i++) {
    const r = (Math.min(cw, ch) / 2) * Math.sqrt(v[i]!) * boost
    if (r < 0.6) continue
    ctx.beginPath()
    ctx.arc(d.x + ((i % g.cols) + 0.5) * cw, d.y + (Math.floor(i / g.cols) + 0.5) * ch, r, 0, Math.PI * 2)
    ctx.fill()
  }
}

let heatCanvas: { c: HTMLCanvasElement; g: CanvasRenderingContext2D } | null = null

function thermal(ctx: CanvasRenderingContext2D, source: CanvasImageSource, src: Rect, d: Rect, cols: number, fx: StyleFx): void {
  const g = grid(source, src, Math.min(cols, 12), rowsFor(Math.min(cols, 12), d))
  if (!g) return
  if (!heatCanvas) {
    const c = document.createElement('canvas')
    const hg = c.getContext('2d')
    if (!hg) return
    heatCanvas = { c, g: hg }
  }
  const { c, g: hg } = heatCanvas
  c.width = g.cols
  c.height = g.rows
  const img = hg.createImageData(g.cols, g.rows)
  const v = lumas(g)
  for (let i = 0; i < v.length; i++) {
    const [r, gg, b] = heat(v[i]! * 0.85 + 0.15 * fx.pulse)
    img.data[i * 4] = r
    img.data[i * 4 + 1] = gg
    img.data[i * 4 + 2] = b
    img.data[i * 4 + 3] = 255
  }
  hg.putImageData(img, 0, 0)
  ctx.save()
  // Smooth upscaling of a 12-cell grid: heat blobs, still no finer than the grid.
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(c, 0, 0, g.cols, g.rows, d.x, d.y, d.w, d.h)
  // The void: where the face's features would be, nothing.
  const cx = d.x + d.w / 2
  const cy = d.y + d.h * 0.48
  const rad = Math.max(d.w, d.h) * 0.36
  const void_ = ctx.createRadialGradient(cx, cy, rad * 0.25, cx, cy, rad)
  void_.addColorStop(0, 'rgba(0,0,0,0.97)')
  void_.addColorStop(0.55, 'rgba(0,0,0,0.9)')
  void_.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = void_
  ctx.fillRect(d.x, d.y, d.w, d.h)
  ctx.restore()
}

/** Draws style `name` over the face (`src` in the source's pixels, `d` on the canvas). `cols`: MOSAIC's cells. */
export function drawStyle(
  name: StyleName | `mask:${string}`,
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  src: Rect,
  d: Rect,
  cols: number,
  fx: StyleFx,
): void {
  switch (name) {
    case 'glitch':
      return glitch(ctx, source, src, d, cols, fx)
    case 'ascii':
      return ascii(ctx, source, src, d, cols, fx)
    case 'redacted':
      return redacted(ctx, d, fx)
    case 'depthglitch':
      return depthGlitch(ctx, source, src, d, cols, fx)
    case 'lowpoly':
      return lowpoly(ctx, source, src, d, cols, fx)
    case 'fox':
      return fox(ctx, source, src, d, cols, fx)
    case 'static':
      return staticNoise(ctx, d, fx)
    case 'halftone':
      return halftone(ctx, source, src, d, cols, fx)
    case 'thermal':
      return thermal(ctx, source, src, d, cols, fx)
    default:
      return wornMask(name.slice('mask:'.length), ctx, fx)
  }
}
