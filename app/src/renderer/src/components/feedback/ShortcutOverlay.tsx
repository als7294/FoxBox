import { CreditLink } from '@/components/common/CreditLink'
import { SHORTCUTS } from '@/lib/shortcuts'
import styles from './feedback.module.css'

/** "?" overlay. Click anywhere or Escape to close. */
export function ShortcutOverlay({ open, onClose }: { open: boolean; onClose(): void }) {
  if (!open) return null
  return (
    <div className={styles.scrim} onClick={onClose} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="keys-title"
        className={styles.keysDialog}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <span id="keys-title" className={styles.keysTitle}>
          SHORTCUTS
        </span>
        <span className={styles.keysSub}>Paused while typing in the script editor.</span>
        <dl className={styles.keysList}>
          {SHORTCUTS.map((s) => (
            <div key={s.keys}>
              <dt>{s.label}</dt>
              <dd>
                <kbd>{s.keys}</kbd>
              </dd>
            </div>
          ))}
        </dl>
        <div className={styles.keysFoot}>
          <CreditLink />
          <button type="button" className={styles.keysClose} onClick={onClose} autoFocus>
            CLOSE
          </button>
        </div>
      </div>
    </div>
  )
}
