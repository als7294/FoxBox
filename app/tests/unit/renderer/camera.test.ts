import { describe, expect, it } from 'vitest'
import { blurRadius, coverCrop, layout, mapBox, mosaicBlocks } from '../../../src/renderer/src/components/camera/compose'
import {
  AFTER_S,
  clampLand,
  decodeAiff,
  findBeatDrop,
  gainOf,
  LEAD_S,
  planClip,
  songShape,
  TAIL_S,
  voiceEndOf,
} from '../../../src/renderer/src/components/camera/mix'
import { HOLD_MS, iou, pad, step, type Box, type Track } from '../../../src/renderer/src/components/camera/faceTrack'
import { clipName, extensionOf, pickMimeType } from '../../../src/renderer/src/components/camera/recording'
import { box, concat, defragment, fullBox, u32 } from '../../../src/renderer/src/components/camera/remux'

const face: Box = { x: 400, y: 200, w: 200, h: 240 }
const covers = (outer: Box, inner: Box) =>
  outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.w >= inner.x + inner.w && outer.y + outer.h >= inner.y + inner.h

describe('face tracks', () => {
  it('pads each side by 25% of the face', () => {
    expect(pad(face)).toEqual({ x: 350, y: 140, w: 300, h: 360 })
  })

  it('smooths a moving face but always covers where it is now', () => {
    let tracks: Track[] = step([], [face], 0)
    expect(tracks).toHaveLength(1)
    const moved = { ...face, x: face.x + 60 }
    tracks = step(tracks, [moved], 33)
    expect(tracks).toHaveLength(1)
    expect(covers(tracks[0]!.box, pad(moved))).toBe(true) // never behind the face
    expect(tracks[0]!.box.x).toBeLessThan(pad(moved).x + 1) // and it hasn't jumped past it either
  })

  it('holds a lost face for half a second, then lets it go', () => {
    let tracks = step([], [face], 1000)
    tracks = step(tracks, [], 1000 + HOLD_MS)
    expect(tracks).toHaveLength(1)
    expect(tracks[0]!.box).toEqual(pad(face))
    expect(step(tracks, [], 1000 + HOLD_MS + 1)).toHaveLength(0)
  })

  it('follows a quick head move with one box, not two', () => {
    let tracks = step([], [face], 0)
    const jumped = { ...face, x: face.x + 320 } // no overlap with the padded old box
    tracks = step(tracks, [jumped], 33)
    expect(tracks).toHaveLength(1)
    expect(covers(tracks[0]!.box, pad(jumped))).toBe(true)
  })

  it('pads by the chosen coverage', () => {
    expect(step([], [face], 0, 0.5)[0]!.box).toEqual(pad(face, 0.5))
  })

  it('tracks two faces separately', () => {
    const other = { x: 900, y: 220, w: 180, h: 220 }
    let tracks = step([], [face, other], 0)
    tracks = step(
      tracks,
      [
        { ...other, x: other.x + 10 },
        { ...face, x: face.x - 10 },
      ],
      33,
    )
    expect(tracks).toHaveLength(2)
    expect(iou(tracks[0]!.box, pad(other))).toBeGreaterThan(0.8)
    expect(iou(tracks[1]!.box, pad(face))).toBeGreaterThan(0.8)
  })
})

describe('clip frame', () => {
  it('is 1080×1920 or 1920×1080, camera on top, the drop underneath', () => {
    const v = layout('vertical')
    expect([v.w, v.h, v.cam.h + v.wave.h, v.wave.y]).toEqual([1080, 1920, 1920, v.cam.h])
    const h = layout('horizontal')
    expect([h.w, h.h, h.cam.h + h.wave.h]).toEqual([1920, 1080, 1080])
  })

  it('crops a 16:9 camera to fill the camera area, and maps face boxes through the crop', () => {
    const cam = layout('vertical').cam
    const crop = coverCrop(1280, 720, cam)
    expect(crop.h).toBeCloseTo(720)
    expect(crop.w / crop.h).toBeCloseTo(cam.w / cam.h)
    const m = mapBox({ x: 640 - 50, y: 300, w: 100, h: 120 }, crop, cam)!
    expect(m.dst.x + m.dst.w / 2).toBeCloseTo(cam.w / 2) // a centred face stays centred
    expect(m.dst.w / m.src.w).toBeCloseTo(crop.scale)
    // A box half outside the visible crop is clipped to it; one fully outside is skipped.
    expect(mapBox({ x: crop.x - 50, y: 300, w: 100, h: 100 }, crop, cam)!.src.x).toBeCloseTo(crop.x)
    expect(mapBox({ x: 0, y: 0, w: 10, h: 10 }, crop, cam)).toBeNull()
  })
})

