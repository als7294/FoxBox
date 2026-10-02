// STRINGS' BEAT FX: the hands' shapes to the bass-remix FX (beatFx.ts), on S1's signals.
import { describe, expect, it } from 'vitest'
import { beatFx, beatFxDrive, beatFxNow, beatSlot, slideSemis } from '@/audio/live/beatFx'

const hand = (shape: string | null, height = 0.5, x = 0.5) => ({ shape, height, x })
const sig = (over: Record<string, unknown>) => ({ at: 1000, fxShapes: null, tension: 0.5, tilt: 0, shake: 0, shapes: {}, ...over })
const drive = (s: object | null, now = 1000) => beatFxDrive(0.016, now, s as Parameters<typeof beatFxDrive>[2])

describe("STRINGS' BEAT FX", () => {
  it('a fist tears, a pinch wobbles at the BEAT the tension picks; both layer; the newest is beatFxNow', () => {
    drive(sig({ fxShapes: { left: hand('fist', 1), right: null } }), 1000)
    const out = drive(sig({ at: 1100, fxShapes: { left: hand('fist', 1), right: hand('pinch', 0.4) } }), 1100)
    expect(out.tear).toBeCloseTo(1, 6)
    expect(out).toMatchObject({ wobble: 1, wobbleRate: 3 }) // tension 0.5: 1/8T
    expect(out.wobbleDepth).toBeCloseTo(0.64, 6) // full depth sooner: 0.4 at the bottom
    expect(beatFx().left).toMatchObject({ fx: 'tearout', since: 1000 }) // held on: it keeps its start
    expect(beatFx().right).toMatchObject({ fx: 'wobble', label: '1/8T', since: 1100 })
    expect(beatFxNow()).toMatchObject({ fx: 'wobble', label: '1/8T' })
  })

  it("one hand: its x picks the BEAT; peace chops, horns halftime, point down sub-drops, point up rolls, the palm's height growls", () => {
    expect(drive(sig({ fxShapes: { left: null, right: hand('peace', 0, 1) } }))).toMatchObject({ gate: 0.85, gateRate: 6, bassSemi: 0 })
    for (const [shape, key] of [['horns', 'halftime'], ['point_down', 'subdrop'], ['point_up', 'buildroll']] as const)
      expect(drive(sig({ fxShapes: { left: hand(shape), right: null } }))[key]).toBe(1)
    expect(drive(sig({ fxShapes: { left: hand('open_palm', 0.8), right: null } }))).toMatchObject({ growl: 1, vowel: 0.8 })
  })

  it('FRAME is GLASS on both hands (its sound the map’s); stale or no signals fire nothing', () => {
    const out = drive(sig({ shapes: { frame: { held: true } }, fxShapes: { left: hand('fist'), right: hand('peace') } }))
    expect([beatFx().left?.fx, beatFx().right?.fx]).toEqual(['glass', 'glass'])
    expect(out.tear).toBeUndefined()
    const rest = { iso: 1, cutSub: 0, cutLow: 0, cutMid: 0, cutHiMid: 0, cutHigh: 0 } // the isolator ready, all open
    expect(drive(sig({ at: 0, fxShapes: { left: hand('fist'), right: null } }), 1000)).toEqual(rest)
    expect(beatFxNow().fx).toBeNull()
    expect(drive(null)).toEqual(rest)
  })

  it('two hands, nothing held: slack is dark, taut open; the tilt slides the bass in pentatonic steps past ±4°; the shake is its vibrato', () => {
    const open = (tension: number, tilt = 0, shake = 0) => drive(sig({ tension, tilt, shake, fxShapes: { left: hand(null), right: hand(null) } }))
    expect(open(0, 1, 0.8)).toMatchObject({ filter: -0.8, bassSemi: 24, vibrato: 1 }) // a deliberate shake
    expect(open(0, 0, 0.15).vibrato).toBe(0) // dancing
    expect(open(1).filter).toBeCloseTo(0, 6)
    expect(slideSemis(4 / 45)).toBe(0)
    expect(slideSemis(-1)).toBe(-24)
    expect(slideSemis(0.5)).toBe(10) // 10.8 semitones' worth: the nearest step
    expect(slideSemis(0.5, 12)).toBe(12) // held: not half a semitone past the midpoint yet
    expect(slideSemis(0.62, 12)).toBe(15)
    expect([beatSlot(0).label, beatSlot(1).label]).toEqual(['1/4', '1/16T'])
  })

  it('FINGER FILTERS: in strings mode a folded finger cuts its band (the more folded hand); an FX shape reopens them all', () => {
    const fingers = { left: [0, 1, 0, 0.3, 0], right: [0, 0.2, 0, 0.9, 0] }
    const play = (over: Record<string, unknown>) => drive(sig({ stringsMode: true, fingers, fxShapes: { left: hand(null), right: hand(null) }, ...over }))
    expect(play({})).toMatchObject({ iso: 1, cutSub: 0, cutLow: 1, cutMid: 0, cutHiMid: 0.9, cutHigh: 0 })
    expect(play({ stringsMode: false })).toMatchObject({ cutLow: 0, cutHiMid: 0 })
    expect(play({ fxShapes: { left: hand('fist'), right: hand(null) } })).toMatchObject({ cutLow: 0, cutHiMid: 0, tear: 0.8 })
  })
})
