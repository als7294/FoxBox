import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EngineStatus } from '../../../src/shared/bridge'
import { EngineSupervisor, type SupervisorOptions } from '../../../src/main/engine/supervisor'

const FAKE = resolve(__dirname, '../../fixtures/fake-engine.mjs')
const dirs: string[] = []
const supervisors: EngineSupervisor[] = []

function make(env: Record<string, string> = {}, extra: Partial<SupervisorOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fvwks-sup-'))
  dirs.push(dir)
  const sup = new EngineSupervisor({
    command: process.execPath,
    args: [FAKE],
    extraArgs: ['--export-dir', join(dir, 'exports'), '--exit-with-parent'],
    env: { ...process.env, ...env },
    token: 'tok-' + Math.random().toString(36).slice(2),
    dataDir: join(dir, 'data'),
    logFile: join(dir, 'logs', 'engine.log'),
    pidFile: join(dir, 'engine.pid'),
    staleMatch: 'fake-engine',
    startTimeoutMs: 4_000,
    healthIntervalMs: 50,
    livenessIntervalMs: 100,
    backoffMs: [50, 100],
    maxAttempts: 4,
    stopTimeoutMs: 600,
    ...extra,
  })
  supervisors.push(sup)
  return { sup, dir }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const until = (sup: EngineSupervisor, state: EngineStatus['state']) =>
  new Promise<EngineStatus>((r) => sup.on('status', (s: EngineStatus) => s.state === state && r(s)))

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((s) => s.stop()))
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('EngineSupervisor', () => {
  it('spawns the engine, learns the port from the READY line and waits for an authenticated /api/health', async () => {
    const { sup, dir } = make()
    const states: string[] = []
    sup.on('status', (s: EngineStatus) => states.push(s.state))
    await sup.start()
    expect(await sup.waitUntilReady(5_000)).toBe(true)
    expect(sup.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const st = sup.getStatus()
    expect(st.state).toBe('ready')
    expect(st.url).toBe(sup.url)
    expect(st.pid).toBeGreaterThan(0)
    expect(st.health).toMatchObject({ state: 'ready', export_dir: join(dir, 'exports') })
    expect(states).toContain('starting')
    const echo = await sup.request('/api/echo', { method: 'POST', body: 'hi', headers: { 'content-type': 'text/plain' } })
    expect(await echo.json()).toMatchObject({ method: 'POST', body: 'hi', contentType: 'text/plain' })
    await sup.stop()
    const log = readFileSync(join(dir, 'logs', 'engine.log'), 'utf8')
    // The token is never on the command line (ps shows argv to every local user).
    expect(log).toContain('(token in env)')
    expect(log).not.toContain('--token')
    expect(log).not.toContain(sup.token)
    expect(log).toContain('FVWKS_ENGINE_READY')
  })

  it('tolerates a slow start', async () => {
    const { sup } = make({ FAKE_ENGINE_DELAY_MS: '600' })
    await sup.start()
    expect(await sup.waitUntilReady(5_000)).toBe(true)
  })

  it('restarts the engine after a crash and follows it to its new port', async () => {
    const { sup } = make({ FAKE_ENGINE_CRASH_ONCE: '1' })
    const seen: string[] = []
    sup.on('status', (s: EngineStatus) => seen.push(s.state))
    await sup.start()
    // The first launch becomes ready, then dies 150 ms later.
    await new Promise((r) => setTimeout(r, 1_200))
    const st = sup.getStatus()
    expect(seen).toContain('restarting')
    expect(st.state).toBe('ready')
    expect(st.restarts).toBe(1)
    expect(st.lastExit?.code).toBe(3)
    expect(st.url).toBe(sup.url)
    expect(sup.url).not.toBe('')
  })

  it('goes offline after too many consecutive failures', async () => {
    const { sup } = make({ FAKE_ENGINE_CRASH_MS: '20' }, { maxAttempts: 3 })
    const offline = until(sup, 'offline')
    await sup.start()
    const st = await offline
    expect(st.attempt).toBe(3)
    expect(st.lastError).toMatch(/exited/)
    expect(sup.url).toBe('')
  })

  it('kills the engine on stop, escalating to SIGKILL when SIGTERM is ignored', async () => {
    const { sup } = make({ FAKE_ENGINE_IGNORE_TERM: '1' })
    await sup.start()
    await sup.waitUntilReady(5_000)
    const pid = sup.getStatus().pid!
    expect(alive(pid)).toBe(true)
    const t0 = Date.now()
    await sup.stop()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500)
    expect(alive(pid)).toBe(false)
    expect(sup.getStatus().state).toBe('stopped')
  })

  it('kills and retries an engine that never becomes healthy', async () => {
    const { sup } = make({ FAKE_ENGINE_NEVER_HEALTHY: '1' }, { startTimeoutMs: 300, maxAttempts: 2 })
    const offline = until(sup, 'offline')
    await sup.start()
    const firstPid = sup.getStatus().pid!
    const st = await offline
    expect(st.lastError).toMatch(/did not answer/)
    expect(alive(firstPid)).toBe(false)
  })

  it('manual restart relaunches and counts the restart', async () => {
    const { sup } = make()
    await sup.start()
    await sup.waitUntilReady(5_000)
    const pid = sup.getStatus().pid!
    await sup.restart()
    expect(await sup.waitUntilReady(5_000)).toBe(true)
    expect(sup.getStatus().pid).not.toBe(pid)
    expect(sup.getStatus().restarts).toBe(1)
    expect(alive(pid)).toBe(false)
  })

  it('runs the setup step first when needed (e.g. uv sync for a missing venv)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fvwks-setup-'))
    dirs.push(dir)
    const marker = join(dir, 'venv-ready')
    const details: string[] = []
    const setups: (string | null)[] = []
    const { sup } = make(
      {},
      {
        setup: {
          command: process.execPath,
          args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ok')`],
          describe: 'Updating the engine (uv sync)…',
          kind: 'update',
          needed: () => !existsSync(marker),
        },
      },
    )
    sup.on('status', (s: EngineStatus) => {
      if (s.detail) details.push(s.detail)
      if (setups.at(-1) !== s.setup) setups.push(s.setup)
    })
    await sup.start()
    expect(await sup.waitUntilReady(5_000)).toBe(true)
    expect(existsSync(marker)).toBe(true)
    expect(details).toContain('Updating the engine (uv sync)…')
    // The pill says UPDATING ENGINE while the step runs, then it clears.
    expect(setups).toEqual(['update', null])
    expect(sup.getStatus().setup).toBeNull()
  })

  it('re-runs setup once when the engine dies during startup (stale venv self-heal)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fvwks-heal-'))
    dirs.push(dir)
    const dep = join(dir, 'mutagen-installed')
    let runs = 0
    const { sup } = make(
      { FAKE_ENGINE_REQUIRE_FILE: dep },
      {
        setup: {
          command: process.execPath,
          args: ['-e', `require('fs').writeFileSync(${JSON.stringify(dep)}, 'ok')`],
          describe: 'uv sync',
          needed: () => false,
          onSuccess: () => runs++,
        },
      },
    )
    await sup.start()
    expect(await sup.waitUntilReady(8_000)).toBe(true)
    expect(runs).toBe(1)
    expect(sup.getStatus().restarts).toBe(1)
  })

  it('goes offline with a clear error when setup fails', async () => {
    const { sup } = make(
      {},
      { setup: { command: process.execPath, args: ['-e', 'process.exit(4)'], describe: 'uv sync', needed: () => true } },
    )
    const offline = until(sup, 'offline')
    await sup.start()
    expect((await offline).lastError).toMatch(/couldn't be installed.*exit 4/)
  })

  it('the engine exits by itself when its parent goes away (--exit-with-parent)', async () => {
    // Simulate the app dying: a parent node process spawns the fake engine with a stdin pipe, then exits.
    const dir = mkdtempSync(join(tmpdir(), 'fvwks-orphan-'))
    dirs.push(dir)
    const pidFile = join(dir, 'child.pid')
    const script = `
      const { spawn } = require('child_process')
      const c = spawn(process.execPath, [${JSON.stringify(FAKE)}, '--port', '0', '--token', 't', '--data-dir', ${JSON.stringify(join(dir, 'd'))}, '--exit-with-parent'], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] })
      require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid))
      setTimeout(() => process.exit(0), 300)
    `
    await new Promise((r) => spawn(process.execPath, ['-e', script], { stdio: 'ignore' }).on('exit', r))
    const pid = Number(readFileSync(pidFile, 'utf8'))
    const deadline = Date.now() + 3_000
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    expect(alive(pid)).toBe(false)
  })

  it('kills an engine left over from a crashed previous run', async () => {
    const { sup, dir } = make()
    const dataDir = join(dir, 'data')
    const stale = spawn(process.execPath, [FAKE, '--port', '0', '--token', 'x', '--data-dir', dataDir], {
      detached: true,
      stdio: 'ignore',
    })
    writeFileSync(join(dir, 'engine.pid'), JSON.stringify({ pid: stale.pid }))
    await new Promise((r) => setTimeout(r, 200))
    expect(alive(stale.pid!)).toBe(true)
    await sup.start()
    expect(alive(stale.pid!)).toBe(false)
    expect(await sup.waitUntilReady(5_000)).toBe(true)
  })
})
