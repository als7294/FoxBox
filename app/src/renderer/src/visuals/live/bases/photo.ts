/**
 * PHOTO: a still picture (`spec.src`), filling the frame ('cover') or all of it shown on the palette ground
 * ('contain'). It drifts very slowly (a Ken Burns zoom and pan, still under reduced motion) and brightens a touch on
 * each onset: the picture is drawn a second time, added on top, at the hit's envelope (one extra blit, only while it
 * glows). With nothing moving it isn't redrawn at all. A picture that won't load shows a dim PHOTO UNAVAILABLE.
 *
 * The picture is scaled once per canvas size (an ImageBitmap at its drawn size, high quality) and drawn per frame
 * with plain smoothing: a full-size photo resampled at 'high' every frame made a saved clip ~5× slower.
 */
import type { BaseInstance, BaseSpec } from '../compositor'
import type { AudioFrame, Palette } from '../registry'
import { context2d, drift, fitRect, ground, hitEnvelope, kenBurns, makeCanvas, quietCard, setSize } from './kit'

/** How much an onset brightens the picture (the added copy's alpha at a full hit). */
const PULSE = 0.16
/** The glow's decay after a hit (ms). */
const PULSE_TAU_MS = 260
/** 'contain' under the drift: the picture fits a frame this much smaller, so the zoom and pan never cut it. */
const CONTAIN_ROOM = 1.12
/** The Ken Burns zoom's top (kit.kenBurns): the pre-scaled picture is this much larger than its fitted size. */
const KB_MAX = 1.09

export function photoBase(spec: BaseSpec, palette: Palette, reduced: boolean): BaseInstance {
  const canvas = makeCanvas()
  const ctx = context2d(canvas)
  const fit = spec.fit ?? 'cover'
  let state: 'loading' | 'ready' | 'failed' = spec.src ? 'loading' : 'failed'
  let img: HTMLImageElement | null = null
  let alive = true
  let dirty = true
  let clock = 0
  let glow = 0
  // The pre-scaled picture for the current canvas size (`scaledFor`), and the scaling in flight.
  let scaled: ImageBitmap | null = null
  let scaledFor = ''
  let scaling: Promise<void> | null = null

  const room = () => (fit === 'contain' && !reduced ? CONTAIN_ROOM : 1)
  const rescale = (): Promise<void> | null => {
    if (!img || state !== 'ready' || typeof createImageBitmap !== 'function') return null
    const key = `${canvas.width}x${canvas.height}`
    if (key === scaledFor) return scaling
    scaledFor = key
    const base = fitRect(img.naturalWidth, img.naturalHeight, canvas.width / room(), canvas.height / room(), fit)
    const k = reduced ? 1 : KB_MAX
    const rw = Math.max(1, Math.min(img.naturalWidth, Math.round(base.w * k)))
    const rh = Math.max(1, Math.min(img.naturalHeight, Math.round(base.h * k)))
    const from = img
    scaling = createImageBitmap(from, { resizeWidth: rw, resizeHeight: rh, resizeQuality: 'high' }).then(
      (bmp) => {
        if (!alive || scaledFor !== key) return bmp.close()
        scaled?.close()
        scaled = bmp
        dirty = true
      },
      () => undefined, // keep drawing the full-size picture
    )
    return scaling
  }

  if (spec.src) {
    const el = new Image()
    el.decoding = 'async'
    el.src = spec.src
    el.decode().then(
      () => {
        if (!alive) return
        img = el
        state = el.naturalWidth > 0 ? 'ready' : 'failed'
        dirty = true
        void rescale()
      },
      () => {
        if (!alive) return
        state = 'failed'
        dirty = true
      },
    )
  }

  return {
    canvas,
    resize(width, height) {
      if (setSize(canvas, width, height)) {
        dirty = true
        void rescale()
      }
    },
    // Offline renders wait for the pre-scaled picture, so no saved frame falls back to the slow full-size draw.
    async prepare() {
      await rescale()
    },
    frame(a: AudioFrame, dt: number) {
      if (!ctx) return
      const step = Math.min(100, Math.max(0, dt))
      clock += step / 1000
      if (state === 'failed') {
        if (dirty) quietCard(ctx, palette, spec.src ? 'PHOTO UNAVAILABLE' : 'NO PHOTO')
        dirty = false
        return
      }
      glow = hitEnvelope(glow, a.onset, a.active, step, PULSE_TAU_MS)
      if (glow < 0.01) glow = 0
      const moving = !reduced || glow > 0
      if (!dirty && !moving) return
      dirty = glow > 0 // one more frame after the glow fades, to clear it
      ground(ctx, palette)
      if (state !== 'ready' || !img) return
      const { width: w, height: h } = canvas
      // 'contain' keeps all of the picture in view: it drifts inside a slightly smaller frame (room for the zoom and pan).
      const pic = scaled ?? img
      const k = room()
      const r = drift(fitRect(img.naturalWidth, img.naturalHeight, w / k, h / k, fit), kenBurns(clock, reduced), w, h)
      r.x += (w - w / k) / 2
      r.y += (h - h / k) / 2
      ctx.imageSmoothingQuality = scaled ? 'low' : 'medium'
      ctx.drawImage(pic, r.x, r.y, r.w, r.h)
      if (glow > 0) {
        ctx.globalCompositeOperation = 'lighter'
        ctx.globalAlpha = Math.min(1, glow) * PULSE * (reduced ? 0.4 : 1)
        ctx.drawImage(pic, r.x, r.y, r.w, r.h)
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
      }
    },
    dispose() {
      alive = false
      img = null
      scaled?.close()
      scaled = null
      setSize(canvas, 2, 2)
    },
  }
}
