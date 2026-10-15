import { describe, expect, it } from 'vitest'
import { drawGuideMove, GUIDE_MOVES } from '@/components/guide/GuideHands'

describe("the GUIDE's hand animations", () => {
  it('every move draws through its loop, and as a still (reduced motion), leaving the context as it found it', () => {
    let drawn = 0
    const state = { globalAlpha: 1 }
    const ctx = new Proxy(state as Record<string, unknown>, {
      get: (t, k) =>
        k in t ? t[k as string]
        : k === 'createLinearGradient' ? () => ({ addColorStop() {} })
        : k === 'save' ? () => stack.push(state.globalAlpha)
        : k === 'restore' ? () => void (state.globalAlpha = stack.pop() ?? 1)
        : k === 'fill' || k === 'stroke' ? () => drawn++
        : () => {},
      set: (t, k, v) => ((t[k as string] = v), true),
    }) as unknown as CanvasRenderingContext2D
    const stack: number[] = []
    expect(GUIDE_MOVES.length).toBe(19)
    for (const hands of [2, 1] as const) { // and ONE-HANDED's
      for (const m of GUIDE_MOVES) {
        for (const t of [0, 0.7, 1.9, 3.3, 3.7, 4.9, null]) {
          drawn = 0
          drawGuideMove(ctx, m, t, hands)
          expect(drawn, `${m} at ${t} (${hands})`).toBeGreaterThan(0)
          expect(state.globalAlpha, `${m} at ${t} (${hands})`).toBe(1)
        }
      }
    }
  })
})
