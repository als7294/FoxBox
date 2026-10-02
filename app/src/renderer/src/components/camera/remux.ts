/**
 * MediaRecorder writes a fragmented MP4: a moov with no duration and no sample tables, then moof+mdat pieces. Some
 * players show no length for it, can't seek it, and some upload pages turn it down. `defragment` rewrites it as a
 * plain MP4 (ftyp, one moov with every sample's table and the real duration, one mdat), without re-encoding.
 */

interface BoxAt {
  type: string
  start: number
  /** Where the body starts (after the size, type and any 64-bit size). */
  body: number
  end: number
}

function* boxes(v: DataView, from: number, to: number): Generator<BoxAt> {
  for (let at = from; at + 8 <= to;) {
    let size = v.getUint32(at)
    let body = at + 8
    if (size === 1) {
      size = Number(v.getBigUint64(at + 8))
      body = at + 16
    } else if (size === 0) size = to - at
    if (size < body - at || at + size > to) return
    const type = String.fromCharCode(v.getUint8(at + 4), v.getUint8(at + 5), v.getUint8(at + 6), v.getUint8(at + 7))
    yield { type, start: at, body, end: at + size }
    at += size
  }
}

const child = (v: DataView, parent: BoxAt, type: string) => {
  for (const b of boxes(v, parent.body, parent.end)) if (b.type === type) return b
  return null
}

// ----------------------------------------------------------------------------------------- writing

type Part = Uint8Array

