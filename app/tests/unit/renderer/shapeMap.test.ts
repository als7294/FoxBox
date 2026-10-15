import { beforeEach, describe, expect, it, vi } from 'vitest'

const store: Record<string, string> = {}
vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v), removeItem: (k: string) => void delete store[k] })
const { SHAPE_DEFAULTS, shapeActions, useShapeMap } = await import('@/components/camera/shapeMap')
const { usePlayPrefs } = await import('@/components/camera/playPrefs')

beforeEach(() => {
  useShapeMap.getState().reset('play')
  useShapeMap.getState().reset('remix')
})

describe('Edit shapes: the shape → action map', () => {
  it('picking an action another shape has swaps the two; OFF swaps with nothing; per mode; Reset all', () => {
    const { assign, reset } = useShapeMap.getState()
    assign('remix', 'fist', 'wobble')
    expect(useShapeMap.getState().remix).toMatchObject({ fist: 'wobble', pinch: 'tearout' })
    assign('remix', 'horns', 'stutter') // nobody had it
    assign('remix', 'peace', 'off')
    assign('remix', 'point_up', 'off')
    expect(useShapeMap.getState().remix).toMatchObject({ horns: 'stutter', peace: 'off', point_up: 'off', point_down: 'subdrop' })
    expect(useShapeMap.getState().play).toEqual(SHAPE_DEFAULTS.play) // REMIX's picks aren't SAUCE's
    reset('remix')
    expect(useShapeMap.getState().remix).toEqual(SHAPE_DEFAULTS.remix)
  })

  it("the actions by the camera's shapes: SAUCE's POINT is both points", () => {
    useShapeMap.getState().assign('play', 'point', 'echo')
    expect(shapeActions('play')).toEqual({ fist: 'drive', pinch: 'wobble', peace: 'octave', horns: 'space', point_up: 'echo', point_down: 'echo' })
    expect(shapeActions('remix').point_up).toBe('buildroll')
  })

  it('remembered; a remembered map that no longer makes sense falls back to the defaults', async () => {
    useShapeMap.getState().assign('play', 'fist', 'mute')
    expect(JSON.parse(store['foxbox-shapes']!).state.play.fist).toBe('mute')
    const saved = (play: object, remix: object = {}) => {
      store['foxbox-shapes'] = JSON.stringify({ state: { play, remix }, version: 0 })
      return useShapeMap.persist.rehydrate()
    }
    await saved({ fist: 'mute', horns: 'nope', frame: 'drive' }, { pinch: 'sweep' })
    expect(useShapeMap.getState().play).toEqual({ ...SHAPE_DEFAULTS.play, fist: 'mute' }) // unknowns dropped
    expect(useShapeMap.getState().remix.pinch).toBe('sweep')
    await saved({ fist: 'echo' }) // ECHO twice (fist and peace)
    expect(useShapeMap.getState().play).toEqual(SHAPE_DEFAULTS.play)
  })
})

describe('Settings → Playing: left-handed and pluck sensitivity', () => {
  it('remembered; anything else remembered reads the defaults', async () => {
    usePlayPrefs.getState().setLeftHanded(true)
    usePlayPrefs.getState().setSensitivity('high')
    expect(JSON.parse(store['foxbox-play-prefs']!).state).toEqual({ leftHanded: true, sensitivity: 'high' })
    store['foxbox-play-prefs'] = JSON.stringify({ state: { leftHanded: 'yes', sensitivity: 'max' }, version: 0 })
    await usePlayPrefs.persist.rehydrate()
    expect(usePlayPrefs.getState()).toMatchObject({ leftHanded: false, sensitivity: 'medium' })
  })
})
