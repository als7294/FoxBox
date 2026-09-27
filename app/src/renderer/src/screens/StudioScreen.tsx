import { usePresets, useRack, useVoices } from '@/api/queries'
import { SourceTabs } from '@/components/layout/SourceTabs'
import { ProgressOverlay } from '@/components/feedback/ProgressOverlay'
import { Cartridge } from '@/components/output/Cartridge'
import { ExportSheet } from '@/components/output/ExportSheet'
import { RackDrawer, RackPanel } from '@/components/rack/RackPanel'
import { SavePresetModal } from '@/components/rack/SavePresetModal'
import { SignalView } from '@/components/signal/SignalView'
import { isStale, useStudio } from '@/state/studio'
import { useUi } from '@/state/ui'
import styles from './studio.module.css'

/** STUDIO: SOURCE (type/record/import) | SIGNAL, with RACK and OUTPUT below; OPEN RACK slides the full rack over. */
export function StudioScreen() {
  const voices = useVoices().data ?? []
  const presets = usePresets().data ?? []
  const rack = useRack().data
  const render = useStudio((s) => s.render)
  const exports = useStudio((s) => s.exports)
  const stale = useStudio(isStale)
  const rackOpen = useStudio((s) => s.rackOpen)
  const exportOpen = useUi((s) => s.exportSheetOpen)
  const saveOpen = useUi((s) => s.savePresetOpen)
  const wet = exports.find((f) => f.variant === 'wet') ?? exports[0] ?? null
  return (
    <div className={styles.studio} data-rack-open={rackOpen || undefined}>
      <SourceTabs voices={voices} />
      <SignalView />
      <div className={styles.bottom}>
        {rack ? (
          <RackPanel rack={rack} presets={presets} />
        ) : (
          <section className={styles.rackLoading} aria-label="Rack" data-reveal="4" aria-busy="true">
            <ProgressOverlay label="LOADING THE RACK" />
          </section>
        )}
        <Cartridge render={render} file={wet} stale={stale} />
      </div>
      {rackOpen && rack && <RackDrawer rack={rack} voices={voices} />}
      <ExportSheet open={exportOpen} onClose={() => useUi.getState().setExportSheetOpen(false)} presets={presets} />
      <SavePresetModal open={saveOpen} onClose={() => useUi.getState().setSavePresetOpen(false)} presets={presets} />
    </div>
  )
}
