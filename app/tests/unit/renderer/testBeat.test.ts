import { describe, expect, it } from 'vitest'
import { STEMS } from '@/audio/live/songFx'
import { renderTestBeat, TEST_BEAT } from '@/audio/live/testBeat'

const SR = 24000
const beat = renderTestBeat(SR)
const rms = (a: Float32Array, i0: number, n: number) => Math.sqrt(a.subarray(i0, i0 + n).reduce((s, v) => s + v * v, 0) / n)

describe("STRINGS' TEST BEAT", () => {
  it('an 8-bar loop at 120 BPM in the four stems, stereo, with headroom together', () => {
    const n = Math.round(TEST_BEAT.bars * 4 * (60 / TEST_BEAT.bpm) * SR)
    for (const s of STEMS) {
      expect(beat[s]).toHaveLength(2)
      expect(beat[s][0]).toHaveLength(n)
      expect(rms(beat[s][0], 0, n)).toBeGreaterThan(0.01) // each stem plays
    }
    let peak = 0
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(STEMS.reduce((sum, s) => sum + beat[s][0][i]!, 0)))
    expect(peak).toBeLessThan(1)
  })

  it('the kick lands on the beat, and the loop point has no seam', () => {
    const d = beat.drums[0]
    const beatN = (60 / TEST_BEAT.bpm) * SR
    expect(rms(d, Math.round(beatN), 600)).toBeGreaterThan(4 * rms(d, Math.round(beatN * 0.75), 600)) // on the beat vs just before
    for (const s of STEMS) {
      const a = beat[s][0]
      expect(Math.abs(a[0]! - a[a.length - 1]!)).toBeLessThan(0.2) // what rings past the end wrapped to the start
    }
  })
})
