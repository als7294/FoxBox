import { accessSync, constants, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import type { SetupStep } from './supervisor'

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
