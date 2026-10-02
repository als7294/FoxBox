/**
 * The TRACK song's live FX (1.5.2): what a TouchDesigner preset's `sound` map (macros, audio channels, camera
 * gestures) does to the song while VISUALS plays it. The song only: SongDeck puts this between its duck and the
 * master, so MIC and the voice mask never pass through it.
 *
 *   in → fvwks-songfx (tape stop / spin-up, beat repeat, bitcrush) → low-pass → high-pass → pan ─┬─ dry ──┐
 *                                                    ├─ echo send → delay ⟲ (HP, LP, feedback ≤ 0.6) ─┤
 *                                                    └─ wash send → reverb ─────────────────────────┴→ fvwks-limit → out
 *
 * Every parameter moves by setTargetAtTime or the worklets' one-poles (no clicks); resonance and feedback are capped
 * and the true-peak limiter closes the chain at -1 dBTP. The song only goes through the chain while an FX is engaged
 * (and TAIL_S after, for the echo and reverb tails): otherwise it takes the bypass, untouched (a hot master would lose
 * ~1.7 dB to the limiter alone); the bypass is delayed by the limiter's look-ahead so the crossfade never combs.
 * `setEnabled(false)` keeps it on the bypass. `reset()` (a new preset, a new base) ramps everything neutral and cuts the echo and reverb
 * tails. The UI reads `useSongFx` (enabled, the FX engaged, the limiter's gain reduction).
 */
import { create } from 'zustand'
import type { BeatClock } from './songDeck'

export interface SongFxParams {
  /** -1..1: below 0 the low-pass sweeps down (20 kHz → 120 Hz), above 0 the high-pass sweeps up (20 Hz → 5 kHz). */
  filter: number
  /** 0..1: the swept filter's resonance (0..12 dB, its level compensated by half). */
  resonance: number
  /** 0..1: the echo throw's send; the tail rings out when it drops. */
  echo: number
  /** The echo's time in beats (0.25 / 0.5 / 0.75 / 1). */
  echoBeats: number
  /** 0..1: at 0.5 and over, a beat repeat holds (from the next grid step, to the one after it drops). */
  stutter: number
  /** The repeat's slice: 4 (a beat), 8 or 16. */
  stutterDiv: number
  /** 0..1: the playback rate falls to 1 - tape (1 stops it); back at 0 it spins up. */
  tape: number
  /** 0..1: bits 16 → 4, the rate down with them. */
  crush: number
  /** 0..1: the reverb wash's send. */
  wash: number
  /** -1..1. */
  pan: number
  /** 0..1 each: a stem's level while the song plays from its stems (1: as in the mix; its lowpass closes with it). */
  drums: number
  bass: number
  vocals: number
  other: number
  /** STRINGS' bass-remix FX on the stems (the stemfx worklet, on the song's beat), 0..1 unless noted: WOBBLE (amount,
   *  depth and resonance, its rate in cycles a beat: 1 a 1/4 note … 6 a 1/16T), GROWL (amount, vowel o 0 · a 0.5 · i 1),
   *  TEAROUT (drive), RIDDIM (gate: the chop's depth, gateRate chops a beat), the pump, SUB DROP (on at 0.5), the 808
   *  slide (bassSemi, -24..24 semitones) and the shake's vibrato; GLASS's world (0 none, 1 HEAT, 2 SKELETON, 3 8-BIT,
   *  4 SHIMMER, 5 MIRROR, 6 GLITCH), how far in (worldWet) and its one control (worldTilt). */
  wobble: number
  wobbleDepth: number
  wobbleRate: number
  growl: number
  vowel: number
  tear: number
  gate: number
  gateRate: number
  pump: number
  subdrop: number
  bassSemi: number
  vibrato: number
  world: number
  worldWet: number
  worldTilt: number
  /** The big moves on the whole song (the moves worklet; slip: letting go comes back in time), each on at 0.5:
   *  HALFTIME, BUILD ROLL, the octave drop; REWIND and REVERSE fire on the rise; BRAKE stops it like a vinyl and spins
   *  back on letting go. */
  halftime: number
  buildroll: number
  octave: number
  rewind: number
  reverse: number
  brake: number
  /** GLASS: in (0.5 and up) and out each sweep a whoosh; `crack` (a rise past 0.5) the glass shattering: a crush and a
   *  stutter hit. Its sound is the world's (above). */
  glass: number
  crack: number
  /** FINGER FILTERS (the iso worklet, on the whole song): `iso` on at 0.5 (STRINGS while it shows), each band's cut
   *  0 open … 1 killed: SUB < 60 Hz, LOW 60-250, MID 250-1k, HIGH-MID 1-4k, HIGH > 4k. */
  iso: number
  cutSub: number
  cutLow: number
  cutMid: number
  cutHiMid: number
  cutHigh: number
}

