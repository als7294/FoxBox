import { describe, expect, it } from 'vitest'
import { autoVjLine, type StageFrame } from '@/components/visuals/stageFrame'

const frame = (f: Partial<StageFrame>): StageFrame => ({
  active: true,
  levels: { mix: 0, drums: 0, bass: 0, vocals: 0, other: 0 },
  section: null,
  dropIn: null,
  nextSection: null,
  nextIn: null,
  bpm: 120,
  ...f,
})

describe("AUTO-VJ's line", () => {
  it('counts down to the next section on TRACK (time at the tempo, bars of 4)', () => {
    expect(autoVjLine(frame({ section: 'build', nextSection: 'drop', nextIn: 14 }), true)).toEqual({ sub: 'DROP IN 0:07 · 4 BARS', bars: 4 })
    expect(autoVjLine(frame({ nextSection: 'breakdown', nextIn: 3 }), true)).toEqual({ sub: 'BREAK IN 0:01 · 1 BAR', bars: 1 })
  })
  it("falls back to LIVE INPUT's predicted drop, then to the section", () => {
    expect(autoVjLine(frame({ dropIn: 8 }), true).sub).toBe('DROP IN 0:04 · 2 BARS')
    expect(autoVjLine(frame({ section: 'verse' }), true)).toEqual({ sub: 'IN THE VERSE', bars: 0 })
  })
  it('says OFF, or that it waits for a track', () => {
    expect(autoVjLine(frame({ nextSection: 'drop', nextIn: 8 }), false)).toEqual({ sub: 'OFF', bars: 0 })
    expect(autoVjLine(frame({ active: false }), true).sub).toBe('WAITS FOR A TRACK')
  })
})
