import { describe, expect, it } from 'vitest'
import { avc1Entry, mp4aEntry, writeMp4, type Sample } from '@/components/clips/mp4'
import { stemsAt } from '@/components/clips/features'

const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint32(at)
const type = (b: Uint8Array, at: number) => String.fromCharCode(...b.subarray(at + 4, at + 8))

function find(b: Uint8Array, path: string[], from = 0, to = b.length): number {
  for (let at = from; at < to; at += u32(b, at)) {
    if (type(b, at) !== path[0]) continue
    if (path.length === 1) return at
    const skip = { stsd: 16, stco: 16 }[path[0]!] ?? 8
    return find(b, path.slice(1), at + skip, at + u32(b, at))
  }
  return -1
}

describe('clip MP4', () => {
  const frames: Sample[] = [0, 1, 2].map((i) => ({ data: Uint8Array.of(0xa0 + i, 1, 2), duration: 1000, key: i === 0 }))
  const sound: Sample[] = [0, 1, 2, 3].map((i) => ({ data: Uint8Array.of(0xb0 + i), duration: 1024, key: true }))
  const file = writeMp4([
    {
      kind: 'video',
      timescale: 30_000,
      entry: avc1Entry(1080, 1920, Uint8Array.of(1, 0x64, 0, 0x28)),
      samples: frames,
      width: 1080,
      height: 1920,
    },
    { kind: 'audio', timescale: 48_000, entry: mp4aEntry(2, 48_000, Uint8Array.of(0x11, 0x90), 192_000), samples: sound },
  ])

  it('is ftyp, moov, then mdat, the boxes filling the file exactly', () => {
    let at = 0
    const order: string[] = []
    while (at < file.length) {
      order.push(type(file, at))
      at += u32(file, at)
    }
    expect(order).toEqual(['ftyp', 'moov', 'mdat'])
    expect(at).toBe(file.length)
  })

  it('points every chunk offset at its sample', () => {
    const traks: number[] = []
    const moov = find(file, ['moov'])
    for (let at = moov + 8; at < moov + u32(file, moov); at += u32(file, at)) if (type(file, at) === 'trak') traks.push(at)
    const firstBytes = traks.map((t) => {
      const stco = find(file, ['mdia', 'minf', 'stbl', 'stco'], t + 8, t + u32(file, t))
      const n = u32(file, stco + 12)
      return Array.from({ length: n }, (_, i) => file[u32(file, stco + 16 + i * 4)])
    })
    expect(firstBytes).toEqual([
      [0xa0, 0xa1, 0xa2],
      [0xb0, 0xb1, 0xb2, 0xb3],
    ])
  })
})

describe('stem features', () => {
  it('reads each stem’s level and hit at a song time', () => {
    // 2 frames at 10 fps, tracks drums, bass, vocals, other, mix: (rms, onset) each.
    const data = Uint8Array.from([255, 128, 0, 0, 51, 0, 0, 0, 9, 9, /* frame 1 */ 0, 0, 102, 63, 0, 0, 0, 0, 9, 9])
    const f = { fps: 10, frames: 2, tracks: ['drums', 'bass', 'vocals', 'other', 'mix'] as const, data }
    expect(stemsAt({ ...f, tracks: [...f.tracks] }, 0.05)).toEqual({
      drums: { rms: 1, onset: 2 },
      bass: { rms: 0, onset: 0 },
      vocals: { rms: 0.2, onset: 0 },
      other: { rms: 0, onset: 0 },
    })
    expect(stemsAt({ ...f, tracks: [...f.tracks] }, 9).bass).toEqual({ rms: 0.4, onset: 0 }) // past the end: the last frame; 63 < 64 isn't a hit
  })
})
