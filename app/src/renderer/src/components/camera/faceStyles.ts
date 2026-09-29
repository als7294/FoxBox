/**
 * The face encryption styles beyond MOSAIC / BLUR / SOLID (1.5): GLITCH, ASCII, REDACTED, LOW-POLY, DEPTH GLITCH,
 * POP-UPS, FOX MASK, STATIC, HALFTONE and THERMAL VOID. Live and in clips they're drawn by the same code (compose.maskRegion).
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
import { drawFaceMask, headFrame, maskReady, posedFace, rigFace } from './faceMask'
import { drawMaskOnFace, maskCovers, recipeFor } from './maskFace'
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
  /** The person's matte (alpha: the person) and where it lands on this canvas (drawImage's src and dst): POP-UPS puts
   *  windows behind the person with it. */
  person?: { image: CanvasImageSource; src: Rect; dst: Rect } | null
  /** The drop, when the audio knows one (a MASKS mask's burst and glitch). */
  drop?: { hit: boolean; energy: number } | null
}

export type StyleName = 'glitch' | 'ascii' | 'redacted' | 'lowpoly' | 'depthglitch' | 'popups' | 'fox' | 'static' | 'halftone' | 'thermal'

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
/** Glasses: the rim's extra reach at eye level (cm; the eyes sit ~2 cm above the ears' line): a little out along the
 *  head's right, a little back on the near side (the arms), and forward on the far side (a lens sits ~2 cm in front of
 *  the eye: on a turned head it hangs past the far cheek). Only as much as the glasses test needs: more reached over a
 *  DJ's headphone cups and read as a mask too wide (the user). */
