// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, passthrough } from 'msw'
import { setupServer } from 'msw/node'
import type { ReactNode } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { handlers } from '../../../src/renderer/src/mocks/handlers'
import { mockEngine } from '../../../src/renderer/src/mocks/mockEngine'
import { SetlistScreen } from '../../../src/renderer/src/screens/SetlistScreen'
import { VaultScreen } from '../../../src/renderer/src/screens/VaultScreen'
import { useSetlist, type LineResult } from '../../../src/renderer/src/state/setlist'
import { useToasts } from '../../../src/renderer/src/state/toasts'
import { useUi } from '../../../src/renderer/src/state/ui'

// SETLIST and VAULT against the MSW mock engine (no bridge in jsdom = mock mode). Lines containing FAIL fail.
const server = setupServer(...handlers, http.all('*', () => passthrough()))
beforeAll(() => {
  mockEngine.latencyMs = 0
  server.listen({ onUnhandledRequest: 'bypass' })
  // jsdom has no media playback.
  window.HTMLMediaElement.prototype.play = () => Promise.resolve()
  window.HTMLMediaElement.prototype.pause = () => {}
})
beforeEach(() => {
  useSetlist.getState().clear()
  useUi.getState().setModal(null)
})
afterEach(cleanup)
afterAll(() => server.close())

