// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TdPreset } from '@shared/tdPresets'
import { TdEffectBrowser } from '@/components/prod/TdEffectBrowser'
import { useProd } from '@/components/prod/prodStore'
import { useTdPresets } from '@/touchdesigner/presets'

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
