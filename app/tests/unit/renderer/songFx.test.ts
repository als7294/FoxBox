// The TRACK song's live FX (1.5.2): the limiter holds its true-peak ceiling, nothing clicks (the worklets run here on
// their real code in a small sandbox; the native nodes only ever move by setTargetAtTime), and the preset map's math.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DRAWN_MS, GESTURES_NEUTRAL, GestureTracker, SIGN_HOLD_MS, SOUND_TARGETS, STRINGS_SOUND, evaluate, glassInput, startSoundMap, stemLevels, usesStems, type SoundEntry } from '@/audio/live/soundMap'
import { KNOBS } from '@/touchdesigner/knobs'
import { TE_CHANNELS } from '@shared/touchengine'
import { stageFrames } from '@/visuals/live/stage'
import { NEUTRAL, STEMS, SongFx, activeFx, filterHz, nextStep, stemLowpassHz, useSongFx } from '@/audio/live/songFx'
import { songStems } from '@/audio/live/songDeck'

const SR = 48000
const SRC = readFileSync(resolve(__dirname, '../../../src/renderer/src/audio/live/worklets/live-processors.js'), 'utf8')

/** The worklet file's processors, with a clock the test moves. */
function worklets() {
  const procs: Record<string, new () => any> = {}
  const posted: unknown[] = []
  const scope = {
    sampleRate: SR,
    currentTime: 0,
    AudioWorkletProcessor: class { port = { postMessage: (m: unknown) => posted.push(m), onmessage: null as null | ((e: { data: unknown }) => void) } },
    registerProcessor: (name: string, cls: new () => any) => { procs[name] = cls },
  }
  // eslint-disable-next-line no-new-func
  new Function('scope', `with (scope) { ${SRC} }`)(scope)
  /** Runs `proc` over stereo `x` in 128-sample blocks; `params(i)` gives the block's k-rate values. */
  const run = (proc: any, L: Float32Array, R: Float32Array, params: (i: number) => Record<string, number>) => {
    const oL = new Float32Array(L.length), oR = new Float32Array(R.length)
    for (let i = 0; i < L.length; i += 128) {
      scope.currentTime = i / SR
      const p = Object.fromEntries(Object.entries(params(i)).map(([k, v]) => [k, new Float32Array([v])]))
      const a = oL.subarray(i, i + 128), b = oR.subarray(i, i + 128)
      proc.process([[L.subarray(i, i + 128), R.subarray(i, i + 128)]], [[a, b]], p)
    }
    return [oL, oR] as const
  }
  return { procs, posted, run, scope }
}

/** `hz`'s amplitude in `x` from sample `from` to `to` (one DFT bin). */
const tone = (x: Float32Array, hz: number, from = SR, to = x.length) => {
  let re = 0
  let im = 0
  for (let i = from; i < to; i++) {
    re += x[i]! * Math.cos((2 * Math.PI * hz * i) / SR)
    im += x[i]! * Math.sin((2 * Math.PI * hz * i) / SR)
  }
  return (2 * Math.hypot(re, im)) / (to - from)
}

/** The peak of `x` upsampled 8x (windowed sinc): what a true-peak meter reads. */
function truePeak(x: Float32Array): number {
  let m = 0
  for (let i = 8; i < x.length - 8; i++) {
    for (let k = 0; k < 8; k++) {
      const t = i + k / 8
      let v = 0
      for (let j = i - 7; j <= i + 8; j++) {
        const d = t - j
        const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d)
        v += x[j]! * sinc * (0.5 + 0.5 * Math.cos((Math.PI * d) / 8))
      }
      m = Math.max(m, Math.abs(v))
    }
  }
  return m
}

const maxStep = (x: Float32Array) => x.reduce((m, v, i) => (i ? Math.max(m, Math.abs(v - x[i - 1]!)) : 0), 0)

describe('song FX limiter', () => {
  const { procs, run } = worklets()
  const sine = (f: number, a: number, n: number, ph = 0) => Float32Array.from({ length: n }, (_, i) => a * Math.sin(2 * Math.PI * f * (i / SR) + ph))

  it('holds -1 dBTP on a loud song, inter-sample peaks included', () => {
    const lim = new procs['fvwks-limit']!()
    const x = sine(SR / 4, 1.8, SR / 2, Math.PI / 4) // samples at ±1.27, the waveform between them at 1.8
    const [L, R] = run(lim, x, sine(997, 1.5, SR / 2), () => ({ ceilingDb: -1, releaseMs: 80 }))
    const ceil = Math.pow(10, -1 / 20)
    expect(Math.max(...L.map(Math.abs), ...R.map(Math.abs))).toBeLessThanOrEqual(ceil + 1e-6)
    expect(20 * Math.log10(truePeak(L.subarray(SR / 10)))).toBeLessThan(-0.7) // the 0.3 dB over is the meter's own ripple
    expect(20 * Math.log10(truePeak(R.subarray(SR / 10)))).toBeLessThan(-0.7)
  })

  it('leaves a quiet song untouched (only delayed)', () => {
    const lim = new procs['fvwks-limit']!()
    const x = sine(440, 0.3, 4096)
    const [L] = run(lim, x, x, () => ({ ceilingDb: -1, releaseMs: 80 }))
    const lag = Math.max(4, Math.round(0.0015 * SR)) + 5 // the look-ahead, and the true-peak filter's centre
    for (let i = lag + 10; i < 4000; i += 97) expect(L[i]).toBeCloseTo(x[i - lag]!, 5)
  })
})

