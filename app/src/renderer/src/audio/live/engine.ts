/**
 * LIVE voice mask: mic in → the rack, in real time → speakers / interface. One AudioContext
 * (latencyHint 'interactive'), the studio's module order, no lookahead anywhere:
 *
 *   mic → PREP (high-pass, gate) → MASK (Signalsmith Stretch: pitch + formant; bypassed at 0 / 0, which also drops
 *   its latency) → LAYERS (+ sub octave, + ghost whisper: a noise-carrier vocoder) → MACHINE (vocoder on the key
 *   root, ring mod, frequency shifter) → DRIVE (oversampled WaveShaper) → CRUSH (bits / rate, noise bed) → TONE
 *   (biquads) → DYNAMICS (compressor + OTT boost) → SPACE sends (convolution reverb on a generated IR, a
 *   tempo-synced delay, the throw delay, the reverse swell) → master (stutter / tape-stop / drop-out, safety clip)
 *   → out.
 *
 * `apply(liveParams(...))` sets it all from a studio preset (presets.ts); `trigger()` schedules the performance FX
 * on the session grid; `bus` is the shared connector (bus.ts); `latencyMs()` is the round trip estimate.
 */
import SignalsmithStretch, { type StretchNode } from './vendor/signalsmith-stretch/SignalsmithStretch.mjs'
import stretchUrl from './vendor/signalsmith-stretch/SignalsmithStretch.mjs?url'
import processorsUrl from './worklets/live-processors.js?url'
import { LiveBusImpl, type LiveBus, type LiveTrigger, type LiveTriggerEvent, type Quantize } from './bus'
import { noteSeconds, type LiveParams } from './presets'

export type LatencyMode = 'low' | 'balanced'

/** Stretch's latency is its block length (measured: 16 ms block → 16 ms). 'low' performs (a little grainier on low
 * voices); 'balanced' is smoother. At pitch 0 / formant 0 Stretch is bypassed and adds nothing. */
const STRETCH: Record<LatencyMode, { blockMs: number; intervalMs: number }> = {
  low: { blockMs: 16, intervalMs: 4 },
  balanced: { blockMs: 32, intervalMs: 8 },
}
const SMOOTH_S = 0.015
const DRIVE_RANGE = 8 // the shaper curve spans ±8 (pre-gain divides by it): headroom for +24 dB of drive
const THROW_FEEDBACK = 0.55

export interface LiveEngineOptions {
  deviceId?: string
  latency?: LatencyMode
  bpm?: number
}

export interface TriggerOptions {
  quantize?: Quantize
  /** stutter slice */
  div?: '1/8' | '1/16' | '1/32'
  /** stutter / tape-stop / drop-out length in beats */
  beats?: number
}

const dbToLin = (db: number) => Math.pow(10, db / 20)

function shaperCurve(mode: string): Float32Array<ArrayBuffer> {
  const n = 4096
  const c = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * DRIVE_RANGE
    let y: number
    if (mode.includes('fold')) y = Math.sin((x * Math.PI) / 2) // wavefolder
    else if (mode.includes('hard')) y = Math.max(-1, Math.min(1, mode.includes('tube') ? Math.tanh(1.5 * x) * 1.2 : x))
    else if (mode.includes('tube')) y = x >= 0 ? Math.tanh(x) : Math.tanh(0.7 * x) / 0.7 // asymmetric: even harmonics
    else y = Math.tanh(x)
    c[i] = Math.max(-1, Math.min(1, y))
  }
  return c
}

