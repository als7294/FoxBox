// A mic-less start (VISUALS → TRACK) must never touch the mic, and no public getter may assume one (1.4.0: latencyMs()
// read `.latency` of undefined during render and blanked the app). A small Web Audio stand-in runs the real engine.
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

vi.mock('@/audio/live/vendor/signalsmith-stretch/SignalsmithStretch.mjs', () => ({
  default: Object.assign(async () => Object.assign(new Node(), { configure: async () => {}, latency: async () => 0.016, schedule: async () => {} }), {}),
}))

const { LiveEngine, SetRecorder, liveParams } = await import('@/audio/live')

describe('LiveEngine with no input', () => {
  it('never opens the mic, and every public getter and control works until the mic is asked for', async () => {
    const live = await LiveEngine.create({ input: 'none', bpm: 128 })
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(live.input).toBe('none')
    expect(Number.isFinite(live.latencyMs())).toBe(true)
    live.apply(liveParams({ chain: { modules: [] }, macros: { depth: 0.5, grit: 0.5, machine: 0.5, space: 0.5 }, macroMap: {}, key: 'Am' }))
    for (const tap of [live.bus.mix, live.bus.voice]) {
      expect(tap.rms()).toBe(0)
      expect(tap.bands()).toEqual({ low: 0, mid: 0, high: 0 })
    }
    expect([live.bus.rms(), live.bus.input.fftSize]).toEqual([0, 2048])
    live.bus.onOnset(() => {})()
    live.setTalk(false)
    live.setTalk(true)
    live.setGate(-50)
    live.setOutputGain(0)
    live.setTempo(128)
    expect(live.nextGridTime('bar')).toBeGreaterThan(1)
    for (const t of ['throw', 'stutter', 'swell', 'tapestop', 'dropout'] as const) expect(live.trigger(t).at).toBeGreaterThan(1)
    const rec = new SetRecorder(live.bus, { dry: true })
    rec.arm()
    expect(rec.level().peak).toBe(0)
    rec.release()

    await live.setInput('mic') // the user picks MIC: now, and only now
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect([live.input, live.latencyMs()]).toEqual(['mic', expect.any(Number)])
    await live.setInput('none')
    expect(track.stop).toHaveBeenCalled()
    expect(Number.isFinite(live.latencyMs())).toBe(true)
    await live.close()
  })
})
