import { linkClock } from '@/visuals/engines/link/clock'
import type { AudioFrame } from './registry'

/**
 * 1.4: while Ableton Link sync is on (S3's LINK toggle, e.g. with Rekordbox), the beat clock is Link's: tempo, beat
 * phase and bar phase come from the session, so the visuals land on the DJ's grid. Otherwise the frame is unchanged.
 */
export function withLink(a: AudioFrame): AudioFrame {
  const link = linkClock.now()
  if (!link) return a
  return { ...a, bpm: link.bpm, beatPhase: link.beatPhase, barPhase: link.barPhase, bar: Math.floor(link.beat / 4) + 1 }
}
