import { setupServer } from 'msw/node'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Peaks, Song } from '../../../src/renderer/src/api/types'

// SONG (v0.7) against the MSW mock engine: import → analysis, overrides, auto-placement, the bake field on export.
// Web Audio is faked: the "decode" reads WAV, like decodeAudioData would.
vi.mock('../../../src/renderer/src/audio/player', async () => {
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
vi.mock('../../../src/renderer/src/audio/playerInstance', () => ({ player: { setBuffers: vi.fn(), toggle: vi.fn(), pause: vi.fn() } }))

const { handlers } = await import('../../../src/renderer/src/mocks/handlers')
const { mockEngine } = await import('../../../src/renderer/src/mocks/mockEngine')
const { encodeWav } = await import('../../../src/renderer/src/audio/wav')
const { exportCurrent } = await import('../../../src/renderer/src/state/renderController')
const { studio, useStudio } = await import('../../../src/renderer/src/state/studio')
const { autoPlace, songGrid, songKey, songPlacement, songs, useSong } = await import('../../../src/renderer/src/state/song')

const server = setupServer(...handlers)
beforeAll(() => {
  mockEngine.latencyMs = 0
  mockEngine.songAnalysisMs = 0
  server.listen({ onUnhandledRequest: 'error' })
})
afterAll(() => server.close())
beforeEach(() => {
  songs.clear()
  useStudio.setState({ render: null, renderKey: null, source: null, sourceKey: null, error: null, phase: 'idle' })
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
  it('imports a song, polls its analysis and puts the drop on its beat drop', async () => {
    const song = await imported()
    const s = useSong.getState()
    expect(song.name).toBe('song-a')
    expect(s.buffer?.duration).toBeCloseTo(40)
    expect(s.beatDrop).toBeCloseTo(20, 0)
    // Mock grid: 128 BPM, bar 1 at 0.12 s (bars of 1.875 s): the beat drop is on bar 12; no render yet, so the drop starts there.
    expect(songGrid(song)).toMatchObject({ bpm: 128, downbeatS: 0.12, barS: 1.875 })
    expect(songKey(song)).toBe('D#m') // the engine says 'Ebm'
    expect(s.placement).toMatchObject({ atBar: 12, auto: true })
  })

  it('sends overrides (null clears one) and keeps an automatic placement on the moved grid', async () => {
    await imported()
    await songs.patch({ bpm_override: 140, key_override: 'A#' })
    let song = useSong.getState().song!
    expect(songGrid(song)?.bpm).toBe(140)
    expect(songKey(song)).toBe('A#')
    await songs.patch({ bpm_override: null, downbeat_override_s: 0.5 })
    song = useSong.getState().song!
    expect(songGrid(song)).toMatchObject({ bpm: 128, downbeatS: 0.5 })
    expect(useSong.getState().placement.atBar).toBe(11)
    // A hand-placed drop stays put until AUTO.
    songs.setPlacement({ atBar: 3 })
    expect(useSong.getState().placement).toMatchObject({ atBar: 3, auto: false })
    await songs.patch({ downbeat_override_s: null })
    expect(useSong.getState().placement.atBar).toBe(3)
    songs.autoPlace()
    expect(useSong.getState().placement).toMatchObject({ atBar: 12, auto: true })
  })

  it('auto-places from the peaks: the last word on the first big energy rise, snapped to a bar', () => {
    // 80 s, 800 buckets: quiet until 40.5 s (bar 21 at 120 BPM from 0.5 s), loud after.
    const n = 800
    const amp = Array.from({ length: n }, (_, i) => ((i * 80) / n < 40.5 ? 0.1 : 0.9))
    const peaks: Peaks = { buckets: n, duration_s: 80, max: amp, min: amp.map((v) => -v) }
    const analysis = { bpm: 120, bpm_confidence: 1, key: null, camelot: null, key_confidence: 0, downbeat_s: 0.5, beats_per_bar: 4 }
    const song = { id: 's', name: 's', duration_s: 80, sample_rate: 48000, channels: 2, peaks, audio_id: 'a', analysis_state: 'done', analysis, created_at: '' } as Song
    expect(autoPlace(song, null)).toBe(21)
    expect(autoPlace(song, { duration_s: 4, tail_s: 3.9 })).toBe(19) // a 2-bar voice ends as the beat drops
    expect(autoPlace(song, null, 10.4)).toBe(6) // a beat drop found in the decoded audio wins
    expect(autoPlace({ ...song, peaks: { ...peaks, max: amp.map(() => 0.5), min: amp.map(() => -0.5) } }, null)).toBe(1) // no drop
    expect(autoPlace({ ...song, analysis: null }, null)).toBe(1) // no grid
  })

  it('bakes the drop into the song on export', async () => {
    await imported()
    studio.applyPreset(mockEngine.preset('pact'))
    useStudio.setState({ tab: 'type', script: 'WE ARE GUY FVWKS' })
    const bake = songPlacement(useSong.getState())
    expect(bake).toMatchObject({ song_id: useSong.getState().song!.id, at_bar: 12, duck_db: -6 })
    const { files } = await exportCurrent({ format: 'wav', bit_depth: 24, variants: ['wet'], stems: false, bake })
    expect(files.map((f) => f.variant)).toEqual(['wet', 'baked'])
    const plain = await exportCurrent({ format: 'wav', bit_depth: 24, variants: ['wet'], stems: false })
    expect(plain.files.map((f) => f.variant)).toEqual(['wet'])
  })
})
