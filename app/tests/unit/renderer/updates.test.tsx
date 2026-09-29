// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateState, UpdatesBridge } from '../../../src/shared/bridge'
import { DEFAULT_FEED_URL } from '../../../src/shared/updates'
import { agoText, clockText, errorText, failureDetail, rateText, transferText } from '../../../src/renderer/src/components/updates/format'
import { UpdateBanner } from '../../../src/renderer/src/components/updates/UpdateBanner'
import { UpdatesCard } from '../../../src/renderer/src/screens/SettingsScreen'
import { useUi } from '../../../src/renderer/src/state/ui'

// The update bar and SETTINGS → UPDATES against a fake `window.fvwks.updates` (main's Updater is tested in main).

function stateOf(patch: Partial<UpdateState> = {}): UpdateState {
  return {
    phase: 'idle',
    current: '1.0.0',
    latest: null,
    sizeBytes: null,
    released: null,
    notes: [],
    download: null,
    error: null,
    feedUrl: DEFAULT_FEED_URL,
    feedIsDefault: true,
    defaultFeedUrl: DEFAULT_FEED_URL,
    hasToken: false,
    lastChecked: null,
    allowLocalFeed: false,
    installBlocked: null,
    whatsNew: null,
    ...patch,
  }
}

/** A stand-in for main's Updater: every call answers with the current state; `push` is main broadcasting a change. */
function fakeUpdates(initial: Partial<UpdateState> = {}) {
  let state = stateOf(initial)
  const listeners = new Set<(s: UpdateState) => void>()
  const set = (patch: Partial<UpdateState>): UpdateState => {
    state = { ...state, ...patch }
    for (const l of listeners) l(state)
    return state
  }
  const current = async (): Promise<UpdateState> => state
  const api = {
    getState: vi.fn(current),
    check: vi.fn(current),
    download: vi.fn(current),
    cancel: vi.fn(current),
    install: vi.fn(current),
    setFeedUrl: vi.fn(async (_url: string | null) => state),
    setToken: vi.fn(async (_token: string | null) => state),
    dismissWhatsNew: vi.fn(current),
    onState: vi.fn((listener: (s: UpdateState) => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    }),
  } satisfies UpdatesBridge
  Object.assign(window, { fvwks: { updates: api } })
  return { api, set, push: (patch: Partial<UpdateState>) => act(() => void set(patch)) }
}

/** Renders and lets the first getState() answer land. */
async function show(ui: ReactElement) {
  render(ui)
  await act(async () => {})
}

const bar = () => screen.queryByTestId('update-banner')

afterEach(() => {
  cleanup()
  delete (window as { fvwks?: unknown }).fvwks
  useUi.setState({ dismissed: {} })
})