describe('recording', () => {
  it('prefers MP4/H.264, falls back to WebM', () => {
    expect(pickMimeType(() => true)).toMatch(/^video\/mp4;codecs=avc1/)
    expect(pickMimeType((t) => t.startsWith('video/webm'))).toBe('video/webm;codecs=vp9,opus')
    expect(pickMimeType(() => false)).toBeNull()
    expect(extensionOf('video/mp4;codecs=avc1')).toBe('mp4')
    expect(clipName('video/webm', new Date(2026, 8, 27, 2, 31))).toBe('FoxBox-clip-2026-09-27-0231.webm')
  })
})

describe('face masks', () => {
  it('never lets a face through: at most 16 mosaic cells, a blur of at least 6% of the face', () => {
    expect(mosaicBlocks(1)).toBe(16)
    expect(mosaicBlocks(5)).toBe(11)
    expect(mosaicBlocks(10)).toBe(5)
    expect(mosaicBlocks(-3)).toBe(16) // clamped
    expect(blurRadius(1, 500)).toBeCloseTo(31)
    expect(blurRadius(10, 500)).toBeCloseTo(85)
  })
})

describe('clip sound', () => {
  it('turns a volume slider into a gain', () => {
    expect([gainOf(0), gainOf(50), gainOf(100), gainOf(150)]).toEqual([0, 0.25, 1, 1])
  })

  it("plans the clip: a lead-in, the drop's last word landing on the beat drop, then the beat drop playing out", () => {
    // A 14 s drop (8 bars) whose voice ends 9.5 s in.
    const drop = { duration: 14, voiceEnd: 9.5 }
    // No song: the drop, a second past its last word.
    expect(planClip(drop, null, 60)).toEqual({ songFrom: 0, dropAt: 0, dropEnd: 9.5, length: 9.5 + AFTER_S })
    expect(planClip({ duration: 10, voiceEnd: 9.8 }, null, 0).length).toBe(10)
    // The last word lands at 40.6 s in the song.
    const p = planClip(drop, 180, 40.6)
    expect(p.songFrom).toBeCloseTo(40.6 - 9.5 - LEAD_S)
    expect(p.dropAt).toBeCloseTo(LEAD_S)
    expect(p.dropEnd).toBeCloseTo(LEAD_S + 9.5)
    expect(p.length).toBeCloseTo(LEAD_S + 9.5 + TAIL_S)
    // A beat drop earlier than the voice is long: the drop starts with the song.
    expect(planClip(drop, 180, 6)).toMatchObject({ songFrom: 0, dropAt: 0, dropEnd: 9.5, length: 9.5 + TAIL_S })
    // Near the song's end: the clip stops with the song.
    expect(planClip(drop, 60, 58)).toMatchObject({ dropAt: LEAD_S, length: LEAD_S + 9.5 + 2 })
    expect([clampLand(5, 200, 9.5), clampLand(90, 200, 9.5), clampLand(300, 200, 9.5), clampLand(9, 8, 9.5)]).toEqual([9.5, 90, 200, 9.5])
  })

  it("finds where a drop's voice ends, before its bar padding", () => {
    const rate = 1000
    const d = new Float32Array(14 * rate) // 14 s, voice for 9.5 s, then a faint tail and silence
    for (let i = 0; i < 9.5 * rate; i++) d[i] = 0.8 * Math.sin(i / 3)
    for (let i = 9.5 * rate; i < 11 * rate; i++) d[i] = 0.001
    expect(voiceEndOf([d], rate)).toBeCloseTo(9.5, 2)
    expect(voiceEndOf([new Float32Array(100)], rate)).toBe(0)
  })

  it("finds the song's first big beat drop, past a lone kick and a fill", () => {
    // A stand-in dance track at 8 kHz: a quiet intro, a groove, a breakdown, a kick and a fill, then the drop at 40.6 s.
    const rate = 8000
    const song = new Float32Array(rate * 70)
    const bass = (from: number, to: number, amp: number) => {
      for (let i = Math.round(from * rate); i < Math.round(to * rate); i++) song[i]! += amp * Math.sin((2 * Math.PI * 55 * i) / rate)
    }
    const hat = (from: number, to: number, amp: number) => {
      for (let i = Math.round(from * rate); i < Math.round(to * rate); i++) song[i]! += amp * (Math.random() * 2 - 1)
    }
    hat(0, 70, 0.05) // hats throughout: no low end
    bass(10, 30, 0.12) // the groove, well under the drop
    bass(39.7, 39.8, 0.8) // a lone kick
    bass(40.2, 40.4, 0.6) // a fill
    bass(40.6, 60, 0.7) // the drop
    bass(62, 70, 0.3)
    expect(findBeatDrop([song], rate)).toBeCloseTo(40.6, 1)
    // A song that never drops: nothing found.
    const flat = new Float32Array(rate * 30)
    for (let i = 0; i < flat.length; i++) flat[i] = 0.5 * Math.sin((2 * Math.PI * 55 * i) / rate)
    expect(findBeatDrop([flat], rate)).toBeNull()
  })

  it("draws the song's shape by loudness, so a mastered build and drop don't look the same", () => {
    // 1 s quiet build, 1 s loud drop, both peaking at full scale.
    const data = new Float32Array(200)
    for (let i = 0; i < 100; i++) data[i] = i % 10 === 0 ? 1 : 0.1
    for (let i = 100; i < 200; i++) data[i] = i % 2 === 0 ? 1 : -1
    const buffer = { sampleRate: 100, length: 200, numberOfChannels: 1, getChannelData: () => data } as unknown as AudioBuffer
    const [build, dropped] = songShape(buffer, 0, 2, 2)
    expect(dropped).toBeCloseTo(1)
    expect(build).toBeLessThan(0.4)
  })

  it('reads AIFF (big-endian) and AIFF-C sowt (little-endian), which Chromium cannot decode', () => {
    const aiff = (kind: 'AIFF' | 'sowt', samples: number[]) => {
      const bytes: number[] = []
      const u32 = (n: number) => bytes.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255)
      const u16 = (n: number) => bytes.push((n >>> 8) & 255, n & 255)
      const text = (t: string) => [...t].forEach((c) => bytes.push(c.charCodeAt(0)))
      const commSize = kind === 'sowt' ? 22 : 18
      const data = samples.length * 2
      text('FORM')
      u32(4 + 8 + commSize + 8 + 8 + data)
      text(kind === 'sowt' ? 'AIFC' : 'AIFF')
      text('COMM')
      u32(commSize)
      u16(1) // channels
      u32(samples.length) // frames
      u16(16) // bits
      bytes.push(0x40, 0x0e, 0xbb, 0x80, 0, 0, 0, 0, 0, 0) // 48000 as an 80-bit extended float
      if (kind === 'sowt') text('sowt')
      text('SSND')
      u32(8 + data)
      u32(0)
      u32(0)
      for (const v of samples) {
        const n = Math.round(v * 32767) & 0xffff
        if (kind === 'sowt') bytes.push(n & 255, n >> 8)
        else bytes.push(n >> 8, n & 255)
      }
      return new Uint8Array(bytes).buffer
    }
    for (const kind of ['AIFF', 'sowt'] as const) {
      const got = decodeAiff(aiff(kind, [0, 0.5, -0.5, 1]))!
      expect(got.sampleRate).toBe(48000)
      expect([...got.channels[0]!].map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 0.5, -0.5, 1])
    }
    expect(decodeAiff(new TextEncoder().encode('RIFF....WAVE').buffer as ArrayBuffer)).toBeNull()
  })
})

