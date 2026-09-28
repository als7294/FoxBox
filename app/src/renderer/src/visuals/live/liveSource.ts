/**
 * The LIVE page's AudioFrame source: the LiveBus mix and voice taps and, while it plays, the SongDeck (the song
 * alone, its beat clock and its drop). The mix fields are voice + song (bus.mix is after the master).
 *
 * `read()` reuses its fft / wave arrays: a style reads them in the frame it gets them. Onsets are the strongest since
 * the previous read (0 when none). The pure helpers below are shared with studioSource.
 */
import type { LiveBus } from '@/audio/live/bus'
import type { SongDeck } from '@/audio/live/songDeck'
import type { AudioFrame } from './registry'

export interface FrameSource {
  read(): AudioFrame
  dispose(): void
}

type Bands = AudioFrame['bands']

export function liveSource(bus: LiveBus, deck: SongDeck | null, getBpm: () => number): FrameSource {
  const db = new Float32Array(bus.mix.analyser.frequencyBinCount)
  const fft = new Uint8Array(512)
  const wave = new Uint8Array(1024)
  const peak = { mix: 0, voice: 0, song: 0 }
  const subs = [
    bus.mix.onOnset((e) => (peak.mix = Math.max(peak.mix, e.strength))),
    bus.voice.onOnset((e) => (peak.voice = Math.max(peak.voice, e.strength))),
    ...(deck ? [deck.tap.onOnset((e) => (peak.song = Math.max(peak.song, e.strength)))] : []),
  ]
  const take = (k: keyof typeof peak) => {
    const v = peak[k]
    peak[k] = 0
    return v
  }
  return {
    read(): AudioFrame {
      const ctx = bus.context
      const t = ctx.currentTime
      const an = bus.mix.analyser
      bytesFromDb(bus.mix.fft(db), fft, an.minDecibels, an.maxDecibels)
      an.getByteTimeDomainData(wave)
      const song = deck?.isPlaying ? deck : null
      const clock = song?.clock() ?? null
      const bpm = clock?.bpm ?? getBpm()
      const session = gridClock(t, bpm)
      const songOnset = take('song')
      return {
        time: t,
        rms: bus.mix.rms(),
        bands: bus.mix.bands(),
        onset: take('mix'),
        fft,
        waveL: wave,
        waveR: wave,
        sampleRate: ctx.sampleRate,
        bpm,
        beatPhase: clock?.beatPhase ?? session.beatPhase,
        active: ctx.state === 'running',
        voice: { rms: bus.voice.rms(), onset: take('voice') },
        song: song ? { rms: song.tap.rms(), onset: songOnset, bands: song.tap.bands() } : null,
        bar: clock?.bar ?? session.bar,
        barPhase: clock?.barPhase ?? session.barPhase,
        drop: song ? inDrop(song.positionS(t), song.dropAtS, song.grid?.barS ?? (4 * 60) / bpm) : false,
      }
    },
    dispose() {
      for (const unsubscribe of subs) unsubscribe()
    },
  }
}

// ------------------------------------------------------------------------------------------------ pure helpers

/** Bytes like getByteFrequencyData from a dB spectrum of any length: each output bin averages the power of its
 * source bins (1024 → 512 halves the resolution as fftSize 1024 would), mapped minDb..maxDb → 0..255. */
export function bytesFromDb(db: ArrayLike<number>, out: Uint8Array, minDb = -100, maxDb = -30): Uint8Array {
  const ratio = db.length / out.length
  for (let k = 0; k < out.length; k++) {
    const a = Math.floor(k * ratio)
    const b = Math.max(a + 1, Math.floor((k + 1) * ratio))
    let p = 0
    for (let i = a; i < b; i++) p += Math.pow(10, db[i]! / 10)
    const v = 10 * Math.log10(p / (b - a) + 1e-30)
    out[k] = Math.max(0, Math.min(255, Math.round(((v - minDb) / (maxDb - minDb)) * 255)))
  }
  return out
}

/** Bytes like getByteTimeDomainData (128 = silence) from float samples. */
export function waveBytes(samples: ArrayLike<number>, out: Uint8Array): Uint8Array {
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(128 + (samples[i] ?? 0) * 128)))
  return out
}

export function rmsOf(samples: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < samples.length; i++) s += samples[i]! * samples[i]!
  return samples.length ? Math.min(1, Math.sqrt(s / samples.length)) : 0
}

/** Band levels 0..1 (-90..-10 dB mapped, as LiveBus taps) from a byte spectrum over 0..sampleRate/2. */
export function bandsFromBytes(bins: ArrayLike<number>, sampleRate: number, minDb = -100, maxDb = -30): Bands {
  const hzPerBin = sampleRate / 2 / bins.length
  const acc = { low: [0, 0], mid: [0, 0], high: [0, 0] }
  for (let i = 1; i < bins.length; i++) {
    const hz = i * hzPerBin
    const band = hz < 250 ? acc.low : hz < 4000 ? acc.mid : hz < 16000 ? acc.high : null
    if (!band) continue
    band[0]! += Math.pow(10, (minDb + (bins[i]! / 255) * (maxDb - minDb)) / 20)
    band[1]! += 1
  }
  const level = (b: number[]) => Math.min(1, Math.max(0, (20 * Math.log10(Math.max(1e-9, b[0]! / Math.max(1, b[1]!))) + 90) / 80))
  return { low: level(acc.low), mid: level(acc.mid), high: level(acc.high) }
}

const frac = (v: number) => v - Math.floor(v)

/** Beat and bar position of time `t` (s) on a plain grid from t = 0. */
export function gridClock(t: number, bpm: number, beatsPerBar = 4): { beatPhase: number; bar: number; barPhase: number } {
  const beats = (t * bpm) / 60
  return { beatPhase: frac(beats), bar: Math.floor(beats / beatsPerBar) + 1, barPhase: frac(beats / beatsPerBar) }
}

/** At the drop: from the moment it lands, for one bar. */
export function inDrop(positionS: number, dropAtS: number | null | undefined, barS: number): boolean {
  return dropAtS != null && positionS >= dropAtS && positionS < dropAtS + barS
}

/** Onsets from successive spectra read once per frame: flux over an adaptive threshold (mean + 1.5 sd of the last
 * 50 frames), at most one per 80 ms; the strength (flux ÷ threshold) or 0. */
export class FluxOnset {
  private prev: Float32Array | null = null
  private hist: number[] = []
  private last = -1

  push(bins: ArrayLike<number>, t: number): number {
    const mag = new Float32Array(bins.length)
    for (let i = 0; i < bins.length; i++) mag[i] = bins[i]! / 255
    let out = 0
    if (this.prev) {
      let f = 0
      for (let i = 1; i < mag.length; i++) f += Math.max(0, mag[i]! - this.prev[i]!)
      const n = this.hist.length
      const mean = n ? this.hist.reduce((a, b) => a + b, 0) / n : f
      const sd = n ? Math.sqrt(this.hist.reduce((a, b) => a + (b - mean) ** 2, 0) / n) : 0
      const thr = mean + 1.5 * sd + 1e-4
      if (n >= 10 && f > thr && t - this.last > 0.08) {
        this.last = t
        out = f / thr
      }
      this.hist.push(f)
      if (this.hist.length > 50) this.hist.shift()
    }
    this.prev = mag
    return out
  }
}
