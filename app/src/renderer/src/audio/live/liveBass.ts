/**
 * LIVE INPUT bass line (1.5): AudioFrame.bass and feel from the approximator (the fvwks-stems worklet's < 150 Hz level,
 * raw sub, growl and 30-600 Hz levels, and the sub's f0), frame by frame: the rolling cousin of fx/bassline.py.
 *   on / noteOn    the < 150 Hz level within 18 dB of its running peak for 80 ms (a kick's blip isn't a note; a
 *                  sidechain pump doesn't retrigger); a note starts where it came on
 *   heldBeats      since the note started; expectBeats: the median of the last 8 notes (1 until one has ended)
 *   pitch / glide  the sub's f0; a slide moves 3-60 semitones a second over ~130 ms, once the note has settled (150 ms)
 *   wobble         4x a second, the growl envelope's autocorrelation over the last 2 bars at the beat divisions (1/4T
 *                  to 1/16T, >= 0.35, growl-heavy only); the phase is 0 at the LFO's peak
 *   feel           style by the offline rules over the last ~8 bars (trap: a pitched sub that slides; dubstep: growl
 *                  with a wobble or stabs; deep: sub notes 1.5+ beats); halfTime stays false live (it needs the
 *                  downbeat, TRACK has it)
 * ponytail: live there's no bass stem, so growl is the mix's 100-600 Hz (pads and vocals count) and a legato 808
 * pattern reads as one long note; TRACK's precomputed bass line (bassline.py on the stem) is the precise one.
 */
import type { AudioFrame, BassLine } from '@/visuals/live/registry'
import { DIVISIONS } from './stems'

export interface LiveBassRaw {
  /** linear RMS: < 60 Hz, 100-600 Hz, 30-600 Hz */
  sub: number
  growl: number
  total: number
  /** the sub's f0 in Hz, 0 = unpitched */
  f0: number
}

/** The growl envelope at 60 fps: the last `n` values of `history` (oldest first), the newest at audio time `t`. */
export interface GrowlHistory {
  history: Float32Array
  n: number
  t: number
}

const ON = 10 ** (-18 / 20)
const SUSTAIN_S = 0.08
const PEAK_HALF_S = 23 // running peaks halve in about 23 s (as the worklet's)
const FPS = 60
const frac = (x: number) => ((x % 1) + 1) % 1

export class LiveBass {
  private peak = 1e-6
  private noteStart: number | null = null
  private onSince: number | null = null
  private readonly notes: number[] = []
  private pitches: { t: number; m: number }[] = []
  private wobble: { div: string | null; anchor: number; period: number } = { div: null, anchor: 0, period: 1 }
  private nextWobble = 0
  private readonly mix = { sub: 0, growl: 0, pitched: 0, glide: 0 }
  private prevT: number | null = null

