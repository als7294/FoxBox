import { describe, expect, it } from 'vitest'
import { TE_CHANNELS } from '../../../src/shared/touchengine'
import { channelState, frameChannels } from '../../../src/renderer/src/touchdesigner/channels'
import { silentFrame } from '../../../src/renderer/src/visuals/live/registry'

describe('TouchDesigner channels from an AudioFrame', () => {
  it('turns hits into a decaying envelope and a counter, counts beats and names the section', () => {
    const s = channelState()
    const kick = { ...silentFrame(0), bands: { low: 0.9, mid: 0.2, high: 0.1 }, stems: { drums: { rms: 0.8, onset: 2 } }, section: 'drop' as const, beatPhase: 0.9 }
    const a = frameChannels(kick, s, 1 / 60)
    expect([a.kick, a.kickcount, a.snare, a.section]).toEqual([1, 1, 0, 3])
    const b = frameChannels({ ...kick, time: 0.05, beatPhase: 0.05 }, s, 0.05) // inside the refractory: no second kick
    expect(b.kickcount).toBe(1)
    expect(b.kick).toBeCloseTo(Math.exp(-0.05 / 0.12), 5)
    expect(b.beat).toBe(1) // the phase wrapped
    expect(Object.keys(a).every((k) => (TE_CHANNELS as readonly string[]).includes(k))).toBe(true)
  })
})
