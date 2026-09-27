import { api } from '@/api/client'
import type { Arrange } from '@/api/types'
import { isEngineUsable, useEngine } from './engine'
import { studio, useStudio } from './studio'

/**
 * Does this engine take Arrange.bars "auto" (v0.2+ contracts)? A render request for a source that can't exist:
 * a v0.1 engine rejects the body (422) before it looks the source up; a v0.2+ engine gets as far as the lookup
 * (404). Nothing is synthesized or rendered either way.
 */
export async function probeAutoBars(): Promise<boolean | null> {
  try {
    const { response } = await api.POST('/api/render', {
      body: {
        source_id: '__fvwks_capability_probe__',
        arrange: { bars: 'auto' } as Arrange,
        quality: 'preview',
        stems: false,
        auto_export: false,
      },
    })
    if (response.status === 404) return true
    if (response.status === 422) return false
    return null
  } catch {
    return null
  }
}

/** On an engine without AUTO, a Studio set to AUTO falls back to 4 bars (the old default). */
function applyAutoBars(supported: boolean | null): void {
  if (supported === false && useStudio.getState().bars === 'auto') studio.setBars(4)
}

let probing = false

/** Probes each (re)started engine once and keeps useEngine.autoBars current. Returns an unsubscribe. */
export function watchCapabilities(): () => void {
  const check = () => {
    // Each (re)started engine may be a different build: probe it once; the previous answer holds meanwhile.
    const { status, epoch, probedEpoch } = useEngine.getState()
    if (probedEpoch === epoch || probing || !isEngineUsable(status)) return
    probing = true
    void probeAutoBars().then((supported) => {
      probing = false
      // A still-unknown answer (engine busy, network) is retried on the next status change.
      if (supported === null) return
      useEngine.getState().setAutoBars(supported)
      applyAutoBars(supported)
    })
  }
  check()
  const offEngine = useEngine.subscribe(check)
  // Settings defaults may set AUTO after the probe answered.
  const offStudio = useStudio.subscribe((s, prev) => {
    if (s.bars === 'auto' && prev.bars !== 'auto') applyAutoBars(useEngine.getState().autoBars)
  })
  return () => {
    offEngine()
    offStudio()
  }
}
