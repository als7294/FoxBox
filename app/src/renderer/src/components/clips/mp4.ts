/**
 * A plain MP4 from WebCodecs output: ftyp, moov first (so players and upload pages can start before the end), then
 * one mdat with the samples interleaved by time. H.264 video (avc1 + the encoder's avcC) and AAC (mp4a + esds) or
 * Opus (Opus + dOps) audio. The box helpers are the camera remux's.
 */
import { box, concat, fullBox, u32 } from '@/components/camera/remux'

export interface Sample {
  data: Uint8Array
  /** In the track's timescale. */
  duration: number
  key: boolean
}

export interface TrackIn {
  kind: 'video' | 'audio'
  timescale: number
  /** The stsd entry: avc1Entry / mp4aEntry / opusEntry. */
  entry: Uint8Array
  samples: Sample[]
  width?: number
  height?: number
  /** Samples to skip at the start (encoder priming): an edit list. */
  skip?: number
  /** Samples to present after the skip (the source's length; the encoder pads its last packet). */
  length?: number
}

const u16 = (n: number) => Uint8Array.of((n >>> 8) & 255, n & 255)
const u8 = (...b: number[]) => Uint8Array.from(b)
const zeros = (n: number) => new Uint8Array(n)
const ascii = (t: string) => Uint8Array.from(t, (c) => c.charCodeAt(0))
const MATRIX = concat([u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)])
const MOVIE_SCALE = 1000

export function avc1Entry(width: number, height: number, avcC: Uint8Array): Uint8Array {
  return box(
    'avc1',
    zeros(6),
    u16(1),
    zeros(16),
    u16(width),
    u16(height),
    u32(0x480000),
    u32(0x480000),
    u32(0),
    u16(1),
    zeros(32),
    u16(0x18),
    u16(0xffff),
    box('avcC', avcC),
  )
}

/** An MPEG-4 descriptor with the 4-byte length form every reader accepts. */
function descriptor(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(parts)
  const n = body.length
  return concat([u8(tag, 0x80 | ((n >>> 21) & 127), 0x80 | ((n >>> 14) & 127), 0x80 | ((n >>> 7) & 127), n & 127), body])
}

function audioEntry(type: string, channels: number, sampleRate: number, ...children: Uint8Array[]): Uint8Array {
  return box(type, zeros(6), u16(1), zeros(8), u16(channels), u16(16), u16(0), u16(0), u32(sampleRate * 65536), ...children)
}

export function mp4aEntry(channels: number, sampleRate: number, audioSpecificConfig: Uint8Array, bitrate: number): Uint8Array {
  const esds = fullBox(
    'esds',
    0,
    0,
    descriptor(
      3,
      u16(1),
      u8(0),
      descriptor(4, u8(0x40, 0x15, 0, 0, 0), u32(bitrate), u32(bitrate), descriptor(5, audioSpecificConfig)),
      descriptor(6, u8(2)),
    ),
  )
  return audioEntry('mp4a', channels, sampleRate, esds)
}

export function opusEntry(channels: number, preSkip: number): Uint8Array {
  const dOps = box('dOps', u8(0, channels), u16(preSkip), u32(48_000), u16(0), u8(0))
  return audioEntry('Opus', channels, 48_000, dOps)
}

function runs(values: readonly number[]): [number, number][] {
  const out: [number, number][] = []
  for (const v of values) {
    const last = out[out.length - 1]
    if (last && last[1] === v) last[0]++
    else out.push([1, v])
  }
  return out
}

