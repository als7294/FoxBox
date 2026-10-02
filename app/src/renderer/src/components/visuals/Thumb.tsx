import { useEffect, useRef } from 'react'

/** What a thumbnail stands for: a layer's kind, the base, the face card. */
export type ThumbKind = 'GEN' | 'FX' | 'MD' | 'TD' | 'TXT' | 'BASE' | 'FACE'

const INK = '#e9e5da'
const EMBER = '#ff4b2b'
const AMBER = '#ffb23e'
const ICE = '#7cc8ff'
const PINK = '#e79bd0'
const OK = '#7fd08a'

/** A small deterministic random from a string (the same style always draws the same picture). */
function rng(key: string): () => number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619)
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    return ((h ^= h >>> 16) >>> 0) / 4294967296
  }
}

/** Draws a still that reads as its kind: rings or bars (generators), stripes (filters), a swirl (Milkdrop), joined
 * points (TouchDesigner), letters (text), the base's picture, a hidden face. */
function draw(c: HTMLCanvasElement, kind: ThumbKind, id: string): void {
  const ctx = c.getContext('2d')
  if (!ctx) return
  const { width: w, height: h } = c
  const r = rng(`${kind}:${id}`)
  ctx.fillStyle = '#050506'
  ctx.fillRect(0, 0, w, h)
  ctx.lineWidth = Math.max(1, w / 40)
  if (kind === 'GEN') {
    if (r() < 0.5) {
      for (let i = 0; i < 5; i++) {
        ctx.strokeStyle = i % 2 ? ICE : EMBER
        ctx.globalAlpha = 0.9 - i * 0.15
        ctx.beginPath()
        ctx.arc(w / 2, h / 2, (i + 1) * (h / 9) * (0.8 + r() * 0.4), 0, Math.PI * 2)
        ctx.stroke()
      }
    } else {
      const n = 10
      for (let i = 0; i < n; i++) {
        const bh = h * (0.2 + r() * 0.75)
        ctx.fillStyle = i % 3 ? ICE : EMBER
        ctx.fillRect((i * w) / n + 1, h - bh, w / n - 2, bh)
      }
    }
  } else if (kind === 'FX') {
    const g = ctx.createLinearGradient(0, 0, w, h)
    g.addColorStop(0, '#3a2a14')
    g.addColorStop(1, '#101012')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = AMBER
    for (let x = -h; x < w; x += w / 6) {
      ctx.globalAlpha = 0.35 + r() * 0.5
      ctx.beginPath()
      ctx.moveTo(x, h)
      ctx.lineTo(x + h, 0)
      ctx.stroke()
    }
  } else if (kind === 'MD') {
    const g = ctx.createRadialGradient(w * (0.3 + r() * 0.4), h / 2, 1, w / 2, h / 2, w)
    g.addColorStop(0, PINK)
    g.addColorStop(0.45, '#4b2a6a')
    g.addColorStop(1, '#050506')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = ICE
    ctx.globalAlpha = 0.6
    ctx.beginPath()
    for (let a = 0; a < Math.PI * 6; a += 0.2) ctx.lineTo(w / 2 + Math.cos(a) * a * (w / 40), h / 2 + Math.sin(a) * a * (h / 40))
    ctx.stroke()
  } else if (kind === 'TD') {
    const pts = Array.from({ length: 14 }, () => [r() * w, r() * h] as const)
    ctx.strokeStyle = EMBER
    ctx.globalAlpha = 0.55
    for (const [x, y] of pts)
      for (const [x2, y2] of pts) {
        if (Math.hypot(x - x2, y - y2) > w / 3) continue
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(x2, y2)
        ctx.stroke()
      }
    ctx.globalAlpha = 1
    ctx.fillStyle = INK
    for (const [x, y] of pts) ctx.fillRect(x - 1.5, y - 1.5, 3, 3)
  } else if (kind === 'TXT') {
    ctx.fillStyle = INK
    ctx.font = `800 ${Math.round(h * 0.62)}px 'Big Shoulders Display', sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('Aa', w / 2, h / 2 + 1)
  } else if (kind === 'BASE') {
    const g = ctx.createLinearGradient(0, 0, 0, h)
    g.addColorStop(0, '#16161a')
    g.addColorStop(1, '#050506')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = id === 'camera' ? OK : id === 'touchdesigner' ? EMBER : ICE
    ctx.globalAlpha = id === 'none' ? 0.25 : 0.8
    ctx.beginPath()
    for (let x = 0; x <= w; x += 2) ctx.lineTo(x, h / 2 + Math.sin(x / (w / 9) + r() * 0.3) * h * 0.25 * (id === 'waveform' ? 1 : 0.4))
    ctx.stroke()
  } else {
    // FACE: a head shape, its face covered (or, off, uncovered and red).
    ctx.fillStyle = '#1b1b20'
    ctx.beginPath()
    ctx.ellipse(w / 2, h * 0.58, w * 0.26, h * 0.34, 0, 0, Math.PI * 2)
    ctx.fill()
    if (id === 'off') {
      ctx.strokeStyle = EMBER
      ctx.stroke()
    } else {
      const s = Math.max(3, Math.round(w / 9))
      for (let y = h * 0.34; y < h * 0.86; y += s)
        for (let x = w * 0.28; x < w * 0.72; x += s) {
          ctx.fillStyle = r() < 0.5 ? OK : '#2f4a34'
          ctx.fillRect(x, y, s - 1, s - 1)
        }
    }
  }
  ctx.globalAlpha = 1
}

/**
 * A still thumbnail, drawn once per kind and id (a live render of every style would cost a GPU context each). `fill`:
 * as big as its box (w × h is then only the drawing's size).
 */
export function Thumb(p: { kind: ThumbKind; id: string; w: number; h: number; className?: string; fill?: boolean }) {
  const { kind, id } = p
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (ref.current) draw(ref.current, kind, id)
  }, [kind, id])
  return (
    <canvas
      ref={ref}
      width={p.w * 2}
      height={p.h * 2}
      style={p.fill ? { width: '100%', height: '100%' } : { width: p.w, height: p.h }}
      className={p.className}
      aria-hidden="true"
    />
  )
}
