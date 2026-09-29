import type { Remix } from '@/api/remix'

/**
 * The file name the engine writes (S3's rule, c780942): "<song> (<STYLE> <RECIPE> - TAKE n)", file-safe ASCII. The song is
 * the name, less a trailing recipe word; STYLE is the current take's; a style equal to the recipe shows once.
 */
export function exportStem(remix: Pick<Remix, 'name' | 'recipe' | 'seed' | 'takes'>, name: string): string {
  const title = (name.trim() || remix.name).trim()
  const recipe = remix.recipe.toUpperCase()
  const words = title.split(/\s+/)
  const song = words.length > 1 && words.at(-1)!.toUpperCase() === recipe ? words.slice(0, -1).join(' ') : title
  const i = remix.takes.findIndex((t) => t.seed === remix.seed)
  const style = i >= 0 ? remix.takes[i]!.style.replace(/_/g, ' ').toUpperCase() : ''
  const label = !style || style === recipe ? recipe : `${style} ${recipe}`
  const stem = `${song} (${label}${i >= 0 ? ` - TAKE ${i + 1}` : ''})`
  const safe = stem
    .normalize('NFKD')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x00-\x7f]/g, '')
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 120)
    .replace(/[\s.]+$/g, '')
  return safe || 'Remix'
}
