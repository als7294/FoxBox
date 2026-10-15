import { setupServer } from 'msw/node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, EngineError, unwrap } from '../../../src/renderer/src/api/client'
import { handlers } from '../../../src/renderer/src/mocks/handlers'
import { mockEngine } from '../../../src/renderer/src/mocks/mockEngine'

const server = setupServer(...handlers)
beforeAll(() => {
  mockEngine.songAnalysisMs = 0
  server.listen({ onUnhandledRequest: 'error' })
})
afterAll(() => server.close())

describe('typed API client against the MSW mock engine (contracts v1.0)', () => {
  it('reads health and settings with contract shapes', async () => {
    expect((await unwrap(api.GET('/api/health'))).state).toBe('ready')
    expect((await unwrap(api.GET('/api/settings'))).artist).toBe('GUY FVWKS')
  })

  it('uploads a song as multipart and streams its audio', async () => {
    const { encodeWav } = await import('../../../src/renderer/src/audio/wav')
    const { uploadSong } = await import('../../../src/renderer/src/api/upload')
    const wav = new Blob([encodeWav({ sampleRate: 48_000, channels: [new Float32Array(48_000).fill(0.1)] }, 24)], { type: 'audio/wav' })
    const song = await uploadSong(wav, 'track.wav')
    expect(song.duration_s).toBeCloseTo(1, 2)
    const audio = await fetch(`http://localhost/api/audio/${song.audio_id}`)
    expect(audio.headers.get('content-type')).toBe('audio/wav')
  })

  it('turns error envelopes into EngineError with code and hint', async () => {
    const err = await unwrap(api.GET('/api/songs/{song_id}', { params: { path: { song_id: 'sng_nope' } } })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EngineError)
    expect((err as EngineError).code).toBe('not_found')
    expect((err as EngineError).status).toBe(404)
  })
})
