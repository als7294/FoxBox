/**
 * Drop anatomy markers (pure): where GAP, FIRST HIT, PAUSE and SWITCH sit, in remix beats, from the drops and the take's
 * choices as BUILD records them (S2): drop.gap "1" · drop.pause "bar8" | "bar12" | "none" · drop.pause_len "0.5" | "1" |
 * "2" · drop.cadence "4+8" | "8", each for every drop. FIRST HIT is every drop's start; a take without a drop.gap choice
 * gets the 1-beat GAP. Anything else (unknown, or declared but inactive: gap "0.5", cadence "bar") is no marker.
 */
import type { RemixSection, RemixTake } from '@/api/remix'
import { sectionBeat } from './arrangement'

export type MarkerKind = 'gap' | 'first' | 'pause' | 'switch'
export interface DropMark {
  kind: MarkerKind
  /** Where it starts, in remix beats (a GAP, PAUSE or the trap switch-up runs `beats` from there). */
  beat: number
  beats: number
  /** Which drop, 0-based. */
  drop: number
}

const GAP: Record<string, number> = { '1': 1 }
const PAUSE_BAR: Record<string, number> = { bar8: 8, bar12: 12 }
const PAUSE_LEN: Record<string, number> = { '0.5': 0.5, '1': 1, '2': 2 }
const EVERY: Record<string, number> = { '4+8': 4, '8': 8 }

export function dropMarkers(
  r: { sections: RemixSection[]; beats_per_bar: number },
  take: Pick<RemixTake, 'style' | 'choices'> | undefined,
): DropMark[] {
  const bpb = r.beats_per_bar
  const pick = (axis: string) => take?.choices.find((c) => c.axis === axis)?.option
  const gapOpt = pick('drop.gap')
  const gap = gapOpt == null ? 1 : GAP[gapOpt]
  const pauseOpt = pick('drop.pause')
  const len = PAUSE_LEN[pick('drop.pause_len') ?? '1']
  const every = EVERY[pick('drop.cadence') ?? '']
  const out: DropMark[] = []
  r.sections
    .filter((s) => s.kind === 'drop')
    .forEach((s, drop) => {
      const at = sectionBeat(s, bpb)
      // TRAP-HYBRID answers the drop with a 2-beat switch-up where the others leave the gap.
      if (take?.style === 'trap_hybrid') out.push({ kind: 'switch', beat: at - 2, beats: 2, drop })
      else if (gap) out.push({ kind: 'gap', beat: at - gap, beats: gap, drop })
      out.push({ kind: 'first', beat: at, beats: 0, drop })
      // The pause ends its bar of the drop; a drop shorter than 12 bars takes it at bar 8.
      let bar = pauseOpt ? PAUSE_BAR[pauseOpt] : undefined
      if (bar === 12 && s.bars < 12) bar = 8
      const pause = bar && len && bar <= s.bars ? at + bar * bpb - len : null
      if (pause != null) out.push({ kind: 'pause', beat: pause, beats: len!, drop })
      for (let b = every ?? s.bars; b < s.bars; b += every!)
        if (pause == null || Math.abs(pause + len! - (at + b * bpb)) >= bpb)
          out.push({ kind: 'switch', beat: at + b * bpb, beats: 0, drop })
    })
  return out.sort((a, b) => a.beat - b.beat)
}
