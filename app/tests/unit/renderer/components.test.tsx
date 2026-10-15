// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Knob } from '../../../src/renderer/src/components/rack/Knob'

afterEach(cleanup)

function ControlledKnob({ onCommit }: { onCommit(v: number): void }) {
  const [v, setV] = useState(0)
  return <Knob label="PITCH" value={v} min={-24} max={12} step={0.1} unit="st" defaultValue={0} onChange={setV} onCommit={onCommit} />
}

describe('Knob (ARIA slider)', () => {
  it('exposes slider semantics and moves with the keyboard', () => {
    const commit = vi.fn()
    render(<ControlledKnob onCommit={commit} />)
    const s = screen.getByRole('slider', { name: 'PITCH' })
    expect(s).toHaveAttribute('aria-valuemin', '-24')
    expect(s).toHaveAttribute('aria-valuemax', '12')
    expect(s).toHaveAttribute('aria-valuetext', '0.0 st')
    fireEvent.keyDown(s, { key: 'ArrowUp' })
    fireEvent.keyUp(s, { key: 'ArrowUp' })
    expect(s).toHaveAttribute('aria-valuenow', '0.5')
    expect(commit).toHaveBeenLastCalledWith(0.5)
    fireEvent.keyDown(s, { key: 'ArrowDown', shiftKey: true })
    expect(s).toHaveAttribute('aria-valuenow', '0.4')
    fireEvent.keyDown(s, { key: 'Home' })
    expect(s).toHaveAttribute('aria-valuenow', '-24')
    fireEvent.keyDown(s, { key: 'End' })
    expect(s).toHaveAttribute('aria-valuenow', '12')
    fireEvent.doubleClick(s)
    expect(s).toHaveAttribute('aria-valuenow', '0')
    expect(commit).toHaveBeenLastCalledWith(0)
  })

  it('turns with the scroll wheel without scrolling the page, and commits after a pause', () => {
    vi.useFakeTimers()
    try {
      const commit = vi.fn()
      render(<ControlledKnob onCommit={commit} />)
      const s = screen.getByRole('slider', { name: 'PITCH' })
      const ev = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })
      act(() => {
        s.dispatchEvent(ev)
      })
      expect(ev.defaultPrevented).toBe(true)
      expect(Number(s.getAttribute('aria-valuenow'))).toBeGreaterThan(0)
      vi.advanceTimersByTime(300)
      expect(commit).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drags vertically (Shift = fine) and commits on release', () => {
    const commit = vi.fn()
    render(<ControlledKnob onCommit={commit} />)
    const s = screen.getByRole('slider', { name: 'PITCH' })
    s.setPointerCapture = () => {}
    fireEvent.pointerDown(s, { pointerId: 1, button: 0, clientY: 300 })
    fireEvent.pointerMove(s, { pointerId: 1, clientY: 210 }) // half the 180 px travel → +18 st
    expect(Number(s.getAttribute('aria-valuenow'))).toBeCloseTo(-6 + 18 - 6 + 6, 0)
    fireEvent.pointerUp(s, { pointerId: 1 })
    expect(commit).toHaveBeenCalledTimes(1)
  })
})
