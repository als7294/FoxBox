import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, join, resolve, sep } from 'node:path'
import type { SetupStep } from './supervisor'

/** Written by engine/server/scripts/bundle_engine.sh at the root of every engine bundle it makes. */
export const ENGINE_BUNDLE_MARKER = '.fvwks-engine-bundle'

/** Where a bundled engine keeps its models: under the app's data folder, never the shared ~/.cache. */
export const bundledModelsDir = (dataDir: string): string => join(dataDir, 'models')

/**
 * The portable engine shipped inside a packaged app (`Contents/Resources/engine`), or null when this build has none
 * (linked and development builds). Only the marker is checked here; a bundle whose launcher is missing is reported
 * by resolveEngineLaunch rather than silently falling back to a linked engine that isn't on this Mac.
 */
export function bundledEngineDir(resourcesPath: string): string | null {
  const dir = join(resourcesPath, 'engine')
  return existsSync(join(dir, ENGINE_BUNDLE_MARKER)) ? dir : null
}

/** macOS runs a quarantined app that was never moved out of Downloads or the disk image from a read-only copy. */
export const isTranslocated = (execPath: string): boolean => execPath.includes('/AppTranslocation/')

export type ExecTool = (file: string, args: string[]) => Promise<void>

const execTool: ExecTool = (file, args) =>
  new Promise((done, fail) => {
    execFile(file, args, { timeout: 60_000 }, (err) => (err ? fail(err) : done()))
  })

/** What Setup and the engine status say when the bundle can't be cleared where it is. */
export const MOVE_TO_APPLICATIONS = 'Move FoxBox to Applications, then open it again.'

/**
 * - cleared: done (xattr -dr also succeeds when nothing was quarantined);
 * - skipped: not our bundle, or read-only with nothing quarantined;
 * - blocked: read-only (a disk image, a locked folder) or refused, and still quarantined. Gatekeeper would stop each
 *   of the engine's libraries with a dialog, so the caller asks the user to move the app instead of launching;
 * - failed: anything else (logged; the launch goes ahead).
 */
export type QuarantineResult = 'cleared' | 'skipped' | 'blocked' | 'failed'

const REFUSED_RE = /Operation not permitted|Permission denied|Read-only file system|EPERM|EACCES|EROFS/i

/** `path` is inside `root`, both with symlinks resolved, so a link can't point the strip anywhere else. */
function isInside(path: string, root: string): boolean {
  try {
    return realpathSync(path).startsWith(realpathSync(root) + sep)
  } catch {
    return false
  }
}

/**
 * A DMG downloaded from the web is quarantined, and so is every file copied out of it. The user approves the app
 * once (right-click → Open), but Gatekeeper can still refuse to exec the bundle's quarantined, ad-hoc-signed Python
 * from a child process. So, before each launch of a bundled engine, drop `com.apple.quarantine` from that folder:
 * only our own marked `Resources/engine` (inside `within`, when given), never through a shell. The attribute is not
 * part of the code signature.
 */
export async function clearEngineQuarantine(
  engineDir: string,
  o: { exec?: ExecTool; log?: (line: string) => void; within?: string } = {},
): Promise<QuarantineResult> {
  const log = o.log ?? (() => {})
  const exec = o.exec ?? execTool
  if (
    basename(engineDir) !== 'engine' ||
    !existsSync(join(engineDir, ENGINE_BUNDLE_MARKER)) ||
    (o.within !== undefined && !isInside(engineDir, o.within))
  ) {
    log(`not clearing quarantine: ${engineDir} is not the engine bundle`)
    return 'skipped'
  }
  const quarantined = async (): Promise<boolean> => {
    for (const p of [engineDir, join(engineDir, 'bin', 'fvwks-engine')]) {
      const found = await exec('/usr/bin/xattr', ['-p', 'com.apple.quarantine', p]).then(
        () => true,
        () => false,
      )
      if (found) return true
    }
    return false
  }
  try {
    accessSync(engineDir, constants.W_OK)
  } catch {
    if (await quarantined()) {
      log(`cannot clear quarantine: ${engineDir} is read-only (a disk image or a locked folder) and quarantined`)
      return 'blocked'
    }
    log(`not clearing quarantine: ${engineDir} is read-only, and nothing in it is quarantined`)
    return 'skipped'
  }
  try {
    await exec('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', engineDir])
    log(`cleared com.apple.quarantine under ${engineDir}`)
    return 'cleared'
  } catch (err) {
    const message = (err as Error).message
    if (REFUSED_RE.test(message) && (await quarantined())) {
      log(`cannot clear quarantine under ${engineDir}: ${message}`)
      return 'blocked'
    }
    log(`could not clear quarantine under ${engineDir}: ${message}`)
    return 'failed'
  }
}

