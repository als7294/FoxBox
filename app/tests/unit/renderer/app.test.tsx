// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, passthrough } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { App } from '../../../src/renderer/src/App'
import { handlers } from '../../../src/renderer/src/mocks/handlers'
import { mockEngine } from '../../../src/renderer/src/mocks/mockEngine'

// Smoke test of the whole renderer (mock mode: no bridge in jsdom, so MSW answers /api/*).
const server = setupServer(...handlers, http.all('*', () => passthrough()))
beforeAll(() => {
  mockEngine.latencyMs = 0
  server.listen({ onUnhandledRequest: 'bypass' })
})
afterEach(cleanup)
afterAll(() => server.close())

describe('App', () => {
  it('boots in mock mode, loads presets and the rack, and survives typing (no render loops)', async () => {
    render(<App />)
    expect(await screen.findByTestId('engine-status')).toHaveAttribute('data-state', 'mock')
    const presets = await screen.findByRole('radiogroup', { name: 'Presets' })
    await waitFor(() => expect(within(presets).getByRole('radio', { name: 'PACT' })).toHaveAttribute('aria-checked', 'true'))
    for (const macro of ['DEPTH', 'GRIT', 'MACHINE', 'SPACE']) expect(screen.getByRole('slider', { name: macro })).toBeInTheDocument()
    // AUTO bars (the v0.2 default) before any render: no NaN anywhere (S1 review).
    expect(screen.getByRole('radio', { name: 'AUTO' })).toHaveAttribute('aria-checked', 'true')
    expect(document.body.textContent).not.toMatch(/NaN/)

    const editor = screen.getByTestId('script-editor')
    fireEvent.focus(editor)
    fireEvent.change(editor, { target: { value: 'WE ARE GUY FVWKS | EXPECT *US' } })
    expect(screen.getByText('TYPING · KEYS PAUSED')).toBeInTheDocument()
    // The engine's script preview arrives (debounced): its warnings show (the spoken-text SAYS line is gone in 1.1).
    expect(await screen.findByText(/Unmatched/, {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.queryByLabelText('What the voice will say')).toBeNull()
  })

  it('navigates every screen', async () => {
    render(<App />)
    expect(await screen.findByTestId('engine-status')).toHaveAttribute('data-state', 'mock')
    const nav = screen.getByRole('navigation', { name: 'Screens' })
    for (const name of ['VAULT', 'SETLIST', 'VOICES', 'SETTINGS', 'STUDIO']) {
      fireEvent.click(within(nav).getByRole('button', { name }))
      if (name !== 'STUDIO') expect(await screen.findByRole('heading', { level: 1, name })).toBeInTheDocument()
    }
  })
})
