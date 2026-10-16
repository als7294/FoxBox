import { describe, expect, it } from 'vitest'
import { decay, defocus, depthScale, drawLightString, REF_PALM, wave } from '@/components/strings/lightString'

const hand = (palm: number) => Array.from({ length: 21 }, (_, i) => ({ x: 0.5, y: i === 9 ? 0.5 - palm : 0.5 }))

describe('strings of light', () => {
  it('rings as a standing wave pinned at both fingertips, decaying to ~5% over the sound\'s ring', () => {
    for (const age of [0, 0.03, 0.2]) {
      expect(wave(0, age, 7, 1)).toBeCloseTo(0, 9)
      expect(wave(1, age, 7, 1)).toBeCloseTo(0, 9)
    }
    expect(decay({ age: 0, velocity: 1, ring: 1, hz: 7, phase: 0 })).toBe(1)
    expect(decay({ age: 1, velocity: 1, ring: 1, hz: 7, phase: 0 })).toBeCloseTo(0.05, 2)
  })
  it('a nearer hand draws thicker, a further one thinner, both softer away from the focus distance', () => {
    expect(depthScale(hand(REF_PALM), 1)).toBeCloseTo(1, 6)
    expect(depthScale(hand(REF_PALM * 1.3), 1)).toBeGreaterThan(1)
    expect(depthScale(hand(REF_PALM * 0.1), 1)).toBe(0.55)
    expect(defocus(1)).toBe(0)
    expect(defocus(1.5)).toBeGreaterThan(defocus(1.2))
  })
  it('a ringing string draws its blur as sub-frame passes; at rest, or with reduced motion, one', () => {
    let fills = 0
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (t, k) => (k in t ? t[k as string] : k === 'fill' ? () => fills++ : k === 'createRadialGradient' || k === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {}),
      set: (t, k, v) => ((t[k as string] = v), true),
    }) as unknown as CanvasRenderingContext2D
    const look = { core: [255, 241, 222] as [number, number, number], glow: [255, 122, 31] as [number, number, number], width: 2, px: 1 }
    const ring = { age: 0.05, velocity: 1, ring: 1, hz: 7, phase: 0 }
    const count = (o: object) => {
      fills = 0
      drawLightString(ctx, { x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }, 1280, 720, look, o)
      return fills
    }
    expect(count({})).toBe(5) // its shadow, halo, inner halo, core, filament
    expect(count({ ring })).toBe(15)
    expect(count({ ring, still: true })).toBe(5)
  })
})
