// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SongPanel } from '../../../src/renderer/src/components/song/SongPanel'
import { encodeWav } from '../../../src/renderer/src/audio/wav'
import { mockEngine } from '../../../src/renderer/src/mocks/mockEngine'
import { lastBar, songGrid, songs, useSong } from '../../../src/renderer/src/state/song'

afterEach(() => {
  cleanup()
  songs.clear()
})

describe('SONG panel', () => {
  it('shows IMPORT SONG and a hint with no song, and no drop controls', () => {
    render(<SongPanel />)
    expect(screen.getByRole('button', { name: '♪ IMPORT SONG' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Drop a bar later' })).toBeNull()
  })

  it('shows BPM · KEY and steps the drop bar, clamped to the song, then AUTO puts it back', () => {
    mockEngine.songAnalysisMs = 0
    const wav = encodeWav({ sampleRate: 8000, channels: [new Float32Array(8000 * 20)] }, 16)
    const { id } = mockEngine.uploadSong(wav, 'test-song', 'test-song.wav')
    const song = mockEngine.song(id) // analysed: 128 BPM, Ebm
    const last = lastBar(songGrid(song)!, song.duration_s)
    useSong.setState({ song, placement: { ...useSong.getState().placement, atBar: last - 1 } })

    render(<SongPanel />)
    expect(screen.getByText('test-song')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '128 BPM' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'D#m · 2A' })).toBeInTheDocument()

    const later = screen.getByRole('button', { name: 'Drop a bar later' })
    fireEvent.click(later)
    expect(useSong.getState().placement).toMatchObject({ atBar: last, auto: false })
    expect(later).toBeDisabled()
    fireEvent.click(later, { shiftKey: true })
    expect(useSong.getState().placement.atBar).toBe(last)

    fireEvent.click(screen.getByRole('button', { name: 'AUTO' }))
    expect(useSong.getState().placement.auto).toBe(true)
    expect(screen.queryByRole('button', { name: 'AUTO' })).toBeNull()
  })
})
