import type { FvwksBridge } from '@shared/bridge'

declare global {
  interface Window {
    /** Present in Electron (preload bridge); undefined in the plain-browser build. */
    fvwks?: FvwksBridge
    fvwksMock?: boolean
  }
}

export function bridge(): FvwksBridge | null {
  return typeof window !== 'undefined' && window.fvwks ? window.fvwks : null
}

export const isElectron = (): boolean => Boolean(bridge())

/**
 * Mock mode: no engine, MSW answers /api/* from the page's own origin. Used by `npm run web`,
 * `npm run dev:mock`, and `?mock=1`.
 */
export function isMockMode(): boolean {
  if (typeof window === 'undefined') return false
  if (window.fvwksMock) return true
  if (!bridge()) return true
  return new URLSearchParams(window.location.search).get('mock') === '1'
}
