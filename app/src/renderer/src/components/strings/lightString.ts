/**
 * Strings of light (S3, 2.0.2; the user: "the strings look fake/cartoony"). One string between two fingertips, drawn
 * the way a lit filament reads on camera rather than as a neon tube:
 * - a tapered ribbon (thin at the fingertips, fullest mid-span), its width following each end's depth: a hand further
 *   away (a smaller palm) draws its end thinner, and a hand far from the focus distance draws it softer;
 * - a hot inner filament, brighter than its halo; the halo soft and wide, low in alpha;
 * - vibration as a real plucked string: a damped standing wave (the first three modes), its amplitude from the pluck's
 *   velocity, decaying over the sound's ring; drawn as sub-frame passes, so a fast-ringing string blurs into its
 *   envelope the way a camera sees one;
 * - a faint specular glint drifting along it.
 * Everything adds light ('lighter') on the strings' own transparent layer, over a faint soft shadow (source-over): on a
 * bright wall a light can't add, so the shadow gives the filament its edge there, and in a dark room it disappears.
 * Fingertips: a small soft point and a spill of warm light on the fingertip (brighter on a pluck).
 */
import type { Pt } from '@/components/camera/camMath'
import { mix, rgba, type Rgb } from './stringTokens'

const N = 28 // samples along a string
const MODES = [1, 0.3, 0.12] // the standing wave's first three modes' shares
export const REF_PALM = 0.16 // a hand at the focus distance: wrist → middle knuckle, picture heights
const TAPER = 0.35 // a string's width at a fingertip, of its mid-span width
const SHADOW: Rgb = [38, 22, 12]

/** How near a hand is (its palm against REF_PALM), 0.55 … 1.6: its strings' width and softness follow it. */
export function depthScale(hand: readonly Pt[] | null | undefined, aspect: number): number {
  const a = hand?.[0]
  const b = hand?.[9]
  if (!a || !b) return 1
  return Math.min(1.6, Math.max(0.55, Math.hypot((b.x - a.x) * aspect, b.y - a.y) / REF_PALM))
}

/** Out of focus, 0 … 1: a hand far nearer or further than the focus distance. */
export const defocus = (scale: number): number => Math.min(1, Math.abs(Math.log(scale)) / Math.log(2.2))

export interface Ring {
  /** Seconds since the pluck. */
  age: number
  /** Its velocity, 0-1. */
  velocity: number
  /** The sound's ring (s): the wave decays to ~5% over it. */
  ring: number
  /** The fundamental's on-screen rate (Hz): a few cycles a frame would alias; this reads as a shimmer. */
  hz: number
  /** Its phase offset (radians): neighbouring strings don't ring in step. */
  phase: number
}

/** The standing wave's offset at s (0-1 along the string), `age` seconds in, in units of its amplitude. */
export function wave(s: number, age: number, hz: number, phase: number): number {
  let y = 0
  MODES.forEach((c, k) => (y += c * Math.sin((k + 1) * Math.PI * s) * Math.cos(2 * Math.PI * (k + 1) * hz * age + phase * (k + 1))))
  return y
}

/** The ring's amplitude now, 0-1 of the pluck's (damped: ~5% at `ring`). */
export const decay = (r: Ring): number => (r.age < 0 ? 0 : Math.exp((-3 * r.age) / Math.max(0.05, r.ring)))

export interface LightLook {
  /** The core's colour (near white) and the halo's (the glow colour). */
  core: Rgb
  glow: Rgb
  /** The core's mid-span width at the focus distance, px. */
  width: number
  /** Px per design unit (the sag, the ring's amplitude). */
  px: number
}

export interface LightOpts {
  /** Each end's depthScale. */
  scaleA?: number
  scaleB?: number
  /** The rest sag (design units, down). */
  sag?: number
  /** The bow toward `c` instead (FLOW's line): a quadratic through it. */
  through?: Pt
  /** 0-1: a pluck's flash (brighter core and halo). */
  lit?: number
  ring?: Ring | null
  /** The ring's amplitude at full velocity, design units. */
  amp?: number
  /** Or the amplitude now, px, as the caller rings it (REMIX's hits): no velocity or decay applied. */
  ampPx?: number
  /** One hand: it fades out toward b. */
  fade?: boolean
  /** Seconds (the glint's drift) and the string's index (its own drift). */
  t?: number
  index?: number
  /** Reduced motion: no vibration passes, no glint drift. */
  still?: boolean
  /** 0-1 of this pass's alpha (the motion-blur ghosts). */
  alpha?: number
}

/**
 * One string a → b (picture 0-1) onto ctx (w × h px), its composite mode left at 'lighter'. Draws `passes` sub-frame
 * moments of a ringing string (each 1/passes of the light), one otherwise.
 */
