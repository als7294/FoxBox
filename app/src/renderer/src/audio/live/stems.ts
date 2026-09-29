/**
 * Stems for the visuals (1.4): AudioFrame.stems from
 *   TRACK mode   the song's precomputed features (v0.9 StemFeatures, GET /api/songs/{id}/stems/features), read at
 *                the playhead: StemTrack / StemTrackReader;
 *   LIVE INPUT   the real-time approximator (the fvwks-stems worklet; no precompute there): LiveStems.
 * Both give rms 0..1 (normalised per song, or by a slow running max live) and onset (0, or ≥ 1 on a hit).
 */
import type { AudioFrame, BassLine, StemId } from '@/visuals/live/registry'

export type StemsFrame = NonNullable<AudioFrame['stems']>
export type BassStyle = NonNullable<AudioFrame['feel']>['style']
const STEM_IDS: readonly StemId[] = ['drums', 'bass', 'vocals', 'other']

/** The v0.9 StemFeatures JSON (the server's response), as far as the reader needs it. */
export interface StemFeaturesJson {
  fps: number
  frames: number
  tracks: string[]
  data_b64: string
  /** v0.10.1: 4 bytes a frame from the bass stem: flags (bit0 on, bit1 note start), sub, growl, pitch (MIDI x 2). */
  bass_b64?: string | null
}

/** The v0.10.1 bass fields of a Song.structure section. */
export interface BassSectionJson {
  start_s: number
  end_s: number
  bass_style?: BassStyle | null
  half_time?: boolean
  note_beats?: number | null
  wobble_div?: string | null
  wobble_anchor_s?: number | null
}

/** A wobble division's length in beats. */
export const DIVISIONS: Record<string, number> = { '1/4T': 2 / 3, '1/8': 0.5, '1/8T': 1 / 3, '1/16': 0.25, '1/16T': 1 / 6 }

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
  /** The bass line's bytes (frames x 4), or null for features without it. */
  readonly bass: Uint8Array | null

  constructor(json: StemFeaturesJson) {
    this.fps = json.fps
    this.tracks = json.tracks
    this.data = b64(json.data_b64)
    this.frames = Math.min(json.frames, Math.floor(this.data.length / (2 * json.tracks.length)))
    this.bass = json.bass_b64 ? b64(json.bass_b64) : null
  }

  /** AudioFrame.bass at frame `f` (a note start anywhere in [f0, f] counts) and song time `t`, at `bpm`, in `sec`. */
  bassAt(f: number, f0: number, t: number, bpm: number, sec: BassSectionJson | undefined): BassLine | undefined {
    const b = this.bass
    if (!b || f < 0 || 4 * f + 3 >= b.length) return undefined
    const beat = 60 / Math.max(40, bpm || 120)
    const on = (b[4 * f]! & 1) === 1
    let noteOn = false
    for (let i = Math.max(0, f0); i <= f; i++) if (b[4 * i]! & 2) noteOn = true
    // the note's start: back while it stays on, to its start flag (at most 32 beats)
    let start = f
    if (on) while (start > 0 && start > f - 32 * beat * this.fps && !(b[4 * start]! & 2) && b[4 * (start - 1)]! & 1) start--
    const held = on ? (f - start) / this.fps : 0
    const midi = (i: number) => (i >= 0 ? b[4 * i + 3]! / 2 : 0)
    // a slide: the pitch moving 3-60 semitones a second over the last 8 frames (the bytes are half-semitone steps), once
    // the note has settled (150 ms)
    const k = 8
    let glide = 0
    if (on && held >= 0.15 && midi(f) && midi(f - k)) {
      const perS = ((midi(f) - midi(f - k)) * this.fps) / k
      if (Math.abs(perS) >= 3 && Math.abs(perS) <= 60) glide = perS * beat
    }
    const div = sec?.wobble_div && DIVISIONS[sec.wobble_div] ? sec.wobble_div : null
    const period = div ? DIVISIONS[div]! * beat : 0
    const phase = div ? (((t - (sec?.wobble_anchor_s ?? sec!.start_s)) / period) % 1 + 1) % 1 : 0
    return {
      on,
      noteOn,
      heldBeats: held / beat,
      expectBeats: sec?.note_beats ?? 1,
      sub: b[4 * f + 1]! / 255,
      growl: b[4 * f + 2]! / 255,
      pitch: midi(f) ? 440 * 2 ** ((midi(f) - 69) / 12) : null,
      glide,
      wobble: { div, phase },
    }
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

  /** The stems at the playhead; with the song's `bpm` and structure `sections`, the bass line and its feel too. */
  read(
    positionS: number,
    bpm = 0,
    sections?: readonly BassSectionJson[],
  ): { stems: StemsFrame; mix: { rms: number; onset: number }; bass?: BassLine; feel?: AudioFrame['feel'] } {
    const f = this.track.frameAt(positionS)
    const from = f > this.last && f - this.last <= this.track.fps / 2 ? this.last + 1 : f
    this.last = f
    const stems: StemsFrame = {}
    for (const id of STEM_IDS) if (this.track.tracks.includes(id)) stems[id] = this.track.value(id, f, from)
    const sec = sections?.find((s) => positionS >= s.start_s && positionS < s.end_s)
    const bass = this.track.bassAt(f, from, positionS, bpm, sec)
    const feel = bass && sec && 'half_time' in sec ? { halfTime: Boolean(sec.half_time), style: sec.bass_style ?? 'other' } : undefined
    return { stems, mix: this.track.value('mix', f, from), bass, feel }
  }
}

/** The real-time approximator's reader: the worklet posts 60 levels a second; `read()` gives the latest levels and the
 * strongest onset per stem since the previous read. */
export class LiveStems {
  readonly node: AudioWorkletNode
  private readonly latest = new Float32Array(12)
  private readonly peak = new Float32Array(4)
  /** The growl envelope's last 512 frames (60 fps, oldest first once full) and the audio time of the newest. */
  readonly growlHistory = new Float32Array(512)
  private growlN = 0
  private growlT = 0

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
      this.growlHistory.copyWithin(0, 1)
      this.growlHistory[this.growlHistory.length - 1] = e.data.s[9] ?? 0
      this.growlN = Math.min(this.growlN + 1, this.growlHistory.length)
      this.growlT = (e.data as { t?: number }).t ?? 0
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

  /** The bass line's raw levels (linear RMS: sub < 60 Hz, growl 100-600 Hz, total 30-600 Hz), the sub's f0 in Hz (0 =
   * unpitched), and the growl envelope's history (the last `n` frames of `growlHistory`, the newest at time `t`). */
  bassRaw(): { sub: number; growl: number; total: number; f0: number; n: number; t: number } {
    const l = this.latest
    return { sub: l[8]!, growl: l[9]!, total: l[10]!, f0: l[11]!, n: this.growlN, t: this.growlT }
  }

  dispose(): void {
    this.node.port.onmessage = null
    this.source.disconnect(this.node)
    this.node.disconnect()
  }
}
