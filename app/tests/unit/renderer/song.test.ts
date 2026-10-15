import { setupServer } from 'msw/node'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Song } from '../../../src/renderer/src/api/types'

// SONG against the MSW mock engine: import → analysis, overrides.
// Web Audio is faked: the "decode" reads WAV, like decodeAudioData would.
vi.mock('../../../src/renderer/src/audio/context', async () => {
  const { decodeWav } = await import('../../../src/renderer/src/audio/wav')
  return {
    audioContext: () => ({
      decodeAudioData: async (bytes: ArrayBuffer) => {
        const pcm = decodeWav(bytes)
        const length = pcm.channels[0]!.length
        return { sampleRate: pcm.sampleRate, length, duration: length / pcm.sampleRate, numberOfChannels: pcm.channels.length, getChannelData: (c: number) => pcm.channels[c]! }
      },
    }),
  }
})
vi.mock('../../../src/renderer/src/audio/cache', () => ({
  loadAudioBuffer: vi.fn(async () => ({ duration: 6.86, length: 302_400, sampleRate: 44_100, numberOfChannels: 2, getChannelData: () => new Float32Array(302_400) })),
}))

const { handlers } = await import('../../../src/renderer/src/mocks/handlers')
const { mockEngine } = await import('../../../src/renderer/src/mocks/mockEngine')
const { encodeWav } = await import('../../../src/renderer/src/audio/wav')
const { songGrid, songKey, songs, useSong } = await import('../../../src/renderer/src/state/song')

const server = setupServer(...handlers)
beforeAll(() => {
  mockEngine.songAnalysisMs = 0
  server.listen({ onUnhandledRequest: 'error' })
})
afterAll(() => server.close())
beforeEach(() => {
  songs.clear()
})

/** 40 s at 8 kHz: a quiet low end for 20 s, then the beat drops. */
function songFile(): File {
  const rate = 8000
  const ch = new Float32Array(rate * 40)
  for (let i = 0; i < ch.length; i++) ch[i] = (i < rate * 20 ? 0.03 : 0.8) * Math.sin((2 * Math.PI * 60 * i) / rate)
  return new File([encodeWav({ sampleRate: rate, channels: [ch] }, 24)], 'song-a.wav', { type: 'audio/wav' })
}

async function imported(): Promise<Song> {
  await songs.importFile(songFile())
  await vi.waitFor(() => expect(useSong.getState().song?.analysis_state).toBe('done'), { timeout: 3000 })
  return useSong.getState().song!
}

describe('the song store', () => {
  it('imports a song, polls its analysis and finds its beat drop', async () => {
    const song = await imported()
    const s = useSong.getState()
    expect(song.name).toBe('song-a')
    expect(s.buffer?.duration).toBeCloseTo(40)
    expect(s.beatDrop).toBeCloseTo(20, 0)
    // Mock grid: 128 BPM, bar 1 at 0.12 s (bars of 1.875 s).
    expect(songGrid(song)).toMatchObject({ bpm: 128, downbeatS: 0.12, barS: 1.875 })
    expect(songKey(song)).toBe('D#m') // the engine says 'Ebm'
  })

  it('sends overrides (null clears one)', async () => {
    await imported()
    await songs.patch({ bpm_override: 140, key_override: 'A#' })
    let song = useSong.getState().song!
    expect(songGrid(song)?.bpm).toBe(140)
    expect(songKey(song)).toBe('A#')
    await songs.patch({ bpm_override: null, downbeat_override_s: 0.5 })
    song = useSong.getState().song!
    expect(songGrid(song)).toMatchObject({ bpm: 128, downbeatS: 0.5 })
  })
})