const GLASSES_UP_CM = 2.0
const GLASSES_BAND_CM = 2.6
const GLASSES_OUT_CM = 2.0
const GLASSES_BACK_CM = 2.0
const GLASSES_FWD_CM = 4.0
/** The far side's forward reach falls off this slowly below the eyes (a cheek plate to the jaw, not one point). */
const PLATE_DOWN_CM = 4.5
/** ...and below the ears' line on the far side: the lips and a beard sit in front of the far jaw's line too. */
const JAW_FWD_CM = 2.5

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
export function lowpolyFacets(mesh: Float32Array, g: Grid, d: Rect): { faces: V3[][]; colors: number[][] } {
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
    const sides = Math.min(1, Math.abs(across) / 5) // not the chin's or the forehead's middle
    const reach = Math.exp(-(((up - GLASSES_UP_CM) / GLASSES_BAND_CM) ** 2)) * sides // eye band, at the sides
    const side = Math.sign(across) * GLASSES_OUT_CM * reach * hf.s
    // The back reach is the near side's (a side turning away drops it at once: on a slight turn it pulled the far rim
    // in, face-03's hinge); the forward reach grows on the far side with the turn.
    const away = Math.sign(across) * hf.r[2]!
    const near = 1 - smoothstep(0, 0.12, away)
    const far = smoothstep(0.1, 0.6, away)
    const plate = Math.exp(-(((up - GLASSES_UP_CM) / (up < GLASSES_UP_CM ? PLATE_DOWN_CM : GLASSES_BAND_CM)) ** 2)) * sides
    const jaw = smoothstep(1, -2, up) * sides
    const back = (far * (GLASSES_FWD_CM * plate + JAW_FWD_CM * jaw) - near * GLASSES_BACK_CM * reach) * hf.s
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

let backScratch: HTMLCanvasElement | null = null

/** POP-UPS: how long a layout holds (s), the face oval's reach (LOW-POLY's rim and scale), the title bars' words. */
const POPUPS_LAYOUT_S = 3
const POPUPS_REACH = RIM_OUT * 1.08
const POPUP_TITLES = ['Error', 'Warning', 'Not Responding', 'Alert', 'System', 'Message', 'Confirm', 'Fatal Error', 'Retry']
const POPUP_SANS = 'system-ui, -apple-system, "Helvetica Neue", sans-serif'
const POPUP_GREY = [236, 233, 216]
/** What the windows float over: a deep blue-black. */
const POPUP_VOID = [10, 18, 44]

/** A seeded split of `r` into windows (at least `min` a side, give or take a split), mostly along its longer side. */
function windowLayout(r: Rect, min: number, rand: () => number): Rect[] {
  const out: Rect[] = []
  const split = (b: Rect, depth: number): void => {
    const long = Math.max(b.w, b.h)
    if (long < min * 2 || depth > 7 || (depth > 1 && long < min * 3.2 && rand() < 0.35)) return void out.push(b)
    const k = 0.32 + 0.36 * rand()
    if (b.w > b.h * (0.8 + 0.4 * rand())) {
      split({ x: b.x, y: b.y, w: b.w * k, h: b.h }, depth + 1)
      split({ x: b.x + b.w * k, y: b.y, w: b.w * (1 - k), h: b.h }, depth + 1)
    } else {
      split({ x: b.x, y: b.y, w: b.w, h: b.h * k }, depth + 1)
      split({ x: b.x, y: b.y + b.h * k, w: b.w, h: b.h * (1 - k) }, depth + 1)
    }
  }
  split(r, 0)
  return out
}

type Popup = Rect & { z: number; seed: number }

/** POP-UPS' layout on the face (the head's plane): windows spread over it (a seeded split, one window a tile), each at
 *  its own depth `z` (in the area's units; below 0 behind the face, above it in front), and on the beat up to four
 *  more snapping in nearer than all of them. The tiles don't move with the beat. */
export function popupStack(area: Rect, seed: number, pulse: number): { tiles: Popup[]; pops: Popup[] } {
  const r = rng(seed)
  const tiles = windowLayout(area, area.w / 3.2, r).map((c) => ({ ...c, z: area.w * (-0.12 + 0.3 * r()), seed: Math.floor(r() * 1e9) }))
  const p = rng(seed + 1)
  const pops = Array.from({ length: Math.round(clamp01(pulse) * 4) }, (_, k) => {
    const w = area.w * (0.3 + 0.2 * p())
    const h = area.h * (0.18 + 0.12 * p())
    const x = area.x + p() * (area.w - w)
    const y = area.y + area.h * 0.1 + p() * (area.h * 0.9 - h)
    return { x, y, w, h, z: area.w * (0.2 + 0.04 * k), seed: Math.floor(p() * 1e9) }
  })
  return { tiles, pops }
}

const mixed = (a: readonly number[], b: readonly number[], k: number, light = 1) =>
  `rgb(${a.map((v, i) => Math.min(255, (v + (b[i]! - v) * k) * light) | 0).join(',')})`

/** A rounded-top window outline (square bottom corners). */
function tabPath(ctx: CanvasRenderingContext2D, w: Rect, rad: number): void {
  ctx.beginPath()
  ctx.moveTo(w.x, w.y + w.h)
  ctx.lineTo(w.x, w.y + rad)
  ctx.arcTo(w.x, w.y, w.x + rad, w.y, rad)
  ctx.lineTo(w.x + w.w - rad, w.y)
  ctx.arcTo(w.x + w.w, w.y, w.x + w.w, w.y + rad, rad)
  ctx.lineTo(w.x + w.w, w.y + w.h)
  ctx.closePath()
}

/** A small bevelled box: a glossy face in `top` -> `bottom`, a light rim. */
function bevel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, top: string, bottom: string, px: number): void {
  const gr = ctx.createLinearGradient(0, y, 0, y + h)
  gr.addColorStop(0, top)
  gr.addColorStop(1, bottom)
  ctx.fillStyle = gr
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'
  ctx.lineWidth = px
  ctx.stroke()
}

/**
 * One early-2000s dialog pane in `w` (the context's units; `px` is one screen pixel): a glossy blue title bar with
 * rounded top corners, a word and bevelled minimise / maximise / close buttons, a blue frame, a grey body with the
 * privacy grid's colour `tint` mixed in, and inside it an error, a warning, a progress bar or a picture of the grid.
 */
