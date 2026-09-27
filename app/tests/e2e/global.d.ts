import type { FvwksBridge } from '../../src/shared/bridge'

declare global {
  interface Window {
    fvwks?: FvwksBridge
  }
}
