import { setupServer } from 'msw/node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, EngineError, unwrap } from '../../../src/renderer/src/api/client'
import { handlers } from '../../../src/renderer/src/mocks/handlers'
import { mockEngine } from '../../../src/renderer/src/mocks/mockEngine'

const server = setupServer(...handlers)
beforeAll(() => {
  mockEngine.latencyMs = 0
  server.listen({ onUnhandledRequest: 'error' })
})
afterAll(() => server.close())

describe('typed API client against the MSW mock engine', () => {
  it('reads health, rack, voices and presets with contract shapes', async () => {
    const health = await unwrap(api.GET('/api/health'))
    expect(health.state).toBe('ready')
    const rack = await unwrap(api.GET('/api/rack'))
    expect(rack.modules.map((m) => m.id)).toContain('mask')
    expect(rack.macros.map((m) => m.id)).toEqual(['depth', 'grit', 'machine', 'space'])
    const voices = await unwrap(api.GET('/api/voices'))
    expect(voices.some((v) => v.id === 'kokoro:am_fenrir')).toBe(true)
    const presets = await unwrap(api.GET('/api/presets'))
    expect(presets.filter((p) => p.factory).map((p) => p.id).sort()).toEqual(['abyss', 'ghost', 'legion', 'pact', 'raw', 'signal', 'unit'])
  })

  it('tts → render (final, auto-export) → export → library → rekordbox', async () => {
    const src = await unwrap(api.POST('/api/sources/tts', { body: { script: 'WE ARE GUY FVWKS | EXPECT *US*', voice_id: 'kokoro:am_fenrir', speed: 0.9, bpm: 140, name: null } }))
    expect(src.segments).toHaveLength(2)
    expect(src.segments[1]!.flags?.throw).toBe(true)
    const info = await unwrap(
      api.POST('/api/render', {
        body: { source_id: src.id, preset_id: 'pact', arrange: { bpm: 140, bars: 4, key: 'Am', fit: 'auto', max_stretch: 0.08, beat_lock: false, first_word_beat: 0, tail_beats: 0, snap_end: 'beat', auto_tail: true, fade_in_ms: 2, fade_out_ms: 30 }, quality: 'final', stems: false, auto_export: true },
      }),
    )
    expect(info.n_samples).toBe(302_400) // 4 bars @ 140 at 44.1 kHz
    expect(info.export?.path).toMatch(/GUYFVWKS_PACT_.*_140bpm_4bar_Am_wet_v01\.aiff$/)
    const audio = await fetch(`http://localhost/api/audio/${info.audio_id}`)
    expect(audio.headers.get('content-type')).toBe('audio/wav')
    const files = (await unwrap(api.POST('/api/exports', { body: { render_ids: [info.id], format: 'wav', bit_depth: 24, variants: ['wet', 'dry'], stems: false, title: null } }))).files
    expect(files.map((f) => f.variant)).toEqual(['wet', 'dry'])
    const lib = await unwrap(api.GET('/api/library', { params: { query: { q: 'expect' } } }))
    expect(lib.items[0]?.render_id).toBe(info.id)
    const xml = await unwrap(api.POST('/api/exports/rekordbox', { body: { export_ids: files.map((f) => f.id), playlist: 'Test' } }))
    expect(xml.tracks).toBe(2)
  })

  it('turns error envelopes into EngineError with code and hint', async () => {
    const err = await unwrap(api.GET('/api/sources/{source_id}', { params: { path: { source_id: 'src_nope' } } })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EngineError)
    expect((err as EngineError).code).toBe('not_found')
    expect((err as EngineError).status).toBe(404)
  })

  it('uploads recordings as multipart', async () => {
    const { encodeWav } = await import('../../../src/renderer/src/audio/wav')
    const { uploadSource } = await import('../../../src/renderer/src/api/upload')
    const wav = new Blob([encodeWav({ sampleRate: 48_000, channels: [new Float32Array(48_000).fill(0.1)] }, 24)], { type: 'audio/wav' })
    const src = await uploadSource(wav, 'take.wav', 'recording', 'TAKE 01')
    expect(src.kind).toBe('recording')
    expect(src.duration_s).toBeCloseTo(1, 2)
  })
})
