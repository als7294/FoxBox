/**
 * The loop strip's rules (2.1 Melody mode, STRINGS_UX "The loop strip"): whatever an edit asks, what lands can't sound
 * bad. A loop is 2 bars of 16ths (start 0-31, length in 16ths, a MIDI note); rules, in order:
 *   grid     starts on the 16th grid, lengths one of 1/16, 1/8, dotted 1/8, 1/4, 1/2, ending by the loop's end
 *   pitch    on the key's scale within the comfortable range (the ladder: an octave and a half); the strong beats (each
 *            bar's 1 and 3) on a chord tone (the preset's chord, or the preset's own note there)
 *   clashes  one note at a time (the loop is a line): a note on a taken 16th slides to the nearest free one, an earlier
 *            note is cut short where the next starts
 *   density  no more than 3 notes in a beat (the ones furthest from the beat go)
 *   leaps    a leap wider than a 6th resolves by step (the next note steps back toward where it came from)
 *   downbeat each bar's first 16th has a note (the root, short, when an edit took it away; the chord's nearest tone if the
 *            root isn't in it)
 * Nothing errors: a move that breaks a rule lands on the nearest note that doesn't. Rule-based, no model.
 */

export interface LoopNote {
  /** 16ths from the loop's start, 0-31 (2 bars). */
  start: number
  /** 16ths. */
  length: number
  midi: number
}

export interface LoopKey {
  /** The allowed notes (the key's scale over the comfortable range), low to high. */
  rows: readonly number[]
  /** The pitch classes each bar's strong beats allow. */
  chords: readonly [ReadonlySet<number>, ReadonlySet<number>]
  /** The key's root, a pitch class. */
  root: number
}

export const LOOP_STEPS = 32
export const LENGTHS = [1, 2, 3, 4, 8] as const
const LEAP = 9 // semitones: wider than a major 6th resolves
const PER_BEAT = 3

const pc = (m: number) => ((m % 12) + 12) % 12
const strong = (start: number) => start % 8 === 0
const nearest = (xs: readonly number[], x: number) => xs.reduce((best, y) => (Math.abs(y - x) < Math.abs(best - x) ? y : best), xs[0]!)

/** The note's pitch on the rows (a chord tone on a strong beat). */
function snapPitch(midi: number, start: number, k: LoopKey): number {
  const chord = k.chords[start < 16 ? 0 : 1]
  const rows = strong(start) ? k.rows.filter((m) => chord.has(pc(m))) : k.rows
  return nearest(rows.length ? rows : k.rows, Number.isFinite(midi) ? midi : k.rows[k.rows.length >> 1]!)
}

/** The longest allowed length at most `room` 16ths (at least a 16th). */
const fit = (length: number, room: number) => {
  const want = nearest(LENGTHS, Number.isFinite(length) ? length : 2)
  return Math.max(1, ...LENGTHS.filter((l) => l <= Math.min(want, room)))
}

/** `notes` with the rules applied (see above): sorted by start, what will land. */
export function applyLoopRules(notes: readonly LoopNote[], k: LoopKey): LoopNote[] {
  // grid, then pitch; a taken 16th: the nearest free one (later first), in the order they came
  const taken = new Set<number>()
  const out: LoopNote[] = []
  for (const n of notes) {
    let start = Math.max(0, Math.min(LOOP_STEPS - 1, Math.round(Number.isFinite(n.start) ? n.start : 0)))
    for (let d = 0; taken.has(start) && d < LOOP_STEPS; d++) for (const s of [start + d, start - d]) if (s >= 0 && s < LOOP_STEPS && !taken.has(s)) { start = s; break }
    if (taken.has(start)) continue // full
    taken.add(start)
    out.push({ start, length: fit(n.length, LOOP_STEPS - start), midi: snapPitch(n.midi, start, k) })
  }
  out.sort((a, b) => a.start - b.start)
  // each bar's downbeat: the root if the bar's chord has it, else its nearest chord tone (nearest the line's middle), an 8th
  for (const bar of [0, 16]) {
    if (out.some((n) => n.start === bar)) continue
    const mid = out.length ? out.reduce((s, n) => s + n.midi, 0) / out.length : k.rows[k.rows.length >> 1]!
    const chord = k.rows.filter((m) => k.chords[bar ? 1 : 0].has(pc(m)))
    const roots = chord.filter((m) => pc(m) === k.root)
    out.push({ start: bar, length: 2, midi: nearest(roots.length ? roots : chord.length ? chord : k.rows, mid) })
    out.sort((a, b) => a.start - b.start)
  }
  // density: the 4th note in a beat and on go, furthest from the beat first (never a downbeat)
  for (let beat = 0; beat < LOOP_STEPS / 4; beat++) {
    const inBeat = out.filter((n) => Math.floor(n.start / 4) === beat)
    for (const n of inBeat.sort((a, b) => (b.start % 4) - (a.start % 4)).slice(0, Math.max(0, inBeat.length - PER_BEAT))) out.splice(out.indexOf(n), 1)
  }
  // leaps: wider than a 6th, the next note steps back toward where the line came from (a strong beat keeps its chord
  // tone: the leaping note comes an octave closer instead, if that's in range)
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1]!, b = out[i]!
    if (Math.abs(b.midi - a.midi) <= LEAP) continue
    const c = out[i + 1]
    const dir = Math.sign(a.midi - b.midi)
    if (c && !strong(c.start)) {
      const r = k.rows.indexOf(b.midi)
      const step = k.rows[r + dir]
      if (r >= 0 && step !== undefined) c.midi = step
    } else {
      const closer = b.midi + 12 * dir
      if (k.rows.includes(closer) && (!strong(b.start) || k.chords[b.start < 16 ? 0 : 1].has(pc(closer)))) b.midi = closer
    }
  }
  // one at a time: cut short where the next starts
  for (let i = 0; i < out.length; i++) {
    const n = out[i]!, next = out[i + 1]?.start ?? LOOP_STEPS
    if (n.start + n.length > next) n.length = fit(next - n.start, next - n.start)
  }
  return out
}

/** mulberry32 (the same seed, the same variation). */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The open palm's variation (the 🎲 rules, in key): `bar` (0 or 1) of `notes` played differently, its downbeat kept;
 *  the others step a scale degree or two (a mostly stepwise turn) and an 8th may split into two 16ths. The whole loop
 *  comes back ruled (the other bar as it was). */
export function loopVariation(notes: readonly LoopNote[], bar: 0 | 1, seed: number, k: LoopKey): LoopNote[] {
  const rnd = seeded(seed)
  const from = bar * 16
  const varied: LoopNote[] = []
  for (const n of notes) {
    if (n.start < from || n.start >= from + 16 || n.start === from) { varied.push({ ...n }); continue }
    const r = k.rows.indexOf(nearest(k.rows, n.midi))
    const step = [-2, -1, -1, 1, 1, 2][Math.floor(rnd() * 6)]!
    const midi = k.rows[Math.max(0, Math.min(k.rows.length - 1, r + step))]!
    if (n.length >= 2 && rnd() < 0.35) { // an 8th into two 16ths, the second a step away
      varied.push({ start: n.start, length: 1, midi }, { start: n.start + 1, length: 1, midi: k.rows[Math.max(0, Math.min(k.rows.length - 1, r + step - Math.sign(step)))]! })
    } else varied.push({ ...n, midi })
  }
  return applyLoopRules(varied, k)
}
