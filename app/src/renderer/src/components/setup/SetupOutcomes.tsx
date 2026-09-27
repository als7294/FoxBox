import type { ReactNode } from 'react'
import { Button } from '@/components/common/Button'
import { FoxMark } from '@/components/common/FoxMark'
import type { FailureKind, PlanItem, RowView } from './plan'
import styles from './setup.module.css'

export type SetupErrorKind = FailureKind | 'engine' | 'cancelled'

const TITLES: Record<SetupErrorKind, string> = {
  disk: 'Disk full',
  network: 'Network lost',
  checksum: 'Checksum failed',
  lost: 'Engine restarted',
  engine: 'Engine offline',
  cancelled: 'Install stopped',
  other: 'Install failed',
}

/**
 * What went wrong and what to do: disk full (with the numbers and a hint), network lost (retry resumes), checksum
 * failed (retry downloads again), the engine restarted or is offline, or the user stopped the install.
 */
export function SetupError({ kind, message, hint, children }: { kind: SetupErrorKind; message: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className={styles.problem} data-kind={kind} role={kind === 'cancelled' ? 'status' : 'alert'}>
      <span className={styles.problemTitle}>
        {kind === 'cancelled' ? '■' : '⚠'} {TITLES[kind]}
      </span>
      <span>{message}</span>
      {hint && <span className={styles.note}>{hint}</span>}
      {children && <div className={styles.problemActions}>{children}</div>}
    </div>
  )
}

/** Setup screen 4: what was installed (and what wasn't), then OPEN STUDIO. */
export function SetupReady({
  plan,
  views,
  opening,
  error,
  onOpen,
}: {
  plan: readonly PlanItem[]
  views: readonly RowView[]
  opening: boolean
  error: string | null
  onOpen(): void
}) {
  const missed = plan.filter((_, i) => views[i]?.state !== 'done')
  return (
    <>
      <FoxMark size={48} className={styles.bigMark} />
      <div>
        <div className={styles.kicker}>04 / Ready</div>
        <h1 className={styles.title}>Transmission ready</h1>
      </div>
      <ul className={styles.summary} aria-label="Installed components">
        <li>
          <span className={styles.ok} aria-hidden="true">
            ✓
          </span>
          Sound engine
        </li>
        {plan.map((item, i) => {
          const done = views[i]?.state === 'done'
          return (
            <li key={item.id}>
              <span className={done ? styles.ok : styles.bad} aria-hidden="true">
                {done ? '✓' : '✕'}
              </span>
              <span>
                {item.name}
                {done ? '' : ' · not installed'}
              </span>
            </li>
          )
        })}
      </ul>
      {missed.length > 0 && <p className={styles.note}>Install what's missing any time in SETTINGS → MODELS.</p>}
      <div className={styles.actions}>
        <span>{error && <span className={styles.diskWarn}>{error}</span>}</span>
        <Button variant="primary" size="lg" disabled={opening} onClick={onOpen}>
          {opening ? 'Opening…' : 'Open studio'}
        </Button>
      </div>
    </>
  )
}
