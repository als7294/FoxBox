// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, passthrough } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { rekordboxApi } from '../../../src/renderer/src/api/rekordbox'
import { RekordboxImport } from '../../../src/renderer/src/components/song/RekordboxImport'
import { handlers } from '../../../src/renderer/src/mocks/handlers'
import { mockEngine } from '../../../src/renderer/src/mocks/mockEngine'

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

const XML = `<?xml version="1.0"?><DJ_PLAYLISTS><COLLECTION Entries="2">
<TRACK TrackID="1" Name="Night Drive" Artist="Someone" TotalTime="200" AverageBpm="140.00" Tonality="Am"></TRACK>
<TRACK TrackID="2" Name="Low Tide" Artist="Someone" TotalTime="180" AverageBpm="150.00" Tonality="Fm"></TRACK>
</COLLECTION><PLAYLISTS><NODE Type="0" Name="ROOT"><NODE Name="Bass" Type="1" Entries="1"><TRACK Key="2"/></NODE></NODE></PLAYLISTS></DJ_PLAYLISTS>`

it('reads a rekordbox.xml, narrows by playlist, and imports the ticked track as a song', async () => {
  // jsdom's FormData doesn't survive Node's fetch: the library step goes straight to the mock engine (the import is MSW).
  vi.spyOn(rekordboxApi, 'library').mockImplementation(async (f) => mockEngine.readRekordbox(await f.text()) as never)
  const onImported = vi.fn()
  const { container } = render(<RekordboxImport onImported={onImported} onClose={() => {}} />)
  const input = container.querySelector('input[type=file]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File([XML], 'rekordbox.xml', { type: 'text/xml' })] } })
  expect(await screen.findByText('Night Drive')).toBeTruthy()
  fireEvent.change(screen.getByRole('combobox', { name: 'Playlist' }), { target: { value: 'Bass' } })
  expect(screen.queryByText('Night Drive')).toBeNull() // the playlist narrows the list
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'IMPORT 1' }))
  await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1), { timeout: 5000 })
  const [ids] = onImported.mock.calls[0] as [string[]]
  expect(ids).toHaveLength(1)
  expect(mockEngine.song(ids[0]!).name).toBe('Low Tide')
})
