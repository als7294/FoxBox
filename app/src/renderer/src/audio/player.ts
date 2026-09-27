/**
 * Dry/wet A/B player on Web Audio. Both buffers play in lockstep from the same start time, and A/B
 * just crossfades two gains, so switching is instant and sample-aligned. Looping uses
 * AudioBufferSourceNode.loop, which is gapless, unlike a media element's loop, so a bar-exact file
 * loops exactly as it will on a CDJ.
 */
export type Side = 'dry' | 'wet'

export interface PlayerSnapshot {
  playing: boolean
  side: Side
  loop: boolean
  duration: number
  hasDry: boolean
  hasWet: boolean
}

/**
 * Where the file is on the AudioContext clock, for overlays locked to playback (the metronome). While playing,
 * the file position at context time t is `offset + (t - startedAt)`, wrapping from loop[1] back to loop[0] when
 * looping: the same maths as `currentTime`.
 */
export interface PlayerTimeline {
  /** Changes whenever the sources (re)start or stop: play, pause, stop, seek, loop change, new buffers. */
  epoch: number
  playing: boolean
  /** AudioContext time at which the sources started (the file was at `offset` then). */
  startedAt: number
  /** File position (s) the sources started from; the paused position while stopped. */
  offset: number
  duration: number
  /** The loop region [start, end) in seconds while looping, else null. */
  loop: [number, number] | null
}

type Listener = (snapshot: PlayerSnapshot) => void

let sharedContext: AudioContext | null = null

export function audioContext(): AudioContext {
  if (!sharedContext || sharedContext.state === 'closed') sharedContext = new AudioContext({ latencyHint: 'interactive' })
  return sharedContext
}

const OUTPUT_KEY = 'fvwks-output'
let outputDevice = ''
try {
  outputDevice = (typeof window !== 'undefined' && window.localStorage.getItem(OUTPUT_KEY)) || ''
} catch {
  // private mode: the choice lasts for the session
}

/** The output device chosen in SETTINGS ('' = system default). Survives relaunches. */
export function outputDeviceId(): string {
  return outputDevice
}

type SinkTarget = { setSinkId?: (id: string) => Promise<void> }

/** Plays an <audio> element (auditions, takes, Vault rows) through the output chosen in SETTINGS. */
export function routeToOutput(el: HTMLMediaElement): void {
  const target = el as HTMLMediaElement & SinkTarget
  if (outputDevice && target.setSinkId) void target.setSinkId(outputDevice).catch(() => undefined)
}

export async function decodeAudio(data: ArrayBuffer): Promise<AudioBuffer> {
  // decodeAudioData detaches its input; keep the caller's copy intact.
  return audioContext().decodeAudioData(data.slice(0))
}

/** Pads a buffer with silence to `frames` (so dry and wet loop in sync). */
function padTo(ctx: BaseAudioContext, buffer: AudioBuffer, frames: number): AudioBuffer {
  if (buffer.length >= frames) return buffer
  const out = ctx.createBuffer(buffer.numberOfChannels, frames, buffer.sampleRate)
  for (let c = 0; c < buffer.numberOfChannels; c++) out.copyToChannel(buffer.getChannelData(c), c)
  return out
}

export class DualPlayer {
  private ctx: AudioContext | null = null
  private buffers: Record<Side, AudioBuffer | null> = { dry: null, wet: null }
  private gains: Record<Side, GainNode> | null = null
  private master: GainNode | null = null
  /** Preview-only sounds (the metronome): straight to the output, beside the master (see monitorBus). */
  private monitor: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private sources: AudioBufferSourceNode[] = []
  private generation = 0
  private startedAt = 0
  private offset = 0
  private playing = false
  private side: Side = 'wet'
  private looping = false
  private loopRange: [number, number] | null = null
  private listeners = new Set<Listener>()
  private volume = 1

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  snapshot(): PlayerSnapshot {
    return {
      playing: this.playing,
      side: this.side,
      loop: this.looping,
      duration: this.duration,
      hasDry: Boolean(this.buffers.dry),
      hasWet: Boolean(this.buffers.wet),
    }
  }

  get duration(): number {
    return Math.max(this.buffers.wet?.duration ?? 0, this.buffers.dry?.duration ?? 0)
  }

