import { describe, expect, it } from 'vitest'
import { clipAudioFor, effectRows, fallbackStyleLabel, voiceOpen, type PagePrefs } from '@/components/visuals/page'
import type { EffectLayer } from '@/visuals/live/compositor'

const fx = (id: string): EffectLayer => ({ id, styleId: `foxbox.${id}`, opacity: 1, blend: 'screen', reactTo: 'mix', enabled: true })

describe('VISUALS page helpers', () => {
  it('opens VOICE on MIC by default, and remembers the choice per source', () => {
    const p: PagePrefs = { source: 'track', voice: {} }
    expect(voiceOpen(p)).toBe(false)
    expect(voiceOpen(p, 'mic')).toBe(true)
    expect(voiceOpen(p, 'input')).toBe(false)
    const chosen: PagePrefs = { source: 'mic', voice: { mic: false, track: true } }
    expect(voiceOpen(chosen)).toBe(false)
    expect(voiceOpen(chosen, 'track')).toBe(true)
  })

  it('lists the effects top layer first, with the moves each one can make', () => {
    const rows = effectRows([fx('a'), fx('b'), fx('c')])
    expect(rows.map((r) => r.layer.id)).toEqual(['c', 'b', 'a'])
    expect(rows.map((r) => [r.up, r.down])).toEqual([
      [false, true],
      [true, true],
      [true, false],
    ])
    expect(effectRows([fx('solo')])[0]).toMatchObject({ up: false, down: false })
    expect(effectRows([])).toEqual([])
  })

  it('names a style no family lists from its id', () => {
    expect(fallbackStyleLabel('shaders.acid-rain')).toBe('ACID RAIN')
    expect(fallbackStyleLabel('milkdrop.flexi_mind.melt')).toBe('FLEXI MIND MELT')
    expect(fallbackStyleLabel('plain')).toBe('PLAIN')
  })

  it("records the active source's sound in a clip: the engine's master, or the live input's capture", () => {
    const ctx = {} as AudioContext
    const inCtx = {} as AudioContext
    const master = {} as AudioNode
    const capture = {} as AudioNode
    const engine = { context: ctx, analyser: master }
    const input = { ctx: inCtx, tap: { analyser: capture } }
    expect(clipAudioFor('mic', engine, input)).toEqual({ ctx, node: master })
    expect(clipAudioFor('track', engine, null)?.node).toBe(master)
    expect(clipAudioFor('input', engine, input)?.node).toBe(capture)
    expect(clipAudioFor('input', engine, null)).toBeNull()
    expect(clipAudioFor('track', null, input)).toBeNull()
  })
})
