// The TRACK song's live FX (1.5.2): the limiter holds its true-peak ceiling, nothing clicks (the worklets run here on
// their real code in a small sandbox; the native nodes only ever move by setTargetAtTime), and the preset map's math.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DRAWN_MS, GESTURES_NEUTRAL, GestureTracker, SIGN_HOLD_MS, SOUND_TARGETS, evaluate, startSoundMap, type SoundEntry } from '@/audio/live/soundMap'
import { KNOBS } from '@/touchdesigner/knobs'
import { TE_CHANNELS } from '@shared/touchengine'
import { stageFrames } from '@/visuals/live/stage'
import { NEUTRAL, SongFx, activeFx, filterHz, nextStep } from '@/audio/live/songFx'

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
    expect(filterHz(0)).toEqual({ lp: 20000, hp: 20 })
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
