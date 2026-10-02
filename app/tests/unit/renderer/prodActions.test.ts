import { describe, expect, it, vi } from 'vitest'
import type { SongDeck } from '@/audio/live'
import { answer, playTrack, request } from '@/components/prod/prodActions'
import { gestureCommand, startProdFeed } from '@/components/prod/prodFeed'
import { silentFrame } from '@/visuals/live/registry'
import { stageFrames } from '@/visuals/live/stage'
import { gesturesOf, useProd } from '@/components/prod/prodStore'
import { stemsNote } from '@/components/prod/StringsPanel'
import { boxToPicture, cameraAlert } from '@/components/prod/TdPreview'
import { useStrings } from '@/components/strings/stringsStore'
import type { Song } from '@/api/types'
import { useLiveAudio } from '@/state/liveAudio'
import { useLiveDeck } from '@/state/liveDeck'
import { useSong } from '@/state/song'
import { useToasts } from '@/state/toasts'
import { useVisuals } from '@/state/visuals'
import { useTdPresets } from '@/touchdesigner/presets'
import { TD_STYLE } from '@/visuals/live/compositor'

describe('PROD', () => {
  it('STRINGS asks before SEND TO OUTPUT while the face shows; HIDE MY FACE, THEN SEND turns FACE HIDING on', () => {
    useStrings.setState({ camera: 'live' })
    useProd.setState({ faceHiding: false })
    request('out')
    expect(useProd.getState().confirm).toBe('out')
    answer('mask')
    expect(useProd.getState().faceHiding).toBe(true)
    expect(useProd.getState().confirm).toBeNull()
    request('out') // face hidden now: straight through, no question
    expect(useProd.getState().confirm).toBeNull()
    useProd.setState({ faceHiding: false })
    useStrings.setState({ camera: 'denied' }) // no camera, no face
    request('out')
    expect(useProd.getState().confirm).toBeNull()
  })

  it('TouchDesigner paused (1.5.5): no scene keeps a TD base or layer', () => {
    const v = useVisuals.getState()
    v.setBase({ kind: 'touchdesigner' })
    v.addTdLayer('plexus')
    expect(useVisuals.getState().scene.base.kind).toBe('none')
    expect(useVisuals.getState().scene.effects.some((e) => e.styleId === TD_STYLE)).toBe(false)
  })

  it('HIDE MY FACE, THEN RECORD waits 400 ms for the masked picture before it records (no unmasked frame)', () => {
    vi.useFakeTimers()
    useStrings.setState({ camera: 'live' })
    useProd.setState({ faceHiding: false })
    useToasts.setState({ items: [] })
    request('rec')
    answer('mask')
    expect(useProd.getState().faceHiding).toBe(true)
    vi.advanceTimersByTime(399)
    expect(useToasts.getState().items).toEqual([]) // not yet: RECORD hasn't run
    vi.advanceTimersByTime(1)
    expect(useToasts.getState().items.map((t) => t.message)).toEqual(['PLAY THE TRACK FIRST']) // it ran (no track here)
    vi.useRealTimers()
  })

  it("STRINGS' ▶ plays any song in one press (a restored one, VISUALS on the mic): TRACK, its engine, then the deck from two bars before the drop", () => {
    useSong.setState({ song: { id: 's1' } as Song })
    useLiveAudio.setState({ source: 'mic' })
    useLiveDeck.setState({ deck: null, startTrack: null })
    playTrack()
    expect(useLiveAudio.getState().source).toBe('track')
    const startTrack = vi.fn()
    useLiveDeck.setState({ startTrack }) // LiveScreen offers it once VISUALS is on TRACK
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

  it("maps a point on the preview back to TouchDesigner's 16:9 picture (the COVER crop's inverse)", () => {
    expect(boxToPicture(0.5, 0.5, 9 / 16)).toEqual({ x: 0.5, y: 0.5 })
    // a 9:16 preview shows the picture's middle third or so: its left edge is well inside the picture
    expect(boxToPicture(0, 0.5, 9 / 16).x).toBeCloseTo(0.5 - 0.5 * (9 / 16 / (16 / 9)))
    // a box wider than 16:9 crops top and bottom instead
    expect(boxToPicture(0.5, 0, 3).y).toBeCloseTo(0.5 - 0.5 * (16 / 9 / 3))
  })

  it("turns S1's hand gestures into TouchDesigner commands by the gesture map", () => {
    const pull = { kind: 'pinch_pull' as const, at: 1, rect: { x: 0.2, y: 0.3, w: 0.4, h: 0.2 } }
    const map = { pinch: 'new_window' as const, palm: 'clear' as const, fist: 'freeze' as const }
    expect(gestureCommand(pull, map)).toEqual({ name: 'new_window', rect: pull.rect })
    expect(gestureCommand(pull, { ...map, pinch: 'portal' })).toEqual({ name: 'portal', rect: { x: 0.4, y: 0.4 } })
    expect(gestureCommand({ kind: 'open_palm', at: 2 }, map)).toEqual({ name: 'clear' })
    expect(gestureCommand({ kind: 'fist', at: 3 }, { ...map, fist: 'nothing' })).toBeNull()
  })

  it("feeds a v2 shader look's own macros from the first knobs (its tdmacro0-3), and leaves a v3 look's alone", () => {
    const look = (id: string, macros: number) => ({
      id,
      label: id,
      title: '',
      how: '',
      order: 0,
      tracks: [],
      mode: 'body' as const,
      macros: Array.from({ length: macros }, (_, i) => ({ id: `m${i}`, label: `M${i}`, default: 0 })),
      reacts_to: 'kick',
      palette: [],
      feedback: false,
      sound: null,
    })
    useTdPresets.setState({
      presets: [look('databody', 3), look('plexus', 0)],
      active: 'databody',
      macros: { databody: [0, 0, 0], plexus: [] },
    })
    useProd.setState({ values: {}, reacts: {} })
    const stop = startProdFeed()
    for (const listen of stageFrames) listen(silentFrame(0), 16)
    expect(useTdPresets.getState().macros.databody).toEqual([0.6, 0.5, 0.25]) // INTENSITY, COLOUR, CHAOS defaults, nothing playing
    useTdPresets.setState({ active: 'plexus' })
    for (const listen of stageFrames) listen(silentFrame(0), 16)
    expect(useTdPresets.getState().macros.plexus).toEqual([])
    stop()
  })

  it('says CAMERA BLOCKED, with the way to Camera settings, when macOS refuses the camera without a prompt', () => {
    expect(cameraAlert('denied')).toMatchObject({ title: 'CAMERA BLOCKED.', settings: true })
    expect(cameraAlert('denied')?.text).toContain('Camera settings')
    expect(cameraAlert('timeout')?.settings).toBe(true) // a stale grant can also look like a camera that never answers
    expect(cameraAlert('missing')?.settings).toBe(false)
    for (const ok of ['off', 'asking', 'opening', 'live'] as const) expect(cameraAlert(ok)).toBeNull()
  })

  it("a look's gesture map: the design's defaults, then the look's own, then the user's pick for that look", () => {
    const strings = { id: 'strings', gestures: { pinch_pull: 'pluck' as const, fist: 'nothing' as const } }
    const none = { id: 'airdraw', gestures: {} }
    expect(gesturesOf({ gestureByFx: {} }, none)).toEqual({ pinch: 'new_window', palm: 'clear', fist: 'freeze' })
    expect(gesturesOf({ gestureByFx: {} }, strings)).toEqual({ pinch: 'pluck', palm: 'clear', fist: 'nothing' })
    expect(gesturesOf({ gestureByFx: { strings: { fist: 'blackout' } } }, strings).fist).toBe('blackout')
    // ENERGY BALL: its pinch squeezes in TouchDesigner, so PINCH + PULL sends nothing
    const pull = { kind: 'pinch_pull' as const, at: 1, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }
    expect(gestureCommand(pull, gesturesOf({ gestureByFx: {} }, { id: 'energyball', gestures: { pinch_pull: 'nothing' } }))).toBeNull()
  })
})
