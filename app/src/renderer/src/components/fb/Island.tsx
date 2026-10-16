// The island (2.0 design: ModeSwitch): the notch, black, hanging from the top centre, only while the window's top
// really sits under one (full screen on a notched built-in display); otherwise a floating glass pill. 2.1.1 (docs/
// MODE_ENTRY_UX.md §1–2): collapsed it's the mode, its status and Switch; Switch, a click or M opens the mode chooser.
import { useEffect, useState } from 'react'
import { usePlay } from '@/components/play/playStore'
import { bridge } from '@/env'
import { clock, useProdRec } from '@/components/prod/prodActions'
import { useTakes } from '@/components/stage/takes'
import { useLiveDeck } from '@/state/liveDeck'
import { t } from '@/i18n'
import { useFb } from './fbStore'
import { ModeCards } from './ModeCards'
import { enterMode, MODE_NAME, toggleChooser, TOP_MODES, useTopMode, type TopMode } from './modes'
import s from './island.module.css'

/** Re-renders while `on`, at `ms`. */
function useTicker(on: boolean, ms: number): void {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!on) return
    const id = window.setInterval(() => tick((n) => n + 1), ms)
    return () => window.clearInterval(id)
  }, [on, ms])
}

/** Under a physical notch now (main says; the web mock: ?notch). What hangs under the island drops with it
 *  (--island-drop: the toasts, the badge, the library bar). */
function useNotch(): boolean {
  const [notch, setNotch] = useState(() => !bridge() && new URLSearchParams(location.search).has('notch'))
  useEffect(() => {
    const b = bridge()
    void b?.atNotch?.().then(setNotch, () => undefined)
    return b?.onNotch?.(setNotch)
  }, [])
  useEffect(() => document.documentElement.style.setProperty('--island-drop', notch ? '0px' : '10px'), [notch])
  return notch
}

/** The mode's status: SAUCE's style and last note, MELODY's melody and tempo, REMIX's beat and bar; a recording's time. */
function Status({ top }: { top: TopMode }) {
  const note = usePlay((p) => p.note)
  const style = usePlay((p) => p.style)
  const melody = usePlay((p) => `${p.preset?.name ?? 'LOOP'} · ${p.loop.linked ? 'LINK ' : ''}${p.loop.bpm}`)
  const takeT0 = useTakes((x) => x.t0)
  const clipT0 = useProdRec((r) => r.t0)
  const deck = useLiveDeck((d) => d.deck)
  const recAt = takeT0 ?? clipT0
  useTicker(recAt != null || top === 'remix', 100)
  if (recAt != null)
    return (
      <span className={s.status}>
        <span className={s.recDot} />
        <span>{clock((performance.now() - recAt) / 1000)}</span>
      </span>
    )
  if (top === 'sauce')
    return (
      <span className={s.status}>
        <span>{style.toUpperCase()}</span>
        <span className={s.sep}>·</span>
        <span className={s.dot} />
        <span>{note ?? '—'}</span>
      </span>
    )
  if (top === 'melody') return <span className={s.status}>{melody}</span>
  const c = deck?.clock() ?? null
  const beat = c ? Math.floor(c.beat) : -1
  const inBar = c && beat >= 0 ? beat % c.beatsPerBar : -1
  return (
    <span className={s.status}>
      <span className={s.beats}>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={s.beat} data-on={(deck?.isPlaying && inBar === i) || undefined} />
        ))}
      </span>
      <span>
        {deck
          ? t('dock.bar', 'Bar {n}', { n: c && beat >= 0 ? Math.floor(beat / c.beatsPerBar) + 1 : 1 })
          : t('island.noSong', 'No song yet')}
      </span>
    </span>
  )
}

/** While the chooser is open, 1 · 2 · 3 pick a mode (before the pages' own 1–7: they see it handled). */
function useChooserKeys(open: boolean) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !/^[123]$/.test(e.key)) return
      e.preventDefault()
      enterMode(TOP_MODES[Number(e.key) - 1]!)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])
}

export function Island() {
  const top = useTopMode()
  const open = useFb((f) => f.island)
  const notch = useNotch()
  useChooserKeys(open)
  return (
    <>
      <div className={s.glow} data-open={open || undefined} data-notch={notch || undefined} aria-hidden="true">
        <div className={s.glowBand} />
      </div>
      <div className={s.island} data-open={open || undefined} data-notch={notch || undefined} onClick={toggleChooser}>
        <div className={s.row}>
          <b className={s.mode}>{MODE_NAME[top]}</b>
          <Status top={top} />
          <button
            type="button"
            className={s.switch}
            aria-keyshortcuts="M"
            aria-expanded={open}
            onClick={(e) => {
              e.stopPropagation()
              toggleChooser()
            }}
          >
            {t('island.switch', 'Switch')}
            <kbd className={s.switchKey}>M</kbd>
          </button>
        </div>
        <div className={s.chooser} aria-hidden={!open} inert={!open} onClick={(e) => e.stopPropagation()}>
          <ModeCards current={top} onPick={enterMode} compact />
          <p className={s.pick}>{t('island.pick', '1, 2 or 3 to pick · Esc to close')}</p>
        </div>
      </div>
    </>
  )
}
