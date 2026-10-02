import { describe, expect, it } from 'vitest'
import { drawTdLabel } from '@/visuals/live/bases/touchdesigner'

/** A 2D context that records the pill and the text; a mono font's glyphs ~0.6 em wide. */
function fakeCtx(width: number, height: number) {
  const drawn = { rects: [] as number[][], texts: [] as [string, number, number][] }
  const ctx = {
    canvas: { width, height },
    font: '',
    save() {},
    restore() {},
    measureText: (t: string) => ({ width: t.length * Number(/(\d+)px/.exec(ctx.font)![1]) * 0.6 }),
    fillRect: (...r: number[]) => drawn.rects.push(r),
    fillText: (t: string, x: number, y: number) => drawn.texts.push([t, x, y]),
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn }
}

describe('the TOUCHDESIGNER label burned into the picture', () => {
  it.each([
    [1920, 1080, 1],
    [1080, 1080, 1],
    [1080, 1920, 2],
    [720, 1280, 2],
    [200, 400, 2],
  ])('stays whole inside a %i x %i frame (%i line(s))', (w, h, lines) => {
    const { ctx, drawn } = fakeCtx(w, h)
    drawTdLabel(ctx)
    const [x, y, rw, rh] = drawn.rects[0] as [number, number, number, number]
    expect(x).toBeGreaterThanOrEqual(0)
    expect(y).toBeGreaterThanOrEqual(0)
    expect(x + rw).toBeLessThanOrEqual(w)
    expect(y + rh).toBeLessThanOrEqual(h)
    expect(drawn.texts).toHaveLength(lines)
    expect(drawn.texts.map(([t]) => t).join(' · ')).toBe('TOUCHDESIGNER · DEMO · NON-COMMERCIAL, NOT COPYRIGHT-SAFE')
  })
})
