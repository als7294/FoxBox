/**
 * SAVE CLIP's offline render: a promo clip of a stretch of the song (the whole song, a bar range, or the drop's clip
 * with the Studio's drop over it), with the VISUALS scene as the picture. Frame by frame, faster than real time:
 * the compositor is stepped at exactly 1/fps per frame from AudioFrames read out of the decoded audio (clipFrames) and
 * the song's stem features, each frame is encoded (H.264, WebCodecs), the sound is mixed offline and encoded (AAC,
 * else Opus), and both go into a plain MP4 (mp4.ts). Frame n is song time from + n/fps, whatever the machine's speed.
 */
import type { Scene } from '@/visuals/live/compositor'
import { Compositor } from '@/visuals/live/compositorEngine'
import { clipFrames } from '@/visuals/live/clipSource'
import { drawWatermark, type Layout } from '@/components/camera/compose'
import type { SongGrid } from '@/state/song'
import { stemsAt, type Features } from './features'
import { markClipRendering } from './rendering'
import { avc1Entry, mp4aEntry, opusEntry, writeMp4, type Sample } from './mp4'

export type ClipAspect = '9:16' | '16:9' | '1:1'

export const CLIP_SIZE: Record<ClipAspect, [number, number]> = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080] }

const FPS = 30
const SR = 48_000
const VIDEO_BITRATE = 8_000_000
const AUDIO_BITRATE = 192_000
const FADE_IN_S = 0.03
const FADE_OUT_S = 1
/** Chromium's DynamicsCompressorNode looks 6 ms ahead: the limited mix comes out this late (measured on a click track). */
const LIMITER_DELAY = Math.round(0.006 * SR)

export interface ClipDrop {
  buffer: AudioBuffer
  /** Where the drop starts, in song time (s). */
  at: number
  /** Where its voice ends, from its start (s): the song is ducked until then. */
  voiceEnd: number
}

export interface ClipJob {
  scene: Scene
  aspect: ClipAspect
  song: AudioBuffer
  grid: SongGrid | null
  /** The song's big beat drop (s). */
  beatDrop: number | null
  features: Features | null
  drop: ClipDrop | null
  /** The stretch of the song, in seconds. */
  from: number
  length: number
  /** Gains (linear): the drop, the song, and the song under the voice. */
  levels: { drop: number; song: number; duck: number }
  bpm: number
  watermark: boolean
  onProgress?(fraction: number): void
  signal?: AbortSignal
}

export interface RenderedClip {
  blob: Blob
  name: string
  seconds: number
  /** How much faster than real time it rendered. */
  speed: number
}

/** The clip's sound: the song's stretch (faded at cut edges, ducked under the voice) and the drop, limited. */
export async function mixClip(job: Pick<ClipJob, 'song' | 'drop' | 'from' | 'length' | 'levels'>): Promise<AudioBuffer> {
  const { song, drop, from, length, levels } = job
  const frames = Math.ceil(length * SR)
  const ac = new OfflineAudioContext(2, frames + LIMITER_DELAY, SR)
  const bus = ac.createDynamicsCompressor()
  bus.threshold.value = -3
  bus.knee.value = 0
  bus.ratio.value = 20
  bus.attack.value = 0.002
  bus.release.value = 0.1
  bus.connect(ac.destination)
  const shape = ac.createGain()
  const songGain = ac.createGain()
  songGain.gain.value = levels.song
  shape.connect(songGain).connect(bus)
  const g = shape.gain
  g.setValueAtTime(from > 0 ? 0 : 1, 0)
  g.linearRampToValueAtTime(1, FADE_IN_S)
  const dropAt = drop ? drop.at - from : null
  if (drop && dropAt != null && dropAt < length && dropAt + drop.buffer.duration > 0) {
    const voiceEnd = dropAt + drop.voiceEnd
    g.setValueAtTime(1, Math.max(FADE_IN_S, dropAt - 0.15))
    g.linearRampToValueAtTime(levels.duck, Math.max(FADE_IN_S, dropAt))
    g.setValueAtTime(levels.duck, Math.max(FADE_IN_S, voiceEnd - 0.05))
    g.linearRampToValueAtTime(1, Math.max(FADE_IN_S, voiceEnd))
    const dropGain = ac.createGain()
    dropGain.gain.value = levels.drop
    dropGain.connect(bus)
    const src = ac.createBufferSource()
    src.buffer = drop.buffer
    src.connect(dropGain)
    // A drop that starts before the clip plays from the part inside it.
    src.start(Math.max(0, dropAt), Math.max(0, -dropAt))
  }
  if (from + length < song.duration - 0.01 && length > FADE_OUT_S * 2) {
    g.setValueAtTime(1, length - FADE_OUT_S)
    g.linearRampToValueAtTime(0, length)
  }
  const src = ac.createBufferSource()
  src.buffer = song
  src.connect(shape)
  src.start(0, from, length)
  // Drop the limiter's lookahead, so the sound sits exactly on the song's time (and the pictures).
  const late = await ac.startRendering()
  const out = new AudioBuffer({ numberOfChannels: 2, length: frames, sampleRate: SR })
  for (let c = 0; c < 2; c++) out.copyToChannel(late.getChannelData(c).subarray(LIMITER_DELAY), c)
  return out
}

