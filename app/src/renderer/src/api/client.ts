import createClient from 'openapi-fetch'
import { bridge, isMockMode } from '@/env'
import type { paths } from './schema'
import { ipcTransport, webTransport, type Transport } from './transport'
import type { ApiErrorBody } from './types'

/** Engine error with the engine's own {code, message, hint, retryable}. */
export class EngineError extends Error {
  readonly code: string
  readonly hint: string | null
  readonly retryable: boolean
  readonly status: number

  constructor(status: number, body: Partial<ApiErrorBody> | null, fallback?: string) {
    super(body?.message ?? fallback ?? `Engine error ${status}`)
    this.name = 'EngineError'
    this.status = status
    this.code = body?.code ?? (status === 0 ? 'network' : `http_${status}`)
    this.hint = body?.hint ?? null
    this.retryable = body?.retryable ?? status >= 500
  }
}

export function isAbort(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') || (err instanceof EngineError && err.code === 'aborted')
  )
}

function pickTransport(): { baseUrl: string; transport: Transport } {
  const b = bridge()
  if (b && !isMockMode()) return { baseUrl: 'http://engine.ipc', transport: ipcTransport(b) }
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
  return { baseUrl: origin, transport: webTransport }
}

const { baseUrl, transport } = pickTransport()

export const api = createClient<paths>({ baseUrl, fetch: transport })

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
