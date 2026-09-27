/**
 * The camera clip's sound: the drop, and optionally a song under it, each with its own level, through a safety
 * limiter (the drop is mastered loud; a song on top would clip). With a song, the clip is a short lead-in, the drop's
 * last word landing as the song's beat drops (the song ducked under the voice), then the beat drop playing out.
 * Without, just the drop, up to a second past its last word (its bar padding is dead air in a video).
 */

export interface MixLevels {
  /** Gains, 0–1. */
  drop: number
  song: number
}

/** Where things sit in the clip, in seconds. */
export interface ClipPlan {
  /** Where the clip starts in the song. */
  songFrom: number
  /** Where the drop starts in the clip. */
  dropAt: number
  /** Where its voice ends in the clip: with a song, where the beat drops. */
  dropEnd: number
  length: number
}

export interface Mix {
  /** AudioContext time the clip starts at. */
  at: number
  length: number
  setLevels(levels: MixLevels): void
  stop(): void
  /** Resolves when the clip has played to its end (or was stopped). */
  ended: Promise<void>
}

/** Song before the drop starts, and after the beat drop. */
export const LEAD_S = 2
export const TAIL_S = 7
/** The drop alone: this long past its last word. */
export const AFTER_S = 1
/** The song under the drop: −6 dB, back up as the beat drops. */
const DUCK = 0.5
const FADE_OUT_S = 1

/** A 0–100 slider as a gain: squared, so the travel feels even to the ear. */
export const gainOf = (percent: number): number => (Math.min(100, Math.max(0, percent)) / 100) ** 2

/** Where the drop's voice can end in the song: not before the voice has had time to play, not after the song. */
export function clampLand(landAt: number, songDuration: number, voiceEnd: number): number {
  return Math.min(Math.max(landAt, voiceEnd), Math.max(voiceEnd, songDuration))
}

/** The clip for a drop whose voice ends `voiceEnd` s in, landing at `landAt` in the song (or no song). */
export function planClip(drop: { duration: number; voiceEnd: number }, songDuration: number | null, landAt: number): ClipPlan {
  if (songDuration == null) {
    const length = Math.min(drop.duration, drop.voiceEnd + AFTER_S)
    return { songFrom: 0, dropAt: 0, dropEnd: Math.min(drop.voiceEnd, length), length }
  }
  const land = clampLand(landAt, songDuration, drop.voiceEnd)
  const songFrom = Math.max(0, land - drop.voiceEnd - LEAD_S)
  const end = Math.max(land, Math.min(songDuration, land + TAIL_S))
  return { songFrom, dropAt: land - drop.voiceEnd - songFrom, dropEnd: land - songFrom, length: end - songFrom }
}

/** Where a drop's voice ends: its last sample within 40 dB of its peak (the render pads drops to whole bars). */
export function voiceEndOf(channels: readonly Float32Array[], rate: number): number {
  let peak = 0
  for (const ch of channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]!))
  const floor = peak / 100
  let last = 0
  for (const ch of channels) {
    for (let i = ch.length - 1; i > last; i--) {
      if (Math.abs(ch[i]!) >= floor) {
        last = i
        break
      }
    }
  }
  return peak ? (last + 1) / rate : 0
}

