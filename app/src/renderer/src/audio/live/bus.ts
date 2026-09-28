/**
 * LiveBus: the LIVE voice mask's shared connector, for the LIVE page (S1) and the visuals (S4). Read-only taps on the
 * chain plus the performance-FX trigger events; nothing here changes the sound.
 *
 * Taps (each an AudioTap: analyser, rms, bands, onsets, fft):
 *   bus.mix    everything that reaches the output: the masked voice and, while a SongDeck plays, the song
 *   bus.voice  the masked voice alone, with its SPACE, before the song joins
 *   deck.tap   the song alone (SongDeck), after its level and duck
 * The top-level analyser / rms / bands / onOnset are bus.mix (as before the song arrived).
 */

export type LiveTrigger = 'throw' | 'stutter' | 'swell' | 'tapestop' | 'dropout'
/** Triggers land on the next 1/16, beat or bar of the grid (the song's beat clock while a SongDeck plays). */
export type Quantize = '1/16' | 'beat' | 'bar'

export interface LiveTriggerEvent {
  name: LiveTrigger
  quantize: Quantize
  /** AudioContext time the effect lands (the grid point). */
  at: number
  /** How long it runs, seconds. */
  durS: number
}

export interface LiveBands {
  low: number
  mid: number
  high: number
}

export interface LiveOnset {
  /** Spectral-flux strength over the adaptive threshold (≥ 1). */
  strength: number
  /** AudioContext time. */
  time: number
}

export interface AudioTap {
  /** fftSize 2048. */
  readonly analyser: AnalyserNode
  /** RMS of the last 2048 samples, linear 0..1. */
  rms(): number
  /** Level per band, 0..1 (-90..-10 dB mapped): low < 250 Hz, mid 250 Hz–4 kHz, high > 4 kHz. */
  bands(): LiveBands
  /** Onsets (spectral flux, polled every ~10 ms while anyone listens). Returns an unsubscribe. */
  onOnset(cb: (e: LiveOnset) => void): () => void
  /** Magnitudes in dB per bin (getFloatFrequencyData), into `out` when given (length analyser.frequencyBinCount). */
  fft(out?: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer>
}

export interface LiveBus {
  readonly context: AudioContext
  /** = mix.analyser: the output (after the master stage), fftSize 2048. */
  readonly analyser: AnalyserNode
  /** The mic after the input gain, before the mask, fftSize 2048. */
  readonly input: AnalyserNode
  /** Everything that reaches the output (voice + song). */
  readonly mix: AudioTap
  /** The masked voice alone (with its reverb / delay), before the song joins. */
  readonly voice: AudioTap
  /** = mix.rms() */
  rms(): number
  /** = mix.bands() */
  bands(): LiveBands
  /** = mix.onOnset() */
  onOnset(cb: (e: LiveOnset) => void): () => void
  /** Performance-FX triggers as they're scheduled; '*' for all of them. Returns an unsubscribe. */
  triggers(name: LiveTrigger | '*', cb: (e: LiveTriggerEvent) => void): () => void
}

const LOW_HZ = 250
const HIGH_HZ = 4000
const POLL_MS = 10
const MIN_GAP_S = 0.08

export class AudioTapImpl implements AudioTap {
  private readonly time: Float32Array<ArrayBuffer>
  private readonly freq: Float32Array<ArrayBuffer>
  private prevMag: Float32Array | null = null
  private flux: number[] = []
  private lastOnset = -1
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly onsetCbs = new Set<(e: LiveOnset) => void>()

  constructor(
    private readonly context: BaseAudioContext,
    readonly analyser: AnalyserNode,
  ) {
    this.time = new Float32Array(analyser.fftSize)
    this.freq = new Float32Array(analyser.frequencyBinCount)
  }

  rms(): number {
    this.analyser.getFloatTimeDomainData(this.time)
    let s = 0
    for (let i = 0; i < this.time.length; i++) s += this.time[i]! * this.time[i]!
    return Math.min(1, Math.sqrt(s / this.time.length))
  }

