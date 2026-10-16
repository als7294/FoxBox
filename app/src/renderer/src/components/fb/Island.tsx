// The island (2.0 design: ModeSwitch): the notch, black, hanging from the top centre, only while the window's top
// really sits under one (full screen on a notched built-in display); otherwise a floating glass pill. Collapsed it shows SAUCE's last note,
// REMIX's beat and bar, or the recording's time, and "SAUCE ⇄" switches in one click; clicked, it expands to the two
// mode pills.
import { useEffect, useState } from 'react'
import { PLAY_MODES, playActions, playModeOf, usePlay } from '@/components/play/playStore'
import { bridge } from '@/env'
import { clock, useProdRec } from '@/components/prod/prodActions'
import { switchMode } from '@/components/shell/ModeSwitch'
import { useTakes } from '@/components/stage/takes'
import { useLiveDeck } from '@/state/liveDeck'
import { useUi, type Mode } from '@/state/ui'
import { t } from '@/i18n'
import { closeAll, useFb } from './fbStore'
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

const NAME: Record<Mode, string> = { play: 'SAUCE', remix: 'REMIX' }

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

function Status({ mode }: { mode: Mode }) {
  const note = usePlay((p) => p.note)
  const loop = usePlay((p) =>
    p.melodyMode === 'loop' ? `LOOP · ${p.preset?.name ?? ''} · ${p.loop.linked ? 'LINK ' : ''}${p.loop.bpm}` : null,
  )
  const takeT0 = useTakes((x) => x.t0)
  const clipT0 = useProdRec((r) => r.t0)
  const deck = useLiveDeck((d) => d.deck)
  const recAt = takeT0 ?? clipT0
  useTicker(recAt != null || mode === 'remix', 100)
  if (recAt != null)
    return (
      <span className={s.status}>
        <span className={s.recDot} />
        <span>{clock((performance.now() - recAt) / 1000)}</span>
      </span>
    )
  if (mode === 'play')
    return (
      <span className={s.status}>
        <span className={s.dot} />
        <span>{loop ?? note ?? '—'}</span>
      </span>
    )
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
      <span>{t('dock.bar', 'Bar {n}', { n: c && beat >= 0 ? Math.floor(beat / c.beatsPerBar) + 1 : 1 })}</span>
    </span>
  )
}

const BARS = [
  [8, 29, 10],
  [17, 23, 22],
  [26, 16, 36],
  [35, 25, 18],
  [44, 12, 44],
  [53, 20, 28],
  [62, 8, 52],
  [71, 19, 30],
  [80, 14, 40],
  [89, 24, 20],
  [98, 18, 32],
  [107, 27, 14],
]

/** 2.1: SAUCE's play style, PLUCK · FLOW · LOOP (S cycles it), in the open Island as in the Hands popover. */
function PlayStyle({ open }: { open: boolean }) {
  const style = usePlay(playModeOf)
  return (
    <div className={s.styleSeg} role="radiogroup" aria-label={t('island.playStyle', 'Play style')} aria-hidden={!open}>
      {PLAY_MODES.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={m === style}
          tabIndex={open ? 0 : -1}
          className={s.styleBtn}
          onClick={(e) => {
            e.stopPropagation()
            playActions.setPlayMode(m)
          }}
        >
          {m.toUpperCase()}
        </button>
      ))}
    </div>
  )
}

export function Island() {
  const mode = useUi((u) => u.mode)
  const open = useFb((f) => f.island)
  const notch = useNotch()
  return (
    <>
      <div className={s.glow} data-open={open || undefined} data-notch={notch || undefined} aria-hidden="true">
        <div className={s.glowBand} />
      </div>
      <div
        className={s.island}
        data-open={open || undefined}
        data-notch={notch || undefined}
        onClick={() => {
          const was = useFb.getState().island
          closeAll()
          useFb.setState({ island: !was })
        }}
      >
        <div className={s.row}>
          <Status mode={mode} />
          <button
            type="button"
            className={s.quick}
            title={t('island.switch', 'Switch mode (M)')}
            aria-keyshortcuts="M"
            onClick={(e) => {
              e.stopPropagation()
              switchMode(mode === 'play' ? 'remix' : 'play')
            }}
          >
            {NAME[mode]} ⇄
          </button>
        </div>
        {mode === 'play' && <PlayStyle open={open} />}
        <div className={s.pills} role="radiogroup" aria-label={t('island.mode', 'Mode')} aria-hidden={!open}>
          {(['play', 'remix'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={m === mode}
              tabIndex={open ? 0 : -1}
              className={s.pill}
              data-selected={m === mode || undefined}
              onClick={(e) => {
                e.stopPropagation()
                switchMode(m)
                useFb.setState({ island: false })
              }}
            >
              {m === 'play' ? (
                <svg width="120" height="68" viewBox="0 0 120 68" className={s.pillArt} style={{ right: -6, top: 0 }} aria-hidden="true">
                  <g fill="currentColor">
                    {BARS.map(([x, y, h]) => (
                      <rect key={x} x={x} y={y} width="5" height={h} rx="2.5" />
                    ))}
                  </g>
                </svg>
              ) : (
                <svg width="120" height="68" viewBox="0 0 120 68" className={s.pillArt} style={{ right: -14, top: -12 }} aria-hidden="true">
                  <g fill="none" stroke="currentColor" strokeWidth="5">
                    <circle cx="70" cy="46" r="40" />
                    <circle cx="70" cy="46" r="24" />
                  </g>
                  <circle cx="70" cy="46" r="7" fill="currentColor" />
                </svg>
              )}
              <span className={s.pillLabel}>{NAME[m]}</span>
            </button>
          ))}
        </div>
        <div className={s.foot} aria-hidden={!open}>
          {t('island.foot', 'M switches · notes release, the song pauses on the bar')}
        </div>
      </div>
    </>
  )
}
