import type { Voice } from '@/api/types'
import { ImportDropzone } from '@/components/source/ImportDropzone'
import { TakesPanel } from '@/components/source/TakesPanel'
import { ScriptEditor } from '@/components/source/ScriptEditor'
import { VoicePicker } from '@/components/source/VoicePicker'
import { studio, useStudio, type SourceTab } from '@/state/studio'
import { useUi } from '@/state/ui'
import styles from './layout.module.css'

const TABS: { id: SourceTab; label: string }[] = [
  { id: 'type', label: 'TYPE' },
  { id: 'import', label: 'IMPORT' },
  // Takes are recorded on VISUALS (VOICE → TAKE); the tab shows once there are some (their transcript and list).
  { id: 'record', label: 'TAKES' },
]

/** SOURCE panel: TYPE | IMPORT (| TAKES), and RECORD →, the way to VISUALS, where takes are recorded. */
export function SourceTabs({ voices }: { voices: readonly Voice[] }) {
  const tab = useStudio((s) => s.tab)
  const hasTakes = useStudio((s) => s.takes.length > 0)
  return (
    <section className={styles.source} aria-label="Source" data-reveal="2">
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>SOURCE</span>
        <div className={styles.flex} />
        <div role="tablist" aria-label="Source" className={styles.tabs}>
          {TABS.filter((t) => t.id !== 'record' || hasTakes || tab === 'record').map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className={styles.tab}
              onClick={() => studio.setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button type="button" className={styles.toLive} onClick={() => useUi.getState().navigate('live')} title="Record takes on VISUALS (VOICE → TAKE)">
          {hasTakes || tab === 'record' ? '● RECORD' : '● RECORD →'}
        </button>
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className={styles.tabPanel}>
        {tab === 'type' && (
          <div className={styles.typeBody}>
            <ScriptEditor />
            <VoicePicker voices={voices} />
          </div>
        )}
        {tab === 'record' && <TakesPanel />}
        {tab === 'import' && <ImportDropzone />}
      </div>
    </section>
  )
}
