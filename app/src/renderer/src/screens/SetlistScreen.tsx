import { useQueryClient } from '@tanstack/react-query'
import { tildePath } from '@/lib/paths'
import { useEffect, useMemo, useRef, useState } from 'react'
import { sampleLines } from '@/state/defaultLines'
import { EngineError } from '@/api/client'
import { useBatch, useCancelJob, useJob, usePresets, useRekordboxExport, useSettings, useVoices } from '@/api/queries'
import type { Job } from '@/api/types'
import { Button } from '@/components/common/Button'
import { TextField } from '@/components/common/Fields'
import { rekordboxSteps, StepsPanel } from '@/components/feedback/StepsPanel'
import { Panel, Screen, ScreenHeader } from '@/components/layout/Screen'
import { SetlistTable, type LineDefaults, type LineView } from '@/components/output/SetlistTable'
import type { TableEmpty } from '@/components/output/VaultTable'
import { orderPresets } from '@/components/rack/PresetStrip'
import { useEngine } from '@/state/engine'
import { buildMaster, partialArrange } from '@/state/renderController'
import { useSetlist, type LineResult, type SetlistLine } from '@/state/setlist'
import { useStudio } from '@/state/studio'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'
import { animate } from '@/visuals/motion'
import s from './setlist.module.css'

const ACTIVE: Job['state'][] = ['queued', 'running']
const DEFAULT_PLAYLIST = 'GUY FVWKS — Drops'
const LOST_NOTE = 'Engine restarted, render again'
const PASTE_TOGGLE = 'setlist-paste-toggle'

const message = (err: unknown) => (err as Error)?.message ?? String(err)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function splitPath(path: string): { dir: string; file: string } {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i < 0 ? { dir: '', file: path } : { dir: path.slice(0, i), file: path.slice(i + 1) }
}

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** The toast for a batch that just settled (design copy). */
function announce(job: Job) {
  const items = job.items ?? []
  const ok = items.filter((i) => i.state === 'done').length
  const failed = items.filter((i) => i.state === 'error').length
  if (job.state === 'cancelled') toast.info('SETLIST CANCELLED', { detail: `${ok} of ${items.length} rendered` })
  else if (!ok) toast.error('SETLIST FAILED', { detail: items.find((i) => i.error)?.error?.message ?? job.error?.message ?? 'No line rendered.' })
  else if (failed) toast.warn('SETLIST PARTIAL', { detail: `${ok} of ${items.length} rendered · ${failed} failed — retry or change voice` })
  else toast.success('SETLIST RENDERED', { detail: `${plural(ok, 'file')} · ready to export` })
}

