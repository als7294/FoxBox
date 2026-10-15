/**
 * ONE-HANDED's hold ring (S3, 2.0.1; STRINGS_UX "Holds"): a hold that toggles something (an effect shape, the one-L
 * frame) shows a small ring at the hand, in the design's language: its hold-to-load ring, the accent filling clockwise
 * from 12 o'clock over a faint track, round caps (stringTokens' `ring`). Nothing for the first HOLD_RING.hideMs, so
 * passing shapes stay quiet; then it fills from empty, full as the hold fires, and a fired hold glows out (one let go
 * early just goes). Each performer hand's progress is playFeed.hold's (S4: inst.holdProgress, and S1's L hold).
 * Reduced motion: the ring still fills; its glow fades without growing.
 */
import type { Pt } from '@/components/camera/camMath'
import type { StageHands } from '@/components/camera/smartCamera'
import { playFeed } from './playFeed'
import { stageHand } from './playStrings'
import { liveTokens, rgba, type StringsMode } from './stringTokens'

export const HOLD_RING = { hideMs: 200, inMs: 120, glowMs: 450 }
const PALM = 9

/** A hand's ring over time (stepRing). */
export interface RingState {
  start: number
  first: number
  shownAt: number
  from: number
  last: number
  lastAt: number
  firedAt: number
}
export const newRing = (): RingState => ({ start: -1, first: 0, shownAt: -1, from: 0, last: 0, lastAt: 0, firedAt: -Infinity })

/** One frame of a hand's hold (`p`: its progress, 0 with none or once fired): the fill to draw, 0-1, or -1 hidden. */
export function stepRing(s: RingState, p: number, now: number): number {
  if (p > 0) {
    if (s.start < 0 || p < s.last - 0.05) Object.assign(s, { start: now, first: p, shownAt: -1 }) // a new hold
    if (s.shownAt < 0 && now - s.start >= HOLD_RING.hideMs) Object.assign(s, { shownAt: now, from: p })
    Object.assign(s, { last: p, lastAt: now })
    return s.shownAt < 0 ? -1 : Math.min(1, Math.max(0, (p - s.from) / Math.max(1e-3, 1 - s.from)))
  }
  if (s.start >= 0) {
    // it's ended: fired if, at the rate it was filling, it was due by now; else let go
    const rate = (s.last - s.first) / Math.max(1, s.lastAt - s.start)
    if (s.shownAt >= 0 && s.last + rate * (now - s.lastAt) >= 0.97) s.firedAt = now
    Object.assign(s, { start: -1, shownAt: -1, last: 0 })
  }
  return -1
}

export function createHoldRing(mode: StringsMode, opts: { reduced?: boolean } = {}) {
  const tokens = liveTokens(mode)
  const rings = { left: newRing(), right: newRing() }
  const seen: Record<'left' | 'right', Pt | null> = { left: null, right: null } // where a glow goes out if the hand's lost
  return {
    draw(ctx: CanvasRenderingContext2D, hands: StageHands, now: number, w: number, h: number): void {
      const tk = tokens(now).ring
      const px = h / 620 // the design stage's units
      const ring = (c: Pt, fill: number, alpha: number, scale: number, glow: number) => {
        const [x, y, r] = [c.x * w, c.y * h, tk.size * px * scale]
        ctx.save()
        ctx.globalAlpha = alpha
        ctx.lineWidth = tk.width * px
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.strokeStyle = rgba(tk.track, 1)
        ctx.stroke()
        if (fill > 0) {
          ctx.shadowColor = rgba(tk.color, glow > 0 ? 1 : 0)
          ctx.shadowBlur = glow * px
          ctx.beginPath()
          ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + fill * Math.PI * 2)
          ctx.strokeStyle = rgba(tk.color, 1)
          ctx.stroke()
        }
        ctx.restore()
      }
      for (const hand of ['left', 'right'] as const) {
        const s = rings[hand]
        const fill = stepRing(s, playFeed.hold?.(hand) ?? 0, now)
        const at = stageHand(hands, hand)?.[PALM] ?? null
        if (at) seen[hand] = at
        if (fill >= 0 && at) {
          const k = Math.min(1, (now - s.shownAt) / HOLD_RING.inMs)
          ring(at, fill, k, opts.reduced ? 1 : 0.8 + 0.2 * k, 0)
        } else if (now - s.firedAt < HOLD_RING.glowMs && seen[hand]) {
          const g = (now - s.firedAt) / HOLD_RING.glowMs
          ring(seen[hand]!, 1, (1 - g) * (1 - g), opts.reduced ? 1 : 1 + 0.35 * g, tk.glow)
        }
      }
    },
  }
}
