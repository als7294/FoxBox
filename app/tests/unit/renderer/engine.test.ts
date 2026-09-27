// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { EngineStatus as Status } from '../../../src/shared/bridge'
import { EngineStatus } from '../../../src/renderer/src/components/layout/EngineStatus'
import { engineView, useEngine } from '../../../src/renderer/src/state/engine'

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
  it('says UPDATING / INSTALLING ENGINE while uv sync runs, and STARTING once the engine launches', () => {
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
  })
})
