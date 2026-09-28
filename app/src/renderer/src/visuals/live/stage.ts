/**
 * StyleStage: the one driver for a style on a canvas (the LIVE page, the output window, a clip). It creates the
 * style's instance, feeds it an AudioFrame every animation frame, keeps the backing store at the canvas's CSS size ×
 * the pixel ratio (at most 2, and at most 3840 px wide) and pauses while the page is hidden.
 *
 * A canvas keeps the first kind of context it hands out ('webgl2' or '2d'), so every new instance (a new style, a
 * new palette) gets a fresh canvas that takes the old one's place in the DOM: `onCanvas` hears about each one, and
 * whoever holds the canvas (a clip's recorder, the React wrapper) follows it. The old canvas's WebGL context is
 * released, so switching styles never runs into the browser's context limit.
 */
import { PALETTES } from './palettes'
import { silentFrame, type AudioFrame, type Palette, type StyleInstance, type StyleOptions, type VisualStyle } from './registry'

export interface StageOptions {
  output: StyleOptions['output']
  /** The canvas the stage now draws on (a fresh one per instance), or null once disposed. */
  onCanvas?(canvas: HTMLCanvasElement | null): void
}

/** The widest backing store the stage allocates (4K UHD); taller or wider canvases scale down to it. */
export const MAX_BACKING_WIDTH = 3840
/** The largest pixel ratio the stage renders at. */
export const MAX_DPR = 2

/** A canvas's backing size for a CSS size and pixel ratio, capped as above (at least 1 × 1). */
export function backingSize(cssW: number, cssH: number, dpr: number): { width: number; height: number } {
  const k = Math.min(dpr || 1, MAX_DPR)
  let width = Math.max(1, Math.round(cssW * k))
  let height = Math.max(1, Math.round(cssH * k))
  if (width > MAX_BACKING_WIDTH) {
    height = Math.max(1, Math.round((height * MAX_BACKING_WIDTH) / width))
    width = MAX_BACKING_WIDTH
  }
  return { width, height }
}

const reducedQuery = (): MediaQueryList | null =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null

export class StyleStage {
  private cv: HTMLCanvasElement
  private readonly output: StyleOptions['output']
  private readonly onCanvas?: (canvas: HTMLCanvasElement | null) => void
  private style: VisualStyle | null = null
  private palette: Palette = PALETTES[0]!
  private instance: StyleInstance | null = null
  /** Bumped on every (re)creation, so a slow async `create` that lost the race is disposed, not shown. */
  private generation = 0
  /** Whether something has taken a context on the current canvas (it then can't host another kind). */
  private used = false
  private source: (() => AudioFrame) | null = null
  private raf = 0
  private last = 0
  private smoothedFps = 0
  private size = { width: 1, height: 1 }
  private readonly resizeObserver: ResizeObserver | null
  private readonly reduced = reducedQuery()
  private disposed = false

