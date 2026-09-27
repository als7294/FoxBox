import { setupWorker } from 'msw/browser'
import { handlers } from './handlers'

/** Starts MSW in the page (browser build and `npm run dev:mock`). */
export async function startMockWorker(): Promise<void> {
  const worker = setupWorker(...handlers)
  await worker.start({
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
    onUnhandledRequest: 'bypass',
    quiet: true,
  })
  console.info('[fvwks] MSW mock engine running')
}
