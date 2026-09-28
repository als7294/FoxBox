/**
 * SetRecorder: records the LIVE master (LiveBus.analyser, the masked output after the master stage) and optionally
 * the dry mic (LiveBus.input), sample-aligned, into a 24-bit / 48 kHz WAV with the leading and trailing silence
 * cropped. `saveToLibrary()` sends it through the existing import route (POST /api/sources/upload).
 *
 * Memory: audio is packed to 24-bit as it arrives (17 MB per stereo minute) and assembled into a Blob without
 * copying; recording stops keeping audio after `maxS` (default 20 min). A context not at 48 kHz is resampled at stop.
 */
import { uploadSource } from '@/api/upload'
import type { SourceInfo } from '@/api/types'
import type { Level } from '../recorder'
import { encodeWav } from '../wav'
import type { LiveBus } from './bus'

export const WAV_RATE = 48_000
const SILENCE_DB = -60 // crop threshold (sample peak)
const LEAD_S = 0.05 // kept before the first sound
const TAIL_S = 0.3 // kept after the last (reverb and echo tails)
const FULL = 8_388_607

export interface SetRecording {
  blob: Blob
  filename: string
  durationS: number
  sampleRate: number
  /** The dry mic over the same span, when recorded with `{ dry: true }`. */
  dry?: Blob
  /** True when the set ran past `maxS` and the end was not kept. */
  truncated: boolean
}

function wavHeader(channels: number, sampleRate: number, dataBytes: number): ArrayBuffer {
  const h = new DataView(new ArrayBuffer(44))
  const tag = (o: number, s: string) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)))
  tag(0, 'RIFF')
  h.setUint32(4, 36 + dataBytes, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  h.setUint32(16, 16, true)
  h.setUint16(20, 1, true) // integer PCM, never WAVE_FORMAT_EXTENSIBLE (CDJs reject it)
  h.setUint16(22, channels, true)
  h.setUint32(24, sampleRate, true)
  h.setUint32(28, sampleRate * channels * 3, true)
  h.setUint16(32, channels * 3, true)
  h.setUint16(34, 24, true)
  tag(36, 'data')
  h.setUint32(40, dataBytes, true)
  return h.buffer
}

/** Packs planar float chunks to interleaved 24-bit as they arrive and remembers where the sound starts and ends. */
export class CaptureBuffer {
  private readonly parts: Uint8Array[] = []
  frames = 0
  first = -1
  last = -1
  truncated = false
  private readonly thr = Math.pow(10, SILENCE_DB / 20)

  constructor(
    readonly channels: number,
    readonly sampleRate: number,
    private readonly maxFrames = Infinity,
  ) {}

  push(planar: Float32Array[]): void {
    const n = planar[0]?.length ?? 0
    if (!n) return
    if (this.frames + n > this.maxFrames) {
      this.truncated = true
      return
    }
    const ch = this.channels
    const out = new Uint8Array(n * ch * 3)
    let o = 0
    for (let i = 0; i < n; i++) {
      let loud = false
      for (let c = 0; c < ch; c++) {
        const x = planar[Math.min(c, planar.length - 1)]![i]!
        if (x > this.thr || x < -this.thr) loud = true
        const v = Math.round(Math.max(-1, Math.min(1, x)) * FULL)
        out[o++] = v & 0xff
        out[o++] = (v >> 8) & 0xff
        out[o++] = (v >> 16) & 0xff
      }
      if (loud) {
        if (this.first < 0) this.first = this.frames + i
        this.last = this.frames + i
      }
    }
    this.parts.push(out)
    this.frames += n
  }

  /** The frames kept after cropping: [start, end). Empty when nothing crossed the threshold. */
  span(lead = LEAD_S, tail = TAIL_S): [number, number] {
    if (this.first < 0) return [0, 0]
    return [Math.max(0, this.first - Math.round(lead * this.sampleRate)), Math.min(this.frames, this.last + 1 + Math.round(tail * this.sampleRate))]
  }

  /** The cropped 24-bit WAV (in `span`), assembled from the packed parts without copying them. */
  wav(span: [number, number] = this.span()): Blob {
    const bpf = this.channels * 3
    const [a, b] = [span[0] * bpf, span[1] * bpf]
    const body: Uint8Array[] = []
    let pos = 0
    for (const p of this.parts) {
      const s = Math.max(a, pos)
      const e = Math.min(b, pos + p.length)
      if (e > s) body.push(p.subarray(s - pos, e - pos))
      pos += p.length
    }
    return new Blob([wavHeader(this.channels, this.sampleRate, b - a), ...(body as BlobPart[])], { type: 'audio/wav' })
  }

  /** Planar float of the cropped span (only for the resampling path). */
  floats(span: [number, number]): Float32Array[] {
    const ch = this.channels
    const n = span[1] - span[0]
    const out = Array.from({ length: ch }, () => new Float32Array(n))
    let frame = 0
    for (const p of this.parts) {
      for (let i = 0; i < p.length; i += 3) {
        const f = frame + Math.floor(i / 3 / ch)
        if (f >= span[0] && f < span[1]) {
          const v = ((p[i]! | (p[i + 1]! << 8) | (p[i + 2]! << 16)) << 8) >> 8
          out[(i / 3) % ch]![f - span[0]] = v / FULL
        }
      }
      frame += p.length / 3 / ch
    }
    return out
  }
}

