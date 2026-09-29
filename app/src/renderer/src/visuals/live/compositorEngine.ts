/**
 * The compositor (1.4): draws a Scene onto one 2D canvas, one frame at a time. The base renders into its own canvas
 * and goes down first; then, bottom to top, each enabled effect: a 'filter' style is handed the composite so far as
 * `input` and replaces it at its opacity, a 'generator' draws its own picture and is blended on with its blend mode.
 * Every layer gets the frame for the stem it follows (frameFor). Synchronous per frame, so the live stage, the output
 * window and the offline clip renderer (S1) all drive it the same way: setScene, resize, then frame(a, dt).
 *
 * 1.5: the AUTO-VJ director (setDirector) patches each frame (layer opacity and params, speed, a punch-in, a hue
 * flip); S1's camera mask lets the base come through the layers (FrameExtras.passThrough); TEXT layers get the scene's
 * words (setText); and a WCAG 2.3.1 flash guard holds the picture to at most 3 flashes a second (Scene.flashLimit, on).
 */
import {
  BLEND_OP,
  frameFor,
  type BaseFactory,
  type BaseInstance,
  type Director,
  type EffectLayer,
  type FrameExtras,
  type Scene,
  type ScenePatch,
} from './compositor'
import { cellsFromRgba, FlashGuard, NO_HOLD } from './flashGuard'
import { paletteById } from './palettes'
import { findStyle, type AudioFrame, type StyleInstance } from './registry'

let baseFactory: BaseFactory | null = null
let director: Director | null = null

/** The AUTO-VJ director (S2), or null for none. Every compositor asks it once per frame. */
export function setDirector(d: Director | null): void {
  director = d
}

