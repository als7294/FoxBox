import { describe, expect, it } from 'vitest'
import { envelopeTracker, knobLive, modulate, REACT_MOD, tdKnobs } from '@/touchdesigner/knobs'
import { silentFrame } from '@/visuals/live/registry'

describe("TouchDesigner's six knobs", () => {
  it('a knob is its value plus its source × 0.45, clamped', () => {
    expect(modulate(0.5, 0)).toBe(0.5)
    expect(modulate(0.5, 1)).toBeCloseTo(0.5 + REACT_MOD)
    expect(modulate(0.9, 1)).toBe(1)
    expect(modulate(0, 0)).toBe(0)
  })

  it('a kick hits and decays, a drop follows S2, the hands are their spread, OFF is nothing', () => {
    const env = envelopeTracker()
    const hit = { ...silentFrame(0), active: true, onset: 1.2, bands: { low: 0.8, mid: 0.2, high: 0 }, dropEnergy: 0.7 }
    const hands = { shapes: { left: { pinch: 0.25 }, right: null } } as never
    const a = env(hit, 16, hands)
    expect(a.kick).toBe(1)
    expect(a.snare).toBe(0)
    expect(a.drop).toBe(0.7)
    expect(a.hands).toBeCloseTo(0.75)
    expect(a.off).toBe(0)
    const b = env({ ...hit, onset: 0, dropEnergy: 0 }, 200, null)
    expect(b.kick).toBeLessThan(0.5)
    expect(b.hands).toBe(0)
  })

  it('tdKnobs() reads the live values by name', () => {
    knobLive.values = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]
    expect(tdKnobs()).toEqual({ intensity: 0.1, colour: 0.2, chaos: 0.3, trails: 0.4, lines: 0.5, size: 0.6 })
  })
})
