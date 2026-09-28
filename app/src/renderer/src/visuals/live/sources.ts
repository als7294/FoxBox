/**
 * AudioFrame sources: where a style's sound comes from. The LIVE page reads S2's LiveBus (the masked mic), the Studio
 * reads the A/B player's analyser, and anything idle draws from silence. Each source is a function the stage calls
 * once per animation frame; it reuses its buffers, so a frame is only valid until the next call (the output window
 * gets a structured clone over its MessagePort, so that's fine).
 *
 * The maths (downsampling, bands from a byte spectrum, spectral-flux onsets, the onset decay, the beat phase) are the
 * pure exported helpers below, unit-tested without an AudioContext.
 */
import type { LiveBus } from '@/audio/live'
import { player } from '@/audio/playerInstance'
import { useStudio } from '@/state/studio'
import { silentFrame, type AudioFrame } from './registry'

/** An AudioFrame source; `dispose` drops any subscription it holds (the LiveBus's onset poll). */
export type AudioSource = (() => AudioFrame) & { dispose(): void }

/** The spectrum length every frame carries (fftSize 1024's bin count), whatever the analyser's size. */
export const FFT_BINS = 512
/** Waveform samples per channel. */
export const WAVE_SAMPLES = 1024
/** How long a LiveBus onset lingers in the frames after it (linear decay to 0). */
export const ONSET_DECAY_S = 0.15

const LOW_HZ = 250
const HIGH_HZ = 4000
const TOP_HZ = 16000

/**
 * `src` resampled to `out.length` bins: each output bin is the mean of the input bins it covers (so a 1024-bin
 * spectrum halves by pairs), or the nearest input bin when stretching.
 */
export function downsample(src: ArrayLike<number>, out: Uint8Array): Uint8Array {
  const n = out.length
  const m = src.length
  if (!m) return out.fill(0)
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * m) / n)
    const b = Math.max(a + 1, Math.floor(((i + 1) * m) / n))
    let s = 0
    for (let j = a; j < b; j++) s += src[j]!
    out[i] = Math.round(s / (b - a))
  }
  return out
}

/**
 * Band levels 0–1 from a byte spectrum of any length (the mean bin level in each: < 250 Hz, 250 Hz–4 kHz, > 4 kHz up
 * to 16 kHz, as LiveBus.bands() stops there too). `fft` covers 0 Hz to Nyquist, so a bin is sampleRate / (2 ×
 * fft.length) wide; bin 0 (DC) is skipped.
 */
export function bandsOf(fft: Uint8Array, sampleRate: number): { low: number; mid: number; high: number } {
  const hz = sampleRate / 2 / Math.max(1, fft.length)
  const acc = [0, 0, 0]
  const cnt = [0, 0, 0]
  for (let i = 1; i < fft.length; i++) {
    const f = i * hz
    const k = f < LOW_HZ ? 0 : f < HIGH_HZ ? 1 : f < TOP_HZ ? 2 : -1
    if (k < 0) break
    acc[k]! += fft[i]!
    cnt[k]! += 1
  }
  const level = (k: number) => (cnt[k] ? acc[k]! / cnt[k]! / 255 : 0)
  return { low: level(0), mid: level(1), high: level(2) }
}

/** Spectral flux between two byte spectra: the mean rise per bin, 0–1 (falls count for nothing). */
export function spectralFlux(prev: Uint8Array, cur: Uint8Array): number {
  const n = Math.min(prev.length, cur.length)
  if (!n) return 0
  let f = 0
  for (let i = 1; i < n; i++) {
    const d = cur[i]! - prev[i]!
    if (d > 0) f += d
  }
  return f / (n - 1) / 255
}

/**
 * A spectral-flux onset detector like S2's (flux over mean + 1.5 σ of the last 50, at least 80 ms apart): feed it one
 * spectrum per frame with its time; it returns the hit's strength (flux ÷ threshold, ≥ 1) or 0.
 */
export function fluxOnsetDetector(): (fft: Uint8Array, time: number) => number {
  let prev: Uint8Array | null = null
  const hist: number[] = []
  let last = -Infinity
  return (fft, time) => {
    if (!prev || prev.length !== fft.length) {
      prev = new Uint8Array(fft)
      return 0
    }
    const f = spectralFlux(prev, fft)
    prev.set(fft)
    const mean = hist.length ? hist.reduce((a, b) => a + b, 0) / hist.length : f
    const sd = hist.length ? Math.sqrt(hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length) : 0
    const thr = mean + 1.5 * sd + 1e-3
    let hit = 0
    if (hist.length >= 10 && f > thr && time - last > 0.08) {
      last = time
      hit = f / thr
    }
    hist.push(f)
    if (hist.length > 50) hist.shift()
    return hit
  }
}