async function resampled(buf: CaptureBuffer, span: [number, number]): Promise<Blob> {
  const src = buf.floats(span)
  const n = src[0]!.length
  const len = Math.max(1, Math.round((n * WAV_RATE) / buf.sampleRate))
  const off = new OfflineAudioContext(buf.channels, len, WAV_RATE)
  const ab = off.createBuffer(buf.channels, Math.max(1, n), buf.sampleRate)
  src.forEach((c, i) => ab.copyToChannel(c as Float32Array<ArrayBuffer>, i))
  const node = new AudioBufferSourceNode(off, { buffer: ab })
  node.connect(off.destination)
  node.start()
  const r = await off.startRendering()
  const channels = Array.from({ length: r.numberOfChannels }, (_, i) => r.getChannelData(i))
  return new Blob([encodeWav({ sampleRate: WAV_RATE, channels }, 24)], { type: 'audio/wav' })
}

function stamp(d = new Date()): string {
  const p = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

interface Tap {
  node: AudioWorkletNode
  source: AudioNode
  buf: CaptureBuffer
  stopped: Promise<void>
}

export class SetRecorder {
  private taps: Tap[] = []
  private _state: 'idle' | 'armed' | 'recording' = 'idle'
  private readonly time: Float32Array<ArrayBuffer>

  constructor(
    private readonly bus: LiveBus,
    private readonly opts: { dry?: boolean; maxS?: number } = {},
  ) {
    this.time = new Float32Array(bus.analyser.fftSize)
  }

  get state(): 'idle' | 'armed' | 'recording' {
    return this._state
  }

  /** Connects the taps (the master, and the dry mic with `{ dry: true }`). Nothing is kept until `start()`. */
  arm(): void {
    if (this._state !== 'idle') return
    const ctx = this.bus.context
    const maxFrames = Math.round((this.opts.maxS ?? 20 * 60) * ctx.sampleRate)
    const make = (source: AudioNode, channels: number): Tap => {
      const node = new AudioWorkletNode(ctx, 'fvwks-tap', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [channels], channelCount: channels, channelCountMode: 'explicit',
      })
      const buf = new CaptureBuffer(channels, ctx.sampleRate, maxFrames)
      let done!: () => void
      const stopped = new Promise<void>((r) => (done = r))
      node.port.onmessage = (e: MessageEvent<{ type: string; data?: Float32Array[] }>) => {
        if (e.data.type === 'chunk' && e.data.data) buf.push(e.data.data)
        else if (e.data.type === 'stopped') done()
      }
      source.connect(node)
      node.connect(ctx.destination) // silent: keeps the tap rendering
      return { node, source, buf, stopped }
    }
    this.taps = [make(this.bus.analyser, 2), ...(this.opts.dry ? [make(this.bus.input, 1)] : [])]
    this._state = 'armed'
  }

  /** Starts keeping audio from the next render quantum, on the same sample in every tap. */
  start(): void {
    if (this._state === 'idle') this.arm()
    if (this._state !== 'armed') return
    const startAt = this.bus.context.currentTime + 0.01
    for (const t of this.taps) t.node.port.postMessage({ type: 'start', startAt })
    this._state = 'recording'
  }

  /** Stops, crops leading / trailing silence (on the master; the dry file keeps the same span) and encodes. */
  async stop(): Promise<SetRecording> {
    if (this._state !== 'recording') throw new Error('SetRecorder: not recording')
    for (const t of this.taps) t.node.port.postMessage({ type: 'stop' })
    await Promise.all(this.taps.map((t) => t.stopped))
    const [master, dry] = this.taps
    const span = master!.buf.span()
    const sr = master!.buf.sampleRate
    const encode = (b: CaptureBuffer) => (sr === WAV_RATE ? Promise.resolve(b.wav(span)) : resampled(b, span))
    const result: SetRecording = {
      blob: await encode(master!.buf),
      filename: `foxbox-live-${stamp()}.wav`,
      durationS: (span[1] - span[0]) / sr,
      sampleRate: WAV_RATE,
      truncated: master!.buf.truncated,
      ...(dry ? { dry: await encode(dry.buf) } : {}),
    }
    this.release()
    return result
  }

  /** The master's level now (armed or recording): the analyser's last 2048 samples. */
  level(): Level {
    this.bus.analyser.getFloatTimeDomainData(this.time)
    let peak = 0
    let sum = 0
    for (const v of this.time) {
      peak = Math.max(peak, Math.abs(v))
      sum += v * v
    }
    return { peak: Math.min(1, peak), rms: Math.min(1, Math.sqrt(sum / this.time.length)), peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity }
  }

  /** Disconnects the taps without encoding (a cancelled take). */
  release(): void {
    for (const t of this.taps) {
      t.node.port.onmessage = null
      t.source.disconnect(t.node)
      t.node.disconnect()
    }
    this.taps = []
    this._state = 'idle'
  }
}

/** Sends a recorded set to the library through the existing import route. */
export function saveToLibrary(rec: SetRecording, name?: string): Promise<SourceInfo> {
  return uploadSource(rec.blob, rec.filename, 'import', name)
}