/** The stem FX, as the stemfx worklet names them; the moves, as the moves worklet does. */
export const STEM_FX = ['wobble', 'wobbleDepth', 'wobbleRate', 'growl', 'vowel', 'tear', 'gate', 'gateRate', 'pump', 'subdrop', 'bassSemi',
  'vibrato', 'world', 'worldWet', 'worldTilt'] as const
export const MOVES = ['halftime', 'buildroll', 'octave', 'rewind', 'reverse', 'brake'] as const
export const CUTS = ['cutSub', 'cutLow', 'cutMid', 'cutHiMid', 'cutHigh'] as const
const RANGE: Partial<Record<keyof SongFxParams, [number, number]>> = { wobbleRate: [0.25, 8], gateRate: [0.25, 8], bassSemi: [-24, 24], world: [0, 6] }

export const STEMS = ['drums', 'bass', 'vocals', 'other'] as const
export type StemName = (typeof STEMS)[number]

export const NEUTRAL: SongFxParams = Object.freeze({
  filter: 0, resonance: 0, echo: 0, echoBeats: 0.75, stutter: 0, stutterDiv: 8, tape: 0, crush: 0, wash: 0, pan: 0,
  drums: 1, bass: 1, vocals: 1, other: 1, wobble: 0, wobbleDepth: 0, wobbleRate: 2, growl: 0, vowel: 0.5, tear: 0, gate: 0, gateRate: 3,
  pump: 0, subdrop: 0, bassSemi: 0, vibrato: 0, world: 0, worldWet: 0, worldTilt: 0, halftime: 0, buildroll: 0, octave: 0, rewind: 0,
  reverse: 0, brake: 0, glass: 0, crack: 0, iso: 0, cutSub: 0, cutLow: 0, cutMid: 0, cutHiMid: 0, cutHigh: 0,
})

/** A stem's lowpass for its level: open (20 kHz) at 1, closing exponentially to 250 Hz at 0, so a fading stem dulls. */
export const stemLowpassHz = (level: number): number => 250 * Math.pow(80, clamp(level, 0, 1))

/** Any of STRINGS' FX engaged (the chain, its limiter, goes in for them). */
export const stemFxOn = (p: SongFxParams): boolean =>
  p.wobble > 0.02 || p.growl > 0.02 || p.tear > 0.02 || p.gate > 0.02 || p.pump > 0.02 || p.subdrop >= 0.5 || Math.abs(p.bassSemi) > 0.05 ||
  p.vibrato > 0.02 || (p.world >= 1 && p.worldWet > 0.02) || MOVES.some((k) => p[k] >= 0.5) || CUTS.some((k) => p[k] > 0.02)

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : 0))
}

export type FxName = 'filter' | 'echo' | 'stutter' | 'tape' | 'crush' | 'wash' | 'pan'

/** The FX a set of parameters engages (the UI's indicator). */
export function activeFx(p: SongFxParams): FxName[] {
  const on: [FxName, boolean][] = [['filter', Math.abs(p.filter) > 0.02], ['echo', p.echo > 0.02], ['stutter', p.stutter >= 0.5],
    ['tape', p.tape > 0.02], ['crush', p.crush > 0.02], ['wash', p.wash > 0.02], ['pan', Math.abs(p.pan) > 0.05]]
  return on.filter(([, v]) => v).map(([k]) => k)
}