describe('song FX without clicks', () => {
  const tone = Float32Array.from({ length: SR * 3 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 110 * i) / SR))
  const slope = 0.5 * 2 * Math.PI * 110 / SR // the tone's own largest step

  it('tape stop and spin-up ramp the rate and come back to live', () => {
    const { procs, run } = worklets()
    const fx = new procs['fvwks-songfx']!()
    const [L] = run(fx, tone, tone, (i) => ({ tape: i >= SR * 0.5 && i < SR * 1.5 ? 1 : 0, tapeS: 0.25, crush: 0 }))
    expect(maxStep(L)).toBeLessThan(slope * 2)
    expect(Math.max(...L.subarray(SR * 1.2, SR * 1.4).map(Math.abs))).toBeLessThan(0.02) // stopped: silence
    expect(L[SR * 2.8]).toBeCloseTo(tone[SR * 2.8]!, 5) // live again
  })

  it('a beat repeat engages and lets go on its times, smoothly', () => {
    const { procs, run } = worklets()
    const fx = new procs['fvwks-songfx']!()
    fx.port.onmessage({ data: { kind: 'stutter', at: 0.5, slice: 0.125 } })
    fx.port.onmessage({ data: { kind: 'stutter-off', at: 1.0 } })
    const [L] = run(fx, tone, tone, () => ({ tape: 0, tapeS: 0.25, crush: 0 }))
    expect(maxStep(L)).toBeLessThan(slope * 3)
    const at = (s: number) => Math.round(s * SR)
    expect(L[at(0.8)]).toBeCloseTo(L[at(0.8) - at(0.125)]!, 3) // repeating the eighth before 0.5 s
    expect(L[at(1.5)]).toBeCloseTo(tone[at(1.5)]!, 5) // released
  })

  it('every native parameter moves by a ramp, and a repeat waits for the grid', () => {
    const calls: { kind: string; tau?: number }[] = []
    class Param {
      value = 0
      setTargetAtTime(_v: number, _t: number, tau: number) { calls.push({ kind: 'target', tau }); return this }
      setValueAtTime() { calls.push({ kind: 'set' }); return this }
      linearRampToValueAtTime() { calls.push({ kind: 'linear' }); return this }
    }
    class Node { connect<T>(n: T) { return n } disconnect() {} }
    const messages: unknown[] = []
    const g = globalThis as Record<string, unknown>
    Object.assign(g, {
      GainNode: class extends Node { gain = new Param() },
      BiquadFilterNode: class extends Node { frequency = new Param(); Q = new Param() },
      StereoPannerNode: class extends Node { pan = new Param() },
      DelayNode: class extends Node { delayTime = new Param() },
      ConvolverNode: class extends Node {},
      AudioWorkletNode: class extends Node {
        private p: Record<string, Param> = {}
        parameters = { get: (k: string) => (this.p[k] ??= new Param()) }
        port = { postMessage: (m: unknown) => messages.push(m), onmessage: null }
      },
    })
    const ctx = { currentTime: 10, sampleRate: SR } as unknown as BaseAudioContext
    const clock = { bpm: 120, beatsPerBar: 4, downbeatS: 0, positionS: 0, beat: 10.1, beatPhase: 0.1, bar: 3, barPhase: 0.5, playing: true }
    const fx = new SongFx(ctx, () => clock, {} as AudioBuffer)
    calls.length = 0
    fx.set({ filter: -0.7, resonance: 1, echo: 1, crush: 0.5, wash: 0.6, pan: 0.4, tape: 0.3, stutter: 1, stutterDiv: 8 })
    fx.reset()
    expect(calls.length).toBeGreaterThan(20)
    expect(calls.every((c) => c.kind === 'target' && (c.tau ?? 0) >= 0.004)).toBe(true)
    const st = messages.find((m) => (m as { kind: string }).kind === 'stutter') as { at: number; slice: number }
    expect(st.at).toBeCloseTo(10 + (10.5 - 10.1) * 0.5, 6) // the next eighth: beat 10.5
    expect(st.slice).toBeCloseTo(0.25, 6)
    expect(messages.at(-1)).toEqual({ kind: 'reset' })
    expect(fx.params).toEqual(NEUTRAL)
  })
})

