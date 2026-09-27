import { Button } from '@/components/common/Button'
import styles from './feedback.module.css'

export interface ErrorStateProps {
  title: string
  message: string
  hint?: string | null
  onRetry?: () => void
  retryLabel?: string
  onDismiss?: () => void
  /** Cover the positioned parent (e.g. the signal stage) instead of sitting in the flow. */
  overlay?: boolean
}

export function ErrorState({ title, message, hint, onRetry, retryLabel = 'Retry', onDismiss, overlay }: ErrorStateProps) {
  return (
    <div className={styles.error} data-overlay={overlay || undefined} role="alert">
      <p className={styles.errorTitle}>⚠ {title}</p>
      <p>{message}</p>
      {hint && <p className={styles.hint}>{hint}</p>}
      <div className={styles.actions}>
        {onRetry && (
          <Button variant="primary" onClick={onRetry}>
            {retryLabel}
          </Button>
        )}
        {onDismiss && (
          <Button variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </div>
    </div>
  )
}
