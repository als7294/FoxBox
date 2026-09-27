import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bundledEngineDir,
  clearEngineQuarantine,
  ENGINE_BUNDLE_MARKER,
  isTranslocated,
  MOVE_TO_APPLICATIONS,
  resolveEngineLaunch,
} from '../../../src/main/engine/command'
import { hasSetupMarker, requiredMissing, setupMarkerPath, shouldShowSetup, writeSetupMarker } from '../../../src/main/setup'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

/** A Resources folder holding an engine bundle as bundle_engine.sh lays it out. */
function fakeResources(opts: { marker?: boolean; launcher?: boolean } = {}): string {
  const resources = temp('fvwks-resources-')
  const engine = join(resources, 'engine')
  mkdirSync(join(engine, 'bin'), { recursive: true })
  if (opts.marker ?? true) writeFileSync(join(engine, ENGINE_BUNDLE_MARKER), '')
  if (opts.launcher ?? true) {
    writeFileSync(join(engine, 'bin', 'fvwks-engine'), '#!/bin/sh\n')
    chmodSync(join(engine, 'bin', 'fvwks-engine'), 0o755)
  }
  return resources
}

describe('bundled engine launch', () => {
  it('finds the bundle only by its marker', () => {
    const withMarker = fakeResources()
    expect(bundledEngineDir(withMarker)).toBe(join(withMarker, 'engine'))
    expect(bundledEngineDir(fakeResources({ marker: false }))).toBeNull()
    expect(bundledEngineDir(temp('fvwks-empty-'))).toBeNull()
  })

  it('runs bin/fvwks-engine with no uv and no setup step, models under <data>/models (HF_HOME)', () => {
    const resources = fakeResources()
    const data = join(temp('fvwks-data-'), 'FoxBox')
    const launch = resolveEngineLaunch({
      // Even with uv on PATH and an inherited Hugging Face cache, the bundle uses neither.
      env: { PATH: '/opt/homebrew/bin', HOME: '/Users/x', HF_HUB_CACHE: '/elsewhere/hub', HUGGINGFACE_HUB_CACHE: '/old', VIRTUAL_ENV: '/venv' },
      engineDir: '/nonexistent/engine',
      exportDir: '/Users/x/Music/FoxBox',
      allowOverrides: false,
      bundle: { dir: join(resources, 'engine'), dataDir: data },
    })
    expect(launch.command).toBe(join(resources, 'engine', 'bin', 'fvwks-engine'))
    expect(launch.args).toEqual([])
    expect(launch.extraArgs).toEqual(['--export-dir', '/Users/x/Music/FoxBox', '--exit-with-parent'])
    expect(launch.setup).toBeUndefined()
    expect(launch.env.HF_HOME).toBe(join(data, 'models'))
    expect(launch.env.HF_HUB_CACHE).toBeUndefined()
    expect(launch.env.HUGGINGFACE_HUB_CACHE).toBeUndefined()
    expect(launch.env.VIRTUAL_ENV).toBeUndefined()
    expect(launch.env.FVWKS_TOKEN).toBeUndefined() // the supervisor adds the token to the child env, never argv
    // Never inside the signed app bundle; the models folder exists for the installer's free-space check.
    expect(launch.cwd).toBe(data)
    expect(existsSync(join(data, 'models'))).toBe(true)
  })

  it('reports a damaged bundle instead of falling back to a linked engine', () => {
    const resources = fakeResources({ launcher: false })
    expect(() =>
      resolveEngineLaunch({ env: {}, engineDir: '/nonexistent', exportDir: '/e', allowOverrides: false, bundle: { dir: join(resources, 'engine'), dataDir: temp('d-') } }),
    ).toThrow(/damaged/)
  })

  it('leaves a linked or development launch exactly as before (no HF_HOME change)', () => {
    const engine = temp('fvwks-engine-')
    mkdirSync(join(engine, '.venv', 'bin'), { recursive: true })
    writeFileSync(join(engine, '.venv', 'bin', 'fvwks-engine'), '#!/bin/sh\n')
    chmodSync(join(engine, '.venv', 'bin', 'fvwks-engine'), 0o755)
    const inherited = resolveEngineLaunch({ env: { PATH: '/nonexistent', HOME: engine, HF_HOME: '/Users/x/.cache/huggingface' }, engineDir: engine, exportDir: '/e', bundle: null })
    expect(inherited.env.HF_HOME).toBe('/Users/x/.cache/huggingface')
    const unset = resolveEngineLaunch({ env: { PATH: '/nonexistent', HOME: engine }, engineDir: engine, exportDir: '/e' })
    expect(unset.env.HF_HOME).toBeUndefined()
    expect(unset.command).toBe(join(engine, '.venv', 'bin', 'fvwks-engine'))
  })
})

