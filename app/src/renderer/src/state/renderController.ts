import { api, EngineError, isAbort, unwrap } from '@/api/client'
import { uploadSource } from '@/api/upload'
import type { Arrange, ExportedFile, ExportRequest, Master, RenderInfo, RenderRequest, SnapEnd, SourceInfo } from '@/api/types'
import { loadAudioBuffer } from '@/audio/cache'
import { analyseBuffer } from '@/visuals/analysis'
import { clearRenderVisuals, setRenderVisuals, vis } from '@/visuals/state'
import { player } from '@/audio/playerInstance'
import { bridge } from '@/env'
import { isEngineUsable, useEngine } from './engine'
import { toast } from './toasts'
import {
  currentDenoise,
  currentRenderKey,
  scriptOf,
  studio,
  ttsKey,
  useStudio,
  type StudioState,
} from './studio'

/** Knob-release debounce before a preview render. */
export const RENDER_DEBOUNCE_MS = 150

let generation = 0
let inflight: AbortController | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
const ttsCache = new Map<string, SourceInfo>()

function toStudioError(err: unknown) {
  if (err instanceof EngineError) return { code: err.code, message: err.message, hint: err.hint }
  return { code: 'error', message: (err as Error)?.message ?? String(err), hint: null }
}

/**
 * Contract ruling (v0.1, S3 P3): send only the Arrange/Master fields the user controls. The server fills the
 * rest from the preset's arrange_hint/master_hint (e.g. GHOST's first_word_beat: 4), then its defaults.
 * The generated types mark every field required, hence the casts.
 */
export function partialArrange(s: Pick<StudioState, 'bpm' | 'bars' | 'key'> & { snapEnd?: SnapEnd | null }): Arrange {
  // snap_end only when chosen: the preset's hint or the engine default (BEAT) applies otherwise, and engines
  // before v0.4.1 (extra fields forbidden) never see it.
  return { bpm: s.bpm, bars: s.bars, key: s.key, ...(s.snapEnd ? { snap_end: s.snapEnd } : {}) } as Arrange
}

export function buildMaster(s: Pick<StudioState, 'masterMode' | 'customLufs'>): Master {
  return (s.masterMode === 'custom' ? { mode: s.masterMode, target_lufs: s.customLufs } : { mode: s.masterMode }) as Master
}

export function buildRenderRequest(s: StudioState, sourceId: string, quality: 'preview' | 'final'): RenderRequest {
  return {
    source_id: sourceId,
    preset_id: s.presetId,
    chain: s.chain,
    macros: s.macros,
    macro_map: s.macroMap,
    stack: s.stack,
    arrange: partialArrange(s),
    master: buildMaster(s),
    quality,
    stems: false,
    auto_export: quality === 'final',
  }
}

/** Re-sends the active take or imported file (kept locally) when the engine no longer has it. */
async function reuploadLocal(s: StudioState): Promise<SourceInfo | null> {
  if (s.tab === 'record') {
    const take = s.takes.find((t) => t.id === s.activeTakeId)
    if (!take) return null
    studio.updateTake(take.id, { status: 'uploading', error: null })
    const source = await uploadSource(take.wav, `${take.name}.wav`, 'recording', take.name, currentDenoise())
    studio.updateTake(take.id, { status: 'ready', source })
    useStudio.setState({ source, sourceKey: source.id })
    return source
  }
  if (s.tab === 'import' && s.imported) {
    const source = await uploadSource(s.imported.blob, s.imported.uploadName, 'import', s.imported.name, currentDenoise())
    studio.setImported({ ...s.imported, source })
    useStudio.setState({ source, sourceKey: source.id })
    return source
  }
  return null
}

