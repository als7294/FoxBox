/** Maps a control position t ∈ [0, 1] to a value and back, for lin and log params. */
export interface Range {
  min: number
  max: number
  scale?: 'lin' | 'log'
  step?: number | null
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function isLog(r: Range): boolean {
  return r.scale === 'log' && r.min > 0 && r.max > r.min
}

export function toPosition(value: number, r: Range): number {
  if (r.max === r.min) return 0
  if (isLog(r)) return clamp(Math.log(value / r.min) / Math.log(r.max / r.min), 0, 1)
  return clamp((value - r.min) / (r.max - r.min), 0, 1)
}

export function fromPosition(t: number, r: Range): number {
  const p = clamp(t, 0, 1)
  const raw = isLog(r) ? r.min * Math.pow(r.max / r.min, p) : r.min + p * (r.max - r.min)
  return quantize(raw, r)
}

export function quantize(value: number, r: Range): number {
  const v = clamp(value, r.min, r.max)
  if (r.step && r.step > 0) {
    const q = Math.round((v - r.min) / r.step) * r.step + r.min
    return clamp(Number(q.toFixed(6)), r.min, r.max)
  }
  return v
}

/** Keyboard step in position space: 1% (fine 0.1%), or the param's own step when it has one. */
export function nudge(value: number, r: Range, direction: 1 | -1, size: 'fine' | 'normal' | 'page'): number {
  if (r.step && size !== 'page') {
    const step = size === 'fine' ? r.step : r.step * (r.max - r.min > r.step * 100 ? 5 : 1)
    return quantize(value + direction * step, r)
  }
  const delta = size === 'fine' ? 0.001 : size === 'page' ? 0.1 : 0.01
  return fromPosition(toPosition(value, r) + direction * delta, r)
}

const UNIT_SUFFIX: Record<string, string> = { '%': '%', x: '×', st: ' st', dB: ' dB', Hz: ' Hz', ms: ' ms', s: ' s', beats: ' b' }

export function formatValue(value: number, unit?: string | null, step?: number | null): string {
  let digits = 2
  if (step && step >= 1) digits = 0
  else if (step && step >= 0.1) digits = 1
  else if (Math.abs(value) >= 1000) digits = 0
  else if (Math.abs(value) >= 100) digits = 0
  else if (Math.abs(value) >= 10) digits = 1
  if (unit === 'Hz' && Math.abs(value) >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} kHz`
  if (unit === '%') return `${Math.round(value * (Math.abs(value) <= 1 ? 100 : 1))}%`
  // Typographic minus (U+2212), as in the design.
  const text = value.toFixed(digits).replace('-', '−')
  const signed = unit === 'st' || unit === 'dB' ? (value > 0 ? `+${text}` : text) : text
  return `${signed}${unit ? (UNIT_SUFFIX[unit] ?? ` ${unit}`) : ''}`
}
