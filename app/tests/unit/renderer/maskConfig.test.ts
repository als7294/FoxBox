import { describe, expect, it } from 'vitest'
import { BUILTIN, DEFAULT_MASK, normalizeConfig, PRESETS } from '@/components/camera/maskConfig'
import { PRESETS as OLD } from '@/components/camera/maskRecipe'

describe('MaskConfig (recipe v4)', () => {
  it('any JSON is a clean config: sliders 0-100, choices from their lists, colours #rrggbb, the TAG six letters', () => {
    const c = normalizeConfig({ base: '<script>', brow: 999, cheeks: -4, chin: 33.6, c1: 'url(x)', c3: '#ABCDEF', tag: 'hello world!', onGlow: 'yes', extra: 1 })
    expect([c.base, c.brow, c.cheeks, c.chin, c.c1, c.c3, c.tag, c.onGlow]).toEqual([DEFAULT_MASK.base, 100, 0, 34, DEFAULT_MASK.c1, '#abcdef', 'HELLOW', DEFAULT_MASK.onGlow])
    expect(c).not.toHaveProperty('extra')
    expect(normalizeConfig(null)).toEqual(DEFAULT_MASK)
    for (const p of [...PRESETS, ...BUILTIN]) expect(normalizeConfig(p.cfg), p.name).toEqual(p.cfg)
    expect(normalizeConfig(normalizeConfig(c))).toEqual(c)
  })

  it('a v1-v3 recipe comes up as its nearest config', () => {
    const oni = normalizeConfig(OLD[0]) // NEON ONI: glass, devil horns, fangs, glow eyes, stripes
    expect(oni).toMatchObject({ base: 'full', mat: 'glass', ears: 'horns', eyes: 'dots', pattern: 'stripes', c1: OLD[0]!.colours.primary, glowColor: OLD[0]!.glow.color, beat: 'drop' })
    const v1 = normalizeConfig({ v: 1, base: { snout: 0.5 }, material: { kind: 'facets' }, glow: { beat: false } })
    expect(v1).toMatchObject({ base: 'full', mat: 'poly', beat: 'off' })
    for (const r of OLD) expect(normalizeConfig(normalizeConfig(r))).toEqual(normalizeConfig(r))
  })
})
