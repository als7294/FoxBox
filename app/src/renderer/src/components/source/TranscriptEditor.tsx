import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, EngineError, unwrap } from '@/api/client'
import { useLiveSource, useModels } from '@/api/queries'
import type { SourceInfo } from '@/api/types'
import { parse } from '@/lib/markup'
import { isEngineUsable, useEngine } from '@/state/engine'
import { adoptSource, schedulePreview, TYPING_PREVIEW_MS } from '@/state/renderController'
import { studio, useStudio } from '@/state/studio'
import { openModelsFor } from '@/components/voices/models'
import { MarkupEditor } from './MarkupEditor'
import styles from './scriptEditor.module.css'

const PENDING = new Set(['queued', 'running'])
const ASR_MODEL = 'whisper-aligner'
const SAVED_MS = 2500

type Blocked = { kind: 'model'; detail: string | null; modelId: string } | { kind: 'engine' } | null

/**
 * Puts a saved transcript everywhere the Studio keeps the source: its take or import (even after switching
 * away mid-save) and the live source. The caller asks for the re-render.
 */
function adopt(updated: SourceInfo): void {
  const s = useStudio.getState()
  const take = s.takes.find((t) => t.source?.id === updated.id)
  if (take) studio.updateTake(take.id, { source: updated })
  const imported = useStudio.getState().imported
  if (imported?.source?.id === updated.id) studio.setImported({ ...imported, source: updated })
  if (useStudio.getState().source?.id === updated.id) useStudio.setState({ source: updated, sourceKey: updated.id })
}

/**
 * RECORD / IMPORT (v0.3): the words the engine heard, in the same markup editor as TYPE. Editing them
 * (breaks, pauses, echoes, fixed words) re-segments and re-aligns the recording: PUT /api/sources/{id}/transcript
 * after a 1.3 s pause or when the editor loses focus. Renders only for a recording or import in the Studio.
 */
export function TranscriptEditor() {
  const tab = useStudio((s) => s.tab)
  const source = useStudio((s) => s.source)
  if (tab === 'type' || !source || source.kind === 'tts') return null
  return <Transcript key={source.id} source={source} />
}

