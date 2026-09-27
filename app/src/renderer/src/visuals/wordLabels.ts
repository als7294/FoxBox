/**
 * Words on the output timeline: which one is being said, and how their labels under the SIGNAL waveform are laid
 * out without colliding. Pure (the canvas measures the text in visuals/draw.ts; this decides what shows where).
 *
 * Every word keeps its tick at its start, with its label to the right of the tick in one of two lanes. A label takes
 * the first lane when it clears the previous label there, else the lane under it. It may run past the next word's
 * tick (that word then takes the other lane) but never past the tick after that, so the next word finds a lane free.
 * A label longer than that is shortened with an ellipsis; one with room for fewer than `minChars` characters shows
 * its tick only. Only when three words start within a few pixels can both lanes be taken; the middle one then draws
 * nothing rather than cross another label.
 */
import type { Word } from './draw'

/** How long a word stays current after it ends when the next one hasn't started (bridges the gaps between words). */
export const WORD_HOLD_S = 0.2

/** Index of the word being said at `t` (s), or -1 between words and outside the speech. Words in time order. */
export function wordAt(words: readonly Word[], t: number, hold = WORD_HOLD_S): number {
  let i = -1
  for (let k = 0; k < words.length && words[k]!.t0 <= t; k++) i = k
  return i >= 0 && t < words[i]!.t1 + hold ? i : -1
}

export interface WordLabel {
  /** 0 = the first lane, 1 = the lane under it. */
  lane: 0 | 1
  /** Whether the tick is drawn (false only when both lanes are taken at this word). */
  tick: boolean
  /** What to draw: the label, shortened with '…', or '' (tick only). */
  text: string
  /** Left edge of the text, px. */
  x: number
  /** Right edge of what the label takes in its lane (its tick when it shows no text), px. */
  end: number
}

export interface LabelLayoutOptions {
  /** Right bound for any text, px. */
  right: number
  /** Tick to text, px. */
  pad?: number
  /** Clear space between a label's end and the next tick in its lane, px. */
  gap?: number
  /** Fewest characters a shortened label keeps before it shows its tick only. */
  minChars?: number
}

const ELLIPSIS = '…'

/**
 * Lays out one label per word. `ticks` are the words' start positions (px, ascending), `texts` the labels and
 * `widths` their measured widths. Shortening assumes the monospaced label face (each character width / length).
 */
export function layoutWordLabels(
  ticks: readonly number[],
  texts: readonly string[],
  widths: readonly number[],
  o: LabelLayoutOptions,
): WordLabel[] {
  const pad = o.pad ?? 5
  const gap = o.gap ?? 6
  const minChars = o.minChars ?? 3
  const ends: [number, number] = [-Infinity, -Infinity]
  const out: WordLabel[] = []
  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i]!
    const x = tick + pad
    const clear0 = tick >= ends[0] + gap
    const clear1 = tick >= ends[1] + gap
    if (!clear0 && !clear1) {
      out.push({ lane: 0, tick: false, text: '', x, end: tick })
      continue
    }
    const lane: 0 | 1 = clear0 ? 0 : 1
    const text = texts[i] ?? ''
    const width = widths[i] ?? 0
    const after = ticks[i + 2]
    const limit = Math.min(o.right, after == null ? Infinity : after - gap)
    let shown = ''
    let end = tick
    if (text && x + width <= limit) {
      shown = text
      end = x + width
    } else if (text.length > minChars) {
      const cw = width / text.length
      const n = Math.floor((limit - x) / cw) - 1
      if (n >= minChars) {
        shown = text.slice(0, n) + ELLIPSIS
        end = x + (n + 1) * cw
      }
    }
    ends[lane] = end
    out.push({ lane, tick: true, text: shown, x, end })
  }
  return out
}
