import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { isMockMode } from './env'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/base.css'

async function boot() {
  // Mocks exist only in dev builds (npm run web / dev:mock); production drops the MSW chunk and fixtures.
  if (import.meta.env.DEV && isMockMode()) {
    const { startMockWorker } = await import('./mocks/browser')
    await startMockWorker()
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void boot()
