// REMIX's library wheel: its state (the dial, the snap, the grab → preview → load, type-ahead) and its preview audio.
import { describe, expect, it, vi } from 'vitest'
import { createWheelState, EDGE_RATE, PAGE_DEG, PAGE_TRACKS } from '@/components/wheel/wheelState'
import { createPreview } from '@/audio/library/preview'

describe("the library wheel's state", () => {
  it('the dial: a 140° sweep is a page of 40 tracks from wherever the finger came in; a lost finger re-anchors', () => {
    const sel: number[] = []
    const s = createWheelState({ select: (i) => sel.push(i) })
    s.setCount(5000)
    s.setDial(200)
    expect(s.selected).toBe(0) // coming in doesn't jump
    s.setDial(200 + PAGE_DEG)
    expect(s.selected).toBe(PAGE_TRACKS)
    s.setDial(null)
    s.setDial(150) // back in, anywhere: carries on from 40
    expect(s.selected).toBe(40)
    s.setDial(150 - 7) // a little back: snapped to a whole track
    expect([s.selected, s.target]).toEqual([38, 38])
    expect(sel).toEqual([0, 40, 38])
  })

  it('held at an end it keeps scrolling; the list wraps round', () => {
    const s = createWheelState()
    s.setCount(100)
    s.setDial(270, 1)
    for (let i = 0; i < 10; i++) s.tick(0.1)
    expect(s.selected).toBe(EDGE_RATE)
    s.setDial(270, 0)
    s.nudge(-30)
    expect(s.selected).toBe(100 + EDGE_RATE - 30)
  })

  it('the grab: the full pull previews the selected track, opening stops it, a spin stops it; the hold loads once', () => {
    const preview: (number | null)[] = []
    const load: number[] = []
    const s = createWheelState({ preview: (i) => preview.push(i), load: (i) => load.push(i) })
    s.setCount(10)
    s.select(3)
    s.setGrab(0.6)
    expect(preview).toEqual([])
    s.setGrab(1)
    s.setGrab(0.5) // still held: no stop until opened past 0.3
    expect(preview).toEqual([3])
    s.setGrab(0.1)
    expect(preview).toEqual([3, null])
    s.setGrab(1)
    s.nudge(1) // spun on to another card: its preview stops
    expect(preview).toEqual([3, null, 3, null])
    s.setLoadProgress(0.5)
    s.setLoadProgress(1)
    s.setLoadProgress(1)
    expect(load).toEqual([4])
  })

  it('typing jumps to the first title starting with it (a second to keep typing)', () => {
    const s = createWheelState()
    const titles = ['Alpha', 'Bravo', 'Brass', 'Charlie']
    s.setCount(titles.length)
    s.type('b', titles, 0)
    expect(s.selected).toBe(1)
    s.type('r', titles, 300)
    s.type('a', titles, 600)
    s.type('s', titles, 900)
    expect(s.selected).toBe(2)
    s.type('c', titles, 5000) // a fresh word
    expect(s.selected).toBe(3)
  })
})

describe("the library wheel's preview", () => {
  class Param { value = 0; setValueAtTime(v: number) { this.value = v; return this } linearRampToValueAtTime(v: number) { this.value = v; return this } cancelScheduledValues() { return this } }
  class GainNode { gain = new Param(); connect<T>(n: T) { return n } }
  const sources: { stop: ReturnType<typeof vi.fn> }[] = []
  class AudioBufferSourceNode { onended: (() => void) | null = null; stop = vi.fn(); constructor() { sources.push(this) } connect<T>(n: T) { return n } start() {} }
  Object.assign(globalThis, { GainNode, AudioBufferSourceNode })
  const ctx = { currentTime: 1, destination: {}, decodeAudioData: async () => ({}) } as unknown as BaseAudioContext

  it('plays through the engine with the deck ducked, stops faded with it back; a newer play wins', async () => {
    const duck = vi.fn()
    let release!: () => void
    const slow = new Promise<void>((r) => (release = r))
    const p = createPreview({ ctx, deck: { duck }, fetch: async (id) => { if (id === 'slow') await slow; return new ArrayBuffer(4) } })
    await p.play('a')
    expect([p.playing, duck.mock.calls.at(-1)]).toEqual(['a', [-15]])
    const first = p.play('slow')
    await p.play('b') // the slow one still loading: b wins
    release()
    await first
    expect(p.playing).toBe('b')
    p.stop()
    expect([p.playing, duck.mock.calls.at(-1)]).toEqual([null, [null]])
    expect(sources.every((s) => s.stop.mock.calls.length)).toBe(true) // every one faded and stopped
  })
})
