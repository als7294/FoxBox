// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TdPreset } from '@shared/tdPresets'
import { SectionTimeline, stepSection } from '@/components/prod/SectionTimeline'
import { BeatFxSheet, StringControls } from '@/components/prod/StringsPanel'
import { TdEffectBrowser } from '@/components/prod/TdEffectBrowser'
import { useProd } from '@/components/prod/prodStore'
import { useTdPresets } from '@/touchdesigner/presets'
import type { SongDeck } from '@/audio/live'
import { useLiveDeck } from '@/state/liveDeck'
import { useUi } from '@/state/ui'

const preset = (id: string, order: number, mode: TdPreset['mode'], changes_sound = false): TdPreset => ({
  id,
  label: id.toUpperCase(),
  title: '',
  how: '',
  order,
  tracks: ['body', 'hands'],
  mode,
  macros: [],
  reacts_to: 'kick',
  palette: [],
  feedback: false,
  sound: { changes_sound, map: [] },
})

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
    useUi.setState({ screen: 'prod' })
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

describe('the PROD effect browser', () => {
  afterEach(cleanup)

  it('lists the looks of the active mode, picks, favourites and marks the ones that change the sound', () => {
    useTdPresets.setState({
      presets: [preset('plexus', 0, 'body'), preset('tape', 1, 'body', true), preset('fwindows', 2, 'hands')],
      active: 'plexus',
    })
    render(<TdEffectBrowser collapsed={false} onExpand={() => {}} />)
    expect(screen.getByRole('radio', { name: 'BODY 2 LOOKS' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'HANDS 1 LOOK' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByRole('radio', { name: 'FWINDOWS' })).toBeNull()

    const tape = screen.getByRole('radio', { name: 'TAPE ♪ SOUND' })
    expect(screen.getByText('♪ SOUND')).toHaveAttribute('title', expect.stringContaining('Changes the sound'))
    fireEvent.click(tape)
    expect(useTdPresets.getState().active).toBe('tape')
    expect(tape).toHaveAttribute('aria-checked', 'true')
    expect(useProd.getState().lastFxByMode.body).toBe('tape')

    const fav = screen.getByRole('button', { name: 'Favourite TAPE' })
    fireEvent.click(fav)
    expect(useProd.getState().favs.tape).toBe(true)
    expect(fav).toHaveAttribute('aria-pressed', 'true')

    // HANDS picks its first look; BODY comes back to TAPE
    fireEvent.click(screen.getByRole('radio', { name: 'HANDS 1 LOOK' }))
    expect(useTdPresets.getState().active).toBe('fwindows')
    fireEvent.click(screen.getByRole('radio', { name: 'BODY 2 LOOKS' }))
    expect(useTdPresets.getState().active).toBe('tape')
  })
})
