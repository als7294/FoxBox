import { describe, expect, it } from 'vitest'
import { silentFrame, type AudioFrame } from '@/visuals/live/registry'
import { Cues, ease, isMono, lissajous, logBands, monoDelay, onsetEnvelope, peakOf } from '@/visuals/live/styles/audioKit'

const frame = (over: Partial<AudioFrame> = {}): AudioFrame => ({ ...silentFrame(0), active: true, ...over })

/** A byte waveform of a sine (128 = silence). */
const sine = (hz: number, phase = 0, sr = 48_000, n = 1024) =>
  Uint8Array.from({ length: n }, (_, i) => Math.round(128 + 100 * Math.sin((2 * Math.PI * hz * i) / sr + phase)))

describe('onset envelope', () => {
  it('jumps on a hit, decays after it, and stays silent when nothing is sounding', () => {
    const hit = onsetEnvelope(0, { onset: 1.2, active: true }, 16, 200, false)
    expect(hit).toBeCloseTo(1.2)
    const later = onsetEnvelope(hit, { onset: 0, active: true }, 200, 200, false)
    expect(later).toBeCloseTo(1.2 / Math.E)
    // below the threshold is no hit; inactive ignores onsets
    expect(onsetEnvelope(0, { onset: 0.9, active: true }, 16, 200, false)).toBe(0)
    expect(onsetEnvelope(0, { onset: 3, active: false }, 16, 200, false)).toBe(0)
  })

  it('caps a hit, and keeps it low and slow under reduced motion', () => {
    expect(onsetEnvelope(0, { onset: 9, active: true }, 16, 200, false)).toBe(1.5)
    const calm = onsetEnvelope(0, { onset: 1, active: true }, 16, 200, true)
    expect(calm).toBeCloseTo(0.4)
    expect(onsetEnvelope(calm, { onset: 0, active: true }, 400, 200, true)).toBeCloseTo(0.4 / Math.E)
  })

  it('eases the same at any frame rate', () => {
    let a = 0
    for (let i = 0; i < 6; i++) a = ease(a, 1, 16, 100)
    expect(ease(0, 1, 96, 100)).toBeCloseTo(a)
  })
})

describe('Lissajous mapping', () => {
  it('plots left against right for a stereo source', () => {
    const l = sine(110)
    const r = sine(110, Math.PI / 2)
    const out = new Float32Array(2048)
    const n = lissajous(l, r, out, 100)
    expect(n).toBe(1024)
    expect(isMono(l, r)).toBe(false)
    // a quarter-period apart draws a circle: every point sits near radius 100/128
    for (let i = 10; i < n - 10; i += 50) expect(Math.hypot(out[i * 2]!, out[i * 2 + 1]!)).toBeCloseTo(100 / 128, 1)
  })

  it('plots a mono source against a delayed copy of itself', () => {
    const l = sine(110)
    const out = new Float32Array(2048)
    const d = monoDelay(48_000)
    expect(d).toBe(109) // a quarter period of 110 Hz
    const n = lissajous(l, l, out, d)
    expect(n).toBe(1024 - d)
    // y is x from d samples earlier
    expect(out[50 * 2 + 1]).toBeCloseTo((l[50]! - 128) / 128, 1)
    expect(out[50 * 2]).toBeCloseTo((l[50 + d]! - 128) / 128, 1)
    // near a circle too (the delay is a quarter period)
    expect(peakOf(out, n)).toBeGreaterThan(0.7)
    expect(peakOf(out, n)).toBeLessThan(0.82)
  })

  it('draws nothing without a waveform, and a single array reads as mono', () => {
    expect(lissajous(null, null, new Float32Array(8), 10)).toBe(0)
    const l = sine(220)
    expect(isMono(l, null)).toBe(true)
    expect(isMono(l, Uint8Array.from(l))).toBe(true)
  })
})

describe('song cues', () => {
  it('flags a new bar on the bar count changing, or on its phase wrapping', () => {
    const c = new Cues(false)
    expect(c.step(frame({ bar: 3, barPhase: 0.9 }), 16).newBar).toBe(false)
    expect(c.step(frame({ bar: 4, barPhase: 0.02 }), 16).newBar).toBe(true)
    expect(c.step(frame({ bar: 4, barPhase: 0.05 }), 16).newBar).toBe(false)
    const p = new Cues(false)
    p.step(frame({ barPhase: 0.95 }), 16)
    expect(p.step(frame({ barPhase: 0.01 }), 16).newBar).toBe(true)
    // nothing sounding: no bar
    expect(p.step(frame({ barPhase: 0.99, active: false }), 16).newBar).toBe(false)
  })

  it('fires the drop once, then lets it decay (40 % under reduced motion)', () => {
    const c = new Cues(false)
    expect(c.step(frame({ drop: true }), 16).dropStart).toBe(true)
    expect(c.drop).toBe(1)
    expect(c.step(frame({ drop: true }), 900).dropStart).toBe(false)
    expect(c.drop).toBeCloseTo(1 / Math.E)
    const calm = new Cues(true).step(frame({ drop: true }), 16)
    expect(calm.drop).toBeCloseTo(0.4)
  })

  it("pulses on the song's kicks when a song plays, else the mix's; the voice has its own", () => {
    const c = new Cues(false)
    c.step(frame({ onset: 2, song: { rms: 0.3, onset: 0, bands: { low: 0, mid: 0, high: 0 } }, voice: { rms: 0.2, onset: 1.1 } }), 16)
    expect(c.kick).toBe(0)
    expect(c.voice).toBeCloseTo(1.1)
    const m = new Cues(false).step(frame({ onset: 1.3 }), 16)
    expect(m.kick).toBeCloseTo(1.3)
  })
})

describe('log bands', () => {
  it('folds the spectrum into rising log bands and sinks to the floor without one', () => {
    const fft = new Uint8Array(512)
    fft[5] = 255 // ~234 Hz
    const out = new Float32Array(16)
    logBands(fft, 48_000, out, 1000)
    const peak = out.indexOf(Math.max(...out))
    expect(peak).toBeGreaterThan(0)
    expect(peak).toBeLessThan(6)
    logBands(null, 48_000, out, 10_000, 0.05)
    for (const v of out) expect(v).toBeCloseTo(0.05)
  })
})
