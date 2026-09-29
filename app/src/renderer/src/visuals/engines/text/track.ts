// TEXT (1.5): which words show when. Text belongs to the stretch right before a drop: the N bars leading to the next
// hit (S2's dropIn, else the track's drop_s), or a build when the drop isn't known. Pure, so it's tested directly.
import type { AudioFrame, TextTrack, TimedWord } from '../../live/registry'

/** Only what the bundled fonts draw (Latin); anything else would send troika to a CDN for a fallback font. */
export const latin = (s: string): string => s.replace(/[^\x20-\x7E\xA0-\xFF]/g, '').trim()

/** The DJ's own text: untimed words (start_s -1), spread across the pre-drop stretch. */
export function typedTrack(text: string, dropS: number | null): TextTrack {
  const words = latin(text).split(/\s+/).filter(Boolean).map((w) => ({ text: w, start_s: -1, end_s: -1 }))
  return { words, drop_s: dropS }
}

/**
 * A Studio drop's words (render timeline) in song time: the render's bar 1 lands on song bar `atBar` of a grid with
 * bar 1 at `downbeatS` (the song's SongPlacement and analysis, as the server mixes it).
 */
export function placedWords(words: TimedWord[], atBar: number, bpm: number, downbeatS: number, beatsPerBar = 4): TimedWord[] {
  const at = downbeatS + (atBar - 1) * beatsPerBar * 60 / bpm
  return words.map((w) => ({ text: w.text, start_s: at + w.start_s, end_s: at + w.end_s }))
}

export interface Moment {
  /** 0–1 through the pre-drop stretch (the build's own progress when S2 has one); -1 when no text should show. */
  progress: number
  /** Seconds to the drop hit (negative after it; Infinity when unknown). */
  toDrop: number
  beatS: number
  barS: number
  /** The words shown by now, in order. */
  words: string[]
}

/** Where we are against the next drop, and the words to show, for `bars` bars before it. */
export function moment(a: AudioFrame, track: TextTrack | null, bars: number): Moment {
  const beatS = 60 / (a.bpm > 0 ? a.bpm : 120)
  const barS = 4 * beatS
  const span = bars * barS
  const dropAt = a.dropIn != null && a.dropIn >= 0 ? a.time + a.dropIn * beatS : (track?.drop_s ?? null)
  const toDrop = dropAt == null ? Infinity : dropAt - a.time
  const build = a.buildProgress ?? 0
  let progress = -1
  if (toDrop <= span && toDrop > -barS) progress = build > 0 ? build : Math.min(1, 1 - toDrop / span)
  else if (dropAt == null && build > 0) progress = build
  if (progress < 0 || !track) return { progress, toDrop, beatS, barS, words: [] }
  const from = dropAt == null ? a.time - span : dropAt - span
  const until = dropAt == null ? a.time : dropAt + beatS
  // Untimed: start_s -1 (typedTrack), or a "word" spanning more than 30 s (a drop's script over the whole song).
  const isUntimed = (w: TimedWord) => w.start_s < 0 || w.end_s - w.start_s > 30
  const timed = track.words.filter((w) => !isUntimed(w))
  const untimed = track.words.filter(isUntimed)
  const words = [
    ...timed.filter((w) => w.start_s >= from && w.start_s <= until && w.start_s <= a.time),
    ...untimed.filter((_, i) => progress >= i / untimed.length),
  ].map((w) => latin(w.text)).filter(Boolean)
  return { progress, toDrop, beatS, barS, words }
}