  get isPlaying(): boolean {
    return this.playing
  }

  timeline(): PlayerTimeline {
    return {
      epoch: this.generation,
      playing: this.playing,
      startedAt: this.startedAt,
      offset: this.offset,
      duration: this.duration,
      loop: this.looping ? this.effectiveLoop() : null,
    }
  }

  /**
   * The bus for preview-only sounds layered over playback (the metronome): the same AudioContext and output
   * device, at the master volume, but not through the analyser, so the meters and the voice core show the voice
   * alone. Nothing on it reaches a render or an export. Null until playback has created the context.
   */
  monitorBus(): { ctx: AudioContext; input: AudioNode } | null {
    if (!this.ctx || this.ctx.state === 'closed' || !this.monitor) return null
    return { ctx: this.ctx, input: this.monitor }
  }

  /** Current position in seconds, following loops. */
  get currentTime(): number {
    if (!this.playing || !this.ctx) return this.offset
    const raw = this.offset + Math.max(0, this.ctx.currentTime - this.startedAt)
    if (!this.looping) return Math.min(raw, this.duration)
    const [start, end] = this.effectiveLoop()
    if (raw < end) return raw
    return start + ((raw - end) % (end - start))
  }

  /**
   * Replace the audio (after a re-render). Keeps playing from the same position when possible.
   * Buffers are padded to a common length so the two sides stay in lockstep.
   */
  setBuffers(buffers: Partial<Record<Side, AudioBuffer | null>>): void {
    const ctx = this.context()
    const next = { ...this.buffers, ...buffers }
    const frames = Math.max(next.dry?.length ?? 0, next.wet?.length ?? 0)
    const rate = next.wet?.sampleRate ?? next.dry?.sampleRate ?? ctx.sampleRate
    const pad = (b: AudioBuffer | null) => (b && b.sampleRate === rate ? padTo(ctx, b, frames) : b)
    const wasPlaying = this.playing
    const at = Math.min(this.currentTime, frames / rate)
    this.stopSources()
    this.buffers = { dry: pad(next.dry), wet: pad(next.wet) }
    if (!this.buffers[this.side]) this.side = this.buffers.wet ? 'wet' : 'dry'
    this.applyGains(true)
    this.offset = at >= this.duration ? 0 : at
    if (wasPlaying && this.duration > 0) this.startSources(this.offset)
    else this.playing = false
    this.emit()
  }

  clear(): void {
    this.stopSources()
    this.playing = false
    this.offset = 0
    this.buffers = { dry: null, wet: null }
    this.emit()
  }

  async play(from?: number): Promise<void> {
    if (this.duration <= 0) return
    const ctx = this.context()
    if (ctx.state === 'suspended') await ctx.resume()
    const at = from ?? (this.offset >= this.duration - 0.005 ? 0 : this.offset)
    this.stopSources()
    this.startSources(at)
    this.emit()
  }

  pause(): void {
    if (!this.playing) return
    this.offset = this.currentTime
    this.stopSources()
    this.playing = false
    this.emit()
  }

  /** Stop and return to the start (Space / ■ STOP). */
  stop(): void {
    this.stopSources()
    this.playing = false
    this.offset = 0
    this.emit()
  }

  toggle(): Promise<void> {
    if (this.playing) {
      this.pause()
      return Promise.resolve()
    }
    return this.play()
  }

  seek(seconds: number): void {
    const t = Math.max(0, Math.min(seconds, this.duration))
    if (this.playing) {
      this.stopSources()
      this.startSources(t)
    } else this.offset = t
    this.emit()
  }

  setSide(side: Side): void {
    if (!this.buffers[side] && this.duration > 0) return
    this.side = side
    this.applyGains(false)
    this.emit()
  }

  toggleSide(): Side {
    this.setSide(this.side === 'wet' ? 'dry' : 'wet')
    return this.side
  }

  /** Loop the whole file, or `range` [start, end) in seconds. */
  setLoop(on: boolean, range: [number, number] | null = null): void {
    const at = this.currentTime
    this.looping = on
    this.loopRange = range
    if (this.playing) {
      this.stopSources()
      this.startSources(at)
    }
    this.emit()
  }

