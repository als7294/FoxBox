// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TdPreset } from '@shared/tdPresets'
import { PlayPanel } from '@/components/prod/PlayPanel'
import { useProd } from '@/components/prod/prodStore'
import { useTdPresets } from '@/touchdesigner/presets'

const look = (id: string, mode: TdPreset['mode']): TdPreset => ({
  id,
  label: id.toUpperCase(),
  title: '',
  how: '',
  order: 0,
  tracks: ['body', 'hands'],
  mode,
  macros: [],
  reacts_to: 'kick',
  palette: [],
  feedback: false,
  sound: null,
})

describe('PROD PLAY', () => {
  afterEach(cleanup)
  beforeEach(() => {
    useTdPresets.setState({ presets: [look('plexus', 'body'), look('fwindows', 'hands')], active: 'plexus' })
    useProd.setState({ values: {}, reacts: {}, reactsOpen: null })
  })

  it('shows the six knobs, and ArrowUp raises INTENSITY by 5%', () => {
    render(<PlayPanel collapsed={false} onExpand={() => {}} />)
    for (const label of ['INTENSITY', 'COLOUR', 'CHAOS', 'TRAILS', 'LINES', 'SIZE']) {
      expect(screen.getByRole('slider', { name: label })).toBeInTheDocument()
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    fireEvent.keyDown(screen.getByRole('slider', { name: 'INTENSITY' }), { key: 'ArrowUp' })
    expect(useProd.getState().values.plexus?.[0]).toBeCloseTo(0.65)
  })

  it("stores KICK picked in INTENSITY's REACTS TO menu, and closes it", () => {
    render(<PlayPanel collapsed={false} onExpand={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'INTENSITY reacts to DROP' }))
    fireEvent.click(screen.getByRole('radio', { name: 'KICK' }))
    expect(useProd.getState().reacts.plexus?.[0]).toBe('kick')
    expect(screen.queryByRole('radiogroup', { name: 'INTENSITY reacts to' })).toBeNull()
    expect(screen.getByRole('button', { name: 'INTENSITY reacts to KICK' })).toBeInTheDocument()
  })

  it('shows the gesture map only for a hands look', () => {
    render(<PlayPanel collapsed={false} onExpand={() => {}} />)
    expect(screen.queryByText('HAND GESTURES')).toBeNull()
    act(() => useTdPresets.setState({ active: 'fwindows' }))
    expect(screen.getByText('HAND GESTURES')).toBeInTheDocument()
  })
})