/** An onset's strength `age` seconds after it: linear to 0 over ONSET_DECAY_S (0 before it happened). */
export function decayOnset(strength: number, age: number): number {
  if (age < 0 || age >= ONSET_DECAY_S) return 0
  return strength * (1 - age / ONSET_DECAY_S)
}

/** Where `time` sits in the beat at `bpm`, 0–1. */
export function beatPhase(time: number, bpm: number): number {
  if (!(bpm > 0)) return 0
  const b = (time * bpm) / 60
  return b - Math.floor(b)
}

/** Float samples (−1…1) as bytes like getByteTimeDomainData (128 = silence). */
export function floatToByteWave(src: Float32Array, out: Uint8Array): Uint8Array {
  const n = Math.min(src.length, out.length)
  for (let i = 0; i < n; i++) out[i] = Math.max(0, Math.min(255, Math.round(128 + src[i]! * 128)))
  out.fill(128, n)
  return out
}

/** The LIVE mask's output (S2's LiveBus): its bands, RMS and onsets, the output analyser's spectrum and waveform. */
export function liveBusSource(bus: LiveBus, getBpm: () => number): AudioSource {
  const raw = new Uint8Array(bus.analyser.frequencyBinCount)
  const fft = new Uint8Array(FFT_BINS)
  const wave = new Uint8Array(Math.min(WAVE_SAMPLES, bus.analyser.fftSize))
  let hit = { strength: 0, time: -Infinity }
  const off = bus.onOnset((e) => (hit = { strength: e.strength, time: e.time }))
  const next = (): AudioFrame => {
    const time = bus.context.currentTime
    const bpm = getBpm()
    bus.analyser.getByteFrequencyData(raw)
    bus.analyser.getByteTimeDomainData(wave)
    const rms = bus.rms()
    const onset = decayOnset(hit.strength, time - hit.time)
    return {
      time,
      rms,
      bands: bus.bands(),
      onset,
      fft: downsample(raw, fft),
      waveL: wave,
      waveR: wave,
      sampleRate: bus.context.sampleRate,
      bpm,
      beatPhase: beatPhase(time, bpm),
      active: bus.context.state === 'running',
      // The mask's output is the voice alone.
      voice: { rms, onset },
      song: null,
    }
  }
  return Object.assign(next, { dispose: off })
}

/**
 * The Studio's A/B player (its analyser, after the master gain): time is the playback position, so the beat phase
 * lines up with the render's grid; the tempo is the render's, else the Studio's BPM. What plays is the voice alone,
 * so `voice` repeats the mix's level and onset and `song` is null.
 */
export function playerSource(): AudioSource {
  const fft = new Uint8Array(FFT_BINS)
  const floats = new Float32Array(WAVE_SAMPLES)
  const wave = new Uint8Array(WAVE_SAMPLES)
  const detect = fluxOnsetDetector()
  let hit = { strength: 0, time: -Infinity }
  const next = (): AudioFrame => {
    const s = useStudio.getState()
    const bpm = s.render?.bpm ?? s.bpm
    const active = player.isPlaying
    const time = player.currentTime
    const sampleRate = player.sampleRate
    const hasFft = player.readBins(fft)
    const hasWave = player.readTimeDomain(floats)
    if (!hasFft) fft.fill(0)
    if (!hasWave) floats.fill(0)
    let sum = 0
    for (let i = 0; i < floats.length; i++) sum += floats[i]! * floats[i]!
    // The onset clock is wall time: the playback position jumps on a seek or a loop.
    const now = performance.now() / 1000
    const strength = active ? detect(fft, now) : 0
    if (strength) hit = { strength, time: now }
    const rms = Math.min(1, Math.sqrt(sum / floats.length))
    const onset = decayOnset(hit.strength, now - hit.time)
    return {
      time,
      rms,
      bands: bandsOf(fft, sampleRate),
      onset,
      fft: hasFft ? fft : null,
      waveL: hasWave ? floatToByteWave(floats, wave) : null,
      waveR: hasWave ? wave : null,
      sampleRate,
      bpm,
      beatPhase: beatPhase(time, bpm),
      active,
      // The Studio plays the voice alone: it is the whole mix, and there's no song.
      voice: { rms, onset },
      song: null,
    }
  }
  return Object.assign(next, { dispose: () => {} })
}

/** Nothing sounding: silent frames on the wall clock, for idle drawing. */
export function silentSource(bpm = 140): AudioSource {
  return Object.assign(() => silentFrame(performance.now() / 1000, bpm), { dispose: () => {} })
}
