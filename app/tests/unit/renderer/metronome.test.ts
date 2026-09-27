// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RenderInfo } from '../../../src/renderer/src/api/types'
import { barSamples } from '../../../src/renderer/src/audio/grid'
import {
  BEAT_TONE,
  blipSamples,
  CLICK_S,
  clickGain,
  clicksBetween,
  DEFAULT_CLICK_VOLUME,
  DOWNBEAT_TONE,
  LOOKAHEAD_S,
  Metronome,
  TICK_MS,
  type Click,
  type ClickTimeline,
  type MetronomeHost,
} from '../../../src/renderer/src/audio/metronome'
import { metronome, player } from '../../../src/renderer/src/audio/playerInstance'
import { matchShortcut, SHORTCUTS } from '../../../src/renderer/src/lib/shortcuts'
import {
  installMetronomeShortcut,
  METRONOME_KEY,
  parseMetronomePrefs,
  useMetronome,
} from '../../../src/renderer/src/state/metronome'
import { useStudio } from '../../../src/renderer/src/state/studio'
import { useUi } from '../../../src/renderer/src/state/ui'

// ------------------------------------------------------------------------------------------------ fakes
// A minimal Web Audio stand-in: enough for DualPlayer and the metronome, recording every source's start/stop.

class FakeParam {
  constructor(public value = 1) {}
  setTargetAtTime(v: number) {
    this.value = v
    return this
  }
}
class FakeNode {
  outputs: unknown[] = []
  connect<T>(n: T): T {
    this.outputs.push(n)
    return n
  }
  disconnect() {
    this.outputs = []
  }
}
class FakeGain extends FakeNode {
  gain = new FakeParam()
}
class FakeAnalyser extends FakeNode {
  fftSize = 2048
  smoothingTimeConstant = 0.8
}
class FakeBuffer {
  private data: Float32Array[]
  constructor(
    public numberOfChannels: number,
    public length: number,
    public sampleRate: number,
  ) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length))
  }
  get duration() {
    return this.length / this.sampleRate
  }
  getChannelData(c: number) {
    return this.data[c]!
  }
  copyToChannel(src: Float32Array, c: number) {
    this.data[c]!.set(src.subarray(0, this.length))
  }
}
class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null
  loop = false
  loopStart = 0
  loopEnd = 0
  onended: (() => void) | null = null
  when: number | null = null
  offset = 0
  /** Context time when start() was called. */
  scheduledAt = 0
  stopped = false
  constructor(private ctx: FakeContext) {
    super()
  }
  start(when: number, offset = 0) {
    this.when = when
    this.offset = offset
    this.scheduledAt = this.ctx.currentTime
  }
  stop() {
    this.stopped = true
  }
}
class FakeContext {
  state = 'running'
  currentTime = 0
  sampleRate = 48_000
  destination = new FakeNode()
  sources: FakeSource[] = []
  gains: FakeGain[] = []
  analysers: FakeAnalyser[] = []
  createGain() {
    const g = new FakeGain()
    this.gains.push(g)
    return g
  }
  createAnalyser() {
    const a = new FakeAnalyser()
    this.analysers.push(a)
    return a
  }
  createBufferSource() {
    const s = new FakeSource(this)
    this.sources.push(s)
    return s
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return new FakeBuffer(channels, length, sampleRate)
  }
  resume() {
    return Promise.resolve()
  }
}

const CLICK_FRAMES = Math.round(CLICK_S * 48_000)
/** Click sources still due to sound (not cancelled), in start order. */
const clickTimes = (ctx: FakeContext) =>
  ctx.sources
    .filter((s) => s.buffer?.length === CLICK_FRAMES && !s.stopped)
    .map((s) => s.when!)
    .sort((a, b) => a - b)
/** Downbeat clicks are the loud ones (DOWNBEAT_TONE 0.9 vs BEAT_TONE 0.5). */
const isDownbeat = (s: FakeSource) => Math.max(...Array.from(s.buffer!.getChannelData(0), Math.abs)) > 0.6

