/** Rekordbox library import (contracts v0.12 / v0.12.1): read a rekordbox.xml, then import the picked tracks as songs. */
import { api, unwrap } from './client'
import type { components } from './schema'
import type { Job } from './types'

type S = components['schemas']
export type RekordboxLibrary = S['RekordboxLibrary']
export type RekordboxEntry = S['RekordboxEntry']
export type RekordboxPlaylist = S['RekordboxPlaylist']

export const rekordboxApi = {
  /** POST /api/rekordbox/library: the user-chosen rekordbox.xml, read into tracks and playlists (nothing imported yet). */
  library(file: Blob, filename = 'rekordbox.xml'): Promise<RekordboxLibrary> {
    const form = new FormData()
    form.append('file', file, filename)
    // openapi-fetch would JSON-encode; hand it the FormData as-is (the browser sets the boundary).
    return unwrap(api.POST('/api/rekordbox/library', { body: form as never, bodySerializer: (b: unknown) => b as FormData }))
  },
  /** POST /api/rekordbox/import: a job with one item per track (done: result_ids [song_id]). */
  import: (library_id: string, track_ids: string[]): Promise<Job> =>
    unwrap(api.POST('/api/rekordbox/import', { body: { library_id, track_ids } })) as Promise<Job>,
}
