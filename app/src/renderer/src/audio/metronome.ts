/**
 * The preview metronome: a click on every beat of the render's bar grid, layered over playback. Preview only: it
 * lives on the Web Audio playback path (the player's monitor bus) and never reaches the engine, a render or an
 * export.
 *
 * The grid is the one BarGrid draws: it starts at the file start and is bar-exact, so beat k sits at k·60/BPM s of
 * the render and every 4th beat is a downbeat (a higher, louder click).
 *
 * Timing is a lookahead scheduler. Every TICK_MS it schedules the clicks that fall in the next LOOKAHEAD_S of
 * AudioContext time, each an AudioBufferSourceNode started at its exact context time, so a click lands on its
 * sample however late the timer fires. Click times come from the player's own timeline (the context time its
 * sources started, the file offset they started from, the loop region), the maths of DualPlayer.currentTime, so
 * the clicks wrap with the gapless loop. Every transport change (play, pause, seek, loop, a new render) restarts
 * the player's sources under a new epoch; the scheduler then drops the clicks it had queued for the old timeline
 * and schedules afresh, at the tempo of the render now playing. A/B only moves the side gains: the click carries on.
 */
import { BEATS_PER_BAR } from './grid'

/** How far ahead clicks are scheduled (seconds of AudioContext time), and how often the scheduler wakes. */
export const LOOKAHEAD_S = 0.15
/** A hidden window's timers may fire only about once a second (browser build): schedule further ahead then. */
export const HIDDEN_LOOKAHEAD_S = 1.5
export const TICK_MS = 25
/** A beat this close to the loop end (or the file end) coincides with the wrap (or the end): no click there. */
export const EDGE_S = 0.001
/** A beat this close before the start offset (floating point) still counts as on it. */
const ON_TOL = 1e-6
/** Safety cap on the clicks per window. */
const MAX_CLICKS = 1024

/** Fader position 0..1; the default is modest under a club-loud master. */
export const DEFAULT_CLICK_VOLUME = 0.5
/** Length of one click (s). */
export const CLICK_S = 0.06

interface Tone {
  freq: number
  amp: number
}
/** Downbeat: A6, near full scale before the volume. Other beats: E6, about 5 dB down. */
export const DOWNBEAT_TONE: Tone = { freq: 1760, amp: 0.9 }
export const BEAT_TONE: Tone = { freq: 1320, amp: 0.5 }

/** Fader position (0..1) to gain: a squared taper, so the low half of the fader is usable. */
export function clickGain(volume: number): number {
  const v = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : DEFAULT_CLICK_VOLUME
  return v * v
}

/** The player's timeline plus the tempo: everything the click times depend on. */
export interface ClickTimeline {
  bpm: number
  /** AudioContext time at which playback started, at file position `offset`. */
  startedAt: number
  offset: number
  /** File length (s): playback ends there unless it loops. */
  duration: number
  /** Loop region [start, end) in seconds while looping, else null. */
  loop: readonly [number, number] | null
  beatsPerBar?: number
}

export interface Click {
  /** AudioContext time of the click. */
  when: number
  /** Position in the file (s). */
  at: number
  /** Beat index from the file start (0 = the first downbeat). */
  beat: number
  downbeat: boolean
}

/**
 * The clicks whose AudioContext time falls in [from, to), in order. Pure. Consecutive windows partition the
 * clicks exactly (each click's time is computed the same way whichever window asks), so a scheduler that asks for
 * [a, b) then [b, c) never doubles or drops one.
 *
 * The file position at context time t is raw = offset + (t - startedAt), straight on up to the loop end (or the
 * file end); when looping, raw ≥ loopEnd wraps into [loopStart, loopEnd) as in DualPlayer.currentTime.
 */