export function SetlistScreen() {
  const lines = useSetlist((x) => x.lines)
  const playlist = useSetlist((x) => x.playlist)
  const jobId = useSetlist((x) => x.jobId)
  const jobLineIds = useSetlist((x) => x.jobLineIds)
  const jobEpoch = useSetlist((x) => x.jobEpoch)
  const results = useSetlist((x) => x.results)
  const store = useSetlist.getState()

  const presetData = usePresets().data
  const presets = useMemo(() => orderPresets(presetData ?? []), [presetData])
  const voiceData = useVoices().data
  const voices = useMemo(() => (voiceData ?? []).filter((x) => x.installed), [voiceData])
  const settings = useSettings().data
  const studioPresetId = useStudio((x) => x.presetId)
  const studioVoiceId = useStudio((x) => x.voiceId)
  const studioBpm = useStudio((x) => x.bpm)
  const studioBars = useStudio((x) => x.bars)
  const epoch = useEngine((x) => x.epoch)
  const qc = useQueryClient()

  const batch = useBatch()
  const cancel = useCancelJob()
  const rekordbox = useRekordboxExport()
  const jobQ = useJob(jobId)
  const job = jobQ.data?.id === jobId ? jobQ.data : undefined
  // A failed poll keeps the last state: only a lost job (below) unlocks the screen, not a network blip.
  const active = Boolean(job && ACTIVE.includes(job.state))
  const busy = batch.isPending || active || (Boolean(jobId) && jobQ.isPending)

  const [pasteOpen, setPasteOpen] = useState(() => useSetlist.getState().lines.length === 0)
  const [pasteText, setPasteText] = useState('')
  // One line per drop, e.g. three from the Studio's starting lines.
  const pastePlaceholder = useMemo(() => `One line per drop, e.g.\n${sampleLines(3).join('\n')}`, [])
  const [armClear, setArmClear] = useState(false)
  const pastePanel = useRef<HTMLDivElement>(null)
  const pasteArea = useRef<HTMLTextAreaElement>(null)
  const openedByUser = useRef(false)

  // What blank cells use: exactly what the batch request sends as its defaults.
  const defaults: LineDefaults = {
    presetId: studioPresetId ?? settings?.default_preset_id ?? 'pact',
    voiceId: studioVoiceId,
    bpm: studioBpm,
    bars: studioBars,
  }

  // Mirror the batch's items onto its lines while it runs, and once more when it settles (then announce it).
  useEffect(() => {
    if (!job) return
    const st = useSetlist.getState()
    if (st.jobId !== job.id || st.settledJobId === job.id) return
    const next: Record<string, LineResult> = {}
    ;(job.items ?? []).forEach((item, i) => {
      const id = st.jobLineIds[i]
      if (id) next[id] = { state: item.state, progress: item.progress ?? 0, error: item.error ?? null, result_ids: item.result_ids ?? [] }
    })
    st.mergeResults(next)
    if (ACTIVE.includes(job.state)) return
    st.markSettled(job.id)
    // A full run wrote the playlist's rekordbox.xml next to its files (the path comes back as the message).
    if (st.jobPlaylist && job.message && /\.xml$/i.test(job.message) && job.result_ids?.length) {
      st.setXml({ path: job.message, playlist: st.jobPlaylist, exportIds: job.result_ids })
    }
    announce(job)
    void qc.invalidateQueries({ queryKey: ['library'] })
  }, [job, qc])

  // A restarted engine has lost the batch: GET /api/jobs/{id} fails (404, or any error after the restart).
  useEffect(() => {
    if (!jobId || !jobQ.isError) return
    const err = jobQ.error
    const notFound = err instanceof EngineError && (err.status === 404 || err.code === 'not_found')
    if (!notFound && epoch === jobEpoch) return
    useSetlist.getState().loseJob(LOST_NOTE)
    toast.warn('SETLIST INTERRUPTED', { detail: 'The engine restarted during the batch. Unfinished lines need RETRY or RENDER ALL.' })
  }, [jobId, jobQ.isError, jobQ.error, epoch, jobEpoch])

  // CLEAR needs a second click within a few seconds.
  useEffect(() => {
    if (!armClear) return
    const id = setTimeout(() => setArmClear(false), 4000)
    return () => clearTimeout(id)
  }, [armClear])

  // The paste panel scans in; opening it by hand puts the caret in it.
  useEffect(() => {
    if (!pasteOpen) return
    animate(pastePanel.current, [{ clipPath: 'inset(0 0 100% 0)', opacity: 0.4 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 }], {
      duration: 260,
      easing: 'cubic-bezier(.2,.8,.2,1)',
    })
    if (openedByUser.current) pasteArea.current?.focus()
  }, [pasteOpen])

  const views = useMemo(() => {
    const out: Record<string, LineView> = {}
    for (const line of lines) {
      const r = results[line.id]
      const inFlight = r && (r.state === 'queued' || r.state === 'running')
      if (!r || r.state === 'cancelled' || (inFlight && (!active || !jobLineIds.includes(line.id)))) {
        out[line.id] = { state: 'queued', progress: 0, error: null }
      } else {
        const state = r.state as LineView['state']
        out[line.id] = { state, progress: state === 'done' ? 1 : r.progress, error: r.error?.message ?? null }
      }
    }
    return out
  }, [lines, results, active, jobLineIds])
  const done = lines.filter((l) => views[l.id]?.state === 'done').length
  const failed = lines.filter((l) => views[l.id]?.state === 'error').length

  /** Renders the given lines, or every line that isn't DONE (all of them when none or all are). */
  const start = async (only?: readonly string[]) => {
    const st = useSetlist.getState()
    const all = st.lines
    if (!all.length || busy) return
    let target = only ? all.filter((l) => only.includes(l.id)) : all.filter((l) => st.results[l.id]?.state !== 'done')
    if (!target.length) target = all
    // Only a run over every line writes the playlist's rekordbox.xml (a partial run would overwrite it with
    // fewer tracks); EXPORT FOLDER + XML rebuilds it after retries.
    const full = target.length === all.length
    const name = full ? st.playlist.trim() || null : null
    const studio = useStudio.getState()
    try {
      const j = await batch.mutateAsync({
        lines: target.map((l: SetlistLine) => ({ script: l.script, title: l.title || null, voice_id: l.voiceId, preset_id: l.presetId, bpm: l.bpm, bars: l.bars, key: l.key })),
        voice_id: studio.voiceId,
        speed: studio.speed,
        preset_id: defaults.presetId,
        macros: studio.macros,
        arrange: partialArrange(studio),
        master: buildMaster(studio),
        export: { format: settings?.format ?? 'aiff', bit_depth: settings?.bit_depth ?? 24, variants: ['wet'] },
        playlist: name,
      })
      st.startJob(
        j.id,
        target.map((l) => l.id),
        name,
        useEngine.getState().epoch,
      )
      if (full) st.setXml(null)
    } catch (err) {
      toast.error('SETLIST DID NOT START', { detail: message(err) })
    }
  }

  /** The ✓ WRITTEN steps for the rendered lines' rekordbox.xml, (re)writing it if it's missing or out of date. */
  const exportXml = async () => {
    const st = useSetlist.getState()
    const ids = st.lines.filter((l) => views[l.id]?.state === 'done').flatMap((l) => st.results[l.id]?.result_ids ?? [])
    if (!ids.length) return
    const name = st.playlist.trim() || settings?.rekordbox?.playlist_default || DEFAULT_PLAYLIST
    try {
      let xml = st.xml
      if (!xml || xml.playlist !== name || !sameIds(xml.exportIds, ids)) {
        const res = await rekordbox.mutateAsync({ export_ids: ids, playlist: name })
        xml = { path: res.path, playlist: res.playlist, exportIds: ids }
        st.setXml(xml)
      }
      const { dir, file } = splitPath(xml.path)
      useUi.getState().setModal({
        title: 'FOLDER + REKORDBOX XML EXPORTED',
        body: `${tildePath(dir)} · ${plural(ids.length, 'file')} · ${file}`,
        steps: rekordboxSteps(xml.playlist),
        revealPath: xml.path,
      })
    } catch (err) {
      toast.error('XML NOT WRITTEN', { detail: message(err) })
    }
  }

  const addLines = () => {
    const n = store.addMany(pasteText)
    if (!n) return
    setPasteText('')
    setPasteOpen(false)
    toast.success('LINES ADDED', { detail: `${plural(n, 'line')} queued` })
    document.getElementById(PASTE_TOGGLE)?.focus()
  }

  const clearAll = () => {
    if (!armClear) return setArmClear(true)
    setArmClear(false)
    const st = useSetlist.getState()
    if (active && st.jobId) cancel.mutate(st.jobId)
    st.clear()
    // CLEAR disappears with the lines: continue in the paste box.
    setPasteOpen(true)
    requestAnimationFrame(() => pasteArea.current?.focus())
  }

  const rb = settings?.rekordbox
  const hot = rb?.hot_cue_first_word ?? true
  const mem = rb?.memory_cue_tail ?? true
  const cues =
    hot && mem
      ? 'EACH FILE: HOT CUE A AT FIRST WORD · MEMORY CUE AT TAIL'
      : hot
        ? 'EACH FILE: HOT CUE A AT FIRST WORD'
        : mem
          ? 'EACH FILE: MEMORY CUE AT TAIL'
          : 'NO CUES · SETTINGS → REKORDBOX'

  const empty: TableEmpty | null =
    lines.length === 0 ? { title: 'NO LINES YET', body: 'Paste one line per drop above, or use + SETLIST on a Studio cartridge.' } : null

  return (
    <Screen>
      <ScreenHeader compact code="05" kicker="BATCH" title="SETLIST">
        <div className={s.playlist}>
          <TextField label="PLAYLIST NAME" value={playlist} onChange={(name) => store.setPlaylist(name)} disabled={busy} />
        </div>
        <div className={s.spacer} />
        {lines.length > 0 && (
          <Button variant={armClear ? 'danger' : 'ghost'} className={s.headBtn} onClick={clearAll} title="Removes every line (and stops a running batch)">
            {armClear ? 'CONFIRM CLEAR' : 'CLEAR'}
          </Button>
        )}
        <Button
          id={PASTE_TOGGLE}
          className={s.headBtn}
          aria-expanded={pasteOpen}
          aria-controls="setlist-paste"
          onClick={() => {
            openedByUser.current = true
            setPasteOpen((o) => !o)
          }}
        >
          + PASTE MANY
        </Button>
        <Button
          className={`${s.headBtn} ${s.exportXml}`}
          disabled={busy || done === 0 || rekordbox.isPending}
          title={done === 0 ? 'Render lines first' : 'Show the rekordbox.xml import steps (rewrites the XML if lines changed since)'}
          onClick={() => void exportXml()}
        >
          EXPORT FOLDER + XML
        </Button>
        {active && jobId && (
          <Button
            variant="ghost"
            className={s.headBtn}
            disabled={cancel.isPending}
            onClick={() =>
              // If the engine can't cancel it (gone, or not answering), stop waiting for it here.
              cancel.mutate(jobId, { onError: () => useSetlist.getState().loseJob('Not rendered: the batch was stopped') })
            }
          >
            CANCEL
          </Button>
        )}
        <Button
          variant="primary"
          size="lg"
          className={s.renderAll}
          data-testid="render-all"
          aria-busy={busy}
          disabled={busy || lines.length === 0}
          onClick={() => void start()}
        >
          {busy ? 'RENDERING…' : 'RENDER ALL'}
        </Button>
      </ScreenHeader>
      <StepsPanel />
      {pasteOpen && (
        <div ref={pastePanel} id="setlist-paste" className={s.pastePanel}>
          <textarea
            ref={pasteArea}
            className={s.pasteText}
            value={pasteText}
            placeholder={pastePlaceholder}
            aria-label="Paste lines"
            spellCheck={false}
            onChange={(e) => setPasteText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                addLines()
              }
            }}
          />
          <Button variant="ink" className={s.addLines} disabled={!pasteText.trim()} aria-keyshortcuts="Meta+Enter" onClick={addLines}>
            ADD LINES
          </Button>
        </div>
      )}
      <Panel className={s.panel} data-reveal="3">
        <SetlistTable
          lines={lines}
          presets={presets}
          voices={voices}
          defaults={defaults}
          views={views}
          locked={busy}
          onRetry={(line) => void start([line.id])}
          empty={empty}
        />
        <div className={s.footer}>
          <span aria-live="polite" data-testid="setlist-summary">
            {lines.length} {lines.length === 1 ? 'LINE' : 'LINES'} · {done} DONE{failed ? ` · ${failed} FAILED` : ''}
          </span>
          {failed > 0 && <span className={s.partial}>▲ PARTIAL — FAILED LINES ARE SKIPPED IN EXPORT</span>}
          <div className={s.spacer} />
          <span className={s.cues}>{cues}</span>
        </div>
      </Panel>
    </Screen>
  )
}
