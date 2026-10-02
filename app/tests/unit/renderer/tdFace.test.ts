import { describe, expect, it } from 'vitest'
import { useVisuals } from '@/state/visuals'
import { useTdCamera } from '@/touchdesigner/camera'
import { tdFaceVisible } from '@/touchdesigner/face'
import { sceneHasTd, TD_STYLE } from '@/visuals/live/compositor'

describe('TouchDesigner and the face (1.5.2)', () => {
  it('SEND TO VISUALS keeps one TD layer, on top, with its look', () => {
    const v = useVisuals.getState()
    v.setBase({ kind: 'core' })
    v.addEffect('foxbox.tunnel')
    v.addTdLayer('plexus')
    v.addEffect('foxbox.tunnel')
    v.addTdLayer('portal')
    const fx = useVisuals.getState().scene.effects
    expect(fx.filter((e) => e.styleId === TD_STYLE)).toHaveLength(1)
    expect(fx.at(-1)).toMatchObject({ styleId: TD_STYLE, td: { preset: 'portal' } })
    expect(sceneHasTd(useVisuals.getState().scene)).toBe(true)
  })

  it('counts the raw camera into TD as face visible, unless MASK FIRST or no TD in the scene', () => {
    const scene = useVisuals.getState().scene
    const noTd = { ...scene, effects: scene.effects.filter((e) => e.styleId !== TD_STYLE) }
    useTdCamera.setState({ state: 'live' })
    useTdCamera.setState({ maskFirst: false })
    expect(tdFaceVisible()).toBe(true) // PROD
    expect(tdFaceVisible(scene)).toBe(true) // VISUALS with a TD layer, FACE ENCRYPTION or not
    expect(tdFaceVisible(noTd)).toBe(false)
    useTdCamera.setState({ maskFirst: true })
    expect(tdFaceVisible(scene)).toBe(false)
    useTdCamera.setState({ maskFirst: false })
    useTdCamera.setState({ state: 'denied' })
    expect(tdFaceVisible()).toBe(false)
  })
})
