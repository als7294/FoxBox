import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MacroMap, Macros, Preset } from '@/api/types'
import { liveParams } from '@/audio/live/presets'

// The factory preset exactly as the engine ships it.
const legion = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../engine/fx/src/fvwks_fx/presets/legion.json'), 'utf-8'),
) as Preset

const input = (macros: Partial<Macros> = {}, key = 'Am') => ({
  chain: legion.chain,
  macros: { ...legion.macros, ...macros } as Macros,
  macroMap: (legion.macro_map ?? {}) as MacroMap,
  key,
})

describe('LIVE preset mapping', () => {
  it('resolves a studio preset and its macros the way the render does', () => {
    const p = liveParams(input())
    // DEPTH 0.5 on pitch 0 → -6 st and formant 0 → -4 st; GRIT on drive 6 → 24 dB and bits 13 → 7
    expect(p.pitchSt).toBeCloseTo(-3)
    expect(p.formantSt).toBeCloseTo(-2)
    expect(p.driveDb).toBeCloseTo(15)
    expect(p.crushBits).toBeCloseTo(10)
    // fixed params straight from the chain: the radio bed, the band-pass, the ring frequency
    expect(p.noiseDb).toBe(-30)
    expect([p.toneHpHz, p.toneLpHz, p.midDb]).toEqual([300, 3400, 4])
    expect(p.ringHz).toBe(60)
    expect(p.ringMix).toBeCloseTo(0.25)
    // LAYERS is off in LEGION: its layers stay silent live
    expect(p.subDb).toBe(-60)
    expect(p.ghostDb).toBe(-60)
    // the vocoder carrier sits on the key root, in MACHINE's octave
    expect(p.rootHz).toBeCloseTo(110)
    expect(liveParams(input({}, 'F#m')).rootHz).toBeCloseTo(92.5, 1)
  })

  it('follows the macros live', () => {
    const deep = liveParams(input({ depth: 1, space: 0 }))
    expect(deep.pitchSt).toBeCloseTo(-6)
    expect(deep.reverbMix).toBe(0)
    expect(deep.delayMix).toBe(0)
    expect(liveParams(input({ space: 1 })).reverbMix).toBeCloseTo(0.2)
  })
})
