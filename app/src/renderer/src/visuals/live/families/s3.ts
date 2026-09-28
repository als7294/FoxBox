// MILKDROP and SHADERS (S3), registered once at app start (S4 imports this module). Presets and user shaders load
// on first use: when a picker lists the family, or a style is created.
import { createIsf } from '../../engines/isf/engine'
import { packShaders, shaderFiles, userShaders } from '../../engines/isf/library'
import { createMilkdrop } from '../../engines/milkdrop/engine'
import { favourites, loadPresets } from '../../engines/milkdrop/presets'
import { registerFamily, type StyleFamily, type VisualStyle } from '../registry'

const CYCLES = [4, 8, 16] as const

/**
 * The style a picker starts on under prefers-reduced-motion: a SHADERS style (slow fog, no flashes). Milkdrop's AUTO
 * would hold a calm preset there too, but SHADERS is calmer still.
 */
export const REDUCED_MOTION_STYLE = 'shaders.fog'

/** The default style for this viewer: REDUCED_MOTION_STYLE when they prefer reduced motion, else null (the picker's own). */
export function defaultStyleForMotion(reduced = matchMedia('(prefers-reduced-motion: reduce)').matches): string | null {
  return reduced ? REDUCED_MOTION_STYLE : null
}

const milkdrop: StyleFamily = {
  id: 'milkdrop',
  label: 'MILKDROP',
  async styles(): Promise<VisualStyle[]> {
    const presets = await loadPresets()
    const fav = favourites()
    const cycles: VisualStyle[] = CYCLES.map((bars) => ({
      id: `milkdrop.cycle-${bars}`,
      label: `AUTO · every ${bars} bars${fav.size >= 2 ? ' (favourites)' : ''}`,
      create: (canvas, opts) => createMilkdrop(canvas, opts, { preset: null, cycleBars: bars }),
    }))
    const one = [...presets]
      .sort((a, b) => Number(fav.has(b.slug)) - Number(fav.has(a.slug)))
      .map<VisualStyle>((p) => ({
        id: `milkdrop.${p.slug}`,
        label: fav.has(p.slug) ? `★ ${p.name}` : p.name,
        create: (canvas, opts) => createMilkdrop(canvas, opts, { preset: p.slug }),
      }))
    return [...cycles, ...one]
  },
}

/** Style id → the user shader's file name (for removing it); pack shaders aren't in here. */
const userFiles = new Map<string, string>()

const shaders: StyleFamily = {
  id: 'shaders',
  label: 'SHADERS',
  async styles(): Promise<VisualStyle[]> {
    const mine = await userShaders()
    userFiles.clear()
    for (const s of mine) if (s.file) userFiles.set(`shaders.${s.id}`, s.file)
    return [...packShaders.filter((s) => !s.error), ...mine].map((s) => ({
      id: `shaders.${s.id}`,
      label: s.label,
      kind: s.kind,
      create: (canvas, opts) => createIsf(canvas, opts, s),
    }))
  },
}

/** The file behind a user shader's style id, or undefined for FoxBox's own pack. */
export const userShaderFile = (styleId: string): string | undefined => userFiles.get(styleId)

/** True in the desktop app, where .fs files can be imported. */
export const canImportShaders = (): boolean => shaderFiles() !== null

registerFamily(milkdrop)
registerFamily(shaders)

/** Re-announce the families (pickers refresh): after favourites change or shaders are imported. */
export function refreshS3Families(): void {
  registerFamily(milkdrop)
  registerFamily(shaders)
}

/** SHADERS → remove a user shader (IsfShader.file, via userShaders()); the list refreshes. */
export async function removeUserShader(file: string): Promise<boolean> {
  const removed = (await shaderFiles()?.removeShader(file)) ?? false
  if (removed) refreshS3Families()
  return removed
}

/** SHADERS → IMPORT: the native dialog (desktop app), then the list refreshes. Resolves with how many were added. */
export async function importUserShaders(): Promise<number> {
  const files = shaderFiles()
  if (!files) return 0
  const added = await files.importShaders()
  if (added > 0) refreshS3Families()
  return added
}