export function clicksBetween(tl: ClickTimeline, from: number, to: number): Click[] {
  const out: Click[] = []
  const { bpm, startedAt, offset, duration } = tl
  if (!(bpm > 0) || !Number.isFinite(bpm) || !(duration > 0) || !(to > from)) return out
  if (!Number.isFinite(startedAt) || !Number.isFinite(offset) || !Number.isFinite(from) || !Number.isFinite(to)) return out
  const beat = 60 / bpm
  const perBar = Math.max(1, Math.round(tl.beatsPerBar ?? BEATS_PER_BAR))
  const add = (when: number, k: number) => out.push({ when, at: k * beat, beat: k, downbeat: k % perBar === 0 })
  const loop = tl.loop && tl.loop[1] - tl.loop[0] >= 0.001 ? tl.loop : null

  // 1. The straight run: from the start offset to the loop end (or the file end).
  const runEnd = loop ? loop[1] : duration
  if (offset < runEnd) {
    const first = offset + Math.max(0, from - startedAt)
    for (let k = Math.max(0, Math.floor(first / beat) - 1); out.length < MAX_CLICKS; k++) {
      const t = k * beat
      if (t >= runEnd - EDGE_S) break
      const when = startedAt + (t - offset)
      if (when >= to) break
      if (t >= offset - ON_TOL && when >= from) add(when, k)
    }
  }
  if (!loop) return out

  // 2. Loop passes: pass n plays [s, e) from raw = e + n·L, i.e. from context time startedAt + (e + n·L - offset).
  const [s, e] = loop
  const span = e - s
  const kFirst = Math.max(0, Math.ceil((s - ON_TOL) / beat))
  const rawFrom = offset + Math.max(0, from - startedAt)
  for (let n = Math.max(0, Math.floor((rawFrom - e) / span) - 1); out.length < MAX_CLICKS; n++) {
    const passRaw = e + n * span
    const passAt = startedAt + (passRaw - offset)
    if (passAt >= to) break
    const p = s + Math.max(0, from - passAt)
    for (let k = Math.max(kFirst, Math.floor(p / beat) - 1); out.length < MAX_CLICKS; k++) {
      const t = k * beat
      if (t >= e - EDGE_S) break
      const when = passAt + (t - s)
      if (when >= to) break
      // Past the window start, and not before the start offset (a first pass entered mid-way).
      if (when >= from && passRaw + (t - s) >= offset - ON_TOL) add(when, k)
    }
  }
  return out
}

/** One click: a sine blip (0.5 ms attack, ~9 ms decay) with a touch of its octave, faded to zero at the end. */
export function blipSamples(sampleRate: number, tone: Tone): Float32Array<ArrayBuffer> {
  const n = Math.max(1, Math.round(CLICK_S * sampleRate))
  const out = new Float32Array(n)
  const attack = 0.0005 * sampleRate
  const decay = 0.009 * sampleRate
  const fade = 0.004 * sampleRate
  const w = (2 * Math.PI * tone.freq) / sampleRate
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / attack) * Math.exp(-i / decay) * Math.min(1, (n - 1 - i) / fade)
    out[i] = tone.amp * env * (0.85 * Math.sin(w * i) + 0.15 * Math.sin(2 * w * i))
  }
  return out
}

function blipBuffer(ctx: BaseAudioContext, tone: Tone): AudioBuffer {
  const samples = blipSamples(ctx.sampleRate, tone)
  const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate)
  buffer.copyToChannel(samples, 0)
  return buffer
}

/** What the metronome needs from the player (DualPlayer implements it). */
export interface MetronomeHost {
  timeline(): {
    epoch: number
    playing: boolean
    startedAt: number
    offset: number
    duration: number
    loop: readonly [number, number] | null
  }
  /** The context and node the clicks go to; null before playback has created the context. */
  monitorBus(): { ctx: BaseAudioContext; input: AudioNode } | null
  /** Called on every transport change. */
  subscribe(listener: () => void): () => void
}

interface Bus {
  ctx: BaseAudioContext
  input: AudioNode
  gain: GainNode
  downbeat: AudioBuffer
  beat: AudioBuffer
}

