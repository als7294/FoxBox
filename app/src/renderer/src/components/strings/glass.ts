/**
 * STRINGS' finger-frame GLASS (1.5.5): make S1's FRAME with your hands (both an L, shapes.frame) and the strings fade
 * out as a pane of thick glass fades in between your hands, following them, tilted as they are; let go and it cracks,
 * the shards falling away as the strings come back. The pane never zooms: its bevelled edge bends the picture, the
 * middle stays true. Through it, another world, the next with each new frame: THERMAL, X-RAY, HALFTONE, PRISM, KALEIDO,
 * DATAMOSH; the bass runs ripples across it, the kick glints its rim. Reduced motion: a plain pane, a fade, no shards.
 *
 * This is the logic (pure, tested): when the glass is on (S1's FRAME_HOLD_MS to make it, EXIT_HOLD_MS to lose it, so
 * it never flickers), the eased crossfade, the crack, which kind, and where the pane sits. glassPass.ts draws it.
 * Points are 0-1 of the picture (y down), as CameraSignals.stage gives them.
 */
import type { Pt } from '@/components/camera/camMath'

/** The world through the pane; 'plain' (no world) with reduced motion only. */
export type GlassType = 'thermal' | 'xray' | 'halftone' | 'prism' | 'kaleido' | 'datamosh' | 'plain'
export const GLASS_TYPES: readonly GlassType[] = ['thermal', 'xray', 'halftone', 'prism', 'kaleido', 'datamosh']
export const GLASS_LABEL: Record<GlassType, string> = {
  thermal: 'THERMAL', xray: 'X-RAY', halftone: 'HALFTONE', prism: 'PRISM', kaleido: 'KALEIDO', datamosh: 'DATAMOSH', plain: '',
}

/** The crossfade, strings out and glass in (and back), eased. */
export const FADE_MS = 400
/** The frame lost this long before the glass goes (S1's hold covers the making). */
export const EXIT_HOLD_MS = 300
/** The shards falling away. */
export const CRACK_MS = 300

/** The pane in the picture: its centre (0-1, y down), half its width and height along its own axes (in picture
 *  heights) and its tilt (radians, clockwise on screen; within ±π/4). */
export interface GlassQuad {
  x: number
  y: number
  hw: number
  hh: number
  tilt: number
}

/** For S2's glass sound (glassSignal, read once a stage frame). `on` is already debounced (S1's hold to make the frame,
 *  EXIT_HOLD_MS to lose it). */
export interface GlassSignal {
  on: boolean
  type: GlassType
  /** 0 (a tiny frame) … 1 (as big as it gets): its diagonal over the picture's width, 0.08 … 0.7. */
  size: number
  /** -1 … 1: its rotation, ±45° full (clockwise positive). */
  tilt: number
  /** Its centre, 0-1 of the picture. */
  x: number
  y: number
  /** performance.now() when the last CRACK began (letting go), 0 if never. */
  crackAt: number
}

export interface GlassFrame {
  /** 0: strings only … 1: glass only (eased). */
  mix: number
  type: GlassType
  /** How far the shards have fallen, 0-1, once the frame is let go; -1 while it's held, or with no crack. */
  crack: number
  quad: GlassQuad | null
  /** The glass kind changed this frame (the page's chip). */
  changed: boolean
  /** Seconds since this pane came on (DATAMOSH's melt grows with it). */
  age: number
}

const OFF: GlassSignal = { on: false, type: 'thermal', size: 0, tilt: 0, x: 0.5, y: 0.5, crackAt: 0 }
let latest: GlassSignal = OFF
/** The glass as it is now (S2: the glass sound); off while STRINGS isn't drawing. */
export const glassSignal = (): GlassSignal => latest
export const clearGlassSignal = (): void => void (latest = OFF)

const MIN_HALF = 0.03 // a pane never thinner than this (picture heights)

/**
 * The pane from the two L hands (MediaPipe's 21 each, 0-1 of the picture): its tilt is where the four fingers of the
 * frame (both thumbs, both index fingers) point, folded to the nearest axis; its edges are the four fingertips' extent
 * along that tilt. `aspect`: the picture's width over height.
 */
