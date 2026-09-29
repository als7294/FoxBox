import { describe, expect, it } from 'vitest'
import { posedFace } from '@/components/camera/faceMask'
import { DEFAULT_MASK, PRESETS } from '@/components/camera/maskConfig'
import { liveBeat, maskCovers } from '@/components/camera/maskFace'

describe('a MASKS mask worn on a face', () => {
  it("covers the face's outline, a lens and the lips turned to 0.5 rad, looking up or down at the decks, every preset", () => {
    for (const p of [...PRESETS, { name: 'DEFAULT', cfg: DEFAULT_MASK }])
      for (const yaw of [-0.5, -0.25, 0, 0.25, 0.5])
        for (const pitch of [-0.3, 0, 0.3]) expect(maskCovers(posedFace(640, 360, 12, yaw, pitch), p.cfg), `${p.name} yaw ${yaw} pitch ${pitch}`).toBe(true)
    for (const yaw of [-0.65, 0.65]) expect(maskCovers(posedFace(640, 360, 12, yaw, 0), DEFAULT_MASK)).toBe(true) // a shell, further
  })

  it('says so where it does not cover; the same mask grown covers a turn it missed (never a second mask under it)', () => {
    expect(maskCovers(posedFace(640, 360, 12, 1.5, 0), DEFAULT_MASK)).toBe(false)
    const turned = posedFace(640, 360, 12, 0.8, 0.3)
    expect(maskCovers(turned, DEFAULT_MASK)).toBe(false)
    expect([1.12, 1.25, 1.4].some((g) => maskCovers(turned, DEFAULT_MASK, g))).toBe(true)
  })

  it('the glitch fires only on a drop VISUALS knows; the drop bursts the glow; never over 3 flashes a second', () => {
    const st = { lastBeat: -9, dropT: -9 }
    const kick = (t: number) => Math.exp(-((t * 145) / 60 % 1) * 5)
    expect(liveBeat(DEFAULT_MASK, kick(1), null, st, 1, false).glitch).toBe(false) // no drop known: no glitch
    const hit = liveBeat(DEFAULT_MASK, kick(2), { hit: true, energy: 1 }, st, 2, false)
    expect(hit.glitch).toBe(true)
    expect(hit.beat.sinceDrop).toBeCloseTo(0)
    const later = liveBeat(DEFAULT_MASK, kick(3), { hit: false, energy: 0.4 }, st, 3, false)
    expect(later.env).toBeLessThan(hit.env) // the burst decays
    expect(liveBeat({ ...DEFAULT_MASK, beat: 'off' }, 1, { hit: true, energy: 1 }, { lastBeat: -9, dropT: -9 }, 4, false).env).toBe(1)
    // Flashes: the envelope's rises over 10 s of kicks with a drop landing at 5 s.
    const s2 = { lastBeat: -9, dropT: -9 }
    let low = Infinity
    let n = 0
    for (let t = 0; t < 10; t += 1 / 60) {
      const drop = t >= 5 ? { hit: t - 5 < 1 / 60, energy: Math.max(0, 1 - (t - 5) / 1.6) } : null
      const e = liveBeat(DEFAULT_MASK, kick(t), drop, s2, t, false).env
      if (e < low) low = e
      else if (e - low > 0.25) {
        n++
        low = e
      }
    }
    expect(n / 10).toBeLessThanOrEqual(3)
  })
})
