// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cameraOff } from '@/components/visuals/LayerStack'
import { CameraAlert } from '@/components/visuals/VisualsStage'

describe("the CAMERA base's trouble on VISUALS", () => {
  afterEach(() => {
    cleanup()
    delete (window as { fvwks?: unknown }).fvwks
  })

  it('counts blocked, unanswered and missing as off (not asking or opening)', () => {
    expect(['denied', 'timeout', 'missing'].every((s) => cameraOff(s as never))).toBe(true)
    expect(cameraOff('asking')).toBe(false)
    expect(cameraOff('live')).toBe(false)
    expect(cameraOff(null)).toBe(false)
  })

  it("blocked: says so in the PM's words and opens Camera settings", () => {
    const openCameraSettings = vi.fn(async () => {})
    ;(window as { fvwks?: unknown }).fvwks = { openCameraSettings }
    render(<CameraAlert state="denied" />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'CAMERA BLOCKED. macOS is blocking the camera for this FoxBox. Turn FoxBox on in Camera settings, then TRY AGAIN.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'OPEN CAMERA SETTINGS' }))
    expect(openCameraSettings).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'TRY AGAIN' })).toBeInTheDocument()
  })

  it('no answer offers the settings too (a stale grant looks like that); no camera only TRY AGAIN', () => {
    ;(window as { fvwks?: unknown }).fvwks = { openCameraSettings: vi.fn(async () => {}) }
    const { unmount } = render(<CameraAlert state="timeout" />)
    expect(screen.getByRole('button', { name: 'OPEN CAMERA SETTINGS' })).toBeInTheDocument()
    unmount()
    render(<CameraAlert state="missing" />)
    expect(screen.queryByRole('button', { name: 'OPEN CAMERA SETTINGS' })).toBeNull()
    expect(screen.getByRole('button', { name: 'TRY AGAIN' })).toBeInTheDocument()
  })
})