function trak(id: number, t: TrackIn, offsets: number[]): Uint8Array {
  const s = t.samples
  const length = s.reduce((n, x) => n + x.duration, 0)
  const skip = Math.min(t.skip ?? 0, length)
  const shown = Math.min(length - skip, t.length ?? Infinity)
  const movie = (n: number) => Math.round((n * MOVIE_SCALE) / t.timescale)
  const video = t.kind === 'video'
  const stts = runs(s.map((x) => x.duration))
  const sync = s.flatMap((x, k) => (x.key ? [k + 1] : []))
  const stbl = box(
    'stbl',
    fullBox('stsd', 0, 0, u32(1), t.entry),
    fullBox('stts', 0, 0, u32(stts.length), ...stts.flatMap(([n, d]) => [u32(n), u32(d)])),
    ...(video && sync.length < s.length ? [fullBox('stss', 0, 0, u32(sync.length), ...sync.map(u32))] : []),
    fullBox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)),
    fullBox('stsz', 0, 0, u32(0), u32(s.length), ...s.map((x) => u32(x.data.length))),
    fullBox('stco', 0, 0, u32(offsets.length), ...offsets.map(u32)),
  )
  const edts = skip || shown < length ? [box('edts', fullBox('elst', 0, 0, u32(1), u32(movie(shown)), u32(skip), u32(0x10000)))] : []
  return box(
    'trak',
    fullBox(
      'tkhd',
      0,
      3,
      u32(0),
      u32(0),
      u32(id),
      u32(0),
      u32(movie(shown)),
      zeros(8),
      u16(0),
      u16(video ? 0 : 1),
      u16(video ? 0 : 0x100),
      u16(0),
      MATRIX,
      u32((t.width ?? 0) * 65536),
      u32((t.height ?? 0) * 65536),
    ),
    ...edts,
    box(
      'mdia',
      fullBox('mdhd', 0, 0, u32(0), u32(0), u32(t.timescale), u32(length), u16(0x55c4), u16(0)),
      fullBox('hdlr', 0, 0, u32(0), ascii(video ? 'vide' : 'soun'), zeros(12), ascii(video ? 'FoxBox video' : 'FoxBox audio'), u8(0)),
      box(
        'minf',
        video ? fullBox('vmhd', 0, 1, zeros(8)) : fullBox('smhd', 0, 0, zeros(4)),
        box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
        stbl,
      ),
    ),
  )
}

function moov(tracks: TrackIn[], offsets: number[][]): Uint8Array {
  const shown = (t: TrackIn) => Math.min(t.samples.reduce((n, x) => n + x.duration, 0) - (t.skip ?? 0), t.length ?? Infinity)
  const duration = Math.max(...tracks.map((t) => Math.round((shown(t) * MOVIE_SCALE) / t.timescale)))
  const mvhd = fullBox(
    'mvhd',
    0,
    0,
    u32(0),
    u32(0),
    u32(MOVIE_SCALE),
    u32(duration),
    u32(0x10000),
    u16(0x100),
    zeros(10),
    MATRIX,
    zeros(24),
    u32(tracks.length + 1),
  )
  return box('moov', mvhd, ...tracks.map((t, i) => trak(i + 1, t, offsets[i]!)))
}

/** The whole file. Samples are interleaved by their start time. */
export function writeMp4(tracks: TrackIn[]): Uint8Array<ArrayBuffer> {
  const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'))
  const order: { track: number; index: number; at: number }[] = []
  tracks.forEach((t, track) => {
    let at = 0
    t.samples.forEach((x, index) => {
      order.push({ track, index, at: at / t.timescale })
      at += x.duration
    })
  })
  order.sort((a, b) => a.at - b.at || a.track - b.track)
  // The moov's size doesn't depend on the offsets' values: size it once, then write it with the real ones.
  const empty = tracks.map((t) => t.samples.map(() => 0))
  const head = ftyp.length + moov(tracks, empty).length + 8
  const offsets = tracks.map(() => [] as number[])
  let at = head
  for (const o of order) {
    offsets[o.track]![o.index] = at
    at += tracks[o.track]!.samples[o.index]!.data.length
  }
  const mdat = concat([u32(at - head + 8), ascii('mdat'), ...order.map((o) => tracks[o.track]!.samples[o.index]!.data)])
  return concat([ftyp, moov(tracks, offsets), mdat])
}
