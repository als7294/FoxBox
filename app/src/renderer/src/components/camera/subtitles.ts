/**
 * Camera clip subtitles: the drop's words a short phrase at a time, the word being said picked out. Pure (compose.ts
 * draws them).
 *
 * The words break into phrases at each of the render's segments (the script's chunks) and at pauses; a longer run
 * splits evenly into phrases of at most two lines of about five words. A phrase shows from its first word until the
 * next phrase starts, or until shortly after its last word when a pause follows. It fades in and out around pauses
 * only (phrases that follow on swap), so nothing shows before the drop's first word or lingers after its last.
 */
import type { RenderInfo } from '@/api/types'
import { WORD_HOLD_S } from '@/visuals/wordLabels'

/** A word on the drop's own timeline (s), its clean text, and whether a new phrase starts with it. */
export interface SubWord {
  t0: number
  t1: number
  w: string
  /** The first word of one of the render's segments. */
  brk: boolean
}

export interface Subtitle {
  /** One or two lines of words. */
  lines: string[][]
  /** The word being said: its index through the phrase (line after line), or -1 between words. */
  current: number
  /** 0–1: in after a pause, out into one. */
  alpha: number
}

/** A line holds about this many words and characters (two lines at most per phrase). */
export const SUB_LINE_WORDS = 5
export const SUB_LINE_CHARS = 18
/** A pause longer than this between words starts a new phrase. */
const PAUSE_S = 0.7
/** Before a pause (and after the last word), a phrase stays this long after its last word, fading out. */
export const SUB_HOLD_S = 0.5
export const SUB_FADE_S = 0.15

interface Phrase {
  words: SubWord[]
  /** The second line starts at this word (words.length: one line). */
  split: number
  from: number
  to: number
  fadeIn: boolean
  fadeOut: boolean
}

// Script markup never shows, should any reach a word: *throws*, [0.5] pauses, | beat breaks.
const clean = (text: string) => text.replace(/\[[^\]]*\]|[*|]/g, '').trim()
const chars = (words: readonly SubWord[]) => words.reduce((n, w) => n + w.w.length, 0) + Math.max(0, words.length - 1)

const fromRender = new WeakMap<RenderInfo, SubWord[]>()

/** The render's words for the subtitles, on the drop's timeline, each segment starting a phrase. */
export function subtitleWords(r: RenderInfo | null | undefined): SubWord[] {
  if (!r) return []
  let out = fromRender.get(r)
  if (!out) {
    out = []
    for (const seg of r.segments) {
      let brk = true
      for (const word of seg.words ?? []) {
        const w = clean(word.text)
        if (!w) continue
        out.push({ t0: word.start_s, t1: word.end_s, w, brk })
        brk = false
      }
    }
    fromRender.set(r, out)
  }
  return out
}

/** Where a phrase's second line starts: one line when it fits, else the most even break. */
function lineBreak(words: readonly SubWord[]): number {
  if (words.length <= SUB_LINE_WORDS && chars(words) <= SUB_LINE_CHARS) return words.length
  let best = words.length
  let widest = Infinity
  for (let s = 1; s < words.length; s++) {
    const m = Math.max(chars(words.slice(0, s)), chars(words.slice(s)))
    if (m < widest) [best, widest] = [s, m]
  }
  return best
}

const phraseCache = new WeakMap<readonly SubWord[], Phrase[]>()

function phrasesOf(words: readonly SubWord[]): Phrase[] {
  let out = phraseCache.get(words)
  if (out) return out
  // Runs: between segment starts and pauses. Each splits into as few even phrases as fit two lines.
  const runs: SubWord[][] = []
  words.forEach((w, i) => {
    const prev = words[i - 1]
    if (!prev || w.brk || w.t0 - prev.t1 > PAUSE_S) runs.push([w])
    else runs[runs.length - 1]!.push(w)
  })
  const groups: SubWord[][] = []
  for (const run of runs) {
    const n = Math.max(Math.ceil(run.length / (2 * SUB_LINE_WORDS)), Math.ceil(chars(run) / (2 * SUB_LINE_CHARS + 1)))
    for (let k = 0, at = 0; k < n; k++) {
      const next = Math.round(((k + 1) * run.length) / n)
      if (next > at) groups.push(run.slice(at, next))
      at = next
    }
  }
  out = groups.map((g) => ({
    words: g,
    split: lineBreak(g),
    from: g[0]!.t0,
    to: g[g.length - 1]!.t1 + SUB_HOLD_S,
    fadeIn: true,
    fadeOut: true,
  }))
  // A phrase that runs into the next one gives way to it at once: no fade between them.
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1]!
    const b = out[i]!
    if (a.to >= b.from) {
      a.to = b.from
      a.fadeOut = false
      b.fadeIn = false
    }
  }
  phraseCache.set(words, out)
  return out
}

/** The subtitle `t` seconds into the drop (its own timeline), or null when no phrase shows. Words in time order. */
export function subtitleAt(words: readonly SubWord[], t: number | null): Subtitle | null {
  if (t == null || !Number.isFinite(t) || !words.length) return null
  const p = phrasesOf(words).find((q) => t >= q.from && t < q.to)
  if (!p) return null
  let current = -1
  for (let i = 0; i < p.words.length && p.words[i]!.t0 <= t; i++) current = i
  if (current >= 0 && t >= p.words[current]!.t1 + WORD_HOLD_S) current = -1
  const alpha = Math.min(1, p.fadeIn ? (t - p.from) / SUB_FADE_S : 1, p.fadeOut ? (p.to - t) / SUB_FADE_S : 1)
  const text = p.words.map((w) => w.w)
  return { lines: p.split < text.length ? [text.slice(0, p.split), text.slice(p.split)] : [text], current, alpha: Math.max(0, alpha) }
}
