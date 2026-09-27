import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// v0.3 contract features against the MSW mock engine: AUTO bars (+ the capability probe and the fallback on
// older engines), clean-up on upload, and background transcripts.
vi.mock('../../../src/renderer/src/audio/cache', () => ({
  loadAudioBuffer: vi.fn(async () => ({ duration: 6.86, length: 302_400, sampleRate: 44_100, numberOfChannels: 2, getChannelData: () => new Float32Array(302_400) })),
}))
vi.mock('../../../src/renderer/src/audio/playerInstance', () => ({
  player: { setBuffers: vi.fn(), toggle: vi.fn(), pause: vi.fn() },
}))

const { handlers } = await import('../../../src/renderer/src/mocks/handlers')
const { mockEngine, resolveAutoBars } = await import('../../../src/renderer/src/mocks/mockEngine')
const rc = await import('../../../src/renderer/src/state/renderController')
const { probeAutoBars } = await import('../../../src/renderer/src/state/capabilities')
const { useEngine } = await import('../../../src/renderer/src/state/engine')
const { studio, useStudio } = await import('../../../src/renderer/src/state/studio')
const { uploadSource } = await import('../../../src/renderer/src/api/upload')
const { encodeWav } = await import('../../../src/renderer/src/audio/wav')

const server = setupServer(...handlers)
beforeAll(() => {
  mockEngine.latencyMs = 0
  server.listen({ onUnhandledRequest: 'error' })
})
afterAll(() => server.close())
beforeEach(() => {
  rc.resetRenderCache()
  useStudio.setState({ tab: 'type', script: 'WE ARE GUY FVWKS | EXPECT *US*', render: null, renderKey: null, source: null, sourceKey: null, error: null, phase: 'idle', bars: 'auto' })
  studio.applyPreset(mockEngine.preset('pact'))
})
afterEach(() => {
  mockEngine.autoBars = true
  mockEngine.transcriptModel = true
  useEngine.setState({ autoBars: null, probedEpoch: -1 })
})

const wav = () => new Blob([encodeWav({ sampleRate: 48_000, channels: [new Float32Array(48_000).fill(0.1)] }, 24)], { type: 'audio/wav' })

describe('AUTO bars (v0.2)', () => {
  it('resolves like the engine: the standard count nearest the phrase that it fits', () => {
    expect(resolveAutoBars(1.5, 140)).toBe(1) // one bar @140 = 1.71 s
    expect(resolveAutoBars(3.0, 140)).toBe(2)
    expect(resolveAutoBars(1.8, 140)).toBe(1) // 5% over one bar: compressing ≤ 8% still fits
    expect(resolveAutoBars(99, 140)).toBe(16) // nothing fits: the longest
  })

  it('renders with bars "auto" and reports the count it used', async () => {
    const info = await rc.renderNow('preview')
    expect(info?.bars).toBeTypeOf('number')
    expect([1, 2, 4, 8, 16]).toContain(info?.bars)
    expect(useStudio.getState().bars).toBe('auto')
  })

  it('probes the engine: a v0.2+ engine takes "auto", an older one rejects it', async () => {
    expect(await probeAutoBars()).toBe(true)
    mockEngine.autoBars = false
    expect(await probeAutoBars()).toBe(false)
  })

  it('falls back to 4 bars once on an engine that predates AUTO', async () => {
    mockEngine.autoBars = false
    const info = await rc.renderNow('preview')
    expect(info?.bars).toBe(4)
    expect(useStudio.getState().bars).toBe(4)
    expect(useEngine.getState().autoBars).toBe(false)
    expect(useStudio.getState().error).toBeNull()
  })
})

describe('clean-up and transcripts (v0.3)', () => {
  it('sends the clean-up strength with an upload and reports it back', async () => {
    expect((await uploadSource(wav(), 'a.wav', 'import', 'A', 0.5)).denoise).toBe(0.5)
    expect((await uploadSource(wav(), 'b.wav', 'import', 'B')).denoise).toBe(1) // FULL by default
  })

  it('takes a finished transcript into the Studio and re-renders with its words', async () => {
    mockEngine.transcriptMs = 50
    const source = await uploadSource(wav(), 'take.wav', 'recording', 'TAKE 01')
    expect(source.transcript_state).toBe('queued')
    useStudio.setState({
      tab: 'record',
      takes: [{ id: 't1', name: 'TAKE 01', durationS: 1, createdAt: 0, wav: wav(), peakDb: -20, source, status: 'ready', error: null }],
      activeTakeId: 't1',
      source,
      sourceKey: source.id,
    })
    try {
      await rc.renderNow('preview')
      const done = await vi.waitFor(async () => {
        const r = await fetch(`http://localhost/api/sources/${source.id}`)
        const info = await r.json()
        expect(info.transcript_state).toBe('done')
        return info
      }, { timeout: 4_000 })
      rc.adoptSource(done)
      expect(useStudio.getState().source?.script).toBe('WE ARE GUY FVWKS')
      expect(useStudio.getState().takes[0]!.source?.transcript_state).toBe('done')
      await vi.waitFor(() => expect(useStudio.getState().render?.segments.some((s) => (s.words ?? []).length > 0)).toBe(true), { timeout: 4_000 })
    } finally {
      useStudio.setState({ tab: 'type', takes: [], activeTakeId: null })
    }
  })

  it('edits a transcript, or explains the missing model (503)', async () => {
    const source = await uploadSource(wav(), 'take.wav', 'recording', 'TAKE 02')
    const put = (script: string) =>
      fetch(`http://localhost/api/sources/${source.id}/transcript`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ script }) })
    const ok = await (await put('WE ARE | *US*')).json()
    expect(ok.segments).toHaveLength(2)
    expect(ok.segments[1].words[0].throw).toBe(true)
    mockEngine.transcriptModel = false
    const res = await put('WE ARE')
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe('model_not_installed')
  })
})
