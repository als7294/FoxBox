import { describe, expect, it } from 'vitest'
import { HOLD_RING, newRing, stepRing } from '@/components/strings/holdRing'

// a 500 ms hold sampled at 30 fps: its progress each frame, then 0 (fired, or let go at `until`)
function run(holdMs: number, until = Infinity) {
  const s = newRing()
  const out: { t: number; fill: number }[] = []
  for (let t = 0; t <= holdMs + 100; t += 33) {
    const p = t < Math.min(holdMs, until) ? Math.max(0.001, t / holdMs) : 0
    out.push({ t, fill: stepRing(s, p, 1000 + t) })
  }
  return { s, out }
}

describe('ONE-HANDED: the hold ring', () => {
  it('stays hidden for the first ~200 ms, then fills from empty to full as the hold fires, and glows', () => {
    const { s, out } = run(500)
    expect(out.filter((f) => f.t < HOLD_RING.hideMs).every((f) => f.fill === -1)).toBe(true)
    const shown = out.filter((f) => f.fill >= 0)
    expect(shown[0]!.fill).toBe(0)
    expect(shown.at(-1)!.fill).toBeGreaterThan(0.9)
    expect(shown.every((f, i) => i === 0 || f.fill >= shown[i - 1]!.fill)).toBe(true)
    expect(s.firedAt).toBeGreaterThan(1000)
  })
  it('a hold let go early just goes (no glow); one under 200 ms never shows', () => {
    expect(run(500, 300).s.firedAt).toBe(-Infinity)
    const quick = run(500, 150)
    expect(quick.out.every((f) => f.fill === -1)).toBe(true)
    expect(quick.s.firedAt).toBe(-Infinity)
  })
})
