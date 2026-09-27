import { engineHealth, engineView, useEngine } from '@/state/engine'
import { useStudio } from '@/state/studio'
import styles from './layout.module.css'

const PHASE: Record<string, string> = {
  synthesizing: 'SYNTHESIZING',
  rendering: 'PREVIEW RENDER',
  finalizing: 'FINAL RENDER',
  exporting: 'EXPORTING',
}

/** READY / LOADING MODEL n% / STARTING / RESTARTING / OFFLINE, or the current render phase while busy. */
export function EngineStatus() {
  const status = useEngine((s) => s.status)
  const phase = useStudio((s) => s.phase)
  const view = engineView(status)
  const health = engineHealth(status)
  const busy = view === 'ready' && phase !== 'idle'
  const label =
    view === 'loading'
      ? `LOADING MODEL${health?.progress != null ? ` ${Math.round(health.progress * 100)}%` : ''}`
      : view === 'starting' && status.setup
        ? status.setup === 'update' ? 'UPDATING ENGINE' : 'INSTALLING ENGINE'
        : busy
        ? PHASE[phase]!
        : { ready: 'READY', error: 'ENGINE ERROR', starting: 'STARTING', restarting: 'RESTARTING', offline: 'OFFLINE', mock: 'MOCK ENGINE' }[view]
  const tone = busy || view === 'loading' || view === 'starting' || view === 'restarting' ? 'busy' : view === 'offline' || view === 'error' ? 'off' : 'ok'
  const title =
    (view === 'error' ? health?.message : null) ??
    status.detail ??
    status.lastError ??
    (health ? `${health.voice_engine} · ${health.fx_engine} · v${health.version}` : undefined)
  return (
    <div className={styles.engine} role="status" data-testid="engine-status" data-state={view} data-tone={tone} title={title}>
      <span className={styles.engineDot} aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}
