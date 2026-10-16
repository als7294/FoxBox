/**
 * SAUCE's Melody mode (LOOP, 2.1; STRINGS_UX "SAUCE: Melody mode"): instead of pluck strings, a glass ring of light
 * centred between the hands, in the strings' look (lightString.ts's layers: a soft halo, a core, a hot filament).
 * - The loop's notes are dots around it (from 12 o'clock, clockwise; a higher note sits a little further out). The
 *   one playing glows, fading after it.
 * - A playhead circles it once per bar: a short bright arc. Reduced motion: it steps per beat.
 * - The four controls (S2's playFeed.loop): brightness makes it glow, register raises or lowers it, space widens and
 *   softens it, and a drop dims it to an outline.
 * - A small handle at each palm, labelled while it's learnt: BRIGHTER (the right hand), HIGHER (the left). The label
 *   goes after its control's been used 3 times (remembered on this Mac). Labels are animation text, so they're big or
 *   nothing (≥ 28 px at 1280 wide, the user's rule).
 */
import type { PlayHand } from '@/audio/play/instrument'
import type { Pt } from '@/components/camera/camMath'
import { t } from '@/i18n'
import { depthScale, drawFingertip, type LightLook } from './lightString'
import type { MelodyLoop } from './playFeed'
import { mix, rgba } from './stringTokens'

export const RING = {
  /** Its radius at no space (picture heights), and how much space widens it (× 1 + this). */
  radius: 0.13,
  spaceGrow: 0.6,
  /** How far a register step raises it (picture heights). */
  lift: 0.07,
  /** A note's glow after it starts (ms). */
  noteMs: 500,
  /** Uses before a label goes. */
  learnUses: 3,
}
const PALM = 9

/** The ring's centre and radius (picture 0-1, the radius in picture heights): between the palms, raised by the
 *  register, widened by space. */
export function ringGeometry(right: Pt | null | undefined, left: Pt | null | undefined, loop: Pick<MelodyLoop, 'register' | 'space'>): { x: number; y: number; r: number } {
  const c = right && left ? { x: (right.x + left.x) / 2, y: (right.y + left.y) / 2 } : (right ?? left ?? { x: 0.5, y: 0.5 })
  return { x: c.x, y: c.y - loop.register * RING.lift, r: RING.radius * (1 + RING.spaceGrow * Math.min(1, Math.max(0, loop.space))) }
}

/** The playhead's angle (radians clockwise from 12 o'clock): once round per bar, or a step per beat (reduced). */
export const playheadAngle = (loop: Pick<MelodyLoop, 'phase' | 'beat' | 'beats'>, reduced: boolean): number =>
  2 * Math.PI * (reduced ? loop.beat / Math.max(1, loop.beats) : Math.min(1, Math.max(0, loop.phase)))

type Control = 'brightness' | 'register'
const HINTS_KEY = 'foxbox-loop-hints'

/** The palm labels' learning: a use is brightness moved ≥ 0.3 from where the last one ended, or a register change. */
export function createLoopHints(storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage) {
  let uses: Record<Control, number> = { brightness: 0, register: 0 }
  try {
    uses = { ...uses, ...(JSON.parse(storage?.getItem(HINTS_KEY) ?? '{}') as Partial<Record<Control, number>>) }
  } catch {
    // unreadable: learn again
  }
  const anchor: Record<Control, number | null> = { brightness: null, register: null }
  const learntAt: Record<Control, number> = { brightness: -Infinity, register: -Infinity }
  const used = (c: Control, now: number) => {
    uses[c]++
    if (uses[c] === RING.learnUses) learntAt[c] = now
    try {
      storage?.setItem(HINTS_KEY, JSON.stringify(uses))
    } catch {
      // storage off: it's learnt for this run only
    }
  }
  return {
    note(loop: Pick<MelodyLoop, 'brightness' | 'register'>, now: number): void {
      const b = anchor.brightness
      if (b === null) anchor.brightness = loop.brightness
      else if (Math.abs(loop.brightness - b) >= 0.3) {
        anchor.brightness = loop.brightness
        used('brightness', now)
      }
      if (anchor.register !== null && loop.register !== anchor.register) used('register', now)
      anchor.register = loop.register
    },
    /** A label's opacity: 1 while it's learnt, fading over 1.5 s from its last use. */
    alpha(c: Control, now: number): number {
      if (uses[c] < RING.learnUses) return 1
      return Math.max(0, 1 - (now - learntAt[c]) / 1500)
    },
    uses: (c: Control) => uses[c],
  }
}
export type LoopHints = ReturnType<typeof createLoopHints>

