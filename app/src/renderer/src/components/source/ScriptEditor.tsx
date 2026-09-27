import { EngineError } from '@/api/client'
import { useScriptPreview } from '@/api/queries'
import { schedulePreview } from '@/state/renderController'
import { studio, useStudio } from '@/state/studio'
import { toast } from '@/state/toasts'
import { MarkupEditor } from './MarkupEditor'
import styles from './scriptEditor.module.css'

// Stable empty array: a fresh [] from a Zustand selector would re-render forever.
const NO_WARNINGS: string[] = []

/** The engine refused the script (pause_too_long, script_too_long…): say why instead of dropping SAYS silently. */
function refusal(err: unknown): string | null {
  if (!(err instanceof EngineError) || err.status < 400 || err.status >= 500) return null
  return err.hint ? `${err.message} ${err.hint}` : err.message
}

/**
 * TYPE: the line for TTS, in the shared markup editor. The engine's preview (POST /api/script/preview) shows
 * what the voice will say and any warnings; the line previews itself once typing pauses.
 */
export function ScriptEditor() {
  const script = useStudio((s) => s.script)
  const defaultLine = useStudio((s) => s.defaultLine)
  const bpm = useStudio((s) => s.bpm)
  const sourceWarnings = useStudio((s) => (s.tab === 'type' ? (s.source?.warnings ?? NO_WARNINGS) : NO_WARNINGS))
  const preview = useScriptPreview(script, bpm)
  const refused = script.trim() ? refusal(preview.error) : null
  const warnings = [...new Set([...(refused ? [] : (preview.data?.warnings ?? [])), ...sourceWarnings])]
  return (
    <MarkupEditor
      label="Script"
      title="SCRIPT"
      value={script}
      bpm={bpm}
      placeholder={defaultLine}
      status={
        <button
          type="button"
          className={styles.shuffle}
          aria-label="Shuffle the line"
          title={script.trim() ? 'Swap in another line (undo in the toast)' : 'Another starting line'}
          onClick={() => {
            const replaced = studio.shuffleLine()
            schedulePreview()
            if (replaced != null) toast.info('LINE SHUFFLED', { actions: [{ label: 'UNDO', run: () => (studio.setScript(replaced), schedulePreview()) }] })
          }}
        >
          <span aria-hidden="true">🎲</span>
        </button>
      }
      testId="script-editor"
      onChange={(value) => {
        studio.setScript(value)
        schedulePreview()
      }}
    >
      {(refused || warnings.length > 0) && (
        <ul className={styles.warnings}>
          {refused && <li data-tone="error">▲ {refused}</li>}
          {warnings.map((w) => (
            <li key={w}>▲ {w}</li>
          ))}
        </ul>
      )}
    </MarkupEditor>
  )
}
