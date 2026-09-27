/**
 * The camera clip's frame: the camera on top (faces masked), the clip's sound as a waveform with a playhead underneath
 * (the song, if there is one, with the drop over it), and a small FOXBOX mark; optionally the animated fox watermark in
 * the picture's bottom-right and the drop's words as subtitles over the picture. Everything is drawn on one canvas,
 * which is what gets recorded.
 */
import type { Peaks } from '@/api/types'
import { theme } from '@/visuals/theme'
import type { Box } from './faceTrack'
import { subtitleAt, type Subtitle, type SubWord } from './subtitles'

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
  /** The fox watermark (SETTINGS → Camera clips). */
  watermark: boolean
  /** Seconds into the clip (it animates the watermark), or null for the live picture. */
  clock: number | null
  /** The fox card over the picture (before the drop, and after it with MADE WITH FOXBOX), or null. */
  card?: Card | null
  /** The drop's words and the time on its own timeline (s), while a clip or a filmed take plays; null: none shown. */
  subtitles?: { words: readonly SubWord[]; t: number } | null
}

// ------------------------------------------------------------------------------------------ intro / outro

/** After the drop's last word the picture holds this long (the take's last frame, or the live camera paused). */
export const FREEZE_S = 2
export const CARD_FADE_S = 0.35
/** The outro (the fox with MADE WITH FOXBOX) runs at least this long: a clip without a song runs on to fit it. */
export const OUTRO_MIN_S = 3
/** MADE WITH FOXBOX comes in this long after the outro's fox. */
const MADE_WITH_AT_S = 0.6

export interface Card {
  /** Over the picture, 0–1. */
  alpha: number
  /** Seconds since this card started (it animates the fox). */
  t: number
  /** MADE WITH FOXBOX, 0–1 (0 in the intro). */
  madeWith: number
}

/** Where the voice is in a clip, in seconds: from its first word to its last. */
export interface ClipVoice {
  from: number
  end: number
}

/** A clip's full length with the outro: the song's tail, or longer when that's too short for the freeze and outro. */
export const clipLength = (length: number, voiceEnd: number): number => Math.max(length, voiceEnd + FREEZE_S + OUTRO_MIN_S)

/** True while the picture should hold still: from the last word until the outro's fox. */
export const frozenAt = (v: ClipVoice, t: number): boolean => t >= v.end && t < v.end + FREEZE_S + CARD_FADE_S

/**
 * The fox card `t` seconds into a clip: over the picture until the first word (fading out as it comes), and again
 * after the last word plus FREEZE_S, with MADE WITH FOXBOX, to the end. Null while the picture shows.
 */
export function clipCard(v: ClipVoice, t: number): Card | null {
  const outro = v.end + FREEZE_S
  if (t >= outro) {
    const s = t - outro
    return { alpha: clamp01(s / CARD_FADE_S), t: s, madeWith: clamp01((s - MADE_WITH_AT_S) / 0.5) }
  }
  if (t < v.from) return { alpha: clamp01((v.from - t) / CARD_FADE_S), t: Math.max(0, t), madeWith: 0 }
  return null
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0))

// ------------------------------------------------------------------------------------------ watermark

/**
 * The easter-egg FoxBox mark (design/brand/foxbox-mark-easter.svg, viewBox 512). From 2 s in, every 7 s, it plays the
 * SVG's glance (eyes left, then right) and right-ear flick (the 60–88 % stretch of the SVG's 17 s cycle, ~4.8 s);
 * in between it's the still mark.
 */
const MARK_CYCLE_S = 17
const MARK_START_S = 2
export const MARK_PERIOD_S = 7
const MARK_FROM = 0.6
const EAR_TIP: [number, number] = [416, 56]
const EAR_INNER: [number, number] = [400, 104]
/** [cycle fraction, eye x offset] */
const EYE_KEYS: [number, number][] = [
  [0.6, 0],
  [0.625, -11],
  [0.68, -11],
  [0.71, 10],
  [0.775, 10],
  [0.805, 0],
]
/** [cycle fraction, ear tip, inner-ear tip] */
const EAR_KEYS: [number, [number, number], [number, number]][] = [
  [0.83, EAR_TIP, EAR_INNER],
  [0.837, [431, 70], [412, 116]],
  [0.847, EAR_TIP, EAR_INNER],
  [0.855, [424, 62], [406, 109]],
  [0.866, EAR_TIP, EAR_INNER],
]

export interface MarkPose {
  eyeX: number
  ear: [number, number]
  inner: [number, number]
}

const easeInOut = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2) // ≈ the SVG's cubic-bezier(.65,0,.35,1)
const easeOut = (x: number) => 1 - (1 - x) ** 2
const lerp = (a: number, b: number, x: number) => a + (b - a) * x

