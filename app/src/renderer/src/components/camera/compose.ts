/**
 * The camera clip's frame: the camera on top (faces masked), the clip's sound as a waveform with a playhead underneath
 * (the song, if there is one, with the drop over it), and a small FOXBOX mark. Everything is drawn on one canvas, which is what gets recorded.
 */
import type { Peaks } from '@/api/types'
import { theme } from '@/visuals/theme'
import type { Box } from './faceTrack'

export type ClipFormat = 'vertical' | 'horizontal'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Layout {
  w: number
  h: number
  cam: Rect
  wave: Rect
}

export type MaskStyle = 'mosaic' | 'blur' | 'solid'

/** How faces are hidden. `strength` 1–10: stronger is coarser (fewer mosaic cells, a wider blur). */
export interface FaceMask {
  style: MaskStyle
  strength: number
}

export const DEFAULT_MASK: FaceMask = { style: 'mosaic', strength: 5 }

// Privacy floors: even at strength 1 a face gets at most 16 cells across, or a blur of 6% of its width.
/** Mosaic cells across a face: 16 at strength 1, 11 at 5, 5 at 10. The whole picture gets twice as many. */
export function mosaicBlocks(strength: number, wholeFrame = false): number {
  const s = Math.min(10, Math.max(1, strength))
  return Math.round((16 - ((s - 1) * 11) / 9) * (wholeFrame ? 2 : 1))
}

/** Blur radius for a region `width` px wide: 6% of it at strength 1, 17% at 10 (the whole picture: a third). */
export function blurRadius(strength: number, width: number, wholeFrame = false): number {
  const s = Math.min(10, Math.max(1, strength))
  return width * (0.05 + 0.012 * s) * (wholeFrame ? 0.34 : 1)
}

export function layout(format: ClipFormat): Layout {
  if (format === 'horizontal') return { w: 1920, h: 1080, cam: { x: 0, y: 0, w: 1920, h: 810 }, wave: { x: 0, y: 810, w: 1920, h: 270 } }
  return { w: 1080, h: 1920, cam: { x: 0, y: 0, w: 1080, h: 1440 }, wave: { x: 0, y: 1440, w: 1080, h: 480 } }
}

/** The part of a srcW×srcH frame that fills `dst` ("cover"), and its scale. */
export function coverCrop(srcW: number, srcH: number, dst: Rect): Rect & { scale: number } {
  const scale = Math.max(dst.w / srcW, dst.h / srcH)
  const w = dst.w / scale
  const h = dst.h / scale
  return { x: (srcW - w) / 2, y: (srcH - h) / 2, w, h, scale }
}

/** A box in camera pixels, clipped to what's visible, mapped onto the canvas. Null when it's off screen. */
export function mapBox(box: Box, crop: Rect & { scale: number }, dst: Rect): { src: Rect; dst: Rect } | null {
  const x0 = Math.max(box.x, crop.x)
  const y0 = Math.max(box.y, crop.y)
  const x1 = Math.min(box.x + box.w, crop.x + crop.w)
  const y1 = Math.min(box.y + box.h, crop.y + crop.h)
  if (x1 - x0 < 1 || y1 - y0 < 1) return null
  const src = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  return {
    src,
    dst: { x: dst.x + (x0 - crop.x) * crop.scale, y: dst.y + (y0 - crop.y) * crop.scale, w: src.w * crop.scale, h: src.h * crop.scale },
  }
}

/**
 * The one place a face is masked: a coarse mosaic, `blocks` square cells across. Swap this function for another
 * mask (a blur, a solid box, an offline high-accuracy pass) without touching the rest.
 */
