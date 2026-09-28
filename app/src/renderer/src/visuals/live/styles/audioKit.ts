/**
 * Pure helpers the FOXBOX styles share (no WebGL, so they're unit-tested): the onset envelope every style flares on,
 * frame-rate-independent easing, and the scope's Lissajous mapping.
 */
import type { AudioFrame } from '../registry'

/** `v` eased toward `target` over `tauMs` (exponential, the same at any frame rate). */
export function ease(v: number, target: number, dtMs: number, tauMs: number): number {
  return target + (v - target) * Math.exp(-Math.max(0, dtMs) / Math.max(1, tauMs))
}

/**
 * The onset envelope: jumps to the hit's strength (onset ≥ 1 is a hit; capped at 1.5), then decays over `tauMs`.
 * Under reduced motion a hit only reaches 40 % and decays twice as slowly, so nothing strobes. Silent when inactive.
 */
export function onsetEnvelope(v: number, a: Pick<AudioFrame, 'onset' | 'active'>, dtMs: number, tauMs: number, reduced: boolean): number {
  const hit = a.active && a.onset >= 1 ? Math.min(1.5, a.onset) * (reduced ? 0.4 : 1) : 0
  const next = v * Math.exp(-Math.max(0, dtMs) / (tauMs * (reduced ? 2 : 1)))
  return Math.max(next, hit)
}

/** The bands, eased (fast up, slower down) so bars and fields never twitch; zero when nothing is sounding. */
export function easeBands(s: { low: number; mid: number; high: number }, a: AudioFrame, dtMs: number): void {
  for (const k of ['low', 'mid', 'high'] as const) {
    const target = a.active ? a.bands[k] : 0
    s[k] = ease(s[k], target, dtMs, target > s[k] ? 40 : 260)
  }
}

/** True when the two channels carry the same samples (a mono source): the scope then plots a delayed copy for y. */
export function isMono(l: Uint8Array, r: Uint8Array | null): boolean {
  if (!r || r === l) return true
  const n = Math.min(l.length, r.length)
  for (let i = 0; i < n; i += 7) if (l[i] !== r[i]) return false
  return true
}

/**
 * The XY scope's points: x = left, y = right (−1…1), or for a mono source y = the same signal `delaySamples` earlier,
 * which draws a Lissajous figure of the sound against itself (a pure tone becomes an ellipse). A 5-tap smoothing hides
 * the byte waveform's steps. Writes x, y pairs into `out`; returns the number of points (0 without a waveform).
 */
export function lissajous(l: Uint8Array | null, r: Uint8Array | null, out: Float32Array, delaySamples: number): number {
  if (!l || l.length < 4) return 0
  const mono = isMono(l, r)
  const src = mono ? l : r!
  const d = mono ? Math.max(1, Math.min(l.length >> 1, Math.round(delaySamples))) : 0
  const n = Math.min(out.length >> 1, l.length - d, src.length)
  const at = (b: Uint8Array, i: number) => {
    const last = b.length - 1
    const s = b[Math.max(0, i - 2)]! + 4 * b[Math.max(0, i - 1)]! + 6 * b[i]! + 4 * b[Math.min(last, i + 1)]! + b[Math.min(last, i + 2)]!
    return s / 16 / 128 - 1
  }
  for (let i = 0; i < n; i++) {
    out[i * 2] = at(l, i + d)
    out[i * 2 + 1] = at(src, i)
  }
  return n
}

/** The Lissajous delay for a mono source: a quarter period of ~110 Hz (a kick's or a voice's fundamental draws round). */
export function monoDelay(sampleRate: number): number {
  return Math.round(sampleRate / 440)
}

/** The peak |value| of `n` xy points (the scope's auto-gain follows it). */
export function peakOf(xy: Float32Array, n: number): number {
  let p = 0
  for (let i = 0; i < n * 2; i++) p = Math.max(p, Math.abs(xy[i]!))
  return p
}

/**
 * The song-aware cues every style reads each frame (registry.ts's 1.3 fields; without a song they fall back to the
 * mix): a kick envelope (the song's onsets, else the mix's), the voice's own onset envelope, a new bar (the bar count
 * changing, or its phase wrapping) and the beat drop (its first frame, then an envelope that decays over ~a second).
 * Under reduced motion the envelopes stay low (onsetEnvelope) and the drop only reaches 40 %.
 */
export class Cues {
  kick = 0
  voice = 0
  drop = 0
  /** True on the first frame of a bar. */
  newBar = false
  /** True on the frame the drop lands. */
  dropStart = false
  private lastBar: number | null = null
  private lastPhase: number | null = null
  private wasDrop = false
  constructor(private readonly reduced: boolean) {}

  step(a: AudioFrame, dtMs: number): this {
    const kickOnset = a.song ? a.song.onset : a.onset
    this.kick = onsetEnvelope(this.kick, { onset: kickOnset, active: a.active }, dtMs, 180, this.reduced)
    this.voice = onsetEnvelope(this.voice, { onset: a.voice ? a.voice.onset : a.onset, active: a.active }, dtMs, 200, this.reduced)
    const bar = a.bar ?? null
    const phase = a.barPhase ?? null
    this.newBar =
      a.active &&
      ((bar != null && this.lastBar != null && bar !== this.lastBar) ||
        (bar == null && phase != null && this.lastPhase != null && phase < this.lastPhase - 0.5))
    this.lastBar = bar
    this.lastPhase = phase
    const drop = a.active && Boolean(a.drop)
    this.dropStart = drop && !this.wasDrop
    this.wasDrop = drop
    this.drop = this.dropStart ? (this.reduced ? 0.4 : 1) : this.drop * Math.exp(-Math.max(0, dtMs) / (this.reduced ? 1600 : 900))
    return this
  }
}

/** The song's bands when a song plays, else the mix's (what the backdrop of a voice-led style follows). */
export const songBands = (a: AudioFrame): { low: number; mid: number; high: number } => a.song?.bands ?? a.bands

/**
 * The byte spectrum folded into `out.length` log-spaced bands from 40 Hz to 16 kHz (0–1, each band's peak bin), eased
 * into `out` (fast up, slower down). Without a spectrum the bands sink toward `floor`.
 */
export function logBands(fft: Uint8Array | null, sampleRate: number, out: Float32Array, dtMs: number, floor = 0): Float32Array {
  const n = out.length
  const hz = sampleRate / 2 / Math.max(1, fft?.length ?? 512)
  for (let k = 0; k < n; k++) {
    let v = floor
    if (fft && fft.length) {
      const lo = (40 * Math.pow(400, k / n)) / hz
      const hi = (40 * Math.pow(400, (k + 1) / n)) / hz
      let m = 0
      if (hi - lo < 1) {
        // Narrower than a bin (the lows): read between bins at the band's centre, so neighbours don't all match.
        const c = Math.min(fft.length - 1.001, Math.max(1, (lo + hi) / 2))
        const i = Math.floor(c)
        m = fft[i]! + (fft[i + 1]! - fft[i]!) * (c - i)
      } else for (let b = Math.max(1, Math.floor(lo)); b <= Math.min(fft.length - 1, Math.floor(hi)); b++) m = Math.max(m, fft[b]!)
      v = Math.max(floor, m / 255)
    }
    out[k] = ease(out[k]!, v, dtMs, v > out[k]! ? 25 : 180)
  }
  return out
}

/** A tiny deterministic hash (0–1), for seeds that must be the same in every renderer. */
export function hash1(v: number): number {
  const s = Math.sin(v * 12.9898 + 78.233) * 43758.5453
  return s - Math.floor(s)
}