function Transcript({ source }: { source: SourceInfo }) {
  const bpm = useStudio((s) => s.bpm)
  const status = useEngine((s) => s.status)
  const epoch = useEngine((s) => s.epoch)
  const asr = (useModels().data ?? []).find((m) => m.id === ASR_MODEL)
  const state = source.transcript_state ?? 'none'
  const pending = PENDING.has(state)

  const [draft, setDraft] = useState(source.script ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<EngineError | null>(null)
  const [blocked, setBlocked] = useState<Blocked>(null)
  // Once the user edits, their words win: the engine's background transcript is no longer followed.
  const [touched, setTouched] = useState(false)
  const draftRef = useRef(draft)
  const blockedRef = useRef<Blocked>(null)
  const dirty = useRef(false)
  const inflight = useRef(false)
  const again = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const savedTimer = useRef<number | undefined>(undefined)

  // Follow the engine while it transcribes: the same poll SignalView uses (one request for both).
  const live = useLiveSource(touched ? null : source).data
  // Installing the aligner model queues every waiting take, which this take's copy can't know: look once.
  const recheck = useQuery({
    queryKey: ['transcript-recheck', source.id, epoch],
    queryFn: ({ signal }) => unwrap(api.GET('/api/sources/{source_id}', { params: { path: { source_id: source.id } }, signal })),
    enabled: isEngineUsable(status) && !touched && asr?.installed === true && state === 'none' && !source.script,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  }).data
  useEffect(() => {
    if (touched) return
    for (const d of [recheck, live]) {
      const cur = useStudio.getState().source
      if (d && cur?.id === d.id && (d.transcript_state !== cur.transcript_state || d.script !== cur.script)) adoptSource(d)
    }
  }, [live, recheck, touched])

  // The engine's words replace the draft unless the user is mid-edit.
  useEffect(() => {
    if (dirty.current) return
    draftRef.current = source.script ?? ''
    setDraft(source.script ?? '')
  }, [source.script])

  const commit = useCallback(async () => {
    window.clearTimeout(timer.current)
    const script = draftRef.current
    if (!dirty.current || !script.trim() || blockedRef.current) return
    if (inflight.current) {
      again.current = true
      return
    }
    inflight.current = true
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const updated = await unwrap(
        api.PUT('/api/sources/{source_id}/transcript', { params: { path: { source_id: source.id } }, body: { script } }),
      )
      if (draftRef.current === script) dirty.current = false
      adopt(updated)
      schedulePreview(0)
      setSaved(true)
      window.clearTimeout(savedTimer.current)
      savedTimer.current = window.setTimeout(() => setSaved(false), SAVED_MS)
    } catch (err) {
      const e = err instanceof EngineError ? err : new EngineError(0, null, String(err))
      if (e.status === 503 && e.code === 'model_not_installed')
        blockedRef.current = { kind: 'model', detail: e.hint ? `${e.message} ${e.hint}` : e.message, modelId: e.modelId ?? ASR_MODEL }
      else if (e.status === 501 || e.code === 'not_implemented') blockedRef.current = { kind: 'engine' }
      else setError(e)
      setBlocked(blockedRef.current)
    } finally {
      inflight.current = false
      setSaving(false)
      if (again.current) {
        again.current = false
        void commit()
      }
    }
  }, [source.id])

  // Switching takes or tabs mid-edit still saves the edit.
  useEffect(
    () => () => {
      window.clearTimeout(savedTimer.current)
      if (dirty.current) void commit()
    },
    [commit],
  )

  const onChange = (value: string) => {
    draftRef.current = value
    dirty.current = true
    setTouched(true)
    setDraft(value)
    setSaved(false)
    setError(null)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void commit(), TYPING_PREVIEW_MS)
  }

  const needsModel = blocked?.kind === 'model' || (asr !== undefined && !asr.installed && !source.script)
  const readOnly = pending || needsModel || blocked?.kind === 'engine'
  const local = useMemo(() => parse(draft), [draft])
  const localNotes = [...(local.error ? [`${local.error.message} ${local.error.hint}`] : []), ...local.warnings]
  const statusText = pending ? 'TRANSCRIBING…' : saving ? 'SAVING…' : saved ? 'SAVED' : null
  const tone = pending || saving ? 'busy' : 'ok'

  return (
    <MarkupEditor
      label="Transcript"
      title="TRANSCRIPT"
      value={pending ? '' : draft}
      bpm={bpm}
      readOnly={readOnly}
      placeholder={pending ? 'Transcribing…' : 'Type what this take says, then mark it up like a script.'}
      status={
        statusText && (
          <span className={styles.status} data-tone={tone} role="status">
            {statusText}
          </span>
        )
      }
      onChange={onChange}
      onLeave={() => void commit()}
      testId="transcript-editor"
    >
      {needsModel && (
        <div className={styles.notice} role="note">
          <p>
            {blocked?.kind === 'model' && blocked.detail
              ? blocked.detail
              : 'Word timings for recordings need the whisper-aligner model. Install it in VOICES to edit this transcript.'}
          </p>
          <button
            type="button"
            className={styles.noticeAction}
            onClick={() => openModelsFor(blocked?.kind === 'model' ? blocked.modelId : ASR_MODEL)}
          >
            INSTALL IN VOICES
          </button>
        </div>
      )}
      {blocked?.kind === 'engine' && (
        <p className={styles.note} role="note">
          Transcript editing arrives with the engine update.
        </p>
      )}
      {!pending && !needsModel && state === 'error' && !source.script && !draft && (
        <p className={styles.note} role="note">
          The engine couldn&apos;t transcribe this take. Type what it says to place the words.
        </p>
      )}
      {(error || localNotes.length > 0) && (
        <ul className={styles.warnings}>
          {error && <li data-tone="error">▲ {error.hint ? `${error.message} ${error.hint}` : error.message}</li>}
          {localNotes.map((w) => (
            <li key={w}>▲ {w}</li>
          ))}
        </ul>
      )}
    </MarkupEditor>
  )
}
