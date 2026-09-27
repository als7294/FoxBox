import type { UpdateState, UpdatesBridge } from '@shared/bridge'
import { useEffect, useState } from 'react'
import { bridge } from '@/env'

/** The useUi `dismissed` id for "Later" on a version: hidden until the next launch or a newer version. */
export const laterId = (version: string | null): string => `update-later:${version ?? ''}`

/**
 * The updater's state (main pushes every change) and the bridge to act on it. `updates` is null in the browser /
 * mock build; `state` stays null until main answers (and when this build has no updater). `apply` takes the state
 * an action resolved with.
 */
export function useUpdates(): { updates: UpdatesBridge | null; state: UpdateState | null; apply(state: UpdateState): void } {
  const [state, setState] = useState<UpdateState | null>(null)
  useEffect(() => {
    const api = bridge()?.updates
    if (!api) return
    let live = true
    const off = api.onState((next) => {
      if (live) setState(next)
    })
    // A push that arrived first is newer than this answer.
    api.getState().then(
      (first) => {
        if (live) setState((cur) => cur ?? first)
      },
      () => {},
    )
    return () => {
      live = false
      off()
    }
  }, [])
  return { updates: bridge()?.updates ?? null, state, apply: setState }
}