function pane(ctx: CanvasRenderingContext2D, w: Rect, px: number, rand: () => number, tint: readonly number[], t: number,
  picture: (x: number, y: number) => number[], opts: { kind?: number; shadow?: number } = {}): void {
  const bar = Math.max(3 * px, Math.min(w.h * 0.22, 18 * px))
  const fw = Math.max(px, bar * 0.14)
  if (opts.shadow) {
    // Cast on what's under it, down-right of the light: further and softer the nearer the pane floats (two offset
    // layers, not a blur: a canvas shadow blur per pane cost 2 ms a face).
    const o = opts.shadow * px
    ctx.fillStyle = 'rgba(0,0,20,0.18)'
    ctx.beginPath()
    ctx.roundRect(w.x + o * 0.5, w.y + o * 0.8, w.w + o * 0.5, w.h + o * 0.5, bar * 0.6)
    ctx.fill()
    ctx.fillStyle = 'rgba(0,0,20,0.3)'
    ctx.fillRect(w.x + o * 0.35, w.y + o * 0.55, w.w, w.h)
  }
  tabPath(ctx, w, bar * 0.45)
  const title = ctx.createLinearGradient(0, w.y, 0, w.y + bar)
  title.addColorStop(0, '#78adf7')
  title.addColorStop(0.14, '#2f78ea')
  title.addColorStop(0.55, '#1a5ed8')
  title.addColorStop(1, '#0c46b4')
  ctx.fillStyle = title
  ctx.fill()
  ctx.fillStyle = 'rgba(255,255,255,0.18)' // the gloss
  ctx.fillRect(w.x + fw, w.y + bar * 0.12, w.w - 2 * fw, bar * 0.32)
  const body = { x: w.x + fw, y: w.y + bar, w: w.w - 2 * fw, h: w.h - bar - fw }
  ctx.fillStyle = mixed(POPUP_GREY, tint, 0.18)
  ctx.fillRect(body.x, body.y, body.w, body.h)
  // The buttons, right to left: close (red), maximise, minimise.
  const bs = bar * 0.72
  const by = w.y + (bar - bs) / 2
  const slots = Math.min(3, Math.floor((w.w - 2 * fw) / (bs * 1.15) - 1))
  for (let j = 0; j < slots; j++) {
    const bx = w.x + w.w - fw - (j + 1) * bs * 1.1
    if (j === 0) bevel(ctx, bx, by, bs, bs, '#f08a68', '#c5391a', px)
    else bevel(ctx, bx, by, bs, bs, '#7fb0f8', '#2c6ce0', px)
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = Math.max(px, bs * 0.14)
    ctx.beginPath()
    const m = bs * 0.3
    if (j === 0) {
      ctx.moveTo(bx + m, by + m)
      ctx.lineTo(bx + bs - m, by + bs - m)
      ctx.moveTo(bx + bs - m, by + m)
      ctx.lineTo(bx + m, by + bs - m)
    } else if (j === 1) {
      ctx.rect(bx + m, by + m, bs - 2 * m, bs - 2 * m)
    } else {
      ctx.moveTo(bx + m, by + bs - m)
      ctx.lineTo(bx + bs - m, by + bs - m)
    }
    ctx.stroke()
  }
  const word = POPUP_TITLES[Math.floor(rand() * POPUP_TITLES.length)]!
  if (bar >= 8 * px && w.w >= bar * 7) {
    ctx.font = `700 ${bar * 0.55}px ${POPUP_SANS}`
    ctx.textBaseline = 'middle'
    ctx.fillStyle = 'rgba(0,0,40,0.6)'
    ctx.fillText(word, w.x + fw + bar * 0.35 + px, w.y + bar / 2 + px, w.w - bar * 4)
    ctx.fillStyle = '#fff'
    ctx.fillText(word, w.x + fw + bar * 0.35, w.y + bar / 2, w.w - bar * 4)
  }
  // Inside.
  const pad = Math.max(px, Math.min(body.w, body.h) * 0.1)
  const b = { x: body.x + pad, y: body.y + pad, w: body.w - 2 * pad, h: body.h - 2 * pad }
  if (b.w < 6 * px || b.h < 5 * px) return
  const kind = opts.kind ?? Math.floor(rand() * 4)
  const lines = (x: number, w: number, n: number, y0: number, h: number) => {
    ctx.fillStyle = '#4b4b4b'
    for (let j = 0; j < n; j++) ctx.fillRect(x, y0 + (h * (j + 0.3)) / n, w * (j === n - 1 ? 0.55 : 0.9 - 0.2 * rand()), Math.max(px, h / n / 3.2))
  }
  if (kind <= 1) {
    // An error (a red disc, a white cross) or a warning (a yellow triangle, a "!"), two lines and an OK button.
    const icon = Math.min(b.h * 0.55, b.w * 0.28)
    const cx = b.x + icon / 2
    const cy = b.y + icon / 2
    ctx.beginPath()
    if (kind === 0) {
      ctx.arc(cx, cy, icon / 2, 0, Math.PI * 2)
      ctx.fillStyle = '#d8321e'
    } else {
      ctx.moveTo(cx, b.y)
      ctx.lineTo(b.x + icon, b.y + icon * 0.9)
      ctx.lineTo(b.x, b.y + icon * 0.9)
      ctx.closePath()
      ctx.fillStyle = '#f2c230'
    }
    ctx.fill()
    ctx.strokeStyle = kind === 0 ? '#fff' : '#111'
    ctx.lineWidth = Math.max(px, icon * 0.13)
    ctx.beginPath()
    if (kind === 0) {
      const m = icon * 0.24
      ctx.moveTo(cx - m, cy - m)
      ctx.lineTo(cx + m, cy + m)
      ctx.moveTo(cx + m, cy - m)
      ctx.lineTo(cx - m, cy + m)
    } else {
      ctx.moveTo(cx, b.y + icon * 0.3)
      ctx.lineTo(cx, b.y + icon * 0.62)
      ctx.moveTo(cx, b.y + icon * 0.72)
      ctx.lineTo(cx, b.y + icon * 0.78)
    }
    ctx.stroke()
    lines(b.x + icon * 1.3, b.w - icon * 1.3, 2, b.y, icon)
    if (b.h > icon * 1.6) {
      const ow = Math.min(b.w * 0.4, icon * 2.2)
      const oh = Math.min(b.h - icon * 1.15, icon * 0.6)
      bevel(ctx, b.x + (b.w - ow) / 2, b.y + b.h - oh, ow, oh, '#fdfdfb', '#dcd8c8', px)
      ctx.strokeStyle = '#1c3f94'
      ctx.lineWidth = px
      ctx.stroke()
    }
  } else if (kind === 2) {
    // A progress bar: green blocks filling a sunken box, and starting over.
    lines(b.x, b.w, 1, b.y, b.h * 0.4)
    const ph = Math.min(b.h * 0.4, 12 * px)
    const y = b.y + b.h - ph
    ctx.fillStyle = '#fff'
    ctx.fillRect(b.x, y, b.w, ph)
    ctx.strokeStyle = '#7f9db9'
    ctx.lineWidth = px
    ctx.strokeRect(b.x, y, b.w, ph)
    const blocks = Math.max(3, Math.floor(b.w / (ph * 0.8)))
    const done = Math.floor(((t * (0.2 + 0.3 * rand()) + rand()) % 1) * blocks)
    ctx.fillStyle = '#37b837'
    for (let j = 0; j < done; j++) ctx.fillRect(b.x + (b.w * j) / blocks + px, y + px * 1.5, b.w / blocks - px * 2, ph - px * 3)
  } else {
    // A picture: the privacy grid under the pane, in a sunken frame.
    const n = Math.max(2, Math.min(6, Math.floor(Math.min(b.w, b.h) / (4 * px))))
    for (let j = 0; j < n * n; j++) {
      const x = b.x + ((j % n) * b.w) / n
      const y = b.y + (Math.floor(j / n) * b.h) / n
      ctx.fillStyle = mixed(picture(x + b.w / n / 2, y + b.h / n / 2), [0, 0, 0], 0)
      ctx.fillRect(x, y, b.w / n + px * 0.5, b.h / n + px * 0.5)
    }
    ctx.strokeStyle = '#808080'
    ctx.lineWidth = px
    ctx.strokeRect(b.x, b.y, b.w, b.h)
  }
}

