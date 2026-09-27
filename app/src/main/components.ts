/**
 * App components, for small updates (1.2). A FoxBox.app splits by path into four parts, each known by a hash of its
 * files:
 *   electron        the Electron frameworks (~300 MB): changes only with Electron (or its fuses)
 *   engine-runtime  engine/runtime/: the bundled Python and its packages (~800 MB): rarely
 *   engine-code     engine/code/ (our fvwks_* packages) and the engine's launcher (a few MB)
 *   app             everything else: app.asar, Info.plist, the executable and its helpers (a few MB, every release)
 * The build records the hashes in Contents/Resources/components.json (electron-builder afterPack, before signing);
 * release.mjs zips each part once and the feed lists them. An update downloads only the parts whose hash differs
 * from the running app's, clones the app, swaps those parts in and re-signs it (updater.ts).
 *
 * Plain erasable TypeScript with node builtins only: the build scripts import this file directly (Node type stripping).
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const COMPONENTS = ['app', 'electron', 'engine-runtime', 'engine-code'] as const
export type ComponentName = (typeof COMPONENTS)[number]
export type ComponentHashes = Record<ComponentName, string>

/** Inside the .app. It belongs to the app part but isn't in that part's hash (it holds the hash). */
export const COMPONENTS_FILE = 'Contents/Resources/components.json'

const ENGINE = 'Contents/Resources/engine/'
/** Third-party: engine/runtime/ (S3's 1.2 layout: CPython and the locked venv); python/ and venv/ before that. */
const ENGINE_RUNTIME = /^(runtime|python|venv)(\/|$)/
/** Our packages inside the older single venv. */
const OLD_ENGINE_CODE = /^venv\/lib\/python[^/]+\/site-packages\/fvwks_[^/]*(\/|$)/

/**
 * The part a path inside the .app (relative, e.g. "Contents/Resources/app.asar") belongs to; null for the app's own
 * code signature, which no part carries (the updater signs the assembled app).
 */
export function componentOf(rel: string): ComponentName | null {
  if (rel === 'Contents/_CodeSignature' || rel.startsWith('Contents/_CodeSignature/')) return null
  if (/^Contents\/Frameworks\/[^/]+\.framework(\/|$)/.test(rel)) return 'electron'
  if (rel.startsWith(ENGINE)) {
    // engine-code: code/ (our fvwks_* packages) and the small files beside it (the launcher, MANIFEST.txt, markers).
    const r = rel.slice(ENGINE.length)
    return ENGINE_RUNTIME.test(r) && !OLD_ENGINE_CODE.test(r) ? 'engine-runtime' : 'engine-code'
  }
  return 'app'
}

/**
 * Left out of the hashes: bytecode caches (rebuilt from the same sources, not always byte for byte, so a stray .pyc
 * never costs an 800 MB download) and components.json itself.
 */
export const unhashed = (rel: string): boolean => rel === COMPONENTS_FILE || rel.endsWith('.pyc') || rel.includes('/__pycache__/')

export interface AppEntry {
  /** Relative to the .app. */
  rel: string
  /** Symlink target, or null for a file. */
  link: string | null
  exec: boolean
}

/** Every file and symlink in the .app (symlinks are not followed), sorted by path. */
export function listApp(app: string): AppEntry[] {
  const out: AppEntry[] = []
  const walk = (rel: string) => {
    for (const name of readdirSync(join(app, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name
      const st = lstatSync(join(app, r))
      if (st.isSymbolicLink()) out.push({ rel: r, link: readlinkSync(join(app, r)), exec: false })
      else if (st.isDirectory()) walk(r)
      else if (st.isFile()) out.push({ rel: r, link: null, exec: (st.mode & 0o111) !== 0 })
    }
  }
  walk('')
  return out
}

/**
 * Each part's hash: its files' paths, exec bits and contents (or link targets). `salt` adds what the files alone
 * don't show, e.g. the Electron fuses (applied after afterPack).
 */
export function hashComponents(app: string, salt: Partial<Record<ComponentName, string>> = {}): ComponentHashes {
  const hashes = new Map(COMPONENTS.map((c) => [c, createHash('sha256').update(`foxbox-component-v1\n${salt[c] ?? ''}\n`)]))
  for (const e of listApp(app)) {
    const c = componentOf(e.rel)
    if (!c || unhashed(e.rel)) continue
    const body = e.link !== null ? `link:${e.link}` : createHash('sha256').update(readFileSync(join(app, e.rel))).digest('hex')
    hashes.get(c)!.update(`${e.rel}\0${e.exec ? 'x' : '-'}\0${body}\n`)
  }
  return Object.fromEntries(COMPONENTS.map((c) => [c, hashes.get(c)!.digest('hex')])) as ComponentHashes
}

export function writeComponentsFile(app: string, hashes: ComponentHashes): void {
  writeFileSync(join(app, COMPONENTS_FILE), `${JSON.stringify({ format: 1, components: hashes }, null, 2)}\n`)
}

/** The running app's part hashes, or null (an app from before 1.2, or anything unreadable: then a full update). */
export function readComponentsFile(app: string): ComponentHashes | null {
  try {
    const raw = JSON.parse(readFileSync(join(app, COMPONENTS_FILE), 'utf8')) as { format?: unknown; components?: Record<string, unknown> }
    if (raw.format !== 1 || !raw.components) return null
    const out = {} as ComponentHashes
    for (const c of COMPONENTS) {
      const h = raw.components[c]
      if (typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)) return null
      out[c] = h
    }
    return out
  } catch {
    return null
  }
}

/**
 * Deletes the files of the parts `keep` rejects (then the folders that leaves empty). The updater clears a part
 * before unpacking its new version; release.mjs prunes a copy of the app down to one part to zip it.
 */
export function removeParts(app: string, keep: (c: ComponentName | null) => boolean): void {
  for (const e of listApp(app)) if (!keep(componentOf(e.rel))) rmSync(join(app, e.rel), { force: true })
  const prune = (rel: string): boolean => {
    const dir = join(app, rel)
    let empty = true
    for (const name of readdirSync(dir)) {
      const r = rel ? `${rel}/${name}` : name
      const st = lstatSync(join(app, r))
      if (st.isDirectory() && !st.isSymbolicLink() && prune(r)) rmdirSync(join(app, r))
      else empty = false
    }
    return empty
  }
  if (existsSync(app)) prune('')
}

/** The zip entry that would land outside part `name` (the part zips hold paths relative to the .app), or null. */
export function strayEntry(entries: readonly string[], name: ComponentName): string | null {
  for (const raw of entries) {
    if (raw.startsWith('__MACOSX/')) continue // ditto's extended attributes, applied to the entries below
    if (raw.endsWith('/')) continue // folders are created as needed
    if (componentOf(raw) !== name) return raw
  }
  return null
}
