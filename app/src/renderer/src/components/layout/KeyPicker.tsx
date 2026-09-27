import { KEY_OPTIONS } from '@/lib/keys'
import { scheduleRender } from '@/state/renderController'
import { studio, useStudio } from '@/state/studio'
import styles from './layout.module.css'

/** Musical key (drives monotone and vocoder notes), shown with its Camelot code: "Am · 8A". */
export function KeyPicker() {
  const key = useStudio((s) => s.key)
  return (
    <label className={styles.keyBox}>
      <span className={styles.boxLabel}>KEY</span>
      <select
        className={styles.keySelect}
        aria-label="Key"
        value={key}
        onChange={(e) => {
          studio.setKey(e.target.value)
          scheduleRender(250)
        }}
      >
        {KEY_OPTIONS.map((k) => (
          <option key={k.value} value={k.value}>
            {k.label}
          </option>
        ))}
      </select>
    </label>
  )
}