/** The two filters' cutoffs for `filter` (exponential sweeps: equal moves sound equal). */
export function filterHz(filter: number): { lp: number; hp: number } {
  const f = clamp(filter, -1, 1)
  // the high-pass rests at 5 Hz, not 20: at 20 it turned a bass master's sub (30-50 Hz) 35-50° against its kick, its
  // peaks up ~3 dB into the limiter whenever the chain went in
  return { lp: f < 0 ? 20000 * Math.pow(120 / 20000, -f) : 20000, hp: f > 0 ? 5 * Math.pow(5000 / 5, f) : 5 }
}

/** The context time of the next 1/`div` grid step after `now` (a step's length in beats is 4 / div); `now` itself
 * without a running clock. */
export function nextStep(clock: BeatClock | null, div: number, now: number): number {
  if (!clock || !clock.playing || !(clock.bpm > 0)) return now
  const step = 4 / div
  const next = Math.ceil(clock.beat / step - 1e-6) * step
  return now + ((next - clock.beat) * 60) / clock.bpm
}

/** Where the deck's song comes from: the mix; splitting its stems (started for a look that wants them); decoding them;
 *  playing from them; or the split failed (the mix plays on). */
export type DeckStems = 'mix' | 'splitting' | 'loading' | 'on' | 'failed'

/**
 * `wantStems`: the active preset's map moves a stem (soundMap.ts sets it): the deck plays the song from its stems,
 * splitting them first if it must. `stems` / `stemsProgress` (0-1 while splitting) are for the look's note.
 */
export const useSongFx = create<{
  enabled: boolean
  active: FxName[]
  grDb: number
  wantStems: boolean
  stems: DeckStems
  stemsProgress: number | null
  setEnabled(on: boolean): void
}>((set) => ({
  enabled: true,
  active: [],
  grDb: 0,
  wantStems: false,
  stems: 'mix',
  stemsProgress: null,
  setEnabled: (enabled) => set({ enabled }),
}))

let current: SongFx | null = null
/** The playing SongDeck's FX (one deck at a time), for the preset driver (soundMap.ts). */
export const currentSongFx = (): SongFx | null => current

const TAU_S = 0.03 // the ramps' time constant: ~100 ms to settle, never a step
const TAIL_S = 4 // the chain stays in this long after the last FX lets go: the echo and the wash ring out
const MAX_Q_DB = 12
/** STRINGS' headroom: the song 6 dB down into its chain, so a hot master doesn't sit on the limiter at rest; a cut or an
 *  FX then changes only what it touches (the limiter idle, not letting go or clamping down on the rest). Sized for a
 *  clipped -7 LUFS master: FINGER FILTERS' crossovers turn its phase and so lift its peaks ~4 dB (any LR isolator does),
 *  always on in STRINGS so there's no jump. */
const STRINGS_TRIM = Math.pow(10, -6 / 20)
const FEEDBACK = 0.55

export class SongFx {
  readonly input: GainNode
  readonly output: GainNode
  /** Each stem's way in (its level), through its lowpass to stemOutput (the deck plays the stems into these). */
  readonly stemInputs: Record<StemName, GainNode>
  readonly stemOutput: GainNode
  private readonly stemLp: Record<StemName, BiquadFilterNode>
  private readonly stemFx: AudioWorkletNode
  private readonly moves: AudioWorkletNode
  private readonly iso: AudioWorkletNode
  private glassOn = false
  private glassAt = -Infinity
  private cracked = false
  private crackUntil = -Infinity
  private beatAt = { bpm: 0, anchor: 0 }
  private p: SongFxParams = { ...NEUTRAL }
  private readonly pre: AudioWorkletNode
  private readonly lp: BiquadFilterNode
  private readonly hp: BiquadFilterNode
  private readonly trim: GainNode
  private readonly pan: StereoPannerNode
  private readonly dry: GainNode
  private readonly echoSend: GainNode
  private readonly delay: DelayNode
  private readonly feedback: GainNode
  private readonly echoReturn: GainNode
  private readonly washSend: GainNode
  private readonly washReturn: GainNode
  private readonly limit: AudioWorkletNode
  private readonly wet: GainNode
  private readonly bypass: GainNode
  private stutterOn = false
  private enabled = true
  private wetOn = false
  private lastActive = -Infinity
  private readonly offStore: () => void

