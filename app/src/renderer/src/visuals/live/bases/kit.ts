/**
 * The bases' shared helpers: how a picture fills the frame (cover / contain), the waveform's shape from a decoded
 * track or from the engine's peaks, the Ken Burns drift, an onset envelope, the dim "… OFF" card, and the 2D canvas
 * every base draws in. The maths is pure (no DOM) so it's unit-tested; the drawing bits take a context.
 */
import type { Palette } from '../registry'
import { theme } from '@/visuals/theme'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Where a srcW×srcH picture lands in a dstW×dstH frame: 'cover' fills it (the overflow is cut, so the rect can start
 * off-canvas), 'contain' fits all of it inside (letterboxed on the palette ground). Centred either way.
 */
export function fitRect(srcW: number, srcH: number, dstW: number, dstH: number, fit: 'cover' | 'contain' = 'cover'): Rect {
  if (!(srcW > 0 && srcH > 0 && dstW > 0 && dstH > 0)) return { x: 0, y: 0, w: dstW, h: dstH }
  const scale = fit === 'cover' ? Math.max(dstW / srcW, dstH / srcH) : Math.min(dstW / srcW, dstH / srcH)
  const w = srcW * scale
  const h = srcH * scale
  return { x: (dstW - w) / 2, y: (dstH - h) / 2, w, h }
}

/**
 * A slow Ken Burns drift at `t` seconds: a zoom that breathes between 1.03× and 1.09× over about 50 s while the centre
 * wanders a little (up to ±1.6% of the frame) on slower, unrelated periods, so it never visibly loops. Still (1×, no
 * pan) under reduced motion.
 */
export function kenBurns(t: number, reduced: boolean): { scale: number; dx: number; dy: number } {
  if (reduced) return { scale: 1, dx: 0, dy: 0 }
  const tau = Math.PI * 2
  return {
    scale: 1.06 + 0.03 * Math.sin((tau * t) / 50),
    dx: 0.016 * Math.sin((tau * t) / 71 + 0.7),
    dy: 0.012 * Math.sin((tau * t) / 59 + 2.1),
  }
}

/** A rect scaled about its centre by `k` and shifted by (dx, dy) fractions of the frame. */
export function drift(r: Rect, k: { scale: number; dx: number; dy: number }, frameW: number, frameH: number): Rect {
  const w = r.w * k.scale
  const h = r.h * k.scale
  return { x: r.x - (w - r.w) / 2 + k.dx * frameW, y: r.y - (h - r.h) / 2 + k.dy * frameH, w, h }
}

/** An onset envelope: jumps to the hit's strength (≥ 1 is a hit, capped at 1.5), then decays with time constant `tauMs`. */
export function hitEnvelope(prev: number, onset: number, active: boolean, dtMs: number, tauMs: number): number {
  const decayed = prev * Math.exp(-Math.max(0, dtMs) / tauMs)
  return active && onset >= 1 ? Math.max(decayed, Math.min(1.5, onset)) : decayed
}

/** The waveform's shape: per bucket, its loudness (RMS) and its peak, each 0–1 against the loudest bucket. */
export interface Envelope {
  rms: Float32Array
  peak: Float32Array
}

/** Buckets the envelope is computed at, once per track; the bars are pooled from it at draw size. */
export const ENVELOPE_BUCKETS = 2048

/** Samples looked at per bucket at most (a long track is strided: the shape, not every sample, is what's drawn). */
const MAX_PER_BUCKET = 1024

const normalize = (a: Float32Array) => {
  let top = 0
  for (let i = 0; i < a.length; i++) top = Math.max(top, a[i]!)
  if (top > 0) for (let i = 0; i < a.length; i++) a[i]! /= top
  return a
}

/**
 * From decoded channels: loudness and peak per bucket. A mastered track peaks near full scale everywhere, so the bars
 * follow its RMS (the build and the drop show), with the peak kept for a faint outline.
 */
