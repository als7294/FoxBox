import type { EngineMethod, FvwksBridge } from '@shared/bridge'

export type Transport = (request: Request) => Promise<Response>

const NULL_BODY_STATUS = new Set([101, 204, 205, 304])
let seq = 0

/**
 * fetch() over the preload bridge: the request is serialized, sent to main over IPC, and main calls
 * the engine with the bearer token. The renderer never learns the engine's port or token.
 */
export function ipcTransport(b: FvwksBridge): Transport {
  return async (request) => {
    const id = `r${Date.now().toString(36)}${(seq++).toString(36)}`
    const url = new URL(request.url)
    const method = request.method.toUpperCase() as EngineMethod
    const body = method === 'GET' || method === 'DELETE' ? null : await request.arrayBuffer()
    const headers: Record<string, string> = {}
    request.headers.forEach((v, k) => {
      headers[k] = v
    })
    if (request.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const onAbort = () => b.engine.abort(id)
    request.signal.addEventListener('abort', onAbort)
    try {
      const res = await b.engine.request({ id, method, path: url.pathname + url.search, headers, body })
      if (request.signal.aborted) throw new DOMException('Aborted', 'AbortError')
      return new Response(NULL_BODY_STATUS.has(res.status) ? null : res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      })
    } finally {
      request.signal.removeEventListener('abort', onAbort)
    }
  }
}

/** Plain fetch against the page's own origin, where MSW answers (browser build, mock mode, tests). */
export const webTransport: Transport = (request) => fetch(request)