describe('song FX maps', () => {
  it('sweeps the filters exponentially and names what is on', () => {
    expect(filterHz(0)).toEqual({ lp: 20000, hp: 5 })
    expect(filterHz(-1).lp).toBeCloseTo(120)
    expect(filterHz(1).hp).toBeCloseTo(5000)
    expect(filterHz(-0.5).lp).toBeCloseTo(Math.sqrt(20000 * 120))
    expect(activeFx({ ...NEUTRAL, filter: 0.3, stutter: 0.6, wash: 0.01 })).toEqual(['filter', 'stutter'])
    expect(nextStep(null, 16, 5)).toBe(5)
  })

  it('evaluates a preset map: curves, dead zones, smoothing, the winner per target', () => {
    const map: SoundEntry[] = [
      { target: 'fx.filter', source: 'gesture.hand_height', min: 0, max: 0.8, curve: 'exp', dead: 0.25 },
      { target: 'fx.echo', source: 'gesture.motion', min: 0, max: 0.8, curve: 'gate', dead: 0.2 },
      { target: 'fx.echo', source: 'macro.throw', min: 0, max: 1, curve: 'lin' },
      { target: 'fx.pan', source: 'gesture.head_tilt', min: -0.6, max: 0.6, curve: 'lin', dead: 0.15 },
      { target: 'fx.wash', source: 'macro.depth', min: 0, max: 0.7, curve: 'lin', smooth_ms: 100 },
      { target: 'fx.nope', source: 'macro.depth', min: 0, max: 1, curve: 'lin' },
    ]
    const s = new Map<number, number>()
    const at = (src: Record<string, number>) => evaluate(map, src, s, 0.016)
    let p = at({ 'gesture.hand_height': 0.2, 'gesture.motion': 0.55, 'macro.throw': 0.3, 'gesture.head_tilt': 0.1, 'macro.depth': 0 })
    expect(p.filter).toBe(0) // in the dead zone
    expect(p.echo).toBeCloseTo(0.3) // the gate not yet (0.55 < 0.6): the macro wins
    expect(p.pan).toBe(0) // a small tilt: dead
    p = at({ 'gesture.hand_height': 1, 'gesture.motion': 0.7, 'macro.throw': 0.3, 'gesture.head_tilt': -1, 'macro.depth': 1 })
    expect(p.filter).toBeCloseTo(0.8)
    expect(p.echo).toBeCloseTo(0.8)
    expect(p.pan).toBeCloseTo(-0.6)
    expect(p.wash).toBeGreaterThan(0.05)
    expect(p.wash).toBeLessThan(0.7) // smoothed: on its way
    expect(p.crush).toBe(NEUTRAL.crush) // unmapped: neutral
  })

  it('reads gestures off the camera, relaxing when it stops', () => {
    const t = new GestureTracker()
    const sig = (at: number, x: number) => ({ at, calibrating: false, near: 0, twoFaces: false,
      head: { x, y: 0.4, yaw: 0, roll: 0.25, lean: 0, jaw: 0.8 }, hands: [{ x: 0.5, y: 0.2, pinch: 0, open: 1, near: 0, fingers: 5, gesture: null }] }) as unknown as Parameters<GestureTracker['update']>[0]
    let g = t.update(sig(0, 0.5), 0, 1)
    for (let i = 1; i <= 30; i++) g = t.update(sig(i * 16, 0.5), i * 16, 0.016)
    expect(g.hand_height).toBeCloseTo(0.8, 2)
    expect(g.head_tilt).toBeCloseTo(0.5, 2)
    expect(g.jaw_open).toBeCloseTo(0.8, 2)
    expect(g.motion).toBeLessThan(0.05) // still
    for (let i = 31; i <= 40; i++) g = t.update(sig(i * 16, 0.5 + (i - 30) * 0.05), i * 16, 0.016) // a quick sweep
    expect(g.motion).toBeGreaterThan(0.5)
    for (let i = 0; i < 60; i++) g = t.update(sig(640, 1), 2000 + i * 16, 0.016) // the camera stopped
    expect(g.hand_height).toBeLessThan(0.05)
    expect(g.motion).toBeLessThan(0.1)
  })

  it('reads hand shapes: a sign fires only once held, a squeeze needs both hands', () => {
    const t = new GestureTracker()
    const hand = (x: number, pinch: number, gesture: string | null) => ({ x, y: 0.5, pinch, open: 0, near: 0, gesture })
    const sig = (at: number, hands: ReturnType<typeof hand>[]) => ({ at, calibrating: false, near: 0, twoFaces: false, head: null,
      hands }) as unknown as Parameters<GestureTracker['update']>[0]
    let g = t.update(sig(0, [hand(0.3, 1, 'fist')]), 0, 0.016)
    for (let ms = 16; ms < 100; ms += 16) g = t.update(sig(ms, [hand(0.3, 1, 'fist')]), ms, 0.016)
    expect(g.fist).toBe(0) // a fist passing through (under SIGN_HOLD_MS)
    g = t.update(sig(112, []), 112, 0.016)
    for (let ms = 128; ms < 400; ms += 16) g = t.update(sig(ms, []), ms, 0.016)
    expect(g.fist).toBe(0)
    for (let ms = 400; ms <= 400 + SIGN_HOLD_MS + 32; ms += 16) g = t.update(sig(ms, [hand(0.3, 0, 'victory')]), ms, 0.016)
    expect(g.victory).toBe(1) // held: fires
    for (let ms = 600; ms < 900; ms += 16) g = t.update(sig(ms, [hand(0.2, 1, null), hand(0.8, 1, null)]), ms, 0.016)
    expect(g.victory).toBe(0) // let go
    expect(g.squeeze).toBeGreaterThan(0.9) // both hands pinched
    expect(g.hands_dist).toBeCloseTo(0.6, 1) // 0.6 of the frame apart
    for (let ms = 900; ms < 1200; ms += 16) g = t.update(sig(ms, [hand(0.2, 1, null)]), ms, 0.016)
    expect(g.squeeze).toBeLessThan(0.05) // one hand alone never squeezes
    expect(g.pinch).toBeGreaterThan(0.9)
  })

  it("reads S1's hand shapes: the sides, FRAME's size, a held TRIANGLE", () => {
    const t = new GestureTracker()
    const side = (pinch: number, fingers: number) => ({ pinch, open: 1 - pinch, fingers, gesture: null, points: [] })
    const frame = (held: boolean, size: number) => ({ held, size, x0: 0, y0: 0, x1: 0, y1: 0, corners: [], since: 0, seen: 0 })
    const sig = (at: number, shapes: Record<string, unknown>) => ({ at, calibrating: false, near: 0, twoFaces: false, head: null,
      hands: [{ x: 0.3, y: 0.5, pinch: 1, open: 0, near: 0, fingers: 2, gesture: null }], shapes }) as unknown as Parameters<GestureTracker['update']>[0]
    let g = t.update(sig(0, { left: side(1, 2), right: side(0.2, 4), apart: 0.5, frame: frame(true, 0.6), triangle: true }), 0, 0.016)
    for (let ms = 16; ms <= 300; ms += 16) g = t.update(sig(ms, { left: side(1, 2), right: side(0.2, 4), apart: 0.5, frame: frame(true, 0.6), triangle: true }), ms, 0.016)
    expect(g.pinch_l).toBeCloseTo(1, 2)
    expect(g.pinch_r).toBeCloseTo(0.2, 2)
    expect(g.squeeze).toBeCloseTo(0.2, 2) // both hands' lesser pinch
    expect(g.fingers_r).toBeCloseTo(0.8, 2)
    expect(g.fingers).toBeCloseTo(0.4, 2) // the nearest hand's 2 of 5
    expect(g.hands_dist).toBeCloseTo(0.5, 1) // S1's wrist to wrist (80 ms smoothing, nearly settled)
    expect(g.frame_held).toBe(1)
    expect(g.frame_size).toBeCloseTo(0.6, 1) // 80 ms smoothing, nearly settled
    expect(g.triangle).toBe(1) // held past SIGN_HOLD_MS
    for (let ms = 316; ms <= 700; ms += 16) g = t.update(sig(ms, { left: side(0, 0), right: null, apart: 0, frame: frame(false, 0.6), triangle: false }), ms, 0.016)
    expect(g.frame_size).toBeLessThan(0.02) // FRAME let go: no size
    expect(g.squeeze).toBeLessThan(0.02)
    expect(g.triangle).toBe(0)
  })

  it('lets the FX go when VISUALS stops drawing (no frozen tape stop on another page)', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
    const sets: Record<string, number>[] = []
    const fake = { set: (p: Record<string, number>) => sets.push(p), tick: () => {}, reset: () => {} }
    const preset = { id: 'p', macros: { smear: 1 }, sound: { changes_sound: true, map: [{ target: 'fx.tape', source: 'macro.smear', min: 0, max: 0.85, curve: 'lin' as const }] } }
    const stop = startSoundMap(() => preset, () => 'touchdesigner', () => fake as never)
    const frame = [...stageFrames].at(-1)!
    const a = { time: 0, rms: 0, bands: { low: 0, mid: 0, high: 0 }, onset: 0, fft: null, waveL: null, waveR: null, sampleRate: 48000, bpm: 120, beatPhase: 0, active: true }
    frame(a, 16)
    expect(sets.at(-1)?.tape).toBeCloseTo(0.85) // the macro drives it while frames come
    vi.advanceTimersByTime(700) // VISUALS stopped drawing
    expect(sets.at(-1)?.tape).toBe(0) // back to neutral
    stop()
    expect(stageFrames.has(frame)).toBe(false)
    vi.useRealTimers()
  })

  it('reads the TD panel knobs as knob.* sources', () => {
    const sets: Record<string, number>[] = []
    const fake = { set: (p: Record<string, number>) => sets.push(p), tick: () => {}, reset: () => {} }
    const preset = { id: 'k', macros: {}, sound: { changes_sound: true, map: [{ target: 'fx.wash', source: 'knob.trails', min: 0, max: 1, curve: 'lin' as const }] } }
    const stop = startSoundMap(() => preset, () => 'touchdesigner', () => fake as never)
    const a = { time: 0, rms: 0, bands: { low: 0, mid: 0, high: 0 }, onset: 0, fft: null, waveL: null, waveR: null, sampleRate: 48000, bpm: 120, beatPhase: 0, active: true }
    ;[...stageFrames].at(-1)!(a, 16)
    expect(sets.at(-1)?.wash).toBeCloseTo(0.15) // TRAILS' default until PROD's feed lands
    stop()
  })

  it('turns a pinched hand into a knob (twist), and a bipolar map spans it', () => {
    const t = new GestureTracker()
    const sig = (at: number, twist: number, pinched: boolean) => ({ at, calibrating: false, near: 0, twoFaces: false, head: null, hands: [],
      shapes: { left: { pinch: 1, open: 0, fingers: 1, gesture: null, points: [], pinched, twist, angle: 0, turn: 0 }, right: null, apart: 0,
        frame: { held: false, size: 0, x0: 0, y0: 0, x1: 0, y1: 0, corners: [], since: 0, seen: 0 }, triangle: false } }) as unknown as Parameters<GestureTracker['update']>[0]
    let g = t.update(sig(0, -0.5, true), 0, 0.016)
    for (let ms = 16; ms < 400; ms += 16) g = t.update(sig(ms, -0.5, true), ms, 0.016)
    expect(g.twist_l).toBeCloseTo(-0.5, 2)
    const p = evaluate([{ target: 'fx.filter', source: 'gesture.twist_l', min: -1, max: 1, curve: 'lin', dead: 0.05 }], { 'gesture.twist_l': g.twist_l }, new Map(), 0.016)
    expect(p.filter).toBeLessThan(-0.4) // turned left: the low-pass sweeps down
    for (let ms = 400; ms < 800; ms += 16) g = t.update(sig(ms, -0.5, false), ms, 0.016)
    expect(Math.abs(g.twist_l)).toBeLessThan(0.01) // let go of the pinch: the knob rests at the middle
  })

  it('fires a drawn shape once, as a one-shot that falls away (a burst through a gate, a swell through lin)', () => {
    const t = new GestureTracker()
    const sig = (drawn: unknown) => ({ at: 0, calibrating: false, near: 0, twoFaces: false, head: null, hands: [], drawn,
      shapes: { left: null, right: null, apart: 0, frame: { held: false, size: 0, x0: 0, y0: 0, x1: 0, y1: 0, corners: [], since: 0, seen: 0 },
        triangle: false } }) as unknown as Parameters<GestureTracker['update']>[0]
    const at = (ms: number, drawn: unknown) => t.update({ ...sig(drawn), at: ms } as never, ms, 0.016)
    let g = at(1000, { shape: 'star', at: 100, score: 0.9 }) // recognised before we looked: never fires
    expect(g.drawn_star).toBe(0)
    g = at(2000, { shape: 'zigzag', at: 1990, score: 0.8 })
    expect(g.drawn_zigzag).toBe(1)
    const map: SoundEntry[] = [{ target: 'fx.stutter', source: 'gesture.drawn_zigzag', min: 0, max: 1, curve: 'gate' },
      { target: 'fx.wash', source: 'gesture.drawn_zigzag', min: 0, max: 0.7, curve: 'lin' }]
    expect(evaluate(map, { 'gesture.drawn_zigzag': g.drawn_zigzag }, new Map(), 0.016).stutter).toBe(1)
    g = at(2000 + DRAWN_MS * 0.7, { shape: 'zigzag', at: 1990, score: 0.8 }) // the same event: no retrigger
    const p = evaluate(map, { 'gesture.drawn_zigzag': g.drawn_zigzag }, new Map(), 0.016)
    expect(p.stutter).toBe(0) // the burst is over (past half)
    expect(p.wash).toBeCloseTo(0.7 * 0.3, 2) // the swell still dying away
    g = at(2000 + DRAWN_MS + 50, { shape: 'zigzag', at: 1990, score: 0.8 })
    expect(g.drawn_zigzag).toBe(0)
  })

  it("every preset's sound map reads sources that exist (no dead macro.* on a v3 preset) and names real targets", () => {
    const dir = resolve(__dirname, '../../../../touchdesigner/presets')
    const ids = readdirSync(dir).filter((d) => existsSync(resolve(dir, d, 'preset.json')))
    expect(ids.length).toBeGreaterThan(8)
    const channels = new Set(TE_CHANNELS.map((c) => (typeof c === 'string' ? c : (c as { name: string }).name)))
    const bad: string[] = []
    for (const id of ids) {
      const p = JSON.parse(readFileSync(resolve(dir, id, 'preset.json'), 'utf8')) as { macros?: { id: string }[]; sound?: { map: SoundEntry[] } | null }
      for (const e of p.sound?.map ?? []) {
        const [kind, name] = [e.source.slice(0, e.source.indexOf('.')), e.source.slice(e.source.indexOf('.') + 1)]
        const ok = kind === 'gesture' ? name in GESTURES_NEUTRAL : kind === 'knob' ? KNOBS.some((k) => k.id === name)
          : kind === 'macro' ? (p.macros ?? []).some((m) => m.id === name) : kind === 'ch' ? channels.has(name) : false
        if (!ok) bad.push(`${id}: ${e.source}`)
        if (!SOUND_TARGETS.includes(e.target)) bad.push(`${id}: target ${e.target}`)
      }
    }
    expect(bad).toEqual([])
  })
})

