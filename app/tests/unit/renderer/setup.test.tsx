// @vitest-environment jsdom
// 2.1 first-run setup: shows after the launch (not with WHAT'S NEW), each pick sets its pref and moves on, Esc skips
// with the defaults, and it's done for good.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { usePlayPrefs } from '../../../src/renderer/src/components/camera/playPrefs'
import { Setup, useSetup } from '../../../src/renderer/src/components/fb/Setup'
import { useProd } from '../../../src/renderer/src/components/prod/prodStore'
import { useUi } from '../../../src/renderer/src/state/ui'

afterEach(cleanup)
beforeEach(() => {
  localStorage.clear()
  useSetup.setState({ step: 0, done: false })
  useUi.setState({ booting: false, whatsNew: false })
  useProd.getState().setFaceHiding(false)
  usePlayPrefs.getState().setLeftHanded(false)
  usePlayPrefs.getState().setControlStyle('curl')
})

describe('first-run setup', () => {
  it('waits for the launch and WHAT’S NEW', () => {
    useUi.setState({ booting: true })
    const { container } = render(<Setup />)
    expect(container).toBeEmptyDOMElement()
    act(() => useUi.setState({ booting: false, whatsNew: true }))
    expect(container).toBeEmptyDOMElement()
  })

  it('five cards: the picks set face hiding, the lead hand and the control style; Later finishes it for good', async () => {
    render(<Setup />)
    fireEvent.click(screen.getByRole('radio', { name: 'English' }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Hide my face' }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Left' }))
    fireEvent.click(await screen.findByRole('radio', { name: /^PALM/ }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Later' }))
    await act(async () => {})
    expect(useProd.getState().faceHiding).toBe(true)
    expect(usePlayPrefs.getState().leftHanded).toBe(true)
    expect(usePlayPrefs.getState().controlStyle).toBe('palm')
    expect(useSetup.getState().done).toBe(true)
    expect(localStorage.getItem('foxbox-setup-done')).toBe('1')
    expect(screen.queryByRole('region', { name: 'Setup' })).toBeNull()
  })

  it('Esc skips with the defaults', () => {
    render(<Setup />)
    fireEvent.keyDown(screen.getByRole('region', { name: 'Setup' }), { key: 'Escape' })
    expect(useSetup.getState().done).toBe(true)
    expect(useProd.getState().faceHiding).toBe(false)
    expect(usePlayPrefs.getState().controlStyle).toBe('curl')
  })
})
