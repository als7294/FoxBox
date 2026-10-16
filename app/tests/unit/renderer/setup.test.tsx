// @vitest-environment jsdom
// 2.1 first-run setup with 2.1.1's guided mode entry (docs/MODE_ENTRY_UX.md §0–1): it shows after the launch (not with
// WHAT'S NEW); a new install answers five cards (how you play waits for Next) and ends by picking a mode; Esc skips the
// questions with the defaults, never the mode; an update asks how you play and the mode, once.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { usePlayPrefs } from '../../../src/renderer/src/components/camera/playPrefs'
import { Setup, setupPlan, useSetup } from '../../../src/renderer/src/components/fb/Setup'
import { usePlay } from '../../../src/renderer/src/components/play/playStore'
import { useProd } from '../../../src/renderer/src/components/prod/prodStore'
import { useUi } from '../../../src/renderer/src/state/ui'

afterEach(cleanup)
beforeEach(() => {
  localStorage.clear()
  useSetup.setState({ plan: setupPlan(false, false, false), step: 0 })
  useUi.setState({ booting: false, whatsNew: false, mode: 'play' })
  usePlay.setState({ melodyMode: 'off' })
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

  it('what it asks: a new install everything; an update how you play and the mode, once each', () => {
    expect(setupPlan(false, false, false)).toEqual(['lang', 'face', 'hands', 'music', 'modes'])
    expect(setupPlan(true, false, false)).toEqual(['hands', 'modes'])
    expect(setupPlan(true, true, false)).toEqual(['modes'])
    expect(setupPlan(true, true, true)).toEqual([])
  })

  it('five cards: the picks set face hiding, the style and the lead hand; the mode starts it, for good', async () => {
    render(<Setup />)
    fireEvent.click(screen.getByRole('radio', { name: 'English' }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Hide my face' }))
    fireEvent.click(await screen.findByRole('radio', { name: /tap with your palm/ }))
    fireEvent.click(screen.getByRole('radio', { name: 'Left' }))
    expect(screen.getByRole('heading', { name: 'How do you play?' })).toBeInTheDocument() // a pick waits for Next
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Later' }))
    await act(async () => {})
    expect(screen.getByRole('heading', { name: 'What are we playing?' })).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Start' })[1]!) // MELODY
    expect(useProd.getState().faceHiding).toBe(true)
    expect(usePlayPrefs.getState().controlStyle).toBe('palm')
    expect(usePlayPrefs.getState().leftHanded).toBe(true)
    expect(usePlay.getState().melodyMode).toBe('loop')
    expect(['foxbox-setup-done', 'foxbox-style-asked', 'foxbox-mode-chosen'].map((k) => localStorage.getItem(k))).toEqual(['1', '1', '1'])
    expect(screen.queryByRole('region', { name: 'Setup' })).toBeNull()
  })

  it('Esc skips the questions with the defaults, then the mode: Esc there starts SAUCE', () => {
    render(<Setup />)
    fireEvent.keyDown(screen.getByRole('region', { name: 'Setup' }), { key: 'Escape' })
    expect(screen.getByRole('heading', { name: 'What are we playing?' })).toBeInTheDocument()
    expect(useProd.getState().faceHiding).toBe(false)
    expect(usePlayPrefs.getState().controlStyle).toBe('curl')
    fireEvent.keyDown(screen.getByRole('region', { name: 'Setup' }), { key: 'Escape' })
    expect(useUi.getState().mode).toBe('play')
    expect(usePlay.getState().melodyMode).toBe('off')
    expect(screen.queryByRole('region', { name: 'Setup' })).toBeNull()
  })

  it('after an update: how you play, then the mode (3 is REMIX)', () => {
    useSetup.setState({ plan: setupPlan(true, false, false), step: 0 })
    render(<Setup />)
    expect(screen.getByRole('heading', { name: 'How do you play?' })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('region', { name: 'Setup' }), { key: 'Enter' }) // Enter is Next
    fireEvent.keyDown(screen.getByRole('region', { name: 'Setup' }), { key: '3' })
    expect(useUi.getState().mode).toBe('remix')
    expect(screen.queryByRole('region', { name: 'Setup' })).toBeNull()
  })
})
