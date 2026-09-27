import type { ReactNode } from 'react'
import styles from './feedback.module.css'

/** `overlay`: fill the positioned parent (e.g. the signal stage) instead of sitting in the flow. */
export function EmptyState({ title, body, action, overlay }: { title: string; body?: ReactNode; action?: ReactNode; overlay?: boolean }) {
  return (
    <div className={styles.empty} data-overlay={overlay || undefined} role="status">
      <p className={styles.emptyTitle}>{title}</p>
      {body && <p className={styles.emptyBody}>{body}</p>}
      {action}
    </div>
  )
}
