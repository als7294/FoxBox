import { describe, expect, it } from 'vitest'
import { decodeWav } from '@/audio/wav'
import { CaptureBuffer } from '@/audio/live/recorder'

describe('SetRecorder capture', () => {
  it('crops leading and trailing silence and writes a 24-bit / 48 kHz stereo WAV', async () => {
    const sr = 48_000
    const buf = new CaptureBuffer(2, sr)
    const block = (n: number, f: (i: number) => number) => {
      const a = Float32Array.from({ length: n }, (_, i) => f(i))
      buf.push([a, a])
    }
    block(sr, () => 0) // 1 s of silence
    block(sr / 2, (i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr)) // 0.5 s of tone
    block(2 * sr, () => 0) // 2 s of silence
    const pcm = decodeWav(await buf.wav().arrayBuffer())
    expect(pcm.sampleRate).toBe(sr)
    expect(pcm.channels).toHaveLength(2)
    // 50 ms kept before the first sound, 300 ms after the last
    expect(pcm.channels[0]!.length).toBe(Math.round(0.05 * sr) + sr / 2 - 1 + Math.round(0.3 * sr))
    const peak = pcm.channels[0]!.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
    expect(peak).toBeCloseTo(0.5, 3)
  })
})