/** The flash guard's grid (cells per side). */
const PROBE = 16

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
  /** Scratch for the mask pass and the punch / hue pass; the last frame shown, and a tiny probe, for the limiter. */
  private scratch: HTMLCanvasElement | null = null
  private probe: CanvasRenderingContext2D | null = null
  private readonly guard = new FlashGuard()
  private lastT = -Infinity

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
    const textChanged = scene.text !== this.scene?.text
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
    if (textChanged) for (const l of this.layers.values()) l.inst?.setText?.(scene.text ?? null)
  }

  resize(width: number, height: number): void {
    const w = Math.max(2, Math.round(width))
    const h = Math.max(2, Math.round(height))
    if (w === this.w && h === this.h) return
    this.w = w
    this.h = h
    this.canvas.width = w
    this.canvas.height = h
    if (this.scratch) ((this.scratch.width = w), (this.scratch.height = h))
    this.guard.reset()
    this.base?.inst?.resize(w, h)
    for (const l of this.layers.values()) {
      l.canvas.width = w
      l.canvas.height = h
      l.inst?.resize(w, h)
    }
  }

  frame(a: AudioFrame, dt: number, extras?: FrameExtras): void {
    const { ctx, w, h } = this
    const scene = this.scene
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.filter = 'none'
    ctx.fillStyle = paletteById(scene?.paletteId).bg
    ctx.fillRect(0, 0, w, h)
    if (!scene) return
    let patch: ScenePatch | null = null
    try {
      patch = director?.frame(a, scene) ?? null
    } catch (err) {
      console.warn('visuals: the director failed a frame', err)
    }
    const step = dt * Math.max(0, patch?.speed ?? 1)
    // The director's look: a hue flip, saturation and a punch-in (a quick zoom, brightened), drawn into the base and
    // each generator layer as it goes down, not onto the finished picture, so a locked layer (EffectLayer.locked) is
    // shielded from all of the patch: no look, its own opacity and params, its own speed. A filter layer's input
    // already carries the look, so its output is drawn as it is.
    const punch = Math.min(1, Math.max(0, patch?.punch ?? 0))
    const hue = patch?.hueShift ?? 0
    const sat = Math.min(2, Math.max(0, patch?.saturation ?? 1))
    const look = [
      hue ? `hue-rotate(${hue}deg)` : '',
      sat !== 1 ? `saturate(${sat})` : '',
      punch > 0 ? `brightness(${1 + 0.4 * punch})` : '',
    ]
      .filter(Boolean)
      .join(' ')
    const z = 1 + 0.08 * punch
    const put = (src: CanvasImageSource, plain: boolean): void => {
      if (plain || (!look && punch === 0)) {
        ctx.drawImage(src, 0, 0, w, h)
        return
      }
      ctx.filter = look || 'none'
      ctx.drawImage(src, (w - w * z) / 2, (h - h * z) / 2, w * z, h * z)
      ctx.filter = 'none'
    }
    const base = this.base?.inst
    if (base) {
      try {
        base.frame(a, step)
        put(base.canvas, false)
      } catch (err) {
        console.warn(`visuals: base ${scene.base.kind} failed a frame`, err)
      }
    }
    for (const e of scene.effects) {
      const layer = this.layers.get(e.id)
      const locked = Boolean(e.locked)
      const over = locked ? undefined : patch?.layers?.[e.id]
      const opacity = over?.opacity ?? e.opacity
      if (!(over?.enabled ?? e.enabled) || !layer?.inst || opacity <= 0) continue
      try {
        if (over?.params) layer.inst.setParams?.(over.params)
        // `false`: the layer drew nothing this frame (TEXT between drops), so there's nothing to composite.
        if (layer.inst.frame(frameFor(a, e.reactTo), locked ? dt : step, layer.kind === 'filter' ? this.canvas : null, extras) === false)
          continue
      } catch (err) {
        console.warn(`visuals: ${e.styleId} failed a frame`, err)
        continue
      }
      ctx.globalAlpha = Math.min(1, opacity)
      ctx.globalCompositeOperation = layer.kind === 'filter' ? 'source-over' : BLEND_OP[e.blend]
      put(layer.canvas, locked || layer.kind === 'filter')
    }
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    // S1's near mask: the base (the camera, faces still hidden) through every layer where the mask is set.
    const pass = extras?.passThrough
    if (pass && base && pass.level > 0) {
      const sc = this.scratchCtx()
      sc.globalCompositeOperation = 'copy'
      sc.drawImage(base.canvas, 0, 0, w, h)
      sc.globalCompositeOperation = 'destination-in'
      sc.drawImage(pass.mask, 0, 0, w, h)
      sc.globalCompositeOperation = 'source-over'
      // The mask's alpha already is each region's nearness: drawn at full opacity (level only gates it).
      put(sc.canvas, false)
    }
    if (scene.flashLimit !== false) this.limitFlashes(a.time)
  }

  /**
   * Photosensitivity (WCAG 2.3.1, flashGuard.ts): the composite, downsampled on the GPU to 16×16, is checked for
   * flashes; past 3 a second this frame's brightness is held back (a gain, a lift, less red), just enough to stay under
   * the threshold. Never a mix with an earlier frame: that double-exposed a moving camera.
   */
  private limitFlashes(t: number): void {
    const { ctx, w, h } = this
    const probe = (this.probe ??= makeCtx(PROBE, PROBE, false))
    if (!probe) return
    if (t < this.lastT) this.guard.reset()
    this.lastT = t
    probe.drawImage(this.canvas, 0, 0, PROBE, PROBE)
    const hold = this.guard.observe(t, cellsFromRgba(probe.getImageData(0, 0, PROBE, PROBE).data))
    if (hold === NO_HOLD) return
    // CSS brightness() scales sRGB values; the guard's gain is in linear light.
    const filters = [
      hold.gain !== 1 ? `brightness(${hold.gain ** (1 / 2.2)})` : '',
      hold.saturate !== 1 ? `saturate(${hold.saturate})` : '',
    ]
    const filter = filters.filter(Boolean).join(' ')
    if (filter) {
      const sc = this.scratchCtx()
      sc.globalCompositeOperation = 'copy'
      sc.drawImage(this.canvas, 0, 0)
      sc.globalCompositeOperation = 'source-over'
      ctx.globalCompositeOperation = 'copy'
      ctx.filter = filter
      ctx.drawImage(sc.canvas, 0, 0, w, h)
      ctx.filter = 'none'
      ctx.globalCompositeOperation = 'source-over'
    }
    if (hold.lift > 0) {
      // A uniform lift (added light), sized for the darkest pixels: sRGB-encoded.
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = Math.min(1, hold.lift <= 0.0031308 ? 12.92 * hold.lift : 1.055 * hold.lift ** (1 / 2.4) - 0.055)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, h)
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
    }
  }

  private scratchCtx(): CanvasRenderingContext2D {
    const c = (this.scratch ??= makeCanvas(this.w, this.h))
    return c.getContext('2d')!
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
          inst.setText?.(this.scene?.text ?? null)
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

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

function makeCtx(w: number, h: number, read: boolean): CanvasRenderingContext2D | null {
  return makeCanvas(w, h).getContext('2d', { willReadFrequently: read })
}
