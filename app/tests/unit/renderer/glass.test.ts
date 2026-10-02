import { describe, expect, it } from 'vitest'
import { handShapes, type HandShapes } from '@/components/camera/camMath'
import { CRACK_MS, createGlass, EXIT_HOLD_MS, FADE_MS, fitGlass, glassSignal, type GlassQuad } from '@/components/strings/glass'
import { synthHands, synthL } from '@/components/strings/strings'

const ASPECT = 16 / 9
const PANE: GlassQuad = { x: 0.5, y: 0.5, hw: 0.2, hh: 0.15, tilt: 0.1 }

/** Steps the glass at 60 fps from `t0` for `ms`, the frame held or not; returns the last frame. */
function run(g: ReturnType<typeof createGlass>, t0: number, ms: number, held: boolean) {
  let f = g.update(t0, held, held ? PANE : null)
  for (let t = t0 + 16; t <= t0 + ms; t += 16) f = g.update(t, held, held ? PANE : null)
  return f
}

describe('STRINGS GLASS: on and off', () => {
  it('fades in over FADE_MS (eased) once the frame is held', () => {
    const g = createGlass({ aspect: ASPECT })
    expect(g.update(0, false, null).mix).toBe(0)
    const first = g.update(16, true, PANE)
    expect(first).toMatchObject({ type: 'thermal', changed: true })
    const half = run(g, 32, FADE_MS / 2 - 32, true)
    expect(half.mix).toBeGreaterThan(0.2)
    expect(half.mix).toBeLessThan(0.8)
    expect(run(g, FADE_MS / 2, FADE_MS, true).mix).toBe(1)
    expect(glassSignal()).toMatchObject({ on: true, type: 'thermal', crackAt: 0 })
  })

  it('a frame lost for less than EXIT_HOLD_MS is the same glass: no flicker, no crack, no new kind', () => {
    const g = createGlass({ aspect: ASPECT })
    run(g, 0, 600, true)
    const lost = run(g, 616, EXIT_HOLD_MS - 50, false)
    expect(lost).toMatchObject({ mix: 1, crack: -1, type: 'thermal' })
    const back = run(g, 616 + EXIT_HOLD_MS - 34, 200, true)
    expect(back).toMatchObject({ mix: 1, crack: -1, type: 'thermal', changed: false })
  })

  it('letting go cracks it (the shards over CRACK_MS) as it fades out, and the strings come back', () => {
    const g = createGlass({ aspect: ASPECT })
    run(g, 0, 600, true)
    const gone = 616 + EXIT_HOLD_MS
    run(g, 616, EXIT_HOLD_MS - 16, false)
    const start = g.update(gone, false, null)
    expect(start.crack).toBeGreaterThanOrEqual(0)
    expect(start.crack).toBeLessThan(0.1)
    expect(glassSignal()).toMatchObject({ on: false, crackAt: gone })
    expect(run(g, gone + 16, CRACK_MS / 2, false).crack).toBeCloseTo(0.5, 1)
    const after = run(g, gone + CRACK_MS / 2 + 16, FADE_MS, false)
    expect(after.mix).toBe(0)
    expect(after.quad).toBeNull()
  })
})

describe('STRINGS GLASS: each new frame the next world', () => {
  it('THERMAL, X-RAY, HALFTONE, PRISM, KALEIDO, DATAMOSH, then THERMAL again', () => {
    const g = createGlass({ aspect: ASPECT })
    const kinds: string[] = []
    let t = 0
    for (let i = 0; i < 7; i++) {
      kinds.push(run(g, t, 500, true).type)
      t += 516
      run(g, t, 1000, false)
      t += 1016
    }
    expect(kinds).toEqual(['thermal', 'xray', 'halftone', 'prism', 'kaleido', 'datamosh', 'thermal'])
  })

  it('reduced motion: the plain pane every time, a fade with no shards', () => {
    const g = createGlass({ aspect: ASPECT, reduced: true })
    let t = 0
    for (let i = 0; i < 3; i++) {
      expect(run(g, t, 500, true).type).toBe('plain')
      t += 516
      const out = run(g, t, EXIT_HOLD_MS + 100, false)
      expect(out.crack).toBe(-1)
      t += 1016
      run(g, t - 500, 400, false)
    }
  })
})

describe('STRINGS GLASS: the pane between the hands', () => {
  const frameHands = (t: number) => synthHands(t, ASPECT).hands

  it('the scripted frame is S1\'s FRAME (an L each), held after its hold', () => {
    let prev: HandShapes | null = null
    let now = 0
    for (let t = 8.1; t < 8.6; t += 1 / 30) {
      const h = frameHands(t)
      prev = handShapes([h.left!, h.right!].map((points) => ({ points, gesture: null })), (now += 33), prev, ASPECT, h.body)
    }
    expect(prev!.frame.held).toBe(true)
  })

  it('sits between the four fingertips, its tilt the hands\' (folded to ±45°)', () => {
    const level = fitGlass(synthL(0.4, 0.62, 0.3, 0, ASPECT), synthL(0.6, 0.38, 0.3, Math.PI, ASPECT), ASPECT)
    expect(level.tilt).toBeCloseTo(0, 5)
    expect(level.x).toBeCloseTo(0.5, 1)
    expect(level.y).toBeCloseTo(0.5, 1)
    expect(level.hw).toBeGreaterThan(level.hh * 0.5)
    // the scripted frame turns by 0.3 sin(0.9 t)
    const t = 9.2
    const tilted = fitGlass(frameHands(t).left!, frameHands(t).right!, ASPECT)
    expect(tilted.tilt).toBeCloseTo(0.3 * Math.sin(0.9 * t), 2)
  })
})
