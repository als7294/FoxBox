// Shared Vitest setup. Renderer component tests opt into jsdom with `// @vitest-environment jsdom`.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setFixtureLoader } from '../../src/renderer/src/mocks/fixtures'

// The MSW mock engine reads fixture WAVs through Vite URLs in the browser; in Node, read them from disk.
setFixtureLoader(async (name) => {
  const buf = await readFile(resolve(__dirname, '../../../fixtures/voices', name))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
})
import '@testing-library/jest-dom/vitest'

// jsdom has no matchMedia. Report prefers-reduced-motion so component tests get the instant, animation-free
// UI (no boot sequence, no screen wipe), as a user with Reduce Motion on would.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) =>
    ({
      matches: /prefers-reduced-motion:\s*reduce/.test(query),
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
}