  constructor(canvas: HTMLCanvasElement, opts: StageOptions) {
    this.cv = canvas
    this.output = opts.output
    this.onCanvas = opts.onCanvas
    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.measure()) : null
    this.resizeObserver?.observe(canvas)
    this.reduced?.addEventListener('change', this.onReducedChange)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.measure()
  }

  /** The canvas currently drawn on. */
  get canvas(): HTMLCanvasElement {
    return this.cv
  }

  /** Frames per second, smoothed over about half a second (0 until the loop has run). */
  get fps(): number {
    return this.smoothedFps
  }

  /** Swaps the style: the old instance is disposed first. A style that fails to create leaves a black frame. */
  async setStyle(style: VisualStyle | null): Promise<void> {
    this.style = style
    await this.recreate()
  }

  /** A new palette means a new instance (styles bake their colours at create). */
  async setPalette(p: Palette): Promise<void> {
    if (p === this.palette) return
    this.palette = p
    if (this.style) await this.recreate()
  }

  /** Starts (or re-points) the frame loop at `source`. */
  start(source: () => AudioFrame): void {
    this.source = source
    if (!this.raf && !this.disposed && !document.hidden) {
      this.last = 0
      this.raf = requestAnimationFrame(this.tick)
    }
  }

  stop(): void {
    this.source = null
    this.halt()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.halt()
    this.generation++
    this.dropInstance()
    this.resizeObserver?.disconnect()
    this.reduced?.removeEventListener('change', this.onReducedChange)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.onCanvas?.(null)
  }

  private halt(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private readonly tick = (now: number): void => {
    this.raf = 0
    if (this.disposed || !this.source || document.hidden) return
    const dt = this.last ? Math.min(250, Math.max(0, now - this.last)) : 1000 / 60
    this.last = now
    if (dt > 0) {
      const f = 1000 / dt
      this.smoothedFps = this.smoothedFps ? this.smoothedFps + (f - this.smoothedFps) * Math.min(1, dt / 500) : f
    }
    const inst = this.instance
    if (inst) {
      try {
        inst.frame(this.source(), dt)
      } catch (e) {
        console.warn(`[visuals] ${this.style?.id ?? 'style'} failed to draw; showing black`, e)
        this.dropInstance()
        this.black()
      }
    }
    this.raf = requestAnimationFrame(this.tick)
  }

  private readonly onVisibility = (): void => {
    if (document.hidden) this.halt()
    else if (this.source) this.start(this.source)
  }

  private readonly onReducedChange = (): void => {
    if (this.style) void this.recreate()
  }

  /** Reads the canvas's CSS size and passes a changed backing size on. */
  private measure(): void {
    const w = this.cv.clientWidth || this.cv.width
    const h = this.cv.clientHeight || this.cv.height
    const next = backingSize(w, h, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)
    if (next.width === this.size.width && next.height === this.size.height && this.cv.width === next.width) return
    this.size = next
    this.cv.width = next.width
    this.cv.height = next.height
    try {
      this.instance?.resize(next.width, next.height)
    } catch (e) {
      console.warn('[visuals] resize failed', e)
    }
  }

  private async recreate(): Promise<void> {
    if (this.disposed) return
    const gen = ++this.generation
    this.dropInstance()
    const style = this.style
    if (!style) {
      this.black()
      return
    }
    const canvas = this.freshCanvas()
    const opts: StyleOptions = { palette: this.palette, reduced: Boolean(this.reduced?.matches), output: this.output }
    let inst: StyleInstance | null = null
    try {
      inst = await style.create(canvas, opts)
    } catch (e) {
      console.warn(`[visuals] ${style.id} failed to start; showing black`, e)
    }
    if (gen !== this.generation || this.disposed) {
      inst?.dispose()
      return
    }
    if (!inst) {
      this.black()
      return
    }
    this.instance = inst
    try {
      inst.resize(this.size.width, this.size.height)
      // One frame straight away, so a paused stage (hidden page, no source yet) isn't left blank.
      inst.frame(this.source?.() ?? silentFrame(performance.now() / 1000), 1000 / 60)
    } catch (e) {
      console.warn(`[visuals] ${style.id} failed to draw; showing black`, e)
      this.dropInstance()
      this.black()
    }
  }

  private dropInstance(): void {
    const inst = this.instance
    this.instance = null
    if (!inst) return
    try {
      inst.dispose()
    } catch (e) {
      console.warn('[visuals] dispose failed', e)
    }
  }

  /** The canvas for the next instance: the current one if nothing has drawn on it yet, else a clone in its place. */
  private freshCanvas(): HTMLCanvasElement {
    if (!this.used) {
      this.used = true
      return this.cv
    }
    const old = this.cv
    const next = old.cloneNode(false) as HTMLCanvasElement
    next.width = this.size.width
    next.height = this.size.height
    old.replaceWith(next)
    this.resizeObserver?.unobserve(old)
    this.resizeObserver?.observe(next)
    releaseContext(old)
    this.cv = next
    this.onCanvas?.(next)
    return next
  }

  /** A black frame (no style, or one that failed), on a canvas of its own; the next create replaces it. */
  private black(): void {
    const c = this.freshCanvas()
    const g = c.getContext('2d')
    if (g) {
      g.fillStyle = '#000'
      g.fillRect(0, 0, c.width, c.height)
    }
  }
}

/** Frees a replaced canvas's WebGL context now rather than whenever it's collected. */
function releaseContext(c: HTMLCanvasElement): void {
  try {
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null
    if (gl && !gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    // a 2d canvas, or already gone
  }
  c.width = 1
  c.height = 1
}
