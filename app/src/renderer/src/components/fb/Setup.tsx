// 2.1 first-run setup (docs/STRINGS_UX.md, "First-run setup"): five quick cards after the launch screen and before the
// camera: language, face hiding, the lead hand, how you play (CURL · PALM · ONE HAND), the music. Each is one big choice, the default first
// in focus; a pick moves on, Esc or "Skip setup" keeps the defaults. Once, for new installs (someone who has played
// 2.0 already counts as set up). Every answer is in Settings later. The step lives in a store: a language change
// remounts the app (LangRoot).
import { useEffect, useRef, type KeyboardEvent } from 'react'
import { create } from 'zustand'
import { usePlayPrefs } from '@/components/camera/playPrefs'
import { useGuide } from '@/components/guide/guideStore'
import { useProd } from '@/components/prod/prodStore'
import { bridge } from '@/env'
import { LANGS, systemLang, t, useLang } from '@/i18n'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'
import s from './setup.module.css'
import { computer } from '@/lib/platform'

const DONE_KEY = 'foxbox-setup-done'
function wasDone(): boolean {
  try {
    return Boolean(localStorage.getItem(DONE_KEY)) || useGuide.getState().shown.play
  } catch {
    return true // no storage: don't ask every launch
  }
}
export const useSetup = create<{ step: number; done: boolean }>(() => ({ step: 0, done: wasDone() }))
function finish(): void {
  try {
    localStorage.setItem(DONE_KEY, '1')
  } catch {
    // storage off: done for this session
  }
  useSetup.setState({ done: true })
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
  /** A line under the label. */
  sub?: string
  /** Sets it; false: stay on this card (a cancelled picker). */
  pick: () => void | boolean | Promise<boolean>
}
interface Card {
  title: string
  line?: string
  /** The card's own footer, in place of the usual one. */
  foot?: string
  def: string
  choices: Choice[]
}

function cards(): Card[] {
  const prefs = usePlayPrefs.getState()
  return [
    {
      title: t('setup.lang.title', 'Your language'),
      def: useLang.getState().lang,
      choices: LANGS.map((l) => ({
        id: l.id,
        label: l.beta ? t('lang.beta', '{name} · beta', { name: l.name }) : l.name,
        pick: () => useLang.getState().setChoice(l.id === systemLang() ? 'system' : l.id),
      })),
    },
    {
      title: t('setup.face.title', 'Hide your face by default?'),
      line: t('setup.face.line', 'FoxBox can cover your face in takes and on outputs.'),
      def: useProd.getState().faceHiding ? 'hide' : 'show',
      choices: [
        { id: 'show', label: t('setup.face.show', 'Show it'), pick: () => useProd.getState().setFaceHiding(false) },
        { id: 'hide', label: t('setup.face.hide', 'Hide my face'), pick: () => useProd.getState().setFaceHiding(true) },
      ],
    },
    {
      title: t('setup.hand.title', 'Which hand leads?'),
      line: t('setup.hand.line', 'Your lead hand plays the pitch in FLOW and spins the library.'),
      def: prefs.leftHanded ? 'left' : 'right',
      choices: [
        { id: 'right', label: t('setup.hand.right', 'Right'), pick: () => prefs.setLeftHanded(false) },
        { id: 'left', label: t('setup.hand.left', 'Left'), pick: () => prefs.setLeftHanded(true) },
      ],
    },
    {
      title: t('setup.style.title', 'How do you like to play?'),
      foot: t(
        'setup.style.foot',
        'No style is better. Like your stance on a skateboard or how you hold a pen, it’s your own motor style. Switch any time in Settings → Playing.',
      ),
      def: prefs.controlStyle,
      // the GUIDE and the coach follow the pick (stepsFor, the HANDS legend)
      choices: [
        { id: 'curl', label: t('style.curl', 'CURL'), sub: t('style.curl.sub', 'Curl a finger to pluck. Small, precise moves, like writing.'), pick: () => prefs.setControlStyle('curl') },
        { id: 'palm', label: t('style.palm', 'PALM'), sub: t('style.palm.sub', 'Tap the air with an open palm. Bigger, looser moves, like drumming.'), pick: () => prefs.setControlStyle('palm') },
        { id: 'one', label: t('style.one', 'ONE HAND'), sub: t('style.one.sub', 'Everything with either hand. Hold a shape to switch its effect.'), pick: () => prefs.setControlStyle('one') },
      ],
    },
    {
      title: t('setup.music.title', 'Where’s your music?'),
      line: t('setup.music.line', 'For REMIX’s library. Nothing leaves {computer}.', { computer: computer() }),
      def: 'later',
      choices: [
        { id: 'folder', label: t('setup.music.folder', 'A folder…'), pick: () => addSource('folder') },
        { id: 'rekordbox', label: t('setup.music.rekordbox', 'Rekordbox XML…'), pick: () => addSource('rekordbox') },
        { id: 'serato', label: 'Serato', pick: () => addSource('serato') },
        { id: 'later', label: t('setup.music.later', 'Later'), pick: () => {} },
      ],
    },
  ]
}

export function Setup() {
  const booting = useUi((u) => u.booting)
  const whatsNew = useUi((u) => u.whatsNew)
  const step = useSetup((x) => x.step)
  const done = useSetup((x) => x.done)
  const box = useRef<HTMLDivElement>(null)
  const show = !done && !booting && !whatsNew
  useEffect(() => {
    if (show) box.current?.querySelector<HTMLElement>('[data-default]')?.focus()
  }, [show, step])
  if (!show) return null
  const all = cards()
  const card = all[step]!
  const choose = async (c: Choice) => {
    if ((await c.pick()) === false) return
    if (step + 1 >= all.length) finish()
    else useSetup.setState({ step: step + 1 })
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') return finish()
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault()
    const btns = [...(box.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])]
    const at = btns.indexOf(document.activeElement as HTMLButtonElement)
    const by = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1
    btns[(at + by + btns.length) % btns.length]?.focus()
  }
  return (
    <div className={s.screen} data-fb role="region" aria-label={t('setup.label', 'Setup')} onKeyDown={onKey}>
      <div ref={box} key={step} className={s.card}>
        <div className={s.top}>
          <span className={s.dots} aria-label={t('setup.progress', 'Step {n} of {all}', { n: step + 1, all: all.length })}>
            {all.map((_, i) => (
              <span key={i} className={s.dot} data-on={i <= step || undefined} />
            ))}
          </span>
          <button type="button" className={s.skip} onClick={finish}>
            {t('setup.skip', 'Skip setup')}
          </button>
        </div>
        <h1 className={s.title}>{card.title}</h1>
        {card.line && <p className={s.line}>{card.line}</p>}
        <div
          className={s.choices}
          role="radiogroup"
          aria-label={card.title}
          data-many={card.choices.length > 2 || undefined}
          data-stack={card.choices.some((c) => c.sub) || undefined}
        >
          {card.choices.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={c.id === card.def}
              data-default={c.id === card.def || undefined}
              className={s.choice}
              onClick={() => void choose(c)}
            >
              {c.sub ? (
                <>
                  <span className={s.choiceName}>{c.label}</span>
                  <span className={s.choiceSub}>{c.sub}</span>
                </>
              ) : (
                c.label
              )}
            </button>
          ))}
        </div>
        <p className={s.foot}>{card.foot ?? t('setup.later', 'You can change this anytime in Settings.')}</p>
      </div>
    </div>
  )
}
