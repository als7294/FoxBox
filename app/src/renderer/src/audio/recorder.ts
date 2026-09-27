import { bridge } from '@/env'
import type { PcmAudio } from './wav'

export type MicErrorKind = 'denied' | 'no-device' | 'busy' | 'unknown'

export class MicError extends Error {
  constructor(
    readonly kind: MicErrorKind,
    message: string,
  ) {
    super(message)
  }
}

export interface Level {
  /** 0..1 linear */
  rms: number
  peak: number
  /** dBFS of the peak, -Infinity for silence */
  peakDb: number
}

/** Asks macOS for microphone access first (Electron), then opens the device through getUserMedia. */
export async function ensureMicAccess(): Promise<void> {
  const b = bridge()
  if (b) {
    const status = await b.micAccessStatus()
    if (status === 'denied' || status === 'restricted') {
      throw new MicError('denied', 'Microphone access is off for FoxBox. Turn it on in System Settings → Privacy & Security → Microphone.')
    }
    if (!(await b.askMicAccess())) throw new MicError('denied', 'Microphone access was denied.')
  }
}

/**
 * Microphone capture: getUserMedia → AudioWorklet (mono float PCM) with an analyser for the level meter.
 * Processing (echo cancellation, noise suppression, AGC) is off: the voice is going to be destroyed on
 * purpose, and AGC pumping would fight the rack's dynamics.
 */
export class MicRecorder {
  private chunks: Float32Array[] = []
  private recording = false
  private stopResolver: ((audio: PcmAudio) => void) | null = null
  private readonly levelBuf: Float32Array<ArrayBuffer>

  private constructor(
    private readonly ctx: AudioContext,
    private readonly stream: MediaStream,
    private readonly node: AudioWorkletNode,
    private readonly analyser: AnalyserNode,
    private readonly source: MediaStreamAudioSourceNode,
  ) {
    this.levelBuf = new Float32Array(analyser.fftSize)
    node.port.onmessage = (event: MessageEvent<{ type: string; data?: Float32Array }>) => {
      if (event.data.type === 'chunk' && event.data.data) this.chunks.push(event.data.data)
      else if (event.data.type === 'stopped') this.finish()
    }
  }

  static async open(deviceId?: string): Promise<MicRecorder> {
    await ensureMicAccess()
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 1 },
        },
        video: false,
      })
    } catch (err) {
      const name = (err as DOMException).name
      if (name === 'NotAllowedError' || name === 'SecurityError') throw new MicError('denied', 'Microphone access was denied.')
      if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new MicError('no-device', 'No microphone found.')
      if (name === 'NotReadableError') throw new MicError('busy', 'The microphone is in use by another app.')
      throw new MicError('unknown', (err as Error).message)
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    await ctx.audioWorklet.addModule(new URL('./worklets/pcm-recorder.js', document.baseURI).href)
    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'pcm-recorder', { numberOfInputs: 1, numberOfOutputs: 0 })
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    source.connect(analyser)
    source.connect(node)
    return new MicRecorder(ctx, stream, node, analyser, source)
  }

  get sampleRate(): number {
    return this.ctx.sampleRate
  }

  get isRecording(): boolean {
    return this.recording
  }

  /** Seconds captured so far. */
  get elapsed(): number {
    return this.chunks.reduce((n, c) => n + c.length, 0) / this.ctx.sampleRate
  }

  level(): Level {
    this.analyser.getFloatTimeDomainData(this.levelBuf)
    let sum = 0
    let peak = 0
    for (const v of this.levelBuf) {
      sum += v * v
      const a = Math.abs(v)
      if (a > peak) peak = a
    }
    const rms = Math.sqrt(sum / this.levelBuf.length)
    return { rms, peak, peakDb: peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY }
  }

  start(): void {
    this.chunks = []
    this.recording = true
    void this.ctx.resume()
    this.node.port.postMessage('start')
  }

  stop(): Promise<PcmAudio> {
    if (!this.recording) return Promise.resolve(this.collect())
    return new Promise((resolve) => {
      this.stopResolver = resolve
      this.node.port.postMessage('stop')
    })
  }

  close(): void {
    this.recording = false
    this.source.disconnect()
    this.node.disconnect()
    for (const track of this.stream.getTracks()) track.stop()
    void this.ctx.close()
  }

  private finish(): void {
    this.recording = false
    const resolve = this.stopResolver
    this.stopResolver = null
    resolve?.(this.collect())
  }

  private collect(): PcmAudio {
    const total = this.chunks.reduce((n, c) => n + c.length, 0)
    const out = new Float32Array(total)
    let o = 0
    for (const c of this.chunks) {
      out.set(c, o)
      o += c.length
    }
    return { sampleRate: this.ctx.sampleRate, channels: [out] }
  }
}

/** Short metronome click on the shared output (count-in). */
export function click(ctx: AudioContext, when: number, accent: boolean): void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.frequency.value = accent ? 1760 : 1320
  gain.gain.setValueAtTime(0.0001, when)
  gain.gain.exponentialRampToValueAtTime(0.4, when + 0.002)
  gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.06)
  osc.connect(gain).connect(ctx.destination)
  osc.start(when)
  osc.stop(when + 0.08)
}
