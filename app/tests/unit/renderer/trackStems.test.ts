import { afterEach, describe, expect, it, vi } from 'vitest'

const get = vi.fn()
vi.mock('@/api/client', async (orig) => ({ ...(await orig<typeof import('@/api/client')>()), api: { GET: (...a: unknown[]) => get(...a) } }))

const { forgetTrackStems, loadTrackStems, trackSourceWithStems } = await import('@/visuals/live/trackStems')

const features = () => {
  const tracks = ['drums', 'bass', 'vocals', 'other', 'mix']
  const bytes = new Uint8Array(60 * tracks.length * 2)
  bytes.set([255, 128], (30 * tracks.length + 0) * 2) // a drum hit at 0.5 s
  return { song_id: 'a', fps: 60, frames: 60, tracks, data_b64: btoa(String.fromCharCode(...bytes)) }
}
const ok = (data: unknown) => ({ data, response: new Response(null, { status: 200 }) })
const notFound = () => ({ error: { error: { code: 'not_found', message: 'no stems' } }, response: new Response(null, { status: 404 }) })

afterEach(() => {
  get.mockReset()
  forgetTrackStems()
})

describe('TRACK stems loader', () => {
  it('fetches once per song, reads the features, and gives null (no throw) on a 404', async () => {
    get.mockResolvedValue(ok(features()))
    const [a, b] = await Promise.all([loadTrackStems('a'), loadTrackStems('a')])
    expect(get).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(get.mock.calls[0]).toEqual(['/api/songs/{song_id}/stems/features', { params: { path: { song_id: 'a' } } }])
    expect(a!.read(0.5).stems.drums).toEqual({ rms: 1, onset: 2 })

    get.mockResolvedValue(notFound())
    expect(await loadTrackStems('b')).toBeNull() // another song: fetched afresh, and a 404 is just "no stems"
    get.mockResolvedValue(ok(features()))
    expect(await loadTrackStems('b')).not.toBeNull() // the failure wasn't cached
  })

  it('passes the TRACK source through untouched without a reader', () => {
    const source = { read: () => ({ rms: 0.5 }) as never, dispose: () => {} }
    expect(trackSourceWithStems(source, null, () => 0)).toBe(source)
  })
})
