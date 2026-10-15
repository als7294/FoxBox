/**
 * The GUIDE's demo sounds (2.0): each step plays its move's real sound quietly (DEMO_DB), looping while the step shows,
 * and ducks (DUCK) while you play (a pluck, any hand shape, a frame), back DUCK_HOLD_MS after. SAUCE's steps play an
 * instrument of their own (createInstrument: your sounds and FX, none of your settings touched); REMIX's play the TEST
 * BEAT through a SongFx of their own (the same chain, never the app's current one). S4's GuideStep calls
 * guideDemo.play(step) and guideDemo.stop(); renderGuideDemo renders one offline (the proofs).
 */
import { cameraSignals, onPluck } from '@/components/camera/smartCamera'
import { audioContext } from './context'
import { impulse } from './live/engine'
import { SongFx, STEMS, type SongFxParams } from './live/songFx'
import type { BeatClock } from './live/songDeck'
import { renderTestBeat } from './live/testBeat'
import processorsUrl from './live/worklets/live-processors.js?url'
import { attachOutput } from './output'
import { createInstrument, type Instrument, type SoundId } from './play/instrument'

export type GuideDemoId = 'pluck' | 'height' | 'twist' | 'shake' | 'octave' | 'preset' | 'frame' | 'record' | 'tearout' | 'bands' | 'drop' | 'glass'
export const DEMO_DB = -12
const DUCK = 0.1 // a further -20 dB while you play
const DUCK_HOLD_MS = 1200

/** REMIX's demo stage: the TEST BEAT's stems from `offset` (looping `loop`, s), into its own SongFx. */
interface Beat {
  fx: SongFx
  play(offset: number, loop?: [number, number]): void
}
type Step<T> = [t: number, act: (x: T) => void]
type Phrase =
  | { mode: 'sauce'; sound: SoundId; period: number; setup?: (i: Instrument) => void; steps: Step<Instrument>[] }
  | { mode: 'remix'; period: number; steps: Step<Beat>[] }

const pluck = (hand: 'left' | 'right', height: number, held = false) => (i: Instrument) =>
  i.pluck({ hand, finger: 1, velocity: 0.8, height, held })
const lift = (hand: 'left' | 'right') => (i: Instrument) => i.release({ hand, finger: 1 })
const plucks = (from: number, gap: number, heights: number[]): Step<Instrument>[] =>
  heights.map((h, k) => [from + k * gap, pluck(k % 2 ? 'left' : 'right', h)])
const fx = (p: Partial<SongFxParams>) => (b: Beat) => b.fx.set({ iso: 1, ...p })
const DROP: [number, number] = [8, 12] // the TEST BEAT's drop, bars 5-6 (120 BPM)

