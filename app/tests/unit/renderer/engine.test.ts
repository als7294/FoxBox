// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineStatus as Status } from '../../../src/shared/bridge'
import { EngineStatus } from '../../../src/renderer/src/components/layout/EngineStatus'
import { bootStage, reached } from '../../../src/renderer/src/state/bootStage'
import { engineView, useEngine, watchEngineRestarts } from '../../../src/renderer/src/state/engine'
import { useUi } from '../../../src/renderer/src/state/ui'

afterEach(cleanup)

const status = (patch: Partial<Status>): Status => ({
  state: 'ready',
  url: '',
  pid: 100,
  restarts: 0,
  attempt: 0,
  startedAt: null,
  readyAt: null,
  lastExit: null,
  lastError: null,
  detail: null,
  setup: null,
  health: { state: 'ready', version: '0.1.0', voice_engine: 'kokoro', fx_engine: 'fvwks-rack', disk_free_bytes: 1e11, data_dir: '/d', export_dir: '/e' },
  nextRetryAt: null,
  logFile: null,
  ...patch,
})

describe('engine store', () => {
  it('bumps the epoch only when a real new engine is ready (queries re-key on it)', () => {
    const { setStatus } = useEngine.getState()
    setStatus(status({ state: 'starting', pid: 100 }))
    const e0 = useEngine.getState().epoch
    setStatus(status({ pid: 100 }))
    expect(useEngine.getState().epoch).toBe(e0 + 1)
    // The process died: "ready" without a pid must not look like a new engine (lists would blank out).
    setStatus(status({ pid: null }))
    setStatus(status({ state: 'restarting', pid: null }))
    expect(useEngine.getState().epoch).toBe(e0 + 1)
    setStatus(status({ state: 'starting', pid: 200 }))
    setStatus(status({ pid: 200 }))
    expect(useEngine.getState().epoch).toBe(e0 + 2)
  })

  it('shows an engine that reports an error as ERROR, not READY', () => {
    expect(engineView(status({}))).toBe('ready')
    expect(engineView(status({ health: { state: 'error', message: 'espeak-ng missing' } }))).toBe('error')
    expect(engineView(status({ health: { state: 'loading_model', progress: 0.4 } }))).toBe('loading')
  })
})

describe('engine status pill', () => {
  it('shows start-up states only while booting; afterwards an engine coming back reads RECONNECTING', () => {
    useUi.getState().setBooting(true)
    useEngine.getState().setStatus(status({ state: 'starting', pid: null, health: null, setup: 'update', detail: 'Updating the engine (uv sync)…' }))
    render(createElement(EngineStatus))
    const pill = screen.getByTestId('engine-status')
    expect(pill).toHaveTextContent('UPDATING ENGINE')
    expect(pill).toHaveAttribute('title', 'Updating the engine (uv sync)…')
    expect(pill).toHaveAttribute('data-tone', 'busy')
    act(() => useEngine.getState().setStatus(status({ state: 'starting', pid: null, health: null, setup: 'install' })))
    expect(screen.getByTestId('engine-status')).toHaveTextContent('INSTALLING ENGINE')
    act(() => useEngine.getState().setStatus(status({ state: 'starting', pid: 7, health: null, setup: null })))
    expect(screen.getByTestId('engine-status')).toHaveTextContent('STARTING')
    // After the boot screen: never the normal start-up states.
    act(() => useUi.getState().setBooting(false))
    expect(screen.getByTestId('engine-status')).toHaveTextContent('RECONNECTING')
    act(() => useEngine.getState().setStatus(status({})))
    expect(screen.getByTestId('engine-status')).toHaveTextContent('READY')
  })
})

describe('boot stages (the boot screen is a real loading screen)', () => {
  const health = (h: Record<string, unknown>) => ({ version: '1.0.0', voice_engine: 'kokoro', fx_engine: 'fvwks-rack', disk_free_bytes: 1e11, data_dir: '/d', export_dir: '/e', ...h })

  it('walks setup → spawn → engine → model (with progress) → warming → ready, monotonic', () => {
    const seq = [
      bootStage(status({ state: 'starting', pid: null, health: null, setup: 'update', detail: 'Updating the engine (uv sync)…' })),
      bootStage(status({ state: 'starting', pid: null, health: null })),
      bootStage(status({ state: 'starting', pid: 7, health: null })),
      bootStage(status({ state: 'ready', health: health({ state: 'starting' }) })),
      bootStage(status({ state: 'ready', health: health({ state: 'loading_model', progress: 0.5, message: 'Downloading Kokoro 82M: 0.2 of 0.4 GB' }) })),
      bootStage(status({ state: 'ready', health: health({ state: 'loading_model', progress: 1, message: 'Loading the voice model' }) })),
      bootStage(status({ state: 'ready', health: health({ state: 'ready' }) })),
    ]
    expect(seq.map((s) => s.id)).toEqual(['setup', 'spawn', 'engine', 'engine', 'model', 'warming', 'ready'])
    for (let i = 1; i < seq.length; i++) expect(seq[i]!.pct).toBeGreaterThanOrEqual(seq[i - 1]!.pct)
    expect(seq[4]!.pct).toBe(55)
    expect(seq[4]!.detail).toMatch(/Downloading Kokoro/)
    expect(seq.at(-1)!.pct).toBe(100)
    expect(reached(seq[5]!, 'model')).toBe(true)
    expect(reached(seq[3]!, 'ready')).toBe(false)
  })

  it('fails on an offline engine or a health error, and the mock engine is ready at once', () => {
    expect(bootStage(status({ state: 'offline', pid: null, health: null, lastError: 'uv not found' }))).toMatchObject({ id: 'error', detail: 'uv not found' })
    expect(bootStage(status({ state: 'ready', health: health({ state: 'error', message: "Couldn't install Kokoro 82M" }) }))).toMatchObject({ id: 'error', detail: "Couldn't install Kokoro 82M" })
    expect(bootStage(status({ state: 'mock' })).id).toBe('ready')
  })
})

describe('engine restarts after boot', () => {
  it('toasts a quiet restart and its return, but not while booting', () => {
    const notify = { info: vi.fn(), success: vi.fn() }
    let booting = true
    useEngine.getState().setStatus(status({}))
    const stop = watchEngineRestarts(() => booting, notify)
    useEngine.getState().setStatus(status({ state: 'starting', pid: 200, health: null }))
    useEngine.getState().setStatus(status({ pid: 200 }))
    expect(notify.info).not.toHaveBeenCalled()
    booting = false
    useEngine.getState().setStatus(status({ state: 'starting', pid: 300, health: null }))
    expect(notify.info).toHaveBeenCalledWith('RECONNECTING TO THE ENGINE', expect.anything())
    useEngine.getState().setStatus(status({ pid: 300 }))
    expect(notify.success).toHaveBeenCalledWith('ENGINE READY')
    stop()
  })
})
