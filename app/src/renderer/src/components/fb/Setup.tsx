// 2.1 first-run setup (docs/STRINGS_UX.md, "First-run setup"), 2.1.1's guided mode entry (docs/MODE_ENTRY_UX.md §0–1):
// big cards after the launch screen and before the camera. A new install: language, face hiding, how you play (the
// style and the lead hand), the music, then what we're playing (the mode chooser). An update: how you play and the mode,
// once each, after WHAT'S NEW. A pick moves on (how you play waits for Next: it asks two things); "Skip setup" or Esc
// skips the questions with the defaults, never the mode. Every answer is in Settings later. The plan and the step live in
// a store: a language change remounts the app (LangRoot).
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { create } from 'zustand'
import onePlay from '@/assets/modes/one.webm'
import palmPlay from '@/assets/modes/palm.webm'
import pluckPlay from '@/assets/modes/pluck.webm'
import { usePlayPrefs, type ControlStyle } from '@/components/camera/playPrefs'
import { useGuide } from '@/components/guide/guideStore'
import { useProd } from '@/components/prod/prodStore'
import { bridge } from '@/env'
import { LANGS, systemLang, t, useLang } from '@/i18n'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'
import s from './setup.module.css'
import { computer } from '@/lib/platform'
import { ModeCards } from './ModeCards'
import { enterMode, TOP_MODES, type TopMode } from './modes'

const DONE_KEY = 'foxbox-setup-done'
/** How you play was asked (2.1's setup asked it too, as its card 4). */
const STYLE_KEY = 'foxbox-style-asked'
const MODE_KEY = 'foxbox-mode-chosen'
const stored = (key: string): boolean => {
  try {
    return Boolean(localStorage.getItem(key))
  } catch {
    return true // no storage: don't ask every launch
  }
}
const remember = (key: string): void => {
  try {
    localStorage.setItem(key, '1')
  } catch {
    // storage off: asked again next launch
  }
}

type CardId = 'lang' | 'face' | 'hands' | 'music' | 'modes'
/** What setup asks: the first run's questions (someone who has played 2.0 counts as set up), how you play once, the mode once. */
export function setupPlan(done: boolean, styleAsked: boolean, modeChosen: boolean): CardId[] {
  const plan: CardId[] = []
  if (!done) plan.push('lang', 'face')
  if (!styleAsked) plan.push('hands')
  if (!done) plan.push('music')
  if (!modeChosen) plan.push('modes')
  return plan
}
const firstPlan = (): CardId[] => {
  const done = stored(DONE_KEY) || useGuide.getState().shown.play
  return setupPlan(done, done ? stored(STYLE_KEY) || stored(DONE_KEY) : false, stored(MODE_KEY))
}
export const useSetup = create<{ plan: CardId[]; step: number }>(() => ({ plan: firstPlan(), step: 0 }))
/** Setup still has a card to show (after the launch and WHAT'S NEW). */
export const setupOpen = (x: { plan: CardId[]; step: number }): boolean => x.step < x.plan.length

function next(): void {
  const { plan, step } = useSetup.getState()
  if (plan[step] === 'music') remember(DONE_KEY) // the first run's last question
  useSetup.setState({ step: step + 1 })
}
/** Skip setup (Esc): the questions keep their defaults; the mode is still asked. */
function skip(): void {
  const { plan } = useSetup.getState()
  remember(DONE_KEY)
  remember(STYLE_KEY)
  const modes = plan.indexOf('modes')
  useSetup.setState({ step: modes >= 0 ? modes : plan.length })
}
function pickMode(m: TopMode): void {
  remember(MODE_KEY)
  enterMode(m)
  useSetup.setState({ step: useSetup.getState().plan.length })
}

/** A music source through the native picker (main adds it to the engine). Cancelled: stay on the card. */
async function addSource(kind: 'folder' | 'rekordbox' | 'serato'): Promise<boolean> {
  const b = bridge()
  if (!b) return true
  const r = await b.addLibrarySource(kind).catch((e: Error) => ({ added: false, error: e.message }))
  if (r.error) toast.error(t('setup.music.failed', 'Couldn’t add that'), { detail: r.error })
  return r.added
}

