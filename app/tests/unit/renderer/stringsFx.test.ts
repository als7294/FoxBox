import { describe, expect, it } from 'vitest'
import { createBeatFx, createFeelFilter, fingerCuts, gridPhase, gridStep, hudLine, IN_MS, OUT_MS, SNAP_MS, stringFeel, synthBeatFx, type BeatFxHands, type BeatFxSlot } from '@/components/strings/beatFx'

const A = { beatPhase: 0.5, barPhase: 0.125, bpm: 120 }
const slot = (fx: BeatFxSlot['fx'], since = 0, depth = 0.8): BeatFxSlot => ({ fx, depth, beat: 0.5, label: '1/8', since })
const hands = (left: BeatFxSlot | null, right: BeatFxSlot | null = null): BeatFxHands => ({ left, right })

/** Steps at 60 fps; returns the last frame. */
function run(f: ReturnType<typeof createBeatFx>, t0: number, ms: number, fx: BeatFxHands) {
  let out = f.update(t0, fx, A)
  for (let t = t0 + 16; t <= t0 + ms; t += 16) out = f.update(t, fx, A)
  return out
}

describe('STRINGS beat FX: on the grid', () => {
  it("a period's phase and step from the beat's phase (and the bar's for longer ones)", () => {
    expect(gridPhase({ beatPhase: 0.5 }, 1)).toBeCloseTo(0.5)
    expect(gridPhase({ beatPhase: 0.5 }, 0.25)).toBeCloseTo(0) // the 3rd 1/16 starts at half a beat
    expect(gridPhase({ beatPhase: 0.4 }, 1 / 3)).toBeCloseTo(0.2)
    expect(gridStep({ beatPhase: 0.8 }, 0.25)).toBe(3)
    expect(gridPhase({ beatPhase: 0, barPhase: 0.5 }, 4)).toBeCloseTo(0.5)
  })
})

describe('STRINGS beat FX: each hand', () => {
  it('eases in over IN_MS times DEPTH, and out over OUT_MS (no pops)', () => {
    const f = createBeatFx()
    const half = run(f, 0, IN_MS / 2, hands(slot('wobble')))
    expect(half.slots[0].amount).toBeGreaterThan(0.2)
    expect(half.slots[0].amount).toBeLessThan(0.6)
    const full = run(f, IN_MS / 2 + 16, IN_MS, hands(slot('wobble')))
    expect(full.slots[0]).toMatchObject({ mode: 3, amount: 0.8 })
    expect(full.hud).toEqual([{ label: 'WOBBLE', beat: '1/8', depth: 0.8, step: 1 }])
    const going = run(f, 212, OUT_MS / 2, hands(null))
    expect(going.slots[0].amount).toBeGreaterThan(0)
    expect(going.hud).toEqual([]) // the chip goes as the hand lets go
    expect(run(f, 212 + OUT_MS / 2 + 16, OUT_MS, hands(null)).active).toBe(false)
  })

  it('two at once, one per hand; GLASS is skipped (it draws itself)', () => {
    const f = createBeatFx()
    const both = run(f, 0, 300, hands(slot('riddim'), slot('growl')))
    expect(both.slots.map((s) => s.mode)).toEqual([2, 4])
    expect(both.hud.map((h) => h.label)).toEqual(['RIDDIM', 'GROWL'])
    const glass = run(createBeatFx(), 0, 300, hands(slot('glass'), slot('glass')))
    expect(glass.active).toBe(false)
  })

  it('HALFTIME slows the strings to half speed at full depth', () => {
    expect(run(createBeatFx(), 0, 300, hands(slot('halftime', 0, 1))).speed).toBeCloseTo(0.5)
  })

  it('BUILD ROLL builds while held, and SNAPS on release (decaying over SNAP_MS)', () => {
    const f = createBeatFx()
    const held = run(f, 0, 2000, hands(slot('buildroll')))
    expect(held.slots[0].build).toBeCloseTo(2000 / (8 * 500), 1) // 8 beats at 120 bpm
    expect(held.snap).toBe(0)
    const snap = f.update(2016, hands(null), A)
    expect(snap.snap).toBeGreaterThan(0.9)
    expect(run(f, 2032, SNAP_MS, hands(null)).snap).toBe(0)
  })

  it('reduced motion: no moves, a held dim only', () => {
    const r = run(createBeatFx({ reduced: true }), 0, 300, hands(slot('tearout')))
    expect(r.slots[0]).toMatchObject({ mode: 0, amount: 0.8 })
    const snap = run(createBeatFx({ reduced: true }), 0, 300, hands(slot('buildroll')))
    expect(snap.snap).toBe(0)
  })
})

