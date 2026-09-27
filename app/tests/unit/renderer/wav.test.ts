import { describe, expect, it } from 'vitest'
import { computePeaks, decodeWav, durationOf, encodeWav, toMono } from '../../../src/renderer/src/audio/wav'

const sine = (n: number, f = 440, sr = 48_000) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * f * i) / sr))

describe('wav', () => {
  it.each([16, 24, 32] as const)('round-trips %i-bit audio', (bits) => {
    const audio = { sampleRate: 48_000, channels: [sine(4800), sine(4800, 220)] }
    const out = decodeWav(encodeWav(audio, bits))
    expect(out.sampleRate).toBe(48_000)
    expect(out.channels).toHaveLength(2)
    expect(out.channels[0]).toHaveLength(4800)
    const tol = bits === 16 ? 1e-4 : bits === 24 ? 1e-6 : 1e-7
    for (let i = 0; i < 4800; i += 97) expect(Math.abs(out.channels[1]![i]! - audio.channels[1]![i]!)).toBeLessThan(tol)
  })

  it('writes integer PCM with format tag 0x0001 (never WAVE_FORMAT_EXTENSIBLE)', () => {
    const view = new DataView(encodeWav({ sampleRate: 44_100, channels: [sine(100)] }, 24))
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1) // channels
    expect(view.getUint32(24, true)).toBe(44_100)
    expect(view.getUint16(34, true)).toBe(24)
  })

  it('writes IEEE float as tag 3 with a fact chunk', () => {
    const buf = encodeWav({ sampleRate: 48_000, channels: [sine(10)] }, 32)
    const view = new DataView(buf)
    expect(view.getUint16(20, true)).toBe(3)
    expect(String.fromCharCode(...new Uint8Array(buf, 36, 4))).toBe('fact')
  })

  it('reads WAVE_FORMAT_EXTENSIBLE PCM', () => {
    const pcm = new Uint8Array(encodeWav({ sampleRate: 48_000, channels: [sine(64)] }, 16))
    // Rebuild the header as a 40-byte extensible fmt chunk.
    const data = pcm.subarray(44)
    const out = new DataView(new ArrayBuffer(12 + 8 + 40 + 8 + data.length))
    const bytes = new Uint8Array(out.buffer)
    const put = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)))
    put(0, 'RIFF')
    out.setUint32(4, out.byteLength - 8, true)
    put(8, 'WAVE')
    put(12, 'fmt ')
    out.setUint32(16, 40, true)
    out.setUint16(20, 0xfffe, true)
    out.setUint16(22, 1, true)
    out.setUint32(24, 48_000, true)
    out.setUint32(28, 96_000, true)
    out.setUint16(32, 2, true)
    out.setUint16(34, 16, true)
    out.setUint16(36, 22, true)
    out.setUint16(38, 16, true)
    out.setUint16(44, 1, true) // SubFormat GUID starts with the PCM tag
    put(60, 'data')
    out.setUint32(64, data.length, true)
    bytes.set(data, 68)
    const decoded = decodeWav(out.buffer)
    expect(decoded.channels[0]).toHaveLength(64)
  })

  it('rejects non-WAV input', () => {
    expect(() => decodeWav(new ArrayBuffer(64))).toThrow(/RIFF/)
  })

  it('mixes to mono, measures duration and peaks', () => {
    const mono = toMono({ sampleRate: 1000, channels: [new Float32Array([1, 0]), new Float32Array([0, 1])] })
    expect(Array.from(mono.channels[0]!)).toEqual([0.5, 0.5])
    expect(durationOf({ sampleRate: 1000, channels: [new Float32Array(2500)] })).toBe(2.5)
    expect(computePeaks(new Float32Array([0, -0.5, 0.25, 1]), 2)).toEqual([0.5, 1])
  })
})
