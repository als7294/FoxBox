/**
 * The FRAME's loop (2.0), the parts both modes share: the styles (the fvwks-frame worklet's `style`: S3's six fronts in
 * GLASS_TYPES' order, then their flip sides in FLIP_SIDE's) and PLAY's tempo, found from the plucks (REMIX has the
 * song's grid). The DSP is the worklet's. The frame turned over (S3's glassSignal().flipped) shows its style's partner
 * (ECHO TRAIL/SLIT-SCAN, PRISM/X-RAY, HALFTONE/SCANLINES, KALEIDO/MIRROR, DATAMOSH/LIQUID, THERMAL/ICE), the loop backwards.
 */
export const FRAME_STYLES = ['echo', 'prism', 'halftone', 'kaleido', 'datamosh', 'thermal', 'slitscan', 'xray', 'scanlines', 'mirror', 'liquid', 'ice'] as const

/** S3's glass type as the worklet's style: 1 ECHO TRAIL … 12 ICE, 0 none ('plain', anything else). */
export const frameStyle = (type: string | undefined): number => FRAME_STYLES.indexOf(type as (typeof FRAME_STYLES)[number]) + 1

export const BPM_MIN = 70
export const BPM_MAX = 180
const CHORD_S = 0.08 // plucks closer than this are one onset (both hands at once)
const PHRASE_S = 2 // a gap longer than this starts a new phrase: its gaps aren't beats

/**
 * PLAY's beat from the plucks: the median gap of the last 8, folded by octaves into BPM_MIN-BPM_MAX, the beat on the
 * latest pluck. Null until 3 plucks of a phrase; then held when the plucking stops (and through a new phrase's first
 * two plucks, re-anchored on each).
 */
export function createTempo() {
  let onsets: number[] = []
  let bpm = 0
  let anchor = 0
  return {
    /** A pluck at context time `t` (s). */
    pluck(t: number): void {
      const last = onsets.at(-1)
      if (last !== undefined && t - last < CHORD_S) return
      if (last !== undefined && t - last > PHRASE_S) onsets = []
      onsets = [...onsets, t].slice(-9)
      if (onsets.length >= 3) {
        const gaps = onsets.slice(1).map((x, i) => x - onsets[i]!).sort((a, b) => a - b)
        let beat = gaps[gaps.length >> 1]!
        while (60 / beat > BPM_MAX) beat *= 2
        while (60 / beat < BPM_MIN) beat /= 2
        bpm = 60 / beat
      }
      if (bpm) anchor = t
    },
    /** The beat at context time `now`: its tempo and how far through it (0-1); null before there's one. */
    clock(now: number): { bpm: number; phase: number } | null {
      if (!bpm) return null
      const x = ((now - anchor) * bpm) / 60
      return { bpm, phase: x - Math.floor(x) }
    },
    /** For the worklet: {bpm, anchor} (a beat's context time), or null. */
    get grid(): { bpm: number; anchor: number } | null {
      return bpm ? { bpm, anchor } : null
    },
  }
}
export type Tempo = ReturnType<typeof createTempo>
