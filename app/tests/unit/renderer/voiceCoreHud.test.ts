import { describe, expect, it } from 'vitest'
import { CORE_HUD, CORE_REST, coreCaption, coreLayout } from '../../../src/renderer/src/visuals/core'
import { geometry, type Word } from '../../../src/renderer/src/visuals/draw'
import { layoutWordLabels, wordAt, type WordLabel } from '../../../src/renderer/src/visuals/wordLabels'

const CW = 5.7 // the waveform labels' monospaced advance at 9.5 px
const measure = (texts: string[]) => texts.map((t) => t.length * CW)

/** No label's text or tick runs into the next one in its lane, and nothing passes the right bound. */
function expectClear(ticks: number[], out: WordLabel[], right: number, gap = 6) {
  for (const lane of [0, 1]) {
    let end = -Infinity
    out.forEach((l, i) => {
      if (l.lane !== lane || !l.tick) return
      expect(ticks[i]!).toBeGreaterThanOrEqual(end + gap)
      end = l.end
    })
  }
  for (const l of out) if (l.text) expect(l.end).toBeLessThanOrEqual(right + 1e-9)
}

describe('waveform word labels', () => {
  it('keeps every label whole in the first lane when the words are spread out', () => {
    const texts = ['WE', 'ARE', 'GUY', 'FAWKES']
    const ticks = [0, 60, 120, 180]
    const out = layoutWordLabels(ticks, texts, measure(texts), { right: 400 })
    expect(out.map((l) => [l.lane, l.text])).toEqual(texts.map((t) => [0, t]))
    expect(out[1]!.x).toBe(65) // tick + 5 px
  })

  it('staggers dense words into the lane under, without collisions (the hero line at 1280)', () => {
    const texts = ['REMEMBER,', 'REMEMBER', 'THE', 'SIGNAL', 'NEVER', 'DIES', 'WE', 'DO', 'NOT', 'FORGIVE', 'EXPECT', 'US']
    const ticks = [0, 46, 90, 117, 145, 170, 195, 216, 236, 258, 279, 303]
    const out = layoutWordLabels(ticks, texts, measure(texts), { right: 575 })
    expectClear(ticks, out, 575)
    expect(out.every((l) => l.tick)).toBe(true)
    expect(out.map((l) => l.lane)).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1])
    // Everything reads whole here except FORGIVE, which would run into its lane-mate US.
    expect(out.filter((l, i) => l.text !== texts[i]).map((l) => l.text)).toEqual(['FORG…'])
    // The overflow lane never takes two words in a row.
    out.forEach((l, i) => i > 0 && l.lane === 1 && expect(out[i - 1]!.lane).toBe(0))
  })

  it('shortens a label with an ellipsis, or shows only its tick when fewer than 3 characters would fit', () => {
    const texts = ['EXTRAORDINARY', 'A', 'B', 'SUPERCALIFRAGILISTIC', 'C', 'D']
    const ticks = [0, 10, 40, 60, 66, 72]
    const out = layoutWordLabels(ticks, texts, measure(texts), { right: 1000 })
    expectClear(ticks, out, 1000)
    expect(out[0]!.text).toBe('EXTR…') // room up to B's tick (40 - 6) = 29 px after the 5 px pad
    expect(out[3]).toMatchObject({ tick: true, text: '', end: 60 }) // 1 px before D's tick: the tick alone
  })

  it('never runs text past the right edge', () => {
    const out = layoutWordLabels([0, 180], ['LIGHTS', 'OFFSTAGE'], measure(['LIGHTS', 'OFFSTAGE']), { right: 220 })
    expect(out[1]!.text).toBe('OFFST…')
    expectClear([0, 180], out, 220)
  })

  it('stays collision-free for random lines', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let run = 0; run < 200; run++) {
      const n = 1 + Math.floor(rnd() * 30)
      const ticks: number[] = []
      const texts: string[] = []
      let t = rnd() * 20
      for (let i = 0; i < n; i++) {
        ticks.push(Math.round(t * 2) / 2)
        texts.push('X'.repeat(1 + Math.floor(rnd() * 12)))
        t += rnd() * 70
      }
      const right = Math.max(...ticks) + 40
      expectClear(ticks, layoutWordLabels(ticks, texts, measure(texts), { right }), right)
    }
  })
})

describe('current word', () => {
  const words: Word[] = [
    { t0: 0.5, t1: 0.8, w: 'we', th: false },
    { t0: 0.9, t1: 1.2, w: 'are', th: false },
    { t0: 2.0, t1: 2.4, w: 'us', th: true },
  ]
  it('is the word being said, held across short gaps, none in pauses', () => {
    expect(wordAt(words, 0.2)).toBe(-1)
    expect(wordAt(words, 0.6)).toBe(0)
    expect(wordAt(words, 0.85)).toBe(0) // the 0.1 s gap before "are" keeps "we"
    expect(wordAt(words, 1.0)).toBe(1)
    expect(wordAt(words, 1.6)).toBe(-1) // a pause
    expect(wordAt(words, 2.5)).toBe(2)
    expect(wordAt(words, 3)).toBe(-1)
  })
})

describe('voice core caption', () => {
  const g = geometry(6.86, 140, 4)
  const words: Word[] = [
    { t0: 0.5, t1: 0.8, w: 'remember,', th: false },
    { t0: 1.9, t1: 2.3, w: 'us', th: true },
  ]
  it('shows only the length when stopped', () => {
    expect(coreCaption(null, words, g)).toMatchObject({ word: '6.86 S', bar: '', thrown: false })
  })
  it('shows the word, its throw and the beat while playing', () => {
    expect(coreCaption(0.6, words, g)).toMatchObject({ word: 'REMEMBER,', bar: 'BAR 1.2', thrown: false })
    expect(coreCaption(2.0, words, g)).toMatchObject({ word: 'US', bar: 'BAR 2.1', thrown: true })
    expect(coreCaption(1.4, words, g)).toMatchObject({ word: '·', key: 'pause' })
  })
  it('changes key on each new word, even the same text again', () => {
    const twice: Word[] = [
      { t0: 0, t1: 0.3, w: 'do', th: false },
      { t0: 0.35, t1: 0.6, w: 'do', th: false },
    ]
    expect(coreCaption(0.1, twice, g).key).not.toBe(coreCaption(0.4, twice, g).key)
  })
})

describe('voice core layout', () => {
  // The panel at 1512×982 and at the 1280×800 minimum (measured).
  for (const [w, h] of [
    [291, 365],
    [246, 248],
  ] as const) {
    it(`keeps the resting sphere clear of the HUD in a ${w}×${h} panel`, () => {
      const { cx, cy, r } = coreLayout(w, h)
      const reach = r * CORE_REST
      expect(cx + reach).toBeLessThanOrEqual(w - CORE_HUD.right + 1e-9) // clear of the panel's right edge
      expect(cx - reach).toBeGreaterThanOrEqual(CORE_HUD.left - 1e-9)
      expect(cy - reach).toBeGreaterThanOrEqual(CORE_HUD.top - 1e-9) // under VOICE CORE
      expect(cy + reach).toBeLessThanOrEqual(h - CORE_HUD.bottom + 1e-9) // above the caption
      expect(r).toBeGreaterThan(55) // still a big sphere (it was ~62 and ~99 px before)
    })
  }
  it('has a floor for tiny panels', () => {
    expect(coreLayout(60, 60).r).toBe(26)
  })
})
