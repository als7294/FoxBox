// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCamera } from '@/components/camera/cameraStore'
import { faceShowsNow } from '@/components/visuals/LayerStack'
import { FaceConfirm } from '@/components/visuals/VisualsStage'
import { useVisuals } from '@/state/visuals'
import { useVisualsUi, visualsUi } from '@/state/visualsUi'
import { useTdCamera } from '@/touchdesigner/camera'

const scene = (base: 'camera' | 'core', td = false) =>
  useVisuals.setState((v) => ({
    scene: {
      ...v.scene,
      base: { kind: base },
      effects: td ? [{ id: 't', styleId: 'touchdesigner', opacity: 1, blend: 'normal', reactTo: 'mix', enabled: true, td: { preset: 'plexus' } }] : [],
    },
  }))

describe('a face asks first', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    useCamera.setState({ hideFaces: true })
    useTdCamera.setState({ state: 'off', maskFirst: false })
    visualsUi.answerFace()
  })

  it('would show with face hiding off on the CAMERA base, or with TouchDesigner raw', () => {
    scene('camera')
    expect(faceShowsNow()).toBe(false)
    useCamera.setState({ hideFaces: false })
    expect(faceShowsNow()).toBe(true)
    scene('core')
    expect(faceShowsNow()).toBe(false)
    scene('core', true)
    useTdCamera.setState({ state: 'live', maskFirst: false })
    expect(faceShowsNow()).toBe(true)
    useTdCamera.setState({ maskFirst: true })
    expect(faceShowsNow()).toBe(false)
  })

  it('HIDE MY FACE, THEN RECORD hides it and records only once the picture has redrawn', () => {
    vi.useFakeTimers()
    const go = vi.fn()
    const hide = vi.fn()
    visualsUi.askFace('rec', go)
    render(<FaceConfirm ask={{ kind: 'rec', go }} tdRaw={false} hideFace={hide} />)
    fireEvent.click(screen.getByRole('button', { name: 'HIDE MY FACE, THEN RECORD' }))
    expect(hide).toHaveBeenCalledOnce()
    expect(go).not.toHaveBeenCalled()
    expect(useVisualsUi.getState().faceAsk).toBeNull()
    vi.advanceTimersByTime(400)
    expect(go).toHaveBeenCalledOnce()
  })

  it('RECORD WITH MY FACE goes at once; CANCEL never does', () => {
    const go = vi.fn()
    const { unmount } = render(<FaceConfirm ask={{ kind: 'clip', go }} tdRaw={false} hideFace={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'RECORD WITH MY FACE' }))
    expect(go).toHaveBeenCalledOnce()
    unmount()
    const never = vi.fn()
    render(<FaceConfirm ask={{ kind: 'out', go: never }} tdRaw={true} hideFace={() => {}} />)
    expect(screen.getByRole('alert')).toHaveTextContent('TOUCHDESIGNER GETS THE RAW CAMERA. The projector will show your real face.')
    fireEvent.click(screen.getByRole('button', { name: 'CANCEL' }))
    expect(never).not.toHaveBeenCalled()
  })
})
