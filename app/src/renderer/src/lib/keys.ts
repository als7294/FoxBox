/** Musical keys in the engine's format ('Am', 'F#m', 'C') with Camelot codes for DJs. */
const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

// Camelot number for each minor root (A = minor, B = relative major).
const MINOR_CAMELOT: Record<string, number> = {
  'G#': 1,
  'D#': 2,
  'A#': 3,
  F: 4,
  C: 5,
  G: 6,
  D: 7,
  A: 8,
  E: 9,
  B: 10,
  'F#': 11,
  'C#': 12,
}

export interface KeyOption {
  value: string
  label: string
  camelot: string
}

function relativeMinor(majorRoot: string): string {
  const i = ROOTS.indexOf(majorRoot as (typeof ROOTS)[number])
  return ROOTS[(i + 9) % 12]!
}

const SHARP_OF: Record<string, string> = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' }

/** A key in the app's spelling (sharps, as KEY_OPTIONS lists them): the engine names songs' keys 'Ebm', 'Bb'… */
export function normalizeKey(key: string): string {
  const m = /^([A-G][#b]?)(m?)$/.exec(key.trim())
  return m ? `${SHARP_OF[m[1]!] ?? m[1]!}${m[2]}` : key
}

export function camelot(key: string): string {
  const minor = key.endsWith('m')
  const root = minor ? key.slice(0, -1) : key
  const n = MINOR_CAMELOT[minor ? root : relativeMinor(root)]
  return n ? `${n}${minor ? 'A' : 'B'}` : '?'
}

export const KEY_OPTIONS: KeyOption[] = [...ROOTS.map((r) => `${r}m`), ...ROOTS.map((r) => r)]
  .map((value) => ({ value, camelot: camelot(value), label: `${value} · ${camelot(value)}` }))
  .sort((a, b) => parseInt(a.camelot) - parseInt(b.camelot) || a.camelot.localeCompare(b.camelot))

/** A MIDI note as a pitch name: 37 → 'C#1' (middle C, 60, is C4). */
export const pitchName = (midi: number): string => `${ROOTS[((Math.round(midi) % 12) + 12) % 12]}${Math.floor(Math.round(midi) / 12) - 1}`
