import { describe, expect, it } from 'vitest'
import { createLoopHints, drawLoopRing, playheadAngle, RING, ringGeometry } from '@/components/strings/loopRing'
import type { MelodyLoop } from '@/components/strings/playFeed'

const loop = (o: Partial<MelodyLoop> = {}): MelodyLoop => ({
  notes: [60, 62, 64, 67, 69, 67, 64, 62], playing: 2, phase: 0.3, beat: 1, beats: 4, brightness: 0.5, register: 0, space: 0, dropped: false, ...o,
})
const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

describe('Melody mode: the loop ring', () => {
  it('sits between the palms, a register step raises it, space widens it', () => {
    const r = { x: 0.3, y: 0.6 }
    const l = { x: 0.7, y: 0.5 }
    expect(ringGeometry(r, l, loop())).toEqual({ x: 0.5, y: 0.55, r: RING.radius })
    expect(ringGeometry(r, l, loop({ register: 1 })).y).toBeCloseTo(0.55 - RING.lift)
    expect(ringGeometry(r, l, loop({ space: 1 })).r).toBeCloseTo(RING.radius * (1 + RING.spaceGrow))
    expect(ringGeometry(null, null, loop())).toMatchObject({ x: 0.5, y: 0.5 })
  })
  it('its playhead goes round once a bar, or steps per beat with reduced motion', () => {
    expect(playheadAngle(loop({ phase: 0.25 }), false)).toBeCloseTo(Math.PI / 2)
    expect(playheadAngle(loop({ phase: 0.3, beat: 1 }), true)).toBeCloseTo(Math.PI / 2)
  })
  it('a palm label goes after 3 uses of its control (brightness moved 0.3+, a register change), remembered', () => {
    const store = memory()
    const h = createLoopHints(store)
    h.note(loop({ brightness: 0.1 }), 0)
    for (const [b, t] of [[0.5, 1], [0.1, 2], [0.45, 3]] as const) h.note(loop({ brightness: b }), t * 1000)
    expect(h.uses('brightness')).toBe(3)
    expect(h.alpha('brightness', 3000)).toBe(1)
    expect(h.alpha('brightness', 4600)).toBe(0)
    expect(h.alpha('register', 4600)).toBe(1)
    h.note(loop({ register: 1 }), 5000)
    expect(h.uses('register')).toBe(1)
    expect(createLoopHints(store).uses('brightness')).toBe(3) // this Mac remembers
  })
  it('draws without pluck strings, its labels big (28 px at 1280) while learnt; a drop leaves an outline', () => {
    const fonts: string[] = []
    let texts = 0
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (t, k) => (k in t ? t[k as string] : k === 'fillText' ? () => texts++ : k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {}),
      set: (t, k, v) => ((k === 'font' && fonts.push(String(v)), (t[k as string] = v)), true),
    }) as unknown as CanvasRenderingContext2D
    const palm = (x: number) => Array.from({ length: 21 }, (_, i) => ({ x, y: i === 9 ? 0.45 : 0.6 }))
    const look = { core: [255, 241, 222] as [number, number, number], glow: [255, 122, 31] as [number, number, number], width: 2, px: 1 }
    const o = { now: 1000, w: 1280, h: 720, look, hints: createLoopHints(memory()), reduced: false, noteAt: [900] }
    drawLoopRing(ctx, { right: palm(0.3), left: palm(0.7) }, loop(), o)
    expect(texts).toBe(2) // BRIGHTER, HIGHER
    expect(fonts.some((f) => f.startsWith('800 28.0px'))).toBe(true)
    expect(() => drawLoopRing(ctx, { right: null, left: null }, loop({ dropped: true }), o)).not.toThrow()
  })
})
