// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { Compositor, setDirector } from '@/visuals/live/compositorEngine'
import type { Scene } from '@/visuals/live/compositor'
import { AutoDirector } from '@/visuals/live/director'
import { registerFamily, type AudioFrame, type StyleInstance } from '@/visuals/live/registry'

/** A 2D context that records what's drawn, and the filter it was drawn with. */
function stubCanvas() {
  const draws: { src: unknown; filter: string; args: number[] }[] = []
  const ctx = {
    filter: 'none',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000',
    fillRect() {},
    drawImage(src: unknown, ...args: number[]) {
      draws.push({ src, filter: ctx.filter, args })
    },
  }
  const canvas = { width: 64, height: 36, getContext: () => ctx } as unknown as HTMLCanvasElement
  return { canvas, draws }
}

const seen = new Map<HTMLCanvasElement, { params: Record<string, number>[]; dts: number[] }>()
registerFamily({
  id: 'lock-test',
  label: 'lock test',
  styles: () => [
    {
      id: 'lock-test.gen',
      label: 'gen',
      create(canvas): StyleInstance {
        const log = { params: [] as Record<string, number>[], dts: [] as number[] }
        seen.set(canvas, log)
        return {
          frame: (_a: AudioFrame, dt: number) => void log.dts.push(dt),
          setParams: (p: Record<string, number>) => void log.params.push({ ...p }),
          resize() {},
          dispose() {},
        } as unknown as StyleInstance
      },
    },
  ],
})

const frame = (t: number, extra: Partial<AudioFrame>): AudioFrame => ({
  time: t, rms: 0.5, bands: { low: 0.5, mid: 0.5, high: 0.5 }, onset: 0, fft: null, waveL: null, waveR: null,
  sampleRate: 48000, bpm: 120, beatPhase: (t * 2) % 1, active: true, bar: Math.floor(t / 2) + 1, barPhase: (t / 2) % 1,
  ...extra,
})

describe('LOCK shields a layer from AUTO-VJ', () => {
  it('keeps a locked layer as set through a build and a drop: no params, its own speed, no look', async () => {
    const d = new AutoDirector({ reduced: () => false })
    d.setEnabled(true)
    setDirector(d)
    const { canvas, draws } = stubCanvas()
    const c = new Compositor(canvas, { output: 'clip' })
    const scene: Scene = {
      base: { kind: 'none' },
      paletteId: 'transmission',
      flashLimit: false,
      effects: [
        { id: 'free', styleId: 'lock-test.gen', opacity: 0.8, blend: 'add', reactTo: 'mix', enabled: true },
        { id: 'kept', styleId: 'lock-test.gen', opacity: 0.6, blend: 'screen', reactTo: 'mix', enabled: true, locked: true },
      ],
    }
    c.resize(64, 36)
    c.setScene(scene)
    await c.ready()
    const [free, kept] = [...seen.values()].slice(-2)
    const keptCanvas = [...seen.keys()].slice(-1)[0]
    // a build ramping to the drop, the held breath, the drop hit, the groove
    for (let t = 8; t < 16; t += 1 / 30) {
      const p = (t - 8) / 8
      c.frame(frame(t, { section: 'build', buildProgress: p, preDrop: t > 15.5, dropIn: (16 - t) * 2 }), 1000 / 30)
    }
    c.frame(frame(16, { section: 'drop', dropHit: true, dropEnergy: 1, dropIndex: 1, drop: true }), 1000 / 30)
    for (let t = 16 + 1 / 30; t < 20; t += 1 / 30) c.frame(frame(t, { section: 'drop', dropEnergy: 0.5, dropIndex: 1 }), 1000 / 30)
    setDirector(null)

    expect(kept!.params).toEqual([]) // no director params, ever
    expect(new Set(kept!.dts)).toEqual(new Set([1000 / 30])) // its own clock, never sped up or held
    const keptDraws = draws.filter((x) => x.src === keptCanvas)
    expect(keptDraws.length).toBeGreaterThan(200)
    expect(keptDraws.every((x) => x.filter === 'none' && x.args.join() === '0,0,64,36')).toBe(true) // no hue, no punch
    // the free layer did get the show (so the test would catch a director that went quiet)
    expect(free!.params.length).toBeGreaterThan(200)
    expect(new Set(free!.dts).size).toBeGreaterThan(1)
    expect(draws.some((x) => x.src !== keptCanvas && x.filter !== 'none')).toBe(true)
  })
})
