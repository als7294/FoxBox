import { useEffect, useMemo, useRef, useState } from 'react'
import bootBgUrl from '../../../../../design/brand/foxbox-boot-bg.svg?url'
import { AnimatedFoxMark } from '@/components/common/AnimatedFoxMark'
import { bridge } from '@/env'
import { useUi } from '@/state/ui'
import { parseNotes, splitHighlights, versionsToShow, type Notes } from './notes'
import styles from './WhatsNew.module.css'

/** Every release's notes, bundled (so WHAT'S NEW works offline). */
const BUNDLED: Notes[] = Object.entries(
  import.meta.glob('../../../../../release-notes/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>,
).map(([path, md]) => parseNotes(path.replace(/^.*\/|\.md$/g, ''), md))

/** The last version whose WHAT'S NEW was seen (per Mac, in the app's own storage). */
const SEEN_KEY = 'foxbox-whatsnew-seen'
const readSeen = (): string | null => {
  try {
    return localStorage.getItem(SEEN_KEY)
  } catch {
    return null
  }
}
const writeSeen = (v: string) => {
  try {
    localStorage.setItem(SEEN_KEY, v)
  } catch {
    // private storage off: it shows again next start, harmless
  }
}

/** Line glyphs cut from the mark's facets (its 512 grid): ear, eye, muzzle, head, both ears. */
const GLYPHS: { viewBox: string; d: string }[] = [
  { viewBox: '100 92 108 142', d: 'M112 104 L196 190 L130 222 Z' },
  { viewBox: '128 238 132 104', d: 'M140 250 L248 290 L226 330 L176 306 Z' },
  { viewBox: '44 280 424 148', d: 'M56 298 L256 410 L456 298' },
  { viewBox: '44 40 424 446', d: 'M96 56 L204 172 L308 172 L416 56 L452 296 L256 470 L60 296 Z' },
  { viewBox: '100 92 312 142', d: 'M112 104 L196 190 L130 222 Z M400 104 L316 190 L382 222 Z' },
]

/**
 * WHAT'S NEW (1.5): a full-window branded screen, once per version, on the first start after an update: the
 * animated mark over the fox lattice, the release (or every release skipped since the last one seen, merged), up to
 * five highlight cards and the rest listed, then LET'S GO. Not a modal: it's the app's first screen until dismissed.
 */
export function WhatsNew({ current = __APP_VERSION__ }: { current?: string }) {
  const booting = useUi((s) => s.booting)
  const [since, setSince] = useState<string | null | undefined>(undefined)
  const [open, setOpen] = useState(true)
  const go = useRef<HTMLButtonElement>(null)

  // Where the story starts: the last WHAT'S NEW seen, else the version the updater came from, else nothing.
  useEffect(() => {
    const seen = readSeen()
    if (seen) return setSince(seen)
    const b = bridge()
    if (!b) return setSince(null)
    void b.updates.getState().then(
      (s) => {
        if (s.whatsNew?.from) setSince(s.whatsNew.from)
        else {
          // A first install (or storage from before 1.5): nothing to catch up on; start counting from here.
          writeSeen(current)
          setSince(current)
        }
      },
      () => setSince(null),
    )
  }, [current])

  const shown = useMemo(() => (since === undefined ? [] : versionsToShow(BUNDLED, current, since)), [since, current])
  const visible = open && !booting && shown.length > 0
  useEffect(() => {
    if (visible) go.current?.focus()
  }, [visible])
  if (!visible) return null

  const done = () => {
    writeSeen(current)
    setOpen(false)
    void bridge()?.updates.dismissWhatsNew()
  }
  const { cards, more } = splitHighlights(shown)
  const newest = shown[0]!
  const oldest = shown[shown.length - 1]!
  return (
    <section
      className={styles.screen}
      aria-label="What's new"
      data-testid="whats-new"
      onKeyDown={(e) => {
        if (e.key === 'Escape') done()
      }}
    >
      <img className={styles.bg} src={bootBgUrl} alt="" aria-hidden="true" draggable={false} />
      <div className={styles.inner}>
        <header className={styles.head}>
          <AnimatedFoxMark size={96} className={styles.mark} />
          <p className={styles.kicker}>WHAT’S NEW{shown.length > 1 ? ` · ${oldest.version} → ${newest.version}` : ''}</p>
          <h1 className={styles.title}>
            FOXBOX {newest.version}
            {newest.title && <span className={styles.subtitle}>{newest.title}</span>}
          </h1>
        </header>
        <ol className={styles.cards}>
          {cards.map((h, i) => {
            const g = GLYPHS[i % GLYPHS.length]!
            return (
              <li key={`${h.version}-${i}`} className={styles.card} style={{ animationDelay: `${120 + i * 70}ms` }}>
                <div className={styles.cardTop}>
                  <span className={styles.num}>{String(i + 1).padStart(2, '0')}</span>
                  <svg className={styles.glyph} viewBox={g.viewBox} aria-hidden="true">
                    <path d={g.d} />
                  </svg>
                </div>
                {h.title && <h2 className={styles.cardTitle}>{h.title}</h2>}
                <p className={styles.cardBody}>{h.body}</p>
                {shown.length > 1 && <span className={styles.ver}>{h.version}</span>}
              </li>
            )
          })}
        </ol>
        {more.length > 0 && (
          <ul className={styles.more} aria-label="Also new">
            {more.map((h, i) => (
              <li key={`${h.version}-m${i}`}>
                {h.title ? `${h.title}: ` : ''}
                {h.body}
              </li>
            ))}
          </ul>
        )}
        <footer className={styles.foot}>
          <button ref={go} type="button" className={styles.go} onClick={done} data-testid="whats-new-go">
            LET’S GO
          </button>
          <p className={styles.signoff}>Stay stealthy.</p>
        </footer>
      </div>
    </section>
  )
}