/** Each step's phrase: a few seconds of the move, then it starts again. */
export const PHRASES: Record<GuideDemoId, Phrase> = {
  pluck: { mode: 'sauce', sound: 'pluck', period: 2.4, steps: plucks(0, 0.5, [0.5, 0.5, 0.7, 0.3]) },
  height: { mode: 'sauce', sound: 'keys', period: 2.8, steps: plucks(0, 0.3, [0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 0.7, 0.4]) },
  twist: {
    mode: 'sauce', sound: 'lead', period: 2.6,
    steps: [[0, pluck('right', 0.5, true)], ...Array.from({ length: 30 }, (_, k): Step<Instrument> => [0.2 + k * 0.05, (i) => i.twist({ left: 0, right: 0.8 * Math.sin((2 * Math.PI * k) / 30) })]), [1.8, (i) => i.twist({ left: 0, right: 0 })], [2.0, lift('right')]],
  },
  shake: { mode: 'sauce', sound: 'lead', period: 2.4, steps: [[0, pluck('right', 0.5, true)], [0.4, (i) => i.holdAction('vibrato', 0.8)], [1.6, (i) => i.releaseAction('vibrato')], [1.8, lift('right')]] },
  octave: { mode: 'sauce', sound: 'pluck', period: 2.6, steps: [...plucks(0, 0.3, [0.5, 0.6, 0.5, 0.4]), [1.1, (i) => i.holdAction('octave')], ...plucks(1.2, 0.3, [0.5, 0.6, 0.5, 0.4]), [2.3, (i) => i.releaseAction('octave')]] },
  preset: {
    mode: 'sauce', sound: 'keys', period: 3.2, setup: (i) => { i.setMelodyMode('follow'); i.setPreset('night-hook') },
    steps: [[0, (i) => i.reset()], ...plucks(0.01, 0.35, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5])],
  },
  frame: {
    mode: 'sauce', sound: 'pluck', period: 11,
    steps: [
      ...plucks(0, 0.5, [0.2, 0.5, 0.8, 0.5, 0.3, 0.6, 0.9, 0.6]),
      [4.1, (i) => { i.setFrameStyle('echo'); i.frame(true); i.frame(false) }], // made: the last 4 beats loop
      [6, (i) => i.setFrameStyle('prism')], // a pinch restyles
      [8, (i) => i.setFrameStyle('xray', true)], // turned over: the flip side, backwards
      [10, (i) => { i.frame(true); i.frame(false); i.setFrameStyle('echo') }], // made again: it breaks
    ],
  },
  record: { mode: 'sauce', sound: 'keys', period: 3, setup: (i) => { i.setMelodyMode('follow'); i.setPreset('kitsune') }, steps: [[0, (i) => i.reset()], ...plucks(0.01, 0.3, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5])] },
  tearout: { mode: 'remix', period: 4, steps: [[0, (b) => b.play(DROP[0], DROP)], [1, fx({ tear: 0.9 })], [3, fx({ tear: 0 })]] },
  bands: { mode: 'remix', period: 4, steps: [[0, (b) => b.play(DROP[0], DROP)], [1, fx({ cutLow: 1 })], [2, fx({ cutLow: 0, cutHigh: 1 })], [3, fx({ cutHigh: 0 })]] },
  drop: { mode: 'remix', period: 6, steps: [[0, (b) => b.play(4)], [2, (b) => b.play(DROP[0], DROP)]] }, // the build, then on the bar the drop
  glass: { mode: 'remix', period: 4, steps: [[0, (b) => b.play(DROP[0], DROP)], [0.5, fx({ frame: 1, frameStyle: 6 })], [2.6, fx({ frame: 0 })]] }, // THERMAL, then it breaks
}

/** The TEST BEAT through a SongFx of its own on `ctx`, into `out`. */
async function beatStage(ctx: BaseAudioContext, out: AudioNode): Promise<Beat & { dispose(): void }> {
  await ctx.audioWorklet.addModule(processorsUrl)
  const stems = renderTestBeat(ctx.sampleRate)
  const buffers = STEMS.map((n) => {
    const b = new AudioBuffer({ length: stems[n][0]!.length, numberOfChannels: 2, sampleRate: ctx.sampleRate })
    stems[n].forEach((c, ch) => b.copyToChannel(c as Float32Array<ArrayBuffer>, ch))
    return b
  })
  let at = { t: ctx.currentTime, offset: 0 }
  const clock = (): BeatClock => {
    const beat = (at.offset + ctx.currentTime - at.t) * 2 // 120 BPM; a loop's length is whole bars: the grid holds
    return { bpm: 120, beatsPerBar: 4, downbeatS: 0, positionS: beat / 2, beat, beatPhase: beat % 1, bar: Math.floor(beat / 4) + 1, barPhase: (beat / 4) % 1, playing: true }
  }
  const fxs = new SongFx(ctx, clock, impulse(ctx, 3.5, 0.4), { current: false })
  fxs.stemOutput.connect(fxs.input)
  fxs.output.connect(out)
  fxs.set({ iso: 1 })
  let srcs: { src: AudioBufferSourceNode; fade: GainNode }[] = []
  const play = (offset: number, loop?: [number, number]) => {
    const t = ctx.currentTime
    for (const s of srcs) { s.fade.gain.setTargetAtTime(0, t, 0.002); s.src.stop(t + 0.02) }
    at = { t, offset }
    srcs = buffers.map((buffer, i) => {
      const src = new AudioBufferSourceNode(ctx, { buffer, loop: Boolean(loop), loopStart: loop?.[0] ?? 0, loopEnd: loop?.[1] ?? 0 })
      const fade = new GainNode(ctx, { gain: 0 })
      fade.gain.setTargetAtTime(1, t, 0.002)
      src.connect(fade).connect(fxs.stemInputs[STEMS[i]!])
      src.start(t, offset)
      return { src, fade }
    })
    fxs.set({ iso: 1 })
  }
  return { fx: fxs, play, dispose: () => { for (const s of srcs) s.src.stop(); fxs.dispose() } }
}

