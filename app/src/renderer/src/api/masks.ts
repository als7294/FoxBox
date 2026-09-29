/** Camera face masks (contracts v0.11.6): the user's imported masks. The built-ins are app assets (camera/masks). */
import { api, EngineError, unwrap } from './client'
import type { components } from './schema'

export type MaskInfo = components['schemas']['MaskInfo']

export const listMasks = (): Promise<MaskInfo[]> => unwrap(api.GET('/api/masks'))

/** POST /api/masks (multipart): a mask picture drawn on the face template. */
export function uploadMask(file: Blob, filename: string, name: string): Promise<MaskInfo> {
  const form = new FormData()
  form.append('file', file, filename)
  form.append('name', name)
  return unwrap(api.POST('/api/masks', { body: form as never, bodySerializer: (b: unknown) => b as FormData }))
}

export const deleteMask = (id: string): Promise<unknown> =>
  unwrap(api.DELETE('/api/masks/{mask_id}', { params: { path: { mask_id: id } } }))

/** A mask's picture as a blob: URL (through the engine's transport, like every engine call). */
export async function maskImageUrl(id: string): Promise<string> {
  const { data, response } = await api.GET('/api/masks/{mask_id}/image', { params: { path: { mask_id: id } }, parseAs: 'blob' })
  if (!response.ok || !(data instanceof Blob)) throw new EngineError(response.status, null, 'The mask picture could not be read.')
  return URL.createObjectURL(data)
}
