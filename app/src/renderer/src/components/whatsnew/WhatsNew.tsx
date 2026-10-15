import { useEffect, useMemo, useRef, useState } from 'react'
import bootBgUrl from '../../../../../design/brand/foxbox-boot-bg.svg?url'
import { AnimatedFoxMark } from '@/components/common/AnimatedFoxMark'
import { bridge } from '@/env'
import { useUi } from '@/state/ui'
import { parseNotes, splitHighlights, toHighlight, versionsToShow, type Notes } from './notes'
import voiceLockupUrl from '../../../../../design/brand/foxbox-voice-lockup.svg?url'
import launchFilm from '@/assets/launch/foxbox-launch.mp4'
import { GuideHands, type GuideMove } from '@/components/guide/GuideHands'
import { guide } from '@/components/guide/guideStore'
import styles from './WhatsNew.module.css'
import w from './whatsnew2.module.css'

/** Every release's notes, bundled (so WHAT'S NEW works offline). */
const BUNDLED: Notes[] = Object.entries(
  import.meta.glob('../../../../../release-notes/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>,
).map(([path, md]) => parseNotes(path.replace(/^.*\/|\.md$/g, ''), md))

/** FoxBox 1.5.5, where STUDIO, VISUALS, MASKS and more live on. */
export const LEGACY_URL = 'https://github.com/als7294/FoxBox/releases/tag/v1.5.5'

const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** FoxBox VOICE's page (main opens exactly this URL in the browser). */
export const VOICE_URL = 'https://foxbox.tech/voice/'

/** The FoxBox VOICE card (the user's ask): its lockup, its line, its film (S2's clip; the aurora until it lands), the CTA. */
function VoiceCard() {
  return (
    <section className={w.voice} aria-label="FoxBox Voice">
      {/* ponytail: the aurora stands in for S2's ≤ 2 MB clip + poster (muted autoplay, the poster with reduced motion) */}
      <div className={w.voiceFilm} aria-hidden="true" />
      <div className={w.voiceText}>
        <img className={w.voiceLockup} src={voiceLockupUrl} alt="FoxBox Voice · beta" draggable={false} />
        <p className={w.voiceLine}>Type a line. Get a finished vocal, cut to the bar and ready to drag into Ableton or Rekordbox.</p>
        <a className={w.voiceCta} href={VOICE_URL} target="_blank" rel="noreferrer">
          Get FoxBox Voice →
        </a>
        <span className={w.voiceSmall}>Mac only · invite beta</span>
      </div>
    </section>
  )
}

/** 2.0's headline features, each with its move (S3's GuideHands). */
const CARDS_2: { title: string; body: string; move: GuideMove }[] = [
  { title: 'SAUCE', body: 'Strings between your hands. Curl a finger to pluck, twist to bend, frame to loop.', move: 'pluck' },
  { title: 'REMIX', body: 'Any track, live. Hold a fist for TEAROUT on the beat, fold a finger to cut a band.', move: 'fist' },
  { title: 'Library', body: 'Rekordbox, Serato or a folder on a wheel. Hold the shaka to open it.', move: 'shaka' },
  {
    title: 'GLASS',
    body: 'Frame a window: the last 4 beats loop. Pinch to change it, turn your hands over to flip it.',
    move: 'frame-glass',
  },
]

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
  // 2.0's first start shows its explainer even before its notes are bundled
  const v2 = current.startsWith('2.') && (since == null || Number(since.split('.')[0]) < 2) // from 1.x (or a first start)
  const visible = open && !booting && (shown.length > 0 || v2)
  useEffect(() => useUi.setState({ whatsNew: visible }), [visible])
  useEffect(() => {
    if (visible) go.current?.focus()
  }, [visible])
  if (!visible) return null

  const done = () => {
    writeSeen(current)
    setOpen(false)
    void bridge()?.updates.dismissWhatsNew()
  }
  if (v2) {
    // WHAT'S NEW 2.0: the launch film behind, what's new on glass cards with S3's hand demos, Let's play or the GUIDE
    const lines = shown.flatMap((n) => n.lines.map((l) => toHighlight(n.version, l)))
    return (
      <section
        className={w.screen}
        data-fb
        aria-label="What's new"
        data-testid="whats-new"
        onKeyDown={(e) => {
          if (e.key === 'Escape') done()
        }}
      >
        <video className={w.film} src={launchFilm} autoPlay={!REDUCED} muted loop playsInline preload="auto" aria-hidden="true" />
        <div className={w.shade} aria-hidden="true" />
        <div className={w.col}>
          <p className={w.kicker}>WHAT’S NEW · {current.split('.').slice(0, 2).join('.')}</p>
          <h1 className={w.title}>FoxBox is now an instrument for your hands</h1>
          <ul className={w.cards}>
            {CARDS_2.map((c) => (
              <li key={c.title} className={w.card}>
                <div className={w.demo}>
                  <GuideHands move={c.move} width={200} />
                </div>
                <b className={w.cardTitle}>{c.title}</b>
                <span className={w.cardBody}>{c.body}</span>
              </li>
            ))}
          </ul>
          <VoiceCard />
          {lines.length > 0 && (
            <details className={w.all}>
              <summary>Everything new in 2.0</summary>
              <ul className={w.more} aria-label="Also new">
                {lines.map((h, i) => (
                  <li key={i}>
                    {h.title ? `${h.title}: ` : ''}
                    {h.body}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className={w.ctas}>
            <button ref={go} type="button" className={w.go} onClick={done} data-testid="whats-new-go">
              Let’s play
            </button>
            <button
              type="button"
              className={w.how}
              onClick={() => {
                done()
                guide.open(useUi.getState().mode, 0)
              }}
            >
              Show me how
            </button>
          </div>
          <p className={w.legacy}>
            Looking for STUDIO, MASKS or the TouchDesigner visuals? They live on in{' '}
            <a href={LEGACY_URL} target="_blank" rel="noreferrer">
              FoxBox 1.5.5
            </a>
            .
          </p>
        </div>
      </section>
    )
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
