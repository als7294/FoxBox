/** Canvas helpers ported from the design's voicebox-engine.js. */
export const clamp = (v: number, a = 0, b = 1): number => Math.max(a, Math.min(b, v))

/** Smooth pseudo-noise in about [-1, 1]. */
export const nz = (x: number): number => (Math.sin(x * 1.7) + Math.sin(x * 2.9 + 1.3) * 0.6 + Math.sin(x * 5.3 + 0.7) * 0.3) / 1.9

export const HX = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export const rgba = (hex: string, a: number): string => {
  const [r, g, b] = HX(hex)
  return `rgba(${r},${g},${b},${a})`
}

/** Colour a → b at t, with alpha aa → ba. */
export const mix = (a: string, aa: number, b: string, ba: number, t: number): string => {
  const A = HX(a)
  const B = HX(b)
  const l = (p: number, q: number) => Math.round(p + (q - p) * t)
  return `rgba(${l(A[0], B[0])},${l(A[1], B[1])},${l(A[2], B[2])},${(aa + (ba - aa) * t).toFixed(3)})`
}

export const f2 = (v: number): string => v.toFixed(2)

export interface Prepared {
  x: CanvasRenderingContext2D
  w: number
  h: number
}

/** Sizes the backing store to the element (2x) and returns a context in CSS pixels, or null if hidden. */
export function prep(cv: HTMLCanvasElement | null): Prepared | null {
  if (!cv) return null
  const w = cv.clientWidth
  const h = cv.clientHeight
  if (!w || !h) return null
  const d = 2
  if (cv.width !== w * d || cv.height !== h * d) {
    cv.width = w * d
    cv.height = h * d
  }
  const x = cv.getContext('2d')
  if (!x) return null
  x.setTransform(d, 0, 0, d, 0, 0)
  return { x, w, h }
}

/** mm:ss.cc */
export const mmss = (t: number): string =>
  `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}`
