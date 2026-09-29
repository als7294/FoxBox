import { describe, expect, it } from 'vitest'
import { DEMO_BPM, demoBeat, glowEnvelope } from '@/components/camera/maskBuild'

describe('MASKS stage beat', () => {
  it('the demo drop: 8 bars of build, then the drop; a forced drop lands 2 beats in', () => {
    const beat = 60 / DEMO_BPM
    expect(demoBeat(beat * 31.5, true, null).inDrop).toBe(false)
    expect(demoBeat(beat * 32.5, true, null).inDrop).toBe(true)
    expect(demoBeat(10 + beat * 2.2, false, 10)).toMatchObject({ on: true, inDrop: true })
    expect(demoBeat(10 + 6, false, 10).on).toBe(false) // 5 s, then over
  })

  it('the glow never flashes more than 3 times a second, and is still without a beat', () => {
    for (const react of ['drop', 'steady'] as const) {
      let low = Infinity
      let n = 0
      for (let t = 0; t < 30; t += 1 / 120) {
        const e = glowEnvelope(demoBeat(t, true, null), react, t, false)
        if (e < low) low = e
        else if (e - low > 0.25) {
          n++
          low = e
        }
      }
      expect(n / 30, react).toBeLessThanOrEqual(3)
    }
    expect(glowEnvelope(demoBeat(3, false, null), 'drop', 3, false)).toBe(1)
    expect(glowEnvelope(demoBeat(3, true, null), 'off', 3, false)).toBe(1)
  })
})
