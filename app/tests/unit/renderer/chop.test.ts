import { describe, expect, it } from 'vitest'
import { partialArrange } from '@/state/renderController'

const base = { bpm: 140, bars: 4 as const, key: 'Am' }

describe('ARRANGE chop in the render request', () => {
  it('sends nothing for the natural phrasing (older engines never see the fields)', () => {
    expect(partialArrange({ ...base, chop: 'off' })).toEqual(base)
  })
  it('sends the grid mode per word, and the placements only when custom', () => {
    expect(partialArrange({ ...base, chop: 'bar', chopSlots: [{ index: 0, beat: 4 }] })).toEqual({ ...base, chop: 'bar', chop_unit: 'word' })
    expect(partialArrange({ ...base, chop: 'custom', chopSlots: [{ index: 1, beat: 6 }] })).toEqual({
      ...base,
      chop: 'custom',
      chop_unit: 'word',
      chop_slots: [{ index: 1, beat: 6 }],
    })
  })
})