/** Advances the context clock and the scheduler's timer together, one tick at a time. */
function run(ctx: FakeContext, seconds: number) {
  const steps = Math.round((seconds * 1000) / TICK_MS)
  for (let i = 0; i < steps; i++) {
    ctx.currentTime += TICK_MS / 1000
    vi.advanceTimersByTime(TICK_MS)
  }
}

/** A transport the tests drive by hand (the real DualPlayer is exercised further down). */
class FakeTransport implements MetronomeHost {
  ctx = new FakeContext()
  input = new FakeNode()
  state = { epoch: 0, playing: false, startedAt: 0, offset: 0, duration: 8, loop: null as [number, number] | null }
  private listeners = new Set<() => void>()
  timeline() {
    return { ...this.state }
  }
  monitorBus() {
    return { ctx: this.ctx as unknown as BaseAudioContext, input: this.input as unknown as AudioNode }
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn)
    fn()
    return () => {
      this.listeners.delete(fn)
    }
  }
  emit() {
    for (const l of this.listeners) l()
  }
  /** Sources (re)start 10 ms from now, as DualPlayer does. */
  play(offset: number, loop: [number, number] | null = this.state.loop) {
    this.state = { ...this.state, epoch: this.state.epoch + 1, playing: true, startedAt: this.ctx.currentTime + 0.01, offset, loop }
    this.emit()
  }
  pause() {
    this.state = { ...this.state, epoch: this.state.epoch + 1, playing: false }
    this.emit()
  }
}

const tl = (p: Partial<ClickTimeline> = {}): ClickTimeline => ({ bpm: 120, startedAt: 10, offset: 0, duration: 8, loop: null, ...p })
const r6 = (v: number) => Math.round(v * 1e6) / 1e6
const whens = (cs: Click[]) => cs.map((c) => r6(c.when))

// ------------------------------------------------------------------------------------------------ timing maths