describe('song stems (STRING HANDS)', () => {
  it('a stem\'s lowpass is open at full level and closes with it', () => {
    expect(stemLowpassHz(1)).toBeCloseTo(20000, 0)
    expect(stemLowpassHz(0)).toBeCloseTo(250, 0)
    expect(stemLowpassHz(0.5)).toBeGreaterThan(stemLowpassHz(0.4))
  })

  it('maps a finger pair onto its stem; unmapped stems stay at 1', () => {
    const map: SoundEntry[] = [{ target: 'stem.drums', source: 'gesture.pair_index', min: 0, max: 1, curve: 'lin', dead: 0.05 }]
    const out = evaluate(map, { 'gesture.pair_index': 0.5 }, new Map(), 0.016)
    expect(out.drums).toBeCloseTo(0.45 / 0.95, 6)
    expect([out.bass, out.vocals, out.other]).toEqual([1, 1, 1])
    expect(usesStems(map)).toBe(true)
    expect(usesStems([{ ...map[0]!, target: 'fx.wash' }])).toBe(false)
    expect(usesStems(null)).toBe(false)
  })

  it("STRINGS' map: the strings' lengths play the stems; a pinched hand turned wobbles or growls the bass, a fist tears it, victory gates it, both pinched pump; hands unseen sit neutral", () => {
    const strings = JSON.parse(readFileSync(resolve(__dirname, '../../../../touchdesigner/presets/strings/preset.json'), 'utf8'))
    const map = strings.sound.map as SoundEntry[]
    const unseen = Object.fromEntries(Object.entries(GESTURES_NEUTRAL).map(([k, v]) => [`gesture.${k}`, v]))
    const run = (over: Record<string, number>) => evaluate(map, { ...unseen, ...over }, new Map(), 0.016)
    const rest = run({})
    for (const [k, v] of Object.entries(NEUTRAL)) expect(rest[k as keyof typeof rest]).toBeCloseTo(v, 6)
    expect(run({ 'gesture.pair_index': 0 })).toMatchObject({ drums: 0, bass: 1, other: 1 })
    expect(run({ 'gesture.turn_l': 0.7, 'gesture.pinch_l': 1 })).toMatchObject({ wobble: 0.7, wobbleDepth: 1 })
    const growl = run({ 'gesture.turn_r': 1, 'gesture.twist_r': -1 })
    expect(growl.growl).toBeCloseTo(1, 6)
    expect(growl.vowel).toBeCloseTo(0, 6) // anticlockwise: "o"
    expect(run({ 'gesture.fist': 1 }).tear).toBe(1)
    expect(run({ 'gesture.victory': 1 }).gate).toBe(1)
    expect(run({ 'gesture.squeeze': 1 }).pump).toBeCloseTo(1, 6)
    expect(usesStems(map)).toBe(true)
  })

  it("PROD's STRINGS page: the song from its stems, the beat FX from the hands (the drive), GLASS from the map; no deck, the stems read 1", () => {
    expect(STRINGS_SOUND.stems).toBe(true)
    expect(typeof STRINGS_SOUND.drive).toBe('function')
    expect(STRINGS_SOUND.map.every((e) => SOUND_TARGETS.includes(e.target))).toBe(true)
    expect(stemLevels()).toEqual({ drums: 1, bass: 1, vocals: 1, other: 1 })
  })

  it('plays from stems only once the split is done with all four', () => {
    const stems = STEMS.map((name) => ({ name, audio_id: `a-${name}` }))
    expect(songStems({ stems_state: 'done', stems })).toEqual({ drums: 'a-drums', bass: 'a-bass', vocals: 'a-vocals', other: 'a-other' })
    expect(songStems({ stems_state: 'done', stems: stems.slice(1) })).toBeNull()
    expect(songStems({ stems_state: 'running', stems })).toBeNull()
  })

  it("reads S1's finger pairs; with a hand out of sight the strings let go (1: the stems play whole)", () => {
    const t = new GestureTracker()
    const side = { pinch: 0, open: 1, fingers: 5, gesture: null, points: [] }
    const frame = { held: false, size: 0, x0: 0, y0: 0, x1: 0, y1: 0, corners: [], since: 0, seen: 0 }
    const sig = (at: number, right: unknown) => ({ at, calibrating: false, near: 0, twoFaces: false, head: null, hands: [],
      shapes: { left: side, right, apart: 0.4, frame, triangle: false, pairs: { thumb: 0.9, index: 0.2, middle: 0.4, ring: 0.6, pinky: 0 } } }) as unknown as Parameters<GestureTracker['update']>[0]
    let g = GESTURES_NEUTRAL
    for (let ms = 0; ms <= 600; ms += 16) g = t.update(sig(ms, side), ms, 0.016)
    expect(g.pair_index).toBeCloseTo(0.2, 2)
    expect(g.pair_ring).toBeCloseTo(0.6, 2)
    expect(g.pair_pinky).toBeCloseTo(0, 2)
    for (let ms = 616; ms <= 1200; ms += 16) g = t.update(sig(ms, null), ms, 0.016)
    expect(g.pair_pinky).toBeGreaterThan(0.98)
  })

  it('each stem follows its level by a ramp, and sits at 1 while AUDIO FX is off', () => {
    class Param {
      value = 1
      setTargetAtTime(v: number, _t: number, tau: number) {
        expect(tau).toBeGreaterThan(0.004)
        this.value = v
        return this
      }
    }
    class Node { connect<T>(n: T) { return n } disconnect() {} }
    Object.assign(globalThis as Record<string, unknown>, {
      GainNode: class extends Node { gain = new Param() },
      BiquadFilterNode: class extends Node { frequency = new Param(); Q = new Param() },
      StereoPannerNode: class extends Node { pan = new Param() },
      DelayNode: class extends Node { delayTime = new Param() },
      ConvolverNode: class extends Node {},
      AudioWorkletNode: class extends Node {
        private p: Record<string, Param> = {}
        parameters = { get: (k: string) => (this.p[k] ??= new Param()) }
        port = { postMessage: () => {}, onmessage: null }
      },
    })
    useSongFx.setState({ enabled: true })
    const fx = new SongFx({ currentTime: 0, sampleRate: SR } as unknown as BaseAudioContext, () => null, {} as AudioBuffer)
    const level = (n: 'drums' | 'vocals') => (fx.stemInputs[n].gain as unknown as Param).value
    fx.set({ drums: 0.25 })
    expect(level('drums')).toBe(0.25)
    expect(level('vocals')).toBe(1)
    useSongFx.setState({ enabled: false }) // resets: every stem back to 1, and held there
    fx.set({ drums: 0.25 })
    expect(level('drums')).toBe(1)
    useSongFx.setState({ enabled: true })
    fx.dispose()
  })
})

