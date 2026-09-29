import type { Remix } from '@/api/remix'
import type { Song } from '@/api/types'
import { BassDnaPanel } from './BassDnaPanel'
import { FlipCards } from './FlipCards'
import { MashRadar } from './MashRadar'
import css from './panel.module.css'
import { panelFor, useRemix, type RemixPanel } from './store'
import { SwapSoundPopover } from './SwapSoundPopover'

const PANELS: { id: RemixPanel; label: string }[] = [
  { id: 'bass', label: 'BASS DNA' },
  { id: 'radar', label: 'MASH RADAR' },
  { id: 'flip', label: 'GENRE FLIP' },
]

/** The right column: BASS DNA · MASH RADAR · GENRE FLIP, or SWAP SOUND docked over them while a clip is picked. */
export function ContextPanel({ songA, remix }: { songA: Song | undefined; remix: Remix | null }) {
  const panel = useRemix(panelFor)
  const swapClip = useRemix((s) => (s.swapClip && s.clips.includes(s.swapClip) ? s.swapClip : null))
  const i = PANELS.findIndex((p) => p.id === panel)
  return (
    <aside className={css.side} aria-label="Context">
      <div className={css.tabs} role="tablist" aria-label="Tools">
        {PANELS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={!swapClip && panel === p.id}
            onClick={() => useRemix.setState({ panel: p.id, swapClip: null })}
          >
            {p.label}
          </button>
        ))}
        {!swapClip && <span className={css.tabBar} style={{ left: `${i * 33.33}%` }} aria-hidden="true" />}
      </div>
      <div className={css.body}>
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
