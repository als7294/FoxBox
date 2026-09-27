import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { isEngineUsable, useEngine } from '@/state/engine'
import { forgetTtsSources } from '@/state/renderController'
import { api, EngineError, unwrap } from './client'
import type {
  BatchRequest,
  ExportRequest,
  Job,
  Lexicon,
  PersonaDesignRequest,
  Preset,
  Settings,
  SourceInfo,
  TakePatch,
} from './types'

export const qk = {
  voices: ['voices'] as const,
  rack: ['rack'] as const,
  presets: ['presets'] as const,
  settings: ['settings'] as const,
  lexicon: ['lexicon'] as const,
  models: ['models'] as const,
  library: (params: LibraryParams) => ['library', params] as const,
  job: (id: string) => ['job', id] as const,
}

export interface LibraryParams {
  q?: string
  starred?: boolean
  preset_id?: string
  limit?: number
  offset?: number
}

/** Queries wait for the engine, and refetch after it (re)starts. */
function useEngineGate(): { enabled: boolean; epoch: number } {
  const status = useEngine((s) => s.status)
  const epoch = useEngine((s) => s.epoch)
  return { enabled: isEngineUsable(status), epoch }
}

export function useVoices() {
  const gate = useEngineGate()
  return useQuery({
    queryKey: [...qk.voices, gate.epoch],
    queryFn: ({ signal }) => unwrap(api.GET('/api/voices', { signal })),
    enabled: gate.enabled,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  })
}

export function useRack() {
  const gate = useEngineGate()
  return useQuery({
    queryKey: [...qk.rack, gate.epoch],
    queryFn: ({ signal }) => unwrap(api.GET('/api/rack', { signal })),
    enabled: gate.enabled,
    placeholderData: keepPreviousData,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function usePresets() {
  const gate = useEngineGate()
  return useQuery({
    queryKey: [...qk.presets, gate.epoch],
    queryFn: ({ signal }) => unwrap(api.GET('/api/presets', { signal })),
    enabled: gate.enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })
}

export function useSettings() {
  const gate = useEngineGate()
  return useQuery({
    queryKey: [...qk.settings, gate.epoch],
    queryFn: ({ signal }) => unwrap(api.GET('/api/settings', { signal })),
    enabled: gate.enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })
}

export function useLexicon() {
  const gate = useEngineGate()
  return useQuery({
    queryKey: [...qk.lexicon, gate.epoch],
    queryFn: ({ signal }) => unwrap(api.GET('/api/lexicon', { signal })),
    enabled: gate.enabled,
    placeholderData: keepPreviousData,
  })
}

export function useModels() {
  const gate = useEngineGate()
  return useQuery({
    queryKey: [...qk.models, gate.epoch],
    queryFn: ({ signal }) => unwrap(api.GET('/api/models', { signal })),
    enabled: gate.enabled,
    placeholderData: keepPreviousData,
  })
}

export function useLibrary(params: LibraryParams) {
  const gate = useEngineGate()
  return useQuery({
    queryKey: [...qk.library(params), gate.epoch],
    queryFn: ({ signal }) => unwrap(api.GET('/api/library', { params: { query: params }, signal })),
    enabled: gate.enabled,
    placeholderData: (prev) => prev,
  })
}

const ACTIVE: Job['state'][] = ['queued', 'running']

/** Polls a job until it settles. */
export function useJob(jobId: string | null) {
  return useQuery({
    queryKey: qk.job(jobId ?? 'none'),
    queryFn: ({ signal }) => unwrap(api.GET('/api/jobs/{job_id}', { params: { path: { job_id: jobId! } }, signal })),
    enabled: Boolean(jobId),
    // A job lost to an engine restart answers 404: stop polling (the screen offers a re-run).
    refetchInterval: (q) => (q.state.error || (q.state.data && !ACTIVE.includes(q.state.data.state)) ? false : 400),
    retry: (count, err) => !(err instanceof EngineError && err.code === 'not_found') && count < 2,
  })
}

/** POST /api/script/preview: the engine's own parse of the script (segments, what TTS will say, warnings). */
export function useScriptPreview(script: string, bpm: number) {
  const gate = useEngineGate()
  const [debounced, setDebounced] = useState(script)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(script), 300)
    return () => clearTimeout(t)
  }, [script])
  return useQuery({
    queryKey: ['script-preview', debounced, bpm, gate.epoch],
    queryFn: ({ signal }) => unwrap(api.POST('/api/script/preview', { body: { script: debounced, bpm }, signal })),
    enabled: gate.enabled && debounced.trim().length > 0,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
    retry: false,
  })
}

