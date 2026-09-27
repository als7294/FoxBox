import type { EngineStatus } from '@shared/bridge'
import { engineHealth } from './engine'

/**
 * Where the start-up is, for the boot screen (a real loading screen: the Studio only appears once the engine is
 * fully ready). Stages in order: setup (uv sync in development builds) → spawn → engine (process up, health
 * answering) → model (the voice model loading, with the engine's progress) → warming → ready; or error.
 */
export type BootStageId = 'setup' | 'spawn' | 'engine' | 'model' | 'warming' | 'ready' | 'error'

export interface BootStage {
  id: BootStageId
  /** Overall progress 0–100 (monotonic across the stages above). */
  pct: number
  /** What the engine says it is doing, or why it failed. */
  detail: string
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0))

export function bootStage(status: EngineStatus): BootStage {
  if (status.state === 'mock') return { id: 'ready', pct: 100, detail: 'mock engine' }
  const health = engineHealth(status)
  if (status.state === 'offline' || status.state === 'stopped') {
    return { id: 'error', pct: 0, detail: status.lastError ?? 'The engine stopped.' }
  }
  if (health?.state === 'error') return { id: 'error', pct: 0, detail: health.message ?? 'The engine reported an error.' }
  if (status.setup) return { id: 'setup', pct: 4, detail: status.detail ?? 'Updating the engine…' }
  const answering = status.state === 'ready' || status.state === 'unresponsive'
  if (answering && health?.state === 'ready') return { id: 'ready', pct: 100, detail: '' }
  if (health?.state === 'loading_model') {
    const message = health.message ?? ''
    // After the downloads the engine loads the voice model into memory and warms it up.
    if (/warm|loading the voice model/i.test(message)) return { id: 'warming', pct: 92, detail: message || 'Warming up the voice model' }
    return { id: 'model', pct: Math.round(22 + 66 * clamp01(health.progress ?? 0)), detail: message || 'Loading the voice model' }
  }
  if (health) return { id: 'engine', pct: 20, detail: health.message ?? 'Engine up' }
  if (status.pid) return { id: 'engine', pct: 12, detail: status.detail ?? 'Waiting for the engine…' }
  return { id: 'spawn', pct: 6, detail: status.detail ?? 'Starting the engine…' }
}

/** Stage order, so the boot log can tell "at or past" a stage. */
export const STAGE_ORDER: readonly BootStageId[] = ['setup', 'spawn', 'engine', 'model', 'warming', 'ready']

export const reached = (stage: BootStage, id: BootStageId): boolean =>
  stage.id !== 'error' && STAGE_ORDER.indexOf(stage.id) >= STAGE_ORDER.indexOf(id)