describe('quarantine on the bundled engine', () => {
  it('runs xattr -dr com.apple.quarantine on our engine bundle only, without a shell', async () => {
    const engine = join(fakeResources(), 'engine')
    const calls: [string, string[]][] = []
    const lines: string[] = []
    const result = await clearEngineQuarantine(engine, { exec: async (file, args) => void calls.push([file, args]), log: (l) => lines.push(l) })
    expect(result).toBe('cleared')
    expect(calls).toEqual([['/usr/bin/xattr', ['-dr', 'com.apple.quarantine', engine]]])
    expect(lines.join('\n')).toMatch(/cleared com\.apple\.quarantine/)
  })

  it('leaves anything that is not the marked engine bundle alone', async () => {
    const exec = async () => {
      throw new Error('must not run')
    }
    expect(await clearEngineQuarantine(join(fakeResources({ marker: false }), 'engine'), { exec })).toBe('skipped')
    expect(await clearEngineQuarantine(fakeResources(), { exec })).toBe('skipped') // Resources itself, not engine/
  })

  it('a read-only bundle: blocked when still quarantined (move the app), skipped when not', async () => {
    const engine = join(fakeResources(), 'engine')
    const lines: string[] = []
    const calls: string[][] = []
    const notQuarantined = async () => {
      throw new Error('xattr: No such xattr: com.apple.quarantine')
    }
    chmodSync(engine, 0o555)
    try {
      // xattr -p finds the attribute: launching would bring up a Gatekeeper dialog per library.
      const blocked = await clearEngineQuarantine(engine, { exec: async (_f, a) => void calls.push(a), log: (l) => lines.push(l) })
      expect(blocked).toBe('blocked')
      expect(calls.every((a) => a[0] === '-p')).toBe(true) // only looked, never tried to write
      expect(lines.at(-1)).toMatch(/read-only .*quarantined/)
      expect(await clearEngineQuarantine(engine, { exec: notQuarantined, log: (l) => lines.push(l) })).toBe('skipped')
      expect(lines.at(-1)).toMatch(/nothing in it is quarantined/)
    } finally {
      chmodSync(engine, 0o755)
    }
    expect(MOVE_TO_APPLICATIONS).toBe('Move FoxBox to Applications, then open it again.')
  })

  it('tells a refused strip (EPERM, read-only volume) from other failures', async () => {
    const engine = join(fakeResources(), 'engine')
    const lines: string[] = []
    const refused = (message: string, stillThere: boolean) => async (_f: string, a: string[]) => {
      if (a[0] === '-dr') throw new Error(`Command failed: /usr/bin/xattr -dr com.apple.quarantine ${engine}\n${message}`)
      if (!stillThere) throw new Error('No such xattr: com.apple.quarantine')
    }
    const log = (l: string) => lines.push(l)
    expect(await clearEngineQuarantine(engine, { exec: refused('xattr: [Errno 1] Operation not permitted', true), log })).toBe('blocked')
    expect(await clearEngineQuarantine(engine, { exec: refused('xattr: [Errno 30] Read-only file system', true), log })).toBe('blocked')
    expect(lines.at(-1)).toMatch(/cannot clear quarantine/)
    // Refused, but nothing is left quarantined: nothing stops the engine.
    expect(await clearEngineQuarantine(engine, { exec: refused('xattr: [Errno 13] Permission denied', false), log })).toBe('failed')
    // Any other failure is logged and the launch goes ahead.
    expect(await clearEngineQuarantine(engine, { exec: refused('xattr: timed out', true), log })).toBe('failed')
    expect(lines.at(-1)).toMatch(/could not clear quarantine[\s\S]*timed out/)
  })

  it('clears only a bundle inside the app it was given (symlinks resolved)', async () => {
    const resources = fakeResources()
    const engine = join(resources, 'engine')
    const exec = async () => {}
    expect(await clearEngineQuarantine(engine, { exec, within: resources })).toBe('cleared')
    expect(await clearEngineQuarantine(engine, { exec, within: fakeResources() })).toBe('skipped')
    // A link named engine inside the app that points at a bundle somewhere else is refused.
    const other = fakeResources()
    const link = join(temp('fvwks-linked-'), 'engine')
    symlinkSync(join(other, 'engine'), link)
    expect(await clearEngineQuarantine(link, { exec, within: dirname(link) })).toBe('skipped')
  })

  it('knows a translocated app', () => {
    expect(isTranslocated('/private/var/folders/xy/abc/T/AppTranslocation/1234-5678/d/FoxBox.app/Contents/MacOS/FoxBox')).toBe(true)
    expect(isTranslocated('/Applications/FoxBox.app/Contents/MacOS/FoxBox')).toBe(false)
  })
})

