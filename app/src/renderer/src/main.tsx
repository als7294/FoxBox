import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { SetupWindow } from './components/setup/SetupWindow'
import { initOutputLink } from './visuals/live/output'
import { OutputWindow } from './visuals/live/OutputWindow'
import './visuals/live/families'
import { isMockMode } from './env'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/base.css'

async function boot() {
  const params = new URLSearchParams(window.location.search)
  // Mocks exist only in dev builds (npm run web / dev:mock); production drops the MSW chunk and fixtures.
  if (import.meta.env.DEV && isMockMode()) {
    const { startMockWorker } = await import('./mocks/browser')
    await startMockWorker()
    const { applyMockScenarios } = await import('./mocks/scenarios')
    applyMockScenarios(params)
  }
  // Main opens the first-run Setup window as index.html?window=setup and the visuals output (1.3) as ?window=output
  // (same bundle, same preload).
  const which = params.get('window')
  initOutputLink()
  const root = which === 'setup' ? <SetupWindow /> : which === 'output' ? <OutputWindow /> : <App />
  createRoot(document.getElementById('root')!).render(<StrictMode>{root}</StrictMode>)
}

void boot()