/** One demo on `ctx` into `out`: its stage, and `at(t, fn)` running a step `t` s in (live: timers; offline: suspends). */
async function stage(id: GuideDemoId, ctx: BaseAudioContext, out: AudioNode) {
  const p = PHRASES[id]
  if (p.mode === 'sauce') {
    const inst = await createInstrument(ctx)
    inst.setSound(p.sound)
    p.setup?.(inst)
    inst.output.connect(out)
    return { target: inst as Instrument | Beat, steps: p.steps as Step<Instrument | Beat>[], period: p.period, dispose: () => inst.dispose() }
  }
  const b = await beatStage(ctx, out)
  return { target: b as Instrument | Beat, steps: p.steps as Step<Instrument | Beat>[], period: p.period, dispose: b.dispose }
}

/** A demo rendered offline, `loops` times round (the proofs: the same instrument and chain the live one plays). */
export async function renderGuideDemo(id: GuideDemoId, loops = 1, sampleRate = 48000): Promise<AudioBuffer> {
  const period = PHRASES[id].period
  const octx = new OfflineAudioContext(2, Math.round((period * loops + 0.5) * sampleRate), sampleRate)
  const s = await stage(id, octx, octx.destination)
  for (let k = 0; k < loops; k++)
    for (const [t, act] of s.steps) void octx.suspend(Math.max(1 / sampleRate * 128, k * period + t)).then(() => { act(s.target); void octx.resume() })
  const buf = await octx.startRendering()
  s.dispose()
  return buf
}

/** The ducking: while you play (a pluck, any shape, a frame) and DUCK_HOLD_MS after. */
export function duckTarget(nowMs: number, lastPlayedMs: number): number {
  return nowMs - lastPlayedMs < DUCK_HOLD_MS ? DUCK : 1
}

const playing = (): boolean => {
  const s = cameraSignals() as unknown as { play?: { shapes?: { left?: unknown; right?: unknown } }; fxShapes?: { left?: { shape?: unknown } | null; right?: { shape?: unknown } | null } | null; frame?: { formed?: boolean } }
  return Boolean(s.play?.shapes?.left || s.play?.shapes?.right || s.fxShapes?.left?.shape || s.fxShapes?.right?.shape || s.frame?.formed)
}

let run: { stop(): void } | null = null
let token = 0

export const guideDemo = {
  /** The step's demo, quiet and looping, until stop() (or another play). */
  async play(id: GuideDemoId): Promise<void> {
    guideDemo.stop()
    const mine = ++token
    const ctx = audioContext()
    void ctx.resume()
    const level = new GainNode(ctx, { gain: Math.pow(10, DEMO_DB / 20) })
    const duck = new GainNode(ctx, { gain: 1 })
    level.connect(duck).connect(ctx.destination)
    const detach = attachOutput(ctx)
    const s = await stage(id, ctx, level)
    const timers: ReturnType<typeof setTimeout>[] = []
    let last = -Infinity
    let raf = 0
    const offPluck = onPluck(() => (last = performance.now()))
    const watch = () => {
      raf = requestAnimationFrame(watch)
      const now = performance.now()
      if (playing()) last = now
      duck.gain.setTargetAtTime(duckTarget(now, last), ctx.currentTime, 0.06)
    }
    const round = () => {
      for (const [t, act] of s.steps) timers.push(setTimeout(() => act(s.target), t * 1000))
      timers.push(setTimeout(round, s.period * 1000))
    }
    const stop = () => {
      for (const t of timers) clearTimeout(t)
      cancelAnimationFrame(raf)
      offPluck()
      level.gain.setTargetAtTime(0, ctx.currentTime, 0.03) // out quietly, then gone
      setTimeout(() => { s.dispose(); level.disconnect(); duck.disconnect(); detach() }, 300)
    }
    if (mine !== token) return stop() // stopped (or replaced) while it was starting
    raf = requestAnimationFrame(watch)
    round()
    run = { stop }
  },
  stop(): void {
    token++
    run?.stop()
    run = null
  },
}
