import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** In userData. Written once the required models are installed; without it the Setup window opens first. */
export const SETUP_MARKER = 'setup-complete.json'

export const setupMarkerPath = (userData: string): string => join(userData, SETUP_MARKER)

export const hasSetupMarker = (userData: string): boolean => existsSync(setupMarkerPath(userData))

/** Atomic (temp file + rename), so a crash never leaves a half-written marker. */
export function writeSetupMarker(userData: string, info: { version: string; bundled: boolean }): void {
  mkdirSync(userData, { recursive: true })
  const file = setupMarkerPath(userData)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ completedAt: new Date().toISOString(), ...info }, null, 2)}\n`)
  renameSync(tmp, file)
}

export interface SetupDecision {
  packaged: boolean
  /** The app runs its bundled engine (a build for fresh Macs). */
  bundled: boolean
  /** FVWKS_FORCE_SETUP from the environment. Development only: never honoured by a packaged app. */
  forceEnv: string | undefined
  markerExists: boolean
}

/**
 * The Setup window opens before the main window when setup never completed on this Mac, and either the app runs
 * its bundled engine (a fresh-Mac build) or a development run asks for it with FVWKS_FORCE_SETUP=1. Linked and
 * development builds otherwise go straight to the Studio, as before.
 */
export function shouldShowSetup(d: SetupDecision): boolean {
  if (d.markerExists) return false
  if (d.bundled) return true
  return !d.packaged && d.forceEnv === '1'
}

/**
 * Ids of required models that aren't installed, from a GET /api/models body; null when the body isn't a model list
 * (so the caller can't vouch for it).
 */
export function requiredMissing(body: unknown): string[] | null {
  if (!Array.isArray(body)) return null
  const missing: string[] = []
  for (const m of body) {
    if (!m || typeof m !== 'object') return null
    const { id, required, installed } = m as { id?: unknown; required?: unknown; installed?: unknown }
    if (typeof id !== 'string') return null
    if (required === true && installed !== true) missing.push(id)
  }
  return missing
}
