import { describe, expect, it } from 'vitest'
import type { Scene } from '@/visuals/live/compositor'
import { AutoDirector } from '@/visuals/live/director'
import type { AudioFrame } from '@/visuals/live/registry'

const scene: Scene = {
  base: { kind: 'core' },
  paletteId: 'transmission',
  effects: [
    { id: 'a', styleId: 's1', opacity: 0.8, blend: 'add', reactTo: 'mix', enabled: true },
    { id: 'b', styleId: 's2', opacity: 0.6, blend: 'screen', reactTo: 'drums', enabled: true },
    { id: 'locked', styleId: 's3', opacity: 0.5, blend: 'normal', reactTo: 'mix', enabled: true, locked: true },
  ],
}
const frame = (t: number, extra: Partial<AudioFrame>): AudioFrame => ({
  time: t, rms: 0.5, bands: { low: 0.5, mid: 0.5, high: 0.5 }, onset: 0, fft: null, waveL: null, waveR: null, sampleRate: 48000,
  bpm: 120, beatPhase: (t * 2) % 1, active: true, bar: Math.floor(t / 2) + 1, barPhase: (t / 2) % 1, ...extra,
})

describe('AUTO-VJ director', () => {
  it('builds tension, holds before the drop, cuts on each drop differently, breathes in breakdowns', () => {
    const d = new AutoDirector({ reduced: () => false })
    expect(d.frame(frame(0, { section: 'intro' }), scene)).toBeNull() // AUTO off
    d.setEnabled(true)
    const early = d.frame(frame(10, { section: 'build', buildProgress: 0.1 }), scene)!
    const late = d.frame(frame(15, { section: 'build', buildProgress: 0.95 }), scene)!
    expect(late.layers!.a!.params!.intensity!).toBeGreaterThan(early.layers!.a!.params!.intensity!)
    expect(late.speed!).toBeGreaterThan(early.speed!)
    expect(late.layers!.locked).toBeUndefined() // locked layers are never touched
    const held = d.frame(frame(15.9, { section: 'build', buildProgress: 0.99, preDrop: true }), scene)!
    expect(held.speed!).toBeLessThan(0.2)
    expect(held.layers!.b!.opacity!).toBeLessThan(0.3)
    for (let t = 15; t < 15.9; t += 1 / 60) d.frame(frame(t, { section: 'build', buildProgress: 0.7 }), scene)
    const drained = d.frame(frame(15.9, { section: 'build', buildProgress: 0.7 }), scene)!
    expect(drained.saturation!).toBeLessThan(0.4) // the colour drains through the build
    const hit1 = d.frame(frame(16, { section: 'drop', dropHit: true, dropEnergy: 1, dropIndex: 1 }), scene)!
    expect(hit1.punch).toBe(1)
    expect(hit1.saturation).toBeCloseTo(1.3) // back hot, as a cut
    const groove = d.frame(frame(17, { section: 'drop', dropEnergy: 0.25, dropIndex: 1 }), scene)!
    expect(groove.layers!.a!.params!.intensity!).toBeGreaterThan(early.layers!.a!.params!.intensity!) // hotter than before the build
    const hit2 = d.frame(frame(60, { section: 'drop', dropHit: true, dropEnergy: 1, dropIndex: 2 }), scene)!
    expect(hit2.hueShift).not.toBeCloseTo(hit1.hueShift!) // the second drop cuts elsewhere
    const breathe = d.frame(frame(80, { section: 'breakdown' }), scene)!
    expect(breathe.speed!).toBeLessThan(1)
  })

  it('stays calm with reduced motion and follows the bass line', () => {
    const d = new AutoDirector({ reduced: () => true })
    d.setEnabled(true)
    const hit = d.frame(frame(16, { section: 'drop', dropHit: true, dropEnergy: 1, dropIndex: 1 }), scene)!
    expect(hit.punch).toBe(0)
    expect(hit.speed!).toBeLessThanOrEqual(1.1)
    const bass = { on: true, noteOn: false, heldBeats: 4, expectBeats: 8, sub: 1, growl: 0, pitch: 45, glide: 0, wobble: { div: null, phase: 0 } }
    const held = new AutoDirector({ reduced: () => false })
    held.setEnabled(true)
    const z = held.frame(frame(20, { section: 'verse', bass }), scene)!.layers!.a!.params!.zoom!
    expect(z).toBeCloseTo(0.25) // halfway through an 8-beat sub: the stretch is halfway
    const half = held.frame(frame(21, { section: 'verse', feel: { halfTime: true, style: 'dubstep' } }), scene)!
    expect(half.speed!).toBeCloseTo(0.5)
  })
})

