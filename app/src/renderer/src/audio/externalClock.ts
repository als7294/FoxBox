/**
 * An external clock (2.1: Ableton Link; S4's addon in main feeds it at ~60 Hz): its tempo and where it is (its beat on
 * the session's timeline, its phase in its quantum). SAUCE's frame loop and tempo-synced FX follow it instead of the
 * plucks' tempo; REMIX's deck follows it within FOLLOW_RANGE (vinyl: there's no time-stretch here), beat-jumping onto
 * its bar and then nudging (followDeck). Nothing for STALE_MS, or null: it's gone, and everything falls back.
 */
export interface ExternalClock {
  bpm: number
  /** Beats on the session's timeline (fractional). */
  beat: number
  /** Where in the quantum, 0 … quantum (beats). */
  phase: number
  /** Beats in a bar (Link's quantum: 4). */
  quantum: number
}
export const STALE_MS = 1000
export const FOLLOW_RANGE = 0.08 // the deck's speed within ±8 % of the song's (the Board's Tempo range)
const NUDGE_MAX = 0.02 // ±2 % to take up a drift
const JUMP_BEATS = 0.25 // further off than this: a jump on the bar

let latest: { c: ExternalClock; at: number } | null = null
const listeners = new Set<(c: ExternalClock | null) => void>()

/** S4's feed (performance.now() ms of the reading by default); null: Link off. */
export function setExternalClock(c: ExternalClock | null, nowMs = performance.now()): void {
  latest = c && c.bpm > 0 && Number.isFinite(c.beat) ? { c: { ...c, quantum: c.quantum > 0 ? c.quantum : 4 }, at: nowMs } : null
  const now = externalClock(nowMs)
  for (const f of listeners) f(now)
}

/** The clock now (the last reading carried on at its tempo), or null: off, or no reading for STALE_MS. */
export function externalClock(nowMs = performance.now()): ExternalClock | null {
  if (!latest || nowMs - latest.at > STALE_MS) return null
  const { c } = latest, d = (((nowMs - latest.at) / 1000) * c.bpm) / 60
  return { bpm: c.bpm, beat: c.beat + d, phase: (((c.phase + d) % c.quantum) + c.quantum) % c.quantum, quantum: c.quantum }
}

/** Each reading (and null when it goes): the deck's follow. */
export function onExternalClock(f: (c: ExternalClock | null) => void): () => void {
  listeners.add(f)
  return () => listeners.delete(f)
}

/**
 * REMIX's follow at a reading: the deck's rate (the clock's tempo over the song's), or null when that's more than
 * FOLLOW_RANGE away (it won't follow: no time-stretch); and the beats to jump on the clock's next bar while the song's
 * place in its bar is more than JUMP_BEATS off the clock's phase, else a nudge (at most ±NUDGE_MAX) taking it up.
 */
export function followDeck(songBpm: number, songBeat: number, beatsPerBar: number, c: ExternalClock): { rate: number; jump: number } | null {
  const base = c.bpm / songBpm
  if (!(songBpm > 0) || !(Math.abs(base - 1) <= FOLLOW_RANGE)) return null
  const bar = beatsPerBar > 0 ? beatsPerBar : 4
  const songIn = ((songBeat % bar) + bar) % bar
  let e = (c.phase % bar) - songIn // the song behind (+) or ahead (-) of the clock, beats
  e -= bar * Math.round(e / bar)
  if (Math.abs(e) > JUMP_BEATS) return { rate: base, jump: e }
  return { rate: base * (1 + Math.max(-NUDGE_MAX, Math.min(NUDGE_MAX, 0.05 * e))), jump: 0 }
}