  setVolume(volume: number): void {
    this.volume = volume
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.01)
    if (this.monitor && this.ctx) this.monitor.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.01)
  }

  /** Route playback (and auditions, via routeToOutput) to another output device, and remember it. */
  async setOutputDevice(deviceId: string): Promise<void> {
    const id = deviceId === 'default' ? '' : deviceId
    const ctx = this.context() as AudioContext & SinkTarget
    if (ctx.setSinkId) await ctx.setSinkId(id)
    outputDevice = id
    try {
      window.localStorage.setItem(OUTPUT_KEY, id)
    } catch {
      // private mode
    }
  }

  /** Output samples for level meters; false when there is no audio context yet. */
  readTimeDomain(buf: Float32Array<ArrayBuffer>): boolean {
    if (!this.analyser) return false
    this.analyser.getFloatTimeDomainData(buf)
    return true
  }

  /** Output spectrum (0..255 per bin, 512 bins). */
  readBins(bins: Uint8Array<ArrayBuffer>): boolean {
    if (!this.analyser) return false
    this.analyser.getByteFrequencyData(bins)
    return true
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48_000
  }

  dispose(): void {
    this.stopSources()
    this.listeners.clear()
  }

  private context(): AudioContext {
    if (this.ctx && this.ctx.state !== 'closed') return this.ctx
    const ctx = audioContext()
    this.ctx = ctx
    this.master = ctx.createGain()
    this.master.gain.value = this.volume
    this.master.connect(ctx.destination)
    this.monitor = ctx.createGain()
    this.monitor.gain.value = this.volume
    this.monitor.connect(ctx.destination)
    // Visuals only (voice core, meters): tapped after the master gain, not in the audio path.
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 1024
    this.analyser.smoothingTimeConstant = 0.6
    this.master.connect(this.analyser)
    const dry = ctx.createGain()
    const wet = ctx.createGain()
    dry.connect(this.master)
    wet.connect(this.master)
    this.gains = { dry, wet }
    this.applyGains(true)
    // The output chosen in SETTINGS on an earlier launch.
    const sink = ctx as AudioContext & SinkTarget
    if (outputDevice && sink.setSinkId) void sink.setSinkId(outputDevice).catch(() => undefined)
    return ctx
  }

  private applyGains(immediate: boolean): void {
    if (!this.gains || !this.ctx) return
    for (const s of ['dry', 'wet'] as const) {
      const target = s === this.side ? 1 : 0
      const param = this.gains[s].gain
      if (immediate) param.value = target
      else param.setTargetAtTime(target, this.ctx.currentTime, 0.004)
    }
  }

  private effectiveLoop(): [number, number] {
    const d = this.duration
    const [start, end] = this.loopRange ?? [0, d]
    const s = Math.max(0, Math.min(start, d))
    const e = Math.max(s + 0.01, Math.min(end, d))
    return [s, e]
  }

  private startSources(from: number): void {
    const ctx = this.context()
    const gen = ++this.generation
    const when = ctx.currentTime + 0.01
    const [loopStart, loopEnd] = this.effectiveLoop()
    // A looping source started at or past its loop end jumps straight to the loop start; fold the offset into
    // the loop first so the audio, currentTime and the metronome all agree on where playback is.
    const at = this.looping && from >= loopEnd ? loopStart + ((from - loopEnd) % (loopEnd - loopStart)) : from
    this.sources = []
    for (const side of ['dry', 'wet'] as const) {
      const buffer = this.buffers[side]
      if (!buffer || !this.gains) continue
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.loop = this.looping
      src.loopStart = loopStart
      src.loopEnd = loopEnd
      src.connect(this.gains[side])
      src.start(when, Math.min(at, buffer.duration))
      this.sources.push(src)
    }
    const primary = this.sources[this.sources.length - 1]
    if (primary) {
      primary.onended = () => {
        if (gen !== this.generation || this.looping) return
        this.playing = false
        this.offset = 0
        this.sources = []
        this.emit()
      }
    }
    this.startedAt = when
    this.offset = at
    this.playing = this.sources.length > 0
  }

  private stopSources(): void {
    this.generation++
    for (const src of this.sources) {
      src.onended = null
      try {
        src.stop()
      } catch {
        // never started
      }
      src.disconnect()
    }
    this.sources = []
  }

  private emit(): void {
    const snap = this.snapshot()
    for (const l of this.listeners) l(snap)
  }
}
