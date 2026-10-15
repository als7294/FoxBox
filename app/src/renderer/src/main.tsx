import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initOutputLink } from './visuals/live/output'
import { OutputWindow } from './visuals/live/OutputWindow'
import { isMockMode } from './env'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/foxbox-tokens.css'
import './styles/fb-motion.css'
import './styles/fb-base.css'
import './styles/base.css'
import './components/strings/strings-tokens.css'

async function boot() {
  const params = new URLSearchParams(window.location.search)
  // Mocks exist only in dev builds (npm run web / dev:mock); production drops the MSW chunk and fixtures.
  if (import.meta.env.DEV && isMockMode()) {
    const { startMockWorker } = await import('./mocks/browser')
    await startMockWorker()
    const { applyMockScenarios } = await import('./mocks/scenarios')
    applyMockScenarios(params)
  }
  // Main opens the output window (SEND TO OUTPUT) as index.html?window=output (same bundle, same preload).
  const which = params.get('window')
  initOutputLink()
  const root = which === 'output' ? <OutputWindow /> : <App />
  createRoot(document.getElementById('root')!).render(<StrictMode>{root}</StrictMode>)
}

void boot()
