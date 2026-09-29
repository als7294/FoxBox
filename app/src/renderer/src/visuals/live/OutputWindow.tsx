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
    // look also catches one that came before this mounted).
    const show = () => {
      raf = 0
      const bmp = takeFrame()
      if (!bmp) return
      // The canvas takes the frame's own size (it would stay 300×150, squashing a 9:16 frame); CSS contains it.
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width
        canvas.height = bmp.height
      }
      view.transferFromImageBitmap(bmp)
    }
    let raf = requestAnimationFrame(show)
    const off = onOutputFrame(() => {
      if (!raf) raf = requestAnimationFrame(show)
    })
    return () => {
      off()
      cancelAnimationFrame(raf)
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