  fft(out: Float32Array<ArrayBuffer> = new Float32Array(this.analyser.frequencyBinCount)): Float32Array<ArrayBuffer> {
    this.analyser.getFloatFrequencyData(out)
    return out
  }

  bands(): LiveBands {
    this.analyser.getFloatFrequencyData(this.freq)
    const hzPerBin = this.context.sampleRate / this.analyser.fftSize
    const acc = { low: [0, 0], mid: [0, 0], high: [0, 0] }
    for (let i = 1; i < this.freq.length; i++) {
      const hz = i * hzPerBin
      const band = hz < LOW_HZ ? acc.low : hz < HIGH_HZ ? acc.mid : hz < 16000 ? acc.high : null
      if (!band) continue
      band[0]! += Math.pow(10, this.freq[i]! / 20)
      band[1]! += 1
    }
    const level = (b: number[]) => {
      const db = 20 * Math.log10(Math.max(1e-9, b[0]! / Math.max(1, b[1]!)))
      return Math.min(1, Math.max(0, (db + 90) / 80))
    }
    return { low: level(acc.low), mid: level(acc.mid), high: level(acc.high) }
  }

  onOnset(cb: (e: LiveOnset) => void): () => void {
    this.onsetCbs.add(cb)
    if (!this.timer) this.timer = setInterval(() => this.pollOnset(), POLL_MS)
    return () => {
      this.onsetCbs.delete(cb)
      if (this.onsetCbs.size === 0 && this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.onsetCbs.clear()
  }

  private pollOnset(): void {
    this.analyser.getFloatFrequencyData(this.freq)
    const mag = new Float32Array(this.freq.length)
    for (let i = 0; i < mag.length; i++) mag[i] = Math.pow(10, this.freq[i]! / 20)
    if (this.prevMag) {
      let f = 0
      for (let i = 1; i < mag.length; i++) f += Math.max(0, mag[i]! - this.prevMag[i]!)
      const hist = this.flux
      const mean = hist.length ? hist.reduce((a, b) => a + b, 0) / hist.length : f
      const sd = hist.length ? Math.sqrt(hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length) : 0
      const thr = mean + 1.5 * sd + 1e-4
      const now = this.context.currentTime
      if (hist.length >= 10 && f > thr && now - this.lastOnset > MIN_GAP_S) {
        this.lastOnset = now
        for (const cb of this.onsetCbs) cb({ strength: f / thr, time: now })
      }
      hist.push(f)
      if (hist.length > 50) hist.shift()
    }
    this.prevMag = mag
  }
}

/** The engine's implementation; `emit` is how LiveEngine announces triggers. */
export class LiveBusImpl implements LiveBus {
  readonly mix: AudioTapImpl
  readonly voice: AudioTapImpl
  private readonly trigCbs = new Map<string, Set<(e: LiveTriggerEvent) => void>>()

  constructor(
    readonly context: AudioContext,
    readonly input: AnalyserNode,
    mixAnalyser: AnalyserNode,
    voiceAnalyser: AnalyserNode,
  ) {
    this.mix = new AudioTapImpl(context, mixAnalyser)
    this.voice = new AudioTapImpl(context, voiceAnalyser)
  }

  get analyser(): AnalyserNode {
    return this.mix.analyser
  }

  rms(): number {
    return this.mix.rms()
  }

  bands(): LiveBands {
    return this.mix.bands()
  }

  onOnset(cb: (e: LiveOnset) => void): () => void {
    return this.mix.onOnset(cb)
  }

  triggers(name: LiveTrigger | '*', cb: (e: LiveTriggerEvent) => void): () => void {
    const set = this.trigCbs.get(name) ?? new Set()
    set.add(cb)
    this.trigCbs.set(name, set)
    return () => set.delete(cb)
  }

  emit(e: LiveTriggerEvent): void {
    for (const key of [e.name, '*']) for (const cb of this.trigCbs.get(key) ?? []) cb(e)
  }

  dispose(): void {
    this.mix.dispose()
    this.voice.dispose()
    this.trigCbs.clear()
  }
}