describe('update text', () => {
  it('formats sizes, speed, time left and ages', () => {
    expect(transferText(128_400_000, 327_000_000)).toBe('128 of 327 MB')
    expect(transferText(1_250_000, 4_000_000)).toBe('1.2 of 4.0 MB')
    expect(rateText(18_400_000)).toBe('18.4 MB/s')
    expect(rateText(640_000)).toBe('640 KB/s')
    expect(clockText(11)).toBe('0:11')
    expect(clockText(725)).toBe('12:05')
    expect(clockText(3729)).toBe('1:02:09')
    const now = 1_800_000_000_000
    expect(agoText(null, now)).toBe('never')
    expect(agoText(now - 20_000, now)).toBe('just now')
    expect(agoText(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(agoText(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(agoText(now - 2 * 86_400_000, now)).toBe('2 days ago')
  })

  it("strips Electron's IPC wrapper and main's repeated prefix", () => {
    expect(errorText(new Error("Error invoking remote method 'fvwks:updates-set-token': UpdateError: Not a token."))).toBe('Not a token.')
    expect(errorText(new Error('Refused.'))).toBe('Refused.')
    expect(errorText(undefined)).toBe('Something went wrong.')
    expect(failureDetail('Update failed, still on v1.0.0. The folder is read-only.')).toBe('The folder is read-only.')
    expect(failureDetail('The download stalled (no data for a minute).')).toBe('The download stalled (no data for a minute).')
  })
})

describe('UpdateBanner', () => {
  it('renders nothing without the bridge (browser build)', async () => {
    await show(<UpdateBanner />)
    expect(bar()).toBeNull()
  })

  it('stays quiet while idle, checking, up to date, and when a check failed', async () => {
    const { api, push } = fakeUpdates()
    await show(<UpdateBanner />)
    expect(api.getState).toHaveBeenCalled()
    expect(bar()).toBeNull()
    push({ phase: 'checking' })
    expect(bar()).toBeNull()
    push({ phase: 'up-to-date', lastChecked: Date.now() })
    expect(bar()).toBeNull()
    push({ phase: 'error', error: { during: 'check', code: 'network', message: "Couldn't reach the update server." } })
    expect(bar()).toBeNull()
  })

  it('offers an available version: Update downloads it, Later hides it until a newer one', async () => {
    const { api, push } = fakeUpdates({ phase: 'available', latest: '1.0.1', sizeBytes: 240_000_000 })
    await show(<UpdateBanner />)
    expect(screen.getByRole('status')).toHaveTextContent('FoxBox 1.0.1 available · 240 MB')
    fireEvent.click(screen.getByRole('button', { name: 'Update to FoxBox 1.0.1' }))
    expect(api.download).toHaveBeenCalledTimes(1)
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', { name: 'Remind me later' }))
    expect(bar()).toBeNull()
    push({ phase: 'checking' })
    push({ phase: 'available' })
    expect(bar()).toBeNull()
    push({ latest: '1.0.2' })
    expect(screen.getByRole('status')).toHaveTextContent('FoxBox 1.0.2 available')
  })

  it('shows download progress ("starting…" until the speed is known) and cancels', async () => {
    const download = { bytes_done: 0, bytes_total: 327_000_000, rate_bps: null, eta_s: null }
    const { api, push } = fakeUpdates({ phase: 'downloading', latest: '1.0.1', sizeBytes: 327_000_000, download })
    await show(<UpdateBanner />)
    expect(bar()).toHaveTextContent('Downloading 1.0.1 · 0 of 327 MB · starting…')
    expect(bar()).not.toHaveTextContent('MB/s')
    expect(screen.getByRole('status')).toHaveTextContent(/^Downloading 1\.0\.1$/)

    push({ download: { bytes_done: 128_400_000, bytes_total: 327_000_000, rate_bps: 18_400_000, eta_s: 11 } })
    expect(bar()).toHaveTextContent('Downloading 1.0.1 · 128 of 327 MB · 18.4 MB/s · 0:11 left')
    expect(screen.getByRole('progressbar', { name: 'Update download' })).toHaveAttribute('aria-valuenow', '39')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel download' }))
    expect(api.cancel).toHaveBeenCalledTimes(1)
    await act(async () => {})
  })

  it('verifies, then offers the restart, which asks main to install', async () => {
    const { api, push } = fakeUpdates({ phase: 'verifying', latest: '1.0.1' })
    await show(<UpdateBanner />)
    expect(screen.getByRole('status')).toHaveTextContent('Verifying 1.0.1…')
    expect(screen.queryByRole('button')).toBeNull()

    push({ phase: 'ready' })
    expect(screen.getByRole('status')).toHaveTextContent('FoxBox 1.0.1 is ready')
    fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }))
    expect(api.install).toHaveBeenCalledTimes(1)
    await act(async () => {})

    push({ phase: 'installing' })
    expect(screen.getByRole('status')).toHaveTextContent('Restarting…')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it("says why this copy can't install instead of offering the restart", async () => {
    fakeUpdates({ phase: 'ready', latest: '1.0.1', installBlocked: 'Move FoxBox to your Applications folder, open it from there, then update.' })
    await show(<UpdateBanner />)
    expect(screen.getByRole('status')).toHaveTextContent('FoxBox 1.0.1 is ready · Move FoxBox to your Applications folder')
    expect(screen.queryByRole('button', { name: 'Restart to update' })).toBeNull()
  })

  it('reports a failed download with Retry, which downloads again', async () => {
    const { api, push } = fakeUpdates({
      phase: 'error',
      latest: '1.0.1',
      error: { during: 'download', code: 'timeout', message: 'The download stalled (no data for a minute).' },
    })
    await show(<UpdateBanner />)
    expect(screen.getByRole('status')).toHaveTextContent('Update failed, still on v1.0.0 · The download stalled (no data for a minute).')
    fireEvent.click(screen.getByRole('button', { name: 'Retry update' }))
    expect(api.download).toHaveBeenCalledTimes(1)
    await act(async () => {})

    // Install failures carry main's own "Update failed, still on vX." prefix: said once.
    push({ error: { during: 'install', code: 'install_failed', message: 'Update failed, still on v1.0.0. The folder is read-only.' } })
    expect(screen.getByRole('status')).toHaveTextContent(/^Update failed, still on v1\.0\.0 · The folder is read-only\.$/)
  })

  it('offers no Retry when there is nothing to download again (a rolled-back update)', async () => {
    fakeUpdates({
      phase: 'error',
      error: { during: 'install', code: 'rolled_back', message: "The update to v1.0.1 didn't start properly, so FoxBox went back to v1.0.0." },
    })
    await show(<UpdateBanner />)
    expect(screen.getByRole('status')).toHaveTextContent("Update failed, still on v1.0.0 · The update to v1.0.1 didn't start properly")
    expect(screen.queryByRole('button', { name: 'Retry update' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remind me later' }))
    expect(bar()).toBeNull()
  })
})

describe('SETTINGS → UPDATES', () => {
  const card = () => screen.getByRole('region', { name: 'Updates' })

  it('is hidden without the bridge (browser build)', async () => {
    await show(<UpdatesCard />)
    expect(screen.queryByRole('region', { name: 'Updates' })).toBeNull()
  })

  it('shows the version and the last check; Check now reports up to date, a new version, or the check error', async () => {
    const { api, set } = fakeUpdates({ lastChecked: Date.now() - 5 * 60_000 })
    await show(<UpdatesCard />)
    expect(card()).toHaveTextContent('v1.0.0')
    expect(card()).toHaveTextContent('Last checked: 5 min ago')
    const check = screen.getByRole('button', { name: 'Check now' })

    api.check.mockImplementationOnce(async () => set({ phase: 'up-to-date', lastChecked: Date.now() }))
    fireEvent.click(check)
    expect(await screen.findByText('Up to date')).toBeInTheDocument()
    expect(card()).toHaveTextContent('Last checked: just now')

    api.check.mockImplementationOnce(async () => set({ phase: 'available', latest: '1.0.1', sizeBytes: 240_000_000 }))
    fireEvent.click(check)
    expect(await screen.findByText('1.0.1 available')).toBeInTheDocument()

    api.check.mockImplementationOnce(async () =>
      set({ phase: 'error', latest: null, error: { during: 'check', code: 'http_error', message: "Couldn't reach the update server. GitHub answered 404." } }),
    )
    fireEvent.click(check)
    expect(await screen.findByText("Couldn't reach the update server. GitHub answered 404.")).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't reach the update server.")
    expect(api.check).toHaveBeenCalledTimes(3)
  })

  it('says "never" before the first check, and Check now brings back a bar hidden with Later', async () => {
    const { api, set } = fakeUpdates({ phase: 'available', latest: '1.0.1' })
    await show(
      <>
        <UpdateBanner />
        <UpdatesCard />
      </>,
    )
    expect(card()).toHaveTextContent('Last checked: never')
    fireEvent.click(screen.getByRole('button', { name: 'Remind me later' }))
    expect(bar()).toBeNull()
    api.check.mockImplementationOnce(async () => set({ phase: 'available', lastChecked: Date.now() }))
    fireEvent.click(within(card()).getByRole('button', { name: 'Check now' }))
    await act(async () => {})
    expect(bar()).toHaveTextContent('FoxBox 1.0.1 available')
  })

  it('names the default source, shows a custom feed, and Use default goes back to it', async () => {
    const custom = 'https://updates.example.test/foxbox/latest-mac.json'
    const { api, push, set } = fakeUpdates()
    await show(<UpdatesCard />)
    expect(card()).toHaveTextContent('GitHub releases (default)')
    expect(screen.queryByRole('button', { name: 'Use default' })).toBeNull()

    push({ feedUrl: custom, feedIsDefault: false })
    expect(card()).toHaveTextContent(custom)
    api.setFeedUrl.mockImplementationOnce(async () => set({ feedUrl: DEFAULT_FEED_URL, feedIsDefault: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Use default' }))
    expect(api.setFeedUrl).toHaveBeenCalledWith(null)
    expect(await screen.findByText('GitHub releases (default)')).toBeInTheDocument()
    expect(card()).not.toHaveTextContent(custom)
  })

  it("saves a token (then shows only that one is saved), removes it, and shows main's rejection", async () => {
    const { api, set } = fakeUpdates()
    await show(<UpdatesCard />)
    const field = screen.getByLabelText('GitHub token (private repo)')
    expect(field).toHaveAttribute('type', 'password')
    expect(screen.getByRole('button', { name: 'Save GitHub token' })).toBeDisabled()

    api.setToken.mockRejectedValueOnce(
      new Error("Error invoking remote method 'fvwks:updates-set-token': UpdateError: That doesn't look like a GitHub token (ghp_… or github_pat_…)."),
    )
    fireEvent.change(field, { target: { value: 'not-a-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save GitHub token' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("That doesn't look like a GitHub token (ghp_… or github_pat_…).")
    expect(api.setToken).toHaveBeenLastCalledWith('not-a-token')

    const good = `ghp_${'a'.repeat(36)}`
    api.setToken.mockImplementationOnce(async () => set({ hasToken: true }))
    fireEvent.change(field, { target: { value: ` ${good} ` } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.submit(field.closest('form')!)
    expect(await screen.findByText('Token saved')).toBeInTheDocument()
    expect(api.setToken).toHaveBeenLastCalledWith(good)
    expect(screen.queryByLabelText('GitHub token (private repo)')).toBeNull()
    expect(document.body.innerHTML).not.toContain(good)

    api.setToken.mockImplementationOnce(async () => set({ hasToken: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove GitHub token' }))
    expect(api.setToken).toHaveBeenLastCalledWith(null)
    expect(await screen.findByLabelText('GitHub token (private repo)')).toHaveValue('')
    expect(screen.queryByText('Token saved')).toBeNull()
  })
})
