import type { HTMLAttributes, ReactNode } from 'react'
import styles from './layout.module.css'

/** A non-Studio screen: fills <main> with the design's 12px inset, header on top. */
export function Screen({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={[styles.screen, className].filter(Boolean).join(' ')}>
      {children}
    </div>
  )
}

/** "02 / LIBRARY" kicker over the big display title, with the screen's controls to the right. */
export function ScreenHeader({ code, kicker, title, children }: { code: string; kicker: string; title: string; children?: ReactNode }) {
  return (
    <header className={styles.screenHead} data-reveal="2">
      <div className={styles.screenTitleBox}>
        <span className={styles.screenKicker}>
          {code} / {kicker}
        </span>
        <h1 className={styles.screenTitle}>{title}</h1>
      </div>
      {children}
    </header>
  )
}

/** Panel surface (the design's #111113 card with a hairline border). */
export function Panel({ className, children, as: As = 'section', ...rest }: HTMLAttributes<HTMLElement> & { as?: 'section' | 'div' }) {
  return (
    <As {...rest} className={[styles.panel, className].filter(Boolean).join(' ')}>
      {children}
    </As>
  )
}
