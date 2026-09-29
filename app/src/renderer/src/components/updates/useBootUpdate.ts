import type { BootUpdateState } from '@shared/bridge'
import { useEffect, useState } from 'react'
import { bridge } from '@/env'

const CLEAR: BootUpdateState = {
  phase: 'clear',
  current: '',
  version: null,
  sizeBytes: null,
  step: null,
  download: null,
  attempt: 0,
  error: null,
}
const WAITING: BootUpdateState = { ...CLEAR, phase: 'checking' }

/**
 * The update check at boot (main's BootUpdateGate): the boot screen holds its hand-over until it is `clear`. Clear
 * at once in the browser / mock build; until main answers, `checking`; if main can't answer, clear (never stuck).
 */
export function useBootUpdate(): { state: BootUpdateState; proceed(): void } {
  const [state, setState] = useState<BootUpdateState>(() => (bridge()?.bootUpdate ? WAITING : CLEAR))
  useEffect(() => {
    const api = bridge()?.bootUpdate
    if (!api) return
    let live = true
    let pushed = false
    const off = api.onState((next) => {
      pushed = true
      if (live) setState(next)
    })
    // A push that arrived first is newer than this answer.
    api.getState().then(
      (first) => live && !pushed && setState(first),
      () => live && !pushed && setState(CLEAR),
    )
    return () => {
      live = false
      off()
    }
  }, [])
  const proceed = () => {
    const api = bridge()?.bootUpdate
    if (!api) return
    api.continue().then(
      (next) => setState(next),
      () => setState(CLEAR),
    )
  }
  return { state, proceed }
}
