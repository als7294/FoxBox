// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SectionTimeline, stepSection } from '@/components/prod/SectionTimeline'
import { BeatFxSheet, StringControls } from '@/components/prod/StringsPanel'
import { useProd } from '@/components/prod/prodStore'
import type { SongDeck } from '@/audio/live'
import { useLiveDeck } from '@/state/liveDeck'
import { useUi } from '@/state/ui'

describe("STRINGS' BEAT FX cheat sheet (1.5.5)", () => {
  afterEach(cleanup)

  it('lights the row of the FX that fires, and shows its BEAT', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    render(<BeatFxSheet read={() => ({ fx: 'riddim', depth: 0.5, beat: 1 / 3, label: '1/8T' })} />)
    vi.advanceTimersByTime(50)
    const lit = [...document.querySelectorAll('[data-on]')].map((r) => r.textContent)
    expect(lit).toEqual(['✌️PEACERIDDIM CHOPS'])
    expect(screen.getByText('1/8T')).toBeInTheDocument()
    vi.useRealTimers()
  })

  it("meters the strings' stretch, tilt (from the middle) and shake", () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    const { container } = render(<StringControls read={() => ({ tension: 0.5, tilt: -0.5, shake: 1 })} />)
    vi.advanceTimersByTime(50)
    const [tension, tilt, shake] = [...container.querySelectorAll<HTMLElement>('[class*="lFill"]')]
    expect(tension!.style.transform).toBe('scaleX(0.50)')
    expect([tilt!.style.marginLeft, tilt!.style.width]).toEqual(['25%', '25%']) // left of centre, half way
    expect(shake!.style.transform).toBe('scaleX(1.00)')
    // FINGER FILTERS: a band per finger, thumb to pinky, on its string's colour
    expect([...container.querySelectorAll('[class*="band"] b')].map((b) => b.textContent)).toEqual([
      'SUB',
      'LOW',
      'MID',
      'HIGH-MID',
      'HIGH',
    ])
    vi.useRealTimers()
  })
})

describe("STRINGS' SECTION TIMELINE (1.5.5)", () => {
  afterEach(cleanup)
  const parts = [
    { kind: 'intro', label: 'INTRO', startS: 0, endS: 16 },
    { kind: 'drop', label: 'DROP 1', startS: 16, endS: 48 },
    { kind: 'breakdown', label: 'BREAK', startS: 48, endS: 64 },
  ]

  it("→ the next section; ← this one's start after its first 2 s, else the one before", () => {
    expect(stepSection(parts, 20, 1)?.label).toBe('BREAK')
    expect(stepSection(parts, 20, -1)?.label).toBe('DROP 1')
    expect(stepSection(parts, 17, -1)?.label).toBe('INTRO')
    expect(stepSection(parts, 50, 1)).toBeNull()
  })

  it('a chip and ←/→ jump through the deck (S2 lands them on the bar)', () => {
    const seek = vi.fn()
    const deck = { durationS: 64, positionS: () => 20, isPlaying: true, sections: () => parts, peaks: () => new Float32Array(4), seek }
    useLiveDeck.setState({ deck: deck as unknown as SongDeck })
    useUi.setState({ mode: 'remix' })
    render(<SectionTimeline />)
    fireEvent.click(screen.getByRole('button', { name: 'BREAK' }))
    expect(seek).toHaveBeenLastCalledWith(48)
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(seek).toHaveBeenLastCalledWith(16)
    useLiveDeck.setState({ deck: null })
  })
})

describe('STRINGS opens at 16:9 (1.5.5)', () => {
  it("drops PROD · TOUCHDESIGNER's saved aspect once, then keeps the user's pick", async () => {
    localStorage.setItem('foxbox-prod', JSON.stringify({ state: { aspect: '9:16' }, version: 0 }))
    await useProd.persist.rehydrate()
    expect(useProd.getState().aspect).toBe('16:9')
    localStorage.setItem('foxbox-prod', JSON.stringify({ state: { aspect: '9:16' }, version: 1 }))
    await useProd.persist.rehydrate()
    expect(useProd.getState().aspect).toBe('9:16')
  })
})