describe('STRINGS beat FX: the HUD and the mock', () => {
  it('reads like the design', () => {
    expect(hudLine({ label: 'WOBBLE', beat: '1/8T', depth: 0.61 })).toBe('WOBBLE · 1/8T · ▮▮▮▯▯ 61%')
  })

  it('the scripted FX take turns and stay out of the GLASS frame', () => {
    const seen = new Set<string>()
    for (let t = 0; t < 30; t += 0.5) {
      const fx = synthBeatFx(t, t * 1000)
      if (t % 14 >= 8 && t % 14 < 11.5) expect(fx).toEqual({ left: null, right: null })
      if (fx.left) seen.add(fx.left.fx)
    }
    expect(seen.size).toBeGreaterThanOrEqual(5)
  })
})

describe("STRINGS: how the hands hold them (S1's tension, tilt, shake)", () => {
  it('only with both hands, and only once S1 sends them; clamped to their ranges', () => {
    expect(stringFeel({ tension: 0.7, tilt: 0.2, shake: 0 }, false)).toBeNull() // a hand missing: tension reads 0, no droop
    expect(stringFeel({}, true)).toBeNull() // before S1's fields land: the strings as they are
    expect(stringFeel({ tension: 1.4, tilt: -3, shake: Number.NaN }, true)).toEqual({ tension: 1, tilt: -1, shake: 0 })
  })
})

describe('STRINGS: calm (the user: "way too bouncy")', () => {
  it("tension's noise doesn't bob the droop; a real change moves it, eased", () => {
    const calm = createFeelFilter()
    const at = (t: number, tension: number) => calm(t, { tension, tilt: 0, shake: 0 })!
    at(0, 0.5)
    for (let t = 16; t < 500; t += 16) expect(at(t, 0.5 + 0.04 * Math.sin(t)).tension).toBe(0.5) // jitter: held
    let moved = 0.5
    for (let t = 500; t < 1500; t += 16) moved = at(t, 0.9).tension
    expect(moved).toBeGreaterThan(0.8)
  })

  it('tilt and shake only past their thresholds', () => {
    const calm = createFeelFilter()
    let f = calm(0, { tension: 0.5, tilt: 0.1, shake: 0.3 })!
    for (let t = 16; t < 400; t += 16) f = calm(t, { tension: 0.5, tilt: 0.1, shake: 0.3 })!
    expect(f).toMatchObject({ tilt: 0, shake: 0 }) // a natural lean, micro-motion
    for (let t = 400; t < 800; t += 16) f = calm(t, { tension: 0.5, tilt: 0.6, shake: 0.8 })!
    expect(f.tilt).toBeGreaterThan(0.5)
    expect(f.shake).toBeGreaterThan(0.5) // a deliberate shake
    expect(calm(816, null)).toBeNull()
  })
})

describe('STRINGS: FINGER FILTERS (S1 fingers + stringsMode)', () => {
  it("each string's cut is its finger's curl on either hand, only while the strings are filters", () => {
    const fingers = { left: [0, 0.2, 0, 0.9, 0], right: [0, 0.6, 0, 0, 0] }
    expect(fingerCuts({ fingers, stringsMode: true })).toEqual([0, 0.6, 0, 0.9, 0])
    expect(fingerCuts({ fingers, stringsMode: false })).toBeUndefined() // an FX shape: the strings come back quietly
    expect(fingerCuts({})).toBeUndefined() // before S1's fields land
    expect(fingerCuts({ fingers: { left: null, right: [0, 0, 2, 0, Number.NaN] }, stringsMode: true })).toEqual([0, 0, 1, 0, 0])
  })
})
