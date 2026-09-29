import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { engineBinary, markVenvSynced, resolveEngineLaunch, venvNeedsSync } from '../../../src/main/engine/command'
import { cartridgePng, encodePng } from '../../../src/main/png'
import { contentSecurityPolicy } from '../../../build/csp'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('drag icon', () => {
  it('is a real, non-empty PNG', () => {
    const png = cartridgePng(64)
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(png.readUInt32BE(16)).toBe(64) // IHDR width
    expect(png.readUInt32BE(20)).toBe(64)
    expect(png.length).toBeGreaterThan(100)
    expect(encodePng(1, 1, new Uint8Array([255, 0, 0, 255])).length).toBeGreaterThan(50)
  })
})

describe('engine launch', () => {
  it('uses the venv binary with --export-dir and --exit-with-parent, and uv sync only when the venv is missing', () => {
    const engine = mkdtempSync(join(tmpdir(), 'fvwks-engine-'))
    dirs.push(engine)
    const uvDir = join(engine, 'bin')
    mkdirSync(uvDir)
    writeFileSync(join(uvDir, 'uv'), '#!/bin/sh\n')
    chmodSync(join(uvDir, 'uv'), 0o755)
    const launch = resolveEngineLaunch({ env: { PATH: uvDir, HOME: engine, VIRTUAL_ENV: '/x' }, engineDir: engine, exportDir: '/tmp/exports' })
    expect(launch.command).toBe(engineBinary(engine))
    expect(launch.extraArgs).toEqual(['--export-dir', '/tmp/exports', '--exit-with-parent'])
    expect(launch.env.VIRTUAL_ENV).toBeUndefined()
    expect(launch.setup?.args).toEqual(['sync', '--all-packages'])
    expect(launch.setup?.needed()).toBe(true)
    expect(launch.setup?.kind).toBe('install')
    mkdirSync(join(engine, '.venv', 'bin'), { recursive: true })
    writeFileSync(engineBinary(engine), '#!/bin/sh\n')
    chmodSync(engineBinary(engine), 0o755)
    expect(launch.setup?.needed()).toBe(false)
    // With the engine installed, a later sync (dependencies changed) is an update.
    const again = resolveEngineLaunch({ env: { PATH: uvDir, HOME: engine }, engineDir: engine, exportDir: '/tmp/exports' })
    expect(again.setup?.kind).toBe('update')
    expect(again.setup?.describe).toMatch(/^Updating the engine/)
  })

  it('re-syncs when a dependency file changes after the last sync', () => {
    const engine = mkdtempSync(join(tmpdir(), 'fvwks-deps-'))
    dirs.push(engine)
    mkdirSync(join(engine, '.venv', 'bin'), { recursive: true })
    mkdirSync(join(engine, 'server'))
    writeFileSync(engineBinary(engine), '#!/bin/sh\n')
    chmodSync(engineBinary(engine), 0o755)
    writeFileSync(join(engine, 'server', 'pyproject.toml'), '[project]\n')
    expect(venvNeedsSync(engine)).toBe(true) // never synced by the app, no pyvenv.cfg
    markVenvSynced(engine)
    expect(venvNeedsSync(engine)).toBe(false)
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(engine, 'server', 'pyproject.toml'), later, later) // e.g. git pull added mutagen
    expect(venvNeedsSync(engine)).toBe(true)
  })

  it('FVWKS_ENGINE_CMD overrides the command (tests)', () => {
    const launch = resolveEngineLaunch({ env: { FVWKS_ENGINE_CMD: '["node","fake.mjs"]' }, engineDir: '/nope', exportDir: '/e' })
    expect(launch.command).toBe('node')
    expect(launch.args).toEqual(['fake.mjs'])
  })

  it('explains a missing engine without uv', () => {
    expect(() => resolveEngineLaunch({ env: { PATH: '/nonexistent', HOME: '/nonexistent' }, engineDir: '/nonexistent/engine', exportDir: '/e' })).toThrow(/not installed/)
  })
})

describe('CSP', () => {
  it('never allows the engine directly, eval, or remote scripts in production', () => {
    const csp = contentSecurityPolicy('build')
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval';")
    expect(csp).not.toContain('127.0.0.1')
    // WebAssembly may compile (the camera clip's face detector); JS eval stays off.
    expect(csp).not.toContain("'unsafe-eval'")
    expect(csp).toContain("connect-src 'self' vbx: blob:;")
  })
})
