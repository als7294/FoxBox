/**
 * Stems for the visuals (1.4): AudioFrame.stems from
 *   TRACK mode   the song's precomputed features (v0.9 StemFeatures, GET /api/songs/{id}/stems/features), read at
 *                the playhead: StemTrack / StemTrackReader;
 *   LIVE INPUT   the real-time approximator (the fvwks-stems worklet; no precompute there): LiveStems.
 * Both give rms 0..1 (normalised per song, or by a slow running max live) and onset (0, or ≥ 1 on a hit).
 */
import type { AudioFrame, StemId } from '@/visuals/live/registry'

export type StemsFrame = NonNullable<AudioFrame['stems']>
const STEM_IDS: readonly StemId[] = ['drums', 'bass', 'vocals', 'other']

/** The v0.9 StemFeatures JSON (the server's response), as far as the reader needs it. */
export interface StemFeaturesJson {
  fps: number
  frames: number
  tracks: string[]
  data_b64: string
}

function b64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** A song's decoded features: frame-major (rms, onset) bytes for each track. */
export class StemTrack {
  readonly fps: number
  readonly frames: number
  readonly tracks: string[]
  private readonly data: Uint8Array

  constructor(json: StemFeaturesJson) {
    this.fps = json.fps
    this.tracks = json.tracks
    this.data = b64(json.data_b64)
    this.frames = Math.min(json.frames, Math.floor(this.data.length / (2 * json.tracks.length)))
  }

  /** rms 0..1 and onset (≥ 1 on a hit) of `track` at frame `f`; the strongest onset over frames [f0, f]. */
  value(track: string, f: number, f0 = f): { rms: number; onset: number } {
    const k = this.tracks.indexOf(track)
    if (k < 0 || f < 0 || f >= this.frames) return { rms: 0, onset: 0 }
    const w = 2 * this.tracks.length
    let onset = 0
    for (let i = Math.max(0, f0); i <= f; i++) onset = Math.max(onset, this.data[i * w + 2 * k + 1]! / 64)
    return { rms: this.data[f * w + 2 * k]! / 255, onset: onset >= 1 ? onset : 0 }
  }

  frameAt(positionS: number): number {
    return Math.floor(positionS * this.fps + 1e-6)
  }
}

/** Reads the stems at the playhead each render frame; an onset between two reads is never missed (playback ahead by
 * up to 0.5 s counts every frame since the last read; a seek reads just the new frame). */
export class StemTrackReader {
  private last = -1

  constructor(readonly track: StemTrack) {}

  read(positionS: number): { stems: StemsFrame; mix: { rms: number; onset: number } } {
    const f = this.track.frameAt(positionS)
    const from = f > this.last && f - this.last <= this.track.fps / 2 ? this.last + 1 : f
    this.last = f
    const stems: StemsFrame = {}
    for (const id of STEM_IDS) if (this.track.tracks.includes(id)) stems[id] = this.track.value(id, f, from)
    return { stems, mix: this.track.value('mix', f, from) }
  }
}

/** The real-time approximator's reader: the worklet posts 60 levels a second; `read()` gives the latest levels and the
 * strongest onset per stem since the previous read. */
export class LiveStems {
  readonly node: AudioWorkletNode
  private readonly latest = new Float32Array(8)
  private readonly peak = new Float32Array(4)

  /** `ctx` must have loaded the live worklets (live-processors.js). */
  constructor(
    ctx: BaseAudioContext,
    private readonly source: AudioNode,
  ) {
    this.node = new AudioWorkletNode(ctx, 'fvwks-stems', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit',
    })
    this.node.port.onmessage = (e: MessageEvent<{ s: Float32Array }>) => {
      this.latest.set(e.data.s)
      for (let i = 0; i < 4; i++) this.peak[i] = Math.max(this.peak[i]!, e.data.s[2 * i + 1]!)
    }
    source.connect(this.node)
    this.node.connect(ctx.destination) // silent output: keeps the worklet rendering
  }

  read(): StemsFrame {
    const out: StemsFrame = {}
    STEM_IDS.forEach((id, i) => {
      out[id] = { rms: this.latest[2 * i]!, onset: this.peak[i]! }
      this.peak[i] = 0
    })
    return out
  }

  dispose(): void {
    this.node.port.onmessage = null
    this.source.disconnect(this.node)
    this.node.disconnect()
  }
}
