import type { BarsSetting } from '@/api/types'
import { useEngine } from '@/state/engine'
import { scheduleRender } from '@/state/renderController'
import { isStale, studio, useStudio } from '@/state/studio'
import styles from './layout.module.css'

const OPTIONS: { value: BarsSetting | null; label: string }[] = [
  { value: 'auto', label: 'AUTO' },
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 4, label: '4' },
  { value: 8, label: '8' },
  { value: 16, label: '16' },
  { value: null, label: 'FREE' },
]

/** File length: AUTO (the standard count that fits the phrase; shows what it picked), 1–16 bars, or FREE. */
export function BarsPicker() {
  const bars = useStudio((s) => s.bars)
  const resolved = useStudio((s) => (s.bars === 'auto' && s.render && !isStale(s) ? (s.render.bars ?? null) : null))
  const autoBars = useEngine((s) => s.autoBars)
  const options = autoBars === false ? OPTIONS.filter((o) => o.value !== 'auto') : OPTIONS
  return (
    <div role="radiogroup" aria-label="Bars" className={styles.bars}>
      <span className={`${styles.boxLabel} ${styles.wideOnly}`}>BARS</span>
      {options.map((o) => {
        const auto = o.value === 'auto'
        return (
          <button
            key={o.label}
            type="button"
            role="radio"
            aria-checked={bars === o.value}
            aria-label={auto ? (resolved ? `AUTO, ${resolved} bars` : 'AUTO') : undefined}
            title={auto ? 'AUTO: the standard bar count that fits the phrase' : undefined}
            className={styles.barBtn}
            onClick={() => {
              studio.setBars(o.value)
              scheduleRender(250)
            }}
          >
            {o.label}
            {auto && resolved != null && <span className={styles.barResolved}> · {resolved}</span>}
          </button>
        )
      })}
    </div>
  )
}
