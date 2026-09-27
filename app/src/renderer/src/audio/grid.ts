/** Bar/beat arithmetic. The app assumes 4/4: one bar = 240 / BPM seconds. */

export const BEATS_PER_BAR = 4

export function beatSeconds(bpm: number): number {
  return 60 / bpm
}

export function barSeconds(bpm: number, beatsPerBar = BEATS_PER_BAR): number {
  return beatSeconds(bpm) * beatsPerBar
}

/** Exact sample count for N bars, e.g. 4 bars @ 140 BPM @ 44.1 kHz = 302,400. */
export function barSamples(bars: number, bpm: number, sampleRate: number, beatsPerBar = BEATS_PER_BAR): number {
  return Math.round(bars * barSeconds(bpm, beatsPerBar) * sampleRate)
}

export interface GridLine {
  /** Seconds from the start of the file. */
  t: number
  /** 1-based bar number. */
  bar: number
  /** 1-based beat within the bar. */
  beat: number
  isBar: boolean
}

/** Every beat line from 0 up to (and including) `durationS`. */
export function gridLines(durationS: number, bpm: number, beatsPerBar = BEATS_PER_BAR): GridLine[] {
  if (!(durationS > 0) || !(bpm > 0)) return []
  const beat = beatSeconds(bpm)
  const count = Math.floor(durationS / beat + 1e-6)
  const lines: GridLine[] = []
  for (let i = 0; i <= count; i++) {
    lines.push({ t: i * beat, bar: Math.floor(i / beatsPerBar) + 1, beat: (i % beatsPerBar) + 1, isBar: i % beatsPerBar === 0 })
  }
  return lines
}

/** Smallest power-of-two bar count (1…16) that holds `seconds`, or null if even 16 bars is too short. */
export function suggestBars(seconds: number, bpm: number, options: readonly number[] = [1, 2, 4, 8, 16]): number | null {
  const bar = barSeconds(bpm)
  for (const bars of options) if (bars * bar + 1e-9 >= seconds) return bars
  return null
}

export function formatSeconds(s: number, digits = 2): string {
  return `${s.toFixed(digits)} s`
}

/** "0:06.86" */
export function formatClock(s: number): string {
  const safe = Math.max(0, s)
  const m = Math.floor(safe / 60)
  const rest = safe - m * 60
  return `${m}:${rest.toFixed(2).padStart(5, '0')}`
}

/** Tap tempo: average interval of the last taps (ignoring gaps over 2 s), rounded to 0.1 BPM. */
export function tapTempo(tapTimesMs: readonly number[]): number | null {
  const recent: number[] = []
  for (let i = tapTimesMs.length - 1; i > 0; i--) {
    const d = tapTimesMs[i]! - tapTimesMs[i - 1]!
    if (d <= 0 || d > 2000) break
    recent.push(d)
    if (recent.length >= 8) break
  }
  if (recent.length === 0) return null
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length
  return Math.round((60000 / avg) * 10) / 10
}
