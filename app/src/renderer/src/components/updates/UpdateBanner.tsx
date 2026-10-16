import type { UpdateState } from '@shared/bridge'
import { t } from '@/i18n'
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

/** A glass pill under the notch (2.0 design §11), its download a thin line along its bottom. */
function Bar({ tone, head, note, meter, progress, children }: BarProps) {
  const pct = progress == null ? null : Math.min(1, Math.max(0, progress))
  return (
    <div className={styles.bar} data-update-bar data-tone={tone} data-testid="update-banner">
      <span className={styles.lead} aria-hidden="true">
        <span className={styles.dot} />
      </span>
      <p className={styles.msg} title={[head, note, meter].filter(Boolean).join(' · ')}>
        <span role="status">
          <span>{head}</span>
          {note ? <span className={styles.note}> · {note}</span> : null}
        </span>
        {meter ? <span className={styles.note}> · {meter}</span> : null}
      </p>
      {children ? <div className={styles.actions}>{children}</div> : null}
      {pct != null && (
        <div
          className={styles.track}
          role="progressbar"
          aria-label={t('update.download.aria', 'Update download')}
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
  if (!d) return t('update.starting', 'starting…')
  const done = transferText(d.bytes_done, d.bytes_total)
  if (d.rate_bps == null) return `${done} · ${t('update.starting', 'starting…')}`
  return [done, rateText(d.rate_bps), ...(d.eta_s == null ? [] : [t('update.left', '{time} left', { time: clockText(d.eta_s) })])].join(' · ')
}

/**
 * App updates, under the notch: available → downloading → verifying → ready → restarting, or a failure (still on
 * the old version). Quiet while idle, checking, up to date, or when a check failed. Nothing in the browser build.
 */
export function UpdateBanner() {
  const { updates, state: s, apply } = useUpdates()
  const later = useUi((u) => (s ? Boolean(u.dismissed[laterId(s.latest)]) : false))
  const dismiss = useUi((u) => u.dismiss)
  if (!updates || !s) return null
  const v = s.latest ?? 'update'
  const run = (call: () => Promise<UpdateState>) =>
    void call().then(apply, (err: unknown) => toast.error(t('update.toast', 'UPDATE'), { detail: errorText(err) }))
  const laterButton = (
    <button type="button" className={styles.btn} data-kind="quiet" aria-label={t('update.later.aria', 'Remind me later')} onClick={() => dismiss(laterId(s.latest))}>
      {t('update.later', 'Later')}
    </button>
  )

  switch (s.phase) {
    case 'available':
      if (later) return null
      return (
        <Bar tone="offer" head={t('update.available', 'FoxBox {v} available', { v })} note={s.sizeBytes ? formatBytes(s.sizeBytes) : null}>
          <button
            type="button"
            className={styles.btn}
            data-kind="solid"
            aria-label={t('update.to', 'Update to FoxBox {v}', { v })}
            onClick={() => run(() => updates.download())}
          >
            {t('update.update', 'Update')}
          </button>
          {laterButton}
        </Bar>
      )
    case 'downloading': {
      const d = s.download
      return (
        <Bar
          tone="busy"
          head={t('update.downloading', 'Downloading {v}', { v })}
          meter={downloadMeter(d)}
          progress={d && d.bytes_total > 0 ? d.bytes_done / d.bytes_total : 0}
        >
          <button type="button" className={styles.btn} aria-label={t('update.cancel.aria', 'Cancel download')} onClick={() => run(() => updates.cancel())}>
            {t('common.cancel', 'Cancel')}
          </button>
        </Bar>
      )
    }
    case 'verifying':
      return <Bar tone="busy" head={t('update.verifying', 'Verifying {v}…', { v })} />
    case 'ready':
      // Main asks for a native confirmation before it swaps the app.
      return (
        <Bar tone="ready" head={t('update.ready', 'Update ready · FoxBox {v}', { v })} note={s.installBlocked}>
          {s.installBlocked ? null : (
            <button
              type="button"
              className={styles.btn}
              data-kind="accent"
              aria-label={t('update.restart.aria', 'Restart to update')}
              onClick={() => run(() => updates.install())}
            >
              {t('update.restart', 'Restart')}
            </button>
          )}
        </Bar>
      )
    case 'installing':
      return <Bar tone="busy" head={t('launch.update.restarting', 'Restarting…')} />
    case 'error':
      if (!s.error || s.error.during === 'check' || later) return null
      return (
        <Bar tone="failed" head={t('update.failed', 'Update failed, still on v{v}', { v: s.current })} note={failureDetail(s.error.message) || null}>
          {/* Without a known version (a rolled-back update) there is nothing to download again. */}
          {s.latest ? (
            <button type="button" className={styles.btn} aria-label={t('update.retry.aria', 'Retry update')} onClick={() => run(() => updates.download())}>
              {t('update.retry', 'Retry')}
            </button>
          ) : null}
          {laterButton}
        </Bar>
      )
    default:
      return null
  }
}
