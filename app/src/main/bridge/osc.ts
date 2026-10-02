// Minimal OSC 1.0 (opensoundcontrol.org/spec-1_0) for the TouchDesigner bridge: messages with int32 (i), float32 (f),
// string (s), true/false (T/F) out, one bundle a frame; the same plus float64 (d) and int64 (h) in, and bundles in
// (TouchDesigner's OSC Out can send them). No dependency: it's a few dozen lines, and a native-free main process stays simple.

export type OscArg = number | string | boolean | { type: 'i'; value: number }

export interface OscMessage {
  address: string
  args: OscArg[]
}

/** An int32 argument (plain numbers go out as float32, what TouchDesigner's CHOPs read). */
export const int = (value: number): OscArg => ({ type: 'i', value: Math.trunc(value) })

function padded(text: string): Buffer {
  const raw = Buffer.from(text, 'utf8')
  const out = Buffer.alloc((raw.length + 4) & ~3) // at least one NUL, then to a multiple of 4
  raw.copy(out)
  return out
}

export function encodeMessage(msg: OscMessage): Buffer {
  if (!msg.address.startsWith('/')) throw new Error(`OSC address must start with '/': ${msg.address}`)
  let tags = ','
  const parts: Buffer[] = []
  for (const arg of msg.args) {
    if (typeof arg === 'boolean') {
      tags += arg ? 'T' : 'F'
    } else if (typeof arg === 'string') {
      tags += 's'
      parts.push(padded(arg))
    } else if (typeof arg === 'number') {
      tags += 'f'
      const b = Buffer.alloc(4)
      b.writeFloatBE(Number.isFinite(arg) ? arg : 0)
      parts.push(b)
    } else {
      tags += 'i'
      const b = Buffer.alloc(4)
      b.writeInt32BE(arg.value | 0)
      parts.push(b)
    }
  }
  return Buffer.concat([padded(msg.address), padded(tags), ...parts])
}

/** An OSC bundle of already-encoded messages, time tag "immediately": one UDP packet a frame. */
export function encodeBundle(messages: Buffer[]): Buffer {
  const head = Buffer.alloc(16)
  head.write('#bundle', 0, 'ascii')
  head.writeUInt32BE(1, 12) // time tag 1: immediately
  const parts: Buffer[] = [head]
  for (const m of messages) {
    const size = Buffer.alloc(4)
    size.writeInt32BE(m.length)
    parts.push(size, m)
  }
  return Buffer.concat(parts)
}

function readString(buf: Buffer, at: number): [string, number] {
  const end = buf.indexOf(0, at)
  if (end < 0) throw new Error('OSC string without NUL')
  return [buf.toString('utf8', at, end), (end + 4) & ~3]
}

/** Every message in a packet (a message, or a bundle of them, nested bundles included). Throws on malformed data. */
export function decodePacket(buf: Buffer): OscMessage[] {
  if (buf.length >= 16 && buf.toString('ascii', 0, 8) === '#bundle\0') {
    const out: OscMessage[] = []
    let at = 16 // "#bundle\0" + 8-byte time tag
    while (at + 4 <= buf.length) {
      const size = buf.readInt32BE(at)
      if (size <= 0 || at + 4 + size > buf.length) throw new Error('OSC bundle element out of range')
      out.push(...decodePacket(buf.subarray(at + 4, at + 4 + size)))
      at += 4 + size
    }
    return out
  }
  const [address, afterAddress] = readString(buf, 0)
  if (!address.startsWith('/')) throw new Error('OSC address must start with /')
  if (afterAddress >= buf.length) return [{ address, args: [] }] // no type tag string (old senders)
  const [tags, afterTags] = readString(buf, afterAddress)
  if (!tags.startsWith(',')) throw new Error('OSC type tags must start with ,')
  const args: OscArg[] = []
  let at = afterTags
  for (const tag of tags.slice(1)) {
    switch (tag) {
      case 'i':
        args.push(buf.readInt32BE(at))
        at += 4
        break
      case 'f':
        args.push(buf.readFloatBE(at))
        at += 4
        break
      case 'd':
        args.push(buf.readDoubleBE(at))
        at += 8
        break
      case 'h':
        args.push(Number(buf.readBigInt64BE(at)))
        at += 8
        break
      case 's': {
        const [s, next] = readString(buf, at)
        args.push(s)
        at = next
        break
      }
      case 'T':
        args.push(true)
        break
      case 'F':
        args.push(false)
        break
      case 'N':
      case 'I':
        break
      default:
        throw new Error(`unsupported OSC type tag '${tag}'`)
    }
  }
  return [{ address, args }]
}
