import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readPresets } from '../../../src/main/bridge/tdProject'

let dir = ''
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

describe("preset.json's gestures and new (1.5.2)", () => {
  it('keeps known gesture actions, drops the rest, and reads NEW', () => {
    dir = mkdtempSync(join(tmpdir(), 'td-presets-'))
    const add = (id: string, json: object) => {
      mkdirSync(join(dir, id))
      writeFileSync(join(dir, id, 'preset.json'), JSON.stringify(json))
      writeFileSync(join(dir, id, 'frag.glsl'), 'void main() {}')
    }
    add('strings', {
      label: 'STRING HANDS',
      mode: 'hands',
      new: true,
      gestures: { pinch_pull: 'pluck', fist: 'nothing', open_palm: 'explode', wave: 'clear' },
    })
    add('plexus', { label: 'PLEXUS' })
    const [plexus, strings] = readPresets(dir).sort((a, b) => a.id.localeCompare(b.id))
    expect(strings).toMatchObject({ new: true, gestures: { pinch_pull: 'pluck', fist: 'nothing' } })
    expect(strings!.gestures).not.toHaveProperty('open_palm') // an unknown action
    expect(strings!.gestures).not.toHaveProperty('wave') // an unknown gesture
    expect(plexus).toMatchObject({ new: false, gestures: {} })
  })
})
