import { describe, expect, it } from 'vitest'
import { barSamples, barSeconds, formatClock, gridLines, suggestBars, tapTempo } from '../../../src/renderer/src/audio/grid'

describe('bar grid', () => {
  it('1 bar = 240/BPM s; 4 bars at 140 BPM is exactly 302,400 samples at 44.1 kHz', () => {
    expect(barSeconds(140)).toBeCloseTo(240 / 140, 12)
    expect(barSamples(4, 140, 44_100)).toBe(302_400)
  })

  it('draws a line on every beat with numbered bars', () => {
    const lines = gridLines(barSeconds(140) * 4, 140)
    expect(lines).toHaveLength(17) // 16 beats + the end line
    expect(lines.filter((l) => l.isBar).map((l) => l.bar)).toEqual([1, 2, 3, 4, 5])
    expect(lines[5]).toMatchObject({ bar: 2, beat: 2, isBar: false })
  })

  it('suggests the smallest power-of-two bar count that fits', () => {
    expect(suggestBars(7.2, 140)).toBe(8)
    expect(suggestBars(6.8, 140)).toBe(4)
    expect(suggestBars(200, 140)).toBeNull()
  })

  it('tap tempo averages recent taps and ignores long gaps', () => {
    const taps = [0, 5000, 5500, 6000, 6500]
    expect(tapTempo(taps)).toBe(120)
    expect(tapTempo([0])).toBeNull()
  })

  it('formats a clock', () => {
    expect(formatClock(6.857)).toBe('0:06.86')
    expect(formatClock(65.5)).toBe('1:05.50')
  })
})
