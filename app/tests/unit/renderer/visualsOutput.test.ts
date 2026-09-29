import { describe, expect, it, vi } from 'vitest'
import { canSendFrame, linkPort, sendFrame, STALE_MS, takeFrame, type OutputMessage } from '@/visuals/live/output'

/** One end of the link, with what the page posts and a way to deliver what the other window says. */
function fakePort() {
  const sent: OutputMessage[] = []
  const port = { postMessage: (m: OutputMessage) => sent.push(m), start() {}, close() {}, onmessage: null } as unknown as MessagePort
  const hear = (m: OutputMessage) => (port.onmessage as (e: { data: OutputMessage }) => void)({ data: m })
  return { port, sent, hear }
}

const bitmap = () => ({ close: vi.fn() }) as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> }

describe('the output window link', () => {
  it('keeps one frame in flight: the next waits until the output window has shown it (or it is stale)', async () => {
    vi.stubGlobal('createImageBitmap', async () => bitmap())
    const { port, sent, hear } = fakePort()
    linkPort(port)
    expect(canSendFrame()).toBe(true)
    sendFrame({} as HTMLCanvasElement)
    expect(canSendFrame()).toBe(false)
    sendFrame({} as HTMLCanvasElement) // dropped
    await vi.waitFor(() => expect(sent.map((m) => m.type)).toEqual(['frame']))
    expect(canSendFrame(performance.now() + STALE_MS + 1)).toBe(true)
    hear({ type: 'shown' })
    expect(canSendFrame()).toBe(true)
    vi.unstubAllGlobals()
  })

  it('shows the newest frame only, and says so when it takes one', () => {
    const { port, sent, hear } = fakePort()
    linkPort(port)
    const [a, b] = [bitmap(), bitmap()]
    hear({ type: 'frame', bitmap: a })
    hear({ type: 'frame', bitmap: b })
    expect(a.close).toHaveBeenCalled()
    expect(takeFrame()).toBe(b)
    expect(sent).toEqual([{ type: 'shown' }])
    expect(takeFrame()).toBeNull()
    expect(sent).toHaveLength(1)
  })
})
