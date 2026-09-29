import { bridge } from '@/env'
import { hideHome } from '@/lib/paths'
import { useUi } from '@/state/ui'
import styles from './feedback.module.css'

/**
 * "✓ WRITTEN" with numbered import steps (rekordbox.xml exports). Inline where the XML was written (VAULT, the Studio's
 * OUTPUT panel), not a modal over the app (UX #11).
 */
export function StepsPanel() {
  const modal = useUi((s) => s.modal)
  const close = () => useUi.getState().setModal(null)
  if (!modal) return null
  const b = bridge()
  return (
    <section aria-label={modal.title} className={styles.stepsPanel} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <div className={styles.stepsInner}>
        <span className={styles.stepsKicker}>✓ WRITTEN</span>
        <span className={styles.stepsTitle}>{modal.title}</span>
        <span className={styles.stepsBody}>{hideHome(modal.body)}</span>
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
    </section>
  )
}

/** Rekordbox import steps for an XML the engine wrote. */
export function rekordboxSteps(playlist: string): string[] {
  return [
    'Rekordbox → Preferences → Advanced → Database → rekordbox xml: choose the file named above.',
    'Open the rekordbox xml tree in the browser sidebar.',
    `Right-click “${playlist}” → Import Playlist. Hot cue A sits on the first word; a memory cue marks each tail.`,
  ]
}
