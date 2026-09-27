import { useState, type ReactNode } from 'react'
import { Button } from '@/components/common/Button'
import { formatEta, formatPair, formatRate, speedEta, type Overall, type PlanItem, type RowState, type RowView } from './plan'
import styles from './setup.module.css'

export interface LogLine {
  at: string
  text: string
}

const STATE_LABEL: Record<RowState, string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  verifying: 'Verifying',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
}
const STATE_TONE: Partial<Record<RowState, 'ok' | 'busy' | 'bad'>> = { downloading: 'busy', verifying: 'busy', done: 'ok', failed: 'bad' }

/** Setup screen 3: the overall bar, one row per component, the current file, a log, cancel and "open the app now". */
export function InstallProgress({
  plan,
  views,
  overall,
  current,
  problem,
  log,
  cancelled,
  opening,
  openError,
  onCancel,
  onOpenNow,
  onContinue,
  onRetryItem,
  onOpenLogs,
}: {
  plan: readonly PlanItem[]
  views: readonly RowView[]
  overall: Overall
  /** "Downloading kokoro-v1_0.safetensors". */
  current: string | null
  /** A SetupError (required part failed, engine offline, install cancelled), shown above the rows. */
  problem: ReactNode
  log: readonly LogLine[]
  cancelled: boolean
  opening: boolean
  openError: string | null
  onCancel(): void
  onOpenNow(): void
  onContinue(): void
  onRetryItem(id: string): void
  onOpenLogs?(): void
}) {
  const [confirming, setConfirming] = useState(false)
  const finishedWithFailures = !overall.active && overall.requiredDone && !overall.allDone
  return (
    <>
      <div>
        <div className={styles.kicker}>03 / Installing</div>
        <h1 className={styles.title}>Locking in the signal</h1>
      </div>
      <OverallProgressBar overall={overall} />
      <p className={styles.current} aria-live="polite">
        {current ?? (overall.active ? 'Waiting for the engine…' : overall.allDone ? 'Everything is installed.' : ' ')}
      </p>
      {problem}
      <ul className={styles.items} aria-label="Components">
        {plan.map((item, i) => (
          <ItemProgressRow key={item.id} item={item} view={views[i]!} onRetry={() => onRetryItem(item.id)} />
        ))}
      </ul>
      <InstallLog lines={log} {...(onOpenLogs ? { onOpenLogs } : {})} />
      {confirming ? (
        <div className={styles.confirm} role="alertdialog" aria-label="Stop the install?">
          <span>Stop the install? What is downloaded stays, and setup resumes next time you open FoxBox.</span>
          <Button variant="ghost" onClick={() => setConfirming(false)} autoFocus>
            Keep installing
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setConfirming(false)
              onCancel()
            }}
          >
            Stop install
          </Button>
        </div>
      ) : (
        <div className={styles.actions}>
          <Button variant="ghost" disabled={!overall.active || cancelled} onClick={() => setConfirming(true)}>
            Cancel
          </Button>
          {openError && <span className={styles.diskWarn}>{openError}</span>}
          {finishedWithFailures ? (
            <Button variant="primary" onClick={onContinue}>
              Continue
            </Button>
          ) : (
            <Button
              variant="secondary"
              disabled={!overall.requiredDone || opening}
              title={overall.requiredDone ? 'The optional parts keep downloading in the background.' : 'Available once the required parts are installed.'}
              onClick={onOpenNow}
            >
              {opening ? 'Opening…' : 'Open the app now'}
            </Button>
          )}
        </div>
      )}
    </>
  )
}

/** The whole install, weighted by bytes. */
export function OverallProgressBar({ overall }: { overall: Overall }) {
  const pct = Math.round(overall.fraction * 100)
  const state: RowState = overall.allDone ? 'done' : overall.active ? 'downloading' : 'queued'
  return (
    <div className={styles.overall}>
      <div className={styles.overallHead}>
        <span className={styles.pct} aria-hidden="true">
          {pct}%
        </span>
        <span className={styles.note}>
          {formatPair(overall.bytesDone, overall.bytesTotal)}
          {overall.starting ? ' · starting…' : ''}
          {overall.rateBps ? ` · ${formatRate(overall.rateBps)}` : ''}
          {overall.etaS != null && overall.rateBps ? ` · ${formatEta(overall.etaS)} left` : ''}
        </span>
      </div>
      <div className={styles.bar} data-state={state} role="progressbar" aria-label="Overall progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className={styles.fill} style={{ transform: `scaleX(${overall.fraction})` }} />
      </div>
    </div>
  )
}

/** One component's download: its state, bytes, speed and ETA, and Retry when it failed. */
export function ItemProgressRow({ item, view, onRetry }: { item: PlanItem; view: RowView; onRetry(): void }) {
  const pct = Math.round(view.fraction * 100)
  return (
    <li className={styles.item} data-state={view.state}>
      <span className={`${styles.chip} ${styles.itemState}`} data-tone={STATE_TONE[view.state]}>
        {STATE_LABEL[view.state]}
      </span>
      <span className={styles.itemName}>
        {item.name}
        {item.required ? '' : ' · optional'}
      </span>
      <span className={styles.itemMeta}>
        {view.state === 'downloading' ? (
          <SpeedEta view={view} />
        ) : view.state === 'done' ? (
          item.alreadyInstalled ? 'Already installed' : formatPair(view.bytesTotal, view.bytesTotal)
        ) : view.state === 'verifying' ? (
          'Checking the files…'
        ) : view.state === 'failed' || view.state === 'cancelled' ? (
          <Button size="sm" variant={view.state === 'failed' ? 'danger' : 'secondary'} onClick={onRetry}>
            {view.state === 'failed' ? 'Retry' : 'Resume'}
          </Button>
        ) : view.fraction > 0 ? (
          `${formatPair(view.bytesDone, view.bytesTotal)} here already`
        ) : (
          'Waiting'
        )}
      </span>
      <div className={styles.bar} data-size="sm" data-state={view.state} role="progressbar" aria-label={`${item.name}: ${STATE_LABEL[view.state]}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className={styles.fill} style={{ transform: `scaleX(${view.state === 'done' ? 1 : view.fraction})` }} />
      </div>
      {view.error && (
        <span className={styles.itemError} role="alert">
          {view.error.message}
          {view.error.hint ? ` ${view.error.hint}` : ''}
        </span>
      )}
    </li>
  )
}

/** "128 of 327 MB · 18.4 MB/s · 0:11 left" ("starting…" until the speed means something). */
export function SpeedEta({ view }: { view: Pick<RowView, 'bytesDone' | 'bytesTotal' | 'rateBps' | 'etaS' | 'starting'> }) {
  return <span>{speedEta(view)}</span>
}

/** "Details": what happened, with times. */
export function InstallLog({ lines, onOpenLogs }: { lines: readonly LogLine[]; onOpenLogs?: () => void }) {
  return (
    <details className={styles.log}>
      <summary>Details</summary>
      <ol className={styles.logLines}>
        {lines.length === 0 ? <li>Nothing yet.</li> : null}
        {lines.map((l, i) => (
          <li key={i}>
            <time>{l.at}</time>
            {l.text}
          </li>
        ))}
      </ol>
      {onOpenLogs && (
        <Button size="sm" variant="ghost" onClick={onOpenLogs}>
          Open engine logs
        </Button>
      )}
    </details>
  )
}
