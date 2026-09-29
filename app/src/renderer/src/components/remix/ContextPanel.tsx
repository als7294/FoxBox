import { useId } from 'react'
import type { Remix, RemixRecipe } from '@/api/remix'
import type { Song } from '@/api/types'
import { BassDnaPanel } from './BassDnaPanel'
import { FlipCards } from './FlipCards'
import { MashRadar } from './MashRadar'
import css from './panel.module.css'
import { panelFor, remix as actions, useRemix, type RemixPanel } from './store'
import { SwapSoundPopover } from './SwapSoundPopover'

const TABS: { id: RemixPanel; recipe: RemixRecipe; n: string; label: string; sub: string; line: string }[] = [
  {
    id: 'bass',
    recipe: 'vip',
    n: '01',
    label: 'VIP',
    sub: 'NEW BASS',
    line: 'Keep the track. Rebuild its drops so the held 808 stays and new growls answer it.',
  },
  { id: 'radar', recipe: 'mashup', n: '02', label: 'MASHUP', sub: 'A + B', line: 'A’s build or vocals into B’s drop, with key and tempo matched.' },
  {
    id: 'flip',
    recipe: 'flip',
    n: '03',
    label: 'FLIP',
    sub: 'NEW STYLE',
    line: 'The same track as trap-hybrid, riddim, half-time, 140, four-on-the-floor or DnB.',
  },
]

const pick = (t: (typeof TABS)[number]) => {
  actions.setRecipe(t.recipe)
  useRemix.setState({ swapClip: null })
}

/**
 * The right column: the recipe tabs (01 VIP · 02 MASHUP · 03 FLIP, each with its panel: BASS DNA, MASH RADAR, the flip
 * styles), or SWAP SOUND docked over them while a clip is picked. › folds it to a 46px rail for more timeline.
 */
export function ContextPanel({ songA, remix }: { songA: Song | undefined; remix: Remix | null }) {
  const panel = useRemix(panelFor)
  const min = useRemix((s) => s.panelMin)
  const swapClip = useRemix((s) => (s.swapClip && s.clips.includes(s.swapClip) ? s.swapClip : null))
  const i = TABS.findIndex((t) => t.id === panel)
  const uid = useId().replace(/:/g, '')
  if (min)
    return (
      <aside className={css.sideMin} aria-label="Tools, collapsed">
        <button type="button" className={css.unfold} aria-label="Open the tools panel" title="Open panel" onClick={() => useRemix.setState({ panelMin: false })}>
          ‹
        </button>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={css.minTab}
            data-on={panel === t.id || undefined}
            title={t.line}
            onClick={() => {
              pick(t)
              useRemix.setState({ panelMin: false })
            }}
          >
            {t.label}
          </button>
        ))}
      </aside>
    )
  return (
    <aside className={css.side} aria-label="Context">
      {!swapClip && (
        <div className={css.tabs}>
          <span className={css.tabBar} style={{ left: `calc(${i * 33.33}% * 0.88 + 6px)` }} aria-hidden="true" />
          <div className={css.tabRow} role="tablist" aria-label="Recipe">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`${uid}-tab-${t.id}`}
                aria-controls={`${uid}-panel`}
                aria-selected={panel === t.id}
                title={t.line}
                onClick={() => pick(t)}
              >
                <span className={css.tabHead}>
                  <span>{t.n}</span>
                  <b>{t.label}</b>
                </span>
                <span className={css.tabSub}>{t.sub}</span>
              </button>
            ))}
          </div>
          <button type="button" className={css.fold} aria-label="Collapse the panel" title="Collapse panel (more timeline)" onClick={() => useRemix.setState({ panelMin: true })}>
            ›
          </button>
        </div>
      )}
      <div className={css.body} role="tabpanel" id={`${uid}-panel`} aria-labelledby={swapClip ? undefined : `${uid}-tab-${panel}`}>
        {swapClip && remix ? (
          <SwapSoundPopover key={swapClip} remix={remix} clipId={swapClip} />
        ) : (
          <>
            {panel === 'bass' && <BassDnaPanel songA={songA} remix={remix} />}
            {panel === 'radar' && <MashRadar songA={songA} />}
            {panel === 'flip' && <FlipCards remix={remix} />}
          </>
        )}
      </div>
    </aside>
  )
}
