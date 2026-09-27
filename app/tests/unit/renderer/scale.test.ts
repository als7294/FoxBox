import { describe, expect, it } from 'vitest'
import { camelot } from '../../../src/renderer/src/lib/keys'
import { formatValue, fromPosition, nudge, quantize, toPosition } from '../../../src/renderer/src/lib/scale'

describe('control scaling', () => {
  it('maps linear ranges', () => {
    const r = { min: -24, max: 12 }
    expect(toPosition(-6, r)).toBeCloseTo(0.5)
    expect(fromPosition(0.5, r)).toBeCloseTo(-6)
  })

  it('maps log ranges (Hz)', () => {
    const r = { min: 20, max: 20_000, scale: 'log' as const }
    expect(fromPosition(0.5, r)).toBeCloseTo(632.46, 1)
    expect(toPosition(632.46, r)).toBeCloseTo(0.5, 4)
  })

  it('quantizes to the step and clamps', () => {
    expect(quantize(1.26, { min: 0, max: 2, step: 0.1 })).toBeCloseTo(1.3)
    expect(quantize(9, { min: 0, max: 2 })).toBe(2)
  })

  it('nudges by 1% (0.1% fine) or by the step', () => {
    expect(nudge(0.5, { min: 0, max: 1 }, 1, 'normal')).toBeCloseTo(0.51)
    expect(nudge(0.5, { min: 0, max: 1 }, -1, 'fine')).toBeCloseTo(0.499)
    expect(nudge(0, { min: -24, max: 12, step: 0.1 }, 1, 'fine')).toBeCloseTo(0.1)
  })

  it('formats values with units', () => {
    expect(formatValue(-9, 'st', 0.1)).toBe('−9.0 st')
    expect(formatValue(3, 'dB')).toBe('+3.00 dB')
    expect(formatValue(8000, 'Hz')).toBe('8.00 kHz')
  })

  it('knows Camelot codes', () => {
    expect(camelot('Am')).toBe('8A')
    expect(camelot('C')).toBe('8B')
    expect(camelot('F#m')).toBe('11A')
    expect(camelot('G#m')).toBe('1A')
    expect(camelot('D#')).toBe('5B')
  })
})