/** The scene as a clip can draw it: there's no camera offline. */
function clipScene(scene: Scene): Scene {
  return scene.base.kind === 'camera' ? { ...scene, base: { kind: 'none' } } : scene
}

const aborted = () => new DOMException('The clip was cancelled.', 'AbortError')

type AudioCodec = AudioEncoderConfig & { codec: 'mp4a.40.2' | 'opus' }

/** Runs an encoder over planar stereo `left`/`right`: its packets and its stream description. */
async function encode(
  config: AudioCodec,
  left: Float32Array,
  right: Float32Array,
  signal?: AbortSignal,
): Promise<{ samples: Sample[]; description: Uint8Array | null }> {
  const samples: Sample[] = []
  let description: Uint8Array | null = null
  let failed: unknown = null
  const packet = config.codec === 'opus' ? 960 : 1024
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      const d = meta?.decoderConfig?.description
      if (d && !description) description = toBytes(d)
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      samples.push({ data, duration: Math.round(((chunk.duration ?? 0) * SR) / 1e6) || packet, key: true })
    },
    error: (e) => (failed = e),
  })
  enc.configure(config)
  const block = 4800
  for (let at = 0; at < left.length; at += block) {
    if (signal?.aborted) throw aborted()
    const n = Math.min(block, left.length - at)
    const data = new Float32Array(n * 2)
    data.set(left.subarray(at, at + n), 0)
    data.set(right.subarray(at, at + n), n)
    const ad = new AudioData({
      format: 'f32-planar',
      sampleRate: SR,
      numberOfFrames: n,
      numberOfChannels: 2,
      timestamp: Math.round((at / SR) * 1e6),
      data,
    })
    enc.encode(ad)
    ad.close()
  }
  await enc.flush()
  enc.close()
  if (failed) throw failed
  return { samples, description }
}

const delays = new Map<string, Promise<number>>()

/**
 * The encoder's delay (priming), measured from its own output: a click encoded and decoded again comes back this many
 * samples late (AAC: 1024 by the spec's convention, 2112 for Apple's encoder). The file's edit list skips it, so the
 * clip's sound lines up with its pictures. Measured once per codec.
 */
function encoderDelay(config: AudioCodec): Promise<number> {
  let d = delays.get(config.codec)
  if (!d) {
    d = (async () => {
      const n = SR / 2
      const at = 4800
      const click = new Float32Array(n)
      click[at] = 0.9
      const { samples, description } = await encode(config, click, click)
      const out: Float32Array[] = []
      let failed: unknown = null
      const dec = new AudioDecoder({
        output: (d) => {
          const x = new Float32Array(d.numberOfFrames)
          d.copyTo(x, { planeIndex: 0, format: 'f32-planar' })
          out.push(x)
          d.close()
        },
        error: (e) => (failed = e),
      })
      dec.configure({ codec: config.codec, sampleRate: SR, numberOfChannels: 2, ...(description ? { description } : {}) })
      let ts = 0
      for (const s of samples) {
        dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round((ts * 1e6) / SR), data: s.data }))
        ts += s.duration
      }
      await dec.flush()
      dec.close()
      if (failed) throw failed
      let best = 0
      let peak = 0
      let i = 0
      for (const x of out) for (const v of x) (Math.abs(v) > peak && ((peak = Math.abs(v)), (best = i)), i++)
      return Math.max(0, best - at)
    })().catch((e: unknown) => {
      delays.delete(config.codec)
      throw e
    })
    delays.set(config.codec, d)
  }
  return d
}

async function encodeAudio(buf: AudioBuffer, signal?: AbortSignal): Promise<{ entry: Uint8Array; samples: Sample[]; skip: number }> {
  const aac: AudioCodec = { codec: 'mp4a.40.2', sampleRate: SR, numberOfChannels: 2, bitrate: AUDIO_BITRATE }
  const opus: AudioCodec = { codec: 'opus', sampleRate: SR, numberOfChannels: 2, bitrate: AUDIO_BITRATE }
  const useAac = (await AudioEncoder.isConfigSupported(aac).catch(() => ({ supported: false }))).supported
  const config = useAac ? aac : opus
  const left = buf.getChannelData(0)
  const { samples, description } = await encode(config, left, buf.numberOfChannels > 1 ? buf.getChannelData(1) : left, signal)
  if (useAac) {
    const skip = await encoderDelay(config)
    return { entry: mp4aEntry(2, SR, description ?? Uint8Array.of(0x11, 0x90), AUDIO_BITRATE), samples, skip }
  }
  // Opus carries its delay as pre-skip (OpusHead bytes 10-11); the edit list skips the same.
  const head = description as Uint8Array | null
  const preSkip = head && head.length >= 12 ? head[10]! | (head[11]! << 8) : 312
  return { entry: opusEntry(2, preSkip), samples, skip: preSkip }
}

