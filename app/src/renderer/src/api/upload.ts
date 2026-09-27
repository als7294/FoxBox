import { api, unwrap } from './client'
import type { Song, SourceInfo } from './types'

/** POST /api/songs (multipart, v0.7): a track to put drops over. The engine analyses it in the background. */
export function uploadSong(blob: Blob, filename: string, name?: string): Promise<Song> {
  const form = new FormData()
  form.append('file', blob, filename)
  if (name) form.append('name', name)
  return unwrap(api.POST('/api/songs', { body: form as never, bodySerializer: (b: unknown) => b as FormData }))
}

/**
 * POST /api/sources/upload (multipart). The engine accepts WAV/AIFF/FLAC/MP3. `denoise` (v0.3) is the clean-up
 * strength 0–1; engines before v0.3 ignore the field.
 */
export function uploadSource(
  blob: Blob,
  filename: string,
  kind: 'recording' | 'import',
  name?: string,
  denoise?: number | null,
): Promise<SourceInfo> {
  const form = new FormData()
  form.append('file', blob, filename)
  form.append('kind', kind)
  if (name) form.append('name', name)
  if (denoise != null) form.append('denoise', String(denoise))
  return unwrap(
    api.POST('/api/sources/upload', {
      // openapi-fetch would JSON-encode; hand it the FormData as-is (the browser sets the boundary).
      body: form as never,
      bodySerializer: (b: unknown) => b as FormData,
    }),
  )
}
