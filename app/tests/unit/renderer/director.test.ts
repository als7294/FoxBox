import { describe, expect, it } from 'vitest'
import type { Scene } from '@/visuals/live/compositor'
import { AutoDirector } from '@/visuals/live/director'
import type { AudioFrame } from '@/visuals/live/registry'

const scene: Scene = {
  base: { kind: 'core' },
  paletteId: 'transmission',
  effects: [
    { id: 'a', styleId: 's1', opacity: 0.8, blend: 'add', reactTo: 'mix', enabled: true },
    { id: 'b', styleId: 's2', opacity: 0.6, blend: 'screen', reactTo: 'drums', enabled: true },
    { id: 'locked', styleId: 's3', opacity: 0.5, blend: 'normal', reactTo: 'mix', enabled: true, locked: true },
  ],
}
const frame = (t: number, extra: Partial<AudioFrame>): AudioFrame => ({
  time: t, rms: 0.5, bands: { low: 0.5, mid: 0.5, high: 0.5 }, onset: 0, fft: null, waveL: null, waveR: null, sampleRate: 48000,
  bpm: 120, beatPhase: (t * 2) % 1, active: true, bar: Math.floor(t / 2) + 1, barPhase: (t / 2) % 1, ...extra,
})

describe('AUTO-VJ director', () => {
  it('builds tension, holds before the drop, cuts on each drop differently, breathes in breakdowns', () => {
    const d = new AutoDirector({ reduced: () => false })
    expect(d.frame(frame(0, { section: 'intro' }), scene)).toBeNull() // AUTO off
    d.setEnabled(true)
    const early = d.frame(frame(10, { section: 'build', buildProgress: 0.1 }), scene)!
    const late = d.frame(frame(15, { section: 'build', buildProgress: 0.95 }), scene)!
    expect(late.layers!.a!.params!.intensity!).toBeGreaterThan(early.layers!.a!.params!.intensity!)
    expect(late.speed!).toBeGreaterThan(early.speed!)
    expect(late.layers!.locked).toBeUndefined() // locked layers are never touched
    const held = d.frame(frame(15.9, { section: 'build', buildProgress: 0.99, preDrop: true }), scene)!
    expect(held.speed!).toBeLessThan(0.2)
    expect(held.layers!.b!.opacity!).toBeLessThan(0.3)
    for (let t = 15; t < 15.9; t += 1 / 60) d.frame(frame(t, { section: 'build', buildProgress: 0.7 }), scene)
    const drained = d.frame(frame(15.9, { section: 'build', buildProgress: 0.7 }), scene)!
    expect(drained.saturation!).toBeLessThan(0.4) // the colour drains through the build
    const hit1 = d.frame(frame(16, { section: 'drop', dropHit: true, dropEnergy: 1, dropIndex: 1 }), scene)!
    expect(hit1.punch).toBe(1)
    expect(hit1.saturation).toBeCloseTo(1.3) // back hot, as a cut
    const groove = d.frame(frame(17, { section: 'drop', dropEnergy: 0.25, dropIndex: 1 }), scene)!
    expect(groove.layers!.a!.params!.intensity!).toBeGreaterThan(early.layers!.a!.params!.intensity!) // hotter than before the build
    const hit2 = d.frame(frame(60, { section: 'drop', dropHit: true, dropEnergy: 1, dropIndex: 2 }), scene)!
    expect(hit2.hueShift).not.toBeCloseTo(hit1.hueShift!) // the second drop cuts elsewhere
    const breathe = d.frame(frame(80, { section: 'breakdown' }), scene)!
    expect(breathe.speed!).toBeLessThan(1)
  })

  it('stays calm with reduced motion and follows the bass line', () => {
    const d = new AutoDirector({ reduced: () => true })
    d.setEnabled(true)
    const hit = d.frame(frame(16, { section: 'drop', dropHit: true, dropEnergy: 1, dropIndex: 1 }), scene)!
    expect(hit.punch).toBe(0)
    expect(hit.speed!).toBeLessThanOrEqual(1.1)
    const bass = { on: true, noteOn: false, heldBeats: 4, expectBeats: 8, sub: 1, growl: 0, pitch: 45, glide: 0, wobble: { div: null, phase: 0 } }
    const held = new AutoDirector({ reduced: () => false })
    held.setEnabled(true)
    const z = held.frame(frame(20, { section: 'verse', bass }), scene)!.layers!.a!.params!.zoom!
    expect(z).toBeCloseTo(0.25) // halfway through an 8-beat sub: the stretch is halfway
    const half = held.frame(frame(21, { section: 'verse', feel: { halfTime: true, style: 'dubstep' } }), scene)!
    expect(half.speed!).toBeCloseTo(0.5)
  })
})
