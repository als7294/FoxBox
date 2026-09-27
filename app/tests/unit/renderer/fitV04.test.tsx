// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FitReport } from '../../../src/renderer/src/api/types'
import { FitIndicator } from '../../../src/renderer/src/components/signal/FitIndicator'
import { mockEngine } from '../../../src/renderer/src/mocks/mockEngine'
import { partialArrange } from '../../../src/renderer/src/state/renderController'

afterEach(cleanup)

const fit = (patch: Partial<FitReport>): FitReport => ({
  status: 'fits',
  speech_s: 2.95,
  available_s: 2.86,
  total_s: 6.86,
  stretch_ratio: 1,
  suggested_bars: null,
  message: '',
  reserved_tail_s: 4,
  ...patch,
})

describe('FIT (v0.4: never cut speech)', () => {
  it('says the render grew instead of cutting, from the requested count to the one used, with a KEEP fix', () => {
    const onBars = vi.fn()
    const message = "Extended to 4 bars: speech 2.95s + 4.00s tail doesn't fit 2 bars @ 140"
    render(<FitIndicator fit={fit({ status: 'extended', suggested_bars: 4, message })} bpm={140} bars={4} requested={2} onBars={onBars} />)
    const status = screen.getByRole('status', { name: 'Fit' })
    expect(status).toHaveAttribute('data-status', 'extended')
    expect(status).toHaveTextContent('EXTENDED 2 → 4 BARS')
    // The line shows the tail kept after the last word, and the file length.
    expect(status).toHaveTextContent('SPEECH 2.95s + 4.00s TAIL → 4 BARS @ 140 = 6.86s')
    fireEvent.click(screen.getByRole('button', { name: 'KEEP 4 BARS' }))
    expect(onBars).toHaveBeenCalledWith(4)
  })

  it('draws the reserved tail right after the speech', () => {
    render(<FitIndicator fit={fit({ status: 'fits', speech_s: 2, available_s: 2.86 })} bpm={140} bars={4} requested={4} onBars={() => {}} />)
    const tail = screen.getByTitle('4.00 s kept for the tail')
    // room = 2.86 + 4 = 6.86 s; the speech fills 2 / 6.86 of the box (80% wide), the tail starts there.
    expect(parseFloat(tail.style.left)).toBeCloseTo((2 / 6.86) * 80, 1)
    expect(parseFloat(tail.style.width)).toBeCloseTo((4 / 6.86) * 80, 1)
  })

  it('sends snap_end only when the user picked one (older engines forbid unknown fields)', () => {
    expect(partialArrange({ bpm: 140, bars: 'auto', key: 'Am' })).toEqual({ bpm: 140, bars: 'auto', key: 'Am' })
    expect(partialArrange({ bpm: 140, bars: 4, key: 'Am', snapEnd: null })).not.toHaveProperty('snap_end')
    expect(partialArrange({ bpm: 140, bars: 4, key: 'Am', snapEnd: 'bar' })).toEqual({ bpm: 140, bars: 4, key: 'Am', snap_end: 'bar' })
  })

  it('mock engine: a phrase and its tail that outgrow the bars extend the render instead of cutting', async () => {
    mockEngine.latencyMs = 0
    const src = await mockEngine.tts({ script: 'WE ARE GUY FVWKS | WE DO NOT FORGIVE | WE DO NOT FORGET | EXPECT US', voice_id: 'kokoro:am_fenrir', speed: 1 } as never)
    const info = await mockEngine.render({ source_id: src.id, preset_id: 'ghost', arrange: { bpm: 140, bars: 1, key: 'Am' }, quality: 'preview' } as never)
    expect(info.fit.status).toBe('extended')
    expect(info.bars).toBeGreaterThan(1)
    expect(info.fit.suggested_bars).toBe(info.bars)
    expect(info.fit.reserved_tail_s).toBeGreaterThan(0)
    expect(info.fit.message).toMatch(/^Extended to \d+ bars/)
    // Nothing cut: the file holds the speech and its tail.
    expect(info.duration_s).toBeGreaterThanOrEqual(info.fit.speech_s * info.fit.stretch_ratio + (info.fit.reserved_tail_s ?? 0) - 0.01)
  })
})
