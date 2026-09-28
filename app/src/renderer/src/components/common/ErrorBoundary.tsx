import { Component, type ErrorInfo, type ReactNode } from 'react'
import { bridge } from '@/env'
import { Button } from './Button'
import styles from './ErrorBoundary.module.css'

/** Sends an error to main.log once (the same message is not repeated), for boundaries and frame loops alike. */
const reported = new Set<string>()
export function reportError(scope: string, err: unknown, extra?: string): void {
  const e = err instanceof Error ? err : new Error(String(err))
  const key = `${scope}|${e.message}`
  if (reported.has(key)) return
  if (reported.size > 200) reported.clear()
  reported.add(key)
  console.error(`[${scope}]`, e)
  bridge()?.logError(scope, e.message, [e.stack, extra].filter(Boolean).join('\n'))
}

interface Props {
  /** Names the part in the log and on the card, e.g. VISUALS or STAGE. */
  scope: string
  children: ReactNode
  /** A smaller card, for a panel inside a page. */
  compact?: boolean
}

/**
 * Keeps a render error inside its panel: the rest of FoxBox keeps running (mid-set, the app never goes blank). Shows
 * a small card with RESET, which mounts the panel again, and logs the error to main.log.
 */
export class ErrorBoundary extends Component<Props, { error: Error | null; round: number }> {
  override state = { error: null as Error | null, round: 0 }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(this.props.scope, error, info.componentStack ?? undefined)
  }

  override render() {
    const { error, round } = this.state
    if (!error) return <ErrorBoundaryRound key={round}>{this.props.children}</ErrorBoundaryRound>
    return (
      <div className={styles.card} data-compact={this.props.compact || undefined} role="alert" data-testid="error-boundary">
        <p className={styles.kicker}>{this.props.scope} · SOMETHING BROKE</p>
        <p className={styles.message}>{error.message || 'An unexpected error.'}</p>
        <Button size="sm" variant="danger" onClick={() => this.setState((s) => ({ error: null, round: s.round + 1 }))}>
          RESET
        </Button>
      </div>
    )
  }
}

/** A keyed wrapper so RESET mounts the children fresh. */
function ErrorBoundaryRound({ children }: { children: ReactNode }) {
  return <>{children}</>
}
