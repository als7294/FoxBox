import { setupServer } from 'msw/node'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// No Web Audio in jsdom: stub the decode cache and the player.
vi.mock('../../../src/renderer/src/audio/cache', () => ({
  loadAudioBuffer: vi.fn(async () => ({
    duration: 6.86,
    length: 302_400,
    sampleRate: 44_100,
    numberOfChannels: 2,
    getChannelData: () => new Float32Array(302_400),
  })),
}))
vi.mock('../../../src/renderer/src/audio/playerInstance', () => ({
  player: { setBuffers: vi.fn(), toggle: vi.fn(), pause: vi.fn() },
}))

const { handlers } = await import('../../../src/renderer/src/mocks/handlers')
const { mockEngine } = await import('../../../src/renderer/src/mocks/mockEngine')
const rc = await import('../../../src/renderer/src/state/renderController')
const { isStale, studio, useStudio } = await import('../../../src/renderer/src/state/studio')
const { player } = await import('../../../src/renderer/src/audio/playerInstance')

const server = setupServer(...handlers)
beforeAll(() => {
  mockEngine.latencyMs = 0
  server.listen({ onUnhandledRequest: 'error' })
})
afterAll(() => server.close())
beforeEach(() => {
  rc.resetRenderCache()
  useStudio.setState({ script: 'WE ARE GUY FVWKS | EXPECT *US*', render: null, renderKey: null, source: null, sourceKey: null, error: null, phase: 'idle' })
  studio.applyPreset(mockEngine.preset('pact'))
})

describe('render controller', () => {
  it('says once per session when the engine build lacks a rack feature (a failed native DSP compile)', async () => {
    const { toast } = await import('../../../src/renderer/src/state/toasts')
    const warning = 'drive.color: Unavailable in this build (the native DSP module is missing).'
    const real = mockEngine.render.bind(mockEngine)
    const spy = vi.spyOn(mockEngine, 'render').mockImplementation(async (req) => ({ ...(await real(req)), warnings: [warning] }))
    const warn = vi.spyOn(toast, 'warn')
    try {
      await rc.renderNow('preview')
      studio.setMacro('grit', 0.2)
      await rc.renderNow('preview')
      const said = warn.mock.calls.filter(([message]) => message === 'UNAVAILABLE IN THIS BUILD')
      expect(said).toEqual([['UNAVAILABLE IN THIS BUILD', { detail: warning }]])
    } finally {
      spy.mockRestore()
      warn.mockRestore()
    }
  })

  it('synthesizes, renders a preview and loads wet+dry into the player', async () => {
    const info = await rc.renderNow('preview')
    expect(info?.quality).toBe('preview')
    const s = useStudio.getState()
    expect(s.render?.id).toBe(info?.id)
    expect(s.source?.kind).toBe('tts')
    expect(s.phase).toBe('idle')
    expect(isStale(s)).toBe(false)
    expect(player.setBuffers).toHaveBeenCalled()
  })

  it('marks the render stale when a control moves, and fresh again after re-rendering', async () => {
    await rc.renderNow('preview')
    studio.setMacro('depth', 0.9)
    expect(isStale(useStudio.getState())).toBe(true)
    await rc.renderNow('preview')
    expect(isStale(useStudio.getState())).toBe(false)
  })

  it('re-uses the TTS source until the script, voice, speed or BPM changes', async () => {
    await rc.renderNow('preview')
    const first = useStudio.getState().source?.id
    studio.setMacro('grit', 0.1)
    await rc.renderNow('preview')
    expect(useStudio.getState().source?.id).toBe(first)
    studio.setScript('EXPECT *US*')
    await rc.renderNow('preview')
    expect(useStudio.getState().source?.id).not.toBe(first)
  })

  it('debounces re-render on release by 150 ms and coalesces bursts', async () => {
    await rc.renderNow('preview')
    let renders = 0
    const onRequest = ({ request }: { request: Request }) => {
      if (new URL(request.url).pathname === '/api/render') renders++
    }
    server.events.on('request:start', onRequest)
    vi.useFakeTimers()
    try {
      rc.scheduleRender()
      rc.scheduleRender()
      rc.scheduleRender()
      await vi.advanceTimersByTimeAsync(149)
      expect(renders).toBe(0)
      await vi.advanceTimersByTimeAsync(1)
    } finally {
      vi.useRealTimers()
    }
    await vi.waitFor(() => expect(renders).toBe(1))
    await vi.waitFor(() => expect(useStudio.getState().phase).toBe('idle'))
    server.events.removeListener('request:start', onRequest)
  })

  it('final render auto-exports the wet file for the cartridge; newer renders supersede older ones', async () => {
    const [a, b] = await Promise.all([rc.renderNow('preview'), rc.renderNow('final')])
    expect(a).toBeNull()
    expect(b?.export?.variant).toBe('wet')
    expect(useStudio.getState().exports[0]?.path).toBe(b?.export?.path)
    expect(await rc.ensureFinal()).toBe(useStudio.getState().render)
  })

  it('recovers when the engine lost its sources (restart): re-synthesizes and retries once', async () => {
    await rc.renderNow('preview')
    mockEngine.sources.clear()
    studio.setMacro('space', 0.2)
    const info = await rc.renderNow('preview')
    expect(info).not.toBeNull()
    expect(useStudio.getState().error).toBeNull()
  })

  it('re-uploads the active recording take when the engine no longer has it', async () => {
    const { encodeWav } = await import('../../../src/renderer/src/audio/wav')
    const wav = new Blob([encodeWav({ sampleRate: 48_000, channels: [new Float32Array(48_000).fill(0.1)] }, 24)], { type: 'audio/wav' })
    useStudio.setState({
      tab: 'record',
      takes: [{ id: 't1', name: 'TAKE 01', durationS: 1, createdAt: 0, wav, peakDb: -20, source: null, status: 'local', error: null }],
      activeTakeId: 't1',
      source: null,
      sourceKey: null,
    })
    try {
      const info = await rc.renderNow('preview')
      expect(info).not.toBeNull()
      expect(useStudio.getState().takes[0]!.status).toBe('ready')
      expect(useStudio.getState().source?.kind).toBe('recording')
    } finally {
      useStudio.setState({ tab: 'type', takes: [], activeTakeId: null })
    }
  })

  it('reports engine errors in the studio state', async () => {
    useStudio.setState({ voiceId: 'kokoro:nope' })
    expect(await rc.renderNow('preview')).toBeNull()
    expect(useStudio.getState().error?.code).toBe('not_found')
    useStudio.setState({ voiceId: 'kokoro:am_fenrir' })
  })
})
