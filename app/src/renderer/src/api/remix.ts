/**
 * REMIX (contracts v0.11.4): the generated schema's types, and a small client for the remix routes.
 *
 * Responses always carry pydantic's defaults (FastAPI response_model), so the defaulted arrays the generated schema marks
 * optional (sections, lanes, clips, hits, notes, wobble, reasons, files, warnings, matches, missing) are required here;
 * `remixApi` narrows each response to them.
 */
import { api, EngineError, unwrap } from './client'
import type { components } from './schema'
import type { Job } from './types'

type S = components['schemas']
/** T with its defaulted fields K present (as the engine always sends them). */
type Filled<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>

export type RemixSection = S['RemixSection']
export type SectionKind = RemixSection['kind']
export type RemixRecipe = S['Remix']['recipe']
export type RemixSlot = S['RemixSource']['slot']
export type RemixSource = S['RemixSource']
export type StemName = S['StemClipSrc']['stem']
export type MashPart = S['MashMatch']['part']
export type BassStyle = NonNullable<S['MashScanRequest']['bass_styles']>[number]
export type GrooveNote = S['GrooveNote']
export type GrooveWobble = S['GrooveWobble']
export type BassGroove = Filled<S['BassGroove'], 'notes' | 'wobble'>
export type BassPatch = S['BassPatch']
export type PatchCategory = BassPatch['category']
export type DrumKit = S['DrumKit']
export type FlipStyle = S['FlipStyle']
export type FlipSettings = S['FlipSettings']
export type BassMacros = S['BassMacros']
export type TopLayer = NonNullable<S['Remix']['top_layers']>[number]
export type MashMatch = Filled<S['MashMatch'], 'reasons'>
export type MashScanRequest = S['MashScanRequest']
export type MashScanResult = { matches: MashMatch[]; missing: string[] }
export type GrooveRenderRequest = S['GrooveRenderRequest']
export type GrooveRenderResult = S['GrooveRenderResult']
export type StemClipSrc = S['StemClipSrc']
export type GrooveClipSrc = S['GrooveClipSrc']
export type KitHit = S['KitHit']
export type KitClipSrc = Filled<S['KitClipSrc'], 'hits'>
export type ClipSrc = StemClipSrc | GrooveClipSrc | KitClipSrc
export type RemixClip = Omit<S['RemixClip'], 'src'> & { src: ClipSrc }
export type RemixLane = Omit<S['RemixLane'], 'clips'> & { clips: RemixClip[] }
export type LaneRole = RemixLane['role']
/** A take (v0.11.8): one seed of the remix plus what BUILD resolved for it (`choices`, read-only). */
export type RemixTake = Filled<S['RemixTake'], 'choices'>
/** RemixUpdate.takes: the takes to keep (rename, star); a seed left out is deleted. */
export type RemixTakeEdit = S['RemixTakeEdit']
export type Remix = Omit<S['Remix'], 'sections' | 'lanes' | 'mash' | 'takes'> & {
  sections: RemixSection[]
  lanes: RemixLane[]
  mash?: MashMatch | null
  takes: RemixTake[]
}
export type RemixCreate = S['RemixCreate']
export type RemixUpdate = S['RemixUpdate']
export type RemixExportRequest = S['RemixExportRequest']
export type ExportFormat = RemixExportRequest['formats'][number]
export type RemixExportResult = Filled<S['RemixExportResult'], 'files' | 'warnings'>

// ------------------------------------------------------------------------------------------------ client

const byId = (remix_id: string) => ({ params: { path: { remix_id } } })

