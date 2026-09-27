// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SetupWindow } from '../../../src/renderer/src/components/setup/SetupWindow'
import { handlers } from '../../../src/renderer/src/mocks/handlers'
import { mockEngine } from '../../../src/renderer/src/mocks/mockEngine'

// The Setup window against the MSW mock engine (no bridge in jsdom: mock mode), with fast simulated downloads.
const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
beforeEach(() => {
  window.localStorage.clear()
  Object.assign(mockEngine.installer, { capSeconds: 0.25, minSeconds: 0.1, verifyMs: 40, tickMs: 20 })
})
afterEach(() => {
  cleanup()
  mockEngine.installer.reset()
})
afterAll(() => server.close())

describe('SetupWindow (first run, mock engine)', () => {
  it('walks welcome → components → install → ready, with the required parts locked and the reserve counted once', async () => {
    mockEngine.installer.simulateFirstRun('fresh')
    Object.assign(mockEngine.installer, { capSeconds: 0.25, minSeconds: 0.1, verifyMs: 40, tickMs: 20 })
    render(<SetupWindow />)
    expect(screen.getByText(/macOS 14 or later on Apple silicon/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Designed by SmittyTech/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))

    const required = await screen.findByRole('region', { name: 'Required components' }, { timeout: 5000 })
    expect(within(required).getByRole('checkbox', { name: /Kokoro voices/ })).toBeDisabled()
    expect(within(required).getByRole('checkbox', { name: /Kokoro voices/ })).toBeChecked()
    const optional = screen.getByRole('region', { name: 'Optional components' })
    const transcripts = within(optional).getByRole('checkbox', { name: /Transcripts/ })
    expect(transcripts).not.toBeChecked() // default_selected false in the engine's list
    fireEvent.click(transcripts)
    expect(screen.getByText(/5\.0 GB kept free/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Install/ }))
    expect(await screen.findByRole('progressbar', { name: 'Overall progress' })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Components' })).toHaveTextContent(/Transcripts for recordings/)
    expect(await screen.findByRole('button', { name: 'Open studio' }, { timeout: 15_000 })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Installed components' })).not.toHaveTextContent(/not installed/)
    expect(mockEngine.models().every((m) => m.installed || m.id === 'qwen3-tts-voicedesign')).toBe(true)
  })

  it('shows a network failure with Retry, which resumes', async () => {
    mockEngine.installer.simulateFirstRun('network')
    // Slow enough that the failure (at 60 %) comes after INSTALL attached to the download.
    Object.assign(mockEngine.installer, { capSeconds: 3, minSeconds: 3, verifyMs: 40, tickMs: 20 })
    render(<SetupWindow />)
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^Install/ })).toBeEnabled(), { timeout: 5000 })
    fireEvent.click(screen.getByRole('button', { name: /^Install/ }))
    expect(await screen.findByText('Network lost', { exact: false }, { timeout: 10_000 })).toBeInTheDocument()
    const partial = mockEngine.models().find((m) => m.id === 'kokoro-82m')!
    expect(partial.install_needs_bytes! - 5e9).toBeLessThan(partial.size_bytes) // what's there stays
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]!)
    await waitFor(() => expect(screen.queryByText('Network lost', { exact: false })).toBeNull(), { timeout: 10_000 })
    expect(await screen.findByRole('button', { name: 'Open studio' }, { timeout: 15_000 })).toBeInTheDocument()
  })

  it('blocks INSTALL when the disk is short, and lets an optional component go', async () => {
    mockEngine.installer.simulateFirstRun('disk')
    render(<SetupWindow />)
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    const persona = await screen.findByRole('checkbox', { name: /Persona designer/ }, { timeout: 5000 })
    fireEvent.click(persona)
    expect(await screen.findByRole('alert')).toHaveTextContent(/free\. Free up .* or untick an optional component/)
    expect(screen.getByRole('button', { name: /^Install/ })).toBeDisabled()
    fireEvent.click(persona)
    await waitFor(() => expect(screen.getByRole('button', { name: /^Install/ })).toBeEnabled())
  })
})
