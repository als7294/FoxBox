/**
 * TOUCHDESIGNER (1.6): the user's own TouchDesigner, run by FoxBox in the background (main/bridge/tdSession.ts), its
 * picture arriving over Syphon as VideoFrames (the preload posts each to the page; this keeps the newest and closes
 * the one before). Drawn with COVER fit. Always labelled in its corner, so the label is in every picture it's in (the
 * stage, the output window, saved clips): TouchDesigner's free licence is non-commercial, so what it draws isn't
 * copyright-safe, and the licence caps the picture at 1280 × 1280. Until a frame arrives: a dim WAITING card.
 */
import type { BaseInstance } from '../compositor'
import type { Palette } from '../registry'
import { theme } from '@/visuals/theme'
import { context2d, fitRect, makeCanvas, quietCard, setSize } from './kit'

export const TD_LABEL = 'TOUCHDESIGNER · DEMO · NON-COMMERCIAL, NOT COPYRIGHT-SAFE'

let latest: VideoFrame | null = null
let seen = 0 // frames received in this window
if (typeof window !== 'undefined') {
  window.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as { fvwks?: string; frame?: VideoFrame } | null
    if (e.source !== window || data?.fvwks !== 'td-frame' || !data.frame) return
    latest?.close()
    latest = data.frame
    seen++
  })
}

/** The newest TouchDesigner frame (PROD's tile snapshots); null before one arrives. */
export const tdLatestFrame = (): VideoFrame | null => latest

const TD_LABEL_LINES = ['TOUCHDESIGNER · DEMO', 'NON-COMMERCIAL, NOT COPYRIGHT-SAFE']

/**
 * The label in the frame's bottom-right corner, on a dark pill, sized to the frame's height. One line where it fits,
 * else two (a 9:16 frame), shrunk if even those don't: never cut off.
 */
export function drawTdLabel(ctx: CanvasRenderingContext2D): void {
  const { width: w, height: h } = ctx.canvas
  let px = Math.max(9, Math.round(h * 0.022))
  ctx.save()
  ctx.font = `600 ${px}px ${theme().mono}`
  const widest = (lines: string[]) => Math.max(...lines.map((l) => ctx.measureText(l).width))
  const lines = widest([TD_LABEL]) + px * 2.4 <= w ? [TD_LABEL] : TD_LABEL_LINES // 2.4 px: the pill's padding and margin
  let tw = widest(lines)
  if (tw + px * 2.4 > w) {
    px = Math.max(4, Math.floor((px * w) / (tw + px * 2.4)))
    ctx.font = `600 ${px}px ${theme().mono}`
    tw = widest(lines)
  }
  const pad = px * 0.6
  const lh = px * 1.25
  const th = lh * (lines.length - 1) + px
  const x = w - tw - pad * 3
  const y = h - th - pad * 3
  ctx.globalAlpha = 0.72
  ctx.fillStyle = '#000'
  ctx.fillRect(x - pad, y - pad, tw + pad * 2, th + pad * 2)
  ctx.globalAlpha = 1
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'top'
  lines.forEach((line, i) => ctx.fillText(line, x, y + i * lh + px * 0.05))
  ctx.restore()
}

/**
 * TouchDesigner's picture on `canvas` (COVER), labelled, or WAITING until a frame arrives: the BASE, and a TD layer
 * (1.5.2, families/touchdesigner). `resize` forces a redraw; `draw` skips when nothing new has arrived.
 */
export function tdPainter(canvas: HTMLCanvasElement, palette: Palette) {
  const ctx = context2d(canvas)
  let drawn = -1
  return {
    resize(width: number, height: number) {
      if (setSize(canvas, width, height)) drawn = -1
    },
    draw() {
      if (!ctx || drawn === seen) return // nothing new
      drawn = seen
      if (!latest) {
        quietCard(ctx, palette, 'WAITING FOR TOUCHDESIGNER')
      } else {
        const r = fitRect(latest.displayWidth, latest.displayHeight, canvas.width, canvas.height, 'cover')
        ctx.drawImage(latest, r.x, r.y, r.w, r.h)
      }
      drawTdLabel(ctx)
    },
  }
}

export function touchDesignerBase(palette: Palette): BaseInstance {
  const canvas = makeCanvas()
  const p = tdPainter(canvas, palette)
  return {
    canvas,
    resize: p.resize,
    frame: p.draw,
    dispose() {
      setSize(canvas, 2, 2)
    },
  }
}
