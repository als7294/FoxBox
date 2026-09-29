/** Camera face masks (contracts v0.11.6; v0.13 adds MASKS recipes): the user's masks. The built-ins are app assets (camera/masks). */
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

/** POST /api/masks/recipes (v0.13): a MASKS character mask, its recipe JSON and a PNG thumbnail (base64, <= 512 px). */
export const saveMaskRecipe = (name: string, recipe: object, thumbnailPngB64: string | null): Promise<MaskInfo> =>
  unwrap(api.POST('/api/masks/recipes', { body: { name, recipe: recipe as Record<string, unknown>, thumbnail_png_b64: thumbnailPngB64 } }))

/** GET /api/masks/{id}/recipe: the recipe as saved: untrusted JSON (maskRecipe.normalize it before use). */
export async function maskRecipe(id: string): Promise<unknown> {
  const got = await unwrap(api.GET('/api/masks/{mask_id}/recipe', { params: { path: { mask_id: id } } }))
  return (got as { recipe?: unknown }).recipe
}

/** PUT /api/masks/{id}/recipe (v0.13): a character's new name and recipe (its thumbnail too, when one is sent). */
export const updateMaskRecipe = (id: string, name: string, recipe: object, thumbnailPngB64: string | null): Promise<MaskInfo> =>
  unwrap(
    api.PUT('/api/masks/{mask_id}/recipe', {
      params: { path: { mask_id: id } },
      body: { name, recipe: recipe as Record<string, unknown>, thumbnail_png_b64: thumbnailPngB64 },
    }),
  )

/** PATCH /api/masks/{id} (v0.15.2): renames any user mask, image or recipe (built-ins: 409). */
export const renameMaskInfo = (id: string, name: string): Promise<MaskInfo> =>
  unwrap(api.PATCH('/api/masks/{mask_id}', { params: { path: { mask_id: id } }, body: { name } }))