describe('clip file', () => {
  it("rewrites MediaRecorder's fragmented MP4 as a plain one: real length, every sample where the tables say", () => {
    const full = (type: string, body: Uint8Array[]) => fullBox(type, 0, 0, ...body)
    const trak = (id: number, scale: number, handler: string) =>
      box(
        'trak',
        full('tkhd', [u32(0), u32(0), u32(id), u32(0), u32(0), new Uint8Array(60)]),
        box(
          'mdia',
          full('mdhd', [u32(0), u32(0), u32(scale), u32(0), u32(0)]),
          full('hdlr', [u32(0), Uint8Array.from(handler, (c) => c.charCodeAt(0)), new Uint8Array(13)]),
          box('minf', full('smhd', [u32(0)]), box('dinf'), box('stbl', full('stsd', [u32(0)]))),
        ),
      )
    const moov = box(
      'moov',
      full('mvhd', [u32(0), u32(0), u32(1000), u32(0), new Uint8Array(80)]),
      trak(1, 48000, 'soun'),
      trak(2, 30000, 'vide'),
      box('mvex', full('trex', [u32(1), u32(1), u32(1024), u32(0), u32(0)]), full('trex', [u32(2), u32(1), u32(1000), u32(0), u32(0)])),
    )
    // Two fragments; each: audio samples of 3 and 4 bytes (default duration), then video frames (the 2nd not a sync frame).
    const fragment = (seq: number, fill: number) => {
      const data = [
        [3, 4],
        [5, 6],
      ].map((sizes) => sizes.map((n, k) => new Uint8Array(n).fill(fill + k)))
      const trafs = (dataStart: number) => {
        const audio = fullBox('trun', 0, 0x201, u32(2), u32(dataStart), u32(3), u32(4))
        const video = fullBox('trun', 0, 0x601, u32(2), u32(dataStart + 7), u32(5), u32(0), u32(6), u32(0x10000))
        return [
          box('traf', fullBox('tfhd', 0, 0x20000, u32(1)), fullBox('tfdt', 1, 0, new Uint8Array(4), u32(seq * 2048)), audio),
          box('traf', fullBox('tfhd', 0, 0x20000, u32(2)), fullBox('tfdt', 1, 0, new Uint8Array(4), u32(seq * 2000)), video),
        ]
      }
      const size = box('moof', fullBox('mfhd', 0, 0, u32(seq)), ...trafs(0)).length
      return concat([box('moof', fullBox('mfhd', 0, 0, u32(seq)), ...trafs(size + 8)), box('mdat', ...data.flat())])
    }
    const input = concat([box('ftyp', u32(0x69736f35)), moov, fragment(0, 10), fragment(1, 20)])
    const out = defragment(input.slice().buffer)!
    expect(out).not.toBeNull()

    const v = new DataView(out.buffer)
    const find = (type: string, from = 0): number => {
      for (let i = from; i < out.length - 4; i++) if (String.fromCharCode(...out.subarray(i, i + 4)) === type) return i + 4
      return -1
    }
    const ftypSize = v.getUint32(0)
    expect(String.fromCharCode(...out.subarray(4, 8), ...out.subarray(ftypSize + 4, ftypSize + 8))).toBe('ftypmoov') // moov up front
    expect(find('mvex')).toBe(-1)
    expect(v.getUint32(find('mvhd') + 16)).toBe(133) // the longer track: 4 frames at 1000/30000 s
    const video = find('trak', find('trak') + 8)
    expect(v.getUint32(find('mdhd', video) + 16)).toBe(4000)
    expect(Array.from({ length: 4 }, (_, k) => v.getUint32(find('stsz', video) + 12 + 4 * k))).toEqual([5, 6, 5, 6])
    expect([v.getUint32(find('stss', video) + 4), v.getUint32(find('stss', video) + 8), v.getUint32(find('stss', video) + 12)]).toEqual([
      2, 1, 3,
    ])
    // Every video sample's bytes are where stco and stsz put them.
    const offsets = [0, 1].map((k) => v.getUint32(find('stco', video) + 8 + 4 * k))
    expect(offsets.map((o) => [out[o], out[o + 5]])).toEqual([
      [10, 11],
      [20, 21],
    ])
    // Not a fragmented MP4: left alone.
    expect(defragment(concat([box('ftyp', u32(0)), moov]).slice().buffer)).toBeNull()
  })
})
