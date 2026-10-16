import { useEffect, useRef } from 'react'
import { bridge } from '@/env'
import { formatBytes, LOW_DISK_BYTES } from '@/lib/format'
import { engineHealth, useEngine } from '@/state/engine'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'
import { animate } from '@/visuals/motion'
import { t } from '@/i18n'
import styles from './feedback.module.css'

type Kind = 'err' | 'warn' | 'info'

interface BannerData {
  id: string
  kind: Kind
  title: string
  body: string
  action?: { label: string; run: () => void }
}

/** The one problem worth interrupting for, in priority order (engine, disk). */
function useBanner(): BannerData | null {
  const status = useEngine((s) => s.status)
  const health = engineHealth(status)
  const b = bridge()
  if (status.state === 'offline') {
    return {
      id: `offline:${status.lastError ?? ''}`,
      kind: 'err',
      title: t('banner.offline.title', 'ENGINE OFFLINE'),
      body: t('banner.offline.body', '{reason} Your track is safe.', { reason: status.lastError ?? t('banner.offline.stopped', 'The engine stopped.') }),
      ...(b ? { action: { label: t('banner.reconnect', 'RECONNECT'), run: () => void b.restartEngine() } } : {}),
    }
  }
  if (status.state === 'restarting') {
    return {
      id: `restarting:${status.restarts}`,
      kind: 'info',
      title: t('banner.restarting.title', 'ENGINE RESTARTING'),
      body: `${status.attempt ? t('banner.restarting.attempt', 'Restarting the engine (attempt {n}).', { n: status.attempt }) : t('banner.restarting.body', 'Restarting the engine.')} ${status.lastError ?? ''}`.trim(),
    }
  }
  if (health?.state === 'error') {
    return {
      id: `health-error:${health.message ?? ''}`,
      kind: 'err',
      title: t('banner.error.title', 'ENGINE ERROR'),
      body: t('banner.error.body', '{reason} Stems will fail until it recovers.', { reason: health.message ?? t('banner.error.default', 'The engine reported an error.') }),
      ...(b ? { action: { label: t('banner.restart', 'RESTART'), run: () => void b.restartEngine() } } : {}),
    }
  }
  if (health && health.disk_free_bytes < LOW_DISK_BYTES) {
    return {
      id: 'lowdisk',
      kind: 'warn',
      title: t('banner.lowdisk.title', 'LOW DISK · {free} FREE', { free: formatBytes(health.disk_free_bytes) }),
      body: t('banner.lowdisk.body', 'Splitting stems and saving takes need at least 3 GB free.'),
      ...(b
        ? {
            action: {
              label: t('banner.reveal', 'SHOW THE FOLDER'),
              run: () => void b.reveal(health.export_dir).then((ok) => !ok && toast.warn(t('banner.reveal.missing', 'Takes folder not found'))),
            },
          }
        : {}),
    }
  }
  return null
}

const ICON: Record<Kind, string> = { err: '✕', warn: '!', info: '↻' }

/** Top-centre banner for engine and render problems (never relies on colour alone: icon + title). */
export function Banner() {
  const data = useBanner()
  const dismissed = useUi((s) => (data ? s.dismissed[data.id] : false))
  const dismiss = useUi((s) => s.dismiss)
  const ref = useRef<HTMLDivElement>(null)
  const id = data && !dismissed ? data.id : null
  useEffect(() => {
    if (!id) return
    animate(
      ref.current,
      [
        { transform: 'translate(-50%,-16px)', opacity: 0, clipPath: 'inset(0 0 100% 0)' },
        { opacity: 1, offset: 0.45 },
        { opacity: 0.35, offset: 0.55 },
        { transform: 'translate(-50%,0)', opacity: 1, clipPath: 'inset(0 0 0 0)' },
      ],
      { duration: 440, easing: 'cubic-bezier(.2,.8,.2,1)' },
    )
  }, [id])
  if (!data || dismissed) return null
  return (
    <div ref={ref} className={styles.banner} role="alert" data-kind={data.kind}>
      <span className={styles.bannerIcon} aria-hidden="true">
        {ICON[data.kind]}
      </span>
      <div className={styles.bannerText}>
        <span className={styles.bannerTitle}>{data.title}</span>
        <span className={styles.bannerBody}>{data.body}</span>
      </div>
      {data.action && (
        <button type="button" className={styles.bannerAction} onClick={data.action.run}>
          {data.action.label}
        </button>
      )}
      <button type="button" className={styles.bannerClose} aria-label={t('common.dismiss', 'Dismiss')} onClick={() => dismiss(data.id)}>
        ×
      </button>
    </div>
  )
}
