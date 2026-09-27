/** Planar float PCM, -1..1. */
export interface PcmAudio {
  sampleRate: number
  channels: Float32Array[]
}

export type WavBitDepth = 16 | 24 | 32

/**
 * Encodes a RIFF/WAVE file. 16/24-bit are integer PCM with format tag 0x0001 (never
 * WAVE_FORMAT_EXTENSIBLE, which CDJs reject); 32 is IEEE float (tag 0x0003).
 */
export function encodeWav(audio: PcmAudio, bitDepth: WavBitDepth = 24): ArrayBuffer {
  const numChannels = audio.channels.length
  if (numChannels === 0) throw new Error('encodeWav: no channels')
  const frames = audio.channels[0]!.length
  const bytesPerSample = bitDepth / 8
  const blockAlign = numChannels * bytesPerSample
  const dataBytes = frames * blockAlign
  const isFloat = bitDepth === 32
  const fmtBytes = 16
  const factBytes = isFloat ? 12 : 0
  const buffer = new ArrayBuffer(12 + 8 + fmtBytes + factBytes + 8 + dataBytes + (dataBytes % 2))
  const view = new DataView(buffer)
  let p = 0
  const str = (s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i))
  }
  const u32 = (v: number) => {
    view.setUint32(p, v, true)
    p += 4
  }
  const u16 = (v: number) => {
    view.setUint16(p, v, true)
    p += 2
  }
  str('RIFF')
  u32(buffer.byteLength - 8)
  str('WAVE')
  str('fmt ')
  u32(fmtBytes)
  u16(isFloat ? 0x0003 : 0x0001)
  u16(numChannels)
  u32(audio.sampleRate)
  u32(audio.sampleRate * blockAlign)
  u16(blockAlign)
  u16(bitDepth)
  if (isFloat) {
    str('fact')
    u32(4)
    u32(frames)
  }
  str('data')
  u32(dataBytes)
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, audio.channels[c]![i] ?? 0))
      if (bitDepth === 16) {
        view.setInt16(p, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true)
        p += 2
      } else if (bitDepth === 24) {
        const v = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff)
        view.setUint8(p, v & 0xff)
        view.setUint8(p + 1, (v >> 8) & 0xff)
        view.setUint8(p + 2, (v >> 16) & 0xff)
        p += 3
      } else {
        view.setFloat32(p, s, true)
        p += 4
      }
    }
  }
  return buffer
}

/** Decodes integer PCM (8/16/24/32-bit) and float (32/64-bit) WAV, including WAVE_FORMAT_EXTENSIBLE. */
export function decodeWav(input: ArrayBuffer): PcmAudio {
  const view = new DataView(input)
  const tag = (o: number) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3))
  if (input.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file')
  let format = 0
  let numChannels = 0
  let sampleRate = 0
  let bitDepth = 0
  let dataOffset = -1
  let dataBytes = 0
  let p = 12
  while (p + 8 <= input.byteLength) {
    const id = tag(p)
    const size = view.getUint32(p + 4, true)
    const body = p + 8
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      numChannels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitDepth = view.getUint16(body + 14, true)
      if (format === 0xfffe && size >= 40) format = view.getUint16(body + 24, true) // SubFormat GUID's first two bytes
    } else if (id === 'data') {
      dataOffset = body
      dataBytes = Math.min(size, input.byteLength - body)
      break
    }
    p = body + size + (size % 2)
  }
  if (dataOffset < 0 || !numChannels || !sampleRate) throw new Error('WAV has no fmt/data chunk')
  if (format !== 1 && format !== 3) throw new Error(`unsupported WAV format tag ${format}`)
  const bytesPerSample = bitDepth / 8
  const frames = Math.floor(dataBytes / (bytesPerSample * numChannels))
  const channels = Array.from({ length: numChannels }, () => new Float32Array(frames))
  let o = dataOffset
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      let s: number
      if (format === 3) s = bitDepth === 64 ? view.getFloat64(o, true) : view.getFloat32(o, true)
      else if (bitDepth === 8) s = (view.getUint8(o) - 128) / 128
      else if (bitDepth === 16) s = view.getInt16(o, true) / 0x8000
      else if (bitDepth === 24) {
        const v = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getInt8(o + 2) << 16)
        s = v / 0x800000
      } else s = view.getInt32(o, true) / 0x80000000
      channels[c]![i] = s
      o += bytesPerSample
    }
  }
  return { sampleRate, channels }
}

export function wavBlob(audio: PcmAudio, bitDepth: WavBitDepth = 24): Blob {
  return new Blob([encodeWav(audio, bitDepth)], { type: 'audio/wav' })
}

/** Mixes all channels down to one. */
export function toMono(audio: PcmAudio): PcmAudio {
  if (audio.channels.length <= 1) return audio
  const frames = audio.channels[0]!.length
  const out = new Float32Array(frames)
  for (const ch of audio.channels) for (let i = 0; i < frames; i++) out[i]! += ch[i]! / audio.channels.length
  return { sampleRate: audio.sampleRate, channels: [out] }
}

export function durationOf(audio: PcmAudio): number {
  return (audio.channels[0]?.length ?? 0) / audio.sampleRate
}

/** Min/max style peaks (absolute max per bucket), for mini waveforms. */
export function computePeaks(channel: Float32Array, buckets: number): number[] {
  const out = new Array<number>(buckets).fill(0)
  if (channel.length === 0 || buckets <= 0) return out
  const step = channel.length / buckets
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * step)
    const end = Math.min(channel.length, Math.floor((b + 1) * step))
    let max = 0
    for (let i = start; i < end; i++) {
      const v = Math.abs(channel[i]!)
      if (v > max) max = v
    }
    out[b] = max
  }
  return out
}
