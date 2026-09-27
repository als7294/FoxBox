import { useEffect, useId } from 'react'
import type { ModelInfo } from '@/api/types'
import { Panel } from '@/components/layout/Screen'
import { formatBytes } from '@/lib/format'
import { toast } from '@/state/toasts'
import { ModelCard } from './ModelCard'
import { orderModels, useModelFocus } from './models'
import styles from './voices.module.css'

/**
 * VOICES → MODELS: every model the engine lists (required first, then opt-in), each with its install state and
 * job. `openModelsFor(id)` (./models) brings the user here with that model's tile lit.
 */
export function ModelsStrip({ models, checking, diskFree }: { models: readonly ModelInfo[]; checking: boolean; diskFree: number | null }) {
  const h = useId()
  const ordered = orderModels(models)
  const ids = ordered.map((m) => m.id).join(' ')
  const wanted = useModelFocus((s) => s.modelId)

  // A model this engine doesn't list can't be lit: say so instead of silently doing nothing.
  useEffect(() => {
    if (!wanted || checking || !ids || ids.split(' ').includes(wanted)) return
    useModelFocus.setState({ modelId: null })
    toast.warn('MODEL NOT OFFERED', { detail: `This engine build has no ${wanted} model to install.` })
  }, [wanted, checking, ids])

  return (
    <Panel className={styles.models} aria-labelledby={h} data-reveal="4">
      <div className={styles.modelsHead}>
        <h2 id={h} className={styles.modelsTitle}>
          Models
        </h2>
        {diskFree != null && <span className={styles.modelsFree}>{formatBytes(diskFree)} free</span>}
      </div>
      {ordered.length === 0 ? (
        <p className={styles.modelsNote}>{checking ? 'Checking models…' : 'Waiting for the engine…'}</p>
      ) : (
        <ul className={styles.modelsList}>
          {ordered.map((m) => (
            <li key={m.id}>
              <ModelCard compact model={m} diskFree={diskFree} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
