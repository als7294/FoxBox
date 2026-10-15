import { http, HttpResponse, type HttpResponseResolver } from 'msw'
import type { Settings, SongUpdate } from '@/api/types'
import { mockLibrary } from './library'
import { MockError, mockEngine as engine } from './mockEngine'

const API = '*/api'

function fail(err: unknown) {
  if (err instanceof MockError) {
    return HttpResponse.json({ error: { code: err.code, message: err.message, hint: err.hint, retryable: false } }, { status: err.status })
  }
  return HttpResponse.json(
    { error: { code: 'internal', message: String((err as Error)?.message ?? err), hint: null, retryable: true } },
    { status: 500 },
  )
}

/** Wraps a resolver so MockErrors become the engine's {error:{…}} envelope. */
const safe =
  (fn: HttpResponseResolver): HttpResponseResolver =>
  async (info) => {
    try {
      return await fn(info)
    } catch (err) {
      return fail(err)
    }
  }

export const handlers = [
  http.get(`${API}/health`, () => HttpResponse.json(engine.health())),
  http.get(`${API}/models`, () => HttpResponse.json(engine.models())),
  // A simulated download (bytes, rate, ETA, verify, cancel with resume): see mocks/installSim.ts.
  http.post(
    `${API}/models/:modelId/install`,
    safe(({ params }) => {
      const job = engine.installer.install(String(params.modelId))
      if (!job) throw new MockError(404, 'not_found', `model '${String(params.modelId)}' not found`)
      return HttpResponse.json(job)
    }),
  ),
  http.get(
    `${API}/jobs/:jobId`,
    safe(({ params }) => HttpResponse.json(engine.job(String(params.jobId)))),
  ),
  http.post(
    `${API}/jobs/:jobId/cancel`,
    safe(({ params }) => {
      const j = engine.jobs.get(String(params.jobId))
      if (j && (j.state === 'queued' || j.state === 'running')) j.state = 'cancelled'
      return HttpResponse.json(engine.job(String(params.jobId)))
    }),
  ),

  // songs: analysis finishes after mockEngine.songAnalysisMs
  http.get(`${API}/songs`, () => {
    return HttpResponse.json([...engine.songs.keys()].map((sid) => engine.song(sid)))
  }),
  http.post(
    `${API}/songs`,
    safe(async ({ request }) => {
      const form = await request.formData()
      const file = form.get('file')
      if (!(file instanceof Blob)) throw new Error('file is required')
      const name = (form.get('name') as string | null) ?? null
      return HttpResponse.json(engine.uploadSong(await file.arrayBuffer(), name, file instanceof File ? file.name : 'song.wav'))
    }),
  ),
  http.get(
    `${API}/songs/:songId`,
    safe(({ params }) => HttpResponse.json(engine.song(String(params.songId)))),
  ),
  http.patch(
    `${API}/songs/:songId`,
    safe(async ({ params, request }) => HttpResponse.json(engine.updateSong(String(params.songId), (await request.json()) as SongUpdate))),
  ),
  http.delete(`${API}/songs/:songId`, ({ params }) => {
    engine.songs.delete(String(params.songId))
    return new HttpResponse(null, { status: 204 })
  }),
  // v1.1 library (the wheel): empty, or mocks/library.ts with ?library in the URL
  http.get(`${API}/library/sources`, () => HttpResponse.json(mockLibrary.sources())),
  http.get(`${API}/library/sources/:sourceId/playlists`, ({ params }) => HttpResponse.json(mockLibrary.playlists(String(params.sourceId)))),
  http.get(`${API}/library/tracks`, ({ request }) => HttpResponse.json(mockLibrary.tracks(new URL(request.url)))),
  http.get(`${API}/library/tracks/:id/art`, ({ params }) =>
    HttpResponse.text(mockLibrary.art(String(params.id)), { headers: { 'content-type': 'image/svg+xml' } }),
  ),
  http.get(`${API}/settings`, () => HttpResponse.json(engine.settings)),
  http.put(
    `${API}/settings`,
    safe(async ({ request }) => {
      engine.settings = (await request.json()) as Settings
      return HttpResponse.json(engine.settings)
    }),
  ),

  http.get(`${API}/audio/:audioId`, ({ params }) => {
    const bytes = engine.audio.get(String(params.audioId))
    if (!bytes) return fail(new MockError(404, 'not_found', `audio '${String(params.audioId)}' not found`))
    return new HttpResponse(bytes, { headers: { 'content-type': 'audio/wav', 'content-length': String(bytes.byteLength) } })
  }),
]