export function startMix(
  ac: AudioContext,
  drop: AudioBuffer,
  song: AudioBuffer | null,
  o: { levels: MixLevels; plan: ClipPlan; outputs: AudioNode[] },
): Mix {
  const { plan } = o
  const bus = ac.createDynamicsCompressor()
  bus.threshold.value = -3
  bus.knee.value = 0
  bus.ratio.value = 20
  bus.attack.value = 0.002
  bus.release.value = 0.1
  for (const out of o.outputs) bus.connect(out)
  const at = ac.currentTime + 0.05
  const dropGain = ac.createGain()
  dropGain.gain.value = o.levels.drop
  dropGain.connect(bus)
  const dropSource = ac.createBufferSource()
  dropSource.buffer = drop
  dropSource.connect(dropGain)
  dropSource.start(at + plan.dropAt)
  dropSource.stop(at + plan.length)
  const sources: AudioBufferSourceNode[] = [dropSource]
  let songGain: GainNode | null = null
  if (song) {
    songGain = ac.createGain()
    songGain.gain.value = o.levels.song
    songGain.connect(bus)
    // The duck and the fades ride on their own gain, so level changes don't fight them.
    const shape = ac.createGain()
    shape.connect(songGain)
    const g = shape.gain
    const dropStart = at + plan.dropAt
    const beat = at + plan.dropEnd
    g.setValueAtTime(0, at)
    g.linearRampToValueAtTime(1, at + 0.03)
    g.setValueAtTime(1, Math.max(at + 0.03, dropStart - 0.15))
    g.linearRampToValueAtTime(DUCK, dropStart)
    g.setValueAtTime(DUCK, Math.max(dropStart, beat - 0.05))
    g.linearRampToValueAtTime(1, beat)
    const end = at + plan.length
    if (end - FADE_OUT_S > beat) {
      g.setValueAtTime(1, end - FADE_OUT_S)
      g.linearRampToValueAtTime(0, end)
    }
    const songSource = ac.createBufferSource()
    songSource.buffer = song
    songSource.connect(shape)
    songSource.start(at, plan.songFrom, plan.length)
    sources.push(songSource)
  }
  const ended = Promise.all(sources.map((n) => new Promise<void>((done) => (n.onended = () => done())))).then(() => undefined)
  const quiet = (n: AudioScheduledSourceNode) => {
    try {
      n.stop()
    } catch {
      // not started or already ended
    }
  }
  return {
    at,
    length: plan.length,
    setLevels(l) {
      dropGain.gain.setTargetAtTime(l.drop, ac.currentTime, 0.02)
      songGain?.gain.setTargetAtTime(l.song, ac.currentTime, 0.02)
    },
    stop() {
      sources.forEach(quiet)
      window.setTimeout(() => bus.disconnect(), 100)
    },
    ended,
  }
}

// ------------------------------------------------------------------------------------------ songs

/** Decodes a song: whatever Chromium reads (MP3, M4A/AAC, WAV, FLAC, Ogg), plus AIFF, which it doesn't. */
export async function decodeSong(ac: BaseAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  const aiff = decodeAiff(bytes)
  if (aiff) {
    const buf = ac.createBuffer(aiff.channels.length, aiff.channels[0]!.length, aiff.sampleRate)
    aiff.channels.forEach((ch, i) => buf.copyToChannel(ch, i))
    return buf
  }
  return ac.decodeAudioData(bytes)
}

/** The 80-bit IEEE extended float AIFF stores its sample rate in. */
function extended80(v: DataView, at: number): number {
  const exp = ((v.getUint8(at) & 0x7f) << 8) | v.getUint8(at + 1)
  const hi = v.getUint32(at + 2)
  const lo = v.getUint32(at + 6)
  return (hi * 2 ** 32 + lo) * 2 ** (exp - 16383 - 63)
}

/** Uncompressed AIFF / AIFF-C (NONE, sowt) at 8–32 bits. Null for anything else (then Chromium decodes it). */
export function decodeAiff(bytes: ArrayBuffer): { sampleRate: number; channels: Float32Array<ArrayBuffer>[] } | null {
  const v = new DataView(bytes)
  if (bytes.byteLength < 12 || v.getUint32(0) !== 0x464f524d /* FORM */) return null
  const form = v.getUint32(8)
  const aifc = form === 0x41494643 /* AIFC */
  if (form !== 0x41494646 /* AIFF */ && !aifc) return null
  let channels = 0
  let frames = 0
  let bits = 0
  let rate = 0
  let little = false
  let data = -1
  for (let at = 12; at + 8 <= bytes.byteLength;) {
    const id = v.getUint32(at)
    const size = v.getUint32(at + 4)
    const body = at + 8
    if (id === 0x434f4d4d /* COMM */) {
      channels = v.getUint16(body)
      frames = v.getUint32(body + 2)
      bits = v.getUint16(body + 6)
      rate = extended80(v, body + 8)
      if (aifc) {
        const kind = v.getUint32(body + 18)
        if (kind === 0x736f7774 /* sowt */) little = true
        else if (kind !== 0x4e4f4e45 /* NONE */) return null
      }
    } else if (id === 0x53534e44 /* SSND */) {
      data = body + 8 + v.getUint32(body)
    }
    at = body + size + (size % 2)
  }
  if (!channels || !frames || data < 0 || bits < 8 || bits > 32 || !rate) return null
  const width = Math.ceil(bits / 8)
  frames = Math.min(frames, Math.floor((bytes.byteLength - data) / (width * channels)))
  const out = Array.from({ length: channels }, () => new Float32Array(new ArrayBuffer(frames * 4)))
  const scale = 1 / 2 ** (width * 8 - 1)
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const p = data + (f * channels + c) * width
      let s = 0
      for (let b = 0; b < width; b++) s = (s << 8) | v.getUint8(little ? p + width - 1 - b : p + b)
      s = (s << (32 - width * 8)) >> (32 - width * 8) // sign-extend
      out[c]![f] = s * scale
    }
  }
  return { sampleRate: rate, channels: out }
}

