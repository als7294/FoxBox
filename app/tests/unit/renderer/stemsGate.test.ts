// REMIX's stems: the first split waits on the stems model's notice (S4's StemsNotice via setStemsGate). "Not now"
// never starts the download; Try again (retryStems) asks again; a song already split never asks.
import { beforeEach, describe, expect, it, vi } from 'vitest'

class Param { value = 0; setTargetAtTime(v: number) { this.value = v; return this } setValueAtTime(v: number) { this.value = v; return this } linearRampToValueAtTime() { return this } cancelScheduledValues() { return this } }
class Node { connect<T>(n: T) { return n } disconnect() {} }
class AnalyserNode extends Node { fftSize = 2048; frequencyBinCount = 1024; getFloatTimeDomainData(a: Float32Array) { a.fill(0) } getFloatFrequencyData(a: Float32Array) { a.fill(-120) } getByteTimeDomainData(a: Uint8Array) { a.fill(128) } }
Object.assign(globalThis, {
  GainNode: class extends Node { gain = new Param() },
  BiquadFilterNode: class extends Node { frequency = new Param(); Q = new Param(); gain = new Param() },
  StereoPannerNode: class extends Node { pan = new Param() },
  DelayNode: class extends Node { delayTime = new Param() },
  ConvolverNode: class extends Node { buffer: unknown = null },
  AnalyserNode,
  AudioWorkletNode: class extends Node { private p: Record<string, Param> = {}; parameters = { get: (k: string) => (this.p[k] ??= new Param()) }; port = { postMessage() {}, onmessage: null } },
})
const ctx = { sampleRate: 48000, currentTime: 1, createBuffer: (_c: number, len: number) => ({ getChannelData: () => new Float32Array(len) }) }
const engine = { ctx, songInput: new Node(), nextGridTime: () => 1, followClock: () => {} }

const ok = { ok: true }
const POST = vi.fn(async () => ({ data: { id: 'job-1' }, response: ok }))
const done = { id: 'sng_1', stems_state: 'done', stems: ['drums', 'bass', 'vocals', 'other'].map((name) => ({ name, audio_id: `a-${name}` })) }
vi.mock('@/api/client', async (orig) => ({
  ...(await orig<typeof import('@/api/client')>()),
  api: { POST: (...a: unknown[]) => POST(...(a as [])), GET: async () => ({ data: done, response: ok }) },
  waitJob: async () => ({}),
}))
vi.mock('@/audio/cache', () => ({ loadAudioBytes: async () => new ArrayBuffer(8) }))
vi.mock('@/state/song', async (orig) => ({ ...(await orig<typeof import('@/state/song')>()), decodeSong: async () => ({ duration: 10, numberOfChannels: 2 }) }))

const { SongDeck, setStemsGate } = await import('@/audio/live/songDeck')
const { useSongFx } = await import('@/audio/live/songFx')
const settle = () => new Promise((r) => setTimeout(r, 0))

describe("REMIX's stems: the model's notice before the first split", () => {
  beforeEach(() => { POST.mockClear(); useSongFx.setState({ wantStems: false, enabled: true, stems: 'mix' }) })
  const deckWith = (song: object) => {
    const deck = new SongDeck(engine as never)
    Object.assign(deck, { song })
    return deck
  }

  it('"Not now" never starts the download (declined); Try again asks again, and Continue splits', async () => {
    let answer = false
    const gate = vi.fn(async () => answer)
    setStemsGate(gate)
    const deck = deckWith({ id: 'sng_1', stems_state: 'none', stems: [] })
    try {
      useSongFx.setState({ wantStems: true })
      await settle()
      expect(gate).toHaveBeenCalledTimes(1)
      expect(POST).not.toHaveBeenCalled()
      expect(useSongFx.getState().stems).toBe('declined')
      answer = true
      deck.retryStems()
      for (let i = 0; i < 5; i++) await settle()
      expect(POST).toHaveBeenCalledTimes(1)
      expect(useSongFx.getState().stems).toBe('on')
    } finally {
      deck.dispose()
    }
  })

  it('a song already split never asks', async () => {
    const gate = vi.fn(async () => false)
    setStemsGate(gate)
    const deck = deckWith(done)
    try {
      useSongFx.setState({ wantStems: true })
      for (let i = 0; i < 5; i++) await settle()
      expect(gate).not.toHaveBeenCalled()
      expect(useSongFx.getState().stems).toBe('on')
    } finally {
      deck.dispose()
    }
  })
})
