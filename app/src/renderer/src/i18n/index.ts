import { create } from 'zustand'
import de from './de.json'
import es from './es.json'
import fr from './fr.json'
import ja from './ja.json'
import pt from './pt.json'

/**
 * FoxBox's languages (2.1): `t('area.key', 'English text', { n: 3 })`. English lives in the code as the fallback, so
 * every string still reads right before it's translated; each other language is one flat JSON of key → text, with
 * {name} placeholders. Feature names stay English in every language (SAUCE, REMIX, FRAME styles, presets).
 *
 * The language follows the system's unless the user picks one (the first-run setup card, Settings → Language).
 * The app root remounts on a change (see LangRoot), so components just call t() while they render.
 */
export type Lang = 'en' | 'es' | 'pt' | 'fr' | 'de' | 'ja'

/** The languages that ship, in their own names; the setup card and Settings list exactly these. Beta: not yet read
 *  by a native speaker (2.1.1's PT-BR, FR, DE, JA); Settings and the setup card say so. */
export const LANGS: readonly { id: Lang; name: string; beta?: boolean }[] = [
  { id: 'en', name: 'English' },
  { id: 'es', name: 'Español' },
  { id: 'pt', name: 'Português (BR)', beta: true }, // short: the setup card's pill holds it on one line
  { id: 'fr', name: 'Français', beta: true },
  { id: 'de', name: 'Deutsch', beta: true },
  { id: 'ja', name: '日本語', beta: true },
]

export const DICTS: Record<Exclude<Lang, 'en'>, Record<string, string>> = { es, pt, fr, de, ja }
const KEY = 'foxbox-lang'

/** The system's language if FoxBox has it, else English. */
export function systemLang(locale = typeof navigator === 'undefined' ? 'en' : navigator.language): Lang {
  const base = locale.toLowerCase().split(/[-_]/)[0]
  return LANGS.some((l) => l.id === base) ? (base as Lang) : 'en'
}

function load(): Lang | 'system' {
  try {
    const v = window.localStorage.getItem(KEY)
    return v && LANGS.some((l) => l.id === v) ? (v as Lang) : 'system'
  } catch {
    return 'system'
  }
}

interface LangState {
  /** The user's pick, or 'system' to follow the Mac. */
  choice: Lang | 'system'
  /** The language in use. */
  lang: Lang
  setChoice(choice: Lang | 'system'): void
}

export const useLang = create<LangState>((set) => {
  const choice = load()
  return {
    choice,
    lang: choice === 'system' ? systemLang() : choice,
    setChoice(next) {
      try {
        if (next === 'system') window.localStorage.removeItem(KEY)
        else window.localStorage.setItem(KEY, next)
      } catch {
        // Blocked storage: the choice holds for this session.
      }
      set({ choice: next, lang: next === 'system' ? systemLang() : next })
    },
  }
})

/** The text for `key` in the language in use, falling back to the English in the code; {name} takes vars.name. */
export function t(key: string, english: string, vars?: Record<string, string | number>): string {
  const lang = useLang.getState().lang
  const text = (lang === 'en' ? undefined : DICTS[lang][key]) ?? english
  return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : text
}
