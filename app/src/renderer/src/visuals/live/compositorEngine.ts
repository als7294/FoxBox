/**
 * The compositor (1.4): draws a Scene onto one 2D canvas, one frame at a time. The base renders into its own canvas
 * and goes down first; then, bottom to top, each enabled effect: a 'filter' style is handed the composite so far as
 * `input` and replaces it at its opacity, a 'generator' draws its own picture and is blended on with its blend mode.
 * Every layer gets the frame for the stem it follows (frameFor). Synchronous per frame, so the live stage, the output
 * window and the offline clip renderer (S1) all drive it the same way: setScene, resize, then frame(a, dt).
 */
import { BLEND_OP, frameFor, type BaseFactory, type BaseInstance, type EffectLayer, type Scene } from './compositor'
import { paletteById } from './palettes'
import { findStyle, type AudioFrame, type StyleInstance } from './registry'

let baseFactory: BaseFactory | null = null

/** The base renderers (visuals/live/bases), registered at app start; until then the base is the palette ground. */
export function setBaseFactory(f: BaseFactory): void {
  baseFactory = f
}

interface Layer {
  key: string
  canvas: HTMLCanvasElement
  inst: StyleInstance | null
  kind: 'generator' | 'filter'
  gone: boolean
}

const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Frees a WebGL context now rather than when the canvas is collected (Chromium caps live contexts at ~16). */
function loseContext(c: HTMLCanvasElement): void {
  for (const type of ['webgl2', 'webgl'] as const) {
    const gl = c.getContext(type, {
      failIfMajorPerformanceCaveat: false,
    }) as WebGLRenderingContext | null
    if (gl) {
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      return
    }
  }
}

export class Compositor {
  private readonly ctx: CanvasRenderingContext2D
  private scene: Scene | null = null
  private base: {
    key: string
    inst: BaseInstance | null
    gone: boolean
  } | null = null
  private readonly layers = new Map<string, Layer>()
  private w = 2
  private h = 2
  /** Base and layer creations still running (ready() waits on them). */
  private readonly starting = new Set<Promise<unknown>>()

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly opts: { output: 'stage' | 'window' | 'clip' },
  ) {
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('no 2d context for the compositor')
    this.ctx = ctx
  }

  /** Applies a scene: only what changed is rebuilt (a base or a layer whose style or palette changed). */
  setScene(scene: Scene): void {
    this.scene = scene
    const reduced = reducedMotion()
    const b = scene.base
    const baseKey = `${b.kind}|${b.src ?? ''}|${b.fit ?? ''}|${scene.paletteId}`
    if (this.base?.key !== baseKey) {
      if (this.base) this.disposeBase(this.base)
      const slot: { key: string; inst: BaseInstance | null; gone: boolean } = {
        key: baseKey,
        inst: null,
        gone: false,
      }
      this.base = slot
      if (baseFactory && b.kind !== 'none') {
        this.track(
          Promise.resolve(
            baseFactory(b, {
              paletteId: scene.paletteId,
              reduced,
              output: this.opts.output,
            }),
          )
            .then((inst) => {
              if (slot.gone) return inst.dispose()
              inst.resize(this.w, this.h)
              slot.inst = inst
            })
            .catch((err: unknown) => console.warn(`visuals: base ${b.kind} failed`, err)),
        )
      }
    }
    const wanted = new Set(scene.effects.map((e) => e.id))
    for (const [id, layer] of this.layers) if (!wanted.has(id)) this.dropLayer(id, layer)
    for (const e of scene.effects) {
      const key = `${e.styleId}|${scene.paletteId}`
      const have = this.layers.get(e.id)
      if (have?.key === key) continue
      if (have) this.dropLayer(e.id, have)
      this.addLayer(e, key, scene.paletteId, reduced)
    }
  }

  resize(width: number, height: number): void {
    const w = Math.max(2, Math.round(width))
    const h = Math.max(2, Math.round(height))
    if (w === this.w && h === this.h) return
    this.w = w
    this.h = h
    this.canvas.width = w
    this.canvas.height = h
    this.base?.inst?.resize(w, h)
    for (const l of this.layers.values()) {
      l.canvas.width = w
      l.canvas.height = h
      l.inst?.resize(w, h)
    }
  }

  frame(a: AudioFrame, dt: number): void {
    const { ctx, w, h } = this
    const scene = this.scene
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.fillStyle = paletteById(scene?.paletteId).bg
    ctx.fillRect(0, 0, w, h)
    if (!scene) return
    const base = this.base?.inst
    if (base) {
      try {
        base.frame(a, dt)
        ctx.drawImage(base.canvas, 0, 0, w, h)
      } catch (err) {
        console.warn(`visuals: base ${scene.base.kind} failed a frame`, err)
      }
    }
    for (const e of scene.effects) {
      const layer = this.layers.get(e.id)
      if (!e.enabled || !layer?.inst || e.opacity <= 0) continue
      try {
        layer.inst.frame(frameFor(a, e.reactTo), dt, layer.kind === 'filter' ? this.canvas : null)
      } catch (err) {
        console.warn(`visuals: ${e.styleId} failed a frame`, err)
        continue
      }
      ctx.globalAlpha = Math.min(1, e.opacity)
      ctx.globalCompositeOperation = layer.kind === 'filter' ? 'source-over' : BLEND_OP[e.blend]
      ctx.drawImage(layer.canvas, 0, 0, w, h)
    }
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
  }

  dispose(): void {
    if (this.base) this.disposeBase(this.base)
    this.base = null
    for (const [id, l] of this.layers) this.dropLayer(id, l)
  }

  private addLayer(e: EffectLayer, key: string, paletteId: string, reduced: boolean): void {
    // A canvas keeps its first context type: every style gets a fresh one.
    const canvas = document.createElement('canvas')
    canvas.width = this.w
    canvas.height = this.h
    const layer: Layer = {
      key,
      canvas,
      inst: null,
      kind: 'generator',
      gone: false,
    }
    this.layers.set(e.id, layer)
    this.track(
      findStyle(e.styleId)
        .then(async (style) => {
          if (!style || layer.gone) return
          layer.kind = style.kind ?? 'generator'
          const inst = await style.create(canvas, {
            palette: paletteById(paletteId),
            reduced,
            output: this.opts.output,
          })
          if (layer.gone) return inst.dispose()
          inst.resize(canvas.width, canvas.height)
          layer.inst = inst
        })
        .catch((err: unknown) => console.warn(`visuals: ${e.styleId} failed to start`, err)),
    )
  }

  private track(p: Promise<unknown>): void {
    this.starting.add(p)
    void p.finally(() => this.starting.delete(p))
  }

  /**
   * Resolves once the current scene's base and every layer has an instance or has failed (S1's offline renderer
   * waits on it before frame 0; live drawing just starts and the layers appear as they're ready).
   */
  async ready(): Promise<void> {
    while (this.starting.size) await Promise.allSettled([...this.starting])
  }

  /** Offline renders: brings the base to frame `a` (a video seeks) before frame(a) draws it. */
  async prepare(a: AudioFrame): Promise<void> {
    await this.base?.inst?.prepare?.(a)
  }

  private dropLayer(id: string, l: Layer): void {
    l.gone = true
    l.inst?.dispose()
    l.inst = null
    loseContext(l.canvas)
    this.layers.delete(id)
  }

  private disposeBase(b: { inst: BaseInstance | null; gone: boolean }): void {
    b.gone = true
    b.inst?.dispose()
    b.inst = null
  }
}
