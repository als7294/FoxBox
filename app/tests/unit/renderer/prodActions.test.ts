import { describe, expect, it, vi } from 'vitest'
import type { SongDeck } from '@/audio/live'
import type { Song } from '@/api/types'
import { cameraAlert } from '@/components/camera/cameraAlert'
import { playTrack } from '@/components/prod/prodActions'
import { stemsNote } from '@/components/prod/StringsPanel'
import { useLiveDeck } from '@/state/liveDeck'
import { useSong } from '@/state/song'

describe('STRINGS', () => {
  it("STRINGS' ▶ plays any song in one press (a restored one): the TRACK engine, then the deck from two bars before the drop", () => {
    useSong.setState({ song: { id: 's1' } as Song })
    useLiveDeck.setState({ deck: null, startTrack: null })
    playTrack()
    const startTrack = vi.fn()
    useLiveDeck.setState({ startTrack }) // REMIX's deck owner offers it (useRemixDeck)
    expect(startTrack).toHaveBeenCalledOnce()
    const calls: string[] = []
    const deck = {
      isPlaying: false,
      positionS: () => 0,
      resume: () => calls.push('resume'),
      cueBeforeDrop: (bars: number) => calls.push(`cue ${bars}`),
      startQuantized: () => calls.push('play'),
    }
    useLiveDeck.setState({ deck: deck as unknown as SongDeck })
    useLiveDeck.setState({ startTrack: null }) // later changes don't start it again
    expect(calls).toEqual(['resume', 'cue 2', 'play'])
    calls.length = 0
    playTrack() // still at the top: before the drop again
    expect(calls).toEqual(['resume', 'cue 2', 'play'])
    deck.positionS = () => 42
    calls.length = 0
    playTrack() // stopped mid-song: it carries on from there
    expect(calls).toEqual(['resume', 'play'])
  })

  it("STRINGS' stems note: the split's progress, then nothing once they're in", () => {
    expect(stemsNote('splitting', 0.42)).toBe('SPLITTING STEMS… 42%')
    expect(stemsNote('loading', null)).toBe('LOADING STEMS…')
    expect(stemsNote('on', null)).toBeNull()
    expect(stemsNote('mix', null)).toBeNull()
  })

  it('says the camera is off, with the way to Camera settings, when macOS refuses the camera without a prompt', () => {
    expect(cameraAlert('denied')).toMatchObject({ title: 'The camera is off', settings: true })
    expect(cameraAlert('denied')?.text).toContain('Camera settings')
    expect(cameraAlert('timeout')?.settings).toBe(true) // a stale grant can also look like a camera that never answers
    expect(cameraAlert('missing')?.settings).toBe(false)
    for (const ok of ['off', 'asking', 'opening', 'live'] as const) expect(cameraAlert(ok)).toBeNull()
  })
})
