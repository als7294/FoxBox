import { Segmented } from '@/components/rack/Segmented'
import { useEngine } from '@/state/engine'
import { resendWithCleanup } from '@/state/renderController'
import { cleanupOf, studio, useStudio, type Cleanup } from '@/state/studio'
import styles from './source.module.css'

const OPTIONS: { value: Cleanup; label: string; title: string }[] = [
  { value: 'off', label: 'OFF', title: 'As recorded' },
  { value: 'light', label: 'LIGHT', title: 'Takes the edge off room noise and hum' },
  { value: 'full', label: 'FULL', title: 'Removes background noise (the default)' },
]

/**
 * CLEAN-UP for recordings and imports (v0.3, DeepFilterNet3 at ingest). Changing it re-sends the active take
 * or file at the new strength. Hidden on engines that predate it.
 */
export function CleanupControl() {
  const cleanup = useStudio((s) => s.cleanup)
  const supported = useEngine((s) => s.autoBars === true)
  const applied = useStudio((s) => (s.tab !== 'type' ? cleanupOf(s.source?.denoise) : null))
  if (!supported) return null
  return (
    <div className={styles.cleanup} title="Noise removal applied when the audio reaches the engine (DeepFilterNet3)">
      <span className={styles.kicker}>CLEAN-UP</span>
      <div className={styles.cleanupSeg}>
        <Segmented<Cleanup>
          label="Clean-up"
          hideLabel
          size="sm"
          value={cleanup}
          options={OPTIONS}
          onChange={(v) => {
            if (v === cleanup) return
            studio.setCleanup(v)
            void resendWithCleanup()
          }}
        />
      </div>
      {applied && applied !== cleanup && <span className={styles.cleanupNote}>SOURCE: {applied.toUpperCase()}</span>}
    </div>
  )
}
