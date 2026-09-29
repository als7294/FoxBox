/**
 * The photosensitivity guard (1.5): WCAG 2.3.1 "three flashes" on the composite, after the counting in EA's IRIS
 * (BSD-3) and EPI-LENS (MIT), reimplemented. The frame arrives as a small grid of RGBA cells (a GPU downsample);
 * per cell, relative luminance (linear sRGB) and red saturation R/(R+G+B).
 *
 * - A general transition: over at least a quarter of the frame, relative luminance moves the same way until the change
 *   adds up to 10% (accumulated over frames, as a slow fade counts too), with the darker state below 0.80.
 * - A red transition: over at least a quarter of the frame, cells go into or out of saturated red (ratio ≥ 0.8) with
 *   a red-ratio change above 0.2.
 * - A flash is a pair of opposing transitions: more than 6 transitions of one kind inside any second is over 3 flashes.
 *
 * When the next transition would break the limit, the frame's brightness is held back toward the last one shown, just
 * enough to keep the change under the threshold, so it arrives more slowly instead. That's a uniform correction of
 * this frame (a gain when it jumps brighter, a lift when it drops darker, less saturation for a red flash), never a
 * mix with the last frame: mixing frames double-exposed anything moving (a panning camera under TEXT · SLAM).
 */

/** How to hold one frame back: multiply its linear luminance by `gain`, add `lift`, scale saturation by `saturate`. */
export interface Hold {
  gain: number
  lift: number
  saturate: number
}

export const NO_HOLD: Hold = { gain: 1, lift: 0, saturate: 1 }

/** WCAG: a change of 10% of the maximum relative luminance. */
const LUMA_STEP = 0.1
/** WCAG: the darker of the two states must be below this. */
const DARK_BELOW = 0.8
/** Of the frame (PM brief: 25%). */
const AREA = 0.25
const RED_RATIO = 0.8
const RED_STEP = 0.2
/** Opposing transitions per second allowed: 3 flashes = 6 transitions. */
const MAX_TRANSITIONS = 6
/** A cell's own change must be at least this to count toward the area (noise floor). */
const CELL_FLOOR = 0.02

export interface Cells {
  /** Relative luminance 0–1 per cell. */
  luma: Float32Array
  /** R/(R+G+B) per cell (0 for black). */
  red: Float32Array
}

/** RGBA bytes (sRGB) → per-cell relative luminance and red ratio. */
export function cellsFromRgba(px: ArrayLike<number>): Cells {
  const n = Math.floor(px.length / 4)
  const luma = new Float32Array(n)
  const red = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const r = px[i * 4]!
    const g = px[i * 4 + 1]!
    const b = px[i * 4 + 2]!
    luma[i] = 0.2126 * LIN[r]! + 0.7152 * LIN[g]! + 0.0722 * LIN[b]!
    const sum = r + g + b
    red[i] = sum > 0 ? r / sum : 0
  }
  return { luma, red }
}

/** sRGB byte → linear. */
const LIN = Float32Array.from({ length: 256 }, (_, v) => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
})

interface Trend {
  dir: -1 | 0 | 1
  acc: number
  times: number[]
}

export class FlashGuard {
  private shown: Cells | null = null
  private readonly luma: Trend = { dir: 0, acc: 0, times: [] }
  private readonly red: Trend = { dir: 0, acc: 0, times: [] }

  reset(): void {
    this.shown = null
    for (const t of [this.luma, this.red]) ((t.dir = 0), (t.acc = 0), (t.times = []))
  }

  /** One frame at `t` seconds: how to hold it back (NO_HOLD: show it as is); records what is then shown. */
  observe(t: number, cells: Cells): Hold {
    const prev = this.shown
    if (!prev || prev.luma.length !== cells.luma.length) {
      this.shown = cells
      return NO_HOLD
    }
    for (const tr of [this.luma, this.red]) tr.times = tr.times.filter((x) => x <= t && t - x < 1)
    const l = this.step(this.luma, prev.luma, cells.luma, LUMA_STEP, (a, b) => Math.min(a, b) < DARK_BELOW)
    const r = this.step(this.red, prev.red, cells.red, RED_STEP, (a, b) => Math.max(a, b) >= RED_RATIO)
    // Over budget: aim for the mean the old mix with the last frame would have shown (just under a transition).
    const damp = Math.max(l.over ? l.damp : 0, r.over ? r.damp : 0)
    if (!l.over && l.transition) this.luma.times.push(t)
    if (!r.over && r.transition) this.red.times.push(t)
    if (l.over) this.luma.acc = Math.sign(this.luma.acc) * Math.min(Math.abs(this.luma.acc), LUMA_STEP * 0.9)
    if (r.over) this.red.acc = Math.sign(this.red.acc) * Math.min(Math.abs(this.red.acc), RED_STEP * 0.9)
    if (damp <= 0) {
      this.shown = cells
      return NO_HOLD
    }
    const now = mean(cells.luma)
    const target = now * (1 - damp) + mean(prev.luma) * damp
    const hold: Hold = {
      gain: now > target && now > 0 ? target / now : 1,
      lift: target > now ? target - now : 0,
      saturate: r.over ? 1 - r.damp : 1,
    }
    this.shown = held(cells, hold)
    return hold
  }

  /**
   * Adds this frame's change to the running trend of one kind. A transition is the trend crossing `threshold` over
   * enough of the frame; `over` when that transition would exceed the per-second budget.
   */
  private step(
    tr: Trend,
    prev: Float32Array,
    cur: Float32Array,
    threshold: number,
    qualifies: (a: number, b: number) => boolean,
  ): { transition: boolean; over: boolean; damp: number } {
    let up = 0
    let down = 0
    let upSum = 0
    let downSum = 0
    let ok = 0
    for (let i = 0; i < cur.length; i++) {
      const d = cur[i]! - prev[i]!
      if (d > CELL_FLOOR) (up++, (upSum += d))
      else if (d < -CELL_FLOOR) (down++, (downSum -= d))
      if (Math.abs(d) > CELL_FLOOR && qualifies(prev[i]!, cur[i]!)) ok++
    }
    const n = cur.length
    const dir: -1 | 0 | 1 = up / n >= AREA && up >= down ? 1 : down / n >= AREA ? -1 : 0
    if (dir === 0 || ok / n < AREA) return { transition: false, over: false, damp: 0 }
    const mean = dir > 0 ? upSum / up : downSum / down
    if (dir !== tr.dir) ((tr.dir = dir), (tr.acc = 0))
    tr.acc += dir * mean
    if (Math.abs(tr.acc) < threshold) return { transition: false, over: false, damp: 0 }
    const over = tr.times.length >= MAX_TRANSITIONS
    // The mix of the last frame that keeps the accumulated change just under the threshold.
    const room = Math.max(0, threshold * 0.9 - (Math.abs(tr.acc) - mean))
    const damp = over ? Math.min(1, Math.max(0, 1 - room / mean)) : 0
    if (!over) tr.acc = 0
    return { transition: !over, over, damp }
  }
}

const mean = (a: Float32Array): number => a.reduce((x, v) => x + v, 0) / (a.length || 1)

/** The cells as they show after a hold: luminance scaled and lifted, red ratio pulled toward grey (1/3). */
function held(cur: Cells, h: Hold): Cells {
  const luma = cur.luma.map((v) => Math.min(1, v * h.gain + h.lift))
  const red = cur.red.map((v) => v * h.saturate + (1 - h.saturate) / 3)
  return { luma, red }
}
