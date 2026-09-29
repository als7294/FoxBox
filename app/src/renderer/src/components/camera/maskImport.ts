/**
 * Importing a face mask: an SVG, PNG or WebP drawn on the face template (1024×1024), checked here, then decoded as an
 * image and redrawn as a 1024×1024 PNG. An SVG decoded as an image runs no scripts and loads nothing external, so
 * only its pixels ever reach the engine.
 */

export type MaskFormat = 'svg' | 'png' | 'webp'

/** The contract's caps (v0.11.6): SVG ≤ 2 MB, PNG/WebP ≤ 16 MB, ≤ 4096 px a side. */
export const MASK_MAX_BYTES: Record<MaskFormat, number> = { svg: 2 * 1024 * 1024, png: 16 * 1024 * 1024, webp: 16 * 1024 * 1024 }
export const MASK_MAX_PX = 4096
const OUT = 1024

export function maskFormat(file: { name: string; type: string }): MaskFormat | null {
  const byType: Record<string, MaskFormat> = { 'image/svg+xml': 'svg', 'image/png': 'png', 'image/webp': 'webp' }
  const ext = file.name.toLowerCase().match(/\.(svg|png|webp)$/)?.[1] as MaskFormat | undefined
  return byType[file.type] ?? ext ?? null
}

/** Why a file can't be a mask (before reading it), or null. */
export function maskFileProblem(file: { name: string; type: string; size: number }): string | null {
  const f = maskFormat(file)
  if (!f) return 'A mask is an SVG, PNG or WebP drawn on the template.'
  if (file.size > MASK_MAX_BYTES[f]) return `That ${f.toUpperCase()} is over ${MASK_MAX_BYTES[f] / 1024 / 1024} MB.`
  return null
}

/** The mask's name: its file's, without the extension. */
export const maskName = (filename: string): string => filename.replace(/\.[a-z0-9]+$/i, '').trim().slice(0, 80) || 'MASK'

/** The picture as a 1024×1024 PNG. Throws a readable Error if it isn't a square picture of at most 4096 px. */
export async function maskPng(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode().catch(() => {
      throw new Error('That picture could not be read.')
    })
    const w = img.naturalWidth
    const h = img.naturalHeight
    if (w > MASK_MAX_PX || h > MASK_MAX_PX) throw new Error(`Masks are at most ${MASK_MAX_PX} px a side.`)
    if (w && h && Math.abs(w / h - 1) > 0.02) throw new Error('Draw it on the template: a mask is square (1024 × 1024).')
    const c = document.createElement('canvas')
    c.width = c.height = OUT
    c.getContext('2d')?.drawImage(img, 0, 0, OUT, OUT)
    return await new Promise<Blob>((done, fail) => c.toBlob((b) => (b ? done(b) : fail(new Error('The mask could not be drawn.'))), 'image/png'))
  } finally {
    URL.revokeObjectURL(url)
  }
}