  constructor(private readonly ctx: BaseAudioContext, private readonly clock: () => BeatClock | null, ir: AudioBuffer) {
    const stereo = { channelCount: 2, channelCountMode: 'explicit' as const }
    this.input = new GainNode(ctx, { gain: 1, ...stereo })
    this.output = new GainNode(ctx, { gain: 1, ...stereo })
    this.pre = new AudioWorkletNode(ctx, 'fvwks-songfx', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
    this.lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 20000, Q: 0 })
    this.hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 5, Q: 0 })
    this.trim = new GainNode(ctx, { gain: 1, ...stereo })
    this.pan = new StereoPannerNode(ctx, { pan: 0 })
    this.dry = new GainNode(ctx, { gain: 1, ...stereo })
    this.echoSend = new GainNode(ctx, { gain: 0, ...stereo })
    this.delay = new DelayNode(ctx, { maxDelayTime: 4, delayTime: 0.375 })
    this.feedback = new GainNode(ctx, { gain: FEEDBACK, ...stereo })
    const fbHp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 250, Q: 0 })
    const fbLp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 4500, Q: 0 })
    this.echoReturn = new GainNode(ctx, { gain: 0.7, ...stereo })
    this.washSend = new GainNode(ctx, { gain: 0, ...stereo })
    const reverb = new ConvolverNode(ctx, { buffer: ir })
    this.washReturn = new GainNode(ctx, { gain: 0.6, ...stereo })
    this.limit = new AudioWorkletNode(ctx, 'fvwks-limit', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
    this.wet = new GainNode(ctx, { gain: 0, ...stereo })
    this.bypass = new GainNode(ctx, { gain: 1, ...stereo })
    const align = new DelayNode(ctx, { maxDelayTime: 0.01, delayTime: (Math.max(4, Math.round(0.0015 * ctx.sampleRate)) + 5) / ctx.sampleRate })
    this.stemOutput = new GainNode(ctx, { gain: 1, ...stereo })
    const ins = {} as Record<StemName, GainNode>
    const lps = {} as Record<StemName, BiquadFilterNode>
    for (const name of STEMS) {
      ins[name] = new GainNode(ctx, { gain: 1, ...stereo })
      lps[name] = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: stemLowpassHz(1), Q: 0 })
    }
    // the stems summed through STRINGS' bass-music FX (each a straight pass at 0)
    this.stemFx = new AudioWorkletNode(ctx, 'fvwks-stemfx', { numberOfInputs: 4, numberOfOutputs: 1, outputChannelCount: [2] })
    STEMS.forEach((name, i) => ins[name].connect(lps[name]).connect(this.stemFx, 0, i))
    this.stemFx.connect(this.stemOutput)
    this.stemInputs = ins
    this.stemLp = lps

    this.moves = new AudioWorkletNode(ctx, 'fvwks-moves', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
    // FINGER FILTERS ahead of the bypass split: a cut sounds the same through either way, no swish as the route turns
    this.iso = new AudioWorkletNode(ctx, 'fvwks-iso', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
    this.input.connect(this.iso).connect(this.moves).connect(this.pre).connect(this.lp).connect(this.hp).connect(this.trim).connect(this.pan)
    this.pan.connect(this.dry).connect(this.limit)
    this.pan.connect(this.echoSend).connect(this.delay)
    this.delay.connect(fbHp).connect(fbLp).connect(this.feedback).connect(this.delay) // the loop, filtered and capped
    this.delay.connect(this.echoReturn).connect(this.limit)
    this.pan.connect(this.washSend).connect(reverb).connect(this.washReturn).connect(this.limit)
    this.limit.connect(this.wet).connect(this.output)
    this.iso.connect(align).connect(this.bypass).connect(this.output)
    this.limit.port.onmessage = (e: MessageEvent<{ gr?: number }>) => {
      const gr = Math.round((e.data?.gr ?? 0) * 10) / 10
      if (gr !== useSongFx.getState().grDb) useSongFx.setState({ grDb: gr })
    }
    this.enabled = useSongFx.getState().enabled
    current = this
    this.offStore = useSongFx.subscribe((s) => {
      if (s.enabled === this.enabled) return
      this.enabled = s.enabled
      if (!s.enabled) this.reset()
      this.route()
    })
  }

  get params(): SongFxParams {
    return { ...this.p }
  }

  /** Moves the FX toward `next` (unset fields keep their value). */
  set(next: Partial<SongFxParams>): void {
    const p = { ...this.p, ...next }
    p.filter = clamp(p.filter, -1, 1)
    p.resonance = clamp(p.resonance, 0, 1)
    p.echo = clamp(p.echo, 0, 1)
    p.echoBeats = [0.25, 0.5, 0.75, 1].reduce((a, b) => (Math.abs(b - p.echoBeats) < Math.abs(a - p.echoBeats) ? b : a))
    p.stutter = clamp(p.stutter, 0, 1)
    p.stutterDiv = [4, 8, 16].reduce((a, b) => (Math.abs(b - p.stutterDiv) < Math.abs(a - p.stutterDiv) ? b : a))
    p.tape = clamp(p.tape, 0, 1)
    p.crush = clamp(p.crush, 0, 1)
    p.wash = clamp(p.wash, 0, 1)
    p.pan = clamp(p.pan, -1, 1)
    for (const name of STEMS) p[name] = clamp(p[name], 0, 1)
    for (const name of [...STEM_FX, ...MOVES, ...CUTS, 'iso', 'glass', 'crack'] as const) p[name] = clamp(p[name], ...(RANGE[name] ?? [0, 1]))
    const t = this.ctx.currentTime
    const ramp = (a: AudioParam, v: number, tau = TAU_S) => a.setTargetAtTime(v, t, tau)
    ramp(this.input.gain, this.enabled && p.iso >= 0.5 ? STRINGS_TRIM : 1, 0.05)
    for (const name of STEMS) {
      const level = this.enabled ? p[name] : 1 // AUDIO FX off: the stems as in the mix
      ramp(this.stemInputs[name].gain, level)
      ramp(this.stemLp[name].frequency, stemLowpassHz(level))
    }
    const f = filterHz(p.filter)
    const qDb = MAX_Q_DB * p.resonance
    // GLASS in or out: the WHOOSH, the low-pass swept down to 600 Hz and back over 0.45 s, ringing
    if (p.glass >= 0.5 !== this.glassOn) {
      this.glassOn = p.glass >= 0.5
      this.glassAt = t
    }
    const since = t - this.glassAt
    const whoosh = since < 0.45 ? Math.sin((Math.PI * since) / 0.45) : 0
    ramp(this.lp.frequency, f.lp * Math.pow(600 / 20000, whoosh))
    ramp(this.hp.frequency, f.hp)
    ramp(this.lp.Q, p.filter < 0 ? qDb : 6 * whoosh)
    ramp(this.hp.Q, p.filter > 0 ? qDb : 0)
    // the CRACK: a crush hit and a 1/16 stutter on the grid, once per rise
    if (p.crack >= 0.5 && !this.cracked) {
      this.crackUntil = t + 0.25
      const at = nextStep(this.clock(), 16, t)
      this.pre.port.postMessage({ kind: 'stutter', at, slice: (4 / 16) * (60 / Math.max(40, this.clock()?.bpm ?? 120)) })
      this.pre.port.postMessage({ kind: 'stutter-off', at: at + 0.25 })
    }
    this.cracked = p.crack >= 0.5
    ramp(this.trim.gain, Math.pow(10, -(p.filter !== 0 ? qDb : 0) / 40)) // half the resonant peak back off
    ramp(this.pan.pan, p.pan)
    ramp(this.echoSend.gain, p.echo, 0.01)
    const bpm = this.clock()?.bpm ?? 120
    ramp(this.delay.delayTime, Math.min(4, (p.echoBeats * 60) / Math.max(40, bpm)), 0.05)
    ramp(this.washSend.gain, 0.8 * p.wash, 0.05)
    ramp(this.dry.gain, 1 - 0.3 * p.wash, 0.05) // the wash takes over a little
    ramp(this.param('tape'), p.tape, 0.005)
    ramp(this.param('crush'), t < this.crackUntil ? Math.max(p.crush, 0.85) : p.crush, 0.005)
    const want = p.stutter >= 0.5
    if (want !== this.stutterOn) {
      const at = nextStep(this.clock(), p.stutterDiv, t)
      const slice = (4 / p.stutterDiv) * (60 / Math.max(40, this.clock()?.bpm ?? 120))
      this.pre.port.postMessage(want ? { kind: 'stutter', at, slice } : { kind: 'stutter-off', at })
      this.stutterOn = want
    }
    this.p = p
    for (const name of STEM_FX) ramp(this.stemFx.parameters.get(name)!, this.enabled ? p[name] : NEUTRAL[name], 0.005) // the worklet snaps them in
    for (const name of MOVES) ramp(this.moves.parameters.get(name)!, this.enabled ? p[name] : 0, 0.005)
    for (const name of ['iso', ...CUTS] as const) ramp(this.iso.parameters.get(name)!, this.enabled ? p[name] : 0, 0.005)
    const clock = this.clock()
    if (clock && clock.playing && clock.bpm > 0) {
      const anchor = t - (clock.beat * 60) / clock.bpm // the context time of beat 0: the worklet's grid
      if (clock.bpm !== this.beatAt.bpm || Math.abs(anchor - this.beatAt.anchor) > 0.003) {
        this.beatAt = { bpm: clock.bpm, anchor }
        this.stemFx.port.postMessage(this.beatAt)
        this.moves.port.postMessage(this.beatAt)
        this.iso.port.postMessage(this.beatAt)
      }
    }
    const active = activeFx(p)
    // through the chain (its limiter, its soft ceiling) whenever an FX is engaged, the bass's included; and all the time
    // while STRINGS shows (its FINGER FILTERS on): the song already limited, so engaging never drops a hot master's level
    if (active.length || stemFxOn(p) || p.iso >= 0.5 || since < 0.5 || t < this.crackUntil) this.lastActive = t
    this.route()
    if (active.join() !== useSongFx.getState().active.join()) useSongFx.setState({ active })
  }

  /** The stems take over from the mix at context time `t`: at 1 there (their sum is the mix: no step), then to their
   *  levels. */
  stemsFrom(t: number): void {
    for (const name of STEMS) {
      const level = this.enabled ? this.p[name] : 1
      for (const [a, from, to] of [[this.stemInputs[name].gain, 1, level], [this.stemLp[name].frequency, stemLowpassHz(1), stemLowpassHz(level)]] as const) {
        a.cancelScheduledValues(t)
        a.setValueAtTime(from, t)
        a.setTargetAtTime(to, t, TAU_S)
      }
    }
  }

  /** A frame with nothing to set: the chain lets go once the tails have rung out. */
  tick(): void {
    this.route()
  }

  /** A new preset or base: everything neutral (ramped), the repeat off and the echo and reverb tails cut. */
  reset(): void {
    const t = this.ctx.currentTime
    this.pre.port.postMessage({ kind: 'reset' })
    this.stutterOn = false
    for (const g of [this.echoReturn.gain, this.washReturn.gain, this.feedback.gain]) {
      g.setTargetAtTime(0, t, 0.015)
    }
    this.set(NEUTRAL)
    this.echoReturn.gain.setTargetAtTime(0.7, t + 0.25, 0.015) // back once the loop has emptied
    this.washReturn.gain.setTargetAtTime(0.6, t + 0.25, 0.015)
    this.feedback.gain.setTargetAtTime(FEEDBACK, t + 0.25, 0.015)
  }

  dispose(): void {
    if (current === this) current = null
    this.offStore()
    this.input.disconnect()
    this.output.disconnect()
    for (const name of STEMS) this.stemInputs[name].disconnect()
    this.stemFx.disconnect()
    this.stemOutput.disconnect()
  }

  /** Through the chain while it's on and something is (or was, within TAIL_S) engaged; else the bypass. */
  private route(): void {
    const t = this.ctx.currentTime
    const wet = this.enabled && t - this.lastActive < TAIL_S
    if (wet === this.wetOn) return
    this.wetOn = wet
    this.wet.gain.setTargetAtTime(wet ? 1 : 0, t, 0.005) // in before the FX's 16th: no fade on it
    this.bypass.gain.setTargetAtTime(wet ? 0 : 1, t, 0.005)
  }

  private param(name: string): AudioParam {
    return this.pre.parameters.get(name)!
  }
}
