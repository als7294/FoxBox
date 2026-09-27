import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { creditEmail } from './build/credit'
import { cspPlugin } from './build/csp'
import pkg from './package.json'

const shared = { '@shared': resolve(__dirname, 'src/shared') }
const define = { __APP_VERSION__: JSON.stringify(pkg.version), __CREDIT_EMAIL__: JSON.stringify(creditEmail()) }

export default defineConfig({
  main: {
    resolve: { alias: shared },
    define,
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    resolve: { alias: shared },
    build: {
      // Sandboxed preloads must be a single CommonJS file.
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: { '@': resolve(__dirname, 'src/renderer/src'), ...shared } },
    plugins: [react(), cspPlugin()],
    define,
    // The MSW mocks serve the repo's fixture WAVs from ../fixtures.
    server: { fs: { allow: [resolve(__dirname, '..')] } },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
  },
})
