import { forwardRef, useImperativeHandle, useRef } from 'react'
import type { Peaks } from '@/api/types'
import type { WaveAnalysis } from '@/visuals/analysis'
import { drawMini } from '@/visuals/draw'
import { useFrame } from '@/visuals/frame'
import { rgba } from '@/visuals/canvas'
import { prep } from '@/visuals/canvas'
import { theme } from '@/visuals/theme'
import styles from './signal.module.css'

export interface MiniWaveformHandle {
  /** PNG data URL of the drawing (used as the native drag image). */
  toDataUrl(): string | null
}

/** Band-coloured mini waveform (the cartridge) from a decoded analysis, or a plain one from engine peaks. */
export const MiniWaveform = forwardRef<MiniWaveformHandle, { analysis?: WaveAnalysis | null; peaks?: Peaks | null; className?: string }>(
  function MiniWaveform({ analysis, peaks, className }, ref) {
    const canvas = useRef<HTMLCanvasElement>(null)
    const drawn = useRef<{ a: unknown; w: number; theme: string } | null>(null)
    useImperativeHandle(ref, () => ({
      toDataUrl: () => {
        try {
          return canvas.current?.toDataURL('image/png') ?? null
        } catch {
          return null
        }
      },
    }))
    // Redraw only when the data, size or theme changes (cheap check per frame).
    useFrame(() => {
      const cv = canvas.current
      if (!cv) return
      const th = theme()
      const src = analysis ?? peaks ?? null
      const d = drawn.current
      if (d && d.a === src && d.w === cv.clientWidth && d.theme === th.name) return
      drawn.current = { a: src, w: cv.clientWidth, theme: th.name }
      if (analysis || !peaks) {
        drawMini(cv, th, analysis ?? null)
        return
      }
      const P = prep(cv)
      if (!P) return
      const { x, w, h } = P
      x.clearRect(0, 0, w, h)
      const n = Math.min(peaks.min.length, peaks.max.length)
      if (!n) return
      x.fillStyle = rgba(th.ink, 0.7)
      const mid = h / 2
      for (let px = 0; px < w; px += 2) {
        const i0 = Math.floor((px / w) * n)
        const i1 = Math.max(i0 + 1, Math.floor(((px + 2) / w) * n))
        let lo = 0
        let hi = 0
        for (let i = i0; i < i1 && i < n; i++) {
          lo = Math.min(lo, peaks.min[i]!)
          hi = Math.max(hi, peaks.max[i]!)
        }
        x.fillRect(px, mid - hi * mid, 2, Math.max(1, (hi - lo) * mid))
      }
    })
    return <canvas ref={canvas} className={className ?? styles.mini} aria-hidden="true" />
  },
)
