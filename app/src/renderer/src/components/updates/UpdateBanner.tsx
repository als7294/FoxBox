import type { UpdateState } from '@shared/bridge'
import type { ReactNode } from 'react'
import { formatBytes } from '@/lib/format'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'
import { clockText, errorText, failureDetail, rateText, transferText } from './format'
import { laterId, useUpdates } from './useUpdates'
import styles from './UpdateBanner.module.css'

type Tone = 'offer' | 'busy' | 'ready' | 'failed'

interface BarProps {
  tone: Tone
  /** What is happening (announced: role="status"). */
  head: string
  /** Announced with it: the size, why this copy can't install, the failure. */
  note?: string | null
  /** Download numbers: shown, never announced (they change several times a second). */
  meter?: string | null
  /** 0–1: the thin progress line along the bar's bottom edge. */
  progress?: number | null
  children?: ReactNode
}

/** The slim row under the top bar. layout.module.css gives the shell a row for it while it is in the DOM. */
function Bar({ tone, head, note, meter, progress, children }: BarProps) {
  const pct = progress == null ? null : Math.min(1, Math.max(0, progress))
  return (
    <div className={styles.bar} data-update-bar data-tone={tone} data-testid="update-banner">
      <span className={styles.lead} aria-hidden="true">
        <span className={styles.dot} />
      </span>
      <p className={styles.msg} title={[head, note, meter].filter(Boolean).join(' · ')}>
        <span role="status">
          <span className={styles.head}>{head}</span>
          {note ? <span className={styles.note}> · {note}</span> : null}
        </span>
        {meter ? <span className={styles.note}> · {meter}</span> : null}
      </p>
      {children ? <div className={styles.actions}>{children}</div> : null}
      {pct != null && (
        <div
          className={styles.track}
          role="progressbar"
          aria-label="Update download"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct * 100)}
        >
          <span className={styles.fill} style={{ transform: `scaleX(${pct})` }} />
        </div>
      )}
    </div>
  )
}

function downloadMeter(d: UpdateState['download']): string {
  if (!d) return 'starting…'
  const done = transferText(d.bytes_done, d.bytes_total)
  if (d.rate_bps == null) return `${done} · starting…`
  return [done, rateText(d.rate_bps), ...(d.eta_s == null ? [] : [`${clockText(d.eta_s)} left`])].join(' · ')
}

/**
 * App updates, under the top bar: available → downloading → verifying → ready → restarting, or a failure (still on
 * the old version). Quiet while idle, checking, up to date, or when a check failed. Nothing in the browser build.
 */
export function UpdateBanner() {
  const { updates, state: s, apply } = useUpdates()
  const later = useUi((u) => (s ? Boolean(u.dismissed[laterId(s.latest)]) : false))
  const dismiss = useUi((u) => u.dismiss)
  if (!updates || !s) return null
  const v = s.latest ?? 'update'
  const run = (call: () => Promise<UpdateState>) =>
    void call().then(apply, (err: unknown) => toast.error('UPDATE', { detail: errorText(err) }))
  const laterButton = (
    <button type="button" className={styles.btn} data-kind="quiet" aria-label="Remind me later" onClick={() => dismiss(laterId(s.latest))}>
      Later
    </button>
  )

  switch (s.phase) {
    case 'available':
      if (later) return null
      return (
        <Bar tone="offer" head={`FoxBox ${v} available`} note={s.sizeBytes ? formatBytes(s.sizeBytes) : null}>
          <button type="button" className={styles.btn} data-kind="solid" aria-label={`Update to FoxBox ${v}`} onClick={() => run(() => updates.download())}>
            Update
          </button>
          {laterButton}
        </Bar>
      )
    case 'downloading': {
      const d = s.download
      return (
        <Bar tone="busy" head={`Downloading ${v}`} meter={downloadMeter(d)} progress={d && d.bytes_total > 0 ? d.bytes_done / d.bytes_total : 0}>
          <button type="button" className={styles.btn} aria-label="Cancel download" onClick={() => run(() => updates.cancel())}>
            Cancel
          </button>
        </Bar>
      )
    }
    case 'verifying':
      return <Bar tone="busy" head={`Verifying ${v}…`} />
    case 'ready':
      // Main asks for a native confirmation before it swaps the app.
      return (
        <Bar tone="ready" head={`FoxBox ${v} is ready`} note={s.installBlocked}>
          {s.installBlocked ? null : (
            <button type="button" className={styles.btn} data-kind="accent" onClick={() => run(() => updates.install())}>
              Restart to update
            </button>
          )}
        </Bar>
      )
    case 'installing':
      return <Bar tone="busy" head="Restarting…" />
    case 'error':
      if (!s.error || s.error.during === 'check' || later) return null
      return (
        <Bar tone="failed" head={`Update failed, still on v${s.current}`} note={failureDetail(s.error.message) || null}>
          {/* Without a known version (a rolled-back update) there is nothing to download again. */}
          {s.latest ? (
            <button type="button" className={styles.btn} aria-label="Retry update" onClick={() => run(() => updates.download())}>
              Retry
            </button>
          ) : null}
          {laterButton}
        </Bar>
      )
    default:
      return null
  }
}
