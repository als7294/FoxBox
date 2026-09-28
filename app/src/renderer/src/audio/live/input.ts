/**
 * LIVE INPUT (1.4 VISUALS): the DJ's own output as the visuals' source. Listen-only: analysed, never played out (it's
 * already coming out of the DJ's system), so there's no double audio and no feedback.
 *
 *   system     Mac system audio (Rekordbox, anything playing): getDisplayMedia + the main process's loopback handler
 *              (Chromium's Core Audio tap; macOS 14.2+, "System Audio Recording" permission). The video track the
 *              API insists on is our own window, dropped at once.
 *   interface  an audio-interface input, e.g. the mixer's USB record out: pick the channel pair (1-based).
 *   mic        any input device (a room mic pointed at the booth monitors works too).
 *
 * `openLiveInput(spec)` → LiveInput: `tap` (the whole signal: analyser, rms, bands, onsets, fft) and `stems` (the
 * real-time stem approximator), plus `close()`. `visuals/live/inputSource.ts` turns it into AudioFrames.
 */
import processorsUrl from './worklets/live-processors.js?url'
import { AudioTapImpl, type AudioTap } from './bus'
import { LiveStems } from './stems'

export type LiveInputSpec =
  | { kind: 'system' }
  | { kind: 'interface'; deviceId: string; /** 1-based, e.g. [3, 4] */ channels?: [number, number] }
  | { kind: 'mic'; deviceId?: string }

export interface AudioInputDevice {
  deviceId: string
  label: string
}

const RAW: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }

/** Audio inputs (labels appear once the user has allowed one device). */
export async function listAudioInputs(): Promise<AudioInputDevice[]> {
  const all = await navigator.mediaDevices.enumerateDevices()
  return all.filter((d) => d.kind === 'audioinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Input ${i + 1}` }))
}

export class LiveInputError extends Error {
  constructor(
    readonly code: 'no-system-audio' | 'denied' | 'no-device',
    message: string,
  ) {
    super(message)
  }
}

async function streamFor(spec: LiveInputSpec): Promise<MediaStream> {
  try {
    if (spec.kind === 'system') {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: RAW })
      for (const t of s.getVideoTracks()) t.stop()
      if (!s.getAudioTracks().length) {
        throw new LiveInputError('no-system-audio', 'System audio isn’t available: it needs macOS 14.2 or later and FoxBox allowed under System Audio Recording (System Settings → Privacy & Security).')
      }
      return s
    }
    if (spec.kind === 'interface') {
      return await navigator.mediaDevices.getUserMedia({ audio: { ...RAW, deviceId: { exact: spec.deviceId }, channelCount: { ideal: 8 } } })
    }
    return await navigator.mediaDevices.getUserMedia({ audio: { ...RAW, ...(spec.deviceId ? { deviceId: { exact: spec.deviceId } } : {}) } })
  } catch (err) {
    if (err instanceof LiveInputError) throw err
    const name = (err as DOMException).name
    if (name === 'NotAllowedError') throw new LiveInputError('denied', 'FoxBox wasn’t allowed to listen to that input.')
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new LiveInputError('no-device', 'That input isn’t connected.')
    throw err
  }
}

export class LiveInput {
  private constructor(
    readonly ctx: AudioContext,
    readonly stream: MediaStream,
    readonly tap: AudioTap,
    readonly stems: LiveStems,
    readonly label: string,
    private readonly tapImpl: AudioTapImpl,
  ) {}

  static async open(spec: LiveInputSpec): Promise<LiveInput> {
    const stream = await streamFor(spec)
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    try {
      await ctx.audioWorklet.addModule(processorsUrl)
      const src = ctx.createMediaStreamSource(stream)
      let node: AudioNode = src
      if (spec.kind === 'interface' && spec.channels) {
        // the chosen pair of the device's channels (missing ones fall back to the first)
        const n = Math.max(1, src.channelCount, stream.getAudioTracks()[0]?.getSettings().channelCount ?? 2)
        src.channelCount = n
        src.channelCountMode = 'explicit'
        src.channelInterpretation = 'discrete'
        const split = ctx.createChannelSplitter(n)
        const merge = ctx.createChannelMerger(2)
        src.connect(split)
        const [l, r] = spec.channels.map((c) => (c >= 1 && c <= n ? c - 1 : 0))
        split.connect(merge, l!, 0)
        split.connect(merge, r!, 1)
        node = merge
      }
      const analyser = new AnalyserNode(ctx, { fftSize: 2048 })
      node.connect(analyser)
      const tapImpl = new AudioTapImpl(ctx, analyser)
      const label = stream.getAudioTracks()[0]?.label || (spec.kind === 'system' ? 'System audio' : 'Input')
      return new LiveInput(ctx, stream, tapImpl, new LiveStems(ctx, node), label, tapImpl)
    } catch (err) {
      for (const t of stream.getTracks()) t.stop()
      await ctx.close().catch(() => {})
      throw err
    }
  }

  /** The analysis lag, ms: the input device and the context (nothing is played out). */
  latencyMs(): number {
    const input = (this.stream.getAudioTracks()[0]?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined)?.latency ?? 0
    return (input + this.ctx.baseLatency) * 1000
  }

  async close(): Promise<void> {
    this.stems.dispose()
    this.tapImpl.dispose()
    for (const t of this.stream.getTracks()) t.stop()
    await this.ctx.close()
  }
}

/** Opens a LIVE INPUT source (see the module doc). Throws LiveInputError with a user-facing message. */
export function openLiveInput(spec: LiveInputSpec): Promise<LiveInput> {
  return LiveInput.open(spec)
}
