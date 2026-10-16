// @vitest-environment jsdom
// 2.1.1's guided mode entry (docs/MODE_ENTRY_UX.md): the three modes and the Island's chooser; the stage says one thing
// at a time (the coach waits under full-window screens, then the hands, then the tips, each once); SAUCE never asks ONE
// HAND for the other hand.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFb } from '@/components/fb/fbStore'
import { Island } from '@/components/fb/Island'
import { enterMode, topModeOf } from '@/components/fb/modes'
import { useSetup } from '@/components/fb/Setup'
import { asksOtherHand, ModeGuide, TIP_AFTER_MS, tipNow, type TipClock } from '@/components/fb/Shell'
import { Coach } from '@/components/fb/Stage'
import { usePlay } from '@/components/play/playStore'
import { useStrings } from '@/components/strings/stringsStore'
import { useUi } from '@/state/ui'

const cam = vi.hoisted(() => ({ shapes: { left: null as unknown, right: null as unknown } }))
vi.mock('@/components/camera/smartCamera', async (orig) => ({
  ...(await orig<object>()),
  cameraSignals: () => ({ tooDark: false, light: 1, frame: { lHeldMs: 0 }, play: { shapes: cam.shapes } }),
}))

afterEach(cleanup)
beforeEach(() => {
  localStorage.clear()
  useUi.setState({ booting: false, whatsNew: false, mode: 'play' })
  useSetup.setState({ plan: [], step: 0 })
  useFb.setState({ island: false, pop: null, board: false })
  usePlay.setState({ melodyMode: 'off' })
  cam.shapes = { left: null, right: null }
})

describe('the three modes', () => {
  it('SAUCE and MELODY are PLAY (MELODY its LOOP), REMIX is REMIX; entering one closes the chooser', () => {
    expect([topModeOf('play', 'off'), topModeOf('play', 'loop'), topModeOf('remix', 'loop')]).toEqual(['sauce', 'melody', 'remix'])
    useFb.setState({ island: true })
    enterMode('melody')
    expect([useUi.getState().mode, usePlay.getState().melodyMode, useFb.getState().island]).toEqual(['play', 'loop', false])
    enterMode('remix')
    expect(useUi.getState().mode).toBe('remix')
    enterMode('sauce')
    expect([useUi.getState().mode, usePlay.getState().melodyMode]).toEqual(['play', 'off'])
  })

  it('the Island: the mode and Switch; open, the chooser (the mode you’re in says so), and 2 picks MELODY', () => {
    const { container } = render(<Island />)
    expect(container.textContent).toMatch(/^SAUCE/) // the row leads with the mode
    fireEvent.click(screen.getByRole('button', { name: /Switch/ }))
    expect(useFb.getState().island).toBe(true)
    expect(screen.getByRole('button', { name: 'You’re here' })).toBeDisabled()
    expect(screen.getAllByRole('button', { name: 'Start' })).toHaveLength(2)
    fireEvent.keyDown(window, { key: '2' })
    expect(usePlay.getState().melodyMode).toBe('loop')
    expect(useFb.getState().island).toBe(false)
  })
})

describe("the stage's coach", () => {
  it('waits under the launch, WHAT’S NEW and the setup', () => {
    useUi.setState({ whatsNew: true })
    const { container } = render(<Coach text="Curve your hands into a C" />)
    expect(container).toBeEmptyDOMElement()
    act(() => useUi.setState({ whatsNew: false }))
    expect(container.textContent).toBe('Curve your hands into a C')
    act(() => useSetup.setState({ plan: ['modes'], step: 0 }))
    expect(container).toBeEmptyDOMElement()
    act(() => {
      useSetup.setState({ plan: [], step: 0 })
      useUi.setState({ booting: true })
    })
    expect(container).toBeEmptyDOMElement()
  })

  it('one thing at a time: the coach until the hands are up, then quiet (the tips wait), nothing before the camera', () => {
    useStrings.setState({ camera: 'live' })
    const { container, rerender } = render(<ModeGuide active top="sauce" />)
    const said = () => [...container.querySelectorAll('[role="status"]')].map((e) => e.textContent)
    expect(said()).toEqual(['Curve your hands into a C, turned a little toward the camera'])
    cam.shapes = { left: {}, right: {} }
    rerender(<ModeGuide active top="sauce" />)
    expect(said()).toEqual([])
    cam.shapes = { left: null, right: null }
    act(() => useStrings.setState({ camera: 'off' }))
    expect(said()).toEqual([])
  })

  it('the tips: after 20 s of playing, one at a time for 6 s, 20 s apart, each once ever; anything else holds them back', () => {
    const c: TipClock = { mode: null, since: 0, id: null, until: 0, last: -Infinity }
    const seen: string[] = []
    expect(tipNow(c, 'melody', false, 0, seen)).toBeNull()
    expect(tipNow(c, 'melody', false, TIP_AFTER_MS - 1, seen)).toBeNull()
    expect(tipNow(c, 'melody', false, TIP_AFTER_MS, seen)).toBe('melody.space')
    expect(tipNow(c, 'melody', true, TIP_AFTER_MS + 1000, seen)).toBeNull() // hidden while the stage is busy
    expect(tipNow(c, 'melody', false, TIP_AFTER_MS + 2000, seen)).toBe('melody.space')
    expect(tipNow(c, 'melody', false, TIP_AFTER_MS + 6000, seen)).toBeNull() // its 6 s are up
    expect(tipNow(c, 'melody', false, TIP_AFTER_MS + 6000 + 19_999, seen)).toBeNull()
    expect(tipNow(c, 'melody', false, TIP_AFTER_MS + 6000 + 20_000, seen)).toBe('melody.frame')
    expect(tipNow(c, 'sauce', false, 100_000, seen)).toBeNull() // a new mode: 20 s of it first
    expect(tipNow(c, 'sauce', false, 120_000, seen)).toBe('sauce.bend')
    expect(seen).toEqual(['melody.space', 'melody.frame', 'sauce.bend'])
  })

  it('asks for the other hand while one plucks, never in ONE HAND', () => {
    expect(asksOtherHand(1, 'pluck', false)).toBe(true)
    expect(asksOtherHand(1, 'pluck', true)).toBe(false) // S3's 2.1.1 find: it asked the whole time
    expect(asksOtherHand(2, 'pluck', false)).toBe(false)
    expect(asksOtherHand(1, 'flow', false)).toBe(false)
  })
})
