// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, passthrough } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { TOP_SLOT_ID } from '../../../src/renderer/src/components/layout/TopBar'
import { App } from '../../../src/renderer/src/App'
import { handlers } from '../../../src/renderer/src/mocks/handlers'
import { mockEngine } from '../../../src/renderer/src/mocks/mockEngine'
import { useStudio } from '../../../src/renderer/src/state/studio'
import { useUi } from '../../../src/renderer/src/state/ui'

// Smoke test of the whole renderer (mock mode: no bridge in jsdom, so MSW answers /api/*).
const server = setupServer(
  ...handlers,
  http.all('*', () => passthrough()),
)
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

  it('page-scoped keys: 3 on VISUALS applies preset 3 there and never leaves (mid-set, leaving froze the output)', async () => {
    render(<App />)
    expect(await screen.findByTestId('engine-status')).toHaveAttribute('data-state', 'mock')
    await screen.findByRole('radiogroup', { name: 'Presets' })
    const nav = screen.getByRole('navigation', { name: 'Screens' })
    fireEvent.click(within(nav).getByRole('button', { name: 'VISUALS' }))
    await waitFor(() => expect(useUi.getState().screen).toBe('live'))
    fireEvent.keyDown(window, { key: '3' })
    expect(useUi.getState().screen).toBe('live')
    await waitFor(() => expect(useStudio.getState().presetName).toBe('ABYSS'))
    // The Studio's own keys do nothing here (⌘S would open the Studio's save form).
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    expect(useUi.getState().screen).toBe('live')
    // Away and back: VISUALS stayed mounted, with its own header (1.5.2: a bare page, no top bar).
    fireEvent.click(within(nav).getByRole('button', { name: 'STUDIO' }))
    fireEvent.click(within(nav).getByRole('button', { name: 'VISUALS' }))
    await waitFor(() => expect(screen.getByTestId('visuals-source')).toBeInTheDocument())
    expect(document.getElementById(TOP_SLOT_ID)).toBeNull()
  })

  it('navigates every screen', async () => {
    render(<App />)
    expect(await screen.findByTestId('engine-status')).toHaveAttribute('data-state', 'mock')
    const nav = screen.getByRole('navigation', { name: 'Screens' })
    // REMIX (04, 1.5.2) is WIP: greyed out with the badge, and not reachable.
    const remix = within(nav).getByRole('button', { name: /^REMIX/ })
    expect(remix).toHaveAttribute('aria-disabled', 'true')
    expect(remix).toHaveTextContent('WIP')
    const before = useUi.getState().screen
    fireEvent.click(remix)
    expect(useUi.getState().screen).toBe(before)
    // PROD (06, 1.5.2): TouchDesigner, open, with the DEMO badge.
    const prod = within(nav).getByRole('button', { name: 'PROD, demo' })
    expect(prod).toHaveTextContent('DEMO')
    fireEvent.click(prod)
    expect(await screen.findByRole('heading', { level: 1, name: 'PROD · TOUCHDESIGNER' })).toBeInTheDocument()
    for (const name of ['VAULT', 'VOICES', 'SETTINGS', 'STUDIO']) {
      fireEvent.click(within(nav).getByRole('button', { name }))
      if (name !== 'STUDIO') expect(await screen.findByRole('heading', { level: 1, name })).toBeInTheDocument()
    }
  })
})
