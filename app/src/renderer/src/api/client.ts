import createClient from 'openapi-fetch'
import { hideHome } from '@/lib/paths'
import { bridge, isMockMode } from '@/env'
import type { paths } from './schema'
import { ipcTransport, webTransport, type Transport } from './transport'
import type { ApiErrorBody, Job } from './types'

/** Engine error with the engine's own {code, message, hint, retryable}. */
export class EngineError extends Error {
  readonly code: string
  readonly hint: string | null
  readonly retryable: boolean
  readonly status: number
  /** v0.6: the model a `model_not_installed` error is about (deep links to VOICES → MODELS). */
  readonly modelId: string | null

  constructor(status: number, body: Partial<ApiErrorBody> | null, fallback?: string) {
    // Engine messages can name files: never with the home folder on screen.
    super(hideHome(body?.message ?? fallback ?? `Engine error ${status}`))
    this.name = 'EngineError'
    this.status = status
    this.code = body?.code ?? (status === 0 ? 'network' : `http_${status}`)
    this.hint = body?.hint ?? null
    this.retryable = body?.retryable ?? status >= 500
    this.modelId = typeof body?.model_id === 'string' && body.model_id ? body.model_id : null
  }
}

export function isAbort(err: unknown): boolean {
  return (err instanceof DOMException && err.name === 'AbortError') || (err instanceof EngineError && err.code === 'aborted')
}

function pickTransport(): { baseUrl: string; transport: Transport } {
  const b = bridge()
  if (b && !isMockMode()) return { baseUrl: 'http://engine.ipc', transport: ipcTransport(b) }
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
  return { baseUrl: origin, transport: webTransport }
}

const { baseUrl, transport } = pickTransport()

export const api = createClient<paths>({ baseUrl, fetch: transport })

/** 2.0 library wheel: a track's cover or preview, vbx://art|preview/<id> in Electron, the engine's route otherwise. */
export function libraryUrl(kind: 'art' | 'preview', trackId: string): string {
  const id = encodeURIComponent(trackId)
  return bridge() && !isMockMode() ? `vbx://${kind}/${id}` : `${baseUrl}/api/library/tracks/${id}/${kind}`
}

/** Audio URL for GET /api/audio/{id}: vbx://audio/<id> in Electron, same-origin /api/audio/<id> otherwise. */
export function audioUrl(audioId: string): string {
  const b = bridge()
  if (b && !isMockMode()) return b.engine.audioUrl(audioId)
  return `${baseUrl}/api/audio/${encodeURIComponent(audioId)}`
}

interface FetchResult<T> {
  data?: T
  error?: unknown
  response: Response
}

/** Resolve an openapi-fetch result to its data, or throw an EngineError. */
export async function unwrap<T>(pending: Promise<FetchResult<T>>): Promise<T> {
  let result: FetchResult<T>
  try {
    result = await pending
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new EngineError(0, null, `Could not reach the engine: ${(err as Error).message}`)
  }
  const { data, error, response } = result
  if (response.ok) return data as T
  const body = (error as { error?: ApiErrorBody } | undefined)?.error ?? null
  throw new EngineError(response.status, body)
}

const SETTLED: Job['state'][] = ['done', 'error', 'cancelled']

/** Polls GET /api/jobs/{id} until the job settles; resolves when done, throws its error otherwise. */
export async function waitJob(job: Job, onProgress?: (j: Job) => void, everyMs = 300): Promise<Job> {
  let j = job
  while (!SETTLED.includes(j.state)) {
    onProgress?.(j)
    await new Promise((r) => setTimeout(r, everyMs))
    j = await unwrap(api.GET('/api/jobs/{job_id}', { params: { path: { job_id: j.id } } }))
  }
  onProgress?.(j)
  if (j.state !== 'done') throw new EngineError(500, j.error ?? { code: j.state, message: `${j.kind} ${j.state}` })
  return j
}
