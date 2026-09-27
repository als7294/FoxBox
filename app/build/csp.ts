import type { Plugin } from 'vite'

/**
 * Injects the Content-Security-Policy meta tag. Production pages load from file://, where response
 * headers can't be set, so the policy has to live in the document. The renderer never talks to the
 * engine directly: JSON goes over IPC and audio over the vbx: scheme served by main. Styles allow
 * 'unsafe-inline' for the style attributes React sets (canvas sizes, transforms, drag offsets).
 */
export function contentSecurityPolicy(mode: 'build' | 'serve'): string {
  const dev = mode === 'serve'
  const directives: Record<string, string[]> = {
    'default-src': ["'none'"],
    // Dev only: the React Fast Refresh preamble is an inline module script.
    // 'wasm-unsafe-eval' lets WebAssembly compile (the camera clip's on-device face detector); it is not JS eval.
    'script-src': ["'self'", "'wasm-unsafe-eval'", ...(dev ? ["'unsafe-inline'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'media-src': ["'self'", 'blob:', 'data:', 'vbx:'],
    'connect-src': ["'self'", 'vbx:', ...(dev ? ['ws://localhost:*', 'http://localhost:*'] : [])],
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
  }
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ')
}

export function cspPlugin(): Plugin {
  let mode: 'build' | 'serve' = 'build'
  return {
    name: 'fvwks-csp',
    configResolved(config) {
      mode = config.command
    },
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy(mode) },
          injectTo: 'head-prepend',
        },
      ]
    },
  }
}