/**
 * POP-UPS: early-2000s dialog windows glitching over the face, floating at depth. The face is spread with windows
 * (one a tile of a seeded split, re-laid every 1.5 s), each at its own depth on the head's plane: behind the face
 * smaller and hazed, in front bigger with a longer, softer shadow, and all sliding over one another as the head turns
 * (parallax along its forward axis). On the beat more pop up nearest, and the nearest one's frozen trail steps toward
 * you; windows jitter and bands tear sideways. They float over a dark void that fills the face's true outline on
 * screen, so nothing of it shows between them; without landmarks the box is the void. Picture colours only through
 * the privacy grid.
 */
function popups(ctx: CanvasRenderingContext2D, source: CanvasImageSource, src: Rect, d: Rect, cols: number, fx: StyleFx): void {
  const g = grid(source, src, cols, rowsFor(cols, d))
  if (!g) return
  const colour = (x: number, y: number): number[] => {
    const gx = Math.min(g.cols - 1, Math.max(0, Math.floor(((x - d.x) / d.w) * g.cols)))
    const gy = Math.min(g.rows - 1, Math.max(0, Math.floor(((y - d.y) / d.h) * g.rows)))
    const i = (gy * g.cols + gx) * 4
    return [g.px[i]!, g.px[i + 1]!, g.px[i + 2]!]
  }
  // Where: on the head's plane (x cm right, y cm down from the ears' line) with landmarks, else the box on screen.
  let area = d
  let toScreen = (x: number, y: number): number[] => [x, y]
  let px = 1 // one screen pixel, in the plane's units
  let par = [0, 0] // a window `z` nearer moves this much (times z) across the plane
  let unit = 1 // screen px per plane unit
  const voidRgb = POPUP_VOID.map((v, i) => v + (colour(d.x + d.w / 2, d.y + d.h / 2)[i]! - v) * 0.12)
  const voidCss = `rgb(${voidRgb.map((v) => v | 0).join(',')})`
  ctx.save()
  ctx.fillStyle = voidCss
  const onScreen = ctx.getTransform()
  const outline = new Path2D() // the void: all of the face on screen, and where tearing may reach
  if (fx.mesh && fx.mesh.length >= 468 * 3) {
    const m = fx.mesh
    const hf = headFrame(m)
    const [r0, r1, r2] = hf.r as [number, number, number]
    const [u0, u1, u2] = hf.u as [number, number, number]
    const [o0, o1, o2] = hf.o as [number, number, number]
    const local = LOWPOLY_RING.map((i) => {
      const p = [m[i * 3]! - o0, m[i * 3 + 1]! - o1, m[i * 3 + 2]! - o2]
      return [(p[0]! * r0 + p[1]! * r1 + p[2]! * r2) / hf.s, -(p[0]! * u0 + p[1]! * u1 + p[2]! * u2) / hf.s]
    })
    const cx = local.reduce((s, p) => s + p[0]!, 0) / local.length
    const cy = local.reduce((s, p) => s + p[1]!, 0) / local.length
    const xs = local.map((p) => cx + (p[0]! - cx) * POPUPS_REACH)
    const ys = local.map((p) => cy + (p[1]! - cy) * POPUPS_REACH)
    area = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
    // The void: the face's true outline on screen (depth included), pushed out the same.
    const sx = LOWPOLY_RING.reduce((s, i) => s + m[i * 3]!, 0) / LOWPOLY_RING.length
    const sy = LOWPOLY_RING.reduce((s, i) => s + m[i * 3 + 1]!, 0) / LOWPOLY_RING.length
    LOWPOLY_RING.forEach((i, k) => {
      const x = sx + (m[i * 3]! - sx) * POPUPS_REACH
      const y = sy + (m[i * 3 + 1]! - sy) * POPUPS_REACH
      if (k) outline.lineTo(x, y)
      else outline.moveTo(x, y)
    })
    outline.closePath()
    toScreen = (x, y) => [o0 + (x * r0 - y * u0) * hf.s, o1 + (x * r1 - y * u1) * hf.s]
    ctx.transform(r0 * hf.s, r1 * hf.s, -u0 * hf.s, -u1 * hf.s, o0, o1)
    px = 1 / hf.s
    unit = hf.s
    // Nearer along the head's forward axis, seen on screen, in the plane's units (x, y per unit of z).
    const [f0, f1] = hf.f as [number, number]
    const det = u0 * r1 - r0 * u1
    if (Math.abs(det) > 1e-6) par = [(u0 * f1 - f0 * u1) / det, (r0 * f1 - r1 * f0) / det]
  } else {
    outline.rect(d.x, d.y, d.w, d.h)
  }
  if (area.w < 4 * px || area.h < 4 * px) {
    ctx.setTransform(onScreen)
    ctx.fill(outline) // too small for windows: the void alone still covers it
    return void ctx.restore()
  }
  const onPlane = ctx.getTransform()
  const picture = (x: number, y: number) => colour(...(toScreen(x, y) as [number, number]))
  const tick = Math.floor(fx.t / POPUPS_LAYOUT_S)
  const { tiles, pops } = popupStack(area, fx.seed * 7919 + tick, fx.pulse)
  const all = [...tiles, ...pops].sort((a, b) => a.z - b.z)
  const shake = rng(fx.seed * 31 + Math.floor(fx.t * 12)) // jitter and tearing change 12 times a second, not every frame
  // A window at depth `z`, in perspective from a viewer 2.5 faces away: nearer, bigger and further out from the face's
  // middle (behind, smaller and drawn in), and slid by the parallax as the head turns.
  const mx = area.x + area.w / 2
  const my = area.y + area.h / 2
  const lift = (w: Rect, z: number): Rect => {
    const k = (2.5 * area.w) / Math.max(area.w, 2.5 * area.w - z)
    const x = mx + (w.x + w.w / 2 - mx) * k + par[0]! * z
    const y = my + (w.y + w.h / 2 - my) * k + par[1]! * z
    return { x: x - (w.w * k * 0.94) / 2, y: y - (w.h * k * 0.94) / 2, w: w.w * k * 0.94, h: w.h * k * 0.94 }
  }
  const one = (w: Popup, z0: number, g: CanvasRenderingContext2D = ctx) => {
    // Floating: each drifts on its own slow bob, in depth and a little sideways.
    const f = rng(w.seed ^ 0x5bd1e995)
    const ph = f() * Math.PI * 2
    const hz = 0.25 + 0.3 * f()
    const z = z0 + area.w * 0.04 * Math.sin(fx.t * hz * Math.PI * 2 + ph)
    const q = lift(w, z)
    q.x += area.w * 0.012 * Math.sin(fx.t * hz * 1.7 * Math.PI + ph * 1.3)
    q.y += area.h * 0.015 * Math.cos(fx.t * hz * Math.PI * 2 + ph)
    if (shake() < 0.05 + 0.3 * fx.pulse) {
      q.x += (shake() - 0.5) * area.w * 0.03
      q.y += (shake() - 0.5) * area.w * 0.03
    }
    pane(g, q, px, rng(w.seed), picture(q.x + q.w / 2, q.y + q.h / 2), fx.t, picture, { shadow: z > 0 ? (z / area.w) * 0.5 * unit : 0 })
    if (z < 0) {
      // Behind: hazed into the void, more the further back.
      g.globalAlpha = Math.min(0.45, (-z / area.w) * 1.2)
      g.fillStyle = voidCss
      tabPath(g, q, 0)
      g.fill()
      g.globalAlpha = 1
    }
  }
  // Behind the head (with the person's matte): bigger windows far back round it, drawn first and erased wherever the
  // person is, so head, hair and shoulders stand in front of them. Without a matte there are none (no guessing).
  const behind = (person: NonNullable<StyleFx['person']>) => {
    const r = rng(fx.seed * 131 + tick)
    const back: Popup[] = Array.from({ length: 5 + Math.round(fx.pulse * 2) }, () => {
      const w = area.w * (0.55 + 0.35 * r())
      const h = area.h * (0.3 + 0.2 * r())
      const x = area.x - area.w * 0.9 + r() * (area.w * 2.8 - w)
      const y = area.y - area.h * 0.25 + r() * (area.h * 1.1 - h)
      return { x, y, w, h, z: -area.w * (0.35 + 0.35 * r()), seed: Math.floor(r() * 1e9) }
    })
    // Their box on screen (through the plane, room for the drift), within the canvas.
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
    for (const w of back) {
      const q = lift(w, w.z)
      for (const [x, y] of [[q.x, q.y], [q.x + q.w, q.y], [q.x, q.y + q.h], [q.x + q.w, q.y + q.h]]) {
        const p = onPlane.transformPoint(new DOMPoint(x, y))
        x0 = Math.min(x0, p.x)
        y0 = Math.min(y0, p.y)
        x1 = Math.max(x1, p.x)
        y1 = Math.max(y1, p.y)
      }
    }
    const pad = (x1 - x0) * 0.08
    x0 = Math.max(0, Math.floor(x0 - pad))
    y0 = Math.max(0, Math.floor(y0 - pad))
    x1 = Math.min(ctx.canvas.width, Math.ceil(x1 + pad))
    y1 = Math.min(ctx.canvas.height, Math.ceil(y1 + pad))
    if (x1 - x0 < 8 || y1 - y0 < 8) return
    backScratch ??= document.createElement('canvas')
    const step = (n: number) => Math.ceil(n / 64) * 64
    if (backScratch.width < x1 - x0 || backScratch.height < y1 - y0) {
      backScratch.width = step(x1 - x0)
      backScratch.height = step(y1 - y0)
    }
    const g = backScratch.getContext('2d')
    if (!g) return
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, x1 - x0, y1 - y0)
    g.setTransform(new DOMMatrix([1, 0, 0, 1, -x0, -y0]).multiply(onPlane))
    for (const w of back) one(w, w.z, g)
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.globalCompositeOperation = 'destination-out' // the person stands in front
    g.drawImage(person.image, person.src.x, person.src.y, person.src.w, person.src.h, person.dst.x - x0, person.dst.y - y0, person.dst.w, person.dst.h)
    g.globalCompositeOperation = 'source-over'
    ctx.save()
    ctx.setTransform(onScreen)
    ctx.drawImage(backScratch, 0, 0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0)
    ctx.restore()
  }
  const drawAll = () => {
    for (const w of all) one(w, w.z)
    // The nearest one's frozen trail: copies of it stepping sideways and toward you, longer on the beat.
    const top = all[all.length - 1]
    if (top) {
      const tr = rng(fx.seed * 977 + tick)
      const copies = 1 + Math.floor(tr() * 3) + Math.round(fx.pulse * 4)
      const sx = (tr() < 0.5 ? -1 : 1) * area.w * (0.025 + 0.02 * tr())
      const sy = (tr() < 0.5 ? -1 : 1) * area.h * (0.02 + 0.015 * tr())
      for (let k = 1; k <= copies; k++) one({ ...top, x: top.x + sx * k, y: top.y + sy * k }, top.z + area.w * 0.015 * k)
    }
  }
  if (fx.mesh && fx.person) behind(fx.person)
  // The void over all of the face, then the windows over it.
  ctx.save()
  ctx.setTransform(onScreen)
  ctx.fill(outline)
  ctx.restore()
  drawAll()
  // Tearing: a band or two of the face redrawn a little sideways (inside its outline: never out over the room).
  const bands = shake() < 0.1 + 0.6 * fx.pulse ? 1 + Math.floor(shake() * 2) : 0
  for (let k = 0; k < bands; k++) {
    const y = area.y + shake() * area.h
    const h = area.h * (0.03 + 0.06 * shake())
    ctx.save()
    ctx.setTransform(onScreen)
    ctx.clip(outline)
    ctx.setTransform(onPlane)
    ctx.beginPath()
    ctx.rect(area.x - area.w, y, area.w * 3, h)
    ctx.clip()
    ctx.fillStyle = voidCss
    ctx.fillRect(area.x - area.w, y, area.w * 3, h)
    ctx.translate((shake() - 0.5) * area.w * 0.25, 0)
    drawAll()
    ctx.restore()
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
/** A MASKS character (recipe mask `id`) on the face; LOW-POLY meanwhile (loading, a recipe that failed, no WebGL),
 *  so the face is never shown while it isn't there. */
/** How much a worn mask may grow to cover a face its core misses (a turn past it), before it goes on a stand-in head. */
const GROW = [1, 1.12, 1.25, 1.4]

/**
 * A MASKS mask (maskFace) on the face: always ONE mask. Where its core doesn't cover this face (a turn past it) the same
 * mask grows until it does, else it's worn on a stand-in head filling the tracker's box. While it loads, or without
 * WebGL, LOW-POLY instead (never under it).
 */
function wornRecipe(id: string, ctx: CanvasRenderingContext2D, source: CanvasImageSource, src: Rect, d: Rect, cols: number, fx: StyleFx): void {
  if (!fx.mesh || fx.mesh.length < 468 * 3) return
  const cfg = recipeFor(id)
  if (!cfg) return lowpoly(ctx, source, src, d, cols, fx)
  const grow = GROW.find((g) => maskCovers(fx.mesh!, cfg, g))
  const drawn = drawMaskOnFace(ctx, cfg, grow ? fx.mesh : standInMesh(d, fx.pose), grow ? (fx.shapes ?? null) : null, fx.t, fx.pulse, grow ?? 1, fx.drop ?? null)
  if (!drawn) lowpoly(ctx, source, src, d, cols, fx)
}

function wornMask(id: string, ctx: CanvasRenderingContext2D, source: CanvasImageSource, src: Rect, d: Rect, cols: number, fx: StyleFx): void {
  if (!fx.mesh || fx.mesh.length < 468 * 3) return
  if (!maskReady(id)) return lowpoly(ctx, source, src, d, cols, fx) // its picture still loading (or gone): never the bare face
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
/** QA (the camera trace reads them): draws that put a second mask on a head: LOW-POLY under a worn mask, a stand-in
 *  under a fading mesh. */
export const doubles = { underlay: 0, fadeUnder: 0 }

/** Styles drawn on the face's mesh: without one they have nothing to draw on. */
export const onMesh = (name: string): boolean =>
  name === 'lowpoly' || name === 'depthglitch' || name === 'fox' || name.startsWith('recipe:') || name.startsWith('mask:')

/**
 * A stand-in head filling box `d` (the tracker's, padded by COVERAGE), turned and tilted as the detector saw it: what a
 * mesh style wears on a face the landmarker has lost, so the face stays hidden, in the style's own look.
 */
export function standInMesh(d: Rect, pose?: HeadPose | null): Float32Array {
  const s = Math.max(d.w / 15.3, d.h / 17.7) // the canonical face's width and height (cm): the head fills the box
  const [cx, cy] = [d.x + d.w / 2, d.y + d.h / 2]
  const m = posedFace(cx, cy - 0.6 * s, s, 0.9 * Math.max(-1, Math.min(1, pose?.yaw ?? 0)), -(pose?.pitch ?? 0))
  const roll = pose?.roll ?? 0
  if (roll)
    for (let i = 0; i < m.length; i += 3) {
      const [x, y] = [m[i]! - cx, m[i + 1]! - cy]
      m[i] = cx + x * Math.cos(roll) - y * Math.sin(roll)
      m[i + 1] = cy + x * Math.sin(roll) + y * Math.cos(roll)
    }
  return m
}

export function drawStyle(
  name: StyleName | `mask:${string}` | `recipe:${string}`,
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  src: Rect,
  d: Rect,
  cols: number,
  fx: StyleFx,
): void {
  // Fail closed: a mesh style on a face the landmarker has lost wears a stand-in head in the tracker's box INSTEAD (one
  // mask a head: never under a fading one).
  const bare = !fx.mesh || fx.mesh.length < 468 * 3
  if (onMesh(name) && bare) return drawOn(name, ctx, source, src, d, cols, { ...fx, mesh: standInMesh(d, fx.pose), shapes: null, alpha: 1 })
  if (onMesh(name) && (fx.alpha ?? 1) < 1) doubles.fadeUnder++ // QA: a fading mesh (nothing under it now)
  drawOn(name, ctx, source, src, d, cols, fx)
}

function drawOn(
  name: StyleName | `mask:${string}` | `recipe:${string}`,
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
    case 'popups':
      return popups(ctx, source, src, d, cols, fx)
    case 'fox':
      return fox(ctx, source, src, d, cols, fx)
    case 'static':
      return staticNoise(ctx, d, fx)
    case 'halftone':
      return halftone(ctx, source, src, d, cols, fx)
    case 'thermal':
      return thermal(ctx, source, src, d, cols, fx)
    default:
      if (name.startsWith('recipe:')) return wornRecipe(name.slice('recipe:'.length), ctx, source, src, d, cols, fx)
      return wornMask(name.slice('mask:'.length), ctx, source, src, d, cols, fx)
  }
}