function toBytes(d: AllowSharedBufferSource): Uint8Array {
  return d instanceof ArrayBuffer || d instanceof SharedArrayBuffer
    ? new Uint8Array(d.slice(0))
    : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))
}

export function clipFileName(aspect: ClipAspect, at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
  return `foxbox-clip-${stamp}-${aspect.replace(':', 'x')}.mp4`
}

export async function renderClip(job: ClipJob): Promise<RenderedClip> {
  markClipRendering(true)
  try {
    return await renderClipNow(job)
  } finally {
    markClipRendering(false)
  }
}

async function renderClipNow(job: ClipJob): Promise<RenderedClip> {
  const started = performance.now()
  const [w, h] = CLIP_SIZE[job.aspect]
  const frames = Math.max(1, Math.round(job.length * FPS))
  const progress = (f: number) => job.onProgress?.(Math.min(0.999, f))

  const audio = await mixClip(job)
  if (job.signal?.aborted) throw aborted()

  const canvas = document.createElement('canvas')
  const comp = new Compositor(canvas, { output: 'clip' })
  comp.resize(w, h)
  comp.setScene(clipScene(job.scene))
  const ctx = canvas.getContext('2d')!
  const stamp = document.createElement('canvas')
  const L: Layout = { w, h, cam: { x: 0, y: 0, w, h }, wave: { x: 0, y: h, w, h: 0 } }
  const read = clipFrames()
  const dropBuf = job.drop?.buffer ?? null
  const dropAtClip = job.drop ? job.drop.at - job.from : 0
  const song = { buf: job.song, t: 0, grid: job.grid, dropAt: job.beatDrop }

  const video: Sample[] = []
  let avcC: Uint8Array | null = null
  let failed: unknown = null
  let lastTs = -1
  const enc = new VideoEncoder({
    output: (chunk, meta) => {
      const d = meta?.decoderConfig?.description
      if (d && !avcC) avcC = toBytes(d)
      if (chunk.timestamp < lastTs) failed = new Error('The video encoder reordered frames.')
      lastTs = chunk.timestamp
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      video.push({ data, duration: 1000, key: chunk.type === 'key' })
    },
    error: (e) => (failed = e),
  })
  try {
    await comp.ready()
    enc.configure({
      codec: 'avc1.640028',
      width: w,
      height: h,
      bitrate: VIDEO_BITRATE,
      framerate: FPS,
      avc: { format: 'avc' },
      latencyMode: 'quality',
    })
    for (let f = 0; f < frames; f++) {
      if (job.signal?.aborted) throw aborted()
      if (failed) throw failed
      const t = f / FPS
      song.t = job.from + t
      const a = read(dropBuf, dropBuf ? t - dropAtClip : null, job.bpm, song)
      if (job.features) a.stems = stemsAt(job.features, song.t)
      await comp.prepare(a) // a video base seeks to this frame
      comp.frame(a, 1000 / FPS)
      if (job.watermark) drawWatermark(ctx, L, t, stamp)
      const vf = new VideoFrame(canvas, { timestamp: Math.round((f * 1e6) / FPS), duration: Math.round(1e6 / FPS) })
      enc.encode(vf, { keyFrame: f % (FPS * 2) === 0 })
      vf.close()
      while (enc.encodeQueueSize > 4) await new Promise((r) => enc.addEventListener('dequeue', r, { once: true }))
      if (f % 15 === 0) {
        progress((0.9 * f) / frames)
        await new Promise((r) => setTimeout(r, 0)) // let the page breathe
      }
    }
    await enc.flush()
    if (failed) throw failed
  } finally {
    if (enc.state !== 'closed') enc.close()
    comp.dispose()
  }
  if (!avcC) throw new Error('The video encoder gave no stream description.')
  progress(0.92)
  const sound = await encodeAudio(audio, job.signal)
  progress(0.97)
  const bytes = writeMp4([
    { kind: 'video', timescale: FPS * 1000, entry: avc1Entry(w, h, avcC), samples: video, width: w, height: h },
    { kind: 'audio', timescale: SR, entry: sound.entry, samples: sound.samples, skip: sound.skip, length: audio.length },
  ])
  const seconds = (performance.now() - started) / 1000
  job.onProgress?.(1)
  return { blob: new Blob([bytes], { type: 'video/mp4' }), name: clipFileName(job.aspect), seconds, speed: job.length / seconds }
}
