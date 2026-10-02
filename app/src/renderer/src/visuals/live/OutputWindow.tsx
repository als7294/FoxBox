import { useEffect, useRef } from 'react'
import { bridge } from '@/env'
import { onOutputFrame, takeFrame } from './output'

/**
 * The output window (index.html?window=output): the VISUALS stage's picture, full screen, nothing else. It shows the
 * frames the stage sends (at the stage's resolution, fitted on black) and draws nothing itself; while SAVE CLIP
 * renders the stage pauses and the last frame holds. Esc closes it.
 */
export function OutputWindow() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const view = canvas?.getContext('bitmaprenderer')
    if (!canvas || !view) return
    // One frame per display refresh: the newest one that came, shown, which lets the stage send the next (the first
    // look also catches one that came before this mounted). If the refresh doesn't come (macOS pauses frames for a
    // covered window), a 50 ms timer shows it anyway, so the stage never stalls on the one frame in flight.
    let received = 0
    let shown = 0
    let byTimer = 0
    const show = (fromTimer = false) => {
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      raf = 0
      timer = 0
      const bmp = takeFrame()
      if (!bmp) return
      shown++
      if (fromTimer) byTimer++
      // The canvas takes the frame's own size (it would stay 300×150, squashing a 9:16 frame); CSS contains it.
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width
        canvas.height = bmp.height
      }
      view.transferFromImageBitmap(bmp)
    }
    let raf = requestAnimationFrame(() => show())
    let timer = 0
    const off = onOutputFrame(() => {
      received++
      if (!raf) raf = requestAnimationFrame(() => show())
      if (!timer) timer = window.setTimeout(() => show(true), 50)
    })
    // main.log: frames received and shown, every 5 s for the first 30 s, then every minute (a black OUTPUT says why).
    let ticks = 0
    const report = () => {
      bridge()?.log('OUTPUT', `${received} frames received, ${shown} shown (${byTimer} by the timer) in the last ${ticks < 6 ? 5 : 60} s`)
      received = shown = byTimer = 0
      ticks++
      stats = window.setTimeout(report, ticks < 6 ? 5000 : 60_000)
    }
    let stats = window.setTimeout(report, 5000)
    return () => {
      off()
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      window.clearTimeout(stats)
    }
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && void bridge()?.visuals.close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', cursor: 'none' }} data-testid="visuals-output">
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain' }} />
    </div>
  )
}