export function drawLightString(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, w: number, h: number, look: LightLook, o: LightOpts = {}): void {
  const [ax, ay, bx, by] = [a.x * w, a.y * h, b.x * w, b.y * h]
  const len = Math.hypot(bx - ax, by - ay)
  if (len < 2) return
  const [ux, uy] = [(bx - ax) / len, (by - ay) / len]
  let [nx, ny] = [-uy, ux] // the normal, pointing down the picture (where a sag goes)
  if (ny < 0) [nx, ny] = [-nx, -ny]
  const sA = o.scaleA ?? 1
  const sB = o.scaleB ?? 1
  const soft = defocus(Math.sqrt(sA * sB))
  const lit = o.lit ?? 0
  const r = o.still ? null : o.ring
  const amp = !r ? 0 : o.ampPx ?? (o.amp ?? 16) * look.px * Math.min(1, len / (0.4 * h)) * (0.25 + 0.75 * r.velocity) * decay(r)
  const passes = amp > 0.6 ? 3 : 1
  const sag = (o.sag ?? 0) * look.px
  const through = o.through && { x: o.through.x * w, y: o.through.y * h }
  const alpha = o.alpha ?? 1
  // the ribbon at one moment (traced as ctx's path): the centre line, and the half-width at each sample
  const ribbon = (age: number, widthK: number): void => {
    const left: [number, number][] = []
    const right: [number, number][] = []
    for (let i = 0; i <= N; i++) {
      const s = i / N
      let x = ax + (bx - ax) * s
      let y = ay + (by - ay) * s
      if (through) { // a quadratic through the bow's control point
        x = (1 - s) * (1 - s) * ax + 2 * s * (1 - s) * through.x + s * s * bx
        y = (1 - s) * (1 - s) * ay + 2 * s * (1 - s) * through.y + s * s * by
      }
      const off = sag * 4 * s * (1 - s) + (amp && r ? amp * wave(s, age, r.hz, r.phase) : 0)
      x += nx * off
      y += ny * off
      const depth = sA + (sB - sA) * s
      const half = 0.5 * look.width * widthK * depth * (TAPER + (1 - TAPER) * Math.sqrt(Math.sin(Math.PI * s)))
      left.push([x + nx * half, y + ny * half])
      right.push([x - nx * half, y - ny * half])
    }
    ctx.beginPath()
    ctx.moveTo(left[0]![0], left[0]![1])
    for (const [x, y] of left.slice(1)) ctx.lineTo(x, y)
    for (const [x, y] of right.reverse()) ctx.lineTo(x, y)
    ctx.fill()
  }
  // fade (one hand's strand): each layer's colour runs out toward b
  const paint = (col: Rgb, al: number) => {
    if (!o.fade) return rgba(col, al)
    const g = ctx.createLinearGradient(ax, ay, bx, by)
    g.addColorStop(0, rgba(col, al))
    g.addColorStop(1, rgba(col, 0))
    return g
  }
  const warm = mix(look.glow, look.core, 0.45)
  const hot = mix(look.core, [255, 255, 255], 0.6)
  for (let j = 0; j < passes; j++) {
    const age = r ? r.age - j / (30 * passes) : 0 // the moments across one 30 fps frame
    const k = alpha / passes
    // the shadow: dark, soft and faint, so a bright background still shows the string's edge
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = paint(SHADOW, k * 0.2 * (1 - 0.5 * soft))
    ribbon(age, 2.6 + 2 * soft)
    ctx.globalCompositeOperation = 'lighter'
    // halo, outer then inner: wide and faint, softer (wider, dimmer) out of focus
    ctx.fillStyle = paint(look.glow, k * (0.05 + 0.1 * lit) * (1 - 0.3 * soft))
    ribbon(age, 9 + 6 * soft)
    ctx.fillStyle = paint(warm, k * (0.18 + 0.22 * lit) * (1 - 0.35 * soft))
    ribbon(age, 3.2 + 2 * soft)
    // the core, and its hotter filament: sharp in focus, melting into the halo out of it
    ctx.fillStyle = paint(look.core, k * (0.75 + 0.25 * lit) * (1 - 0.45 * soft))
    ribbon(age, 1 + 0.25 * lit)
    ctx.fillStyle = paint(hot, k * (0.55 + 0.45 * lit) * (1 - 0.6 * soft))
    ribbon(age, 0.4)
  }
  // the specular glint: a soft point of light drifting slowly along it
  if (!o.fade) {
    const sg = o.still ? 0.5 : 0.5 + 0.32 * Math.sin(0.55 * (o.t ?? 0) + 1.7 * (o.index ?? 0))
    const gx = ax + (bx - ax) * sg + nx * sag * 4 * sg * (1 - sg)
    const gy = ay + (by - ay) * sg + ny * sag * 4 * sg * (1 - sg)
    const gr = look.width * 3.5 * (sA + (sB - sA) * sg)
    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr)
    g.addColorStop(0, rgba([255, 255, 255], alpha * (0.22 + 0.3 * lit) * (1 - 0.6 * soft)))
    g.addColorStop(1, rgba([255, 255, 255], 0))
    ctx.fillStyle = g
    ctx.fillRect(gx - gr, gy - gr, 2 * gr, 2 * gr)
  }
}

/** A fingertip: a small soft point, and a spill of warm light on the fingertip (`lit` 0-1 brightens it). */
export function drawFingertip(ctx: CanvasRenderingContext2D, p: Pt, w: number, h: number, look: LightLook, scale = 1, lit = 0): void {
  const [x, y] = [p.x * w, p.y * h]
  const spill = 18 * look.px * scale
  const g = ctx.createRadialGradient(x, y, 0, x, y, spill)
  g.addColorStop(0, rgba(look.glow, 0.09 + 0.22 * lit))
  g.addColorStop(1, rgba(look.glow, 0))
  ctx.globalCompositeOperation = 'lighter'
  ctx.fillStyle = g
  ctx.fillRect(x - spill, y - spill, 2 * spill, 2 * spill)
  const dot = 4 * look.px * scale * (1 + 0.4 * lit)
  const d = ctx.createRadialGradient(x, y, 0, x, y, dot)
  d.addColorStop(0, rgba(mix(look.core, [255, 255, 255], 0.5), 0.85))
  d.addColorStop(0.35, rgba(look.core, 0.45))
  d.addColorStop(1, rgba(look.glow, 0))
  ctx.fillStyle = d
  ctx.fillRect(x - dot, y - dot, 2 * dot, 2 * dot)
}
