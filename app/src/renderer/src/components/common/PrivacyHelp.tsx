import { APP_BUNDLE_ID } from '@shared/updates'
import styles from './common.module.css'

/**
 * Under a blocked camera or mic: where to allow it, and the fix when macOS doesn't list FoxBox there at all (a stale
 * denial on record for the bundle id, which System Settings can't show or change).
 */
export function PrivacyHelp({ kind, also }: { kind: 'camera' | 'mic'; also?: string }) {
  const pane = kind === 'camera' ? 'Camera' : 'Microphone'
  return (
    <div className={styles.privacy}>
      <span className={styles.privacyBody}>
        {pane} access is off for FoxBox. Allow it in System Settings → Privacy &amp; Security → {pane}.{also ? ` ${also}` : ''}
      </span>
      <details className={styles.privacyMore}>
        <summary>Not listed there?</summary>
        <span>Run this in Terminal, then TRY AGAIN (macOS asks once more):</span>
        <code className={styles.privacyCode}>tccutil reset {pane} {APP_BUNDLE_ID}</code>
      </details>
    </div>
  )
}
