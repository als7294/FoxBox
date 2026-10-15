// The GUIDE's demo sounds (audio/guideDemo.ts): a phrase for every step, quiet, ducking while you play. (Rendered on
// the real instrument and chain in the hidden proofs.)
import { describe, expect, it, vi } from 'vitest'

vi.mock('tone', () => ({}))
vi.mock('@/components/camera/smartCamera', () => ({ cameraSignals: () => ({}), onPluck: () => () => {} }))

describe("the GUIDE's demos", () => {
  it('every step has its phrase inside its loop; quiet (-12 dB), ducking -20 dB more while you play and 1.2 s after', async () => {
    const { DEMO_DB, PHRASES, duckTarget } = await import('@/audio/guideDemo')
    expect(Object.keys(PHRASES)).toEqual(['pluck', 'height', 'twist', 'shake', 'octave', 'preset', 'frame', 'record', 'tearout', 'bands', 'drop', 'glass'])
    for (const [id, p] of Object.entries(PHRASES)) {
      expect(p.steps.length, id).toBeGreaterThan(0)
      expect(p.steps.every(([t]) => t >= 0 && t < p.period), id).toBe(true)
    }
    expect(DEMO_DB).toBe(-12)
    expect([duckTarget(1000, 500), duckTarget(3000, 500), duckTarget(1000, -Infinity)]).toEqual([0.1, 1, 1])
  })
})
