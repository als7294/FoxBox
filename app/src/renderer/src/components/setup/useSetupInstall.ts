import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, EngineError, unwrap } from '@/api/client'
import type { Health, Job, ModelInfo } from '@/api/types'
import { isEngineUsable, useEngine } from '@/state/engine'
import type { PlanItem } from './plan'

const ACTIVE: Job['state'][] = ['queued', 'running']
export const isActiveJob = (job: Job | undefined): boolean => Boolean(job && ACTIVE.includes(job.state))

/** Models and health for the Setup window, polled faster while something installs. */
export function useSetupData(fast: boolean) {
  const status = useEngine((s) => s.status)
  const epoch = useEngine((s) => s.epoch)
  const usable = isEngineUsable(status)
  const models = useQuery({
    queryKey: ['setup-models', epoch],
    queryFn: ({ signal }) => unwrap(api.GET('/api/models', { signal })),
    enabled: usable,
    refetchInterval: fast ? 1500 : 4000,
    retry: 1,
  })
  const health = useQuery({
    queryKey: ['setup-health', epoch],
    queryFn: ({ signal }) => unwrap(api.GET('/api/health', { signal })),
    enabled: usable,
    refetchInterval: fast ? 1000 : 3000,
    retry: 1,
  })
  return {
    status,
    usable,
    models: (models.data ?? null) as ModelInfo[] | null,
    modelsError: models.error as Error | null,
    health: (health.data ?? null) as Health | null,
    refetch: () => {
      void models.refetch()
      void health.refetch()
    },
  }
}

export interface SetupInstall {
  /** Latest job per model id (the engine's own first-run jobs are adopted through ModelInfo.install_job_id). */
  jobs: Record<string, Job | undefined>
  /** Jobs the engine no longer knows (it restarted mid-download). */
  lost: Record<string, boolean>
  busy: boolean
  error: string | null
  /** POST install for the plan's components, in order (required first); running jobs are reused (the engine dedupes). */
  start(only?: string[]): Promise<void>
  cancelAll(): Promise<void>
}

/** The install jobs behind the Setup rows: start, poll, reattach after an engine restart, cancel. */
export function useSetupInstall(plan: readonly PlanItem[] | null, models: readonly ModelInfo[] | null): SetupInstall {
  const qc = useQueryClient()
  const [jobIds, setJobIds] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const entries = Object.entries(jobIds)
  const results = useQueries({
    queries: entries.map(([, jobId]) => ({
      queryKey: ['setup-job', jobId],
      queryFn: ({ signal }: { signal: AbortSignal }) => unwrap(api.GET('/api/jobs/{job_id}', { params: { path: { job_id: jobId } }, signal })),
      refetchInterval: (q: { state: { error: unknown; data: Job | undefined } }) =>
        q.state.error || (q.state.data && !ACTIVE.includes(q.state.data.state)) ? false : 500,
      retry: (count: number, err: unknown) => !(err instanceof EngineError && err.status === 404) && count < 2,
    })),
  })
  const jobs: Record<string, Job | undefined> = {}
  const lost: Record<string, boolean> = {}
  entries.forEach(([modelId], i) => {
    const r = results[i]
    jobs[modelId] = r?.data as Job | undefined
    if (r?.error instanceof EngineError && r.error.status === 404) lost[modelId] = true
  })

  const latest = useRef({ jobs, models, plan })
  latest.current = { jobs, models, plan }

  // Adopt the engine's running job for a model we don't track, or whose tracked job ended or was lost.
  const lostKey = Object.keys(lost).sort().join(',')
  useEffect(() => {
    if (!models) return
    const adopt: Record<string, string> = {}
    for (const m of models) {
      const running = m.install_job_id
      if (!running || running === jobIds[m.id]) continue
      const tracked = latest.current.jobs[m.id]
      if (!jobIds[m.id] || lostKey.split(',').includes(m.id) || (tracked && !ACTIVE.includes(tracked.state))) adopt[m.id] = running
    }
    if (Object.keys(adopt).length) setJobIds((cur) => ({ ...cur, ...adopt }))
  }, [models, jobIds, lostKey])

  const start = useCallback(
    async (only?: string[]) => {
      const { plan: items, models: known } = latest.current
      if (!items) return
      setBusy(true)
      setError(null)
      try {
        for (const item of items) {
          if (only && !only.includes(item.id)) continue
          const m = known?.find((x) => x.id === item.id)
          if (item.alreadyInstalled || (m && m.installed && !m.update_available)) continue
          if (!only && isActiveJob(latest.current.jobs[item.id])) continue
          const job = await unwrap(api.POST('/api/models/{model_id}/install', { params: { path: { model_id: item.id } } }))
          qc.setQueryData(['setup-job', job.id], job)
          setJobIds((cur) => ({ ...cur, [item.id]: job.id }))
        }
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [qc],
  )

  const cancelAll = useCallback(async () => {
    const active = Object.values(latest.current.jobs).filter((j): j is Job => isActiveJob(j))
    // Queued ones first, so none starts in the gap left by the running one.
    active.sort((a, b) => (a.state === 'queued' ? -1 : 0) - (b.state === 'queued' ? -1 : 0))
    await Promise.allSettled(active.map((j) => unwrap(api.POST('/api/jobs/{job_id}/cancel', { params: { path: { job_id: j.id } } }))))
    await qc.invalidateQueries({ queryKey: ['setup-job'] })
  }, [qc])

  return { jobs, lost, busy, error, start, cancelAll }
}
