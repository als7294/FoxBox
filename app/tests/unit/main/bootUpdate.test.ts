import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BootUpdateState, UpdateState } from '../../../src/shared/bridge'
import { BOOT_DOWNLOAD_ATTEMPTS, bootSkipReason, BootUpdateGate, decideAfterCheck, type BootUpdater } from '../../../src/main/bootUpdate'
import { Updater } from '../../../src/main/updater'

// The update check at boot against a fake Updater (the real one's network and install are tested in updater.test).

const FEED = 'https://updates.example.com/foxbox/latest-mac.json'

const base = (patch: Partial<UpdateState> = {}): UpdateState => ({
  phase: 'idle',
  current: '1.4.0',
  latest: null,
  sizeBytes: null,
  released: null,
  notes: [],
  download: null,
  error: null,
  feedUrl: FEED,
  feedIsDefault: true,
  defaultFeedUrl: FEED,
  hasToken: false,
  lastChecked: null,
  allowLocalFeed: false,
  installBlocked: null,
  whatsNew: null,
  ...patch,
})

const available = base({ phase: 'available', latest: '1.5.0', sizeBytes: 3_100_000 })
const downloadError = base({
  phase: 'error',
  latest: '1.5.0',
  error: { during: 'download', code: 'network', message: 'The download failed: offline' },
})

/** Scripted answers for check / download / install; download pushes progress like the real Updater. */
class FakeUpdater extends EventEmitter<{ state: [UpdateState] }> implements BootUpdater {
  checks: number[] = []
  downloads = 0
  installs: { required: boolean }[] = []
  constructor(
    private readonly answers: { check: () => Promise<UpdateState>; download?: UpdateState[]; install?: UpdateState },
    private state = base(),
  ) {
    super()
  }
  getState = () => this.state
  check = async (timeoutMs?: number) => {
    this.checks.push(timeoutMs ?? -1)
    this.state = await this.answers.check()
    return this.state
  }
  download = async () => {
    this.downloads++
    this.emit(
      'state',
      base({
        phase: 'downloading',
        latest: '1.5.0',
        sizeBytes: 3_100_000,
        download: { bytes_done: 1_000_000, bytes_total: 3_100_000, rate_bps: 500_000, eta_s: 5 },
      }),
    )
    this.state = this.answers.download?.[this.downloads - 1] ?? downloadError
    return this.state
  }
  install = async (o: { required: boolean }) => {
    this.installs.push(o)
    this.state = this.answers.install ?? base({ phase: 'installing', latest: '1.5.0' })
    return this.state
  }
}

function gate(u: BootUpdater, o: { skip?: string | null; timeoutMs?: number } = {}) {
  const g = new BootUpdateGate({ updater: u, current: '1.4.0', skip: o.skip ?? null, timeoutMs: o.timeoutMs ?? 50 })
  const states: BootUpdateState[] = []
  g.on('state', (s) => states.push(s))
  return { g, states }
}

describe('decideAfterCheck', () => {
  it('requires a newer version, clears when up to date, and fails (CONTINUE) otherwise', () => {
    expect(decideAfterCheck(available)).toEqual({ next: 'required' })
    expect(decideAfterCheck(base({ phase: 'up-to-date' }))).toEqual({ next: 'clear' })
    expect(decideAfterCheck(null)).toMatchObject({ next: 'failed', error: expect.stringMatching(/in time/) })
    expect(
      decideAfterCheck(base({ phase: 'error', error: { during: 'check', code: 'network', message: "Couldn't reach the update server." } })),
    ).toEqual({
      next: 'failed',
      error: "Couldn't reach the update server.",
    })
    // A copy that can't replace itself (read-only folder, translocated) never gets stuck downloading.
    expect(decideAfterCheck({ ...available, installBlocked: 'Move FoxBox to your Applications folder.' })).toMatchObject({
      next: 'failed',
      error: expect.stringMatching(/^FoxBox 1\.5\.0 is required\. Move/),
    })
  })
})

describe('bootSkipReason', () => {
  it('skips development builds, the opt-out, Setup, no feed and a rolled-back update', () => {
    const run = { packaged: true, firstRun: false, optOut: false, state: base() }
    expect(bootSkipReason(run)).toBeNull()
    expect(bootSkipReason({ ...run, packaged: false })).toMatch(/development/)
    expect(bootSkipReason({ ...run, optOut: true })).toMatch(/FVWKS_SKIP_BOOT_UPDATE/)
    expect(bootSkipReason({ ...run, firstRun: true })).toMatch(/Setup/)
    expect(bootSkipReason({ ...run, state: base({ feedUrl: null }) })).toMatch(/no update source/)
    expect(
      bootSkipReason({ ...run, state: base({ phase: 'error', error: { during: 'install', code: 'rolled_back', message: '' } }) }),
    ).toMatch(/rolled back/)
  })
})

