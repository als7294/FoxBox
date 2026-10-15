/**
 * The audio context REMIX's deck plays in (2.0: the 1.x voice mask is gone; PLAY runs its own chain, audio/play): one
 * AudioContext (latencyHint 'interactive') with the worklets loaded, the song's way in (songInput) to the speakers,
 * the grid quantized starts land on (nextGridTime: a playing song's clock via followClock, else a 120 BPM session), and
 * `bus`, the taps RECORD and the visuals read.
 */
import { attachOutput } from '../output'
import processorsUrl from './worklets/live-processors.js?url'
import { LiveBusImpl, type LiveBus, type Quantize } from './bus'

/** 1.x's options, still accepted (state/liveDeck passes them): there's no input, and so no latency mode, any more. */
export interface LiveEngineOptions {
  input?: 'none'
  latency?: string
  bpm?: number
}

export function impulse(ctx: BaseAudioContext, decayS: number, dark: number): AudioBuffer {
  const sr = ctx.sampleRate
  const len = Math.max(1, Math.round(Math.min(6, decayS * 1.4 + 0.1) * sr))
  const buf = ctx.createBuffer(2, len, sr)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    let seed = 1234 + ch * 7919
    let y = 0
    for (let i = 0; i < len; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      const t = i / sr
      const x = ((seed / 4294967296) * 2 - 1) * Math.exp((-6.91 * t) / Math.max(0.05, decayS))
      // darker as it decays: the one-pole's cutoff falls from ~12 kHz toward ~1 kHz with `dark`
      const hz = 12000 * Math.pow(1 - 0.9 * dark, Math.min(1, t / Math.max(0.05, decayS)) * 2) * (1 - 0.5 * dark)
      const a = 1 - Math.exp((-2 * Math.PI * hz) / sr)
      y += a * (x - y)
      d[i] = y
    }
  }
  return buf
}

export class LiveEngine {
  readonly ctx: AudioContext
  readonly bus: LiveBus
  private readonly busImpl: LiveBusImpl
  /** Where a SongDeck plugs in: to the speakers and the bus's mix tap. */
  readonly songInput: GainNode
  private bpm: number
  private anchor: number
  private session: { bpm: number; anchor: number }
  private follow: { bpm: number; anchor: number } | null = null
  private readonly detachOutput: () => void

  /** The context with the worklets loaded. Never asks for the mic. */
  static async create(opts: LiveEngineOptions = {}): Promise<LiveEngine> {
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    try {
      await ctx.audioWorklet.addModule(processorsUrl)
      const engine = new LiveEngine(ctx, opts.bpm ?? 120)
      void ctx.resume()
      return engine
    } catch (err) {
      await ctx.close().catch(() => {})
      throw err
    }
  }

  private constructor(ctx: AudioContext, bpm: number) {
    this.ctx = ctx
    this.bpm = bpm
    this.anchor = ctx.currentTime
    this.session = { bpm, anchor: this.anchor }
    const tap = () => new AnalyserNode(ctx, { fftSize: 2048 })
    const mix = tap()
    this.songInput = new GainNode(ctx, { gain: 1, channelCount: 2, channelCountMode: 'explicit' })
    this.songInput.connect(mix)
    this.songInput.connect(ctx.destination)
    // the bus keeps its shape; with no input or voice now, those two taps stay silent
    this.busImpl = new LiveBusImpl(ctx, tap(), mix, tap())
    this.bus = this.busImpl
    this.detachOutput = attachOutput(ctx) // the settings sheet's output (audio/output.ts)
  }

  /** The session grid: `bpm`, with beat 1 at `anchor` (AudioContext time; defaults to when the engine started). */
  setTempo(bpm: number, anchor: number = this.session.anchor): void {
    this.session = { bpm: Math.max(40, Math.min(240, bpm)), anchor }
    this.applyTempo()
  }

  /** A playing song's beat clock takes over the grid; null hands it back to the session. */
  followClock(clock: { bpm: number; anchor: number } | null): void {
    this.follow = clock
    this.applyTempo()
  }

  /** The AudioContext time of the next 1/16, beat or bar on the active grid. */
  nextGridTime(q: Quantize): number {
    const beat = 60 / this.bpm
    const unit = q === '1/16' ? beat / 4 : q === 'beat' ? beat : 4 * beat
    const now = this.ctx.currentTime + 0.01 // never schedule into the render quantum already playing
    return this.anchor + Math.ceil((now - this.anchor) / unit - 1e-9) * unit
  }

  async close(): Promise<void> {
    this.detachOutput()
    this.busImpl.dispose()
    await this.ctx.close()
  }

  private applyTempo(): void {
    const g = this.follow ?? this.session
    this.bpm = g.bpm
    this.anchor = g.anchor
  }
}