async function ensureSource(signal: AbortSignal, gen: number): Promise<SourceInfo | null> {
  const s = useStudio.getState()
  if (s.tab !== 'type') {
    if (s.source) return s.source
    const again = await reuploadLocal(s)
    if (again || gen !== generation) return again
    studio.setError({
      code: 'no_source',
      message: s.tab === 'record' ? 'Record a take first.' : 'Drop a file to import first.',
      hint: null,
    })
    return null
  }
  const key = ttsKey(s)
  if (s.source && s.sourceKey === key) return s.source
  const cached = ttsCache.get(key)
  if (cached) {
    useStudio.setState({ source: cached, sourceKey: key })
    return cached
  }
  if (!s.script.trim()) studio.setScript(s.defaultLine)
  studio.setPhase('synthesizing')
  const source = await unwrap(
    api.POST('/api/sources/tts', {
      body: { script: scriptOf(s), voice_id: s.voiceId, speed: s.speed, bpm: s.bpm, name: null },
      signal,
    }),
  )
  if (gen !== generation) return null
  ttsCache.set(key, source)
  useStudio.setState({ source, sourceKey: key })
  return source
}

/**
 * Synthesize (if the script changed) → render → load wet + dry audio into the A/B player.
 * A newer call supersedes older ones; superseded calls resolve to null.
 */
function isMissingSource(err: unknown): boolean {
  return err instanceof EngineError && err.code === 'not_found' && /source/i.test(err.message)
}

/** The engine restarted and lost its in-memory sources: forget ours so the next render re-creates them. */
export function forgetEngineSources(): void {
  ttsCache.clear()
  const s = useStudio.getState()
  useStudio.setState({
    source: null,
    sourceKey: null,
    takes: s.takes.map((t) => ({ ...t, source: null, status: t.status === 'error' ? t.status : ('local' as const) })),
    imported: s.imported ? { ...s.imported, source: null } : null,
  })
}

/** Rack features this engine build lacks (e.g. its native DSP module failed to compile): said once per session. */
const buildWarningsSeen = new Set<string>()
function noteBuildWarnings(warnings: readonly string[] | undefined): void {
  for (const w of warnings ?? []) {
    if (!/unavailable in this build/i.test(w) || buildWarningsSeen.has(w)) continue
    buildWarningsSeen.add(w)
    toast.warn('UNAVAILABLE IN THIS BUILD', { detail: w })
  }
}

export async function renderNow(quality: 'preview' | 'final' = 'preview', retried = false): Promise<RenderInfo | null> {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = null
  if (useStudio.getState().queued) useStudio.setState({ queued: null })
  const gen = ++generation
  inflight?.abort()
  const ctrl = new AbortController()
  inflight = ctrl
  studio.setError(null)
  try {
    const source = await ensureSource(ctrl.signal, gen)
    if (!source || gen !== generation) return null
    const s = useStudio.getState()
    const key = currentRenderKey(s)
    studio.setPhase(quality === 'final' ? 'finalizing' : 'rendering')
    if (quality === 'final') vis.finalT0 = performance.now()
    const info = await unwrap(api.POST('/api/render', { body: buildRenderRequest(s, source.id, quality), signal: ctrl.signal }))
    if (gen !== generation) return null
    const [wet, dry] = await Promise.all([loadAudioBuffer(info.audio_id), loadAudioBuffer(info.dry_audio_id)])
    if (gen !== generation) return null
    player.setBuffers({ wet, dry })
    // Same source re-rendered (a knob moved): morph; a new line or a final render: sweep it in.
    const previous = useStudio.getState().render
    const mode = quality === 'preview' && previous?.source_id === info.source_id && vis.wet ? 'morph' : 'reveal'
    // Visuals only: a failed analysis must never fail the render.
    try {
      setRenderVisuals(analyseBuffer(wet), analyseBuffer(dry), mode, quality === 'final')
    } catch (err) {
      console.warn('[render] waveform analysis failed', err)
      clearRenderVisuals()
    }
    vis.finalT0 = 0
    useStudio.setState({ render: info, renderKey: key, phase: 'idle', exports: info.export ? [info.export] : [] })
    noteBuildWarnings(info.warnings)
    return info
  } catch (err) {
    if (gen === generation) vis.finalT0 = 0
    if (isAbort(err) || gen !== generation) return null
    // The engine dropped this preview for a newer one of the same line (409 superseded): not an error.
    if (err instanceof EngineError && err.code === 'superseded') {
      useStudio.setState({ phase: 'idle' })
      return null
    }
    if (!retried && isMissingSource(err)) {
      forgetEngineSources()
      return renderNow(quality, true)
    }
    // An engine that predates AUTO bars rejects the request body: fall back to 4 bars once.
    if (!retried && err instanceof EngineError && err.status === 422 && useStudio.getState().bars === 'auto') {
      useEngine.getState().setAutoBars(false)
      studio.setBars(4)
      toast.warn('AUTO BARS NEEDS THE ENGINE UPDATE', { detail: 'Using 4 bars for now.' })
      return renderNow(quality, true)
    }
    const e = toStudioError(err)
    useStudio.setState({ phase: 'idle', error: e })
    return null
  } finally {
    if (inflight === ctrl) inflight = null
  }
}