// ------------------------------------------------------------------------------------ the beat drop

/** The low end per 10 ms hop, as power: mono, through a two-pole low-pass at 150 Hz (kick and bass). */
export function lowEnd(channels: readonly Float32Array[], rate: number, hopS = 0.01): Float32Array {
  const hop = Math.max(1, Math.round(rate * hopS))
  const n = Math.floor(channels[0]!.length / hop)
  const a = Math.exp((-2 * Math.PI * 150) / rate)
  const out = new Float32Array(n)
  let y1 = 0
  let y2 = 0
  for (let h = 0; h < n; h++) {
    let e = 0
    for (let i = h * hop; i < (h + 1) * hop; i++) {
      let x = 0
      for (const ch of channels) x += ch[i]!
      x /= channels.length
      y1 = y1 * a + x * (1 - a)
      y2 = y2 * a + y1 * (1 - a)
      e += y2 * y2
    }
    out[h] = e / hop
  }
  return out
}

const dB = (p: number) => 10 * Math.log10(p + 1e-12)

/**
 * The song's first big beat drop, in seconds: where its low end (kick and bass) comes in near its loudest and stays
 * there, after a clearly quieter stretch (a breakdown, a build, the gap before the drop). Null if there's none.
 */
export function findBeatDrop(channels: readonly Float32Array[], rate: number): number | null {
  const hopS = Math.max(1, Math.round(rate * 0.01)) / rate
  const p = lowEnd(channels, rate)
  const n = p.length
  const sum = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) sum[i + 1] = sum[i]! + p[i]!
  const level = (a: number, b: number) => {
    const lo = Math.max(0, a)
    const hi = Math.min(n, b)
    return hi > lo ? dB((sum[hi]! - sum[lo]!) / (hi - lo)) : -120
  }
  const sec = Math.round(1 / hopS)
  const win = 4 * sec
  // How loud the low end gets when the song is going: the top tenth of its seconds.
  const secs: number[] = []
  for (let h = 0; h + sec <= n; h += sec) secs.push(level(h, h + sec))
  if (secs.length < 12) return null
  secs.sort((a, b) => a - b)
  const loud = secs[Math.floor(0.9 * (secs.length - 1))]!
  // The first stretch where the next 4 s are near that and 6 dB over the 4 s before; its sharpest point.
  let best = -1
  let contrast = 0
  for (let h = win; h + win <= n; h++) {
    if (best >= 0 && h > best + win) break
    const after = level(h, h + win)
    const jump = after - level(h - win, h)
    if (after >= loud - 4 && jump >= 6 && jump > contrast) {
      best = h
      contrast = jump
    }
  }
  if (best < 0) return null
  // The hit itself: the first 10 ms near the loud level where every tenth of the next 0.4 s stays near it (a fill or
  // a lone kick just before the drop doesn't).
  const tenth = Math.round(sec / 10)
  const holds = (h: number) => [0, 1, 2, 3].every((k) => level(h + k * tenth, h + (k + 1) * tenth) >= loud - 10)
  for (let h = Math.max(0, best - sec); h <= best + sec; h++) {
    if (dB(p[h]!) >= loud - 10 && holds(h)) return h * hopS
  }
  return best * hopS
}

/** The song's shape over part of it: its loudness (RMS) per bucket, 0–1 against the loudest bucket. A mastered song
 * peaks near full scale everywhere, so peaks alone would draw a flat block; loudness shows the build and the drop. */
export function songShape(buffer: AudioBuffer, from: number, length: number, buckets = 480): Float32Array {
  const out = new Float32Array(buckets)
  const a = Math.max(0, Math.round(from * buffer.sampleRate))
  const b = Math.min(buffer.length, Math.round((from + length) * buffer.sampleRate))
  const per = (b - a) / buckets
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c)
    for (let k = 0; k < buckets; k++) {
      let e = 0
      for (let i = Math.floor(a + k * per), end = Math.floor(a + (k + 1) * per); i < end; i++) e += ch[i]! * ch[i]!
      out[k]! += e
    }
  }
  let top = 0
  for (let k = 0; k < buckets; k++) top = Math.max(top, (out[k] = Math.sqrt(out[k]! / Math.max(1, per))))
  if (top > 0) for (let k = 0; k < buckets; k++) out[k]! /= top
  return out
}