interface Choice {
  id: string
  label: string
  /** Sets it; false: stay on this card (a cancelled picker). */
  pick: () => void | boolean | Promise<boolean>
}
interface Card {
  title: string
  line?: string
  foot?: string
  /** One big choice per card (a pick moves on), or the card's own body. */
  def?: string
  choices?: Choice[]
  body?: () => ReactNode
  /** The wide glass (three demos side by side). */
  wide?: boolean
}

const PLAY_DEMO: Record<ControlStyle, string> = { curl: pluckPlay, palm: palmPlay, one: onePlay }
const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** How you play (§0): three picks, each a live demo; the lead hand under them. Picking doesn't move on, Next does. */
function HowYouPlay() {
  const style = usePlayPrefs((p) => p.controlStyle)
  const left = usePlayPrefs((p) => p.leftHanded)
  const picks: { id: ControlStyle; two: boolean; name: string; feel: string }[] = [
    { id: 'curl', two: true, name: t('hands.curl', 'curl a finger'), feel: t('hands.curl.feel', 'Small, precise moves.') },
    {
      id: 'palm',
      two: true,
      name: t('hands.palm', 'tap with your palm'),
      feel: t('hands.palm.feel', 'Bigger and looser, like a drum pad.'),
    },
    { id: 'one', two: false, name: t('hands.one', 'One hand'), feel: t('hands.one.feel', 'Everything with either hand.') },
  ]
  return (
    <>
      <div className={s.picks} role="radiogroup" aria-label={t('hands.title', 'How do you play?')}>
        {picks.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={style === p.id}
            data-default={style === p.id || undefined}
            className={s.pick}
            onClick={() => usePlayPrefs.getState().setControlStyle(p.id)}
            onFocus={() => usePlayPrefs.getState().setControlStyle(p.id)}
          >
            <span className={s.pickDemo}>
              <video src={PLAY_DEMO[p.id]} autoPlay={!REDUCED} muted loop playsInline preload="auto" aria-hidden="true" />
              {style === p.id && (
                <span className={s.tick} aria-hidden="true">
                  ✓
                </span>
              )}
            </span>
            <span className={s.pickText}>
              {p.two && <span className={s.pickTwo}>{t('hands.two', 'Two hands ·')}</span>}
              <b className={s.pickName}>{p.name}</b>
              <span className={s.pickFeel}>{p.feel}</span>
            </span>
          </button>
        ))}
      </div>
      <div className={s.lead}>
        <b className={s.leadName}>{t('hands.lead', 'Lead hand')}</b>
        <span className={s.toggle} role="radiogroup" aria-label={t('hands.lead', 'Lead hand')}>
          {[true, false].map((l) => (
            <button
              key={String(l)}
              type="button"
              role="radio"
              aria-checked={left === l}
              onClick={() => usePlayPrefs.getState().setLeftHanded(l)}
            >
              {l ? t('setup.hand.left', 'Left') : t('setup.hand.right', 'Right')}
            </button>
          ))}
        </span>
        <span className={s.leadLine}>{t('setup.hand.line', 'Your lead hand plays the pitch in FLOW and spins the library.')}</span>
      </div>
    </>
  )
}

function card(id: CardId): Card {
  switch (id) {
    case 'lang':
      return {
        title: t('setup.lang.title', 'Your language'),
        def: useLang.getState().lang,
        choices: LANGS.map((l) => ({
          id: l.id,
          label: l.beta ? t('lang.beta', '{name} · beta', { name: l.name }) : l.name,
          pick: () => useLang.getState().setChoice(l.id === systemLang() ? 'system' : l.id),
        })),
      }
    case 'face':
      return {
        title: t('setup.face.title', 'Hide your face by default?'),
        line: t('setup.face.line', 'FoxBox can cover your face in takes and on outputs.'),
        def: useProd.getState().faceHiding ? 'hide' : 'show',
        choices: [
          { id: 'show', label: t('setup.face.show', 'Show it'), pick: () => useProd.getState().setFaceHiding(false) },
          { id: 'hide', label: t('setup.face.hide', 'Hide my face'), pick: () => useProd.getState().setFaceHiding(true) },
        ],
      }
    case 'hands':
      return {
        title: t('hands.title', 'How do you play?'),
        line: t('hands.line', 'Like being a lefty or riding goofy: there’s no right way, just your way.'),
        foot: t('hands.foot', 'Switch any time in Settings → Playing.'),
        body: () => <HowYouPlay />,
        wide: true,
      }
    case 'music':
      return {
        title: t('setup.music.title', 'Where’s your music?'),
        line: t('setup.music.line', 'For REMIX’s library. Nothing leaves {computer}.', { computer: computer() }),
        def: 'later',
        choices: [
          { id: 'folder', label: t('setup.music.folder', 'A folder…'), pick: () => addSource('folder') },
          { id: 'rekordbox', label: t('setup.music.rekordbox', 'Rekordbox XML…'), pick: () => addSource('rekordbox') },
          { id: 'serato', label: 'Serato', pick: () => addSource('serato') },
          { id: 'later', label: t('setup.music.later', 'Later'), pick: () => {} },
        ],
      }
    case 'modes':
      return {
        title: t('modes.title', 'What are we playing?'),
        line: t('modes.line', 'Pick one. Switch any time from the top of the screen, or press M.'),
        foot: t('modes.foot', 'Not sure? Start with SAUCE.'),
        body: () => <ModeCards focus="sauce" onPick={pickMode} />,
        wide: true,
      }
  }
}