function schedule(delay: number, why: 'typing' | 'controls' = 'controls'): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  useStudio.setState({ queued: why })
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void renderNow('preview')
  }, delay)
}

/** Re-render shortly after a control is released (coalesces bursts). Only when there is something to render. */
export function scheduleRender(delay = RENDER_DEBOUNCE_MS): void {
  const s = useStudio.getState()
  if (!s.render && !s.source) return
  schedule(delay)
}

/** How long typing has to pause before the line previews (the design's 1.3 s). */
export const TYPING_PREVIEW_MS = 1300

/**
 * Preview the typed line once typing pauses (or after a voice/speed change), even before the first render.
 * Nothing happens for an empty script or while the engine is down.
 */
export function schedulePreview(delay = TYPING_PREVIEW_MS): void {
  const s = useStudio.getState()
  if (s.tab === 'type' ? !s.script.trim() : !s.source && !s.render) return
  if (!isEngineUsable(useEngine.getState().status)) return
  schedule(delay, 'typing')
}

const signedDb = (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`)

/** Final render (auto-exports the wet file, so the cartridge is drag-ready). */
export async function renderFinal(): Promise<RenderInfo | null> {
  const info = await renderNow('final')
  if (info?.export) {
    const l = info.loudness
    toast.success('FINAL RENDER COMPLETE', {
      detail: `${signedDb(l.short_term_max_lufs ?? l.integrated_lufs)} LUFS · ${signedDb(l.true_peak_db)} dBTP · drag the cartridge into Rekordbox`,
    })
  }
  for (const w of info?.warnings ?? []) if (/not exported/i.test(w)) toast.warn('NOT EXPORTED', { detail: w })
  return info
}

/** A final, up-to-date render: reuses the current one when nothing changed. */
export async function ensureFinal(): Promise<RenderInfo | null> {
  const s = useStudio.getState()
  if (s.render?.quality === 'final' && s.renderKey === currentRenderKey(s)) return s.render
  return renderNow('final')
}

export interface ExportOptions {
  format: ExportRequest['format']
  bit_depth: ExportRequest['bit_depth']
  variants: string[]
  stems: boolean
  title?: string | null
  /** v0.7: also write the song with this drop baked in (variant 'baked'). */
  bake?: ExportRequest['bake']
}

/** Export the current render (rendering a final first when needed). */
export async function exportCurrent(options: ExportOptions): Promise<{ files: ExportedFile[]; warnings: string[] }> {
  const info = await ensureFinal()
  if (!info) return { files: [], warnings: [] }
  studio.setPhase('exporting')
  vis.exportT0 = performance.now()
  try {
    const res = await unwrap(
      api.POST('/api/exports', {
        body: {
          render_ids: [info.id],
          format: options.format,
          bit_depth: options.bit_depth,
          variants: options.variants,
          stems: options.stems,
          title: options.title ?? null,
          ...(options.bake ? { bake: options.bake } : {}),
        },
      }),
    )
    const byId = new Map(useStudio.getState().exports.map((f) => [f.id, f]))
    for (const f of res.files) byId.set(f.id, f)
    useStudio.setState({ exports: [...byId.values()], phase: 'idle' })
    return { files: res.files, warnings: res.warnings ?? [] }
  } catch (err) {
    useStudio.setState({ phase: 'idle', error: toStudioError(err) })
    return { files: [], warnings: [] }
  } finally {
    vis.exportT0 = 0
  }
}

/**
 * EXPORT (⌘⇧E): make sure an up-to-date final exists (a final render auto-exports the wet file in the
 * current settings' format) and hand that file over; export again only if the format changed since.
 */
export async function exportNow(format: ExportRequest['format'], bitDepth: ExportRequest['bit_depth']): Promise<ExportedFile | null> {
  const info = await ensureFinal()
  if (!info) return null
  let file: ExportedFile | null = info.export && info.export.format === format && info.export.bit_depth === bitDepth ? info.export : null
  if (!file) {
    const { files, warnings } = await exportCurrent({ format, bit_depth: bitDepth, variants: ['wet'], stems: false })
    for (const w of warnings) toast.warn('EXPORT WARNING', { detail: w })
    file = files[0] ?? null
  }
  if (file) {
    const b = bridge()
    const path = file.path
    toast.success('EXPORTED', {
      detail: path,
      dragPath: path,
      actions: b ? [{ label: 'REVEAL', run: () => void b.reveal(path) }] : [],
    })
  }
  return file
}

/** The lexicon changed: synthesized lines are out of date (recordings and imports are not). */
export function forgetTtsSources(): void {
  ttsCache.clear()
  const s = useStudio.getState()
  if (s.tab === 'type') useStudio.setState({ source: null, sourceKey: null })
  schedulePreview(400)
}

/**
 * CLEAN-UP changed (v0.3): send the active take or imported file again at the new strength (the engine applies
 * it at ingest), then preview. The local audio is kept for exactly this.
 */
export async function resendWithCleanup(): Promise<void> {
  const s = useStudio.getState()
  if (s.tab === 'type') return
  if (s.tab === 'record') {
    const take = s.takes.find((t) => t.id === s.activeTakeId)
    if (!take || take.status === 'uploading') return
    useStudio.setState({ source: null, sourceKey: null })
    studio.updateTake(take.id, { source: null })
  } else {
    if (!s.imported) return
    useStudio.setState({ source: null, sourceKey: null })
    studio.setImported({ ...s.imported, source: null })
  }
  try {
    // With no source, renderNow re-uploads the local audio (reuploadLocal) at the current clean-up.
    await renderNow('preview')
  } catch (err) {
    toast.error('CLEAN-UP NOT APPLIED', { detail: (err as Error).message })
  }
}

/**
 * The engine finished background work on the active recording/import (v0.3 transcript): take its new SourceInfo
 * (script, words) into the Studio, and re-render once so the waveform shows the words.
 */
export function adoptSource(info: SourceInfo): void {
  const s = useStudio.getState()
  if (s.source?.id !== info.id) return
  const transcribed = info.transcript_state === 'done' && s.source.transcript_state !== 'done'
  if (s.tab === 'record' && s.activeTakeId) studio.updateTake(s.activeTakeId, { source: info })
  else if (s.tab === 'import' && s.imported) studio.setImported({ ...s.imported, source: info })
  useStudio.setState({ source: info, sourceKey: info.id })
  if (transcribed && s.render?.source_id === info.id) void renderNow('preview')
}

/** Test hook: forget cached TTS sources. */
export function resetRenderCache(): void {
  ttsCache.clear()
}

// A restarted engine (new process, new epoch) has none of the old sources.
useEngine.subscribe((state, prev) => {
  if (prev.epoch > 0 && state.epoch !== prev.epoch) forgetEngineSources()
})
