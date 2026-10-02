import { create } from 'zustand'
import type { LatencyMode } from '@/audio/live'
import { loadPrefs, type AudioSource } from '@/components/visuals/page'

export type TalkMode = 'open' | 'ptt' | 'latch'

export interface Level {
  /** Linear 0..1 over the last 2048 samples. */
  peak: number
  rms: number
}

interface LiveAudio {
  /** The AUDIO SOURCE (LiveScreen arms or closes the mic, and remembers it in the page prefs). */
  source: AudioSource
  /** 'balanced' is shown as SAFE. LiveScreen hands it to the running engine. */
  latency: LatencyMode
  talkMode: TalkMode
  /** PUSH held / LATCH on / MUTE over all of them. */
  held: boolean
  latched: boolean
  muted: boolean
  /** The live engine runs / it has the mic (TRACK starts without it). */
  on: boolean
  micOpen: boolean
  /** The analysers the levels read (LiveScreen keeps them current): the song deck, LIVE INPUT's capture, the mic. */
  taps: Record<AudioSource, AnalyserNode | null>
  setSource(source: AudioSource): void
  setLatency(mode: LatencyMode): void
  setTalkMode(mode: TalkMode): void
  setMuted(muted: boolean): void
  /** The talk control (PUSH, Space, a MIDI note or pedal): holds in PUSH, toggles on press in LATCH. */
  talk(down: boolean): void
}

export const useLiveAudio = create<LiveAudio>((set, get) => ({
  source: loadPrefs().source,
  latency: 'low',
  talkMode: 'open',
  held: false,
  latched: false,
  muted: false,
  on: false,
  micOpen: false,
  taps: { track: null, input: null, mic: null },
  setSource: (source) => set({ source }),
  setLatency: (latency) => set({ latency }),
  setTalkMode: (talkMode) => set({ talkMode, held: false, latched: false }),
  setMuted: (muted) => set({ muted }),
  talk: (down) => {
    const mode = get().talkMode
    if (mode === 'ptt') set({ held: down })
    else if (mode === 'latch' && down) set({ latched: !get().latched })
  },
}))

/** The mic reaches the mask: open, held in PUSH, or latched, and not muted. */
export const isTalking = (s: Pick<LiveAudio, 'muted' | 'talkMode' | 'held' | 'latched'>): boolean =>
  !s.muted && (s.talkMode === 'open' || (s.talkMode === 'ptt' ? s.held : s.latched))

const SILENT: Level = { peak: 0, rms: 0 }
const scratch = new Float32Array(2048)

/** Peak and RMS of an analyser's last frame: cheap enough to call every animation frame. */
export function readLevel(node: AnalyserNode | null): Level {
  if (!node) return SILENT
  const buf = node.fftSize <= scratch.length ? scratch.subarray(0, node.fftSize) : new Float32Array(node.fftSize)
  node.getFloatTimeDomainData(buf)
  let peak = 0
  let sum = 0
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i]!
    peak = Math.max(peak, Math.abs(v))
    sum += v * v
  }
  return { peak, rms: Math.sqrt(sum / buf.length) }
}

/** The active AUDIO SOURCE's level (the IN LEDs): TRACK the song, LIVE INPUT the capture, MIC the mic. */
export function sourceLevel(): Level {
  const s = useLiveAudio.getState()
  return readLevel(s.taps[s.source])
}

/** The mic after its input gain (the VOICE strip); silent while the mic is closed. */
export const micLevel = (): Level => readLevel(useLiveAudio.getState().taps.mic)

/** LEDs lit for a peak: `n` steps over floorDb..0 dBFS (any signal above the floor lights one). */
export function ledsLit(peak: number, n = 12, floorDb = -48): number {
  if (peak <= 0) return 0
  const db = 20 * Math.log10(peak)
  return Math.max(0, Math.min(n, Math.ceil(((db - floorDb) / -floorDb) * n)))
}
