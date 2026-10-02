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
}

export const NEUTRAL: SongFxParams = Object.freeze({
  filter: 0, resonance: 0, echo: 0, echoBeats: 0.75, stutter: 0, stutterDiv: 8, tape: 0, crush: 0, wash: 0, pan: 0,
})

export type FxName = 'filter' | 'echo' | 'stutter' | 'tape' | 'crush' | 'wash' | 'pan'

/** The FX a set of parameters engages (the UI's indicator). */
export function activeFx(p: SongFxParams): FxName[] {
  const on: [FxName, boolean][] = [['filter', Math.abs(p.filter) > 0.02], ['echo', p.echo > 0.02], ['stutter', p.stutter >= 0.5],
    ['tape', p.tape > 0.02], ['crush', p.crush > 0.02], ['wash', p.wash > 0.02], ['pan', Math.abs(p.pan) > 0.05]]
  return on.filter(([, v]) => v).map(([k]) => k)
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : 0))

/** The two filters' cutoffs for `filter` (exponential sweeps: equal moves sound equal). */
export function filterHz(filter: number): { lp: number; hp: number } {
  const f = clamp(filter, -1, 1)
  return { lp: f < 0 ? 20000 * Math.pow(120 / 20000, -f) : 20000, hp: f > 0 ? 20 * Math.pow(5000 / 20, f) : 20 }
}

/** The context time of the next 1/`div` grid step after `now` (a step's length in beats is 4 / div); `now` itself
 * without a running clock. */
export function nextStep(clock: BeatClock | null, div: number, now: number): number {
  if (!clock || !clock.playing || !(clock.bpm > 0)) return now
  const step = 4 / div
  const next = Math.ceil(clock.beat / step - 1e-6) * step
  return now + ((next - clock.beat) * 60) / clock.bpm
}

export const useSongFx = create<{ enabled: boolean; active: FxName[]; grDb: number; setEnabled(on: boolean): void }>((set) => ({
  enabled: true,
  active: [],
  grDb: 0,
  setEnabled: (enabled) => set({ enabled }),
}))

let current: SongFx | null = null
/** The playing SongDeck's FX (one deck at a time), for the preset driver (soundMap.ts). */
export const currentSongFx = (): SongFx | null => current

const TAU_S = 0.03 // the ramps' time constant: ~100 ms to settle, never a step
const TAIL_S = 4 // the chain stays in this long after the last FX lets go: the echo and the wash ring out
const MAX_Q_DB = 12
const FEEDBACK = 0.55

export class SongFx {
  readonly input: GainNode
  readonly output: GainNode
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
    this.hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 20, Q: 0 })
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

    this.input.connect(this.pre).connect(this.lp).connect(this.hp).connect(this.trim).connect(this.pan)
    this.pan.connect(this.dry).connect(this.limit)
    this.pan.connect(this.echoSend).connect(this.delay)
    this.delay.connect(fbHp).connect(fbLp).connect(this.feedback).connect(this.delay) // the loop, filtered and capped
    this.delay.connect(this.echoReturn).connect(this.limit)
    this.pan.connect(this.washSend).connect(reverb).connect(this.washReturn).connect(this.limit)
    this.limit.connect(this.wet).connect(this.output)
    this.input.connect(align).connect(this.bypass).connect(this.output)
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
    const t = this.ctx.currentTime
    const ramp = (a: AudioParam, v: number, tau = TAU_S) => a.setTargetAtTime(v, t, tau)
    const { lp, hp } = filterHz(p.filter)
    const qDb = MAX_Q_DB * p.resonance
    ramp(this.lp.frequency, lp)
    ramp(this.hp.frequency, hp)
    ramp(this.lp.Q, p.filter < 0 ? qDb : 0)
    ramp(this.hp.Q, p.filter > 0 ? qDb : 0)
    ramp(this.trim.gain, Math.pow(10, -(p.filter !== 0 ? qDb : 0) / 40)) // half the resonant peak back off
    ramp(this.pan.pan, p.pan)
    ramp(this.echoSend.gain, p.echo, 0.01)
    const bpm = this.clock()?.bpm ?? 120
    ramp(this.delay.delayTime, Math.min(4, (p.echoBeats * 60) / Math.max(40, bpm)), 0.05)
    ramp(this.washSend.gain, 0.8 * p.wash, 0.05)
    ramp(this.dry.gain, 1 - 0.3 * p.wash, 0.05) // the wash takes over a little
    ramp(this.param('tape'), p.tape, 0.005)
    ramp(this.param('tapeS'), 0.25, 0.005)
    ramp(this.param('crush'), p.crush, 0.005)
    const want = p.stutter >= 0.5
    if (want !== this.stutterOn) {
      const at = nextStep(this.clock(), p.stutterDiv, t)
      const slice = (4 / p.stutterDiv) * (60 / Math.max(40, this.clock()?.bpm ?? 120))
      this.pre.port.postMessage(want ? { kind: 'stutter', at, slice } : { kind: 'stutter-off', at })
      this.stutterOn = want
    }
    this.p = p
    const active = activeFx(p)
    if (active.length) this.lastActive = t
    this.route()
    if (active.join() !== useSongFx.getState().active.join()) useSongFx.setState({ active })
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
  }

  /** Through the chain while it's on and something is (or was, within TAIL_S) engaged; else the bypass. */
  private route(): void {
    const t = this.ctx.currentTime
    const wet = this.enabled && t - this.lastActive < TAIL_S
    if (wet === this.wetOn) return
    this.wetOn = wet
    this.wet.gain.setTargetAtTime(wet ? 1 : 0, t, 0.01)
    this.bypass.gain.setTargetAtTime(wet ? 0 : 1, t, 0.01)
  }

  private param(name: string): AudioParam {
    return this.pre.parameters.get(name)!
  }
}
