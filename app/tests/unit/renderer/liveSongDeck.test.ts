import { describe, expect, it } from 'vitest'
import { clockAt, dropBarOf, loudestSection } from '@/audio/live/songDeck'

describe('SongDeck beat clock', () => {
  it('reads bar / beat / phases off the song grid at the playhead', () => {
    const grid = { bpm: 120, downbeatS: 0.5, beatsPerBar: 4, barS: 2 }
    expect(clockAt(grid, 0.5)).toMatchObject({ beat: 0, bar: 1, beatPhase: 0, barPhase: 0 })
    const c = clockAt(grid, 2.75) // 4.5 beats in: bar 2, halfway through its first beat
    expect(c.bar).toBe(2)
    expect(c.beatPhase).toBeCloseTo(0.5)
    expect(c.barPhase).toBeCloseTo(0.125)
    expect(clockAt(grid, 0)).toMatchObject({ beat: -1, bar: 0, barPhase: 0.75 }) // the pickup before bar 1
  })

  it('cues a drop to the bar its hit falls in, or to the loudest 8 bars without one', () => {
    const grid = { bpm: 145, downbeatS: 0, beatsPerBar: 4, barS: 240 / 145 }
    expect(dropBarOf(grid, 24.52 * grid.barS)).toBe(25) // a hit two beats into bar 25, after a pre-drop gap
    expect(dropBarOf(grid, 23.95 * grid.barS)).toBe(25) // a hair before the bar line
    const hopS = 0.01
    const env = Float32Array.from({ length: Math.round((40 * grid.barS) / hopS) }, (_, i) => (i * hopS >= 17 * grid.barS && i * hopS < 29 * grid.barS ? 1 : 0.1))
    expect(loudestSection(env, hopS, grid, 40 * grid.barS)).toBe(17) // the phrase 17-24 is the loudest of 1, 9, 17, 25, 33
  })
})
