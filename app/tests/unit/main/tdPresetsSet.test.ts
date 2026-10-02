import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readPresets } from '../../../src/main/bridge/tdProject'

// 1.5.2 ships the known set (the user's call): PROD shows BODY 8 / HANDS 4. A merge that drops a look, or turns a HANDS
// look back to BODY (S2's preset.json carries `mode: "hands"`), fails here. FINGER WINDOWS, LINE SCAN, DOT SCREEN: 1.5.3.
describe("1.5.2's TouchDesigner looks", () => {
  it('are BODY 8 / HANDS 4, with the four HANDS looks', () => {
    const bad: string[] = []
    const presets = readPresets(join(__dirname, '../../../../touchdesigner/presets'), (id, why) => bad.push(`${id}: ${why}`))
    expect(bad).toEqual([])
    const ids = (mode: string) =>
      presets
        .filter((p) => (p.mode ?? 'body') === mode)
        .map((p) => p.id)
        .sort()
    expect(ids('hands')).toEqual(['airdraw', 'energyball', 'portal', 'strings'])
    expect(ids('body')).toHaveLength(8)
  })
})
