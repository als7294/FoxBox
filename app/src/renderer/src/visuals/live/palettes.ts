import type { Palette } from './registry'

/** The stage's colour options: TRANSMISSION (the app's ember) first, then a few for other rooms. */
export const PALETTES: readonly Palette[] = [
  { id: 'transmission', label: 'EMBER', bg: '#050506', accent: '#ff4b2b', amber: '#ffb23e', ink: '#e9e5da', ice: '#7cc8ff' },
  { id: 'ice', label: 'ICE', bg: '#03060a', accent: '#29a8ff', amber: '#7cf0ff', ink: '#e8f4ff', ice: '#b48cff' },
  { id: 'acid', label: 'ACID', bg: '#040602', accent: '#b6ff2e', amber: '#ffe45c', ink: '#f1ffe0', ice: '#2effc4' },
  { id: 'magenta', label: 'NEON', bg: '#070309', accent: '#ff2e9a', amber: '#ff8a2e', ink: '#ffe9f6', ice: '#8a5cff' },
  { id: 'mono', label: 'MONO', bg: '#050505', accent: '#f2f2f2', amber: '#bdbdbd', ink: '#ffffff', ice: '#8c8c8c' },
]

export const paletteById = (id: string | null | undefined): Palette => PALETTES.find((p) => p.id === id) ?? PALETTES[0]!