describe("STRINGS' bass-music FX (the stemfx worklet, 120 BPM)", () => {
  const N = SR * 3
  const wave = (f: (t: number) => number) => Float32Array.from({ length: N }, (_, i) => f(i / SR))
  const saw = (hz: number, amp: number) => wave((t) => amp * (2 * ((t * hz) % 1) - 1))
  const sine = (hz: number, amp: number) => wave((t) => amp * Math.sin(2 * Math.PI * hz * t))
  const silent = new Float32Array(N)
  const P = (over: Record<string, number> = {}) => ({ wobble: 0, wobbleDepth: 0, wobbleRate: 2, growl: 0, vowel: 0.5, tear: 0, gate: 0, gateRate: 3,
    pump: 0, subdrop: 0, bassSemi: 0, vibrato: 0, world: 0, worldWet: 0, worldTilt: 0, ...over })
  /** Runs the stems (drums, bass, vocals, other; each [L, R]) through it in 128-sample blocks. */
  const run = (stems: [Float32Array, Float32Array][], params: Record<string, number>) => {
    const { procs, scope } = worklets()
    const fx = new procs['fvwks-stemfx']!()
    const oL = new Float32Array(N), oR = new Float32Array(N)
    const p = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, new Float32Array([v])]))
    for (let i = 0; i < N; i += 128) {
      scope.currentTime = i / SR
      fx.process(stems.map(([l, r]) => [l.subarray(i, i + 128), r.subarray(i, i + 128)]), [[oL.subarray(i, i + 128), oR.subarray(i, i + 128)]], p)
    }
    return [oL, oR] as const
  }
  const mono = (x: Float32Array): [Float32Array, Float32Array] => [x, x]
  /** The RMS over `win` samples every 10 ms, from 0.5 s on (the smoothing settled). */
  const envelope = (x: Float32Array, win = SR / 20) => Array.from({ length: Math.floor((N - SR / 2 - win) / (SR / 100)) }, (_, w) => {
    const a = x.subarray(SR / 2 + (w * SR) / 100, SR / 2 + (w * SR) / 100 + win)
    return Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length)
  })
  const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  /** How often an envelope rises through its middle (with 20 % hysteresis), a second. */
  const rate = (env: number[]) => {
    const lo = env.reduce((m, v) => Math.min(m, v), Infinity)
    const hi = env.reduce((m, v) => Math.max(m, v), 0)
    let up = false
    let n = 0
    for (const v of env) {
      if (!up && v > lo + 0.6 * (hi - lo)) {
        up = true
        n++
      } else if (up && v < lo + 0.4 * (hi - lo)) up = false
    }
    return n / ((env.length * 10) / 1000)
  }

  it('at rest it is the four stems summed', () => {
    const d = sine(60, 0.1), b = saw(55, 0.1), v = sine(440, 0.05), o = sine(660, 0.05)
    const [L] = run([mono(d), mono(b), mono(v), mono(o)], P())
    for (let i = SR / 2; i < N; i += 997) expect(L[i]).toBeCloseTo(d[i]! + b[i]! + v[i]! + o[i]!, 3)
  })

  it('the wobble sweeps the bass on the beat: 2 a beat (1/8 notes) is 4 sweeps a second at 120 BPM', () => {
    const [L] = run([mono(silent), mono(saw(55, 0.3)), mono(silent), mono(silent)], P({ wobble: 1, wobbleDepth: 1, wobbleRate: 2 }))
    const bright = L.map((v, i) => (i ? v - L[i - 1]! : 0)) // the change sample to sample: its highs, where the cutoff shows
    const r = rate(envelope(bright, SR / 50)) // 20 ms windows: a sweep is 250 ms
    expect(r).toBeGreaterThan(3.4)
    expect(r).toBeLessThan(4.6)
  })

  it('the riddim gate chops the bass in 1/8-note triplets (6 a second at 120 BPM), its edges soft', () => {
    const bass = sine(80, 0.4)
    const [L] = run([mono(silent), mono(bass), mono(silent), mono(silent)], P({ gate: 1 }))
    const r = rate(envelope(L, SR / 80)) // 12.5 ms windows (one period of 80 Hz): a chop is 167 ms
    expect(r).toBeGreaterThan(5.4)
    expect(r).toBeLessThan(6.6)
    expect(maxStep(L.subarray(SR / 2))).toBeLessThan(maxStep(bass) * 1.5) // no clicks at the chops (past the engage's hit)
  })

  it('the pump ducks everything but the drums on the beat, the drums untouched', () => {
    const [L] = run([mono(silent), mono(silent), mono(sine(440, 0.3)), mono(silent)], P({ pump: 1 }))
    const env = envelope(L, SR / 40) // 25 ms windows every 10 ms from 0.5 s (on a beat; a beat is 50 of them)
    expect(env[0]!).toBeLessThan(0.75 * env[38]!) // just after the beat vs late in it
    const [D] = run([mono(sine(60, 0.3)), mono(silent), mono(silent), mono(silent)], P({ pump: 1 }))
    expect(Math.abs(envelope(D)[0]! - envelope(D)[38]!)).toBeLessThan(0.005)
  })

  it('everything at full stays under full scale, and the bass is mono below 150 Hz', () => {
    const loud = saw(55, 0.6)
    const [L, R] = run([mono(sine(60, 0.5)), mono(loud), mono(sine(330, 0.5)), mono(sine(550, 0.5))],
      P({ wobble: 1, wobbleDepth: 1, wobbleRate: 6, growl: 1, vowel: 1, tear: 1, gate: 1, gateRate: 4, pump: 1, subdrop: 1, bassSemi: 12, vibrato: 1, world: 5, worldWet: 1, worldTilt: 1 }))
    expect(Math.max(peak(L), peak(R))).toBeLessThanOrEqual(1)
    const [l, r] = run([mono(silent), [sine(60, 0.4), sine(60, -0.4)], mono(silent), mono(silent)], P()) // 60 Hz in anti-phase
    const side = envelope(l.map((v, i) => v - r[i]!))
    expect(Math.max(...side)).toBeLessThan(0.1 * 0.4) // the lows summed to mono
  })

  it('TEAROUT grinds the bass (Density drive, DeRez2 crush): far more highs, louder by density at about its own peak', () => {
    const bass = sine(55, 0.4)
    const hf = (x: Float32Array) => Math.sqrt(x.subarray(SR).reduce((a, v, i, b) => a + (i ? (v - b[i - 1]!) ** 2 : 0), 0) / (N - SR))
    const [L] = run([mono(silent), mono(bass), mono(silent), mono(silent)], P({ tear: 1 }))
    const rms = (x: Float32Array) => Math.sqrt(x.subarray(SR).reduce((m, v) => m + v * v, 0) / (N - SR))
    expect(hf(L)).toBeGreaterThan(3 * hf(bass))
    expect(rms(L)).toBeGreaterThan(1.05 * rms(bass)) // louder (denser)…
    expect(peak(L.subarray(SR))).toBeLessThan(1.3 * peak(bass)) // …at about the bass's own peak (the mix's peaks unmoved)
  })

  it('SUB DROP takes the bass an octave down; the 808 slide at +12 an octave up', () => {
    const bass = [mono(silent), mono(sine(110, 0.4)), mono(silent), mono(silent)]
    /** Zero crossings a second from 1 s (a granular shift smears one DFT bin, not the crossings); the level. */
    const pitch = (x: Float32Array): [number, number] => [x.subarray(SR).reduce((a, v, i, b) => a + (i && Math.sign(v) !== Math.sign(b[i - 1]!) ? 1 : 0), 0) / ((N - SR) / SR) / 2,
      Math.sqrt(x.subarray(SR).reduce((a, v) => a + v * v, 0) / (N - SR))]
    const [down, downLevel] = pitch(run(bass, P({ subdrop: 1 }))[0])
    const [up, upLevel] = pitch(run(bass, P({ bassSemi: 12 }))[0])
    expect(down).toBeGreaterThan(45)
    expect(down).toBeLessThan(70)
    expect(up).toBeGreaterThan(190)
    expect(up).toBeLessThan(250)
    expect(Math.min(downLevel, upLevel)).toBeGreaterThan(0.1)
  })

  it("GLASS's six worlds each change the sound and none does at wet 0; 8-BIT leaves the sub", () => {
    const stems = [mono(sine(60, 0.3)), mono(saw(55, 0.2)), mono(sine(440, 0.1)), mono(sine(660, 0.1))]
    const [dry] = run(stems, P())
    const diff = (x: Float32Array) => Math.sqrt(x.subarray(SR).reduce((a, v, i) => a + (v - dry[SR + i]!) ** 2, 0) / (N - SR))
    for (let world = 1; world <= 6; world++) {
      expect(diff(run(stems, P({ world, worldWet: 1, worldTilt: 1 }))[0])).toBeGreaterThan(0.01)
      expect(diff(run(stems, P({ world, worldWet: 0, worldTilt: 1 }))[0])).toBeLessThan(1e-6)
    }
    const kick = [mono(sine(60, 0.3)), mono(silent), mono(sine(1000, 0.2)), mono(silent)]
    expect(tone(run(kick, P({ world: 3, worldWet: 1, worldTilt: 1 }))[0], 60)).toBeGreaterThan(0.7 * tone(run(kick, P())[0], 60))
  })
})