export function pixelate(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  src: Rect,
  dst: Rect,
  blocks: number,
  scratch: HTMLCanvasElement,
): void {
  const cols = Math.max(2, Math.round(blocks))
  const rows = Math.max(2, Math.round(cols * (dst.h / dst.w)))
  scratch.width = cols
  scratch.height = rows
  const tiny = scratch.getContext('2d')
  if (!tiny) return
  tiny.imageSmoothingEnabled = true
  tiny.imageSmoothingQuality = 'high'
  tiny.drawImage(source, src.x, src.y, src.w, src.h, 0, 0, cols, rows)
  ctx.save()
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(scratch, 0, 0, cols, rows, dst.x, dst.y, dst.w, dst.h)
  ctx.restore()
}

/** Hides one region with the chosen mask. The single swap point for another kind of mask. */
export function maskRegion(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  src: Rect,
  dst: Rect,
  mask: FaceMask,
  scratch: HTMLCanvasElement,
  wholeFrame = false,
): void {
  if (mask.style === 'solid') {
    ctx.fillStyle = theme().bg
    ctx.fillRect(dst.x, dst.y, dst.w, dst.h)
    return
  }
  if (mask.style === 'blur') {
    // Blur a larger area than the box and clip to the box, so its edges are as blurred as its middle.
    const r = blurRadius(mask.strength, dst.w, wholeFrame)
    const k = src.w / dst.w
    ctx.save()
    ctx.beginPath()
    ctx.rect(dst.x, dst.y, dst.w, dst.h)
    ctx.clip()
    ctx.filter = `blur(${r.toFixed(1)}px)`
    ctx.drawImage(
      source,
      src.x - 2 * r * k,
      src.y - 2 * r * k,
      src.w + 4 * r * k,
      src.h + 4 * r * k,
      dst.x - 2 * r,
      dst.y - 2 * r,
      dst.w + 4 * r,
      dst.h + 4 * r,
    )
    ctx.restore()
    return
  }
  pixelate(ctx, source, src, dst, mosaicBlocks(mask.strength, wholeFrame), scratch)
}

/** The clip's sound, drawn under the camera. */
export interface Wave {
  /** The song over the whole clip (loudest sample per bucket, 0–1), or null for the drop alone. */
  song: Float32Array | null
  drop: Peaks | null
  /** Where the drop's voice plays, 0–1 through the clip. */
  dropFrom: number
  dropTo: number
  /** How much of the drop that is, 0–1 (the rest is its bar padding). */
  dropShown: number
}

export interface FrameInput {
  video: HTMLVideoElement | null
  /** Face boxes in camera pixels (padding included). */
  faces: readonly Box[]
  /** Hide the whole camera picture: the user's choice, and always while face detection isn't running. */
  wholeFrame: boolean
  mask: FaceMask
  wave: Wave
  /** 0–1 through the clip. */
  progress: number
  label: string
}

/** The loudest value in the part [f0, f1) (fractions) of `values`. */
function loudest(values: ArrayLike<number>, f0: number, f1: number): number {
  const n = values.length
  const a = Math.max(0, Math.floor(f0 * n))
  const b = Math.min(n, Math.max(a + 1, Math.floor(f1 * n)))
  let hi = 0
  for (let k = a; k < b; k++) hi = Math.max(hi, Math.abs(values[k] ?? 0))
  return hi
}

