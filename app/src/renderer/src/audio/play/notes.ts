/**
 * PLAY's note map: a key and scale (minor pentatonic by default) laid over the hands. PLUCK picks each note on a LADDER
 * of the scale (~1.5 octaves from an octave below the instrument's): by each hand's height (HEIGHT, the default: two
 * hands, two notes) or by the hands' spread (SPREAD); any finger plucks it (melody.ts can pick it instead). FLOW: the
 * right hand's height runs over two octaves of the scale. Both snap to the scale's notes with hysteresis, so a steady
 * hand holds its note.
 */
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const
export type NoteName = (typeof NOTE_NAMES)[number]

export const SCALES = {
  minorPentatonic: [0, 3, 5, 7, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
  minor: [0, 2, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  blues: [0, 3, 5, 6, 7, 10],
} as const
export type ScaleId = keyof typeof SCALES

export interface Key {
  root: NoteName
  scale: ScaleId
}
export const DEFAULT_KEY: Key = { root: 'C#', scale: 'minorPentatonic' }

/** MIDI note number to Hz (A4 = 69 = 440 Hz). */
export const midiHz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12)

/** The MIDI note of scale degree `degree` (0 = the root; past the scale's length it climbs octaves) from octave `octave`
 *  (scientific: the root of octave 4 in C is C4 = 60). */
export function degreeMidi(key: Key, octave: number, degree: number): number {
  const steps = SCALES[key.scale]
  const n = steps.length
  const oct = Math.floor(degree / n)
  return 12 * (octave + 1 + oct) + NOTE_NAMES.indexOf(key.root) + steps[((degree % n) + n) % n]!
}

/** A hand's height (0 bottom … 1 top) as an octave shift: the top quarter +1, the bottom quarter -1 (FLOW's left hand). */
export const heightOctave = (height: number | undefined): number => (height == null || !Number.isFinite(height) ? 0 : height > 0.75 ? 1 : height < 0.25 ? -1 : 0)

/** FOLLOW's octave: a hand high plays the note an octave up, low an octave down, in the middle as written. */
export const followOctave = (height: number | undefined): number => (height == null || !Number.isFinite(height) ? 0 : height > 2 / 3 ? 1 : height < 1 / 3 ? -1 : 0)

/** A position 0-1 on a ladder of `size` steps; `held` (last time's step) stays until it's 0.6 of a step away, so a steady
 *  hand doesn't flicker between two. */
export function ladderDegree(x: number, size: number, held: number | null = null): number {
  const pos = Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)) * (size - 1)
  return held != null && Math.abs(pos - held) < 0.6 ? held : Math.round(pos)
}

/** PLUCK's ladder: ~1.5 octaves of the scale (a pentatonic's 9 steps, a 7-note scale's 12). */
export const ladderSize = (key: Key): number => Math.round(1.5 * SCALES[key.scale].length) + 1

/** A ladder degree's MIDI note: from the root an octave below `octave`, `shift` octaves on top (POINT UP / DOWN). */
export const ladderMidi = (key: Key, octave: number, degree: number, shift = 0): number => degreeMidi(key, octave - 1 + shift, degree)

/** @deprecated The 1st PLAY note map (a note per finger, the left hand an octave below): only the strings' labels still
 *  read it (S3, S4) until they move to Instrument.currentNote / ladder(). PLUCK no longer plays it. */
export const pluckMidi = (key: Key, octave: number, hand: 'left' | 'right', finger: number, shift = 0): number =>
  degreeMidi(key, octave + shift - (hand === 'left' ? 1 : 0), Math.max(0, Math.min(4, Math.round(finger))))

/** A MIDI note's name as the strip shows it: C#4. */
export const noteName = (midi: number): string => `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`

/** FLOW: the scale degree for the right hand's height (0-1 over two octaves from an octave below `octave`); `held` (last
 *  time's degree) stays until the hand is 0.6 of a step past the midpoint, so a steady hand doesn't flicker. */
export const flowDegree = (key: Key, pitch: number, held: number | null = null): number => ladderDegree(pitch, 2 * SCALES[key.scale].length + 1, held)

export const flowMidi = (key: Key, octave: number, degree: number, shift = 0): number => degreeMidi(key, octave - 1 + shift, degree)
