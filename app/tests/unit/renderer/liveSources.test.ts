import { describe, expect, it } from 'vitest'
import {
  bandsOf,
  beatPhase,
  decayOnset,
  downsample,
  floatToByteWave,
  fluxOnsetDetector,
  ONSET_DECAY_S,
  spectralFlux,
} from '@/visuals/live/sources'
import { backingSize } from '@/visuals/live/stage'

describe('AudioFrame source helpers', () => {
  it('downsamples a spectrum by averaging the bins each output covers', () => {
    const src = Uint8Array.from({ length: 1024 }, (_, i) => (i % 2 ? 100 : 50))
    const out = downsample(src, new Uint8Array(512))
    expect(out.length).toBe(512)
    expect([...out].every((v) => v === 75)).toBe(true)
    // Stretching takes the nearest bin; an empty input is silence.
    expect([...downsample([10, 20], new Uint8Array(4))]).toEqual([10, 10, 20, 20])
    expect([...downsample([], new Uint8Array(3))]).toEqual([0, 0, 0])
  })

  it('reads the three bands from the bin edges at the sample rate', () => {
    // 512 bins at 48 kHz: 46.875 Hz each, so bins 1–5 are < 250 Hz, 6–85 up to 4 kHz, 86–341 up to 16 kHz.
    const fft = new Uint8Array(512)
    fft.fill(255, 1, 6)
    const lowOnly = bandsOf(fft, 48_000)
    expect(lowOnly.low).toBeCloseTo(1)
    expect(lowOnly.mid).toBe(0)
    expect(lowOnly.high).toBe(0)
    fft.fill(0).fill(51, 86, 342)
    expect(bandsOf(fft, 48_000).high).toBeCloseTo(0.2)
    // Any length: 1024 bins halve the bin width, so the same edge moves to bin 11.
    const wide = new Uint8Array(1024)
    wide.fill(255, 1, 11)
    expect(bandsOf(wide, 48_000).low).toBeCloseTo(1)
    expect(bandsOf(wide, 48_000).mid).toBe(0)
  })

  it('measures spectral flux as the mean rise (falls ignored)', () => {
    const a = new Uint8Array([0, 0, 0, 0, 0])
    const b = new Uint8Array([0, 255, 255, 0, 0])
    expect(spectralFlux(a, b)).toBeCloseTo(0.5)
    expect(spectralFlux(b, a)).toBe(0)
  })

  it('detects a hit after a steady run and spaces hits at least 80 ms apart', () => {
    const detect = fluxOnsetDetector()
    const quiet = new Uint8Array(64).fill(20)
    const loud = new Uint8Array(64).fill(220)
    let t = 0
    for (let i = 0; i < 20; i++) expect(detect(quiet, (t += 0.016))).toBe(0)
    const hit = detect(loud, (t += 0.016))
    expect(hit).toBeGreaterThanOrEqual(1)
    detect(quiet, (t += 0.016))
    expect(detect(loud, (t += 0.016))).toBe(0)
  })

  it('decays an onset linearly to zero over its window', () => {
    expect(decayOnset(2, 0)).toBe(2)
    expect(decayOnset(2, ONSET_DECAY_S / 2)).toBeCloseTo(1)
    expect(decayOnset(2, ONSET_DECAY_S)).toBe(0)
    expect(decayOnset(2, -0.01)).toBe(0)
  })

  it('places time in the beat', () => {
    expect(beatPhase(0.25, 120)).toBeCloseTo(0.5)
    expect(beatPhase(1, 120)).toBeCloseTo(0)
    expect(beatPhase(3, 0)).toBe(0)
  })

  it('turns float samples into byte samples around 128', () => {
    const out = floatToByteWave(new Float32Array([0, 1, -1, 0.5]), new Uint8Array(6))
    expect([...out]).toEqual([128, 255, 0, 192, 128, 128])
  })

  it('sizes the backing store at css × dpr (≤ 2), at most 3840 px wide', () => {
    expect(backingSize(1512, 982, 2)).toEqual({ width: 3024, height: 1964 })
    expect(backingSize(1512, 982, 3)).toEqual({ width: 3024, height: 1964 })
    expect(backingSize(2560, 1440, 2)).toEqual({ width: 3840, height: 2160 })
    expect(backingSize(0, 0, 1)).toEqual({ width: 1, height: 1 })
  })
})
