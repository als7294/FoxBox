// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AbletonBridge, AbletonView } from '../../../src/shared/ableton'
import { AbletonDeviceRow } from '../../../src/renderer/src/components/fb/AbletonDeviceRow'

afterEach(cleanup)

const SUITE = { edition: 'Suite', version: 12, maxForLive: 'yes' as const }
function api(view: AbletonView, install?: AbletonBridge['install']): AbletonBridge {
  return {
    status: async () => view,
    install: install ?? (async () => ({ ok: true, view: { ...view, installed: true, port: 47400 } })),
    remove: async () => ({ ok: true, view }),
    show: vi.fn(async () => {}),
  }
}

describe('THE DEVICE row (S5: Found → Installing → Installed ✓, or not found)', () => {
  it('Live found → Install → Installing… → Installed ✓ → Show in Live', async () => {
    let finish!: () => void
    const bridge = api({ installed: false, port: null, live: SUITE }, () => new Promise((r) => (finish = () => r({ ok: true, view: { installed: true, port: 47400, live: SUITE } }))))
    render(<AbletonDeviceRow api={bridge} />)
    expect(await screen.findByText('Live found')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(await screen.findByText('Installing…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Install' })).toBeDisabled()
    finish()
    expect(await screen.findByText('Installed ✓')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show in Live' }))
    expect(bridge.show).toHaveBeenCalled()
  })

  it('says why when it can not install: no Live, Live Lite, or a failure', async () => {
    render(<AbletonDeviceRow api={api({ installed: false, port: null, live: null })} />)
    expect(await screen.findByText('Live not found')).toBeInTheDocument()
    expect(screen.getByText("Live isn't on this Mac. The virtual port works with any DAW.")).toBeInTheDocument()
    cleanup()
    render(<AbletonDeviceRow api={api({ installed: false, port: null, live: { edition: 'Lite', version: 12, maxForLive: 'no' } })} />)
    expect(await screen.findByText('Needs Live Suite')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()
    render(<AbletonDeviceRow api={api({ installed: false, port: null, live: SUITE }, async () => ({ ok: false, error: 'UDP ports 47400–47409 are all in use.' }))} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('UDP ports 47400–47409 are all in use.')
  })
})
