// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, passthrough } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { App } from '../../../src/renderer/src/App'
import { handlers } from '../../../src/renderer/src/mocks/handlers'
import { useUi } from '../../../src/renderer/src/state/ui'

// Smoke test of the whole renderer (mock mode: no bridge in jsdom, so MSW answers /api/*).
const server = setupServer(
  ...handlers,
  http.all('*', () => passthrough()),
)
const requested: string[] = []
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' })
  server.events.on('request:start', ({ request }) => void requested.push(new URL(request.url).pathname))
})
afterEach(cleanup)
afterAll(() => server.close())

describe('App (2.0: SAUCE and REMIX, the design shell)', () => {
  it('opens on SAUCE, which never asks for a song; ⌘, opens settings, Esc closes it; M goes to REMIX', async () => {
    useUi.setState({ booting: false })
    render(<App />)
    expect(await screen.findByRole('navigation', { name: 'SAUCE' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: ',', metaKey: true })
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(useUi.getState().settingsOpen).toBe(false))
    await new Promise((r) => setTimeout(r, 300)) // anything PLAY would fetch at start
    expect(requested.filter((p) => p.startsWith('/api/songs'))).toEqual([])
    fireEvent.keyDown(window, { key: 'm' })
    expect(await screen.findByRole('navigation', { name: 'REMIX' })).toBeInTheDocument()
    expect(useUi.getState().mode).toBe('remix')
  })
})