function drawWaveform(ctx: CanvasRenderingContext2D, r: Rect, wave: Wave, progress: number): void {
  const t = theme()
  const padX = Math.round(r.w * 0.06)
  const x0 = r.x + padX
  const w = r.w - 2 * padX
  const mid = r.y + r.h * 0.52
  const amp = r.h * 0.3
  const bars = Math.min(160, Math.max(40, Math.round(w / 9)))
  const barW = Math.max(2, (w / bars) * 0.55)
  const bar = (i: number, level: number) => {
    const h = Math.max(2, Math.min(1, level) * amp)
    ctx.fillRect(x0 + (i + 0.5) * (w / bars) - barW / 2, mid - h, barW, h * 2)
  }
  const span = Math.max(1e-6, wave.dropTo - wave.dropFrom)
  for (let i = 0; i < bars; i++) {
    const f0 = i / bars
    const f1 = (i + 1) / bars
    const played = (i + 0.5) / bars <= progress
    // The song in grey; the drop over it in amber (brighter once played). No song: the drop, grey until played.
    if (wave.song) {
      ctx.fillStyle = played ? 'rgba(233,229,218,0.55)' : 'rgba(233,229,218,0.2)'
      bar(i, loudest(wave.song, f0, f1))
    }
    const c = (f0 + f1) / 2
    if (c < wave.dropFrom || c > wave.dropTo) continue
    let hi = wave.song ? 0 : 0.02
    if (wave.drop?.max.length) {
      const q0 = ((f0 - wave.dropFrom) / span) * wave.dropShown
      const q1 = ((f1 - wave.dropFrom) / span) * wave.dropShown
      hi = Math.max(hi, loudest(wave.drop.max, q0, q1), loudest(wave.drop.min, q0, q1))
    }
    ctx.fillStyle = played || wave.song ? t.amber : 'rgba(233,229,218,0.22)'
    ctx.globalAlpha = wave.song && !played ? 0.5 : 1
    bar(i, hi)
    ctx.globalAlpha = 1
  }
  const px = x0 + Math.min(1, Math.max(0, progress)) * w
  ctx.fillStyle = t.accent
  ctx.fillRect(px - 1.5, mid - amp - 18, 3, amp * 2 + 36)
}

/** One frame of the clip. `scratch` is a small canvas the mosaic reuses. */
export function drawFrame(ctx: CanvasRenderingContext2D, L: Layout, f: FrameInput, scratch: HTMLCanvasElement): void {
  const t = theme()
  ctx.fillStyle = t.bg
  ctx.fillRect(0, 0, L.w, L.h)

  const v = f.video
  if (v && v.readyState >= 2 && v.videoWidth > 0) {
    const crop = coverCrop(v.videoWidth, v.videoHeight, L.cam)
    ctx.drawImage(v, crop.x, crop.y, crop.w, crop.h, L.cam.x, L.cam.y, L.cam.w, L.cam.h)
    if (f.wholeFrame) {
      maskRegion(ctx, v, crop, L.cam, f.mask, scratch, true)
    } else {
      for (const face of f.faces) {
        const m = mapBox(face, crop, L.cam)
        if (m) maskRegion(ctx, v, m.src, m.dst, f.mask, scratch)
      }
    }
  } else {
    ctx.fillStyle = t.dim
    ctx.font = `500 ${Math.round(L.cam.h * 0.03)}px ${t.mono}`
    ctx.textAlign = 'center'
    ctx.fillText('NO CAMERA', L.cam.x + L.cam.w / 2, L.cam.y + L.cam.h / 2)
  }

  // The panel under the camera: the clip's sound, the drop's label and the mark.
  ctx.fillStyle = t.bg
  ctx.fillRect(L.wave.x, L.wave.y, L.wave.w, L.wave.h)
  ctx.fillStyle = 'rgba(233,229,218,0.08)'
  ctx.fillRect(L.wave.x, L.wave.y, L.wave.w, 2)
  drawWaveform(ctx, L.wave, f.wave, f.progress)
  const unit = Math.round(Math.min(L.w, L.h) * 0.022)
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  ctx.fillStyle = t.dim
  ctx.font = `500 ${unit}px ${t.mono}`
  ctx.fillText(f.label, L.wave.x + Math.round(L.wave.w * 0.06), L.wave.y + unit * 2.2)
  ctx.textAlign = 'right'
  ctx.fillStyle = 'rgba(233,229,218,0.6)'
  ctx.font = `${t.displayWeight} ${Math.round(unit * 1.6)}px ${t.display}`
  ctx.fillText('FOXBOX', L.wave.x + L.wave.w - Math.round(L.wave.w * 0.04), L.wave.y + L.wave.h - unit * 1.2)
}
