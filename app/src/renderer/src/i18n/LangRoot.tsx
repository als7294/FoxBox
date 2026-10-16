import { Fragment, useEffect, type ReactNode } from 'react'
import { useLang } from './index'

/** Remounts the app when the language changes, so every t() re-reads (app state lives in stores, so it survives).
 *  ponytail: a remount on a rare user action, not per-component subscriptions; add those if a remount ever hurts. */
export function LangRoot({ children }: { children: ReactNode }) {
  const lang = useLang((s) => s.lang)
  useEffect(() => {
    document.documentElement.lang = lang === 'pt' ? 'pt-BR' : lang
  }, [lang])
  return <Fragment key={lang}>{children}</Fragment>
}