  /** `low`: the approximator's bass level (stems.bass.rms, 0..1 against its running peak). */
  update(t: number, bpm: number, low: number, raw: LiveBassRaw, growl?: GrowlHistory): { bass: BassLine; feel: NonNullable<AudioFrame['feel']> } {
    const beat = 60 / Math.max(40, bpm || 120)
    const dt = this.prevT == null ? 0 : Math.min(0.1, Math.max(0, t - this.prevT))
    this.prevT = t
    // sub and growl against the bass's running peak (one scale, so they compare: a faint growl stays faint)
    this.peak = Math.max(raw.total, this.peak * 0.5 ** (dt / PEAK_HALF_S))
    const sub = Math.min(1, raw.sub / this.peak)
    const gr = Math.min(1, raw.growl / this.peak)
    if (low >= ON && raw.total > 1e-4) this.onSince ??= t
    else this.onSince = null
    const on = this.onSince != null && t - this.onSince >= SUSTAIN_S

    // notes
    const noteOn = on && this.noteStart == null
    if (this.noteStart != null && !on) {
      this.notes.push((t - this.noteStart) / beat)
      if (this.notes.length > 8) this.notes.shift()
      this.noteStart = null
    }
    if (noteOn) this.noteStart = this.onSince
    const held = on && this.noteStart != null ? t - this.noteStart : 0
    const sorted = [...this.notes].sort((a, b) => a - b)
    const expectBeats = sorted.length ? sorted[sorted.length >> 1]! : 1

    // pitch and slides
    const midi = raw.f0 > 0 ? 69 + 12 * Math.log2(raw.f0 / 440) : 0
    this.pitches.push({ t, m: midi })
    while (this.pitches.length && this.pitches[0]!.t < t - 0.2) this.pitches.shift()
    let glide = 0
    const from = this.pitches.find((x) => x.t >= t - 0.14)
    if (on && held >= 0.15 && midi && from?.m && t - from.t > 0.05) {
      const perS = (midi - from.m) / (t - from.t)
      if (Math.abs(perS) >= 3 && Math.abs(perS) <= 60) glide = perS * beat
    }

    // the mix over the last ~8 bars (on frames): sub vs growl, pitched, sliding
    if (on) {
      const k = 1 - Math.exp(-dt / (32 * beat))
      const m = this.mix
      m.sub += k * (sub - m.sub)
      m.growl += k * (gr - m.growl)
      m.pitched += k * ((midi ? 1 : 0) - m.pitched)
      m.glide += k * ((glide ? 1 : 0) - m.glide)
    }

    // the wobble, 4x a second
    if (t >= this.nextWobble) {
      this.nextWobble = t + 0.25
      this.wobble = growl && this.mix.growl >= 0.8 * this.mix.sub ? findWobble(growl, beat) : { div: null, anchor: 0, period: 1 }
    }
    const w = this.wobble

    const m = this.mix
    const style =
      m.pitched >= 0.5 && m.glide >= 0.03
        ? 'trap'
        : m.growl > 1.2 * m.sub && (w.div || expectBeats <= 0.5)
          ? 'dubstep'
          : m.sub > 1.5 * m.growl && expectBeats >= 1.5
            ? 'deep'
            : 'other'
    return {
      bass: {
        on,
        noteOn,
        heldBeats: held / beat,
        expectBeats,
        sub,
        growl: gr,
        pitch: raw.f0 > 0 ? raw.f0 : null,
        glide,
        wobble: { div: w.div, phase: w.div ? frac((t - w.anchor) / w.period) : 0 },
      },
      feel: { halfTime: false, style },
    }
  }
}

/** The growl envelope's dominant LFO over the last 2 bars, as a beat division (autocorrelation >= 0.35), and the time
 * of an LFO peak. */
export function findWobble(g: GrowlHistory, beat: number): { div: string | null; anchor: number; period: number } {
  const none = { div: null, anchor: 0, period: 1 }
  const L = Math.round(8 * beat * FPS)
  if (g.n < L || L < 8) return none
  const x = g.history.subarray(g.history.length - L)
  // detrend: minus a 2-beat moving average
  const half = Math.max(1, Math.round(beat * FPS))
  const c = new Float64Array(L + 1)
  for (let i = 0; i < L; i++) c[i + 1] = c[i]! + x[i]!
  const d = new Float64Array(L)
  for (let i = 0; i < L; i++) {
    const a = Math.max(0, i - half)
    const b = Math.min(L, i + half + 1)
    d[i] = x[i]! - (c[b]! - c[a]!) / (b - a)
  }
  const ac = (lag: number) => {
    let s = 0
    for (let i = 0; i + lag < L; i++) s += d[i]! * d[i + lag]!
    return s
  }
  const e0 = ac(0)
  if (e0 <= 1e-12) return none
  let best: string | null = null
  let score = 0
  for (const [div, beats] of Object.entries(DIVISIONS)) {
    const lag = beats * beat * FPS
    const lo = Math.floor(lag)
    const v = (ac(lo) + (lag - lo) * (ac(lo + 1) - ac(lo))) / e0
    if (v > score) [best, score] = [div, v]
  }
  if (!best || score < 0.35) return none
  const period = DIVISIONS[best]! * beat
  // the LFO's peak: the envelope's circular mean over the period
  let [cs, sn] = [0, 0]
  for (let i = 0; i < L; i++) {
    const a = 2 * Math.PI * frac((g.t - (L - 1 - i) / FPS) / period)
    cs += d[i]! * Math.cos(a)
    sn += d[i]! * Math.sin(a)
  }
  return { div: best, anchor: frac(Math.atan2(sn, cs) / (2 * Math.PI)) * period, period }
}