/** The mark `t` seconds into a clip (null: still). */
export function markPose(t: number | null): MarkPose {
  const still: MarkPose = { eyeX: 0, ear: EAR_TIP, inner: EAR_INNER }
  if (t == null || t < MARK_START_S) return still
  const c = MARK_FROM + ((t - MARK_START_S) % MARK_PERIOD_S) / MARK_CYCLE_S
  const pose = { ...still }
  for (let i = 1; i < EYE_KEYS.length; i++) {
    const [c0, v0] = EYE_KEYS[i - 1]!
    const [c1, v1] = EYE_KEYS[i]!
    if (c >= c0 && c < c1) pose.eyeX = lerp(v0, v1, easeInOut((c - c0) / (c1 - c0)))
  }
  for (let i = 1; i < EAR_KEYS.length; i++) {
    const [c0, e0, n0] = EAR_KEYS[i - 1]!
    const [c1, e1, n1] = EAR_KEYS[i]!
    if (c < c0 || c >= c1) continue
    const x = easeOut((c - c0) / (c1 - c0))
    pose.ear = [lerp(e0[0], e1[0], x), lerp(e0[1], e1[1], x)]
    pose.inner = [lerp(n0[0], n1[0], x), lerp(n0[1], n1[1], x)]
  }
  return pose
}

/**
 * The watermark: ~56 px tall on 1080-wide video (scaled with it), 24 px in from the picture's bottom-right corner (so
 * above the waveform strip), ember at 85 % with a soft dark shadow so it reads over bright video. It's cut out on
 * `stamp` (cutting the frame itself would cut the video) and then drawn on.
 */
export function drawWatermark(ctx: CanvasRenderingContext2D, L: Layout, t: number | null, stamp: HTMLCanvasElement): void {
  const k = Math.min(L.w, L.h) / 1080
  const size = paintMark(stamp, 56 * k, markPose(t), Math.ceil(12 * k))
  if (!size) return
  const { w, h, pad } = size
  const margin = 24 * k
  ctx.save()
  ctx.globalAlpha = 0.85
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)'
  ctx.shadowBlur = 10 * k
  ctx.shadowOffsetY = k
  ctx.drawImage(stamp, L.cam.x + L.cam.w - margin - w - pad, L.cam.y + L.cam.h - margin - h - pad)
  ctx.restore()
}

/** Paints the mark `height` px tall (in `pose`, ember) on `stamp` with `pad` px around it, holes cut out. */
function paintMark(stamp: HTMLCanvasElement, height: number, p: MarkPose, pad: number): { w: number; h: number; pad: number } | null {
  const s = height / 414 // the mark spans y 56–470 and x 56–456 of its 512 box
  const w = 400 * s
  const h = 414 * s
  const sw = Math.ceil(w + 2 * pad)
  const sh = Math.ceil(h + 2 * pad)
  if (stamp.width !== sw || stamp.height !== sh) {
    stamp.width = sw
    stamp.height = sh
  }
  const m = stamp.getContext('2d')
  if (!m) return null
  const e = p.eyeX
  m.setTransform(1, 0, 0, 1, 0, 0)
  m.clearRect(0, 0, sw, sh)
  m.setTransform(s, 0, 0, s, pad - 56 * s, pad - 56 * s)
  m.globalCompositeOperation = 'source-over'
  m.fillStyle = theme().accent
  m.fill(new Path2D(`M96 56 L204 172 L308 172 L${p.ear[0]} ${p.ear[1]} L452 296 L256 470 L60 296 Z`))
  m.globalCompositeOperation = 'destination-out'
  m.fill(
    new Path2D(
      `M112 104 L196 190 L130 222 Z M${p.inner[0]} ${p.inner[1]} L316 190 L382 222 Z ` +
        `M${140 + e} 250 L${248 + e} 290 L${226 + e} 330 L${176 + e} 306 Z ` +
        `M${372 + e} 250 L${264 + e} 290 L${286 + e} 330 L${336 + e} 306 Z`,
    ),
  )
  m.lineWidth = 28
  m.lineJoin = 'miter'
  m.strokeStyle = '#000'
  m.stroke(new Path2D('M56 298 L256 410 L456 298'))
  m.globalCompositeOperation = 'source-over'
  return { w, h, pad }
}

/**
 * The fox card over the picture: the easter-egg fox, glancing and flicking its ear on a loop, over a soft ember glow;
 * in the outro MADE WITH FOXBOX under it.
 */
