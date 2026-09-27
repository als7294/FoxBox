import { describe, expect, it } from 'vitest'
import { crossfade, easeProfile, motionTarget, type MotionInputs } from '../../../src/renderer/src/visuals/motionProfile'

const mid = { depth: 0.5, grit: 0.5, machine: 0.5, space: 0.5 }
const input = (patch: Partial<MotionInputs> = {}): MotionInputs => ({
  presetId: null,
  macros: mid,
  param: () => undefined,
  stackCount: 0,
  ...patch,
})

describe('voice core motion profile', () => {
  it('follows the macros: DEPTH is mass and gravity (slower), GRIT turbulence, MACHINE lattice + stepping, SPACE trails', () => {
    const light = motionTarget(input({ macros: { ...mid, depth: 0 } }))
    const heavy = motionTarget(input({ macros: { ...mid, depth: 1 } }))
    expect(heavy.mass).toBeGreaterThan(light.mass)
    expect(heavy.gravity).toBeGreaterThan(light.gravity)
    expect(heavy.rot).toBeLessThan(light.rot)
    expect(motionTarget(input({ macros: { ...mid, grit: 1 } })).turbulence).toBeGreaterThan(motionTarget(input({ macros: { ...mid, grit: 0 } })).turbulence)
    const machine = motionTarget(input({ macros: { ...mid, machine: 1 } }))
    expect(machine.lattice).toBeGreaterThan(0.75)
    expect(machine.step).toBeCloseTo(1, 6)
    expect(motionTarget(input({ macros: { ...mid, machine: 0.2 } })).step).toBe(0)
    expect(motionTarget(input({ macros: { ...mid, space: 1 } })).trails).toBeGreaterThan(motionTarget(input({ macros: { ...mid, space: 0 } })).trails)
  })

  it('reads the resolved chain, so user presets get their own feel (no factory signature)', () => {
    const subby = motionTarget(input({ presetId: 'user-my-mask', param: (m, p) => (m === 'layers' && p === 'sub_gain_db' ? 0 : undefined) }))
    const dry = motionTarget(input({ presetId: 'user-my-mask', param: () => undefined }))
    expect(subby.mass).toBeGreaterThan(dry.mass)
    expect(subby.subPulse).toBeGreaterThan(dry.subPulse)
    expect(subby.clusters + subby.glitch + subby.ember + subby.pale).toBe(0)
    expect(motionTarget(input({ param: (m, p) => (m === 'mask' && p === 'growl' ? 1 : undefined) })).tremor).toBeGreaterThan(0.5)
  })

  it('gives each factory preset its signature', () => {
    const f = (presetId: string, stackCount = 0) => motionTarget(input({ presetId, stackCount }))
    expect(f('pact', 2)).toMatchObject({ ember: 1, satellites: 1 })
    expect(f('pact', 2).mass).toBeGreaterThanOrEqual(0.65)
    expect(f('legion')).toMatchObject({ clusters: 1 })
    expect(f('legion').scan).toBeGreaterThan(0.5)
    expect(f('abyss')).toMatchObject({ drift: 1 })
    expect(f('abyss').darkness).toBeGreaterThan(0.5)
    expect(f('unit')).toMatchObject({ step: 1, sharp: 1 })
    expect(f('unit').lattice).toBeGreaterThanOrEqual(0.92)
    expect(f('ghost')).toMatchObject({ pale: 1, sharp: 0 })
    expect(f('ghost').trails).toBeGreaterThanOrEqual(0.88)
    expect(f('signal')).toMatchObject({ glitch: 1, rgb: 1 })
    const raw = f('raw')
    expect(raw.breathing).toBe(1)
    expect(raw.turbulence).toBeLessThan(motionTarget(input()).turbulence)
    // A/B dry side: the raw voice, no signature.
    expect(motionTarget(input({ presetId: 'signal', dry: true })).glitch).toBe(0)
  })

  it('crossfades to a new profile in about 400 ms', () => {
    const live = motionTarget(input({ presetId: 'unit' }))
    const next = motionTarget(input({ presetId: 'ghost' }))
    for (let t = 0; t < 400; t += 16) easeProfile(live, next, crossfade(16))
    expect(live.pale).toBeGreaterThan(0.94)
    expect(live.step).toBeLessThan(0.06)
    // Reduce Motion jumps straight there.
    const jump = motionTarget(input({ presetId: 'unit' }))
    easeProfile(jump, next, 1)
    expect(jump).toEqual(next)
  })
})
