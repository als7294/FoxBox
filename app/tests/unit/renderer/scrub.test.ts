// STRINGS' scrub (SongDeck): bar-snapped seeks, the sections the strip shows, its waveform; the TEST BEAT's parts.
import { describe, expect, it } from 'vitest'
import { labelSections, nearestBar, peaksOf } from '@/audio/live/songDeck'
import { renderTestBeat, TEST_BEAT, TEST_BEAT_SECTIONS } from '@/audio/live/testBeat'

const grid = { bpm: 145, downbeatS: 0.3, beatsPerBar: 4, barS: (4 * 60) / 145 }

describe("STRINGS' scrub", () => {
  it('a seek lands on the nearest bar line, inside the track; the looping TEST BEAT wraps', () => {
    expect(nearestBar(grid, 10, 144)).toBeCloseTo(0.3 + 6 * grid.barS, 9) // 10 s is 5.97 bars in
    expect(nearestBar(grid, 0, 144)).toBeCloseTo(0.3, 9)
    expect(nearestBar(grid, -5, 144)).toBeGreaterThanOrEqual(0)
    expect(nearestBar(grid, 500, 144)).toBeLessThan(144)
    const beat = { bpm: 120, downbeatS: 0, beatsPerBar: 4, barS: 2 }
    expect(nearestBar(beat, 15.9, 16, true)).toBe(0) // past the last bar: round to the top of the loop
    expect(nearestBar(beat, 9.2, 16, true)).toBe(10)
  })

  it("the song's sections, labelled for a DJ (a kind that comes back numbered), on the grid's bars, end to end", () => {
    const parts = [
      { kind: 'intro', startBar: 1, startS: 0, endS: 13 },
      { kind: 'build', startBar: 17, startS: 26.4, endS: 39.7 },
      { kind: 'drop', startBar: 25, startS: 39.7, endS: 66 },
      { kind: 'breakdown', startBar: 41, startS: 66, endS: 86 },
      { kind: 'drop', startBar: 61, startS: 99.3, endS: 125 },
    ]
    const s = labelSections(parts, grid, 144)
    expect(s.map((x) => x.label)).toEqual(['INTRO', 'BUILD', 'DROP 1', 'BREAK', 'DROP 2'])
    expect(s[2]!.startS).toBeCloseTo(0.3 + 24 * grid.barS, 9)
    expect(s[1]!.endS).toBe(s[2]!.startS)
    expect(s.at(-1)!.endS).toBe(144)
    expect(labelSections([], grid, 144)).toEqual([])
  })

  it('the waveform: n values 0-1 of loudness (a quiet part shows lower), the loudest 1', () => {
    const x = Float32Array.from({ length: 48000 }, (_, i) => (i < 24000 ? 0.1 : 0.5) * Math.sin(i / 7))
    const p = peaksOf([x, x], 8)
    expect(p).toHaveLength(8)
    expect(Math.max(...p)).toBe(1)
    expect(p[0]!).toBeCloseTo(0.2, 1) // a fifth as loud
  })

  it("the TEST BEAT's parts: INTRO, BUILD, DROP, BREAK over its 8 bars; no drums in the BREAK, the vocal from the DROP", () => {
    const sr = 24000, barN = (4 * 60 * sr) / TEST_BEAT.bpm
    const s = labelSections(TEST_BEAT_SECTIONS.map((p) => ({ ...p, startS: 0, endS: 0 })), { bpm: 120, downbeatS: 0, beatsPerBar: 4, barS: 2 }, 16)
    expect(s.map((x) => `${x.label} ${x.startS}-${x.endS}`)).toEqual(['INTRO 0-4', 'BUILD 4-8', 'DROP 8-12', 'BREAK 12-16'])
    const beat = renderTestBeat(sr)
    const rms = (a: Float32Array, bar: number) => { const i0 = Math.round((bar - 1) * barN) + 2400, n = Math.round(barN) - 4800; return Math.sqrt(a.subarray(i0, i0 + n).reduce((m, v) => m + v * v, 0) / n) }
    expect(rms(beat.drums[0], 7)).toBeLessThan(0.05 * rms(beat.drums[0], 5))
    expect(rms(beat.vocals[0], 2)).toBeLessThan(0.05 * rms(beat.vocals[0], 5))
    for (const bar of [1, 4, 6, 8]) expect(rms(beat.bass[0], bar)).toBeGreaterThan(0.02)
  })
})