/** The ring, its notes, playhead and palm handles onto ctx (w × h px), its composite mode left at source-over. */
export function drawLoopRing(
  ctx: CanvasRenderingContext2D,
  hands: { right: Pt[] | null; left: Pt[] | null },
  loop: MelodyLoop,
  o: { now: number; w: number; h: number; look: LightLook; hints: LoopHints; reduced: boolean; noteAt: number[] },
): void {
  const { now, w, h, look } = o
  const aspect = w / Math.max(1, h)
  const geo = ringGeometry(hands.right?.[PALM], hands.left?.[PALM], loop)
  const [cx, cy, r] = [geo.x * w, geo.y * h, geo.r * h]
  const depth = Math.sqrt(depthScale(hands.right, aspect) * depthScale(hands.left, aspect))
  const bright = Math.min(1, Math.max(0, loop.brightness))
  const soft = Math.min(1, Math.max(0, loop.space))
  const out = loop.dropped
  const width = look.width * depth
  const glow = mix(look.glow, [255, 214, 170], 0.3 * bright)
  ctx.globalCompositeOperation = 'lighter'
  const circle = (lw: number, col: readonly number[], al: number) => {
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.lineWidth = lw
    ctx.strokeStyle = rgba(col, al)
    ctx.stroke()
  }
  if (out) circle(width, look.core, 0.35) // dropped: an outline
  else {
    circle(width * (9 + 8 * soft), glow, (0.05 + 0.12 * bright) * (1 - 0.3 * soft))
    circle(width * (3.2 + 3 * soft), mix(glow, look.core, 0.45), (0.12 + 0.22 * bright) * (1 - 0.35 * soft))
    circle(width, look.core, (0.6 + 0.3 * bright) * (1 - 0.45 * soft))
    circle(width * 0.4, mix(look.core, [255, 255, 255], 0.6), (0.45 + 0.4 * bright) * (1 - 0.6 * soft))
  }
  // the playhead: a short bright arc, its head a point of light
  const a = playheadAngle(loop, o.reduced) - Math.PI / 2
  if (!out) {
    ctx.beginPath()
    ctx.arc(cx, cy, r, a - 0.22, a)
    ctx.lineWidth = width * 2.2
    ctx.lineCap = 'round'
    ctx.strokeStyle = rgba([255, 255, 255], 0.35 + 0.35 * bright)
    ctx.stroke()
    drawFingertip(ctx, { x: (cx + Math.cos(a) * r) / w, y: (cy + Math.sin(a) * r) / h }, w, h, look, depth, 0.6 + 0.4 * bright)
  }
  // the notes: dots round it, a higher note a little further out; the one playing glows, fading after
  const n = loop.notes.length
  const sorted = [...loop.notes].sort((p, q) => p - q)
  loop.notes.forEach((midi, i) => {
    const rank = n > 1 ? sorted.indexOf(midi) / (n - 1) : 0.5
    const ang = (2 * Math.PI * i) / Math.max(1, n) - Math.PI / 2
    const rr = r * (1 + 0.16 * (rank - 0.5))
    const p = { x: (cx + Math.cos(ang) * rr) / w, y: (cy + Math.sin(ang) * rr) / h }
    const lit = o.reduced ? (loop.playing === i ? 1 : 0) : Math.max(0, 1 - (now - (o.noteAt[i] ?? -Infinity)) / RING.noteMs)
    if (out) {
      ctx.globalCompositeOperation = 'source-over'
      ctx.beginPath()
      ctx.arc(p.x * w, p.y * h, 3 * look.px * depth, 0, Math.PI * 2)
      ctx.lineWidth = Math.max(1, look.px)
      ctx.strokeStyle = rgba(look.core, 0.4)
      ctx.stroke()
      ctx.globalCompositeOperation = 'lighter'
    } else drawFingertip(ctx, p, w, h, look, depth * (0.8 + 0.5 * lit), lit)
  })
  // the palm handles, each with its label while it's learnt (big or nothing)
  ctx.globalCompositeOperation = 'source-over'
  const label = 28 * (w / 1280)
  const handle = (hand: PlayHand, text: string, c: Control) => {
    const palm = hands[hand]?.[PALM]
    if (!palm) return
    const [x, y] = [palm.x * w, palm.y * h]
    ctx.beginPath()
    ctx.arc(x, y, 9 * look.px * depth, 0, Math.PI * 2)
    ctx.lineWidth = Math.max(1.5, 2 * look.px)
    ctx.strokeStyle = rgba(look.core, 0.55)
    ctx.stroke()
    const al = o.hints.alpha(c, now)
    if (al <= 0.01) return
    ctx.save()
    ctx.globalAlpha = al
    ctx.font = `800 ${label.toFixed(1)}px Geist, system-ui, sans-serif`
    ctx.letterSpacing = `${(0.06 * label).toFixed(2)}px`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)'
    ctx.shadowBlur = 12 * look.px
    ctx.fillStyle = '#FFFFFF'
    ctx.fillText(text, x, y - 18 * look.px * depth)
    ctx.restore()
  }
  handle('right', t('loop.handle.brighter', 'BRIGHTER'), 'brightness')
  handle('left', t('loop.handle.higher', 'HIGHER'), 'register')
}

