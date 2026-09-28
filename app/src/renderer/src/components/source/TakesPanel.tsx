import { Button } from '@/components/common/Button'
import { renderNow } from '@/state/renderController'
import { studio, useStudio } from '@/state/studio'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'
import { TakeList } from './TakeList'
import { uploadTake } from './takes'
import { TranscriptEditor } from './TranscriptEditor'
import styles from './source.module.css'

/**
 * The Studio's TAKES: the takes recorded on VISUALS, the active one's transcript (edit it to place throws), and a way
 * back to VISUALS for another. Recording itself lives on VISUALS (VOICE → TAKE → STUDIO).
 */
export function TakesPanel() {
  const takes = useStudio((s) => s.takes)
  const activeId = useStudio((s) => s.activeTakeId)
  const presetName = useStudio((s) => s.presetName)
  return (
    <div className={styles.record}>
      <Button variant="primary" onClick={() => useUi.getState().navigate('live')} data-testid="record-in-live">
        ● RECORD A TAKE IN VISUALS
      </Button>
      <TranscriptEditor />
      <div className={styles.takesHead}>
        <span className={styles.kicker}>TAKES · {takes.length}</span>
        {takes.length > 0 && (
          <button
            type="button"
            className={styles.clear}
            onClick={() => {
              for (const t of useStudio.getState().takes) studio.removeTake(t.id)
            }}
          >
            CLEAR
          </button>
        )}
      </div>
      <TakeList
        takes={takes}
        activeId={activeId}
        onUse={(id) => {
          const t = useStudio.getState().takes.find((x) => x.id === id)
          studio.selectTake(id)
          if (t) toast.success(`${t.name} → SOURCE`, { detail: `Masking with ${presetName ?? 'CUSTOM'} · ${t.durationS.toFixed(2)} s` })
          if (useStudio.getState().source) void renderNow('preview')
        }}
        onRetry={(id) => {
          const t = useStudio.getState().takes.find((x) => x.id === id)
          if (t) void uploadTake(t)
        }}
      />
    </div>
  )
}