const u8 = (...bytes: number[]) => Uint8Array.from(bytes)
export const u32 = (n: number): Part => u8((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255)
const text = (t: string): Part => Uint8Array.from(t, (c) => c.charCodeAt(0))

export function concat(parts: readonly Part[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export function box(type: string, ...parts: Part[]): Uint8Array<ArrayBuffer> {
  const body = concat(parts)
  return concat([u32(body.length + 8), text(type), body])
}

export function fullBox(type: string, version: number, flags: number, ...parts: Part[]): Uint8Array<ArrayBuffer> {
  return box(type, u32(((version & 255) << 24) | (flags & 0xffffff)), ...parts)
}

// ----------------------------------------------------------------------------------------- reading

interface Sample {
  offset: number
  size: number
  duration: number
  flags: number
  cto: number
}

interface Track {
  id: number
  timescale: number
  tkhd: BoxAt
  mdhd: BoxAt
  /** mdia's hdlr, minf's media header and dinf, stbl's stsd: copied as they are. */
  hdlr: BoxAt
  mediaHeader: BoxAt
  dinf: BoxAt
  stsd: BoxAt
  defaults: { duration: number; size: number; flags: number }
  /** The track's first decode time (its tfdt): a late start becomes an edit list. */
  start: number | null
  time: number
  samples: Sample[]
  /** Samples per chunk, in the order the chunks are written. */
  chunks: number[]
}

/**
 * The plain MP4, or null if this isn't a fragmented MP4 we can rewrite (then keep the original). `comment`: the file's
 * QuickTime ©cmt (1.6: SAVE CLIP's LIVE mode puts the TouchDesigner DEMO label there).
 */
export function defragment(input: ArrayBuffer, comment?: string): Uint8Array<ArrayBuffer> | null {
  try {
    return rewrite(input, comment)
  } catch {
    return null
  }
}

function rewrite(input: ArrayBuffer, comment?: string): Uint8Array<ArrayBuffer> | null {
  const v = new DataView(input)
  const top = [...boxes(v, 0, input.byteLength)]
  const moov = top.find((b) => b.type === 'moov')
  if (!moov || !top.some((b) => b.type === 'moof')) return null
  const mvhd = child(v, moov, 'mvhd')
  if (!mvhd) return null
  const movieScale = v.getUint32(mvhd.body + (v.getUint8(mvhd.body) === 1 ? 20 : 12))

  const tracks = new Map<number, Track>()
  const order: Track[] = []
  for (const trak of boxes(v, moov.body, moov.end)) {
    if (trak.type !== 'trak') continue
    const tkhd = child(v, trak, 'tkhd')
    const mdia = child(v, trak, 'mdia')
    const mdhd = mdia && child(v, mdia, 'mdhd')
    const hdlr = mdia && child(v, mdia, 'hdlr')
    const minf = mdia && child(v, mdia, 'minf')
    const stbl = minf && child(v, minf, 'stbl')
    const stsd = stbl && child(v, stbl, 'stsd')
    const dinf = minf && child(v, minf, 'dinf')
    const mediaHeader = minf && [...boxes(v, minf.body, minf.end)].find((b) => b.type.endsWith('mhd'))
    if (!tkhd || !mdhd || !hdlr || !stsd || !dinf || !mediaHeader) return null
    const id = v.getUint32(tkhd.body + (v.getUint8(tkhd.body) === 1 ? 20 : 12))
    const timescale = v.getUint32(mdhd.body + (v.getUint8(mdhd.body) === 1 ? 20 : 12))
    const t: Track = {
      ...{ id, timescale, tkhd, mdhd, hdlr, mediaHeader, dinf, stsd },
      defaults: { duration: 0, size: 0, flags: 0 },
      start: null,
      time: 0,
      samples: [],
      chunks: [],
    }
    tracks.set(id, t)
    order.push(t)
  }
  const mvex = child(v, moov, 'mvex')
  if (mvex) {
    for (const trex of boxes(v, mvex.body, mvex.end)) {
      const t = trex.type === 'trex' ? tracks.get(v.getUint32(trex.body + 4)) : undefined
      if (t) t.defaults = { duration: v.getUint32(trex.body + 12), size: v.getUint32(trex.body + 16), flags: v.getUint32(trex.body + 20) }
    }
  }

  for (const moof of top) {
    if (moof.type !== 'moof') continue
    // With neither a base offset nor default-base-is-moof, a traf's data follows the previous traf's.
    let previousEnd = moof.start
    for (const traf of boxes(v, moof.body, moof.end)) {
      if (traf.type !== 'traf') continue
      const tfhd = child(v, traf, 'tfhd')
      if (!tfhd) return null
      const tfFlags = v.getUint32(tfhd.body) & 0xffffff
      const t = tracks.get(v.getUint32(tfhd.body + 4))
      if (!t) return null
      let at = tfhd.body + 8
      let base = tfFlags & 0x1 ? Number(v.getBigUint64(at)) : tfFlags & 0x20000 ? moof.start : previousEnd
      if (tfFlags & 0x1) at += 8
      if (tfFlags & 0x2) at += 4 // sample description index: one description per track here
      const dflt = { ...t.defaults }
      if (tfFlags & 0x8) ((dflt.duration = v.getUint32(at)), (at += 4))
      if (tfFlags & 0x10) ((dflt.size = v.getUint32(at)), (at += 4))
      if (tfFlags & 0x20) dflt.flags = v.getUint32(at)
      const tfdt = child(v, traf, 'tfdt')
      if (tfdt) {
        const time = v.getUint8(tfdt.body) === 1 ? Number(v.getBigUint64(tfdt.body + 4)) : v.getUint32(tfdt.body + 4)
        if (t.start == null) t.start = t.time = time
        else if (time > t.time && t.samples.length) {
          // A gap: the sample before it lasts until this fragment starts.
          t.samples[t.samples.length - 1]!.duration += time - t.time
          t.time = time
        }
      }
      if (t.start == null) t.start = 0
      for (const trun of boxes(v, traf.body, traf.end)) {
        if (trun.type !== 'trun') continue
        const version = v.getUint8(trun.body)
        const f = v.getUint32(trun.body) & 0xffffff
        const count = v.getUint32(trun.body + 4)
        let p = trun.body + 8
        let offset = base
        if (f & 0x1) ((offset = base + v.getInt32(p)), (p += 4))
        let firstFlags: number | null = null
        if (f & 0x4) ((firstFlags = v.getUint32(p)), (p += 4))
        for (let i = 0; i < count; i++) {
          const duration = f & 0x100 ? v.getUint32(p) : dflt.duration
          if (f & 0x100) p += 4
          const size = f & 0x200 ? v.getUint32(p) : dflt.size
          if (f & 0x200) p += 4
          let flags = f & 0x400 ? v.getUint32(p) : dflt.flags
          if (f & 0x400) p += 4
          if (i === 0 && firstFlags != null) flags = firstFlags
          const cto = f & 0x800 ? (version === 0 ? v.getUint32(p) : v.getInt32(p)) : 0
          if (f & 0x800) p += 4
          if (offset + size > input.byteLength) return null
          t.samples.push({ offset, size, duration, flags, cto })
          t.time += duration
          offset += size
        }
        if (count) t.chunks.push(count)
        base = offset
      }
      previousEnd = base
    }
  }
  if (order.some((t) => !t.samples.length)) return null

  // The new file: ftyp, moov, then mdat with each track's runs in the order they came.
  const ftyp = box('ftyp', text('isom'), u32(0x200), text('isom'), text('iso2'), text('avc1'), text('mp41'))
  // Each trun becomes a chunk, written in the order it sat in the source file.
  const runs = order.flatMap((t) => {
    let from = 0
    return t.chunks.map((count) => ({ track: t, from: (from += count) - count, count }))
  })
  runs.sort((a, b) => a.track.samples[a.from]!.offset - b.track.samples[b.from]!.offset)
  const dataSize = order.reduce((n, t) => n + t.samples.reduce((m, s) => m + s.size, 0), 0)
  if (dataSize > 0xffffffff - 64) return null
  const chunkOffsets = new Map<Track, number[]>(order.map((t) => [t, []]))
  const build = (mdatStart: number) => {
    let at = mdatStart + 8
    for (const r of runs) {
      chunkOffsets.get(r.track)!.push(at)
      for (let i = r.from; i < r.from + r.count; i++) at += r.track.samples[i]!.size
    }
    return moovBox(v, mvhd, movieScale, order, chunkOffsets, comment)
  }
  // The moov's size doesn't depend on the offsets in it: build once to measure, then for real.
  const measure = build(0)
  chunkOffsets.forEach((list) => (list.length = 0))
  const moovOut = build(ftyp.length + measure.length)
  const out = new Uint8Array(ftyp.length + moovOut.length + 8 + dataSize)
  out.set(ftyp, 0)
  out.set(moovOut, ftyp.length)
  let at = ftyp.length + moovOut.length
  out.set(concat([u32(8 + dataSize), text('mdat')]), at)
  at += 8
  const src = new Uint8Array(input)
  for (const r of runs) {
    for (let i = r.from; i < r.from + r.count; i++) {
      const s = r.track.samples[i]!
      out.set(src.subarray(s.offset, s.offset + s.size), at)
      at += s.size
    }
  }
  return out
}

/** QuickTime user data with a ©cmt comment (QuickTime and Finder show it; ffprobe reads it as `comment`). */
function udta(comment: string): Uint8Array {
  const t = new TextEncoder().encode(comment)
  return box('udta', box('\xa9cmt', u8(t.length >> 8, t.length & 255, 0x55, 0xc4), t)) // 0x55c4: language 'und'
}

const raw = (v: DataView, b: BoxAt) => new Uint8Array(v.buffer, v.byteOffset + b.start, b.end - b.start)

/** A copy of a full box with its duration field set (tkhd, mdhd and mvhd keep it at different places). */
function withDuration(v: DataView, b: BoxAt, duration: number, at: { v0: number; v1: number }): Uint8Array {
  const copy = raw(v, b).slice()
  const d = new DataView(copy.buffer)
  const body = b.body - b.start
  if (d.getUint8(body) === 1) d.setBigUint64(body + at.v1, BigInt(duration))
  else d.setUint32(body + at.v0, Math.min(0xffffffff, duration))
  return copy
}

/** Equal neighbours as [count, value] pairs. */
function runLengths(values: readonly number[]): [number, number][] {
  const out: [number, number][] = []
  for (const x of values) {
    const last = out[out.length - 1]
    if (last && last[1] === x) last[0]++
    else out.push([1, x])
  }
  return out
}

function moovBox(v: DataView, mvhd: BoxAt, movieScale: number, tracks: Track[], chunkOffsets: Map<Track, number[]>,
                 comment?: string): Uint8Array {
  const toMovie = (t: Track, n: number) => Math.round((n * movieScale) / t.timescale)
  const lengths = tracks.map((t) => t.samples.reduce((n, s) => n + s.duration, 0))
  const movieLength = Math.max(...tracks.map((t, i) => toMovie(t, (t.start ?? 0) + lengths[i]!)))
  const traks = tracks.map((t, i) => {
    const s = t.samples
    const stts = runLengths(s.map((x) => x.duration))
    const ctts = s.some((x) => x.cto) ? runLengths(s.map((x) => x.cto)) : null
    const sync = s.flatMap((x, k) => (x.flags & 0x10000 ? [] : [k + 1]))
    const sizes = s.map((x) => x.size)
    const sameSize = sizes.every((x) => x === sizes[0])
    // stsc: [first chunk, samples per chunk, description 1] wherever the samples per chunk change.
    const stsc: number[][] = []
    t.chunks.forEach((count, k) => {
      if (stsc[stsc.length - 1]?.[1] !== count) stsc.push([k + 1, count, 1])
    })
    const offsets = chunkOffsets.get(t)!
    const stbl = box(
      'stbl',
      raw(v, t.stsd),
      fullBox('stts', 0, 0, u32(stts.length), ...stts.flatMap(([n, d]) => [u32(n), u32(d)])),
      ...(ctts ? [fullBox('ctts', 1, 0, u32(ctts.length), ...ctts.flatMap(([n, c]) => [u32(n), u32(c)]))] : []),
      ...(sync.length < s.length ? [fullBox('stss', 0, 0, u32(sync.length), ...sync.map(u32))] : []),
      fullBox('stsc', 0, 0, u32(stsc.length), ...stsc.flat().map(u32)),
      sameSize ? fullBox('stsz', 0, 0, u32(sizes[0]!), u32(s.length)) : fullBox('stsz', 0, 0, u32(0), u32(s.length), ...sizes.map(u32)),
      fullBox('stco', 0, 0, u32(offsets.length), ...offsets.map(u32)),
    )
    const start = t.start ?? 0
    // A track that starts late gets an empty edit for the gap, then plays from its first sample.
    const edts = start
      ? [
          box(
            'edts',
            fullBox(
              'elst',
              0,
              0,
              u32(2),
              u32(toMovie(t, start)),
              u32(0xffffffff),
              u32(0x10000),
              u32(toMovie(t, lengths[i]!)),
              u32(0),
              u32(0x10000),
            ),
          ),
        ]
      : []
    return box(
      'trak',
      withDuration(v, t.tkhd, toMovie(t, start + lengths[i]!), { v0: 20, v1: 28 }),
      ...edts,
      box(
        'mdia',
        withDuration(v, t.mdhd, lengths[i]!, { v0: 16, v1: 24 }),
        raw(v, t.hdlr),
        box('minf', raw(v, t.mediaHeader), raw(v, t.dinf), stbl),
      ),
    )
  })
  return box('moov', withDuration(v, mvhd, movieLength, { v0: 16, v1: 24 }), ...traks, ...(comment ? [udta(comment)] : []))
}