describe("STRINGS' big moves (the moves worklet: slip, 120 BPM)", () => {
  const N = SR * 3
  const wave = (f: (t: number) => number) => Float32Array.from({ length: N }, (_, i) => f(i / SR))
  const MOVES0 = { halftime: 0, buildroll: 0, octave: 0, rewind: 0, reverse: 0, brake: 0 }
  const moves = (x: Float32Array, params: (i: number) => Record<string, number>) => {
    const { procs, run } = worklets()
    return run(new procs['fvwks-moves']!(), x, x, (i) => ({ ...MOVES0, ...params(i) }))[0]
  }
  const rms = (x: Float32Array, from: number, to: number) => Math.sqrt(x.subarray(from, to).reduce((a, v) => a + v * v, 0) / (to - from))
  let seed = 7
  const noise = wave(() => 0.3 * ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 31 - 1))
  const corr = (a: Float32Array, b: Float32Array) => {
    let ab = 0, aa = 0, bb = 0
    for (let i = 0; i < a.length; i++) { ab += a[i]! * b[i]!; aa += a[i]! ** 2; bb += b[i]! ** 2 }
    return ab / Math.sqrt(aa * bb)
  }

  it('at rest the song passes untouched', () => {
    const y = moves(noise, () => ({}))
    for (let i = 0; i < N; i += 331) expect(y[i]).toBeCloseTo(noise[i]!, 6)
  })

  it('HALFTIME keeps the pitch and halves the beat: a hit on every beat comes once a second', () => {
    const y = moves(wave((t) => 0.5 * Math.sin(2 * Math.PI * 440 * t)), () => ({ halftime: 1 }))
    expect(tone(y, 440)).toBeGreaterThan(5 * tone(y, 220))
    const pulses = moves(wave((t) => ((t % 0.5) < 0.03 ? 0.5 * Math.sin(2 * Math.PI * 1000 * t) : 0)), () => ({ halftime: 1 }))
    const loud = Array.from({ length: 300 }, (_, k) => rms(pulses, k * 480, k * 480 + 480)) // 10 ms windows
    const top = Math.max(...loud)
    const at = loud.flatMap((v, k) => (v > 0.5 * top && (k === 0 || loud[k - 1]! <= 0.5 * top) ? [k / 100] : []))
    const hits = at.filter((t, k) => k === 0 || t - at[k - 1]! > 0.25) // a grain's smear is one hit
    expect(hits.length).toBe(3) // 0, 1 and 2 s (from 6 beats)
  })

  it('BUILD ROLL repeats its slice: half a beat in the 2nd beat held, the song running on underneath', () => {
    const y = moves(noise, () => ({ buildroll: 1 }))
    const q = SR / 4 // half a beat
    expect(corr(y.subarray(SR / 2 + 480, SR / 2 + q - 480), y.subarray(SR / 2 + q + 480, SR / 2 + 2 * q - 480))).toBeGreaterThan(0.8)
    expect(Math.abs(corr(noise.subarray(SR / 2 + 480, SR / 2 + q - 480), noise.subarray(SR / 2 + q + 480, SR / 2 + 2 * q - 480)))).toBeLessThan(0.1)
  })

  it('BRAKE slows the song to a stop over 2 beats', () => {
    const x = wave((t) => 0.5 * Math.sin(2 * Math.PI * 440 * t))
    const y = moves(x, (i) => ({ brake: i >= SR / 2 ? 1 : 0 }))
    expect(rms(y, 1.6 * SR, 1.9 * SR)).toBeLessThan(0.01)
  })

  it('REVERSE plays the beat before the next one backwards', () => {
    const x = wave((t) => 0.5 * Math.sin(2 * Math.PI * (200 * t + 300 * t * t))) // a rising sweep
    const y = moves(x, (i) => ({ reverse: i >= 0.6 * SR ? 1 : 0 }))
    const back = Float32Array.from({ length: 0.4 * SR }, (_, k) => x[2 * SR - 1 - (SR + 480 + k)]!)
    expect(corr(y.subarray(SR + 480, SR + 480 + 0.4 * SR), back)).toBeGreaterThan(0.99)
  })

  it('slip: let go of any move and it is the live song again, in time (it ran on underneath)', () => {
    for (const move of ['halftime', 'buildroll', 'octave', 'brake', 'rewind']) {
      const y = moves(noise, (i) => ({ [move]: i >= SR && i < 2 * SR ? 1 : 0 }))
      expect(rms(y.map((v, i) => v - noise[i]!), 1.6 * SR, 1.8 * SR), move).toBeGreaterThan(0.05) // it did something…
      expect(y.subarray(2.06 * SR).reduce((m, v, i) => Math.max(m, Math.abs(v - noise[2.06 * SR + i]!)), 0), move).toBeLessThan(0.01) // …and is back
      expect(y.reduce((m, v) => Math.max(m, Math.abs(v)), 0), move).toBeLessThanOrEqual(1)
    }
  })
})