function impulse(ctx: BaseAudioContext, decayS: number, dark: number): AudioBuffer {
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
  private readonly stream: MediaStream
  private readonly stretch: StretchNode
  private stretchLatencyS = 0
  private stretchOn = false
  private bpm: number
  private anchor: number
  private session: { bpm: number; anchor: number }
  private follow: { bpm: number; anchor: number } | null = null
  /** Where a SongDeck plugs in: summed with the voice into the master (so the recorder and master FX get it). */
  readonly songInput: GainNode
  /** The masked voice before SPACE: the key for ducking a song under the voice. */
  readonly duckKey: AudioNode
  private params: LiveParams | null = null
  private gateOverrideDb: number | null = null
  private irKey = ''
  private curveMode = ''
  private vocoderKey = ''

  private readonly n: {
    inGain: GainNode
    hp: BiquadFilterNode
    gate: AudioWorkletNode
    direct: GainNode
    stretched: GainNode
    voice: GainNode
    sub: AudioWorkletNode
    ghost: AudioWorkletNode
    ghostGain: GainNode
    layers: GainNode
    vocoder: AudioWorkletNode
    ringshift: AudioWorkletNode
    driveDry: GainNode
    drivePre: GainNode
    shaper: WaveShaperNode
    driveTone: BiquadFilterNode
    drivePost: GainNode
    driveWet: GainNode
    driveOut: GainNode
    crush: AudioWorkletNode
    toneHp: BiquadFilterNode
    toneLp: BiquadFilterNode
    lowShelf: BiquadFilterNode
    peak: BiquadFilterNode
    comp: AudioWorkletNode
    revSend: GainNode
    swellSend: GainNode
    predelay: DelayNode
    reverb: ConvolverNode
    delaySend: GainNode
    delay: DelayNode
    delayFb: GainNode
    throwSend: GainNode
    throwDelay: DelayNode
    master: GainNode
    perform: AudioWorkletNode
    out: GainNode
  }

  /** Opens the mic (asks for permission), loads the worklets and builds the chain. Call `apply()` next. */
  static async create(opts: LiveEngineOptions = {}): Promise<LiveEngine> {
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      })
      await ctx.audioWorklet.addModule(processorsUrl)
      SignalsmithStretch.moduleUrl = stretchUrl // a file URL: the default blob: URL is blocked by the app's CSP
      const stretch = await SignalsmithStretch(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
      const engine = new LiveEngine(ctx, stream, stretch, opts.bpm ?? 120)
      await engine.setLatencyMode(opts.latency ?? 'low')
      return engine
    } catch (err) {
      await ctx.close().catch(() => {})
      throw err
    }
  }

  private constructor(ctx: AudioContext, stream: MediaStream, stretch: StretchNode, bpm: number) {
    this.ctx = ctx
    this.stream = stream
    this.stretch = stretch
    this.bpm = bpm
    this.anchor = ctx.currentTime
    this.session = { bpm, anchor: this.anchor }
    const mono = { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' as const }
    const gain = (v = 1) => new GainNode(ctx, { gain: v })
    const biquad = (type: BiquadFilterType, frequency: number) => new BiquadFilterNode(ctx, { type, frequency })
    const worklet = (name: string, extra: Partial<AudioWorkletNodeOptions> = {}) => new AudioWorkletNode(ctx, name, { ...mono, ...extra })

    const n = (this.n = {
      inGain: gain(),
      hp: biquad('highpass', 70),
      gate: worklet('fvwks-gate'),
      direct: gain(1),
      stretched: gain(0),
      voice: gain(),
      sub: worklet('fvwks-sub'),
      ghost: worklet('fvwks-vocoder', { processorOptions: { carrier: 'noise', bands: 12 } }),
      ghostGain: gain(0),
      layers: gain(),
      vocoder: worklet('fvwks-vocoder', { processorOptions: { carrier: 'saw', bands: 16 } }),
      ringshift: worklet('fvwks-ringshift'),
      driveDry: gain(1),
      drivePre: gain(1),
      shaper: new WaveShaperNode(ctx, { oversample: '4x' }),
      driveTone: biquad('lowpass', 8000),
      drivePost: gain(1),
      driveWet: gain(0),
      driveOut: gain(),
      crush: worklet('fvwks-crush'),
      toneHp: biquad('highpass', 20),
      toneLp: biquad('lowpass', 20000),
      lowShelf: biquad('lowshelf', 120),
      peak: biquad('peaking', 1000),
      comp: worklet('fvwks-comp'),
      revSend: gain(0),
      swellSend: gain(0),
      predelay: new DelayNode(ctx, { delayTime: 0.01, maxDelayTime: 0.2 }),
      reverb: new ConvolverNode(ctx),
      delaySend: gain(0),
      delay: new DelayNode(ctx, { delayTime: 0.25, maxDelayTime: 4 }),
      delayFb: gain(0.35),
      throwSend: gain(0),
      throwDelay: new DelayNode(ctx, { delayTime: 0.375, maxDelayTime: 4 }),
      master: new GainNode(ctx, { gain: 1, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' }),
      perform: worklet('fvwks-perform', { outputChannelCount: [2], channelCount: 2 }),
      out: gain(1),
    })
    n.ghost.parameters.get('mix')!.value = 1
    const inputTap = new AnalyserNode(ctx, { fftSize: 2048 })
    const outputTap = new AnalyserNode(ctx, { fftSize: 2048 })
    const voiceTap = new AnalyserNode(ctx, { fftSize: 2048 })
    const voiceBus = gain() // the masked voice with its SPACE, before the song joins

    // PREP → MASK (the two paths cross-fade: Stretch only runs while it shifts something)
    ctx.createMediaStreamSource(stream).connect(n.inGain)
    n.inGain.connect(inputTap)
    n.inGain.connect(n.hp).connect(n.gate)
    n.gate.connect(n.direct).connect(n.voice)
    n.gate.connect(stretch).connect(n.stretched).connect(n.voice)
    // LAYERS
    n.voice.connect(n.layers)
    n.voice.connect(n.sub).connect(n.layers)
    n.voice.connect(n.ghost).connect(n.ghostGain).connect(n.layers)
    // MACHINE → DRIVE
    n.layers.connect(n.vocoder).connect(n.ringshift)
    n.ringshift.connect(n.driveDry).connect(n.driveOut)
    n.ringshift.connect(n.drivePre).connect(n.shaper).connect(n.driveTone).connect(n.drivePost).connect(n.driveWet).connect(n.driveOut)
    // CRUSH → TONE → DYNAMICS
    n.driveOut.connect(n.crush).connect(n.toneHp).connect(n.toneLp).connect(n.lowShelf).connect(n.peak).connect(n.comp)
    // SPACE: dry + sends, summed on the voice bus
    n.comp.connect(voiceBus)
    n.comp.connect(n.revSend).connect(n.predelay)
    n.comp.connect(n.swellSend).connect(n.predelay)
    n.predelay.connect(n.reverb).connect(voiceBus)
    n.comp.connect(n.delaySend).connect(n.delay)
    const delayLp = biquad('lowpass', 4500)
    n.delay.connect(delayLp).connect(n.delayFb).connect(n.delay)
    delayLp.connect(voiceBus)
    n.comp.connect(n.throwSend).connect(n.throwDelay)
    const throwLp = biquad('lowpass', 3500)
    const throwFb = gain(THROW_FEEDBACK)
    n.throwDelay.connect(throwLp).connect(throwFb).connect(n.throwDelay)
    throwLp.connect(voiceBus)
    // master: voice + song
    voiceBus.connect(voiceTap)
    voiceBus.connect(n.master)
    this.songInput = new GainNode(ctx, { gain: 1, channelCount: 2, channelCountMode: 'explicit' })
    this.songInput.connect(n.master)
    this.duckKey = n.comp
    n.master.connect(n.perform).connect(n.out)
    n.out.connect(outputTap)
    n.out.connect(ctx.destination)

    this.busImpl = new LiveBusImpl(ctx, inputTap, outputTap, voiceTap)
    this.bus = this.busImpl
  }

  /** Stretch's block size: 'low' (default) for performing, 'balanced' for smoother low voices. */
  async setLatencyMode(mode: LatencyMode): Promise<void> {
    await this.stretch.configure(STRETCH[mode])
    this.stretchLatencyS = await this.stretch.latency()
  }

  /** Round trip estimate, ms: the context's output path, the mic's input latency and the pitch shifter (when on). */
  latencyMs(): number {
    const track = this.stream.getAudioTracks()[0]
    const input = (track?.getSettings() as MediaTrackSettings & { latency?: number }).latency ?? 0
    const out = this.ctx.baseLatency + (this.ctx.outputLatency || 0)
    return (out + input + (this.stretchOn ? this.stretchLatencyS : 0)) * 1000
  }

  /** The session grid: `bpm`, with beat 1 at `anchor` (AudioContext time; defaults to when LIVE started). */
  setTempo(bpm: number, anchor: number = this.session.anchor): void {
    this.session = { bpm: Math.max(40, Math.min(240, bpm)), anchor }
    this.applyTempo()
  }

  /** A playing song's beat clock takes over the grid (quantized FX, delay times); null hands it back to the session. */
  followClock(clock: { bpm: number; anchor: number } | null): void {
    this.follow = clock
    this.applyTempo()
  }

  /** The AudioContext time of the next 1/16, beat or bar on the active grid. */
  nextGridTime(q: Quantize): number {
    return this.nextGrid(q)
  }

  /** The performer's gate threshold (dB), over the preset's; null hands it back to the preset. */
  setGate(db: number | null): void {
    this.gateOverrideDb = db
    if (this.params) this.set(this.n.gate.parameters.get('thresholdDb')!, db ?? this.params.gateDb)
  }

  /** Push-to-talk: opens / closes the mic input only (an 8 ms ramp, no click); reverb, delay, the song and the FX
   * tails keep ringing after release. */
  setTalk(on: boolean): void {
    const g = this.n.inGain.gain
    const t = this.ctx.currentTime
    g.cancelScheduledValues(t)
    g.setValueAtTime(g.value, t)
    g.linearRampToValueAtTime(on ? 1 : 0, t + 0.008)
  }

  setOutputGain(db: number): void {
    this.set(this.n.out.gain, dbToLin(db))
  }

  /** Sets every stage from a preset's live params (presets.ts `liveParams`). Cheap: call it as macros move. */
  apply(p: LiveParams): void {
    const n = this.n
    this.params = p
    const P = (node: AudioWorkletNode, name: string) => node.parameters.get(name)!
    // PREP
    this.set(n.hp.frequency, Math.max(20, p.hpHz))
    this.set(P(n.gate, 'thresholdDb'), Math.max(-90, this.gateOverrideDb ?? p.gateDb))
    // MASK: Stretch only when it shifts
    const shift = Math.abs(p.pitchSt) > 0.05 || Math.abs(p.formantSt) > 0.05
    if (shift) void this.stretch.schedule({ active: true, semitones: p.pitchSt, formantSemitones: p.formantSt, formantCompensation: true, formantBaseHz: 0 })
    if (shift !== this.stretchOn) {
      this.stretchOn = shift
      this.set(n.direct.gain, shift ? 0 : 1)
      this.set(n.stretched.gain, shift ? 1 : 0)
      if (!shift) void this.stretch.schedule({ active: false, output: this.ctx.currentTime + 0.1 })
    }
    // LAYERS
    this.set(P(n.sub, 'gain'), p.subDb > -59.5 ? dbToLin(p.subDb) : 0)
    this.set(n.ghostGain.gain, (p.ghostDb > -59.5 ? dbToLin(p.ghostDb) : 0) + 0.5 * p.whisper)
    // MACHINE
    this.set(P(n.vocoder, 'mix'), p.vocoderMix)
    this.set(P(n.vocoder, 'rootHz'), p.rootHz)
    const vk = `${p.vocoderCarrier}|${p.vocoderFifth}|${p.vocoderBands}`
    if (vk !== this.vocoderKey) {
      this.vocoderKey = vk
      n.vocoder.port.postMessage({ carrier: p.vocoderCarrier, fifth: p.vocoderFifth, bands: Math.min(20, p.vocoderBands) })
    }
    this.set(P(n.ringshift, 'ringMix'), p.ringMix)
    this.set(P(n.ringshift, 'ringHz'), p.ringHz)
    this.set(P(n.ringshift, 'shiftMix'), p.shiftMix)
    this.set(P(n.ringshift, 'shiftHz'), p.shiftHz)
    // DRIVE
    if (p.driveMode !== this.curveMode) {
      this.curveMode = p.driveMode
      n.shaper.curve = shaperCurve(p.driveMode)
    }
    const mix = p.driveOn ? Math.min(1, Math.max(0, p.driveMix)) : 0
    this.set(n.driveDry.gain, 1 - mix)
    this.set(n.driveWet.gain, mix)
    this.set(n.drivePre.gain, dbToLin(p.driveDb) / DRIVE_RANGE)
    this.set(n.drivePost.gain, dbToLin(-0.35 * p.driveDb))
    this.set(n.driveTone.frequency, Math.min(this.ctx.sampleRate * 0.45, p.driveToneHz))
    // CRUSH
    this.set(P(n.crush, 'bits'), p.crushBits)
    this.set(P(n.crush, 'rateHz'), Math.min(this.ctx.sampleRate, p.crushRateHz))
    this.set(P(n.crush, 'mix'), p.crushMix)
    this.set(P(n.crush, 'noiseDb'), p.noiseDb)
    // TONE (neutral when the module is off)
    this.set(n.toneHp.frequency, p.toneOn ? Math.max(20, p.toneHpHz) : 20)
    this.set(n.toneLp.frequency, p.toneOn ? Math.min(this.ctx.sampleRate * 0.45, p.toneLpHz) : this.ctx.sampleRate * 0.45)
    this.set(n.lowShelf.frequency, p.lowHz)
    this.set(n.lowShelf.gain, p.toneOn ? p.lowDb : 0)
    this.set(n.peak.frequency, p.midHz)
    this.set(n.peak.gain, p.toneOn ? p.midDb : 0)
    this.set(n.peak.Q, p.midQ)
    // DYNAMICS
    this.set(P(n.comp, 'on'), p.compOn ? 1 : 0)
    this.set(P(n.comp, 'thresholdDb'), p.compThresholdDb)
    this.set(P(n.comp, 'ratio'), Math.max(1, p.compRatio))
    this.set(P(n.comp, 'attackMs'), p.compAttackMs)
    this.set(P(n.comp, 'releaseMs'), p.compReleaseMs)
    this.set(P(n.comp, 'makeupDb'), p.makeupDb)
    this.set(P(n.comp, 'ott'), p.ott)
    // SPACE
    this.set(n.revSend.gain, p.reverbMix)
    this.set(n.predelay.delayTime, Math.min(0.2, p.predelayMs / 1000))
    const ir = `${p.reverbDecayS.toFixed(2)}|${p.reverbDark.toFixed(2)}`
    if (ir !== this.irKey) {
      this.irKey = ir
      n.reverb.buffer = impulse(this.ctx, p.reverbDecayS, p.reverbDark)
    }
    this.set(n.delaySend.gain, p.delayMix)
    this.set(n.delayFb.gain, Math.min(0.9, Math.max(0, p.delayFeedback)))
    this.applySpaceTimes(p)
  }

  /** Schedules a performance FX on the next grid point; announces it on `bus.triggers`. */
  trigger(name: LiveTrigger, opts: TriggerOptions = {}): LiveTriggerEvent {
    const p = this.params
    const beat = 60 / this.bpm
    const q: Quantize = opts.quantize ?? (name === 'swell' ? 'bar' : name === 'stutter' ? '1/16' : 'beat')
    let at = this.nextGrid(q)
    const now = this.ctx.currentTime
    let durS = beat
    if (name === 'throw') {
      // open the throw send for one beat: that slice of voice echoes on (dotted 1/4, feedback 0.55)
      const g = this.n.throwSend.gain
      g.setTargetAtTime(p ? Math.max(0.2, p.throwSend) : 0.6, at, 0.003)
      g.setTargetAtTime(0, at + beat, 0.01)
    } else if (name === 'stutter') {
      durS = (opts.beats ?? 1) * beat
      const slice = noteSeconds(opts.div ?? p?.stutterDiv ?? '1/16', this.bpm)
      this.n.perform.port.postMessage({ kind: 'stutter', at, slice, dur: durS })
    } else if (name === 'swell') {
      // a reverse swell, approximated: the reverb send builds into the grid point, then cuts
      if (at - now < beat) at += 4 * beat
      durS = at - now
      const g = this.n.swellSend.gain
      g.cancelScheduledValues(now)
      g.setValueAtTime(0.0001, now)
      g.exponentialRampToValueAtTime(Math.max(0.6, 2 * (p?.reverbMix ?? 0.3)), at)
      g.setValueAtTime(0, at + 0.005)
    } else if (name === 'tapestop') {
      durS = (opts.beats ?? p?.tapeStopBeats ?? 1) * beat
      this.n.perform.port.postMessage({ kind: 'tapestop', at, dur: durS, hold: beat })
    } else {
      durS = (opts.beats ?? 1) * beat
      this.n.perform.port.postMessage({ kind: 'mute', at, dur: durS })
    }
    const ev: LiveTriggerEvent = { name, quantize: q, at, durS }
    this.busImpl.emit(ev)
    return ev
  }

  async close(): Promise<void> {
    this.busImpl.dispose()
    for (const t of this.stream.getTracks()) t.stop()
    await this.ctx.close()
  }

  private nextGrid(q: Quantize): number {
    const beat = 60 / this.bpm
    const unit = q === '1/16' ? beat / 4 : q === 'beat' ? beat : 4 * beat
    const now = this.ctx.currentTime + 0.01 // never schedule into the render quantum already playing
    return this.anchor + Math.ceil((now - this.anchor) / unit - 1e-9) * unit
  }

  private applyTempo(): void {
    const g = this.follow ?? this.session
    this.bpm = g.bpm
    this.anchor = g.anchor
    if (this.params) this.applySpaceTimes(this.params)
  }

  private applySpaceTimes(p: LiveParams): void {
    this.set(this.n.delay.delayTime, Math.min(4, noteSeconds(p.delayDiv, this.bpm)))
    this.set(this.n.throwDelay.delayTime, Math.min(4, noteSeconds('1/4d', this.bpm)))
  }

  private set(param: AudioParam, value: number): void {
    if (Number.isFinite(value)) param.setTargetAtTime(value, this.ctx.currentTime, SMOOTH_S)
  }
}
