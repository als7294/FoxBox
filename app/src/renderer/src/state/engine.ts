import type { EngineStatus } from '@shared/bridge'
import { create } from 'zustand'
import type { Health } from '@/api/types'
import { bridge, isMockMode } from '@/env'

export type EngineView = 'ready' | 'loading' | 'error' | 'starting' | 'restarting' | 'offline' | 'mock'

interface EngineStore {
  status: EngineStatus
  /** Bumped whenever the engine (re)becomes ready, so queries refetch. */
  epoch: number
  /** Does this engine take Arrange.bars "auto" (v0.2+ contracts)? null = not probed yet. */
  autoBars: boolean | null
  /** The engine epoch `autoBars` was probed on (a restarted engine is probed again; the old answer holds meanwhile). */
  probedEpoch: number
  setStatus(status: EngineStatus): void
  setAutoBars(autoBars: boolean | null): void
}

const initial: EngineStatus = {
  state: isMockMode() ? 'mock' : 'idle',
  url: '',
  pid: null,
  restarts: 0,
  attempt: 0,
  startedAt: null,
  readyAt: null,
  lastExit: null,
  lastError: null,
  detail: null,
  setup: null,
  health: null,
  nextRetryAt: null,
  logFile: null,
}

export const useEngine = create<EngineStore>((set, get) => ({
  status: initial,
  epoch: 0,
  autoBars: null,
  probedEpoch: -1,
  setStatus(status) {
    const prev = get().status
    // A new engine is ready: ready after any other state, or ready under a different (real) process id.
    const becameReady = status.state === 'ready' && (prev.state !== 'ready' || (status.pid != null && prev.pid !== status.pid))
    set({ status, epoch: becameReady ? get().epoch + 1 : get().epoch })
  },
  setAutoBars: (autoBars) => set({ autoBars, probedEpoch: get().epoch }),
}))

export function engineHealth(status: EngineStatus): Health | null {
  const h = status.health as Health | null
  return h && typeof h === 'object' && 'state' in h ? h : null
}

/** One word for the EngineStatus chip: READY / LOADING MODEL / ERROR / STARTING / RESTARTING / OFFLINE / MOCK. */
export function engineView(status: EngineStatus): EngineView {
  if (status.state === 'mock') return 'mock'
  const health = engineHealth(status)
  if (status.state === 'ready' || status.state === 'unresponsive') {
    // The engine answers but reports a failure (espeak missing, model failed to load): TTS will fail.
    if (health?.state === 'error') return 'error'
    return health?.state === 'loading_model' || health?.state === 'starting' ? 'loading' : 'ready'
  }
  if (status.state === 'starting' || status.state === 'idle') return 'starting'
  if (status.state === 'restarting') return 'restarting'
  return 'offline'
}

export function isEngineUsable(status: EngineStatus): boolean {
  return status.state === 'mock' || status.state === 'ready' || status.state === 'unresponsive'
}

/** Subscribes the store to main's engine status pushes. Returns an unsubscribe function. */
export function connectEngineStatus(): () => void {
  const b = bridge()
  if (!b || isMockMode()) {
    useEngine.getState().setStatus({ ...initial, state: 'mock' })
    return () => {}
  }
  void b.getEngineStatus().then((s) => s && useEngine.getState().setStatus(s))
  return b.onEngineStatus((s) => useEngine.getState().setStatus(s))
}
