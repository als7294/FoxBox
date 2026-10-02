// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PerformanceStrip } from '@/components/visuals/PerformanceStrip'
import { useUi } from '@/state/ui'
import { useVisuals } from '@/state/visuals'
import { useVisualsUi, visualsUi } from '@/state/visualsUi'

const voiceFor = (ready = true) => ({ talk: vi.fn<(down: boolean) => void>(), lit: false, ready })

describe('PERFORM pads', () => {
  beforeEach(() => {
    useUi.setState({ screen: 'live' })
    visualsUi.setPerform(true)
  })
  afterEach(() => {
    cleanup()
    visualsUi.setPerform(false)
  })

  it('VOICE holds like PUSH: one talk(true) on the press, one talk(false) on the release', () => {
    const voice = voiceFor()
    render(<PerformanceStrip voice={voice} />)
    const pad = screen.getByTestId('perform-voice')
    fireEvent.pointerDown(pad)
    fireEvent.pointerDown(pad)
    expect(voice.talk.mock.calls).toEqual([[true]])
    fireEvent.pointerUp(pad)
    fireEvent.pointerLeave(pad)
    expect(voice.talk.mock.calls).toEqual([[true], [false]])
  })

  it('V holds it too, and a key repeat is not a second press', () => {
    const voice = voiceFor()
    render(<PerformanceStrip voice={voice} />)
    fireEvent.keyDown(window, { key: 'v' })
    fireEvent.keyDown(window, { key: 'v', repeat: true })
    fireEvent.keyUp(window, { key: 'v' })
    expect(voice.talk.mock.calls).toEqual([[true], [false]])
  })

  it('VOICE does nothing before the audio source starts', () => {
    const voice = voiceFor(false)
    render(<PerformanceStrip voice={voice} />)
    const pad = screen.getByTestId('perform-voice')
    expect(pad).toBeDisabled()
    fireEvent.keyDown(window, { key: 'v' })
    fireEvent.pointerDown(pad)
    expect(voice.talk).not.toHaveBeenCalled()
  })

  it('leaving PERFORM mid-press lets go of the voice and DROP FX', () => {
    const voice = voiceFor()
    const { unmount } = render(<PerformanceStrip voice={voice} />)
    fireEvent.keyDown(window, { key: 'v' })
    fireEvent.keyDown(window, { key: 'd' })
    expect(useVisualsUi.getState().dropFx).toBe(true)
    unmount()
    expect(voice.talk.mock.calls).toEqual([[true], [false]])
    expect(useVisualsUi.getState().dropFx).toBe(false)
  })

  it('D holds DROP FX only while held', () => {
    render(<PerformanceStrip voice={voiceFor()} />)
    fireEvent.keyDown(window, { key: 'd' })
    expect(useVisualsUi.getState().dropFx).toBe(true)
    fireEvent.keyUp(window, { key: 'd' })
    expect(useVisualsUi.getState().dropFx).toBe(false)
  })

  it('an empty pad saves the stack; the key fires the pad, and the page keys never see it', () => {
    useVisuals.setState({ pads: Array.from({ length: 8 }, () => null) })
    render(<PerformanceStrip voice={voiceFor()} />)
    const later = vi.fn()
    window.addEventListener('keydown', later)
    fireEvent.keyDown(window, { key: '3' })
    window.removeEventListener('keydown', later)
    expect(useVisuals.getState().pads[2]?.name).toBe('LOOK 3')
    expect(later).not.toHaveBeenCalled()
  })
})
