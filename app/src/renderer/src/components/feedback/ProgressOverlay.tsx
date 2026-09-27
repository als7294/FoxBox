import styles from './feedback.module.css'

/** Covers a region while work is running. `progress` in 0..1, or indeterminate when omitted. */
export function ProgressOverlay({
  label,
  progress,
  detail,
  overlay,
}: {
  label: string
  progress?: number | null
  detail?: string | null
  /** Cover the positioned parent instead of sitting in the flow. */
  overlay?: boolean
}) {
  const pct = progress == null ? null : Math.round(Math.min(1, Math.max(0, progress)) * 100)
  return (
    <div className={styles.progress} data-overlay={overlay || undefined} role="status" aria-live="polite">
      <p className={styles.progressLabel}>{label}</p>
      <div
        className={styles.progressBar}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(pct != null ? { 'aria-valuenow': pct } : {})}
        data-indeterminate={pct == null || undefined}
      >
        <div className={styles.progressFill} style={pct != null ? { width: `${pct}%` } : undefined} />
      </div>
      {detail && <p className={styles.hint}>{detail}</p>}
    </div>
  )
}
