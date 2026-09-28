/**
 * The shared WebGL look for the FOXBOX styles: a three.js renderer on the stage's canvas and one post chain on top
 * of every scene: bloom (lifted by the sound), film grain and a vignette. Styles build their scene and camera, then
 * call `post.render(dt, level)` each frame.
 */
import { BlendFunction, BloomEffect, EffectComposer, EffectPass, NoiseEffect, RenderPass, VignetteEffect } from 'postprocessing'
import { HalfFloatType, type Camera, type Scene, SRGBColorSpace, WebGLRenderer } from 'three'
import type { StyleOptions } from './registry'

export function makeRenderer(canvas: HTMLCanvasElement, opts: StyleOptions): WebGLRenderer {
  const r = new WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: 'high-performance',
    // Clips and the output window read the canvas back (drawImage / a video track).
    preserveDrawingBuffer: opts.output !== 'stage',
  })
  r.outputColorSpace = SRGBColorSpace
  // Black: under the composer a coloured clear is colour-converted twice (a grey haze); styles paint their own ground.
  r.setClearColor(0x000000, 1)
  r.setPixelRatio(1) // the stage sizes the backing store itself (CSS px × dpr)
  return r
}

export interface Post {
  composer: EffectComposer
  bloom: BloomEffect
  /** Draws the scene with the chain. `level` 0–1 lifts the bloom with the sound (calmer under reduced motion). */
  render(dt: number, level?: number): void
  setSize(width: number, height: number): void
  dispose(): void
}

export function makePost(renderer: WebGLRenderer, scene: Scene, camera: Camera, opts: StyleOptions, look: { bloom?: number; grain?: number; vignette?: number } = {}): Post {
  const composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType })
  composer.addPass(new RenderPass(scene, camera))
  const base = look.bloom ?? 1.1
  const bloom = new BloomEffect({ intensity: base, luminanceThreshold: 0.18, luminanceSmoothing: 0.35, mipmapBlur: true, radius: 0.72 })
  const grain = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: true })
  grain.blendMode.opacity.value = look.grain ?? 0.22
  const vignette = new VignetteEffect({ offset: 0.32, darkness: look.vignette ?? 0.62 })
  composer.addPass(new EffectPass(camera, bloom, grain, vignette))
  const k = opts.reduced ? 0.35 : 1
  return {
    composer,
    bloom,
    render(dt, level = 0) {
      bloom.intensity = base * (1 + Math.min(1.5, level * 2.2 * k))
      composer.render(dt / 1000)
    },
    setSize(width, height) {
      renderer.setSize(width, height, false)
      composer.setSize(width, height, false)
    },
    dispose() {
      composer.dispose()
    },
  }
}
