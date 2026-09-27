import type { EngineMethod, EngineRequest, EngineResponse } from '../shared/bridge'

const METHODS = new Set<EngineMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
/** Request headers the renderer may set; everything else (Authorization, Host, Cookie, …) is dropped. */
const REQUEST_HEADERS = new Set(['content-type', 'accept', 'if-none-match', 'if-match'])
const RESPONSE_HEADERS = ['content-type', 'content-length', 'etag', 'content-disposition', 'retry-after']
const MAX_BODY = 256 * 1024 * 1024

/** Validates an untrusted request from the renderer. Paths must stay under /api/. */
export function parseEngineRequest(raw: unknown): { request: EngineRequest } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'request must be an object' }
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > 100) return { error: 'bad id' }
  if (typeof r.method !== 'string' || !METHODS.has(r.method as EngineMethod)) return { error: 'bad method' }
  const path = r.path
  if (typeof path !== 'string' || !path.startsWith('/api/') || path.length > 8192) return { error: 'path must start with /api/' }
  let parsed: URL
  try {
    parsed = new URL(path, 'http://engine.invalid')
  } catch {
    return { error: 'bad path' }
  }
  if (parsed.host !== 'engine.invalid' || !parsed.pathname.startsWith('/api/') || /\/\.\.?(\/|$)|\\/.test(path)) {
    return { error: 'bad path' }
  }
  const headers: Record<string, string> = {}
  if (r.headers && typeof r.headers === 'object') {
    for (const [k, v] of Object.entries(r.headers as Record<string, unknown>)) {
      const key = k.toLowerCase()
      if (REQUEST_HEADERS.has(key) && typeof v === 'string' && v.length < 1024 && !/[\r\n]/.test(v)) headers[key] = v
    }
  }
  let body: ArrayBuffer | null = null
  if (r.body != null) {
    if (!(r.body instanceof ArrayBuffer) && !ArrayBuffer.isView(r.body)) return { error: 'body must be binary' }
    const view = ArrayBuffer.isView(r.body) ? r.body : new Uint8Array(r.body)
    if (view.byteLength > MAX_BODY) return { error: 'body too large' }
    body = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice().buffer
  }
  if (body && (r.method === 'GET' || r.method === 'DELETE')) body = null
  const timeoutMs =
    typeof r.timeoutMs === 'number' && Number.isFinite(r.timeoutMs) ? Math.min(Math.max(r.timeoutMs, 1_000), 30 * 60_000) : undefined
  return {
    request: {
      id: r.id,
      method: r.method as EngineMethod,
      path: parsed.pathname + parsed.search,
      headers,
      body,
      ...(timeoutMs ? { timeoutMs } : {}),
    },
  }
}

export function pickHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  for (const h of RESPONSE_HEADERS) {
    const v = headers.get(h)
    if (v) out[h] = v
  }
  return out
}

/** A response in the engine's own error shape ({error: {code, message, hint, retryable}}). */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  hint: string | null = null,
  retryable = false,
): EngineResponse {
  const body = new TextEncoder().encode(JSON.stringify({ error: { code, message, hint, retryable } }))
  return {
    status,
    statusText: code,
    headers: { 'content-type': 'application/json' },
    body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  }
}