export class Metronome {
  private on = false
  private bpm = 0
  private level: number
  /** Identity of the timeline (and tempo) the queued clicks belong to; null while silent. */
  private key: string | null = null
  /** Context time up to which clicks are scheduled. */
  private horizon = -Infinity
  private queued: { src: AudioBufferSourceNode; when: number }[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private bus: Bus | null = null
  private readonly unsubscribe: () => void

  constructor(
    private readonly host: MetronomeHost,
    volume = DEFAULT_CLICK_VOLUME,
  ) {
    this.level = clickGain(volume)
    this.unsubscribe = host.subscribe(() => this.sync())
  }

  get enabled(): boolean {
    return this.on
  }

  setEnabled(on: boolean): void {
    if (on === this.on) return
    this.on = on
    this.sync()
  }

  /** Tempo of the render being played (RenderInfo.bpm); null or nonsense means no clicks. */
  setBpm(bpm: number | null | undefined): void {
    const next = typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0 ? bpm : 0
    if (next === this.bpm) return
    this.bpm = next
    this.sync()
  }

  /** Fader position 0..1; takes effect at once, clicks already queued included (a short ramp, no zipper). */
  setVolume(volume: number): void {
    this.level = clickGain(volume)
    if (this.bus) this.bus.gain.gain.setTargetAtTime(this.level, this.bus.ctx.currentTime, 0.015)
  }

  /**
   * Re-reads the transport. When the timeline (or the tempo) changed, drops the clicks queued for the old one;
   * then schedules the next window. The timer calls this every TICK_MS while clicks are due.
   */
  sync(): void {
    const tl = this.host.timeline()
    const live = this.on && this.bpm > 0 && tl.playing && tl.duration > 0
    const key = live ? [tl.epoch, tl.startedAt, tl.offset, tl.duration, tl.loop ? tl.loop.join('~') : '-', this.bpm].join('|') : null
    if (key !== this.key) {
      this.cancel()
      this.key = key
      this.horizon = -Infinity
    }
    if (key == null) {
      this.stopTimer()
      return
    }
    this.timer ??= setInterval(() => this.sync(), TICK_MS)
    const bus = this.output()
    if (!bus) return
    const now = bus.ctx.currentTime
    const hidden = typeof document !== 'undefined' && document.hidden
    const to = now + (hidden ? HIDDEN_LOOKAHEAD_S : LOOKAHEAD_S)
    // Never into the past: after a stall, clicks already due are skipped rather than played late.
    const from = Math.max(this.horizon, now)
    if (to > from) {
      for (const c of clicksBetween({ ...tl, bpm: this.bpm }, from, to)) {
        const src = bus.ctx.createBufferSource()
        src.buffer = c.downbeat ? bus.downbeat : bus.beat
        src.connect(bus.gain)
        src.start(c.when)
        this.queued.push({ src, when: c.when })
      }
      this.horizon = to
    }
    // Forget clicks that have played out (a finished source node is collected on its own).
    const done = now - CLICK_S
    if (this.queued.length && this.queued[0]!.when < done) this.queued = this.queued.filter((q) => q.when >= done)
  }

  /** Clicks queued and not yet started (for tests and diagnostics). */
  pending(): number {
    const now = this.bus?.ctx.currentTime ?? -Infinity
    return this.queued.filter((q) => q.when > now).length
  }

  dispose(): void {
    this.unsubscribe()
    this.on = false
    this.cancel()
    this.stopTimer()
    this.key = null
    this.bus?.gain.disconnect()
    this.bus = null
  }

  /** Stops the clicks queued for later; one already sounding rings out (it is a few ms long). */
  private cancel(): void {
    const now = this.bus?.ctx.currentTime ?? -Infinity
    for (const q of this.queued) {
      if (q.when <= now) continue
      try {
        q.src.stop()
      } catch {
        // already stopped
      }
      q.src.disconnect()
    }
    this.queued = []
  }

  private stopTimer(): void {
    if (this.timer != null) clearInterval(this.timer)
    this.timer = null
  }

  /** The metronome's own gain on the host's monitor bus, and the two click buffers, per AudioContext. */
  private output(): Bus | null {
    const out = this.host.monitorBus()
    if (!out) return null
    if (this.bus && this.bus.ctx === out.ctx && this.bus.input === out.input) return this.bus
    this.bus?.gain.disconnect()
    const gain = out.ctx.createGain()
    gain.gain.value = this.level
    gain.connect(out.input)
    this.bus = { ctx: out.ctx, input: out.input, gain, downbeat: blipBuffer(out.ctx, DOWNBEAT_TONE), beat: blipBuffer(out.ctx, BEAT_TONE) }
    return this.bus
  }
}
