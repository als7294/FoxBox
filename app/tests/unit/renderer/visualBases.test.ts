import { describe, expect, it } from 'vitest'
import { drift, envelopeFromChannels, envelopeFromPeaks, fitRect, hitEnvelope, kenBurns, pool } from '@/visuals/live/bases/kit'

describe('fitRect', () => {
  it('cover fills the frame, centred, cutting the overflow', () => {
    // 16:9 into a square: height fits, the sides spill out equally.
    expect(fitRect(1600, 900, 900, 900, 'cover')).toEqual({ x: -350, y: 0, w: 1600, h: 900 })
  })
  it('contain shows all of it, letterboxed and centred', () => {
    expect(fitRect(1600, 900, 800, 800, 'contain')).toEqual({ x: 0, y: 175, w: 800, h: 450 })
  })
  it('a picture with no size yet fills the frame', () => {
    expect(fitRect(0, 0, 640, 360)).toEqual({ x: 0, y: 0, w: 640, h: 360 })
  })
})

describe('Ken Burns', () => {
  it('drifts slowly, and is still under reduced motion', () => {
    const k = kenBurns(12, false)
    expect(k.scale).toBeGreaterThanOrEqual(1.03)
    expect(k.scale).toBeLessThanOrEqual(1.09)
    expect(Math.abs(k.dx)).toBeLessThanOrEqual(0.016)
    expect(kenBurns(12, true)).toEqual({ scale: 1, dx: 0, dy: 0 })
    // a zoom about the centre keeps the centre
    const r = drift({ x: 0, y: 0, w: 100, h: 50 }, { scale: 1.2, dx: 0, dy: 0 }, 100, 50)
    expect(r.x + r.w / 2).toBeCloseTo(50)
    expect(r.y + r.h / 2).toBeCloseTo(25)
  })
})

describe('waveform bucketing', () => {
  it('follows loudness from decoded audio, normalised to the loudest bucket', () => {
    // quiet first half, loud second half
    const ch = Float32Array.from({ length: 8000 }, (_, i) => (i < 4000 ? 0.1 : 0.8) * Math.sin(i / 3))
    const env = envelopeFromChannels([ch], 8)
    expect(env.rms[7]).toBeCloseTo(1)
    expect(env.rms[0]!).toBeLessThan(0.2)
    expect(Math.max(...env.peak)).toBeCloseTo(1)
  })
  it('reads the engine peaks as amplitude and pools bars by their loudest bucket', () => {
    const env = envelopeFromPeaks({ min: [-0.5, -0.1, -1, -0.2], max: [0.5, 0.1, 1, 0.2] }, 4)
    ;[0.5, 0.1, 1, 0.2].forEach((v, i) => expect(env.rms[i]).toBeCloseTo(v))
    expect(Array.from(pool(env.rms, 2))).toEqual([0.5, 1])
    expect(pool(new Float32Array(0), 3)).toHaveLength(3)
  })
})

describe('onset envelope', () => {
  it('jumps on a hit and decays', () => {
    const h = hitEnvelope(0, 1.2, true, 16, 200)
    expect(h).toBeCloseTo(1.2)
    expect(hitEnvelope(h, 0, true, 200, 200)).toBeCloseTo(1.2 / Math.E)
    expect(hitEnvelope(0, 3, false, 16, 200)).toBe(0)
  })
})