describe('BootUpdateGate', () => {
  it('skipped: clear from the start, no check', async () => {
    const u = new FakeUpdater({ check: async () => available })
    const { g } = gate(u, { skip: 'development build' })
    expect(g.getState().phase).toBe('clear')
    expect((await g.run()).phase).toBe('clear')
    expect(u.checks).toEqual([])
  })

  it('not required: clear after the check (with the short timeout)', async () => {
    const u = new FakeUpdater({ check: async () => base({ phase: 'up-to-date' }) })
    const { g } = gate(u)
    expect(g.getState().phase).toBe('checking')
    expect((await g.run()).phase).toBe('clear')
    expect(u.checks).toEqual([50])
  })

  it('required: UPDATE REQUIRED with version, size and progress, then installs without the dialog', async () => {
    const u = new FakeUpdater({ check: async () => available, download: [base({ phase: 'ready', latest: '1.5.0' })] })
    const { g, states } = gate(u)
    const end = await g.run()
    expect(end).toMatchObject({ phase: 'required', version: '1.5.0', sizeBytes: 3_100_000, step: 'installing', attempt: 1 })
    expect(states.some((s) => s.phase === 'required' && s.step === 'downloading' && s.download?.bytes_done === 1_000_000)).toBe(true)
    expect(u.installs).toEqual([{ required: true }])
    // No way past it while required.
    expect(g.continue().phase).toBe('required')
  })

  it('a check that never answers: failed after the timeout, then CONTINUE', async () => {
    const u = new FakeUpdater({ check: () => new Promise<UpdateState>(() => {}) })
    const { g } = gate(u, { timeoutMs: 20 })
    const end = await g.run()
    expect(end).toMatchObject({ phase: 'failed', error: expect.stringMatching(/in time/) })
    expect(g.continue().phase).toBe('clear')
  })

  it('offline: failed with the reason, and CONTINUE', async () => {
    const offline = base({ phase: 'error', error: { during: 'check', code: 'network', message: "Couldn't reach the update server." } })
    const { g } = gate(new FakeUpdater({ check: async () => offline }))
    expect(await g.run()).toMatchObject({ phase: 'failed', error: "Couldn't reach the update server." })
    expect(g.continue().phase).toBe('clear')
  })

  it('two failed downloads: failed (CONTINUE), no install', async () => {
    const u = new FakeUpdater({ check: async () => available, download: [downloadError, downloadError, base({ phase: 'ready' })] })
    const { g } = gate(u)
    const end = await g.run()
    expect(u.downloads).toBe(BOOT_DOWNLOAD_ATTEMPTS)
    expect(end).toMatchObject({
      phase: 'failed',
      attempt: 2,
      error: expect.stringMatching(/^Couldn't download FoxBox 1\.5\.0\. The download failed: offline/),
    })
    expect(u.installs).toEqual([])
    expect(g.continue().phase).toBe('clear')
  })

  it('one failed download, then a good one: installs', async () => {
    const u = new FakeUpdater({ check: async () => available, download: [downloadError, base({ phase: 'ready', latest: '1.5.0' })] })
    const { g } = gate(u)
    expect(await g.run()).toMatchObject({ phase: 'required', step: 'installing', attempt: 2 })
    expect(u.installs).toHaveLength(1)
  })

  it('an install that fails (rolled back in place): failed, CONTINUE on this version', async () => {
    const failed = base({
      phase: 'error',
      error: { during: 'install', code: 'install_failed', message: 'Update failed, still on v1.4.0. Disk full.' },
    })
    const u = new FakeUpdater({ check: async () => available, download: [base({ phase: 'ready' })], install: failed })
    const { g } = gate(u)
    expect(await g.run()).toMatchObject({ phase: 'failed', error: 'Update failed, still on v1.4.0. Disk full.' })
  })
})

describe('with the real Updater (no network: fetch is injected)', () => {
  const dirs: string[] = []
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

  it("aborts a feed that doesn't answer at the boot timeout", async () => {
    const userData = mkdtempSync(join(tmpdir(), 'fvwks-boot-'))
    dirs.push(userData)
    const hang = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))),
    )
    const updater = new Updater({
      currentVersion: '1.4.0',
      userData,
      packaged: true,
      appBundle: null,
      fetch: hang as unknown as typeof fetch,
      defaultFeedUrl: FEED,
    })
    const { g } = gate(updater, { timeoutMs: 30 })
    const started = Date.now()
    const end = await g.run()
    expect(Date.now() - started).toBeLessThan(500)
    expect(end.phase).toBe('failed')
    expect(hang).toHaveBeenCalledOnce()
    expect(updater.getState().error?.during).toBe('check')
  })
})
