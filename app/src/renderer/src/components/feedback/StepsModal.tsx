import { bridge } from '@/env'
import { useUi } from '@/state/ui'
import styles from './feedback.module.css'

/** "✓ WRITTEN" dialog with numbered import steps (rekordbox.xml exports). */
export function StepsModal() {
  const modal = useUi((s) => s.modal)
  const close = () => useUi.getState().setModal(null)
  if (!modal) return null
  const b = bridge()
  return (
    <div className={styles.scrim} onClick={close} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={modal.title}
        className={styles.stepsDialog}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && close()}
      >
        <span className={styles.stepsKicker}>✓ WRITTEN</span>
        <span className={styles.stepsTitle}>{modal.title}</span>
        <span className={styles.stepsBody}>{modal.body}</span>
        <div className={styles.stepsList}>
          <span className={styles.stepsLabel}>IMPORT STEPS</span>
          {modal.steps.map((t, i) => (
            <div key={t} className={styles.step}>
              <span className={styles.stepN}>{String(i + 1).padStart(2, '0')}</span>
              <span>{t}</span>
            </div>
          ))}
        </div>
        <div className={styles.stepsActions}>
          {modal.revealPath && b && (
            <button type="button" className={styles.ghostBtn} onClick={() => void b.reveal(modal.revealPath!)}>
              REVEAL XML
            </button>
          )}
          <button type="button" className={styles.doneBtn} onClick={close} autoFocus>
            DONE
          </button>
        </div>
      </div>
    </div>
  )
}

/** Rekordbox import steps for an XML the engine wrote. */
export function rekordboxSteps(playlist: string): string[] {
  return [
    'Rekordbox → Preferences → Advanced → Database → rekordbox xml: choose the file below.',
    'Open the rekordbox xml tree in the browser sidebar.',
    `Right-click “${playlist}” → Import Playlist. Hot cue A sits on the first word; a memory cue marks each tail.`,
  ]
}
