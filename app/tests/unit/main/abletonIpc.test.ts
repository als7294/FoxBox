import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { registerAbletonIpc } from '../../../src/main/ableton/ipc'
import { ABLETON_IPC } from '../../../src/shared/ableton'

function setup(trusted = true) {
  const home = mkdtempSync(join(tmpdir(), 'fb-ableton-ipc-'))
  const appsDir = join(home, 'Applications')
  mkdirSync(join(appsDir, 'Ableton Live 12 Suite.app'), { recursive: true })
  const handlers = new Map<string, (e: unknown) => unknown>()
  const deps = {
    where: () => ({ userData: join(home, 'fb'), home, library: join(home, 'Lib'), appsDir }),
    trusted: () => trusted,
    openPath: vi.fn(async () => ''),
    showItem: vi.fn(),
  }
  registerAbletonIpc({ handle: (ch: string, fn: (e: unknown) => unknown) => void handlers.set(ch, fn) } as never, deps)
  const call = (ch: string) => handlers.get(ch)!({})
  return { call, deps, appsDir }
}

describe('Settings → MIDI & Ableton: the main side', () => {
  it('status, install, show in Live, remove', async () => {
    const { call, deps, appsDir } = setup()
    expect(await call(ABLETON_IPC.status)).toEqual({ installed: false, port: null, live: { edition: 'Suite', version: 12, maxForLive: 'yes' } })
    const done = (await call(ABLETON_IPC.install)) as { ok: true; view: { installed: boolean; port: number } }
    expect(done.ok && done.view.installed).toBe(true)
    expect(done.view.port).toBeGreaterThanOrEqual(47400)
    await call(ABLETON_IPC.show)
    expect(deps.openPath).toHaveBeenCalledWith(join(appsDir, 'Ableton Live 12 Suite.app'))
    expect(await call(ABLETON_IPC.remove)).toEqual({ ok: true, view: { installed: false, port: null, live: expect.anything() } })
  })

  it('refuses a window it does not trust', async () => {
    const { call } = setup(false)
    expect(await call(ABLETON_IPC.status)).toBeNull()
    expect(await call(ABLETON_IPC.install)).toEqual({ ok: false, error: 'Refused.' })
  })
})
