// Renderer only, in a normal browser, with MSW mocks instead of the engine: `npm run web`.
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { creditEmail } from './build/credit'
import { cspPlugin } from './build/csp'
import pkg from './package.json'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: {
    alias: { '@': resolve(__dirname, 'src/renderer/src'), '@shared': resolve(__dirname, 'src/shared') },
    // One copy of each: REMIX's lazy chunk (waveform-playlist + Tone) found late made a second React (S5 R16).
    dedupe: ['react', 'react-dom', 'tone'],
  },
  // Pre-bundled up front, so the first REMIX visit doesn't re-optimise mid-session (504 Outdated Optimize Dep).
  optimizeDeps: { include: ['@waveform-playlist/browser', '@waveform-playlist/playout', 'tone'] },
  plugins: [react(), cspPlugin()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __CREDIT_EMAIL__: JSON.stringify(creditEmail()) },
  server: { port: 5199, strictPort: false, fs: { allow: [resolve(__dirname, '..')] } },
})