function mount(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

const result = (state: LineResult['state'], ids: string[] = []): LineResult => ({ state, progress: state === 'done' ? 1 : 0.3, error: null, result_ids: ids })

describe('setlist store', () => {
  it('re-queues a line only when a render input changes, and keeps other lines across partial batches', () => {
    const st = useSetlist.getState()
    expect(st.addMany('ONE\n\n  TWO  \nTHREE\n')).toBe(3)
    const [a, b, c] = useSetlist.getState().lines
    st.startJob('job-1', [a!.id, b!.id, c!.id], 'Drops', 1)
    st.mergeResults({ [a!.id]: result('done', ['x1']), [b!.id]: result('error'), [c!.id]: result('done', ['x3']) })
    st.update(c!.id, { title: 'renamed' })
    expect(useSetlist.getState().results[c!.id]?.state).toBe('done')
    st.update(c!.id, { presetId: 'legion' })
    expect(useSetlist.getState().results[c!.id]).toBeUndefined()

    st.startJob('job-2', [b!.id], null, 1)
    expect(useSetlist.getState().results[a!.id]?.state).toBe('done')
    expect(useSetlist.getState().results[b!.id]?.state).toBe('queued')
    st.loseJob('Engine restarted, render again')
    const s = useSetlist.getState()
    expect(s.jobId).toBeNull()
    expect(s.results[b!.id]).toMatchObject({ state: 'error', error: { message: 'Engine restarted, render again' } })
    expect(s.results[a!.id]?.state).toBe('done')
  })

  it('reorders lines', () => {
    const st = useSetlist.getState()
    st.addMany('A\nB\nC\nD')
    const ids = () => useSetlist.getState().lines.map((l) => l.script).join('')
    st.moveTo(useSetlist.getState().lines[0]!.id, 2)
    expect(ids()).toBe('BCAD')
    st.move(useSetlist.getState().lines[3]!.id, -1)
    expect(ids()).toBe('BCDA')
    st.move(useSetlist.getState().lines[0]!.id, -1)
    expect(ids()).toBe('BCDA')
  })
})

describe('SetlistScreen', () => {
  it('pastes lines, renders them as one batch, shows DONE / FAILED, and retries after an edit', async () => {
    mount(<SetlistScreen />)
    expect(screen.getByRole('heading', { level: 1, name: 'SETLIST' })).toBeInTheDocument()
    // An empty setlist opens the paste panel.
    expect(screen.getByRole('button', { name: '+ PASTE MANY' })).toHaveAttribute('aria-expanded', 'true')
    fireEvent.change(screen.getByLabelText('Paste lines'), { target: { value: 'WE ARE GUY FVWKS | EXPECT *US*\nTHIS LINE WILL FAIL\nTHE SIGNAL NEVER DIES' } })
    fireEvent.click(screen.getByRole('button', { name: 'ADD LINES' }))
    const table = screen.getByRole('table', { name: 'Setlist' })
    expect(within(table).getAllByRole('row')).toHaveLength(4)
    expect(screen.getByTestId('setlist-summary')).toHaveTextContent('3 LINES · 0 DONE')
    expect(within(table).getAllByText('QUEUED')).toHaveLength(3)
    // Blank cells follow the Studio (top bar): the pickers show those values.
    await waitFor(() => expect(within(table).getByLabelText('Line 1 preset')).toHaveDisplayValue('PACT'))
    expect(within(table).getByLabelText('Line 1 bars')).toHaveDisplayValue('AUTO') // the Studio's default bars (v0.2)

    fireEvent.change(screen.getByLabelText('PLAYLIST NAME'), { target: { value: 'Unit Drops' } })
    fireEvent.click(screen.getByTestId('render-all'))
    await waitFor(() => expect(screen.getByTestId('setlist-summary')).toHaveTextContent('3 LINES · 2 DONE · 1 FAILED'), { timeout: 20_000 })
    await waitFor(() => expect(screen.getByTestId('render-all')).toHaveTextContent('RENDER ALL'))
    expect(screen.getByText('▲ PARTIAL — FAILED LINES ARE SKIPPED IN EXPORT')).toBeInTheDocument()
    expect(screen.getByText(/▲ TTS failed for this line/)).toBeInTheDocument()
    expect(within(table).getAllByText('DONE')).toHaveLength(2)
    expect(within(table).getByText('FAILED')).toBeInTheDocument()

    // The full run wrote the playlist's XML next to its files: EXPORT FOLDER + XML shows it without rewriting.
    fireEvent.click(screen.getByRole('button', { name: 'EXPORT FOLDER + XML' }))
    await waitFor(() => expect(useUi.getState().modal?.title).toBe('FOLDER + REKORDBOX XML EXPORTED'))
    expect(useUi.getState().modal).toMatchObject({ body: expect.stringContaining('2 files'), revealPath: expect.stringMatching(/unit-drops_rekordbox\.xml$/) })
    useUi.getState().setModal(null)

    // RETRY re-renders only that line (it still fails).
    fireEvent.click(within(table).getByRole('button', { name: 'Retry line 2' }))
    await waitFor(() => expect(useToasts.getState().items.at(-1)?.message).toBe('SETLIST FAILED'), { timeout: 20_000 })
    expect(screen.getByTestId('setlist-summary')).toHaveTextContent('3 LINES · 2 DONE · 1 FAILED')

    // Editing a line re-queues it; RENDER ALL then renders just the lines that aren't DONE. The XML is rebuilt.
    const script = within(table).getByLabelText('Line 2 script')
    fireEvent.change(script, { target: { value: 'THIS LINE WILL LAND' } })
    fireEvent.blur(script)
    expect(screen.getByTestId('setlist-summary')).toHaveTextContent('3 LINES · 2 DONE')
    await waitFor(() => expect(screen.getByTestId('render-all')).toHaveTextContent('RENDER ALL'))
    fireEvent.click(screen.getByTestId('render-all'))
    await waitFor(() => expect(screen.getByTestId('setlist-summary')).toHaveTextContent('3 LINES · 3 DONE'), { timeout: 20_000 })
    await waitFor(() => expect(screen.getByTestId('render-all')).toHaveTextContent('RENDER ALL'))
    fireEvent.click(screen.getByRole('button', { name: 'EXPORT FOLDER + XML' }))
    await waitFor(() => expect(useUi.getState().modal?.body).toContain('3 files'))
  }, 60_000)
})

describe('VaultScreen', () => {
  it('lists takes under redaction bars, filters, selects all and exports a Rekordbox playlist', async () => {
    mount(<VaultScreen />)
    expect(screen.getByRole('heading', { level: 1, name: 'VAULT' })).toBeInTheDocument()
    const table = screen.getByRole('table', { name: 'Vault' })
    await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(3))
    const takes = within(table).getAllByRole('row').length - 1
    expect(screen.getByText(`${takes} OF ${takes} TRANSMISSIONS`)).toBeInTheDocument()

    // Play / stop a row.
    fireEvent.click(within(table).getAllByRole('button', { name: /^Play / })[0]!)
    expect(within(table).getByRole('button', { name: /^Stop / })).toBeInTheDocument()
    fireEvent.click(within(table).getByRole('button', { name: /^Stop / }))
    expect(within(table).queryByRole('button', { name: /^Stop / })).toBeNull()

    // Search narrows the rows (debounced, server-side).
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search scripts' }), { target: { value: 'never dies' } })
    await waitFor(() => expect(screen.getByText(`1 OF ${takes} TRANSMISSIONS`)).toBeInTheDocument())
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search scripts' }), { target: { value: 'zzz-nothing' } })
    expect(await screen.findByText('NO TRANSMISSIONS MATCH')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search scripts' }), { target: { value: '' } })
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(takes + 1))

    // Filter chips: ★ STARRED after starring one take.
    const star = within(table).getAllByRole('button', { name: /^Star / })[0]!
    fireEvent.click(star)
    await waitFor(() => expect(star).toHaveAttribute('aria-pressed', 'true'))
    fireEvent.click(screen.getByRole('button', { name: '★ STARRED' }))
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'ALL' }))
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(takes + 1))

    // Select all → the selection bar → EXPORT TO REKORDBOX PLAYLIST → the ✓ WRITTEN steps.
    fireEvent.click(within(table).getByLabelText('Select all'))
    const bar = screen.getByRole('group', { name: 'Selected takes' })
    expect(bar).toHaveTextContent(`${takes} SELECTED`)
    fireEvent.click(within(bar).getByRole('button', { name: 'EXPORT TO REKORDBOX PLAYLIST' }))
    await waitFor(() => expect(useUi.getState().modal?.title).toBe('REKORDBOX XML EXPORTED'))
    expect(useUi.getState().modal?.body).toContain(`${takes} tracks`)
    expect(useUi.getState().modal?.revealPath).toMatch(/_rekordbox\.xml$/)

    // DELETE asks for a second click.
    fireEvent.click(within(bar).getByRole('button', { name: 'DELETE' }))
    expect(within(bar).getByRole('button', { name: `CONFIRM DELETE ${takes}` })).toBeInTheDocument()
    fireEvent.click(within(bar).getByRole('button', { name: 'CLEAR' }))
    expect(screen.queryByRole('group', { name: 'Selected takes' })).toBeNull()
  }, 30_000)
})
