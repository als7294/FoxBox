import { http, HttpResponse, type HttpResponseResolver } from 'msw'
import type { BatchRequest, ExportRequest, Lexicon, Preset, RenderRequest, Settings, TakePatch, TTSRequest } from '@/api/types'
import { MockError, mockEngine as engine } from './mockEngine'

const API = '*/api'

function fail(err: unknown) {
  if (err instanceof MockError) {
    return HttpResponse.json({ error: { code: err.code, message: err.message, hint: err.hint, retryable: false } }, { status: err.status })
  }
  return HttpResponse.json({ error: { code: 'internal', message: String((err as Error)?.message ?? err), hint: null, retryable: true } }, { status: 500 })
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
  http.get(`${API}/jobs/:jobId`, safe(({ params }) => HttpResponse.json(engine.job(String(params.jobId))))),
  http.post(
    `${API}/jobs/:jobId/cancel`,
    safe(({ params }) => {
      const j = engine.jobs.get(String(params.jobId))
      if (j && (j.state === 'queued' || j.state === 'running')) j.state = 'cancelled'
      return HttpResponse.json(engine.job(String(params.jobId)))
    }),
  ),

  http.post(`${API}/sources/tts`, safe(async ({ request }) => HttpResponse.json(await engine.tts((await request.json()) as TTSRequest)))),
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
  http.get(`${API}/sources/:sourceId`, safe(({ params }) => HttpResponse.json(engine.source(String(params.sourceId))))),

  http.post(
    `${API}/script/preview`,
    safe(async ({ request }) => HttpResponse.json(engine.preview(((await request.json()) as { script: string }).script))),
  ),
  http.get(`${API}/personas/candidates/:candidateId`, ({ params }) =>
    fail(new MockError(404, 'not_found', `persona candidate '${String(params.candidateId)}' not found`)),
  ),
  http.post(`${API}/personas/design`, () => HttpResponse.json(engine.failedJob('persona_design', 'model_missing', 'Install Qwen3-TTS VoiceDesign first (not available in the mock).'))),

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

  http.post(`${API}/render`, safe(async ({ request }) => HttpResponse.json(await engine.render((await request.json()) as RenderRequest)))),
  http.get(`${API}/renders/:renderId`, safe(({ params }) => HttpResponse.json(engine.renderInfo(String(params.renderId))))),
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

  http.post(`${API}/batch`, safe(async ({ request }) => HttpResponse.json(engine.batch((await request.json()) as BatchRequest)))),

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