describe('metronome timing (clicksBetween)', () => {
  it('clicks every beat of the grid from the file start, every 4th a downbeat', () => {
    const cs = clicksBetween(tl(), 10, 12.25)
    expect(whens(cs)).toEqual([10, 10.5, 11, 11.5, 12])
    expect(cs.map((c) => c.beat)).toEqual([0, 1, 2, 3, 4])
    expect(cs.map((c) => c.downbeat)).toEqual([true, false, false, false, true])
    expect(cs.map((c) => c.at)).toEqual([0, 0.5, 1, 1.5, 2])
  })

  it('follows the playback offset: a seek mid-beat waits for the next beat, a seek onto a beat clicks at once', () => {
    const mid = clicksBetween(tl({ offset: 1.2 }), 9.99, 11)
    expect(whens(mid)).toEqual([10.3, 10.8])
    expect(mid.map((c) => c.beat)).toEqual([3, 4])
    expect(mid[1]!.downbeat).toBe(true)
    const on = clicksBetween(tl({ offset: 2 }), 9.99, 10.6)
    expect(whens(on)).toEqual([10, 10.5])
    expect(on[0]).toMatchObject({ beat: 4, downbeat: true })
    // Nothing before the sources start.
    expect(clicksBetween(tl({ offset: 2 }), 0, 9.999)).toEqual([])
  })

  it('stops at the end of the file, with no click on the end line itself', () => {
    const bpm = 140
    const duration = barSamples(4, bpm, 44_100) / 44_100
    const cs = clicksBetween(tl({ bpm, duration, startedAt: 0 }), 0, 100)
    expect(cs).toHaveLength(16)
    expect(cs.at(-1)!.beat).toBe(15)
  })

  it('wraps with the loop: the downbeat comes back at the loop start, with no double click at the seam', () => {
    // 1 bar at 120 BPM looped whole, playback entered at 1.2 s.
    const cs = clicksBetween(tl({ duration: 2, loop: [0, 2], startedAt: 0, offset: 1.2 }), 0, 4.9)
    expect(whens(cs)).toEqual([0.3, 0.8, 1.3, 1.8, 2.3, 2.8, 3.3, 3.8, 4.3, 4.8])
    expect(cs.map((c) => c.beat)).toEqual([3, 0, 1, 2, 3, 0, 1, 2, 3, 0])
    expect(cs.filter((c) => c.downbeat).map((c) => r6(c.when))).toEqual([0.8, 2.8, 4.8])
  })

  it('wraps a sample-rounded bar-exact loop cleanly at any tempo', () => {
    for (const bpm of [120, 128, 137, 140, 150.5, 174]) {
      const duration = barSamples(1, bpm, 44_100) / 44_100 // a hair short of or past the exact bar
      const cs = clicksBetween(tl({ bpm, duration, startedAt: 0, loop: [0, duration] }), 0, duration * 3 - 1e-9)
      expect(cs.map((c) => c.beat)).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3])
      for (let i = 1; i < cs.length; i++) expect(cs[i]!.when - cs[i - 1]!.when).toBeGreaterThan(60 / bpm - 0.001)
    }
  })

  it('keeps the accents on the file bar grid when the loop region starts mid-bar', () => {
    // Loop beats 2 and 3 of bar 1: [0.5, 1.5) at 120 BPM.
    const cs = clicksBetween(tl({ startedAt: 0, loop: [0.5, 1.5] }), 0, 3.25)
    expect(whens(cs)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3])
    expect(cs.map((c) => c.beat)).toEqual([0, 1, 2, 1, 2, 1, 2])
    expect(cs.filter((c) => c.downbeat)).toHaveLength(1)
  })

  it('re-grids at a new tempo from the same file position (a new render arriving mid-play)', () => {
    // The player restarts the new render where the old one was (3.1 s): at 140 BPM the next beat is beat 8.
    const beat = 60 / 140
    const cs = clicksBetween(tl({ bpm: 140, startedAt: 20, offset: 3.1, duration: 4 * 4 * beat }), 20, 21.3)
    expect(cs[0]).toMatchObject({ beat: 8, downbeat: true })
    expect(cs[0]!.when).toBeCloseTo(20 + (8 * beat - 3.1), 9)
    for (let i = 1; i < cs.length; i++) expect(cs[i]!.when - cs[i - 1]!.when).toBeCloseTo(beat, 9)
    // Same moment at the old tempo: a different grid.
    expect(clicksBetween(tl({ bpm: 120, startedAt: 20, offset: 3.1 }), 20, 21.3)[0]).toMatchObject({ beat: 7, downbeat: false })
  })

  it('partitions the clicks exactly across consecutive windows (a scheduler never doubles or drops one)', () => {
    const cases = [
      tl({ bpm: 137.3, offset: 0.37, duration: 7.1 }),
      tl({ bpm: 128, offset: 1.9, duration: 7.5, loop: [0, 7.5] }),
      tl({ bpm: 174, offset: 0.2, duration: 5.52, loop: [1.1, 3.3] }),
      tl({ bpm: 90, offset: 4.4, duration: 6, loop: [1, 3] }), // entered past the loop end
    ]
    for (const c of cases) {
      const whole = clicksBetween(c, 0, 40)
      const pieces: Click[] = []
      for (let t = 0; t < 40; t += 0.037) pieces.push(...clicksBetween(c, t, Math.min(40, t + 0.037)))
      expect(pieces).toEqual(whole)
      expect(whole.length).toBeGreaterThan(8)
    }
  })

  it('stays silent for a nonsense tempo or an empty file', () => {
    expect(clicksBetween(tl({ bpm: 0 }), 10, 20)).toEqual([])
    expect(clicksBetween(tl({ bpm: Number.NaN }), 10, 20)).toEqual([])
    expect(clicksBetween(tl({ duration: 0 }), 10, 20)).toEqual([])
    expect(clicksBetween(tl(), 12, 12)).toEqual([])
  })
})

