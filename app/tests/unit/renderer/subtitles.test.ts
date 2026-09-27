import { describe, expect, it } from 'vitest'
import type { RenderInfo } from '@/api/types'
import { SUB_FADE_S, SUB_HOLD_S, subtitleAt, subtitleWords, type SubWord } from '@/components/camera/subtitles'

// "GUY FVWKS | IN THE MIX ALL NIGHT LONG WITH YOU": two segments, a word every 0.4 s from 1 s.
const said = (text: string, t0: number): SubWord[] =>
  text.split(' ').map((w, i) => ({ t0: t0 + i * 0.4, t1: t0 + i * 0.4 + 0.3, w, brk: i === 0 }))
const words = [...said('Guy Fawkes', 1), ...said('in the mix all night long with you', 1.8)]

describe('camera clip subtitles', () => {
  it('shows a phrase only while its words are said, fading in after silence and out after the last word', () => {
    expect(subtitleAt(words, 0.9)).toBeNull()
    expect(subtitleAt(words, null)).toBeNull()
    expect(subtitleAt(words, 1)).toMatchObject({ lines: [['Guy', 'Fawkes']], current: 0, alpha: 0 })
    expect(subtitleAt(words, 1 + 2 * SUB_FADE_S)!.alpha).toBe(1)
    expect(subtitleAt(words, 1.45)).toMatchObject({ current: 1, alpha: 1 })
    const last = words[words.length - 1]!
    expect(subtitleAt(words, last.t1 + SUB_HOLD_S - SUB_FADE_S / 2)!.alpha).toBeCloseTo(0.5)
    expect(subtitleAt(words, last.t1 + SUB_HOLD_S)).toBeNull()
  })

  it('starts a phrase at each segment (swapping, no fade), in two even lines; a longer run splits in two', () => {
    expect(subtitleAt(words, 1.8)).toMatchObject({
      lines: [
        ['in', 'the', 'mix', 'all'],
        ['night', 'long', 'with', 'you'],
      ],
      current: 0,
      alpha: 1,
    })
    expect(subtitleAt(words, 1.8 + 4 * 0.4 + 0.1)!.current).toBe(4) // "night", on line two
    const long = said('in the mix tonight all night long with you', 0)
    expect(subtitleAt(long, 0)!.lines.flat()).toEqual(['in', 'the', 'mix', 'tonight', 'all'])
    expect(subtitleAt(long, 2.1)!.lines.flat()).toEqual(['night', 'long', 'with', 'you'])
    // Between words (past the hold), nothing is lit.
    const gap = [
      { t0: 0, t1: 0.2, w: 'ONE', brk: true },
      { t0: 0.6, t1: 0.8, w: 'TWO', brk: false },
    ]
    expect(subtitleAt(gap, 0.5)!.current).toBe(-1)
  })

  it("reads the render's words without script markup, each segment a new phrase", () => {
    const r = {
      segments: [
        {
          index: 0,
          start_s: 0,
          end_s: 1,
          words: [
            { text: '*US*', start_s: 0, end_s: 0.4, throw: true },
            { text: '|', start_s: 0.4, end_s: 0.4, throw: false },
          ],
        },
        { index: 1, start_s: 1, end_s: 2, words: [{ text: 'Fawkes', start_s: 1, end_s: 1.5, throw: false }] },
      ],
    } as unknown as RenderInfo
    expect(subtitleWords(r)).toEqual([
      { t0: 0, t1: 0.4, w: 'US', brk: true },
      { t0: 1, t1: 1.5, w: 'Fawkes', brk: true },
    ])
  })
})
