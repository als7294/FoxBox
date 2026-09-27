import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** Encodes straight (non-premultiplied) RGBA pixels as a PNG. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

type RGBA = [number, number, number, number]

/**
 * The cartridge glyph used as the drag image: a dark tile with an ember waveform.
 * Drawn in code so it never depends on a resource path (dev, packaged and tests alike).
 */
export function cartridgePng(size = 64): Buffer {
  const px = new Uint8Array(size * size * 4)
  const set = (x: number, y: number, [r, g, b, a]: RGBA) => {
    const i = (y * size + x) * 4
    px[i] = r
    px[i + 1] = g
    px[i + 2] = b
    px[i + 3] = a
  }
  const radius = Math.round(size * 0.14)
  const inset = Math.round(size * 0.06)
  const body: RGBA = [20, 19, 18, 245]
  const edge: RGBA = [222, 214, 198, 255]
  const ember: RGBA = [232, 72, 38, 255]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.max(inset + radius - x, 0, x - (size - 1 - inset - radius))
      const dy = Math.max(inset + radius - y, 0, y - (size - 1 - inset - radius))
      const d = Math.hypot(dx, dy)
      if (d <= radius - 1.5) set(x, y, body)
      else if (d <= radius) set(x, y, edge)
    }
  }
  // Waveform bars across the middle.
  const bars = 11
  const left = inset + Math.round(size * 0.12)
  const width = size - 2 * left
  const mid = Math.round(size / 2)
  for (let b = 0; b < bars; b++) {
    const x0 = left + Math.round((b * width) / bars)
    const x1 = left + Math.round(((b + 1) * width) / bars) - Math.max(2, Math.round(size * 0.025))
    const h = Math.round(size * (0.08 + 0.26 * Math.abs(Math.sin(b * 1.7 + 0.6))))
    for (let x = x0; x <= x1; x++) for (let y = mid - h; y <= mid + h; y++) set(x, y, ember)
  }
  return encodePng(size, size, px)
}
