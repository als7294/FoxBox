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

const masks = new Map<string, { info: Record<string, unknown> & { size_bytes: number }; recipe: object; png: string | null }>()
let maskSeq = 0
const packs = new Map(
  [
    {
      id: 'pk1',
      name: 'My Drums',
      enabled: true,
      available: true,
      counts: { kick: 6, snare: 4, clap: 2, hat: 9 },
      created_at: '2026-09-29T12:00:00Z',
    },
    { id: 'pk2', name: 'Tour SSD', enabled: true, available: false, counts: { kick: 3, perc: 12 }, created_at: '2026-09-29T12:05:00Z' },
  ].map((p) => [p.id, p]),
)

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

  // v0.12 Rekordbox import: the library from the chosen XML, then a job that makes one song per track.
  http.post(
    `${API}/rekordbox/library`,
    safe(async ({ request }) => {
      const file = (await request.formData()).get('file')
      if (!(file instanceof Blob)) throw new Error('file is required')
      return HttpResponse.json(engine.readRekordbox(await file.text()))
    }),
  ),
  http.post(
    `${API}/rekordbox/import`,
    safe(async ({ request }) => {
      const body = (await request.json()) as { library_id: string; track_ids: string[] }
      return HttpResponse.json(engine.importRekordbox(body.library_id, body.track_ids))
    }),
  ),

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

  // SAMPLE LAYERS (v0.15): two packs (one on a drive that isn't there); a rescan is done at once. Adding goes through main.
  http.get(`${API}/sample-packs`, () => HttpResponse.json([...packs.values()])),
  http.patch(
    `${API}/sample-packs/:id`,
    safe(async ({ request, params }) => {
      const p = packs.get(String(params.id))
      if (!p) throw new MockError(404, 'not_found', 'No such pack.')
      const b = (await request.json()) as { name?: string | null; enabled?: boolean | null }
      Object.assign(p, b.name != null ? { name: b.name } : {}, b.enabled != null ? { enabled: b.enabled } : {})
      return HttpResponse.json(p)
    }),
  ),
  http.delete(`${API}/sample-packs/:id`, ({ params }) => HttpResponse.json({ deleted: packs.delete(String(params.id)) })),
  http.post(`${API}/sample-packs/:id/rescan`, ({ params }) => {
    const at = new Date().toISOString()
    const job = {
      id: `job_scan_${String(params.id)}`,
      kind: 'sample_scan',
      state: 'done',
      progress: 1,
      message: null,
      items: [],
      result_ids: [String(params.id)],
      error: null,
      created_at: at,
      updated_at: at,
    }
    engine.jobs.set(job.id, job as never)
    return HttpResponse.json(job)
  }),

  // MASKS (v0.13): the user's masks in memory (recipes and their PNG thumbnails; no image upload in the mock).
  http.get(`${API}/masks`, () => HttpResponse.json([...masks.values()].map((m) => m.info))),
  http.post(
    `${API}/masks/recipes`,
    safe(async ({ request }) => {
      const b = (await request.json()) as { name: string; recipe: object; thumbnail_png_b64?: string | null }
      const id = `m${++maskSeq}`
      const info = {
        id,
        name: b.name,
        kind: 'user',
        format: 'recipe',
        width: 512,
        height: 512,
        size_bytes: 1,
        created_at: new Date().toISOString(),
      }
      masks.set(id, { info, recipe: b.recipe, png: b.thumbnail_png_b64 ?? null })
      return HttpResponse.json(info)
    }),
  ),
  http.get(`${API}/masks/:id/recipe`, ({ params }) => {
    const m = masks.get(String(params.id))
    return m ? HttpResponse.json({ recipe: m.recipe }) : fail(new MockError(404, 'not_found', 'No such mask.'))
  }),
  http.put(
    `${API}/masks/:id/recipe`,
    safe(async ({ request, params }) => {
      const m = masks.get(String(params.id))
      if (!m) throw new MockError(404, 'not_found', 'No such mask.')
      const b = (await request.json()) as { name: string; recipe: object; thumbnail_png_b64?: string | null }
      Object.assign(m, { recipe: b.recipe, png: b.thumbnail_png_b64 ?? m.png })
      m.info = { ...m.info, name: b.name, size_bytes: m.info.size_bytes + 1 }
      return HttpResponse.json(m.info)
    }),
  ),
  http.get(`${API}/masks/:id/image`, ({ params }) => {
    const png = masks.get(String(params.id))?.png
    if (!png) return fail(new MockError(404, 'not_found', 'No picture.'))
    return new HttpResponse(
      Uint8Array.from(atob(png), (c) => c.charCodeAt(0)),
      { headers: { 'content-type': 'image/png' } },
    )
  }),
  http.patch(
    `${API}/masks/:id`,
    safe(async ({ request, params }) => {
      const m = masks.get(String(params.id))
      if (!m) throw new MockError(404, 'not_found', 'No such mask.')
      m.info = { ...m.info, name: ((await request.json()) as { name: string }).name }
      return HttpResponse.json(m.info)
    }),
  ),
  http.delete(`${API}/masks/:id`, ({ params }) => HttpResponse.json({ deleted: masks.delete(String(params.id)) })),

  http.get(`${API}/audio/:audioId`, ({ params }) => {
    const bytes = engine.audio.get(String(params.audioId))
    if (!bytes) return fail(new MockError(404, 'not_found', `audio '${String(params.audioId)}' not found`))
    return new HttpResponse(bytes, { headers: { 'content-type': 'audio/wav', 'content-length': String(bytes.byteLength) } })
  }),
]