describe('metronome click sound', () => {
  const zeroCrossings = (s: Float32Array) => {
    let n = 0
    for (let i = 1; i < s.length; i++) if (s[i - 1]! < 0 !== s[i]! < 0) n++
    return n
  }
  const peak = (s: Float32Array) => s.reduce((m, v) => Math.max(m, Math.abs(v)), 0)

  it('is a short synthesized blip, enveloped to zero at both ends; the downbeat is higher and louder', () => {
    const down = blipSamples(48_000, DOWNBEAT_TONE)
    const beat = blipSamples(48_000, BEAT_TONE)
    expect(down.length).toBe(Math.round(CLICK_S * 48_000))
    for (const s of [down, beat]) {
      expect(Math.abs(s[0]!)).toBeLessThan(1e-6)
      expect(Math.abs(s.at(-1)!)).toBeLessThan(1e-6)
      expect(peak(s.subarray(s.length / 2))).toBeLessThan(peak(s) * 0.05) // over 26 dB down by mid-click
    }
    expect(peak(down)).toBeGreaterThan(peak(beat) * 1.5)
    expect(zeroCrossings(down.subarray(0, 960))).toBeGreaterThan(zeroCrossings(beat.subarray(0, 960)))
  })

  it('maps the fader to gain on a squared taper, modest by default', () => {
    expect(clickGain(0)).toBe(0)
    expect(clickGain(1)).toBe(1)
    expect(clickGain(DEFAULT_CLICK_VOLUME)).toBe(0.25)
    expect(clickGain(3)).toBe(1)
    expect(clickGain(Number.NaN)).toBe(0.25)
  })
})

// ------------------------------------------------------------------------------------------------ scheduler

