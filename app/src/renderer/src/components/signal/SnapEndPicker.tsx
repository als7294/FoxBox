import type { SnapEnd } from '@/api/types'
import { scheduleRender } from '@/state/renderController'
import { studio, useStudio } from '@/state/studio'
import styles from './signal.module.css'

const ORDER: readonly SnapEnd[] = ['beat', 'bar', 'off']
const TITLE: Record<SnapEnd, string> = {
  beat: 'END ON A BEAT: the last word lands on a beat (the phrase is warped within the stretch limit, then the tail rings). Nothing is cut.',
  bar: 'END ON A BAR: the last word lands on a bar line. Nothing is cut.',
  off: 'END OFF: natural length, no warping of the phrase end.',
}

/**
 * END (v0.4.1 `snap_end`): where the phrase's last word lands, BEAT → BAR → OFF on click. It lives in the FIT
 * readout it affects (the top bar is full at 1280 and 1512). Shows the preset's hint or the engine default (BEAT)
 * until the user picks one.
 */
export function SnapEndPicker() {
  const chosen = useStudio((s) => s.snapEnd)
  const hint = useStudio((s) => s.arrangeHint.snap_end)
  const effective: SnapEnd = chosen ?? (hint === 'bar' || hint === 'off' || hint === 'beat' ? hint : 'beat')
  const next = ORDER[(ORDER.indexOf(effective) + 1) % ORDER.length]!
  return (
    <button
      type="button"
      className={`${styles.chip} ${styles.endChip}`}
      data-testid="snap-end"
      data-value={effective}
      aria-label={`Phrase end: ${effective.toUpperCase()}. Click for ${next.toUpperCase()}.`}
      title={`${TITLE[effective]} Click for ${next.toUpperCase()}.`}
      onClick={() => {
        studio.setSnapEnd(next)
        scheduleRender(250)
      }}
    >
      END ⇥ {effective.toUpperCase()}
    </button>
  )
}
