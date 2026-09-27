// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { SongStrip } from '../../../src/renderer/src/components/song/SongStrip'
import { encodeWav } from '../../../src/renderer/src/audio/wav'
import { handlers } from '../../../src/renderer/src/mocks/handlers'
import { mockEngine } from '../../../src/renderer/src/mocks/mockEngine'
import { songs, useSong } from '../../../src/renderer/src/state/song'

const server = setupServer(...handlers)
beforeAll(() => {
  mockEngine.songAnalysisMs = 0
  server.listen({ onUnhandledRequest: 'error' })
})
afterAll(() => server.close())
afterEach(() => {
  cleanup()
  songs.clear()
})

describe('SONG strip key picker', () => {
  it('asks for the key when the engine is unsure, and sends the Camelot pick as key_override', async () => {
    const wav = encodeWav({ sampleRate: 8000, channels: [new Float32Array(8000 * 20)] }, 16)
    const { id } = mockEngine.uploadSong(wav, 'song-b', 'song-b.wav')
    mockEngine.song(id) // analysed
    mockEngine.songs.get(id)!.analysis!.key = null // below the engine's key confidence
    useSong.setState({ song: mockEngine.song(id) })

    render(<SongStrip />)
    expect(screen.getByText('128 BPM')).toBeInTheDocument()
    expect(screen.queryByText(/detected/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'SET KEY' }))
    const picker = screen.getByRole('dialog', { name: 'Song key' })
    const keys = within(picker).getAllByRole('button')
    expect(keys).toHaveLength(24)
    expect(keys.map((k) => k.textContent)).toContain('2AD#m')
    fireEvent.click(within(picker).getByRole('button', { name: 'D#m (2A)' }))

    await waitFor(() => expect(mockEngine.songs.get(id)!.key_override).toBe('Ebm'))
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: 'D#m · 2A' })).toBeInTheDocument())
  })
})
