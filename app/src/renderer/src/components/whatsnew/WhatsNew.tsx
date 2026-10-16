import { useEffect, useMemo, useRef, useState } from 'react'
import { bridge, isWindows } from '@/env'
import { useUi } from '@/state/ui'
import { t, useLang } from '@/i18n'
import { parseNotes, splitHighlights, toHighlight, versionsToShow, type Notes } from './notes'
import voiceLockupUrl from '../../../../../design/brand/foxbox-voice-lockup.svg?url'
import launchFilm from '@/assets/launch/foxbox-launch.mp4'
import { GuideHands, type GuideMove } from '@/components/guide/GuideHands'
import { guide } from '@/components/guide/guideStore'
import w from './whatsnew2.module.css'

const parseAll = (files: Record<string, string>): Notes[] =>
  Object.entries(files).map(([path, md]) => parseNotes(path.replace(/^.*\/|\.md$/g, ''), md))
/** Every release's notes, bundled (so WHAT'S NEW works offline). */
const BUNDLED: Notes[] = parseAll(import.meta.glob('../../../../../release-notes/*.md', { query: '?raw', import: 'default', eager: true }))
/** Translated notes (release-notes/<lang>/<version>.md) where written; the English stands in for the rest. */
const TRANSLATED = new Map(
  Object.entries(import.meta.glob('../../../../../release-notes/*/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>).map(
    ([path, md]) => {
      const [, lang = '', version = ''] = /([\w-]+)\/([^/]+)\.md$/.exec(path) ?? []
      return [`${lang}/${version}`, parseNotes(version, md)] as const
    },
  ),
)
const bundled = (): Notes[] => {
  const lang = useLang.getState().lang
  return BUNDLED.map((n) => TRANSLATED.get(`${lang}/${n.version}`) ?? n)
}

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
        <p className={w.voiceLine}>
          {t('whatsnew.voice.line', 'Type a line. Get a finished vocal, cut to the bar and ready to drag into Ableton or Rekordbox.')}
        </p>
        <a className={w.voiceCta} href={VOICE_URL} target="_blank" rel="noreferrer">
          {t('whatsnew.voice.cta', 'Get FoxBox Voice →')}
        </a>
        <span className={w.voiceSmall}>{t('whatsnew.voice.small', 'Mac only · invite beta')}</span>
      </div>
    </section>
  )
}

/** 2.0's headline features, each with its move (S3's GuideHands); built at render time, in the language in use. */
const cards2 = (): { title: string; body: string; move: GuideMove }[] => [
  { title: 'SAUCE', body: t('whatsnew.card.sauce', 'Strings between your hands. Curl a finger to pluck, twist to bend, frame to loop.'), move: 'pluck' },
  { title: 'REMIX', body: t('whatsnew.card.remix', 'Any track, live. Hold a fist for TEAROUT on the beat, fold a finger to cut a band.'), move: 'fist' },
  { title: t('whatsnew.card.library.title', 'Library'), body: t('whatsnew.card.library', 'Rekordbox, Serato or a folder on a wheel. Hold the shaka to open it.'), move: 'shaka' },
  {
    title: t('whatsnew.card.frames.title', 'Frames'),
    body: t('whatsnew.card.frames', 'Hold a frame: the last 4 beats loop. Pull wider for more, let go to stop.'),
    move: 'frame-glass',
  },
]

/** 2.1's headline features, each with its move; the release notes list everything under them. */
const cards21 = (): { title: string; body: string; move: GuideMove }[] => [
  {
    title: 'LOOP',
    body: t('whatsnew21.loop', 'Pick a melody and it loops on the beat. Right hand up for brighter, left for higher, a fist drops it.'),
    move: 'melody',
  },
  {
    title: t('whatsnew.card.frames.title', 'Frames'),
    body: t('whatsnew21.frames', 'Hold a frame: the last 4 beats loop. Wider for more, let go to stop. Each new frame is the next effect.'),
    move: 'frame',
  },
  {
    title: t('whatsnew21.style.title', 'How you play'),
    body: t('whatsnew21.style', 'CURL, PALM or ONE HAND. No wrong answer. Switch any time in Settings.'),
    move: 'palm-tap',
  },
  {
    title: 'MIDI + Ableton',
    body: t('whatsnew21.midi', 'Your hands play any synth: the FoxBox MIDI port, a device for Live, Link tempo and .mid takes.'),
    move: 'pluck',
  },
]

/** The Windows beta (W1): SAUCE and Frames (REMIX and the Library aren't there yet), then its own card. */
export const whatsNewCards = (): { title: string; body: string; move: GuideMove }[] => {
  const all = cards2()
  if (!isWindows()) return all
  return [
    ...all.filter((c) => c.move === 'pluck' || c.move === 'frame-glass'),
    {
      title: t('whatsnew.card.windows.title', 'Windows beta'),
      body: t('whatsnew.card.windows', 'FoxBox Strings, now on Windows: SAUCE and Frames today. REMIX and the library are coming.'),
      move: 'c-pose',
    },
  ]
}

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

