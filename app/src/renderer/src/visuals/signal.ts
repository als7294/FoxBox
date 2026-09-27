import type { RenderInfo } from '@/api/types'
import { player } from '@/audio/playerInstance'
import { useStudio } from '@/state/studio'
import { geometry, type Geom, type Word } from './draw'
import { vis } from './state'

const words = new WeakMap<RenderInfo, Word[]>()

/** The render's words on the output timeline (for labels, the voice core and the beat readout). */
export function renderWords(r: RenderInfo | null | undefined): Word[] {
  if (!r) return []
  let out = words.get(r)
  if (!out) {
    out = r.segments.flatMap((s) => s.words ?? []).map((w) => ({ t0: w.start_s, t1: w.end_s, w: w.text, th: w.throw }))
    words.set(r, out)
  }
  return out
}

/** Grid geometry of what's shown: the render's own tempo/bars, or the Studio's settings before the first render. */
export function signalGeom(): Geom {
  const s = useStudio.getState()
  const r = s.render
  if (r) return geometry(vis.wet?.duration ?? r.duration_s, r.bpm, r.bars ?? null)
  return geometry(0, s.bpm, s.bars === 'auto' ? 4 : s.bars)
}

/** Speech end when it overflows the file's bars (hatched on the grid), else 0. */
export function overflowEnd(): number {
  const r = useStudio.getState().render
  return r && r.fit.status === 'overflow' ? r.first_word_s + r.fit.speech_s : 0
}

/** Playhead position, or null when stopped at the start (no playhead drawn). */
export function playhead(): number | null {
  const t = player.currentTime
  return player.isPlaying || t > 0 ? t : null
}
