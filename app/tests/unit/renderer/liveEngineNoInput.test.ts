// REMIX's audio context (2.0: the voice mask gone): it never touches the mic, the song reaches the speakers and the mix
// tap, and the grid follows a playing song's clock. A small Web Audio stand-in runs the real engine.
import { afterAll, describe, expect, it, vi } from 'vitest'

class Param {
  constructor(public value = 0) {}
  setTargetAtTime(v: number) { this.value = v; return this }
  setValueAtTime(v: number) { this.value = v; return this }
  linearRampToValueAtTime(v: number) { this.value = v; return this }
  exponentialRampToValueAtTime(v: number) { this.value = v; return this }
  cancelScheduledValues() { return this }
}
class Node {
  channelCount = 2
  channelCountMode = 'max'
  channelInterpretation = 'speakers'
  connect<T>(n: T) { return n }
  disconnect() {}
}
class GainNode extends Node { gain: Param; constructor(_c: unknown, o: { gain?: number } = {}) { super(); this.gain = new Param(o.gain ?? 1) } }
class BiquadFilterNode extends Node { frequency = new Param(); Q = new Param(); gain = new Param() }
class DelayNode extends Node { delayTime = new Param() }
class ConvolverNode extends Node { buffer: unknown = null }
class WaveShaperNode extends Node { curve: unknown = null }
class AnalyserNode extends Node {
  fftSize = 2048; frequencyBinCount = 1024; minDecibels = -100; maxDecibels = -30
  getFloatTimeDomainData(a: Float32Array) { a.fill(0) }
  getFloatFrequencyData(a: Float32Array) { a.fill(-120) }
  getByteTimeDomainData(a: Uint8Array) { a.fill(128) }
}
class AudioWorkletNode extends Node {
  private p: Record<string, Param> = {}
  parameters = { get: (k: string) => (this.p[k] ??= new Param()) }
  port = { postMessage() {}, onmessage: null }
}
class AudioContext {
  sampleRate = 48000; currentTime = 1; baseLatency = 0.005; outputLatency = 0.02; state = 'running'
  destination = new Node()
  audioWorklet = { addModule: async () => {} }
  createBuffer(_ch: number, len: number) { return { getChannelData: () => new Float32Array(len) } }
  createMediaStreamSource() { return new Node() }
  async resume() {}
  async close() { this.state = 'closed' }
}
Object.assign(globalThis, { AudioContext, GainNode, BiquadFilterNode, DelayNode, ConvolverNode, WaveShaperNode, AnalyserNode, AudioWorkletNode })

const track = { getSettings: () => ({ latency: 0.01 }), stop: vi.fn() }
const getUserMedia = vi.fn(async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }))
const nav = globalThis.navigator
Object.defineProperty(globalThis, 'navigator', { value: { ...nav, mediaDevices: { getUserMedia } }, configurable: true })
afterAll(() => Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true }))

const { LiveEngine } = await import('@/audio/live')

describe('LiveEngine (REMIX: the context, the song in, the grid)', () => {
  it('never asks for the mic; the song goes to the speakers and the mix tap; the bus reads silence until it plays', async () => {
    const live = await LiveEngine.create({ input: 'none', bpm: 128 })
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(live.songInput).toBeInstanceOf(GainNode)
    expect([live.bus.rms(), live.bus.input.fftSize, live.bus.analyser.fftSize]).toEqual([0, 2048, 2048])
    live.bus.onOnset(() => {})()
    await live.close()
    expect(live.ctx.state).toBe('closed')
  })

  it('quantized starts land on the session grid, then on a playing song\'s', async () => {
    const live = await LiveEngine.create({ bpm: 120 }) // context time 1: the session's beat 1
    expect(live.nextGridTime('bar')).toBeCloseTo(3, 9) // the next bar of 2 s
    expect(live.nextGridTime('beat')).toBeCloseTo(1.5, 9)
    live.followClock({ bpm: 60, anchor: 0.5 })
    expect(live.nextGridTime('beat')).toBeCloseTo(1.5, 9)
    expect(live.nextGridTime('bar')).toBeCloseTo(4.5, 9)
    live.followClock(null)
    expect(live.nextGridTime('1/16')).toBeCloseTo(1.125, 9)
    await live.close()
  })
})
