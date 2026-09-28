import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, normalize, relative, sep } from 'node:path'

const DRAGGABLE_EXTENSIONS = new Set(['.aiff', '.aif', '.wav', '.xml', '.flac', '.mp3', '.mp4'])
const MAX_ROOTS = 16
const MAX_RETURNED = 20_000
const MAX_JSON_BYTES = 32 * 1024 * 1024

function real(p: string): string | null {
  try {
    return realpathSync.native(p)
  } catch {
    return null
  }
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

type Obj = Record<string, unknown>
const isObject = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** An ExportedFile as the engine writes it (id, render_id, variant, filename, path). */
function isExportedFile(o: Obj): o is Obj & { path: string } {
  return typeof o.path === 'string' && typeof o.filename === 'string' && typeof o.render_id === 'string' && typeof o.variant === 'string'
}

/** POST /api/exports/rekordbox → RekordboxResult. */
function isRekordboxResult(o: Obj): o is Obj & { path: string } {
  return typeof o.path === 'string' && typeof o.filename === 'string' && typeof o.tracks === 'number' && typeof o.playlist === 'string'
}

/** A finished batch job names the rekordbox.xml it wrote in its message. */
function isFinishedBatch(o: Obj): o is Obj & { message: string } {
  return o.kind === 'batch' && o.state === 'done' && typeof o.message === 'string'
}

const XML_IN_MESSAGE = /\/[^\0\n"'<>|]+?\.xml\b/g

function asPath(candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null
  if (!candidate || candidate.length > 4096 || candidate.includes('\0') || !isAbsolute(candidate)) return null
  return normalize(candidate)
}

/**
 * Decides which paths the renderer may drag out or reveal. A path is allowed only if the engine itself
 * returned it (main sees every engine response, since it proxies them) and it lies inside an export root
 * the engine reported. Roots seen earlier are remembered, so files exported before the user moved the
 * export folder stay draggable from the Vault.
 */
export class ExportGuard {
  private current: string | null = null
  private knownRoots: string[] = []
  private returned = new Set<string>()

  constructor(private readonly memoryFile?: string) {
    if (!memoryFile) return
    try {
      const saved = JSON.parse(readFileSync(memoryFile, 'utf8')) as unknown
      if (Array.isArray(saved)) this.knownRoots = saved.filter((r): r is string => typeof r === 'string' && isAbsolute(r))
    } catch {
      // first run
    }
  }

  get root(): string | null {
    return this.current
  }

  get roots(): readonly string[] {
    return this.knownRoots
  }

  /** Record the export root the engine reports (health or settings). */
  setRoot(root: string): void {
    const path = asPath(root)
    if (!path) return
    this.current = path
    if (!this.knownRoots.includes(path)) {
      this.knownRoots = [path, ...this.knownRoots].slice(0, MAX_ROOTS)
      this.persist()
    }
  }

  /** Record a path the engine returned, or main wrote (a saved clip). Ignored unless it lies inside a known root. */
  noteReturnedPath(candidate: unknown): void {
    const path = asPath(candidate)
    if (!path || !this.knownRoots.some((r) => isInside(r, path))) return
    if (this.returned.size >= MAX_RETURNED) this.returned.clear()
    this.returned.add(path)
  }

  /**
   * Learn from one engine JSON response (main proxies every one). Only structured, engine-generated fields
   * count; strings the user controls (upload names, titles, scripts, preset names) never do:
   * - export roots: `export_dir` of GET /api/health and GET/PUT /api/settings;
   * - files: `path` of ExportedFile objects (exports, RenderInfo.export, Take.exports) and of a
   *   RekordboxResult, plus the rekordbox .xml named in a finished batch job's message.
   */
  noteResponse(method: string, url: string, body: ArrayBuffer | string): void {
    const size = typeof body === 'string' ? body.length : body.byteLength
    if (size === 0 || size > MAX_JSON_BYTES) return
    let value: unknown
    try {
      value = JSON.parse(typeof body === 'string' ? body : Buffer.from(body).toString('utf8'))
    } catch {
      return
    }
    const route = url.split('?')[0] ?? ''
    const verb = method.toUpperCase()
    const rootSource = (route === '/api/health' && verb === 'GET') || (route === '/api/settings' && (verb === 'GET' || verb === 'PUT'))
    if (rootSource && isObject(value) && typeof value.export_dir === 'string') this.setRoot(value.export_dir)
    const walk = (v: unknown, depth: number) => {
      if (depth > 8) return
      if (Array.isArray(v)) {
        for (const item of v) walk(item, depth + 1)
        return
      }
      if (!isObject(v)) return
      if (isExportedFile(v) || isRekordboxResult(v)) this.noteReturnedPath(v.path)
      else if (isFinishedBatch(v)) for (const xml of v.message.match(XML_IN_MESSAGE) ?? []) this.noteReturnedPath(xml)
      for (const item of Object.values(v)) if (item && typeof item === 'object') walk(item, depth + 1)
    }
    walk(value, 0)
  }

  /** Canonical path of an existing, engine-returned file inside a root that may be dragged, else null. */
  resolveDraggable(candidate: unknown): string | null {
    const target = this.resolveReturned(candidate)
    if (!target) return null
    const stat = statSync(target, { throwIfNoEntry: false })
    return stat?.isFile() && DRAGGABLE_EXTENSIONS.has(extname(target).toLowerCase()) ? target : null
  }

  /** Canonical path of an engine-returned file, or of an export root itself, that may be revealed. */
  resolveRevealable(candidate: unknown): string | null {
    const path = asPath(candidate)
    if (!path) return null
    if (this.knownRoots.includes(path)) return real(path)
    const target = this.resolveReturned(candidate)
    if (!target) return null
    const stat = statSync(target, { throwIfNoEntry: false })
    return stat && (stat.isFile() || stat.isDirectory()) ? target : null
  }

  private resolveReturned(candidate: unknown): string | null {
    const path = asPath(candidate)
    if (!path || !this.returned.has(path)) return null
    const target = real(path)
    if (!target) return null
    for (const root of this.knownRoots) {
      const realRoot = real(root)
      if (realRoot && isInside(realRoot, target) && target !== realRoot) return target
    }
    return null
  }

  private persist(): void {
    if (!this.memoryFile) return
    try {
      mkdirSync(dirname(this.memoryFile), { recursive: true })
      writeFileSync(this.memoryFile, JSON.stringify(this.knownRoots, null, 2))
    } catch {
      // best effort
    }
  }
}
