/**
 * RECORD's WAV takes (2.0): PLAY's instrument (or REMIX's track, audio only) through the fvwks-tap worklet, packed to
 * 24-bit as it arrives (17 MB per stereo minute), cropped of its leading and trailing silence, and saved by main into
 * <exports>/Takes as "FoxBox take 3 - 808 - C#m.wav". The last three show as draggable chips (this session only: main
 * lets a file be dragged once it saved it).
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { bridge } from '@/env'
import { toast } from '@/state/toasts'

const SILENCE = Math.pow(10, -60 / 20) // the crop's threshold (sample peak)
const LEAD_S = 0.05 // kept before the first sound
const TAIL_S = 0.3 // kept after the last (echo and space tails)
const FULL = 8_388_607
const MAX_S = 20 * 60 // a take stops keeping audio after 20 minutes

export interface Take {
  name: string
  /** Where main saved it (drag-out and Show in Finder take it; never shown). */
  path: string
  seconds: number
}

interface TakesState {
  /** The last take's number (kept across launches). */
  n: number
  /** The last three, newest first. */
  recent: Take[]
  /** Recording since (performance.now()), else null. */
  t0: number | null
}

export const useTakes = create<TakesState>()(
  persist((): TakesState => ({ n: 0, recent: [], t0: null }), {
    name: 'foxbox-takes',
    storage: createJSONStorage(() => localStorage),
    partialize: (s) => ({ n: s.n }),
  }),
)

function wavHeader(channels: number, rate: number, bytes: number): ArrayBuffer {
  const h = new DataView(new ArrayBuffer(44))
  const tag = (o: number, s: string) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)))
  tag(0, 'RIFF')
  h.setUint32(4, 36 + bytes, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  h.setUint32(16, 16, true)
  h.setUint16(20, 1, true) // integer PCM, never WAVE_FORMAT_EXTENSIBLE (CDJs reject it)
  h.setUint16(22, channels, true)
  h.setUint32(24, rate, true)
  h.setUint32(28, rate * channels * 3, true)
  h.setUint16(32, channels * 3, true)
  h.setUint16(34, 24, true)
  tag(36, 'data')
  h.setUint32(40, bytes, true)
  return h.buffer
}

/** Planar float chunks packed to interleaved 24-bit as they arrive, remembering where the sound starts and ends. */
export class CaptureBuffer {
  private readonly parts: Uint8Array[] = []
  frames = 0
  first = -1
  last = -1

  constructor(
    readonly channels: number,
    readonly rate: number,
    private readonly maxFrames = Infinity,
  ) {}

  push(planar: Float32Array[]): void {
    const n = planar[0]?.length ?? 0
    if (!n || this.frames + n > this.maxFrames) return
    const out = new Uint8Array(n * this.channels * 3)
    let o = 0
    for (let i = 0; i < n; i++) {
      let loud = false
      for (let c = 0; c < this.channels; c++) {
        const x = planar[Math.min(c, planar.length - 1)]![i]!
        if (x > SILENCE || x < -SILENCE) loud = true
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

  /** The frames kept after cropping, [start, end); empty when nothing crossed the threshold. */
  span(): [number, number] {
    if (this.first < 0) return [0, 0]
    return [Math.max(0, this.first - Math.round(LEAD_S * this.rate)), Math.min(this.frames, this.last + 1 + Math.round(TAIL_S * this.rate))]
  }

  /** The cropped WAV, assembled from the packed parts without copying them. */
  wav([s0, s1] = this.span()): Blob {
    const bpf = this.channels * 3
    const [a, b] = [s0 * bpf, s1 * bpf]
    const body: Uint8Array[] = []
    let pos = 0
    for (const p of this.parts) {
      const s = Math.max(a, pos)
      const e = Math.min(b, pos + p.length)
      if (e > s) body.push(p.subarray(s - pos, e - pos))
      pos += p.length
    }
    return new Blob([wavHeader(this.channels, this.rate, b - a), ...(body as BlobPart[])], { type: 'audio/wav' })
  }
}

let tap: { node: AudioWorkletNode; source: AudioNode; buf: CaptureBuffer; stopped: Promise<void>; label: string } | null = null

/** Starts a take of `source` (its context must have the fvwks-tap worklet loaded). `label`: " - 808 - C#m". */
export function startTake(ctx: BaseAudioContext, source: AudioNode, label: string): void {
  if (tap) return
  const node = new AudioWorkletNode(ctx, 'fvwks-tap', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
  })
  const buf = new CaptureBuffer(2, ctx.sampleRate, MAX_S * ctx.sampleRate)
  let done!: () => void
  const stopped = new Promise<void>((r) => (done = r))
  node.port.onmessage = (e: MessageEvent<{ type: string; data?: Float32Array[] }>) => {
    if (e.data.type === 'chunk' && e.data.data) buf.push(e.data.data)
    else if (e.data.type === 'stopped') done()
  }
  source.connect(node)
  node.connect(ctx.destination) // silent: keeps the tap rendering
  node.port.postMessage({ type: 'start', startAt: ctx.currentTime + 0.01 })
  tap = { node, source, buf, stopped, label }
  useTakes.setState({ t0: performance.now() })
}

/** Stops and saves the take running (null: none, or nothing was heard). */
export async function stopTake(): Promise<Take | null> {
  const t = tap
  tap = null
  useTakes.setState({ t0: null })
  if (!t) return null
  t.node.port.postMessage({ type: 'stop' })
  await t.stopped
  t.node.port.onmessage = null
  t.source.disconnect(t.node)
  t.node.disconnect()
  const span = t.buf.span()
  if (span[1] <= span[0]) return null
  const n = useTakes.getState().n + 1
  const name = `FoxBox take ${n}${t.label}.wav`
  const b = bridge()
  const path = b ? await b.saveClip(name, await t.buf.wav(span).arrayBuffer()) : name
  const take = { name: path.split('/').pop() ?? name, path, seconds: (span[1] - span[0]) / t.buf.rate }
  useTakes.setState((s) => ({ n, recent: [take, ...s.recent].slice(0, 3) }))
  return take
}

/** Stops the take running and says so: "Take 3 saved" (its file draggable from the toast too). */
export async function finishTake(): Promise<void> {
  try {
    const take = await stopTake()
    if (take) toast.success(`Take ${useTakes.getState().n} saved`, { detail: take.name, dragPath: take.path })
    else toast.warn('Nothing to save', { detail: 'The take was silent.' })
  } catch (e) {
    toast.error('Take not saved', { detail: (e as Error).message })
  }
}
