import { describe, expect, it } from 'vitest'
import { DEFAULT_RECIPE as D, normalize, PRESETS, RECIPE_VERSION } from '@/components/camera/maskRecipe'

describe('v1-v3 recipes (kept so saved ones load)', () => {
  it('any JSON is a clean recipe, and an older one comes up to date', () => {
    const hostile = normalize({ base: { snout: 99, brow: -3 }, material: { kind: '<script>' }, colours: { primary: 'url(x)' }, eyes: { size: 'big' } })
    expect([hostile.base.snout, hostile.base.brow, hostile.material.kind, hostile.colours.primary, hostile.eyes.size]).toEqual([1, 0, D.material.kind, D.colours.primary, 0.5])
    for (const r of PRESETS) expect(normalize(r)).toEqual(r)
    const v1 = normalize({ v: 1, name: 'OLD', base: { snout: 0.5 }, material: { kind: 'facets' } })
    expect([v1.v, v1.base.shape, v1.base.snout, v1.material.kind]).toEqual([RECIPE_VERSION, 'full', 0.5, 'facets'])
    const v2 = normalize({ v: 2, colours: { secondary: '#123456' }, glow: { beat: false } })
    expect([v2.colours.accent, v2.glow.mode]).toEqual(['#123456', 'off'])
  })
})
