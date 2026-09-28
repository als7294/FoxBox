// The user's own ISF shaders (1.3 SHADERS): .fs files in <data dir>/shaders/. The renderer only ever names a file
// inside that folder (to remove it); what gets imported comes from main's own open dialog.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'

export const SHADER_MAX_BYTES = 64 * 1024
const MAX_FILES = 200
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}\.fs$/

export const shadersDir = (dataDir: string): string => join(dataDir, 'shaders')

const isShaderFile = (path: string): boolean => {
  try {
    const st = lstatSync(path)
    return st.isFile() && st.size <= SHADER_MAX_BYTES // no symlinks, no huge files
  } catch {
    return false
  }
}

/** Every .fs file in the folder, as text (at most MAX_FILES, sorted by name). */
export function listShaders(dir: string): { file: string; source: string }[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => FILE_NAME.test(f) && isShaderFile(join(dir, f)))
    .sort()
    .slice(0, MAX_FILES)
    .map((file) => ({ file, source: readFileSync(join(dir, file), 'utf8') }))
}

/** Copies chosen .fs files in (a same-named file is replaced). Returns how many were copied. */
export function importShaderFiles(dir: string, paths: string[]): number {
  mkdirSync(dir, { recursive: true })
  let added = 0
  for (const path of paths) {
    if (extname(path).toLowerCase() !== '.fs' || !isShaderFile(path)) continue
    const name = basename(path).replace(/[^A-Za-z0-9 ._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '')
    if (!FILE_NAME.test(name)) continue
    copyFileSync(path, join(dir, name))
    added += 1
  }
  return added
}

/** Deletes one file the renderer names; only a plain .fs file name directly inside the folder. */
export function removeShader(dir: string, file: unknown): boolean {
  if (typeof file !== 'string' || !FILE_NAME.test(file)) return false
  const path = resolve(dir, file)
  if (dirname(path) !== resolve(dir) || !isShaderFile(path)) return false
  unlinkSync(path)
  return true
}