export function envelopeFromChannels(channels: readonly Float32Array[], buckets = ENVELOPE_BUCKETS): Envelope {
  const rms = new Float32Array(buckets)
  const peak = new Float32Array(buckets)
  const len = channels[0]?.length ?? 0
  if (!len) return { rms, peak }
  const per = len / buckets
  const stride = Math.max(1, Math.floor(per / MAX_PER_BUCKET))
  for (let k = 0; k < buckets; k++) {
    const a = Math.floor(k * per)
    const b = Math.max(a + 1, Math.min(len, Math.floor((k + 1) * per)))
    let e = 0
    let p = 0
    let n = 0
    for (const ch of channels) {
      for (let i = a; i < b; i += stride) {
        const v = ch[i]!
        e += v * v
        const m = v < 0 ? -v : v
        if (m > p) p = m
        n++
      }
    }
    rms[k] = Math.sqrt(e / Math.max(1, n))
    peak[k] = p
  }
  return { rms: normalize(rms), peak: normalize(peak) }
}

/**
 * From the engine's peaks (min / max per bucket, as the Studio and the SONG strip draw them): the amplitude per bucket,
 * resampled to `buckets`. Peaks have no loudness, so `rms` is the amplitude too.
 */
export function envelopeFromPeaks(peaks: { min: readonly number[]; max: readonly number[] }, buckets = ENVELOPE_BUCKETS): Envelope {
  const n = peaks.max.length
  const out = new Float32Array(buckets)
  if (!n) return { rms: out, peak: out }
  const amp = (i: number) => {
    const hi = peaks.max[i] ?? 0
    const lo = peaks.min[i] ?? -hi
    return Math.max(0, (hi - lo) / 2)
  }
  for (let k = 0; k < buckets; k++) {
    const a = Math.floor((k * n) / buckets)
    const b = Math.max(a + 1, Math.floor(((k + 1) * n) / buckets))
    let m = 0
    for (let i = a; i < b && i < n; i++) m = Math.max(m, amp(i))
    out[k] = m
  }
  normalize(out)
  return { rms: out, peak: out }
}

/** `src` pooled into `n` bars: each bar is the loudest bucket it covers (so short hits don't vanish at a small size). */
export function pool(src: Float32Array, n: number): Float32Array {
  const out = new Float32Array(Math.max(0, n))
  const len = src.length
  if (!len || n <= 0) return out
  for (let k = 0; k < n; k++) {
    const a = Math.floor((k * len) / n)
    const b = Math.max(a + 1, Math.floor(((k + 1) * len) / n))
    let m = 0
    for (let i = a; i < b && i < len; i++) m = Math.max(m, src[i]!)
    out[k] = m
  }
  return out
}

/** The frame's 2D context (bases draw opaque: alpha off is faster to composite). */
export function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  return canvas.getContext('2d', { alpha: false })
}

/** A fresh canvas at a small placeholder size (the compositor resizes it before the first frame). */
export function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 2
  c.height = 2
  return c
}

/** Sets a canvas's backing size (whole px, at least 2). Returns true when it changed. */
export function setSize(canvas: HTMLCanvasElement, width: number, height: number): boolean {
  const w = Math.max(2, Math.round(width))
  const h = Math.max(2, Math.round(height))
  if (canvas.width === w && canvas.height === h) return false
  canvas.width = w
  canvas.height = h
  return true
}

/** The palette ground. */
export function ground(ctx: CanvasRenderingContext2D, p: Palette): void {
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.fillStyle = p.bg
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
}

/** A calm, dim mono label in the middle of the frame ('CAMERA OFF', 'VIDEO UNAVAILABLE'), on the palette ground. */
export function quietCard(ctx: CanvasRenderingContext2D, p: Palette, label: string): void {
  ground(ctx, p)
  const { width: w, height: h } = ctx.canvas
  const px = Math.max(10, Math.round(Math.min(w, h) * 0.02))
  ctx.save()
  ctx.font = `500 ${px}px ${theme().mono}`
  const spacing = px * 0.24
  ctx.letterSpacing = `${spacing.toFixed(1)}px`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = p.ink
  ctx.globalAlpha = 0.28
  // The spacing trails the last letter too: shift by half of it so the word sits truly centred.
  ctx.fillText(label, w / 2 + spacing / 2, h / 2)
  ctx.restore()
}
