/**
 * MY MASKS through the engine (contracts v0.13): the user's masks, each MaskConfig mask's config (its recipe body, v4;
 * older recipes upgrade through normalizeConfig), and save / update / duplicate / rename / delete / import. VISUALS'
 * picker hears about every change (MASKS_CHANGED) and wears `recipe:<id>`.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { deleteMask, listMasks, maskRecipe, renameMaskInfo, saveMaskRecipe, updateMaskRecipe, uploadMask, type MaskInfo } from '@/api/masks'
import { MASKS_CHANGED } from '@/components/camera/CameraControls'
import { camera, useCamera } from '@/components/camera/cameraStore'
import { normalizeConfig, type MaskConfig } from '@/components/camera/maskConfig'
import { maskFileProblem, maskName, maskPng } from '@/components/camera/maskImport'
import { addRecipeMask, holdRecipe } from '@/components/camera/maskFace'
import { masks, uniqueName } from './masksStore'
import { renderThumb } from './stage'

/** A saved mask: a MaskConfig one (`cfg` once loaded), or an image drawn on the TEMPLATE. */
export interface Saved {
  id: string
  name: string
  kind: 'mask' | 'image'
  date: number
  cfg: MaskConfig | null
  info: MaskInfo
}

const KEY = ['masks', 'library']

async function load(): Promise<Saved[]> {
  const list = (await listMasks()).filter((m) => m.kind === 'user')
  return Promise.all(
    list.map(async (m) => {
      const recipe = m.format === 'recipe'
      if (recipe) addRecipeMask(m.id, () => maskRecipe(m.id))
      const cfg = recipe ? await maskRecipe(m.id).then(normalizeConfig, () => null) : null
      return { id: m.id, name: m.name, kind: recipe ? 'mask' : 'image', date: Date.parse(m.created_at) || 0, cfg, info: m } as Saved
    }),
  ).then((all) => all.sort((a, b) => b.date - a.date))
}

/** The saved masks, newest first ([] while the engine is away). */
export function useLibrary() {
  const q = useQuery({ queryKey: KEY, queryFn: load })
  return { saved: q.data ?? [], loading: q.isLoading }
}

/** After any change: MY MASKS and VISUALS' picker list them again. */
export function useLibraryRefresh() {
  const qc = useQueryClient()
  return async () => {
    await qc.invalidateQueries({ queryKey: KEY })
    await qc.invalidateQueries({ queryKey: ['masks'] })
    window.dispatchEvent(new Event(MASKS_CHANGED))
  }
}

/** A PNG thumbnail for the engine's /image (base64, ≤ 512 px), or null while the stage has no pictures. */
async function thumbB64(cfg: MaskConfig): Promise<string | null> {
  const url = await renderThumb(cfg, 'full').catch(() => '')
  if (!url) return null
  const blob = await (await fetch(url)).blob()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** SAVE: a new mask, or over `id`. VISUALS wears this version from now (holdRecipe). */
export async function saveConfig(name: string, cfg: MaskConfig, id: string | null): Promise<string> {
  const thumb = await thumbB64(cfg)
  const info = id ? await updateMaskRecipe(id, name, cfg, thumb) : await saveMaskRecipe(name, cfg, thumb)
  addRecipeMask(info.id, () => maskRecipe(info.id))
  holdRecipe(info.id, cfg) // VISUALS wears this version from now
  return info.id
}

/** RENAME: a MaskConfig mask through its recipe; an image mask through PATCH (v0.15.2, live with S3's server). */
export const renameMask = (m: Saved, name: string) =>
  m.kind === 'image' ? renameMaskInfo(m.id, name) : updateMaskRecipe(m.id, name, m.cfg ?? {}, null)
/** DELETE: gone from the engine; VISUALS stops wearing it (FOX again, as its picker does) and the editor forgets it. */
export async function removeMask(m: Saved): Promise<void> {
  await deleteMask(m.id)
  const mask = useCamera.getState().settings.mask
  if (mask.style === `recipe:${m.id}` || mask.style === `mask:${m.id}`) camera.set({ mask: { ...mask, style: 'fox' } })
  masks.forget(m.id)
}

/** IMPORT: an SVG, PNG or WebP drawn on the face TEMPLATE; the problem's copy when it can't be used. */
export async function importImage(file: File, taken: readonly Saved[]): Promise<string | null> {
  const problem = maskFileProblem(file)
  if (problem) return problem
  const base = maskName(file.name).replace(/[_-]+/g, ' ').trim().toUpperCase().slice(0, 20) || 'IMAGE MASK'
  const name = uniqueName(base, taken)
  await uploadMask(await maskPng(file), `${name}.png`, name)
  return null
}
