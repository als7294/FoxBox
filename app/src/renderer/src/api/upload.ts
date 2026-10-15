import { api, unwrap } from './client'
import type { Song } from './types'

/** POST /api/songs (multipart): REMIX's track. The engine analyses it in the background. */
export function uploadSong(blob: Blob, filename: string, name?: string): Promise<Song> {
  const form = new FormData()
  form.append('file', blob, filename)
  if (name) form.append('name', name)
  return unwrap(api.POST('/api/songs', { body: form as never, bodySerializer: (b: unknown) => b as FormData }))
}