const PENDING: string[] = ['queued', 'running']

/** Background work on a source is still running: WORLD analysis, or (v0.3) the transcript of a recording. */
export function sourcePending(s: Pick<SourceInfo, 'analysis_state' | 'transcript_state'> | null | undefined): boolean {
  return Boolean(s) && (PENDING.includes(s!.analysis_state ?? 'none') || PENDING.includes(s!.transcript_state ?? 'none'))
}

/** Polls a source while its background analysis or transcript runs; returns the latest SourceInfo. */
export function useLiveSource(source: SourceInfo | null) {
  const gate = useEngineGate()
  return useQuery({
    queryKey: ['source', source?.id ?? null, gate.epoch],
    queryFn: ({ signal }) => unwrap(api.GET('/api/sources/{source_id}', { params: { path: { source_id: source!.id } }, signal })),
    enabled: gate.enabled && sourcePending(source),
    refetchInterval: (q) => (q.state.data && !sourcePending(q.state.data) ? false : 700),
    retry: false,
  })
}

export function usePersonaCandidate(candidateId: string) {
  return useQuery({
    queryKey: ['persona-candidate', candidateId],
    queryFn: ({ signal }) =>
      unwrap(api.GET('/api/personas/candidates/{candidate_id}', { params: { path: { candidate_id: candidateId } }, signal })),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function useUpdateSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (settings: Settings) => unwrap(api.PUT('/api/settings', { body: settings })),
    onSuccess: (data) => {
      qc.setQueriesData({ queryKey: qk.settings }, data)
      void qc.invalidateQueries({ queryKey: qk.settings })
    },
  })
}

export function useUpdateLexicon() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (lexicon: Lexicon) => unwrap(api.PUT('/api/lexicon', { body: lexicon })),
    onSuccess: () => {
      // The lexicon changes what TTS says: re-parse the script and re-synthesize the current line.
      forgetTtsSources()
      void qc.invalidateQueries({ queryKey: ['script-preview'] })
      return qc.invalidateQueries({ queryKey: qk.lexicon })
    },
  })
}

export function useSavePreset() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ preset, update }: { preset: Preset; update: boolean }) =>
      update
        ? unwrap(api.PUT('/api/presets/{preset_id}', { params: { path: { preset_id: preset.id } }, body: preset }))
        : unwrap(api.POST('/api/presets', { body: preset })),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.presets }),
  })
}

export function useDeletePreset() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (presetId: string) =>
      unwrap(api.DELETE('/api/presets/{preset_id}', { params: { path: { preset_id: presetId } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.presets }),
  })
}

export function useExport() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (req: ExportRequest) => unwrap(api.POST('/api/exports', { body: req })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library'] }),
  })
}

export function useRekordboxExport() {
  return useMutation({
    mutationFn: (req: { export_ids: string[]; playlist: string; target_path_root?: string | null }) =>
      unwrap(api.POST('/api/exports/rekordbox', { body: req })),
  })
}

export function usePatchTake() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: TakePatch }) =>
      unwrap(api.PATCH('/api/library/{take_id}', { params: { path: { take_id: id } }, body: patch })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library'] }),
  })
}

export function useDeleteTake() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE('/api/library/{take_id}', { params: { path: { take_id: id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library'] }),
  })
}

export function useBatch() {
  return useMutation({
    mutationFn: (req: BatchRequest) => unwrap(api.POST('/api/batch', { body: req })),
  })
}

export function useCancelJob() {
  return useMutation({
    mutationFn: (jobId: string) => unwrap(api.POST('/api/jobs/{job_id}/cancel', { params: { path: { job_id: jobId } } })),
  })
}

export function useInstallModel() {
  return useMutation({
    mutationFn: (modelId: string) =>
      unwrap(api.POST('/api/models/{model_id}/install', { params: { path: { model_id: modelId } } })),
  })
}

export function useDesignPersona() {
  return useMutation({
    mutationFn: (req: PersonaDesignRequest) => unwrap(api.POST('/api/personas/design', { body: req })),
  })
}

export function useSavePersona() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (req: { candidate_id: string; name: string }) => unwrap(api.POST('/api/personas', { body: req })),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.voices }),
  })
}
