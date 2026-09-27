/** The TRANSMISSION palette for canvas drawing (CSS reads the same values from styles/tokens.css). */
export interface VbTheme {
  name: 'transmission'
  bg: string
  panel: string
  ink: string
  dim: string
  accent: string
  amber: string
  ice: string
  mono: string
  display: string
  displayWeight: number
}

const TRANSMISSION: VbTheme = {
  name: 'transmission',
  bg: '#0b0b0c',
  panel: '#111113',
  ink: '#e9e5da',
  dim: '#8d8a82',
  accent: '#ff4b2b',
  amber: '#ffb23e',
  ice: '#7cc8ff',
  mono: '"JetBrains Mono", monospace',
  display: '"Big Shoulders Display", sans-serif',
  displayWeight: 800,
}

export function theme(): VbTheme {
  return TRANSMISSION
}
