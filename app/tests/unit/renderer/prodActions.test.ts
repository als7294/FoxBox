import { describe, expect, it } from 'vitest'
import { answer, request } from '@/components/prod/prodActions'
import { gestureCommand, startProdFeed } from '@/components/prod/prodFeed'
import { silentFrame } from '@/visuals/live/registry'
import { stageFrames } from '@/visuals/live/stage'
import { gesturesOf, useProd } from '@/components/prod/prodStore'
import { boxToPicture, cameraAlert } from '@/components/prod/TdPreview'
import { useVisuals } from '@/state/visuals'
import { useTdCamera } from '@/touchdesigner/camera'
import { useTdPresets } from '@/touchdesigner/presets'
import { TD_STYLE } from '@/visuals/live/compositor'

describe('PROD', () => {
  it('asks before SEND TO VISUALS while the face is visible; MASK FIRST, THEN SEND hides it, then sends', () => {
    useTdPresets.setState({ active: 'plexus' })
    useTdCamera.setState({ state: 'live', maskFirst: false })
    request('send')
    expect(useProd.getState().confirm).toBe('send')
    expect(useVisuals.getState().scene.effects.some((e) => e.styleId === TD_STYLE)).toBe(false)
    answer('mask')
    expect(useTdCamera.getState().maskFirst).toBe(true)
    expect(useProd.getState().confirm).toBeNull()
    expect(useVisuals.getState().scene.effects.at(-1)).toMatchObject({ styleId: TD_STYLE, td: { preset: 'plexus' } })
    // face hidden now: straight through, no question
    request('send')
    expect(useProd.getState().confirm).toBeNull()
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
