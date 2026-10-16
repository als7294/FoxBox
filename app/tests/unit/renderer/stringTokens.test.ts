import { describe, expect, it } from 'vitest'
import { notePluck, setPlayNotes, setPlayStrings } from '@/components/strings/playFeed'
import { createPlayStrings } from '@/components/strings/playStrings'
import { defaultFrameTokens, defaultTokens, parseColour, parseFrameTokens, parseRgba, parseTokens } from '@/components/strings/stringTokens'
import { synthHand } from '@/components/strings/strings'

describe('string tokens (2.0)', () => {
  it('reads hex and rgb() colours, nothing else', () => {
    expect(parseColour('#fa0')).toEqual([255, 170, 0])
    expect(parseColour(' #FF9A3C ')).toEqual([255, 154, 60])
    expect(parseColour('rgba(12, 34, 56, 0.5)')).toEqual([12, 34, 56])
    expect(parseColour('rgb(12 34 56)')).toEqual([12, 34, 56])
    expect(parseColour('orange')).toBeNull()
    expect(parseColour('')).toBeNull()
    expect(parseRgba('rgba(255,255,255,.4)')).toEqual([255, 255, 255, 0.4]) // the design's cut
    expect(parseRgba('#FFB27A')).toEqual([255, 178, 122, 1])
  })

  it('takes what the page sets, falls back on the rest, and clamps', () => {
    const vars: Record<string, string> = {
      '--strings-play-core': '#000000',
      '--strings-play-weight': '3.5px',
      '--strings-play-glow-color': 'not a colour',
      '--strings-play-flash-ms': '900ms',
      '--strings-play-label-size': '6', // never under 11 px
      '--strings-play-label-font': 'x; }',
    }
    const t = parseTokens('play', (n) => vars[n] ?? '')
    const d = defaultTokens('play')
    expect(t.core).toEqual([0, 0, 0])
    expect(t.weight).toBe(3.5)
    expect(t.flashMs).toBe(900)
    expect(t.glowColor).toEqual(d.glowColor)
    expect(t.label.size).toBe(11)
    expect(t.label.font).toBe(d.label.font)
    expect(parseTokens('remix', () => '')).toEqual(defaultTokens('remix'))
    const fx = parseTokens('remix', (n) => ({ '--strings-remix-fx-gate': '1.4', '--strings-remix-fx-string-displace': '8' })[n] ?? '').fx
    expect(fx).toEqual({ gate: 1, stringDisplace: 8 })
    const cut = parseTokens('remix', (n) => ({ '--strings-remix-cut': 'rgba(255,255,255,.4)', '--strings-remix-cut-dash': '4 12' })[n] ?? '')
    expect([cut.cut, cut.cutDash]).toEqual([[255, 255, 255, 0.4], [4, 12]])
    // the frame reads the design's own names (foxbox-tokens.css)
    const frame = parseFrameTokens(
      (n) =>
        ({
          '--frame-world-opacity': '0.9', '--frame-label-size': '4', '--frame-ice': 'rgb(1, 2, 3)', '--frame-edge-draw': 'x', '--frame-bloom': '700ms',
          '--frame-bloom-delay': '350ms', '--frame-glow-remix': '#F2701F', '--frame-sweep': 'rgba(255,255,255,.85)',
        })[n] ?? '',
    )
    expect(frame).toMatchObject({ worldOpacity: 0.9, ice: [1, 2, 3], edgeMs: defaultFrameTokens().edgeMs, bloomMs: 700, bloomDelayMs: 350, sweep: [255, 255, 255, 0.85] })
    expect(frame.glow.remix).toEqual([242, 112, 31])
    expect(frame.label.size).toBe(11) // never under 11 px
  })
})

describe("SAUCE's note labels", () => {
  it("one faint label per hand, the instrument's note for it, at its index fingertip (none without the instrument); its NotePop takes over on a pluck", () => {
    const text: [string, number, number][] = []
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (t, k) => (k === 'fillText' ? (s: string, x: number, y: number) => text.push([s, x, y]) : k in t ? t[k as string] : () => ({ addColorStop() {} })),
      set: (t, k, v) => ((t[k as string] = v), true),
    })
    const canvas = { width: 1280, height: 720, getContext: () => ctx } as unknown as HTMLCanvasElement
    const strings = createPlayStrings(canvas)
    const right = synthHand(0.3, 0.7, 0.3, [1, 1, 1, 1, 1], true, 16 / 9) // the performer's right hand: the stage's left
    const left = synthHand(0.7, 0.7, 0.3, [1, 1, 1, 1, 1], false, 16 / 9)
    setPlayStrings({ style: 'pluck', frozen: false })
    strings.frame({ left: right, right: left, body: null }, 0)
    expect(text).toEqual([])
    setPlayNotes((hand) => (hand === 'right' ? 'E2' : 'C#1'))
    strings.frame({ left: right, right: left, body: null }, 16)
    expect(text.map((t) => t[0])).toEqual(['E2', 'C#1'])
    expect(Math.abs(text[0]![1] - right[8]!.x * 1280)).toBeLessThan(40) // by the right hand's index fingertip
    notePluck('right', 1, 1, 100)
    text.length = 0
    strings.frame({ left: right, right: left, body: null }, 200)
    expect(text.map((t) => t[0])).toEqual(['C#1']) // the right hand's NotePop shows
    text.length = 0
    strings.frame({ left: right, right: left, body: null }, 2200)
    expect(text.map((t) => t[0])).toEqual(['E2', 'C#1'])
    setPlayNotes(null)
  })
})
