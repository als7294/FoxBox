import { engineHealth, engineView, useEngine } from '@/state/engine'
import { useStudio } from '@/state/studio'
import { useUi } from '@/state/ui'
import styles from './layout.module.css'

const PHASE: Record<string, string> = {
  synthesizing: 'SYNTHESIZING',
  rendering: 'PREVIEW RENDER',
  finalizing: 'FINAL RENDER',
  exporting: 'EXPORTING',
}

/** READY, RECONNECTING, ENGINE ERROR, OFFLINE or MOCK ENGINE (start-up states only while booting), or the render phase. */
export function EngineStatus() {
  const status = useEngine((s) => s.status)
  const phase = useStudio((s) => s.phase)
  const view = engineView(status)
  const health = engineHealth(status)
  const busy = view === 'ready' && phase !== 'idle'
  // The boot screen covers the normal start-up (a real loading screen), so after it the chip only reports
  // problems: an engine coming back after a crash or a restart reads RECONNECTING.
  const booting = useUi((s) => s.booting)
  const reconnecting = view === 'loading' || view === 'starting' || view === 'restarting'
  const label =
    booting && view === 'loading'
      ? `LOADING MODEL${health?.progress != null ? ` ${Math.round(health.progress * 100)}%` : ''}`
      : booting && view === 'starting' && status.setup
        ? status.setup === 'update' ? 'UPDATING ENGINE' : 'INSTALLING ENGINE'
        : !booting && reconnecting
          ? 'RECONNECTING'
          : busy
            ? PHASE[phase]!
            : { ready: 'READY', error: 'ENGINE ERROR', starting: 'STARTING', restarting: 'RESTARTING', offline: 'OFFLINE', mock: 'MOCK ENGINE', loading: 'LOADING MODEL' }[view]
  const tone = busy || reconnecting ? 'busy' : view === 'offline' || view === 'error' ? 'off' : 'ok'
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