describe('first-run Setup window', () => {
  it('opens for a bundled build until setup completes', () => {
    expect(shouldShowSetup({ packaged: true, bundled: true, forceEnv: undefined, markerExists: false })).toBe(true)
    expect(shouldShowSetup({ packaged: true, bundled: true, forceEnv: undefined, markerExists: true })).toBe(false)
  })

  it('never for linked or development builds, unless development forces it', () => {
    expect(shouldShowSetup({ packaged: true, bundled: false, forceEnv: undefined, markerExists: false })).toBe(false)
    expect(shouldShowSetup({ packaged: false, bundled: false, forceEnv: undefined, markerExists: false })).toBe(false)
    expect(shouldShowSetup({ packaged: false, bundled: false, forceEnv: '1', markerExists: false })).toBe(true)
    expect(shouldShowSetup({ packaged: false, bundled: false, forceEnv: '1', markerExists: true })).toBe(false)
  })

  it('ignores FVWKS_FORCE_SETUP in a packaged app', () => {
    expect(shouldShowSetup({ packaged: true, bundled: false, forceEnv: '1', markerExists: false })).toBe(false)
  })

  it('writes the marker atomically', () => {
    const userData = join(temp('fvwks-ud-'), 'FoxBox')
    expect(hasSetupMarker(userData)).toBe(false)
    writeSetupMarker(userData, { version: '0.1.0', bundled: true })
    expect(hasSetupMarker(userData)).toBe(true)
    const marker = JSON.parse(readFileSync(setupMarkerPath(userData), 'utf8')) as { version: string; bundled: boolean; completedAt: string }
    expect(marker).toMatchObject({ version: '0.1.0', bundled: true })
    expect(Date.parse(marker.completedAt)).not.toBeNaN()
  })

  it('reads the required models still missing from GET /api/models, and refuses anything else', () => {
    const models = [
      { id: 'kokoro-82m', required: true, installed: false },
      { id: 'deepfilternet3', required: true, installed: true },
      { id: 'whisper-aligner', required: false, installed: false },
    ]
    expect(requiredMissing(models)).toEqual(['kokoro-82m'])
    expect(requiredMissing(models.map((m) => ({ ...m, installed: true })))).toEqual([])
    expect(requiredMissing({ error: 'x' })).toBeNull()
    expect(requiredMissing([{ required: true }])).toBeNull()
  })
})