export interface EngineLaunch {
  command: string
  /** Before the standard `--port/--token/--data-dir` flags. */
  args: string[]
  /** After them. */
  extraArgs: string[]
  cwd?: string
  env: NodeJS.ProcessEnv
  setup?: SetupStep
  /** Human-readable, for logs. */
  describe: string
}

export interface ResolveOptions {
  env: NodeJS.ProcessEnv
  /**
   * Honour FVWKS_ENGINE_CMD / FVWKS_UV (tests and development). Off in packaged builds: environment
   * variables set with `launchctl setenv` must not choose what the app executes.
   */
  allowOverrides?: boolean
  /** The engine's `engine/` folder (uv workspace). */
  engineDir: string
  exportDir: string
  /**
   * The engine bundle inside a packaged app (bundledEngineDir). Runs `<bundle>/bin/fvwks-engine` with no uv and no
   * setup step, and keeps models under `<dataDir>/models` (HF_HOME). Null or absent: the linked/development engine,
   * whose environment is left exactly as it is (its models stay in ~/.cache).
   */
  bundle?: { dir: string; dataDir: string } | null
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Finds `uv`. Apps launched from Finder get a minimal PATH, so the usual install folders are checked too. */
export function findUv(env: NodeJS.ProcessEnv): string | null {
  if (env.FVWKS_UV && isExecutable(env.FVWKS_UV)) return env.FVWKS_UV
  const home = env.HOME || homedir()
  const dirs = [
    join(home, '.local', 'bin'),
    ...(env.PATH ?? '').split(delimiter).filter(Boolean),
    join(home, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
  for (const dir of dirs) {
    const candidate = join(dir, 'uv')
    if (isExecutable(candidate)) return candidate
  }
  return null
}

export function engineBinary(engineDir: string): string {
  return join(engineDir, '.venv', 'bin', 'fvwks-engine')
}

const SYNC_STAMP = '.fvwks-synced'

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** The workspace's dependency files: root pyproject.toml, uv.lock and every member's pyproject.toml. */
export function dependencyFiles(engineDir: string): string[] {
  const files = [join(engineDir, 'pyproject.toml'), join(engineDir, 'uv.lock')]
  try {
    for (const entry of readdirSync(engineDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) files.push(join(engineDir, entry.name, 'pyproject.toml'))
    }
  } catch {
    // unreadable engine dir: the launch reports it
  }
  return files
}

/**
 * The venv needs `uv sync` when it is missing, or when a dependency file changed since the app last synced it
 * (e.g. after a git pull added a package). Without our stamp, `pyvenv.cfg` stands in for "last synced".
 */
export function venvNeedsSync(engineDir: string): boolean {
  if (!isExecutable(engineBinary(engineDir))) return true
  const venv = join(engineDir, '.venv')
  const synced = mtime(join(venv, SYNC_STAMP)) || mtime(join(venv, 'pyvenv.cfg'))
  return dependencyFiles(engineDir).some((f) => mtime(f) > synced)
}

export function markVenvSynced(engineDir: string): void {
  // Writing (rather than utimes with a millisecond Date) keeps the filesystem's full mtime precision.
  writeFileSync(join(engineDir, '.venv', SYNC_STAMP), `${new Date().toISOString()}\n`)
}

/**
 * How to launch the engine:
 * - `FVWKS_ENGINE_CMD='["node","fake.mjs"]'` runs any command (tests).
 * - A packaged app with an engine bundle runs `<bundle>/bin/fvwks-engine` (no uv), models under `<data>/models`.
 * - Otherwise `<engine>/.venv/bin/fvwks-engine`, after a one-time `uv sync --all-packages` if the venv is
 *   missing. Every launch adds `--export-dir <dir> --exit-with-parent`; the port is 0 and the engine
 *   announces the one it bound (`FVWKS_ENGINE_READY port=N`).
 */
export function resolveEngineLaunch(opts: ResolveOptions): EngineLaunch {
  const env: NodeJS.ProcessEnv = { ...opts.env }
  // A shell's active venv would confuse uv; ELECTRON_RUN_AS_NODE must never leak into children.
  delete env.VIRTUAL_ENV
  delete env.ELECTRON_RUN_AS_NODE
  env.PYTHONUNBUFFERED = '1'
  const extraArgs = ['--export-dir', opts.exportDir, '--exit-with-parent']

  const overrides = opts.allowOverrides ?? true
  if (overrides && opts.env.FVWKS_ENGINE_CMD) {
    const parsed = JSON.parse(opts.env.FVWKS_ENGINE_CMD) as unknown
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((p) => typeof p === 'string')) {
      throw new Error('FVWKS_ENGINE_CMD must be a JSON array of strings')
    }
    const [command, ...args] = parsed as string[]
    return { command: command!, args, extraArgs, env, describe: parsed.join(' ') }
  }

  if (opts.bundle) {
    const bundleDir = resolve(opts.bundle.dir)
    const bin = join(bundleDir, 'bin', 'fvwks-engine')
    if (!isExecutable(bin)) {
      throw new Error(`The engine inside the app is damaged (${bin} is missing). Reinstall FoxBox.`)
    }
    // A fresh Mac downloads its models next to the app's data, where the disk checks look. HF_HUB_CACHE would
    // override HF_HOME, so an inherited one is dropped.
    const models = bundledModelsDir(resolve(opts.bundle.dataDir))
    env.HF_HOME = models
    delete env.HF_HUB_CACHE
    delete env.HUGGINGFACE_HUB_CACHE
    // The installer measures free space on the cache folder's parent, which must exist on a first launch.
    mkdirSync(models, { recursive: true })
    return {
      command: bin,
      args: [],
      extraArgs,
      // Never inside the (signed, read-only) app bundle.
      cwd: resolve(opts.bundle.dataDir),
      env,
      describe: `${bin} ${extraArgs.join(' ')} (bundled engine, HF_HOME=${models})`,
    }
  }

  const engineDir = resolve(opts.engineDir)
  const bin = engineBinary(engineDir)
  const uv = findUv(overrides ? opts.env : { ...opts.env, FVWKS_UV: undefined })
  let setup: SetupStep | undefined
  if (uv) {
    const update = isExecutable(bin)
    setup = {
      command: uv,
      args: ['sync', '--all-packages'],
      cwd: engineDir,
      describe: update ? 'Updating the engine (uv sync)…' : 'Installing the engine (uv sync)…',
      kind: update ? 'update' : 'install',
      needed: () => venvNeedsSync(engineDir),
      onSuccess: () => markVenvSynced(engineDir),
    }
  } else if (!isExecutable(bin)) {
    throw new Error(
      `The engine is not installed (${bin} is missing) and uv was not found. Install uv (https://docs.astral.sh/uv/) or set FVWKS_UV.`,
    )
  }
  return {
    command: bin,
    args: [],
    extraArgs,
    cwd: engineDir,
    env,
    ...(setup ? { setup } : {}),
    describe: `${bin} ${extraArgs.join(' ')}`,
  }
}
