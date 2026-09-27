import { useEffect, useRef } from 'react'
import { bridge } from '@/env'
import { formatBytes, LOW_DISK_BYTES } from '@/lib/format'
import { engineHealth, useEngine } from '@/state/engine'
import { renderNow } from '@/state/renderController'
import { studio, useStudio } from '@/state/studio'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'
import { animate } from '@/visuals/motion'
import styles from './feedback.module.css'

type Kind = 'err' | 'warn' | 'info'

interface BannerData {
  id: string
  kind: Kind
  title: string
  body: string
  action?: { label: string; run: () => void }
}

/** The one problem worth interrupting for, in priority order (engine, render errors, levels, disk). */
function useBanner(): BannerData | null {
  const status = useEngine((s) => s.status)
  const error = useStudio((s) => s.error)
  const render = useStudio((s) => s.render)
  const health = engineHealth(status)
  const b = bridge()
  if (status.state === 'offline') {
    return {
      id: `offline:${status.lastError ?? ''}`,
      kind: 'err',
      title: 'ENGINE OFFLINE',
      body: `${status.lastError ?? 'The engine stopped.'} Your script and rack are safe.`,
      ...(b ? { action: { label: 'RECONNECT', run: () => void b.restartEngine() } } : {}),
    }
  }
  if (status.state === 'restarting') {
    return {
      id: `restarting:${status.restarts}`,
      kind: 'info',
      title: 'ENGINE RESTARTING',
      body: `Respawning the engine${status.attempt ? ` (attempt ${status.attempt})` : ''}. ${status.lastError ?? ''}`.trim(),
    }
  }
  if (health?.state === 'error') {
    return {
      id: `health-error:${health.message ?? ''}`,
      kind: 'err',
      title: 'ENGINE ERROR',
      body: `${health.message ?? 'The engine reported an error.'} Synthesis will fail until it recovers.`,
      ...(b ? { action: { label: 'RESTART', run: () => void b.restartEngine() } } : {}),
    }
  }
  if (error && error.code !== 'no_source') {
    const synth = /tts|voice|synth/i.test(error.code)
    const title: Record<string, string> = {
      engine_offline: 'ENGINE OFFLINE',
      export_dir_unavailable: 'EXPORT FOLDER UNAVAILABLE',
      disk_full: 'DISK FULL',
      export_failed: 'EXPORT FAILED',
    }
    return {
      id: `error:${error.code}:${error.message}`,
      kind: 'err',
      title: title[error.code] ?? (synth ? 'SYNTHESIS FAILED' : 'RENDER FAILED'),
      body: [error.message, error.hint].filter(Boolean).join(' '),
      action: {
        label: 'RETRY',
        run: () => {
          studio.setError(null)
          void renderNow('preview')
        },
      },
    }
  }
  const stack = render?.warnings?.find((w) => /stack/i.test(w))
  if (stack) return { id: `stack:${render!.id}`, kind: 'err', title: 'STACK VOICE FAILED', body: stack }
  if (render && render.loudness.true_peak_db > -1 + 0.05) {
    const tp = render.loudness.true_peak_db
    return {
      id: `tp:${render.id}`,
      kind: 'warn',
      title: `TRUE PEAK ${tp > 0 ? '+' : ''}${tp.toFixed(1)} dBTP`,
      body: 'Over the −1.0 dBTP ceiling. Club systems will clip on the echo.',
      action: { label: 'RE-RENDER', run: () => void renderNow('preview') },
    }
  }
  if (health && health.disk_free_bytes < LOW_DISK_BYTES) {
    return {
      id: 'lowdisk',
      kind: 'warn',
      title: `LOW DISK · ${formatBytes(health.disk_free_bytes)} FREE`,
      body: 'Final renders and the persona model need at least 3 GB free.',
      ...(b
        ? {
            action: {
              label: 'REVEAL EXPORTS',
              run: () => void b.reveal(health.export_dir).then((ok) => !ok && toast.warn('Export folder not found')),
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
      <button type="button" className={styles.bannerClose} aria-label="Dismiss" onClick={() => dismiss(data.id)}>
        ×
      </button>
    </div>
  )
}
