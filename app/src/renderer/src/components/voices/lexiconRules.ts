import type { LexiconEntry } from '@/api/types'

/*
 * How the engine reads a lexicon entry (engine/voice fvwks_voice/lexicon.py, Lexicon.speak):
 * - acronym: it says `say` verbatim, so letters are spelled only when `say` is the word itself ("DJ" → "DJ"; the
 *   engine compares case- and space-insensitively and then says the word in capitals, as it does for a blank `say`);
 *   an acronym with a respelling ("FVWKS" → "Fawkes") is still read as a word;
 * - otherwise: `say`, with ALL-CAPS words lower-cased (read as words).
 * These rules keep the SPELL chip truthful.
 */

const caps = (word: string) => word.trim().toUpperCase()
/** The engine's `_norm_key`: whitespace collapsed, case folded. */
const key = (text: string) => text.split(/\s+/).filter(Boolean).join(' ').toLowerCase()

/** True when the engine spells this entry letter by letter. */
export function isSpelled(e: Pick<LexiconEntry, 'word' | 'say' | 'acronym'>): boolean {
  if (!e.acronym) return false
  const say = key(e.say ?? '')
  return say === '' || say === key(e.word)
}

/**
 * SPELL on: the spoken form becomes the word in capitals. SPELL off: plain again, with `restore` (the respelling that
 * SPELL replaced) when there is one.
 */
export function withSpell(e: LexiconEntry, on: boolean, restore?: string): LexiconEntry {
  return on ? { ...e, say: caps(e.word), acronym: true } : { ...e, say: restore ?? e.say, acronym: false }
}

/** A typed entry is spelled when its spoken form is exactly the word in capitals ("DJ" → "DJ"; "GUY" → "Guy" is a word). */
export function spelledAsTyped(word: string, say: string): boolean {
  const w = caps(word)
  return w.length >= 2 && /[A-Z]/.test(w) && say.trim() === w
}

/** A new spoken form for an entry: a changed one decides SPELL again, an unchanged one keeps it. */
export function withSay(e: LexiconEntry, say: string): LexiconEntry {
  const s = say.trim()
  return s === e.say.trim() ? e : { ...e, say: s, acronym: spelledAsTyped(e.word, s) }
}
