/**
 * Melody mode's loop (2.1, STRINGS_UX "SAUCE: Melody mode"): the preset as 2 bars that play by themselves, on a beat
 * clock (120 BPM, the popover's tempo, or Link's tempo when it follows). The player schedules ahead in 16ths (pump: the
 * instrument's timer, a little ahead of now), its notes at their exact times; an edit (the loop strip) lands at the
 * loop's top, never mid-note; the open palm's variation plays its bar once. Its `beat` callback runs as each beat is
 * scheduled: what the hands asked lands there (register, the drop, the shapes).
 */
import { applyLoopRules, LOOP_STEPS, type LoopKey, type LoopNote } from './loopRules'

/** A preset's 8 notes as the loop: one a beat over 2 bars, each a dotted 8th (air between them). */
export const presetLoop = (midis: readonly number[]): LoopNote[] => midis.slice(0, 8).map((midi, i) => ({ start: i * 4, length: 3, midi }))

export interface LoopClock {
  bpm: number
  /** The loop's beat at `at` (context time): where it is. */
  beat: number
  at: number
}

export function createLoopPlayer(o: {
  play: (n: LoopNote, at: number, durS: number) => void
  beat?: (beat: number, at: number) => void
}) {
  let notes: LoopNote[] = []
  let pending: LoopNote[] | null = null
  let once: { bar: 0 | 1; notes: LoopNote[]; from: number } | null = null // the palm's variation: its bar, one pass
  let clock: LoopClock = { bpm: 120, beat: 0, at: 0 }
  let next = 0 // the next 16th to schedule (from the start)
  let running = false
  const beatAt = (t: number) => clock.beat + ((t - clock.at) * clock.bpm) / 60
  const timeAt = (b: number) => clock.at + ((b - clock.beat) * 60) / clock.bpm
  return {
    get running() { return running },
    get notes() { return notes },
    get pending() { return pending },
    get bpm() { return clock.bpm },
    /** From the top at `at`, `bpm`. */
    start(loop: LoopNote[], at: number, bpm: number) {
      notes = loop
      pending = null
      once = null
      clock = { bpm, beat: 0, at }
      next = 0
      running = true
    },
    stop() {
      running = false
      once = null
    },
    /** A new tempo from `at` on (the loop carries on from where it is; Link's readings come here too). */
    tempo(bpm: number, at: number) {
      if (!(bpm > 0) || bpm === clock.bpm) return
      clock = { bpm, beat: beatAt(at), at }
    },
    /** An edit (already ruled) for the loop's next top. */
    edit(loop: LoopNote[]) {
      pending = loop
    },
    /** The palm's variation for the next bar to come round (not yet scheduled): `make(bar)` gives the whole loop with
     *  that bar varied; it plays once. */
    vary(make: (bar: 0 | 1) => LoopNote[]) {
      const at = next % LOOP_STEPS
      const bar: 0 | 1 = at === 0 ? 0 : at === 16 ? 1 : at < 16 ? 1 : 0
      once = { bar, notes: make(bar), from: next + ((bar * 16 - at + LOOP_STEPS) % LOOP_STEPS) }
    },
    /** Schedules everything up to `until` (context time). */
    pump(until: number) {
      if (!running) return
      while (timeAt(next / 4) < until) {
        const pos = next % LOOP_STEPS
        if (pos === 0 && pending) { notes = pending; pending = null } // the top: an edit lands
        const at = timeAt(next / 4)
        if (pos % 4 === 0) o.beat?.(next / 4, at)
        const bar = pos < 16 ? 0 : 1
        const src = once && once.bar === bar && next >= once.from ? once.notes : notes
        for (const n of src) if (n.start === pos) o.play(n, at, (n.length * 15) / clock.bpm)
        if (once && next >= once.from && (pos === 15 || pos === 31) && bar === once.bar) once = null // played once
        next++
      }
    },
    /** Where it is at `t`: the 16th, the note playing (its index in `notes`, -1 before the first), the bar's phase. */
    where(t: number) {
      const b = Math.max(0, beatAt(t))
      const pos = Math.floor(b * 4) % LOOP_STEPS
      let step = -1
      for (let i = 0; i < notes.length; i++) if (notes[i]!.start <= pos) step = i
      if (step < 0 && notes.length) step = notes.length - 1 // before the first: the last one is still the line's
      return { pos, step, beat: Math.floor(b), phase: b % 1, barPhase: (b / 4) % 1, bpm: clock.bpm }
    },
    /** The beat grid for the frame loop: the tempo and a beat's context time. */
    grid() {
      return { bpm: clock.bpm, anchor: clock.at - (clock.beat * 60) / clock.bpm }
    },
  }
}
export type LoopPlayer = ReturnType<typeof createLoopPlayer>

/** The loop key for a ladder: its notes (the comfortable range) and each bar's chord (the preset's chord tones, with
 *  the preset's own notes on the strong beats so it always passes). */
export function loopKey(rows: readonly number[], chordPcs: readonly [number[], number[]], preset: readonly LoopNote[], rootPc: number): LoopKey {
  const own = (bar: number) => preset.filter((n) => n.start % 8 === 0 && Math.floor(n.start / 16) === bar).map((n) => n.midi % 12)
  return { rows, chords: [new Set([...chordPcs[0], ...own(0)]), new Set([...chordPcs[1], ...own(1)])], root: rootPc }
}

export { applyLoopRules }