/**
 * WHAT'S NEW: a full-window screen, once per version, on the first start after an update: the
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

  const shown = useMemo(() => (since === undefined ? [] : versionsToShow(bundled(), current, since)), [since, current])
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
  // WHAT'S NEW 2.0 and 2.1: the launch film behind, the headline features on glass cards with S3's hand demos, the
  // notes folded under them, Let's play or the GUIDE
  const head = v2
    ? { title: t('whatsnew.title', 'FoxBox is now an instrument for your hands'), cards: cards2(), all: t('whatsnew.all', 'Everything new in 2.0') }
    : shown.some((n) => n.version === '2.1.0')
      ? { title: shown[0]!.title ?? `FoxBox ${current}`, cards: cards21(), all: t('whatsnew.all21', 'Everything new in 2.1') }
      : null
  if (head) {
    const lines = shown.flatMap((n) => n.lines.map((l) => toHighlight(n.version, l)))
    return (
      <section
        className={w.screen}
        data-fb
        aria-label={t('whatsnew.aria', 'What’s new')}
        data-testid="whats-new"
        onKeyDown={(e) => {
          if (e.key === 'Escape') done()
        }}
      >
        <video className={w.film} src={launchFilm} autoPlay={!REDUCED} muted loop playsInline preload="auto" aria-hidden="true" />
        <div className={w.shade} aria-hidden="true" />
        <div className={w.col}>
          <p className={w.kicker}>{t('whatsnew.kicker', 'WHAT’S NEW · {v}', { v: current.split('.').slice(0, 2).join('.') })}</p>
          <h1 className={w.title}>{head.title}</h1>
          <ul className={w.cards}>
            {(isWindows() ? whatsNewCards() : head.cards).map((c) => (
              <li key={c.title} className={w.card}>
                <div className={w.demo}>
                  <GuideHands move={c.move} width={200} />
                </div>
                <b className={w.cardTitle}>{c.title}</b>
                <span className={w.cardBody}>{c.body}</span>
              </li>
            ))}
          </ul>
          {v2 && !isWindows() && <VoiceCard />}
          {lines.length > 0 && (
            <details className={w.all}>
              <summary>{head.all}</summary>
              <ul className={w.more} aria-label={t('whatsnew.more.aria', 'Also new')}>
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
              {t('whatsnew.go', 'Let’s play')}
            </button>
            <button
              type="button"
              className={w.how}
              onClick={() => {
                done()
                guide.open(useUi.getState().mode, 0)
              }}
            >
              {t('whatsnew.how', 'Show me how')}
            </button>
          </div>
          {v2 && !isWindows() && ( // 1.5.5 was Mac only
            <p className={w.legacy}>
              {t('whatsnew.legacy', 'Looking for STUDIO, MASKS or the TouchDesigner visuals? They live on in')}{' '}
              <a href={LEGACY_URL} target="_blank" rel="noreferrer">
                FoxBox 1.5.5
              </a>
              .
            </p>
          )}
        </div>
      </section>
    )
  }
  // a point release (2.0.x): the same film and column, its notes as one compact list of glass cards
  const { cards, more } = splitHighlights(shown)
  const newest = shown[0]!
  const oldest = shown[shown.length - 1]!
  return (
    <section
      className={w.screen}
      data-fb
      aria-label={t('whatsnew.aria', 'What’s new')}
      data-testid="whats-new"
      onKeyDown={(e) => {
        if (e.key === 'Escape') done()
      }}
    >
      <video className={w.film} src={launchFilm} autoPlay={!REDUCED} muted loop playsInline preload="auto" aria-hidden="true" />
      <div className={w.shade} aria-hidden="true" />
      <div className={w.col}>
        <p className={w.kicker}>
          {t('whatsnew.kicker', 'WHAT’S NEW · {v}', { v: shown.length > 1 ? `${oldest.version} → ${newest.version}` : newest.version })}
        </p>
        <h1 className={w.title}>{newest.title ?? `FoxBox ${newest.version}`}</h1>
        <ul className={w.list}>
          {[...cards, ...more].map((h, i) => (
            <li key={`${h.version}-${i}`} className={w.item}>
              {h.title && <b className={w.itemTitle}>{h.title}</b>}
              <span className={w.itemBody}>{h.body}</span>
            </li>
          ))}
        </ul>
        <div className={w.ctas}>
          <button ref={go} type="button" className={w.go} onClick={done} data-testid="whats-new-go">
            {t('whatsnew.go', 'Let’s play')}
          </button>
          <button
            type="button"
            className={w.how}
            onClick={() => {
              done()
              guide.open(useUi.getState().mode, 0)
            }}
          >
            {t('whatsnew.how', 'Show me how')}
          </button>
        </div>
      </div>
    </section>
  )
}
