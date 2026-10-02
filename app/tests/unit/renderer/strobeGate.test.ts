import { describe, expect, it } from 'vitest'
import { strobeGate } from '@/components/camera/vision'

describe("the tracker's strobe gate", () => {
  it("skips a strobe's blackout, but darker for longer is the room's new light (tracking never stalls)", () => {
    const s = { light: -1, darkSince: -1 }
    expect(strobeGate(s, 0.8, 0)).toBe(false)
    expect(strobeGate(s, 0.1, 33)).toBe(true) // a blackout: skipped
    expect(strobeGate(s, 0.8, 66)).toBe(false)
    expect(s.light).toBeCloseTo(0.8)
    for (let t = 100; t < 390; t += 33) expect(strobeGate(s, 0.2, t)).toBe(true) // the lights go down...
    expect(strobeGate(s, 0.2, 420)).toBe(false) // ...and stay down: tracked again
    expect(s.light).toBeCloseTo(0.2)
    expect(strobeGate(s, 0.2, 453)).toBe(false)
  })
})
