import { useEffect, useRef } from 'react'
import { clipRendering } from '@/components/clips/rendering'
import { reportError } from '@/components/common/ErrorBoundary'
import type { Scene } from './compositor'
import { Compositor } from './compositorEngine'
import type { AudioFrame } from './registry'
import { backingSize } from './stage'

/**
 * A Scene on a canvas, live: the compositor sized to the canvas (CSS px × dpr, capped) and drawn every animation
 * frame from `source`, paused while the window is hidden. The stage, the output window and previews use it; the
 * offline clip renderer drives a Compositor directly.
 */
export function CompositeStage({
  scene,
  source,
  output = 'stage',
  className,
  onCanvas,
  onFps,
}: {
  scene: Scene
  source: () => AudioFrame
  output?: 'stage' | 'window' | 'clip'
  className?: string
  onCanvas?(canvas: HTMLCanvasElement | null): void
  onFps?(fps: number): void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const comp = useRef<Compositor | null>(null)
  const sourceRef = useRef(source)
  sourceRef.current = source
  const fpsRef = useRef(onFps)
  fpsRef.current = onFps

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const c = new Compositor(canvas, { output })
    comp.current = c
    onCanvas?.(canvas)
    const ro = new ResizeObserver(() => {
      const r = canvas.getBoundingClientRect()
      const { width, height } = backingSize(r.width, r.height, window.devicePixelRatio)
      c.resize(width, height)
    })
    ro.observe(canvas)
    let raf = 0
    let last = 0
    let n = 0
    let t0 = performance.now()
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      // The VISUALS stage pauses while SAVE CLIP renders (it competes for the GPU); the output window keeps drawing,
      // since it may be on a projector mid-show.
      if (document.hidden || (output === 'stage' && clipRendering())) {
        last = 0
        return
      }
      const dt = last ? Math.min(100, now - last) : 16
      last = now
      // Outside React's render, so no boundary sees it: a bad frame is logged once and the loop carries on.
      try {
        c.frame(sourceRef.current(), dt)
      } catch (err) {
        reportError('STAGE frame', err)
      }
      n++
      if (now - t0 >= 1000) {
        fpsRef.current?.(Math.round((n * 1000) / (now - t0)))
        n = 0
        t0 = now
      }
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      c.dispose()
      comp.current = null
      onCanvas?.(null)
    }
    // The compositor lives as long as the canvas; the scene is applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [output])

  useEffect(() => {
    comp.current?.setScene(scene)
  }, [scene])

  return <canvas ref={canvasRef} className={className} style={{ display: 'block', width: '100%', height: '100%' }} />
}
