// The SHADERS list: FoxBox's pack (./shaders, see LICENSES.md) and the user's own .fs files, which main keeps in
// <data dir>/shaders/ (read through the bridge; the renderer never touches the file system).
import type { VisualsBridge } from '@shared/bridge'
import { bridge } from '@/env'
import { parseIsf, type IsfShader } from './loader'

const PACK = import.meta.glob('./shaders/*.fs', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const FILTERS = import.meta.glob('./filters/*.fs', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

const load = (files: Record<string, string>, prefix = ''): IsfShader[] =>
  Object.entries(files)
    .map(([path, source]) => parseIsf(source, path.split('/').pop()!))
    .map((s) => ({ ...s, id: prefix + s.id }))
    .sort((a, b) => a.label.localeCompare(b.label))

/** FoxBox's generators (./shaders) and, 1.4, its filters (./filters: they transform the picture beneath). */
export const packShaders: IsfShader[] = [...load(PACK), ...load(FILTERS, 'fx-')]

export function shaderFiles(): VisualsBridge | null {
  return bridge()?.visuals ?? null
}

/** The user's shaders (ids prefixed 'user-' so they never shadow the pack); unusable files are left out. */
export async function userShaders(): Promise<IsfShader[]> {
  const files = shaderFiles()
  if (!files) return []
  const list = await files.listShaders().catch(() => [])
  const out: IsfShader[] = []
  for (const { file, source } of list) {
    const s = parseIsf(source, file)
    if (s.error) {
      console.warn(`SHADERS: skipped ${file}: ${s.error}`)
      continue
    }
    out.push({ ...s, id: `user-${s.id}`, label: `${s.label} ·`, file })
  }
  return out.sort((a, b) => a.label.localeCompare(b.label))
}