describe("STRINGS' punch and FINGER FILTERS (the stemfx engage, the iso worklet)", () => {
  const N = SR * 3
  const wave = (f: (t: number) => number) => Float32Array.from({ length: N }, (_, i) => f(i / SR))
  const sine = (hz: number, amp = 0.3) => wave((t) => amp * Math.sin(2 * Math.PI * hz * t))
  const iso = (x: Float32Array, params: (i: number) => Record<string, number>) => {
    const { procs, run } = worklets()
    return run(new procs['fvwks-iso']!(), x, x, (i) => ({ iso: 1, cutSub: 0, cutLow: 0, cutMid: 0, cutHiMid: 0, cutHigh: 0, ...params(i) }))[0]
  }
  const CENTRES = [30, 122, 500, 2000, 9000]
  const CUT = ['cutSub', 'cutLow', 'cutMid', 'cutHiMid', 'cutHigh']

  it('an FX engaged off the grid waits for the next 16th, then is at full in under 30 ms', () => {
    const { procs, scope } = worklets()
    const fx = new procs['fvwks-stemfx']!()
    const bass = sine(55, 0.4), silent = new Float32Array(N), o = [new Float32Array(128), new Float32Array(128)]
    const P = (tear: number) => Object.fromEntries(Object.entries({ wobble: 0, wobbleDepth: 0, wobbleRate: 2, growl: 0, vowel: 0.5, tear, gate: 0, gateRate: 3,
      pump: 0, subdrop: 0, bassSemi: 0, vibrato: 0, world: 0, worldWet: 0, worldTilt: 0 }).map(([k, v]) => [k, new Float32Array([v])]))
    const trace: [number, number][] = []
    for (let i = 0; i < 1.4 * SR; i += 128) {
      scope.currentTime = i / SR
      const ins = [silent, bass, silent, silent].map((x) => [x.subarray(i, i + 128), x.subarray(i, i + 128)])
      fx.process(ins, [o], P(i >= 1.03 * SR ? 1 : 0)) // the fist at 1.03 s: the next 16th (120 BPM) is 1.125 s
      trace.push([(i + 128) / SR, fx.v.tea])
    }
    expect(trace.filter(([t]) => t < 1.12).every(([, v]) => v === 0)).toBe(true)
    const full = trace.find(([t, v]) => t > 1.125 && v >= 0.95)!
    expect(full[0] - 1.125).toBeLessThan(0.03)
  })

  it("SUB DROP's octave dive waits for the 16th too, then is all the way down in under 30 ms", () => {
    const { procs, scope } = worklets()
    const fx = new procs['fvwks-stemfx']!()
    const bass = sine(55, 0.4), silent = new Float32Array(N), o = [new Float32Array(128), new Float32Array(128)]
    const P = (subdrop: number) => Object.fromEntries(Object.entries({ wobble: 0, wobbleDepth: 0, wobbleRate: 2, growl: 0, vowel: 0.5, tear: 0, gate: 0, gateRate: 3,
      pump: 0, subdrop, bassSemi: 0, vibrato: 0, world: 0, worldWet: 0, worldTilt: 0 }).map(([k, v]) => [k, new Float32Array([v])]))
    const trace: [number, number][] = []
    for (let i = 0; i < 1.4 * SR; i += 128) {
      scope.currentTime = i / SR
      fx.process([silent, bass, silent, silent].map((x) => [x.subarray(i, i + 128), x.subarray(i, i + 128)]), [o], P(i >= 1.03 * SR ? 1 : 0))
      trace.push([(i + 128) / SR, fx.v.dive])
    }
    expect(trace.filter(([t]) => t < 1.12).every(([, v]) => v === 0)).toBe(true)
    expect(trace.find(([t, v]) => t > 1.125 && v >= 0.95)![0] - 1.125).toBeLessThan(0.03)
  })

  it('off, the song itself; on with every band open, flat (the allpass sum) to 0.05 dB', () => {
    for (const hz of [30, 60, 122, 250, 1000, 4000, 9000]) {
      const x = sine(hz)
      expect(iso(x, () => ({ iso: 0 }))).toEqual(x)
      expect(20 * Math.log10(tone(iso(x, () => ({})), hz) / tone(x, hz))).toBeCloseTo(0, 1)
    }
  })

  it('each finger kills its band (18 dB and more at its centre: LR4 over two octaves) and leaves the others', () => {
    CUT.forEach((cut, k) => {
      const y = (hz: number) => tone(iso(sine(hz), () => ({ [cut]: 1 })), hz) / tone(sine(hz), hz)
      expect(20 * Math.log10(y(CENTRES[k]!)), cut).toBeLessThan(-18)
      for (const [j, hz] of CENTRES.entries()) if (Math.abs(j - k) > 1) expect(Math.abs(20 * Math.log10(y(hz))), `${cut} at ${hz}`).toBeLessThan(1)
    })
  })

  it('a killed band raised again lands with a hit; folding is smooth (no step bigger than the song makes)', () => {
    const x = sine(122)
    const y = iso(x, (i) => ({ cutLow: i >= SR && i < 2 * SR ? 1 : 0 }))
    const rms = (a: Float32Array, from: number, to: number) => Math.sqrt(a.subarray(from, to).reduce((m, v) => m + v * v, 0) / (to - from))
    expect(rms(y, 1.5 * SR, 1.9 * SR)).toBeLessThan(0.125 * rms(x, 1.5 * SR, 1.9 * SR)) // killed (-18 dB)
    expect(rms(y, 2.0 * SR, 2.1 * SR) - rms(x, 2.0 * SR, 2.1 * SR)).toBeGreaterThan(0.02) // back, with the hit on its 16th
    const step = (a: Float32Array, from: number, to: number) => a.subarray(from, to).reduce((m, v, i, b) => (i ? Math.max(m, Math.abs(v - b[i - 1]!)) : m), 0)
    expect(step(y, SR - 480, SR + 4800)).toBeLessThan(2 * step(x, SR - 480, SR + 4800)) // the closing ring lifts it a little; a click would be far past
  })
})