export function fitGlass(left: readonly Pt[], right: readonly Pt[], aspect: number): GlassQuad {
  const sq = (p: Pt) => ({ x: p.x * aspect, y: p.y })
  const fingers: [number, number][] = [[2, 4], [5, 8]]
  let s = 0
  let c = 0
  for (const h of [left, right]) {
    for (const [a, b] of fingers) {
      const p = sq(h[a]!)
      const q = sq(h[b]!)
      const ang = Math.atan2(q.y - p.y, q.x - p.x)
      s += Math.sin(4 * ang)
      c += Math.cos(4 * ang)
    }
  }
  const tilt = Math.atan2(s, c) / 4
  const tips = [left[4]!, left[8]!, right[4]!, right[8]!].map(sq)
  const mid = tips.reduce((m, p) => ({ x: m.x + p.x / 4, y: m.y + p.y / 4 }), { x: 0, y: 0 })
  const cos = Math.cos(tilt)
  const sin = Math.sin(tilt)
  const local = tips.map((p) => ({ x: (p.x - mid.x) * cos + (p.y - mid.y) * sin, y: -(p.x - mid.x) * sin + (p.y - mid.y) * cos }))
  const x0 = Math.min(...local.map((p) => p.x))
  const x1 = Math.max(...local.map((p) => p.x))
  const y0 = Math.min(...local.map((p) => p.y))
  const y1 = Math.max(...local.map((p) => p.y))
  const lx = (x0 + x1) / 2
  const ly = (y0 + y1) / 2
  return {
    x: (mid.x + lx * cos - ly * sin) / aspect,
    y: mid.y + lx * sin + ly * cos,
    hw: Math.max(MIN_HALF, (x1 - x0) / 2),
    hh: Math.max(MIN_HALF, (y1 - y0) / 2),
    tilt,
  }
}

const ease = (t: number) => t * t * (3 - 2 * t)
const SMOOTH = 0.45 // the pane following the hands, each frame (the tracker's points arrive at ~30 a second)

/** The glass over time: `update` each drawn frame with whether S1's FRAME is held and the pane the hands make. */
export function createGlass(opts: { reduced?: boolean; aspect?: number } = {}) {
  const reduced = opts.reduced === true
  const aspect = opts.aspect ?? 16 / 9
  let on = false
  let heldAt = -Infinity
  let index = -1 // GLASS_TYPES' index; the first frame is THERMAL
  let fade = 0 // linear 0-1; `mix` is it eased
  let crackAt = -Infinity
  let onAt = 0
  let cracked = 0 // the signal's crackAt
  let last: number | null = null
  let quad: GlassQuad | null = null
  return {
    update(now: number, held: boolean, pane: GlassQuad | null): GlassFrame {
      const dt = last === null ? 0 : Math.max(0, now - last)
      last = now
      if (held && pane) heldAt = now
      const want = now - heldAt < EXIT_HOLD_MS
      let changed = false
      if (want && !on) {
        on = true
        index = (index + 1) % GLASS_TYPES.length
        crackAt = -Infinity
        onAt = now
        changed = true
      } else if (!want && on) {
        on = false
        crackAt = reduced ? -Infinity : now
        if (!reduced) cracked = now
      }
      fade = Math.min(1, Math.max(0, fade + ((on ? 1 : -1) * dt) / FADE_MS))
      if (pane && on) {
        const k = quad ? SMOOTH : 1
        const lerp = (a: number, b: number) => a + (b - a) * k
        quad = quad ? { x: lerp(quad.x, pane.x), y: lerp(quad.y, pane.y), hw: lerp(quad.hw, pane.hw), hh: lerp(quad.hh, pane.hh), tilt: lerp(quad.tilt, pane.tilt) } : pane
      }
      const crack = crackAt > -Infinity && fade > 0 ? Math.min(1, (now - crackAt) / CRACK_MS) : -1
      if (fade === 0 && !on) {
        quad = null
        crackAt = -Infinity
      }
      const type: GlassType = reduced ? 'plain' : GLASS_TYPES[Math.max(0, index)]!
      const size = quad ? Math.min(1, Math.max(0, (Math.hypot(2 * quad.hw, 2 * quad.hh) / aspect - 0.08) / 0.62)) : 0
      latest = quad && on
        ? { on: true, type, size, tilt: quad.tilt / (Math.PI / 4), x: quad.x, y: quad.y, crackAt: cracked }
        : { ...OFF, type, crackAt: cracked }
      return { mix: ease(fade), type, crack, quad, changed, age: (now - onAt) / 1000 }
    },
  }
}