describe('metronome scheduler', () => {
  let host: FakeTransport
  let m: Metronome
  beforeEach(() => {
    vi.useFakeTimers()
    host = new FakeTransport()
    m = new Metronome(host)
  })
  afterEach(() => {
    m.dispose()
    vi.useRealTimers()
  })

  it('stays silent while off or stopped', () => {
    m.setBpm(120)
    host.play(0)
    run(host.ctx, 1)
    expect(host.ctx.sources).toHaveLength(0)
    host.pause()
    m.setEnabled(true)
    run(host.ctx, 1)
    expect(host.ctx.sources).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('schedules each click ahead at its exact context time, never late, accenting downbeats', () => {
    m.setBpm(120)
    m.setEnabled(true)
    host.play(0) // sources start at 0.01
    expect(clickTimes(host.ctx).map(r6)).toEqual([0.01]) // the first downbeat, queued before it is due
    run(host.ctx, 2)
    expect(clickTimes(host.ctx).map(r6)).toEqual([0.01, 0.51, 1.01, 1.51, 2.01])
    for (const s of host.ctx.sources) expect(s.when!).toBeGreaterThanOrEqual(s.scheduledAt)
    // Never more than the lookahead in flight.
    for (const s of host.ctx.sources) expect(s.when! - s.scheduledAt).toBeLessThanOrEqual(LOOKAHEAD_S + 1e-9)
    expect(host.ctx.sources.map(isDownbeat)).toEqual([true, false, false, false, true])
  })

  it('A/B (a transport event with the same timeline) leaves the queued clicks alone', () => {
    m.setBpm(120)
    m.setEnabled(true)
    host.play(0)
    run(host.ctx, 0.5)
    const before = host.ctx.sources.length
    host.emit()
    host.emit()
    expect(host.ctx.sources.length).toBe(before)
    expect(host.ctx.sources.some((s) => s.stopped)).toBe(false)
  })

  it('a seek drops the queued clicks and re-grids from the new position', () => {
    m.setBpm(120)
    m.setEnabled(true)
    host.play(0)
    run(host.ctx, 0.9) // queued: 1.01
    expect(clickTimes(host.ctx).at(-1)).toBeCloseTo(1.01, 9)
    host.play(3.3) // seek at ~0.9 s: the file is at 3.3 from 0.91
    const queued = host.ctx.sources.filter((s) => s.when! > host.ctx.currentTime)
    expect(queued.every((s) => s.stopped || s.scheduledAt >= host.ctx.currentTime)).toBe(true)
    run(host.ctx, 0.6)
    const after = clickTimes(host.ctx).filter((t) => t > 0.9)
    // Next beat after 3.3 s is 3.5 s: 0.2 s after the restart.
    expect(after[0]).toBeCloseTo(0.91 + 0.2, 6)
    expect(after[1]).toBeCloseTo(0.91 + 0.7, 6)
  })

  it('pause cancels what is queued and stops the timer', () => {
    m.setBpm(120)
    m.setEnabled(true)
    host.play(0)
    run(host.ctx, 0.45) // 0.51 is queued
    host.pause()
    expect(clickTimes(host.ctx).map(r6)).toEqual([0.01])
    run(host.ctx, 1)
    expect(clickTimes(host.ctx).map(r6)).toEqual([0.01])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('wraps with the gapless loop', () => {
    host.state.duration = 2
    m.setBpm(120)
    m.setEnabled(true)
    host.play(1.2, [0, 2])
    run(host.ctx, 2.4)
    const t = clickTimes(host.ctx).map(r6)
    expect(t).toEqual([0.31, 0.81, 1.31, 1.81, 2.31].map(r6))
    // The downbeat returns exactly one loop after the first wrap.
    const downs = host.ctx.sources.filter((s) => !s.stopped && isDownbeat(s)).map((s) => r6(s.when!))
    expect(downs).toEqual([0.81])
  })

  it('a new render at a new tempo re-grids at the same file position', () => {
    m.setBpm(120)
    m.setEnabled(true)
    host.play(0)
    run(host.ctx, 1.0)
    // The player restarts the new render at the same position (about 1.0 s), then the studio gets the new tempo.
    const pos = host.ctx.currentTime
    host.play(pos)
    m.setBpm(140)
    run(host.ctx, 1.5)
    const beat = 60 / 140
    const after = clickTimes(host.ctx).filter((t) => t > pos + 0.005)
    const start = host.state.startedAt
    for (const t of after) {
      const at = pos + (t - start)
      expect(Math.abs(at / beat - Math.round(at / beat))).toBeLessThan(1e-6)
    }
    for (let i = 1; i < after.length; i++) expect(after[i]! - after[i - 1]!).toBeCloseTo(beat, 9)
  })

  it('skips clicks that fell due during a stall instead of playing them late', () => {
    m.setBpm(120)
    m.setEnabled(true)
    host.play(0)
    host.ctx.currentTime += 1.3 // the main thread was blocked; the timer did not run
    vi.advanceTimersByTime(TICK_MS)
    // 0.51 and 1.01 went by during the stall: dropped, not played late.
    for (const s of host.ctx.sources) expect(s.when!).toBeGreaterThanOrEqual(s.scheduledAt)
    expect(clickTimes(host.ctx).map(r6)).toEqual([0.01])
    run(host.ctx, 0.3)
    expect(clickTimes(host.ctx).map(r6)).toEqual([0.01, 1.51])
  })

  it('volume ramps its gain; switching off stops the queued clicks; on again resumes on the grid', () => {
    m.setBpm(120)
    m.setEnabled(true)
    host.play(0)
    run(host.ctx, 0.4)
    const [gain] = host.ctx.gains // the metronome's own gain, into the host's bus
    expect(gain!.outputs).toEqual([host.input])
    expect(gain!.gain.value).toBe(clickGain(DEFAULT_CLICK_VOLUME))
    m.setVolume(1)
    expect(gain!.gain.value).toBe(1)
    m.setEnabled(false)
    expect(clickTimes(host.ctx).map(r6)).toEqual([0.01])
    run(host.ctx, 0.5) // now ~0.9
    m.setEnabled(true)
    run(host.ctx, 0.3)
    expect(clickTimes(host.ctx).map(r6)).toEqual([0.01, 1.01])
  })
})

// ------------------------------------------------------------------------------------------------ the real player

describe('metronome on the real DualPlayer (playerInstance wiring)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('AudioContext', FakeContext)
  })
  afterEach(() => {
    player.clear()
    useMetronome.getState().setOn(false)
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('locks the clicks to playback through play, A/B, seek, loop, a new render and stop', async () => {
    const sr = 48_000
    const bufferOf = (seconds: number) => new FakeBuffer(1, Math.round(seconds * sr), sr) as unknown as AudioBuffer
    player.setBuffers({ wet: bufferOf(8), dry: bufferOf(8) }) // 4 bars at 120
    useStudio.setState({ render: { bpm: 120 } as RenderInfo })
    const ctx = player.monitorBus()!.ctx as unknown as FakeContext
    useMetronome.getState().setOn(true)
    expect(metronome.enabled).toBe(true)

    await player.play()
    const program = () => ctx.sources.filter((s) => s.buffer?.length !== CLICK_FRAMES)
    const t0 = program().at(-1)!.when!
    run(ctx, 1)
    expect(clickTimes(ctx).map(r6)).toEqual([t0, t0 + 0.5, t0 + 1].map(r6))

    // A/B: the click carries on untouched.
    const count = ctx.sources.length
    player.setSide('dry')
    expect(ctx.sources.length).toBe(count)
    expect(ctx.sources.some((s) => s.buffer?.length === CLICK_FRAMES && s.stopped)).toBe(false)

    // Seek: the clicks follow the program sources' new start.
    player.seek(3.3)
    const seekStart = program().at(-1)!
    expect(seekStart.offset).toBeCloseTo(3.3, 9)
    run(ctx, 0.5)
    const afterSeek = clickTimes(ctx).filter((t) => t >= seekStart.when!)
    expect(afterSeek[0]).toBeCloseTo(seekStart.when! + 0.2, 9)

    // Loop on: sources restart looping the whole file; the downbeat lands exactly on the wrap.
    player.setLoop(true)
    const loopStart = program().at(-1)!
    expect(loopStart.loop).toBe(true)
    run(ctx, 8.5)
    const wrapAt = loopStart.when! + (8 - loopStart.offset)
    expect(clickTimes(ctx).some((t) => Math.abs(t - wrapAt) < 1e-9)).toBe(true)
    const nearWrap = clickTimes(ctx).filter((t) => Math.abs(t - wrapAt) < 0.1)
    expect(nearWrap).toHaveLength(1)

    // A new render at 140 BPM: the player swaps buffers in place, then the studio gets the RenderInfo.
    const beat = 60 / 140
    player.setBuffers({ wet: bufferOf(16 * beat), dry: bufferOf(16 * beat) })
    useStudio.setState({ render: { bpm: 140 } as RenderInfo })
    const swap = program().at(-1)!
    run(ctx, 1.5)
    const afterSwap = clickTimes(ctx).filter((t) => t >= swap.when!)
    expect(afterSwap.length).toBeGreaterThan(2)
    for (const t of afterSwap) {
      const at = swap.offset + (t - swap.when!)
      expect(Math.abs(at / beat - Math.round(at / beat))).toBeLessThan(1e-6)
    }

    // Stop: nothing left queued.
    player.stop()
    const now = ctx.currentTime
    expect(clickTimes(ctx).filter((t) => t > now)).toEqual([])
    run(ctx, 1)
    expect(clickTimes(ctx).filter((t) => t > now)).toEqual([])
  })

  it('goes out on the monitor bus beside the analyser (meters show the voice alone) and follows the switch live', async () => {
    const sr = 48_000
    player.setBuffers({ wet: new FakeBuffer(1, 8 * sr, sr) as unknown as AudioBuffer })
    useStudio.setState({ render: { bpm: 120 } as RenderInfo })
    const bus = player.monitorBus()!
    const ctx = bus.ctx as unknown as FakeContext
    ctx.sources = [] // the context is shared with the previous test
    await player.play()
    run(ctx, 0.5)
    expect(clickTimes(ctx)).toEqual([]) // switched off
    useMetronome.getState().setOn(true)
    run(ctx, 0.2)
    const clicks = ctx.sources.filter((s) => s.buffer?.length === CLICK_FRAMES)
    expect(clicks.length).toBeGreaterThan(0)
    // click → the metronome's gain → the monitor bus → the output; the analyser only hears the master.
    const monitor = bus.input as unknown as FakeNode
    const clickGainNode = clicks[0]!.outputs[0] as FakeNode
    expect(clickGainNode.outputs).toEqual([monitor])
    expect(monitor.outputs).toEqual([ctx.destination])
    expect(ctx.analysers).toHaveLength(1)
    expect(ctx.gains.filter((g) => g.outputs.includes(ctx.analysers[0]!))).toHaveLength(1) // the master, only
    useMetronome.getState().setOn(false)
    expect(clickTimes(ctx).filter((t) => t > ctx.currentTime)).toEqual([])
  })
})

// ------------------------------------------------------------------------------------------------ shortcut + prefs

const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})
const press = (target: EventTarget, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key: 'm', bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(e)
  return e
}

describe('metronome shortcut (M)', () => {
  beforeEach(() => {
    useUi.setState({ booting: false })
    useStudio.setState({ typing: false })
    useMetronome.getState().setOn(false)
    document.body.innerHTML = ''
  })

  it('maps M, and pauses it while typing like every single-key shortcut', () => {
    expect(matchShortcut(key('m'), false)).toBe('toggle-metronome')
    expect(matchShortcut(key('M', { shiftKey: true }), false)).toBe('toggle-metronome')
    expect(matchShortcut(key('m'), true)).toBeNull()
    expect(matchShortcut(key('m', { metaKey: true }), false)).toBeNull()
    expect(matchShortcut(key('m', { altKey: true }), false)).toBeNull()
    expect(SHORTCUTS.find((s) => s.keys === 'M')?.label).toMatch(/metronome/i)
  })

  it('toggles the click from anywhere (the listener playerInstance installs), and App then leaves the key alone', () => {
    const e = press(document.body)
    expect(e.defaultPrevented).toBe(true)
    expect(useMetronome.getState().on).toBe(true)
    expect(metronome.enabled).toBe(true)
    press(document.body, { key: 'M', shiftKey: true })
    expect(useMetronome.getState().on).toBe(false)
  })

  it('does nothing while typing, in a dialog, during the boot intro, or on key repeat', () => {
    document.body.innerHTML = '<input type="text" /><div contenteditable="true"></div>'
    expect(press(document.querySelector('input')!).defaultPrevented).toBe(false)
    useStudio.setState({ typing: true })
    press(document.body)
    useStudio.setState({ typing: false })
    document.body.innerHTML = '<dialog open></dialog>'
    press(document.body)
    document.body.innerHTML = ''
    useUi.setState({ booting: true })
    press(document.body)
    useUi.setState({ booting: false })
    press(document.body, { repeat: true })
    expect(useMetronome.getState().on).toBe(false)
  })

  it('can be removed', () => {
    const target = Object.assign(new EventTarget(), { document }) as unknown as Window
    const remove = installMetronomeShortcut(target)
    press(target)
    expect(useMetronome.getState().on).toBe(true)
    remove()
    press(target)
    expect(useMetronome.getState().on).toBe(true)
  })
})

describe('metronome prefs (per viewer)', () => {
  beforeEach(() => {
    useMetronome.setState({ on: false, volume: DEFAULT_CLICK_VOLUME })
    window.localStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    useMetronome.setState({ on: false, volume: DEFAULT_CLICK_VOLUME })
  })

  it('parses stored prefs defensively', () => {
    expect(parseMetronomePrefs(null)).toEqual({ on: false, volume: DEFAULT_CLICK_VOLUME })
    expect(parseMetronomePrefs('{"on":true,"volume":0.8}')).toEqual({ on: true, volume: 0.8 })
    expect(parseMetronomePrefs('{"on":"yes","volume":7}')).toEqual({ on: false, volume: 1 })
    expect(parseMetronomePrefs('{"volume":null}')).toEqual({ on: false, volume: DEFAULT_CLICK_VOLUME })
    expect(parseMetronomePrefs('not json')).toEqual({ on: false, volume: DEFAULT_CLICK_VOLUME })
  })

  it('persists the switch and the level, clamped', () => {
    useMetronome.getState().setOn(true)
    useMetronome.getState().setVolume(1.7)
    expect(useMetronome.getState().volume).toBe(1)
    expect(parseMetronomePrefs(window.localStorage.getItem(METRONOME_KEY))).toEqual({ on: true, volume: 1 })
    useMetronome.getState().setVolume(0.3)
    expect(parseMetronomePrefs(window.localStorage.getItem(METRONOME_KEY))).toEqual({ on: true, volume: 0.3 })
  })

  it('still works when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => useMetronome.getState().toggle()).not.toThrow()
    expect(useMetronome.getState().on).toBe(true)
  })
})
