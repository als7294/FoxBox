import { http, HttpResponse, type HttpResponseResolver } from 'msw'
import type {
  BatchRequest,
  ExportRequest,
  Lexicon,
  MixRequest,
  Preset,
  RenderRequest,
  Settings,
  SongUpdate,
  TakePatch,
  TTSRequest,
} from '@/api/types'
import type { GrooveRenderRequest, MashScanRequest, RemixCreate, RemixExportRequest, RemixUpdate } from '@/api/remix'
import { MockError, mockEngine as engine } from './mockEngine'
import type { TakeFeedbackCreate } from './remixSim'

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
  http.get(`${API}/rack`, () => HttpResponse.json(engine.rack())),
  http.get(`${API}/voices`, () => HttpResponse.json(engine.voices())),
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

  http.post(
    `${API}/sources/tts`,
    safe(async ({ request }) => HttpResponse.json(await engine.tts((await request.json()) as TTSRequest))),
  ),
  http.post(
    `${API}/sources/upload`,
    safe(async ({ request }) => {
      const form = await request.formData()
      const file = form.get('file')
      if (!(file instanceof Blob)) throw new Error('file is required')
      const kind = form.get('kind') === 'recording' ? 'recording' : 'import'
      const name = (form.get('name') as string | null) ?? null
      const denoise = form.get('denoise')
      return HttpResponse.json(engine.upload(await file.arrayBuffer(), kind, name, denoise == null ? null : Number(denoise)))
    }),
  ),
  http.put(
    `${API}/sources/:sourceId/transcript`,
    safe(async ({ params, request }) =>
      HttpResponse.json(engine.updateTranscript(String(params.sourceId), ((await request.json()) as { script: string }).script)),
    ),
  ),
  http.get(
    `${API}/sources/:sourceId`,
    safe(({ params }) => HttpResponse.json(engine.source(String(params.sourceId)))),
  ),

  http.post(
    `${API}/script/preview`,
    safe(async ({ request }) => HttpResponse.json(engine.preview(((await request.json()) as { script: string }).script))),
  ),
  http.get(`${API}/personas/candidates/:candidateId`, ({ params }) =>
    fail(new MockError(404, 'not_found', `persona candidate '${String(params.candidateId)}' not found`)),
  ),
  http.post(`${API}/personas/design`, () =>
    HttpResponse.json(
      engine.failedJob('persona_design', 'model_missing', 'Install Qwen3-TTS VoiceDesign first (not available in the mock).'),
    ),
  ),

  http.get(`${API}/presets`, () => HttpResponse.json(engine.presets())),
  http.post(
    `${API}/presets`,
    safe(async ({ request }) => {
      const p = (await request.json()) as Preset
      if (engine.presets().some((x) => x.id === p.id)) return fail(new MockError(409, 'exists', `Preset '${p.id}' already exists.`))
      const saved = { ...p, factory: false }
      engine.userPresets.set(saved.id, saved)
      return HttpResponse.json(saved)
    }),
  ),
  http.put(
    `${API}/presets/:presetId`,
    safe(async ({ params, request }) => {
      const pid = String(params.presetId)
      if (!engine.userPresets.has(pid)) return fail(new MockError(409, 'read_only', 'Factory presets are read-only. Save a copy instead.'))
      const saved = { ...((await request.json()) as Preset), id: pid, factory: false }
      engine.userPresets.set(pid, saved)
      return HttpResponse.json(saved)
    }),
  ),
  http.delete(`${API}/presets/:presetId`, ({ params }) => {
    engine.userPresets.delete(String(params.presetId))
    return new HttpResponse(null, { status: 204 })
  }),

  http.post(
    `${API}/render`,
    safe(async ({ request }) => HttpResponse.json(await engine.render((await request.json()) as RenderRequest))),
  ),
  http.get(
    `${API}/renders/:renderId`,
    safe(({ params }) => HttpResponse.json(engine.renderInfo(String(params.renderId)))),
  ),
  http.post(
    `${API}/exports`,
    safe(async ({ request }) => {
      const req = (await request.json()) as ExportRequest
      return HttpResponse.json({ files: engine.exportFiles(req), warnings: engine.exportWarnings(req) })
    }),
  ),
  http.post(
    `${API}/exports/rekordbox`,
    safe(async ({ request }) => {
      const body = (await request.json()) as { export_ids: string[]; playlist?: string }
      return HttpResponse.json(engine.rekordbox(body.export_ids, body.playlist ?? 'GUY FVWKS — Drops'))
    }),
  ),

  http.get(`${API}/library`, ({ request }) => HttpResponse.json(engine.library(new URL(request.url).searchParams))),
  http.patch(
    `${API}/library/:takeId`,
    safe(async ({ params, request }) => {
      const t = engine.takes.get(String(params.takeId))
      if (!t) throw new MockError(404, 'not_found', `take '${String(params.takeId)}' not found`)
      Object.assign(t, Object.fromEntries(Object.entries((await request.json()) as TakePatch).filter(([, v]) => v != null)))
      return HttpResponse.json(t)
    }),
  ),
  http.delete(`${API}/library/:takeId`, ({ params }) => {
    engine.takes.delete(String(params.takeId))
    return new HttpResponse(null, { status: 204 })
  }),

  // v0.7 songs: analysis finishes after mockEngine.songAnalysisMs; the mix is the drop alone.
  http.get(`${API}/songs`, () => {
    engine.remix.seedDemoSongs() // only REMIX lists songs: its demo tracks appear here
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
    `${API}/songs/:songId/bass/groove`,
    safe(({ params, request }) => {
      const q = new URL(request.url).searchParams
      return HttpResponse.json(engine.remix.groove(String(params.songId), Number(q.get('start_bar') ?? 1), Number(q.get('bars') ?? 8)))
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
  http.post(
    `${API}/mix`,
    safe(async ({ request }) => HttpResponse.json(engine.mix((await request.json()) as MixRequest))),
  ),

  // v0.11 REMIX: see mocks/remixSim.ts.
  http.get(`${API}/remixes`, ({ request }) => {
    const q = new URL(request.url).searchParams
    return HttpResponse.json(engine.remix.list({ song_id: q.get('song_id'), recipe: q.get('recipe') }))
  }),
  http.post(
    `${API}/remixes`,
    safe(async ({ request }) => HttpResponse.json(engine.remix.create((await request.json()) as RemixCreate))),
  ),
  http.get(
    `${API}/remixes/:remixId`,
    safe(({ params }) => HttpResponse.json(engine.remix.get(String(params.remixId)))),
  ),
  http.patch(
    `${API}/remixes/:remixId`,
    safe(async ({ params, request }) =>
      HttpResponse.json(engine.remix.update(String(params.remixId), (await request.json()) as RemixUpdate)),
    ),
  ),
  http.delete(`${API}/remixes/:remixId`, ({ params }) => {
    engine.remix.remove(String(params.remixId))
    return new HttpResponse(null, { status: 204 })
  }),
  http.post(
    `${API}/remixes/:remixId/build`,
    safe(async ({ params, request }) => {
      const body = (await request.text().then((t) => (t ? JSON.parse(t) : null))) as { fresh?: boolean } | null
      return HttpResponse.json(engine.remix.build(String(params.remixId), Boolean(body?.fresh)))
    }),
  ),
  http.post(
    `${API}/remixes/:remixId/prepare`,
    safe(({ params }) => HttpResponse.json(engine.remix.prepare(String(params.remixId)))),
  ),
  http.post(
    `${API}/remixes/:remixId/export`,
    safe(async ({ params, request }) =>
      HttpResponse.json(engine.remix.export(String(params.remixId), (await request.json()) as RemixExportRequest)),
    ),
  ),
  http.get(
    `${API}/remixes/:remixId/export`,
    safe(({ params }) => HttpResponse.json(engine.remix.exportResult(String(params.remixId)))),
  ),
  http.post(
    `${API}/grooves/render`,
    safe(async ({ request }) => HttpResponse.json(engine.remix.renderGroove((await request.json()) as GrooveRenderRequest))),
  ),
  http.post(
    `${API}/remixes/:remixId/feedback`,
    safe(async ({ params, request }) =>
      HttpResponse.json(engine.remix.rate(String(params.remixId), (await request.json()) as TakeFeedbackCreate)),
    ),
  ),
  http.get(`${API}/remix-prefs`, () => HttpResponse.json(engine.remix.prefs())),
  http.delete(`${API}/remix-prefs/:style`, ({ params }) => {
    engine.remix.resetPrefs(String(params.style))
    return new HttpResponse(null, { status: 204 })
  }),
  http.get(`${API}/patches`, () => HttpResponse.json(engine.remix.patches())),
  http.get(`${API}/kits`, () => HttpResponse.json(engine.remix.kits())),
  http.get(`${API}/flip-styles`, () => HttpResponse.json(engine.remix.flipStyles())),
  http.post(
    `${API}/mash/scan`,
    safe(async ({ request }) => HttpResponse.json(engine.remix.mashScan((await request.json()) as MashScanRequest))),
  ),

  http.post(
    `${API}/batch`,
    safe(async ({ request }) => HttpResponse.json(engine.batch((await request.json()) as BatchRequest))),
  ),

  http.get(`${API}/settings`, () => HttpResponse.json(engine.settings)),
  http.put(
    `${API}/settings`,
    safe(async ({ request }) => {
      engine.settings = (await request.json()) as Settings
      return HttpResponse.json(engine.settings)
    }),
  ),
  http.get(`${API}/lexicon`, () => HttpResponse.json(engine.lexicon)),
  http.put(
    `${API}/lexicon`,
    safe(async ({ request }) => {
      engine.lexicon = (await request.json()) as Lexicon
      return HttpResponse.json(engine.lexicon)
    }),
  ),

  http.get(`${API}/audio/:audioId`, ({ params }) => {
    const bytes = engine.audio.get(String(params.audioId))
    if (!bytes) return fail(new MockError(404, 'not_found', `audio '${String(params.audioId)}' not found`))
    return new HttpResponse(bytes, { headers: { 'content-type': 'audio/wav', 'content-length': String(bytes.byteLength) } })
  }),
]
