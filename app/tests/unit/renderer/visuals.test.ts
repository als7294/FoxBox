import { describe, expect, it } from 'vitest'
import { createStageVisual, feedVisual, setVisual, setVisualStage, visualHidesCamera, VISUALS } from '@/components/strings/visuals'
import { silentFrame } from '@/visuals/live/registry'

describe('VISUALS', () => {
  it('a visual hides the camera in REMIX only; every one draws in both modes', () => {
    const calls: string[] = []
    const ctx = new Proxy({}, {
      get: (_t, k) =>
        k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} })
        : typeof k === 'string' && /^(fill|stroke|fillRect|arc|lineTo|roundRect)$/.test(k) ? () => calls.push(k)
        : () => {},
      set: () => true,
    }) as unknown as CanvasRenderingContext2D
    feedVisual({ ...silentFrame(1), fft: new Uint8Array(512).fill(200), waveL: new Uint8Array(1024).fill(160), sampleRate: 48000 }, 0)
    setVisual('off')
    setVisualStage('remix')
    expect(visualHidesCamera()).toBe(false)
    for (const mode of ['remix', 'play'] as const) {
      setVisualStage(mode)
      for (const k of VISUALS.slice(1)) {
        setVisual(k)
        expect(visualHidesCamera()).toBe(mode === 'remix')
        calls.length = 0
        const v = createStageVisual()
        for (let i = 0; i < 10; i++) v.draw(ctx, 1280, 720, 100, i / 10)
        expect(calls.length, `${mode} ${k}`).toBeGreaterThan(0)
      }
    }
    setVisual('off')
    setVisualStage(null)
  })
})
