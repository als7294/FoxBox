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

describe('TRACK bass line (v0.10.1)', () => {
  it('reads held notes, slides, stabs, the wobble phase and the feel at the playhead', async () => {
    // 60 fps, 120 BPM (30 frames a beat): A1 (55 Hz) from frame 0, sliding up 5 semitones over frames 60-90, a new note at 90
    const bass = new Uint8Array(120 * 4)
    for (let f = 0; f < 120; f++) {
      const midi = f < 60 ? 33 : f < 90 ? 33 + (5 * (f - 60)) / 30 : 38
      bass.set([1 | (f === 0 || f === 90 ? 2 : 0), 200, 40, Math.round(midi * 2)], f * 4)
    }
    get.mockResolvedValue(ok({ ...features(), frames: 120, bass_b64: btoa(String.fromCharCode(...bass)) }))
    const reader = (await loadTrackStems('a'))!
    const sections = [{ start_s: 0, end_s: 2, bass_style: 'trap' as const, half_time: true, note_beats: 2, wobble_div: '1/8', wobble_anchor_s: 0.1 }]
    const held = reader.read(0.5, 120, sections)
    expect(held.bass).toMatchObject({ on: true, noteOn: false, expectBeats: 2, glide: 0, wobble: { div: '1/8' } })
    expect(held.bass!.heldBeats).toBeCloseTo(1)
    expect(held.bass!.pitch).toBeCloseTo(55)
    expect(held.bass!.wobble.phase).toBeCloseTo(0.6) // (0.5 - 0.1) / 0.25 s
    expect(held.feel).toEqual({ halfTime: true, style: 'trap' })
    const slide = reader.read(1.25, 120, sections).bass!
    expect(slide.glide).toBeGreaterThan(3) // about 5 semitones a beat
    expect(slide.glide).toBeLessThan(7)
    expect(reader.read(1.5, 120, sections).bass).toMatchObject({ noteOn: true, heldBeats: 0 })
    expect(reader.read(0.5).feel).toBeUndefined() // no structure: the bass alone
  })
})