describe('AUTO-VJ new looks at each section', () => {
  const layered: Scene = {
    base: { kind: 'core' },
    paletteId: 'transmission',
    effects: [
      { id: 'g', styleId: 'gen.a', opacity: 1, blend: 'add', reactTo: 'mix', enabled: true },
      { id: 'f', styleId: 'fil.a', opacity: 1, blend: 'normal', reactTo: 'mix', enabled: true, locked: true },
      { id: 'm', styleId: 'milk.a', opacity: 1, blend: 'screen', reactTo: 'mix', enabled: true },
      { id: 'td', styleId: 'touchdesigner', opacity: 1, blend: 'normal', reactTo: 'mix', enabled: true, td: { preset: 'plexus' } },
      { id: 'txt', styleId: 'text.lyrics', opacity: 1, blend: 'normal', reactTo: 'mix', enabled: true },
    ],
  }
  const catalog = () => ({ gen: ['gen.a', 'gen.b', 'gen.c', 'gen.d', 'gen.e'], fil: ['fil.a', 'fil.b'],
    milk: ['milk.a', 'milk.b', 'milk.c', 'milk.d', 'milk.e'] })

  it('swaps every unlocked layer for another of its kind at INTRO / BUILD / DROP / BREAK, and says so', () => {
    let scene = layered
    const swaps: Record<string, string>[] = []
    const events: unknown[] = []
    const d = new AutoDirector({ reduced: () => false, catalog, random: () => 0.5, applySwaps: (s) => {
      swaps.push(s)
      scene = { ...scene, effects: scene.effects.map((l) => (s[l.id] ? { ...l, styleId: s[l.id]! } : l)) }
    } })
    d.onSwap((e) => events.push(e))
    d.frame(frame(0, { section: 'verse' }), scene) // AUTO off: nothing
    d.setEnabled(true)
    d.frame(frame(1, { section: 'verse' }), scene) // the first frame only notes the section
    expect(swaps).toEqual([])
    d.frame(frame(2, { section: 'build' }), scene)
    expect(Object.keys(swaps[0]!).sort()).toEqual(['g', 'm']) // the locked filter, TOUCHDESIGNER and TEXT stay
    expect(swaps[0]!.g).toMatch(/^gen\./)
    expect(swaps[0]!.m).toMatch(/^milk\./)
    expect(events).toEqual([{ section: 'build', changed: 2, kept: 1 }])
    const seen = new Map(layered.effects.map((l) => [l.id, [l.styleId]]))
    for (const [t, section] of [[3, 'drop'], [4, 'breakdown'], [5, 'build'], [6, 'drop']] as const) {
      d.frame(frame(t, { section }), scene)
      const s = swaps.at(-1)!
      for (const id of ['g', 'm']) {
        expect(seen.get(id)!.slice(-3)).not.toContain(s[id]) // never back to one of its last three looks
        seen.get(id)!.push(s[id]!)
      }
      expect(new Set(scene.effects.map((l) => l.styleId)).size).toBe(scene.effects.length) // never two of one look
    }
    const n = swaps.length
    d.frame(frame(7, { section: 'verse' }), scene)
    d.frame(frame(8, { section: 'outro' }), scene)
    expect(swaps.length).toBe(n) // verses and the outro keep the look
  })
})

describe('the countdown to the next section (TRACK)', () => {
  it('names the next section and the beats to it', async () => {
    const { StructureTrack } = await import('@/audio/live/structure')
    const json = { sections: [{ kind: 'intro', start_s: 0, end_s: 8, start_bar: 1, energy: 0.3 }, { kind: 'build', start_s: 8, end_s: 16, start_bar: 5, energy: 0.6 },
      { kind: 'drop', start_s: 16, end_s: 32, start_bar: 9, energy: 1 }], drops_s: [16], builds: [[8, 16]] as [number, number][],
      phrase_bars: 8, energy_fps: 10, energy_b64: '' }
    const track = new StructureTrack(json as never, 120)
    expect(track.at(4)).toMatchObject({ section: 'intro', nextSection: 'build', nextIn: 8 }) // 4 s at 120 BPM
    expect(track.at(12)).toMatchObject({ section: 'build', nextSection: 'drop', nextIn: 8 })
    expect(track.at(20)).toMatchObject({ section: 'drop', nextSection: null, nextIn: null })
  })
})

describe('AUTO-VJ with few looks of a kind', () => {
  it('still changes a layer, never straight back to the look it just had', () => {
    let scene: Scene = { base: { kind: 'core' }, paletteId: 'transmission',
      effects: [{ id: 'm', styleId: 'milk.a', opacity: 1, blend: 'screen', reactTo: 'mix', enabled: true }] }
    const looks: string[] = ['milk.a']
    const d = new AutoDirector({ reduced: () => false, catalog: () => ({ gen: [], fil: [], milk: ['milk.a', 'milk.b', 'milk.c'] }), random: () => 0,
      applySwaps: (s) => {
        looks.push(s.m!)
        scene = { ...scene, effects: [{ ...scene.effects[0]!, styleId: s.m! }] }
      } })
    d.setEnabled(true)
    ;['verse', 'build', 'drop', 'breakdown', 'build', 'drop', 'build'].forEach((section, t) => d.frame(frame(t, { section: section as never }), scene))
    expect(looks.length).toBe(7) // a new look every boundary
    for (let i = 1; i < looks.length; i++) {
      expect(looks[i]).not.toBe(looks[i - 1])
      if (i >= 2) expect(looks[i]).not.toBe(looks[i - 2]) // nor straight back
    }
  })
})
