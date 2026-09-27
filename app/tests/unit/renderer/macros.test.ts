import { describe, expect, it } from 'vitest'
import type { MacroTarget, ParamSpec } from '../../../src/renderer/src/api/types'
import { macroTargetValue, roundHalfEven } from '../../../src/renderer/src/lib/macros'

// Values resolved by the engine itself (fvwks_fx.api.resolve, S2), the macro under test at m and the
// others at 0.5. The last three targets are synthetic (no factory preset uses exp/log yet).
const knob = (min: number, max: number, step: number | null = null) => ({ kind: 'knob', min, max, step }) as ParamSpec
const lin = (min: number, max: number, curve: MacroTarget['curve'] = 'lin') => ({ module: 'm', param: 'p', min, max, curve }) as MacroTarget
const M = [0, 0.25, 0.5, 0.75, 1]

const TABLE: [string, MacroTarget, ParamSpec, number[], boolean][] = [
  ['pact depth mask.pitch_st', lin(-4, -14), knob(-24, 12, 0.1), [-4, -6.5, -9, -11.5, -14], false],
  ['pact depth layers.sub_gain_db (clamped at max)', lin(-18, 2), knob(-60, 0), [-18, -13, -8, -3, 0], false],
  ['pact space space.reverb_mix', lin(0.05, 0.25), knob(0, 1), [0.05, 0.1, 0.15, 0.2, 0.25], false],
  ['raw grit drive.mix (dead zone below 0.5)', lin(-0.6, 0.6), knob(0, 1), [0, 0, 0, 0.3, 0.6], false],
  ['raw space space.reverb_mix (dead zone)', lin(-0.2, 0.2), knob(0, 1), [0, 0, 0, 0.1, 0.2], false],
  ['unit space space.reverb_mix (dead zone)', lin(-0.1, 0.1), knob(0, 1), [0, 0, 0, 0.05, 0.1], false],
  ['raw machine mask.mcadams', lin(1, 0.6), knob(0.5, 1), [1, 0.9, 0.8, 0.7, 0.6], false],
  ['legion grit crush.bits (8.5 → 8)', lin(13, 7), knob(4, 24, 1), [13, 12, 10, 8, 7], true],
  ['signal grit crush.bits (4.5 → 4, clamped min)', lin(9, 3), knob(4, 24, 1), [9, 8, 6, 4, 4], true],
  ['ghost machine layers.ghost_gain_db', lin(-40, -12), knob(-60, 0), [-40, -33, -26, -19, -12], false],
  ['exp tone.lp_hz', lin(2000, 12000, 'exp'), knob(1000, 20000), [2000, 3130.1692, 4898.9795, 7667.3173, 12000], false],
  ['log space.reverb_decay_s', lin(0.5, 6, 'log'), knob(0.2, 10), [0.5, 3.3154, 4.572, 5.3912, 6], false],
  ['exp with min ≤ 0 falls back to lin', lin(0, 1, 'exp'), knob(0, 1), [0, 0.25, 0.5, 0.75, 1], false],
]

describe('macro → param (matches the engine resolve)', () => {
  it.each(TABLE)('%s', (_name, target, param, expected, integer) => {
    M.forEach((m, i) => {
      const v = macroTargetValue(target, m, param)
      if (integer) expect(v).toBe(expected[i])
      else expect(v).toBeCloseTo(expected[i]!, 3)
    })
  })

  it('rounds halves to even like Python', () => {
    expect([8.5, 4.5, 9.5, -7.5, -8.5, 2.4, 2.6].map(roundHalfEven)).toEqual([8, 4, 10, -8, -8, 2, 3])
  })
})