function drawCard(ctx: CanvasRenderingContext2D, L: Layout, card: Card, stamp: HTMLCanvasElement): void {
  const th = theme()
  const r = L.cam
  const unit = Math.min(L.w, L.h) / 1080
  const fox = Math.min(r.w, r.h) * 0.34
  const cx = r.x + r.w / 2
  const cy = r.y + r.h * 0.46 - (card.madeWith ? fox * 0.12 * card.madeWith : 0)
  ctx.save()
  ctx.globalAlpha = card.alpha
  ctx.fillStyle = th.bg
  ctx.fillRect(r.x, r.y, r.w, r.h)
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, fox * 1.4)
  glow.addColorStop(0, 'rgba(255, 75, 43, 0.16)')
  glow.addColorStop(1, 'rgba(255, 75, 43, 0)')
  ctx.fillStyle = glow
  ctx.fillRect(r.x, r.y, r.w, r.h)
  // The fox starts on its glance, so even a short intro shows it move.
  const size = paintMark(stamp, fox, markPose(MARK_START_S + card.t), Math.ceil(4 * unit))
  if (size) ctx.drawImage(stamp, cx - size.w / 2 - size.pad, cy - size.h / 2 - size.pad)
  if (card.madeWith > 0) {
    ctx.globalAlpha = card.alpha * card.madeWith
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    const top = cy + fox / 2 + 64 * unit
    ctx.fillStyle = th.dim
    ctx.font = `500 ${Math.round(32 * unit)}px ${th.mono}`
    ctx.letterSpacing = `${Math.round(10 * unit)}px`
    ctx.fillText('MADE WITH', cx, top)
    ctx.fillStyle = th.ink
    ctx.font = `${th.displayWeight} ${Math.round(96 * unit)}px ${th.display}`
    ctx.letterSpacing = `${Math.round(6 * unit)}px`
    ctx.fillText('FOXBOX', cx, top + 100 * unit)
  }
  ctx.restore()
}

// ------------------------------------------------------------------------------------------ subtitles

/**
 * The subtitle: the phrase (subtitles.ts) centred in the picture's lower middle, bottom clear of the watermark's
 * height so it never meets the fox; uppercase in the display face, the word being said in the accent, the rest in ink,
 * on a soft dark rounded backing. 72 px type on 1080-wide video (scaled with it), smaller when a line would run wider
 * than the picture's safe area.
 */
function drawSubtitle(ctx: CanvasRenderingContext2D, L: Layout, sub: Subtitle): void {
  if (sub.alpha <= 0) return
  const th = theme()
  const k = Math.min(L.w, L.h) / 1080
  const r = L.cam
  const maxW = r.w * 0.84
  const lines = sub.lines.map((l) => l.map((w) => w.toUpperCase()))
  const fontAt = (px: number) => {
    ctx.font = `${th.displayWeight} ${px}px ${th.display}`
    ctx.letterSpacing = `${Math.round(px * 0.03)}px`
  }
  ctx.save()
  // The backing's padding, in type sizes: across, and above the capitals and below the baseline.
  const padX = 0.42
  const padY = 0.3
  let size = Math.round(72 * k)
  fontAt(size)
  const widest = Math.max(...lines.map((l) => ctx.measureText(l.join(' ')).width))
  if (widest + 2 * padX * size > maxW) {
    size = Math.floor(maxW / (widest / size + 2 * padX))
    fontAt(size)
  }
  const space = ctx.measureText(' ').width
  const widths = lines.map((l) => l.map((w) => ctx.measureText(w).width))
  const lineW = widths.map((ws) => ws.reduce((a, b) => a + b, 0) + space * (ws.length - 1))
  const cap = ctx.measureText('H').actualBoundingBoxAscent || size * 0.7
  const lead = size * 1.12
  const boxW = Math.max(...lineW) + 2 * padX * size
  const boxH = cap + lead * (lines.length - 1) + 2 * padY * size
  const cx = r.x + r.w / 2
  // Bottom at the watermark's top (24 px margin, 56 px mark) plus a gap.
  const bottom = r.y + r.h - (24 + 56 + 28) * k
  const top = bottom - boxH
  ctx.globalAlpha = sub.alpha
  ctx.fillStyle = 'rgba(11, 11, 12, 0.68)'
  ctx.beginPath()
  ctx.roundRect(cx - boxW / 2, top, boxW, boxH, 14 * k)
  ctx.fill()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)'
  ctx.shadowBlur = 8 * k
  ctx.shadowOffsetY = 2 * k
  let n = 0
  lines.forEach((line, li) => {
    let x = cx - lineW[li]! / 2
    const y = top + padY * size + cap + li * lead
    line.forEach((w, wi) => {
      ctx.fillStyle = n++ === sub.current ? th.accent : '#e9e5da'
      ctx.fillText(w, x, y)
      x += widths[li]![wi]! + space
    })
  })
  ctx.restore()
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

/** One frame of the clip. `scratch` is a small canvas the mosaic reuses, `stamp` one the watermark does, `cardStamp` the fox card's. */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  L: Layout,
  f: FrameInput,
  scratch: HTMLCanvasElement,
  stamp?: HTMLCanvasElement,
  cardStamp?: HTMLCanvasElement,
): void {
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
  if (f.watermark && stamp) drawWatermark(ctx, L, f.clock, stamp)
  const sub = f.subtitles ? subtitleAt(f.subtitles.words, f.subtitles.t) : null
  if (sub) drawSubtitle(ctx, L, sub)
  if (f.card && f.card.alpha > 0 && cardStamp) drawCard(ctx, L, f.card, cardStamp)

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
