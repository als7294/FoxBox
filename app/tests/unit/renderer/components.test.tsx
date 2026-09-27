// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import rack from '../../../../contracts/rack.v0.json'
import type { ModuleSpec, ModuleState, RackDescriptor } from '../../../src/renderer/src/api/types'
import { Knob } from '../../../src/renderer/src/components/rack/Knob'
import { ModuleCard, segmentedFits } from '../../../src/renderer/src/components/rack/ModuleCard'
import { Segmented } from '../../../src/renderer/src/components/rack/Segmented'

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

describe('Segmented', () => {
  it('is a radio group with arrow-key selection', () => {
    const onChange = vi.fn()
    render(<Segmented label="MODE" value="natural" options={[{ value: 'natural', label: 'NATURAL' }, { value: 'monotone', label: 'MONOTONE' }]} onChange={onChange} />)
    const group = screen.getByRole('radiogroup', { name: 'MODE' })
    expect(screen.getByRole('radio', { name: 'NATURAL' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith('monotone')
  })
})

describe('ModuleCard (generic, from GET /api/rack)', () => {
  const spec = (rack as RackDescriptor).modules.find((m) => m.id === 'mask') as ModuleSpec
  it('renders every non-advanced param, the bypass switch, and locks macro-driven params', () => {
    const onToggle = vi.fn()
    const state: ModuleState = { id: 'mask', enabled: true, params: { formant_st: -5 } }
    render(
      <ModuleCard spec={spec} state={state} defaultOpen controlled={new Map([['pitch_st', 'depth']])} onToggle={onToggle} onParam={vi.fn()} onCommit={vi.fn()} />,
    )
    for (const p of spec.params.filter((x) => !x.advanced && x.kind === 'knob')) expect(screen.getByRole('slider', { name: p.label })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'PITCH' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('DEPTH')).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'FORMANT' })).toHaveAttribute('aria-valuenow', '-5')
    fireEvent.click(screen.getByRole('switch', { name: 'Enable MASK' }))
    expect(onToggle).toHaveBeenCalledWith(false)
  })

  it('shows a one-line summary when closed and opens from the title', () => {
    render(<ModuleCard spec={spec} state={{ id: 'mask', enabled: true, params: {} }} controlled={new Map()} onToggle={vi.fn()} onParam={vi.fn()} onCommit={vi.fn()} />)
    expect(screen.queryByRole('slider', { name: 'PITCH' })).toBeNull()
    expect(screen.getByText(/PITCH .* · /)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'MASK' }))
    expect(screen.getByRole('slider', { name: 'PITCH' })).toBeInTheDocument()
  })

  it('shows unavailable modules as bypassed with a note', () => {
    const edit = { ...((rack as RackDescriptor).modules.find((m) => m.id === 'edit') as ModuleSpec), available: false }
    render(<ModuleCard spec={edit} state={{ id: 'edit', enabled: true, params: {} }} controlled={new Map()} onToggle={vi.fn()} onParam={vi.fn()} onCommit={vi.fn()} />)
    expect(screen.getByRole('note')).toHaveTextContent(/NOT AVAILABLE YET/)
    expect(screen.getByRole('switch', { name: 'Enable EDIT' })).toHaveAttribute('aria-checked', 'false')
  })

  it('renders segmented params as a select when their labels would not fit (rack 1.2.0 options)', () => {
    expect(segmentedFits(['saw', 'square', 'noise'])).toBe(true)
    expect(segmentedFits(['channel', 'talkbox'])).toBe(true)
    expect(segmentedFits(['saw', 'square', 'noise', 'supersaw'])).toBe(false)
    expect(segmentedFits(['plate', 'hall', 'room', 'galactic'])).toBe(false)
    const machine = (rack as RackDescriptor).modules.find((m) => m.id === 'machine') as ModuleSpec
    const spec = {
      ...machine,
      params: machine.params.map((p) => (p.id === 'vocoder_carrier' ? { ...p, options: [...(p.options ?? []), 'supersaw'] } : p)),
    } as ModuleSpec
    render(<ModuleCard spec={spec} state={{ id: 'machine', enabled: true, params: {} }} defaultOpen controlled={new Map()} onToggle={vi.fn()} onParam={vi.fn()} onCommit={vi.fn()} />)
    expect(screen.getByRole('combobox', { name: spec.params.find((p) => p.id === 'vocoder_carrier')!.label })).toBeInTheDocument()
  })
})