describe("STRINGS' GLASS: a world with its own sound", () => {
  it("STRINGS' map: the glass's world, how far in (its size) and its control (its tilt); a crack fires the hit; no glass, at rest", () => {
    const unseen = Object.fromEntries(Object.entries(GESTURES_NEUTRAL).map(([k, v]) => [`gesture.${k}`, v]))
    const run = (over: Record<string, number>) => evaluate(STRINGS_SOUND.map, { ...unseen, ...over }, new Map(), 0.016)
    expect(run({})).toMatchObject({ glass: 0, world: 0, crack: 0 })
    const g = run({ 'gesture.glass_on': 1, 'gesture.glass_world': 3 / 6, 'gesture.glass_size': 1, 'gesture.glass_tilt': 1 })
    expect(g.glass).toBe(1)
    expect(g.world).toBeCloseTo(3, 6) // 8-BIT
    expect(g.worldWet).toBeCloseTo(1, 6)
    expect(g.worldTilt).toBeCloseTo(1, 6)
    expect(run({ 'gesture.glass_crack': 1 }).crack).toBe(1)
  })

  it('reads the glass signal: on, its world, size and tilt, and a crack as a short pulse', () => {
    const t = new GestureTracker()
    let glass = { on: true, type: 'kaleido', size: 0.3, tilt: -0.5, crackAt: 0 }
    const previous = glassInput.current
    glassInput.current = () => glass
    let g = GESTURES_NEUTRAL
    for (let ms = 0; ms <= 600; ms += 16) g = t.update(null, ms, 0.016)
    expect(g.glass_on).toBe(1)
    expect(g.glass_world).toBeCloseTo(5 / 6, 6) // MIRROR
    expect(g.glass_size).toBeCloseTo(0.3, 2)
    expect(g.glass_tilt).toBeCloseTo(-0.5, 2)
    glass = { on: false, type: 'kaleido', size: 0.3, tilt: -0.5, crackAt: 610 }
    g = t.update(null, 616, 0.016)
    expect(g.glass_crack).toBe(1)
    expect(g.glass_world).toBe(0)
    for (let ms = 632; ms <= 900; ms += 16) g = t.update(null, ms, 0.016)
    expect(g.glass_crack).toBe(0)
    glassInput.current = previous
  })

  it('in and out whoosh (the low-pass swept down and back); a crack crushes and stutters once', () => {
    class Param {
      value = 0
      setTargetAtTime(v: number) {
        this.value = v
        return this
      }
    }
    class Node { connect<T>(n: T) { return n } disconnect() {} }
    const posted: { kind: string }[] = []
    Object.assign(globalThis as Record<string, unknown>, {
      GainNode: class extends Node { gain = new Param() },
      BiquadFilterNode: class extends Node { frequency = new Param(); Q = new Param() },
      StereoPannerNode: class extends Node { pan = new Param() },
      DelayNode: class extends Node { delayTime = new Param() },
      ConvolverNode: class extends Node {},
      AudioWorkletNode: class extends Node {
        private p: Record<string, Param> = {}
        parameters = { get: (k: string) => (this.p[k] ??= new Param()) }
        port = { postMessage: (m: { kind: string }) => posted.push(m), onmessage: null }
      },
    })
    useSongFx.setState({ enabled: true })
    const ctx = { currentTime: 0, sampleRate: SR }
    const fx = new SongFx(ctx as unknown as BaseAudioContext, () => null, {} as AudioBuffer)
    const inner = fx as unknown as { lp: { frequency: Param }; wet: { gain: Param }; param(n: string): Param }
    fx.set({ iso: 1 }) // STRINGS: through the limiter from the start, no FX engaged (no level jump on engaging)
    expect(inner.wet.gain.value).toBe(1)
    fx.set({ glass: 1 })
    ctx.currentTime = 0.22 // the middle of the sweep
    fx.set({ glass: 1 })
    expect(inner.lp.frequency.value).toBeLessThan(1000)
    ctx.currentTime = 1
    fx.set({ glass: 1 })
    expect(inner.lp.frequency.value).toBeCloseTo(20000, 0) // through
    fx.set({ crack: 1 })
    fx.set({ crack: 1 }) // held: still one hit
    expect(posted.filter((m) => m.kind === 'stutter')).toHaveLength(1)
    expect(inner.param('crush').value).toBeCloseTo(0.85, 6)
    fx.dispose()
  })
})
