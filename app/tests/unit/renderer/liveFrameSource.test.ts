import { describe, expect, it } from 'vitest'
import { bytesFromDb, FluxOnset, gridClock, inDrop, waveBytes } from '@/visuals/live/liveSource'

describe('AudioFrame source helpers', () => {
  it('maps spectra, waves, the plain grid, the drop window and onsets', () => {
    // 1024 dB bins → 512 bytes like getByteFrequencyData (-100..-30 dB)
    const db = Float32Array.from({ length: 1024 }, (_, i) => (i < 2 ? -30 : -100))
    const out = bytesFromDb(db, new Uint8Array(512))
    expect([out[0], out[1], out[511]]).toEqual([255, 0, 0])
    expect([...waveBytes([0, 1, -1], new Uint8Array(3))]).toEqual([128, 255, 0])
    expect(gridClock(2.25, 120)).toEqual({ beatPhase: 0.5, bar: 2, barPhase: 0.125 }) // beat 4.5 at 120 BPM
    expect([inDrop(40.6, 40.59, 1.66), inDrop(42.3, 40.59, 1.66), inDrop(10, null, 1.66)]).toEqual([true, false, false])
    const flux = new FluxOnset()
    const quiet = new Uint8Array(64).fill(10)
    let hit = 0
    for (let f = 0; f < 20; f++) hit = flux.push(quiet, f * 0.016)
    expect(hit).toBe(0)
    expect(flux.push(new Uint8Array(64).fill(200), 0.4)).toBeGreaterThan(1) // a hit after a steady run
  })
})
