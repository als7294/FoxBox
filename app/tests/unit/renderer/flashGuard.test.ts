import { describe, expect, it } from 'vitest'
import { cellsFromRgba, FlashGuard, NO_HOLD, type Hold } from '../../../src/renderer/src/visuals/live/flashGuard'

const N = 256
const grey = (v: number) => cellsFromRgba(new Uint8ClampedArray(N * 4).map((_, i) => (i % 4 === 3 ? 255 : v)))
const red = (v: number) => cellsFromRgba(new Uint8ClampedArray(N * 4).map((_, i) => (i % 4 === 0 ? v : i % 4 === 3 ? 255 : 0)))

/** Runs frames at `fps` for `seconds`, `at(t)` giving each frame; returns the hold per frame. */
function run(g: FlashGuard, fps: number, seconds: number, at: (t: number) => ReturnType<typeof grey>): Hold[] {
  const out: Hold[] = []
  for (let i = 0; i < fps * seconds; i++) out.push(g.observe(i / fps, at(i / fps)))
  return out
}

describe('FlashGuard (WCAG 2.3.1)', () => {
  it('lets 3 flashes a second through, then holds a strobe back so what shows stays within 3', () => {
    const g = new FlashGuard()
    const fps = 30
    const luma: number[] = []
    const holds: Hold[] = []
    for (let i = 0; i < fps * 2; i++) {
      const v = i % 2 ? 1 : 0 // full black / white strobe, 15 Hz
      const h = g.observe(i / fps, grey(v ? 255 : 0))
      holds.push(h)
      luma.push(Math.min(1, v * h.gain + h.lift)) // what shows: this frame, corrected (never an earlier frame)
    }
    const turns: number[] = []
    let anchor = luma[0]!
    for (let i = 1; i < luma.length; i++) {
      if (Math.abs(luma[i]! - anchor) >= 0.1) {
        turns.push(i / fps)
        anchor = luma[i]!
      }
    }
    for (const t0 of turns) expect(turns.filter((t) => t >= t0 && t - t0 < 1).length).toBeLessThanOrEqual(6)
    expect(turns.length).toBeGreaterThan(0)
    // From dark, the white frames are held back by a gain (the black ones need nothing).
    expect(holds.some((h) => h.gain < 1)).toBe(true)
    expect(holds.every((h) => h.lift === 0)).toBe(true)
  })

  it('from a white picture, black flashes are held back by a lift (added light), not by an earlier frame', () => {
    const holds = run(new FlashGuard(), 30, 1, (t) => grey(Math.floor(t * 30) % 2 ? 0 : 255))
    expect(holds.some((h) => h.lift > 0)).toBe(true)
  })

  it('never touches 2 flashes a second, a slow fade or a steady picture', () => {
    const pulse = run(new FlashGuard(), 60, 3, (t) => grey((t * 2) % 1 < 0.5 ? 230 : 20))
    expect(pulse.every((h) => h === NO_HOLD)).toBe(true)
    const fade = run(new FlashGuard(), 60, 2, (t) => grey(Math.round(255 * t * 0.5)))
    expect(fade.every((h) => h === NO_HOLD)).toBe(true)
    expect(run(new FlashGuard(), 60, 1, () => grey(128)).every((h) => h === NO_HOLD)).toBe(true)
  })

  it('holds saturated red flashes back by desaturating', () => {
    const holds = run(new FlashGuard(), 20, 1, (t) => (Math.floor(t * 20) % 2 ? red(255) : grey(40)))
    expect(holds.slice(12).some((h) => h.saturate < 1)).toBe(true)
  })

  it('ignores flashes that cover less than a quarter of the frame', () => {
    const small = (on: boolean) =>
      cellsFromRgba(new Uint8ClampedArray(N * 4).map((_, i) => (i % 4 === 3 ? 255 : on && i < N * 4 * 0.2 ? 255 : 0)))
    expect(run(new FlashGuard(), 30, 1, (t) => small(Math.floor(t * 30) % 2 === 1)).every((h) => h === NO_HOLD)).toBe(true)
  })
})