export const remixApi = {
  list: (query?: { song_id?: string; recipe?: string }) => unwrap(api.GET('/api/remixes', { params: { query } })) as Promise<Remix[]>,
  create: (body: RemixCreate) => unwrap(api.POST('/api/remixes', { body })) as Promise<Remix>,
  get: (id: string) => unwrap(api.GET('/api/remixes/{remix_id}', byId(id))) as Promise<Remix>,
  patch: (id: string, body: RemixUpdate) => unwrap(api.PATCH('/api/remixes/{remix_id}', { ...byId(id), body })) as Promise<Remix>,
  remove: (id: string) => unwrap(api.DELETE('/api/remixes/{remix_id}', byId(id))),
  /** `fresh` (v0.11.9): drop the take's saved arrangement (its edits) and rebuild from its recorded choices. */
  build: (id: string, fresh = false): Promise<Job> =>
    unwrap(api.POST('/api/remixes/{remix_id}/build', { ...byId(id), body: fresh ? { fresh: true } : null })),
  prepare: (id: string): Promise<Job> => unwrap(api.POST('/api/remixes/{remix_id}/prepare', byId(id))),
  export: (id: string, body: RemixExportRequest): Promise<Job> => unwrap(api.POST('/api/remixes/{remix_id}/export', { ...byId(id), body })),
  exportResult: (id: string) => unwrap(api.GET('/api/remixes/{remix_id}/export', byId(id))) as Promise<RemixExportResult>,
  groove: (songId: string, startBar: number, bars: number) =>
    unwrap(
      api.GET('/api/songs/{song_id}/bass/groove', { params: { path: { song_id: songId }, query: { start_bar: startBar, bars } } }),
    ) as Promise<BassGroove>,
  renderGroove: (body: GrooveRenderRequest): Promise<GrooveRenderResult> => unwrap(api.POST('/api/grooves/render', { body })),
  patches: (): Promise<BassPatch[]> => unwrap(api.GET('/api/patches')),
  kits: (): Promise<DrumKit[]> => unwrap(api.GET('/api/kits')),
  flipStyles: (): Promise<FlipStyle[]> => unwrap(api.GET('/api/flip-styles')),
  mashScan: (body: MashScanRequest) => unwrap(api.POST('/api/mash/scan', { body })) as Promise<MashScanResult>,
}

export type SamplePack = S['SamplePack']
export type DrumRole = keyof SamplePack['counts']

/** v0.15 your drum sample packs. Adding one goes through main (bridge().samplePacks): the page never holds a path. */
export const samplePacksApi = {
  list: (): Promise<SamplePack[]> => unwrap(api.GET('/api/sample-packs')),
  update: (id: string, body: S['SamplePackUpdate']): Promise<SamplePack> =>
    unwrap(api.PATCH('/api/sample-packs/{pack_id}', { params: { path: { pack_id: id } }, body })),
  forget: (id: string) => unwrap(api.DELETE('/api/sample-packs/{pack_id}', { params: { path: { pack_id: id } } })),
  rescan: (id: string): Promise<Job> => unwrap(api.POST('/api/sample-packs/{pack_id}/rescan', { params: { path: { pack_id: id } } })),
}

/**
 * PATCH at the remix's rev. A stale rev (409) means someone else saved first: the fresh remix comes back instead,
 * with `conflict`, and the edit is dropped (the user redoes it on what's there now).
 */
export async function saveRemix(r: Remix, edit: Omit<RemixUpdate, 'rev'>): Promise<{ remix: Remix; conflict: boolean }> {
  try {
    return { remix: await remixApi.patch(r.id, { ...edit, rev: r.rev }), conflict: false }
  } catch (err) {
    if (err instanceof EngineError && err.status === 409) return { remix: await remixApi.get(r.id), conflict: true }
    throw err
  }
}

const SETTLED: Job['state'][] = ['done', 'error', 'cancelled']

/** Polls GET /api/jobs/{id} until the job settles; resolves when done, throws its error otherwise. */
export async function waitJob(job: Job, onProgress?: (j: Job) => void, everyMs = 300): Promise<Job> {
  let j = job
  while (!SETTLED.includes(j.state)) {
    onProgress?.(j)
    await new Promise((r) => setTimeout(r, everyMs))
    j = await unwrap(api.GET('/api/jobs/{job_id}', { params: { path: { job_id: j.id } } }))
  }
  onProgress?.(j)
  if (j.state !== 'done') throw new EngineError(500, j.error ?? { code: j.state, message: `${j.kind} ${j.state}` })
  return j
}
