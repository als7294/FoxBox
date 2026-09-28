// "Sync to Rekordbox" (1.4): the Ableton Link session's tempo and beat, for the stage's AudioFrames. Main runs the
// Link helper while sync is on and sends ~60 updates a second; between them the beat is extrapolated at the session
// tempo. Every window (the stage, the output window) keeps its own clock from the same updates.
import type { LinkState } from '@shared/bridge'
import { bridge } from '@/env'

export interface LinkNow {
  bpm: number
  /** Session beat (fractional); beatPhase 0–1 through the beat; barPhase 0–1 through the Link quantum (a bar). */
  beat: number
  beatPhase: number
  barPhase: number
  peers: number
}

const STALE_MS = 1000
let last: { state: LinkState; t: number } | null = null
let unsubscribe: (() => void) | null = null
const listeners = new Set<() => void>()
let status: { on: boolean; peers: number; error: string | null } = { on: false, peers: 0, error: null }

function setStatus(next: Partial<typeof status>): void {
  const merged = { ...status, ...next }
  if (merged.on === status.on && merged.peers === status.peers && merged.error === status.error) return
  status = merged
  for (const l of listeners) l()
}

function listen(): void {
  const api = bridge()?.link
  if (!api || unsubscribe) return
  unsubscribe = api.onState((state) => {
    last = state ? { state, t: performance.now() } : null
    setStatus({ on: state !== null || status.on, peers: state?.peers ?? 0 })
  })
}

export const linkClock = {
  available: (): boolean => Boolean(bridge()?.link),
  status: () => status,
  /** Join or leave the Link session (the helper runs only while on). */
  async setEnabled(on: boolean): Promise<void> {
    const api = bridge()?.link
    if (!api) return
    listen()
    const res = await api.setEnabled(on)
    if (!on) last = null
    setStatus({ on: on && res.running, error: res.error, peers: on ? status.peers : 0 })
  },
  setTempo(bpm: number): void {
    bridge()?.link?.setTempo(bpm)
  },
  /** Tempo and beat right now, or null when sync is off (or the helper has gone quiet). */
  now(): LinkNow | null {
    if (!last) return null
    const dt = performance.now() - last.t
    if (dt > STALE_MS) return null
    const s = last.state
    const beat = s.beat + (dt / 1000) * (s.tempo / 60)
    const q = s.quantum > 0 ? s.quantum : 4
    return { bpm: s.tempo, beat, beatPhase: beat - Math.floor(beat), barPhase: (((beat % q) + q) % q) / q, peers: s.peers }
  },
  subscribe(cb: () => void): () => void {
    listen()
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
}
