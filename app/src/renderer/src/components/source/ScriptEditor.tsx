import { EngineError } from '@/api/client'
import { useScriptPreview } from '@/api/queries'
import { schedulePreview } from '@/state/renderController'
import { PLACEHOLDER_SCRIPT, studio, useStudio } from '@/state/studio'
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
  const bpm = useStudio((s) => s.bpm)
  const sourceWarnings = useStudio((s) => (s.tab === 'type' ? (s.source?.warnings ?? NO_WARNINGS) : NO_WARNINGS))
  const preview = useScriptPreview(script, bpm)
  const refused = script.trim() ? refusal(preview.error) : null
  const warnings = [...new Set([...(refused ? [] : (preview.data?.warnings ?? [])), ...sourceWarnings])]
  const segments = !refused && script.trim() ? (preview.data?.segments ?? []) : []
  const says = segments.length > 0 ? segments.map((s) => s.say).join(' | ') : null
  return (
    <MarkupEditor
      label="Script"
      title="SCRIPT"
      value={script}
      bpm={bpm}
      placeholder={PLACEHOLDER_SCRIPT}
      testId="script-editor"
      onChange={(value) => {
        studio.setScript(value)
        schedulePreview()
      }}
    >
      {says && (
        <p className={styles.says} aria-label="What the voice will say" title={says}>
          <span>SAYS</span>
          {says}
        </p>
      )}
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