export function Setup() {
  const booting = useUi((u) => u.booting)
  const whatsNew = useUi((u) => u.whatsNew)
  const plan = useSetup((x) => x.plan)
  const step = useSetup((x) => x.step)
  const box = useRef<HTMLDivElement>(null)
  const show = step < plan.length && !booting && !whatsNew
  useEffect(() => {
    if (show) box.current?.querySelector<HTMLElement>('[data-default]')?.focus()
  }, [show, step])
  if (!show) return null
  const id = plan[step]!
  const c = card(id)
  const choose = async (ch: Choice) => {
    if ((await ch.pick()) === false) return
    next()
  }
  const onKey = (e: KeyboardEvent) => {
    if (id === 'modes' && /^[123]$/.test(e.key)) return pickMode(TOP_MODES[Number(e.key) - 1]!)
    if (e.key === 'Escape') return id === 'modes' ? pickMode('sauce') : skip()
    if (id === 'hands' && e.key === 'Enter' && !(e.target as HTMLElement).closest(`.${s.toggle}`)) {
      e.preventDefault() // Enter is Next (the lead hand's toggle keeps its own)
      remember(STYLE_KEY)
      return next()
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    // the arrows move within the focused choice's own group
    const group = (document.activeElement as HTMLElement | null)?.closest('[role="radiogroup"]')
    if (!group) return
    e.preventDefault()
    const btns = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    const at = btns.indexOf(document.activeElement as HTMLButtonElement)
    const by = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1
    btns[(at + by + btns.length) % btns.length]?.focus()
  }
  return (
    <div className={s.screen} data-fb role="region" aria-label={t('setup.label', 'Setup')} onKeyDown={onKey}>
      <div ref={box} key={step} className={s.card} data-wide={c.wide || undefined}>
        <div className={s.top}>
          <span className={s.dots} aria-label={t('setup.progress', 'Step {n} of {all}', { n: step + 1, all: plan.length })}>
            {plan.map((_, i) => (
              <span key={i} className={s.dot} data-on={i <= step || undefined} />
            ))}
          </span>
          {id !== 'modes' && (
            <button type="button" className={s.skip} onClick={skip}>
              {plan.includes('lang') ? t('setup.skip', 'Skip setup') : t('guide.skip', 'Skip')}
            </button>
          )}
        </div>
        <h1 className={s.title}>{c.title}</h1>
        {c.line && <p className={s.line}>{c.line}</p>}
        {c.body ? (
          <div className={s.body}>{c.body()}</div>
        ) : (
          <div className={s.choices} role="radiogroup" aria-label={c.title} data-many={(c.choices?.length ?? 0) > 2 || undefined}>
            {c.choices?.map((ch) => (
              <button
                key={ch.id}
                type="button"
                role="radio"
                aria-checked={ch.id === c.def}
                data-default={ch.id === c.def || undefined}
                className={s.choice}
                onClick={() => void choose(ch)}
              >
                {ch.label}
              </button>
            ))}
          </div>
        )}
        <div className={s.bottom}>
          <p className={s.foot}>{c.foot ?? t('setup.later', 'You can change this anytime in Settings.')}</p>
          {id === 'hands' && (
            <button
              type="button"
              className={s.next}
              onClick={() => {
                remember(STYLE_KEY)
                next()
              }}
            >
              {t('guide.next', 'Next')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
