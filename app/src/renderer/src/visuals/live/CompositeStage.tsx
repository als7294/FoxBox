import { useEffect, useRef } from 'react'
import { clipRendering } from '@/components/clips/rendering'
import { reportError } from '@/components/common/ErrorBoundary'
import type { Scene } from './compositor'
import { Compositor } from './compositorEngine'
import type { AudioFrame, FrameExtras } from './registry'
import { backingSize, feedStageFrames } from './stage'

/** 60 fps, less a little for rAF jitter (a 120 Hz display's every other frame, a 60 Hz display's every frame). */
const MIN_FRAME_MS = 1000 / 60 - 2
const RENDERING_FRAME_MS = 1000 / 30 - 2

/**
 * A Scene on a canvas, live: the compositor sized to the canvas (CSS px × dpr, capped), or at a fixed `resolution`
 * (the VISUALS stage: its format's clip size, fitted into the box), and drawn every animation frame from `source`,
 * paused while the window is hidden. `onFrame` sees the canvas after each drawn frame (the output window's feed).
 * The offline clip renderer drives a Compositor directly.
 */
export function CompositeStage({
  scene,
  source,
  output = 'stage',
  className,
  onCanvas,
  onFps,
  onFrame,
  resolution,
  extras,
  paused,
  live,
}: {
  scene: Scene
  source: () => AudioFrame
  output?: 'stage' | 'window' | 'clip'
  className?: string
  onCanvas?(canvas: HTMLCanvasElement | null): void
  onFps?(fps: number): void
  onFrame?(canvas: HTMLCanvasElement): void
  /** Render at exactly this many pixels (width, height), whatever the box; shown contained in it. */
  resolution?: readonly [number, number]
  /** 1.5: per frame, what isn't sound (S1's near mask when the base is CAMERA). */
  extras?: () => FrameExtras | undefined
  /** Skip drawing (VISUALS hidden behind another page with no output window open). */
  paused?: boolean
  /** The output window shows this stage (a projector mid-set): it never stops for a SAVE CLIP render. */
  live?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const comp = useRef<Compositor | null>(null)
  const sourceRef = useRef(source)
  sourceRef.current = source
  const fpsRef = useRef(onFps)
  fpsRef.current = onFps
  const frameRef = useRef(onFrame)
  frameRef.current = onFrame
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const liveRef = useRef(live)
  liveRef.current = live
  const extrasRef = useRef(extras)
  extrasRef.current = extras
  const fixed = useRef(resolution)
  fixed.current = resolution
  const [fixedW, fixedH] = resolution ?? [0, 0]

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const c = new Compositor(canvas, { output })
    comp.current = c
    onCanvas?.(canvas)
    const ro = new ResizeObserver(() => {
      if (fixed.current) return
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
      // SAVE CLIP's offline render competes for the GPU: the stage pauses for it, unless the output window is showing it
      // (it only shows what the stage sends), and then it draws at 30 fps.
      const rendering = output === 'stage' && clipRendering()
      // A hidden window stops drawing, unless the output shows this stage (the main window minimised mid-set).
      if ((document.hidden && !liveRef.current) || pausedRef.current || (rendering && !liveRef.current)) {
        last = 0
        return
      }
      // At most 60 fps: projectors and streams run at 60 and clips at 30, so a 120 Hz display's extra frames are cost only.
      if (last && now - last < (rendering ? RENDERING_FRAME_MS : MIN_FRAME_MS)) return
      const dt = last ? Math.min(100, now - last) : 16
      last = now
      // Outside React's render, so no boundary sees it: a bad frame is logged once and the loop carries on.
      try {
        const a = sourceRef.current()
        // the main stage's frames for listeners outside it (the TouchDesigner feed: its channels, preset and tracking)
        if (output === 'stage') feedStageFrames(c, a, dt, now)
        c.frame(a, dt, extrasRef.current?.())
        frameRef.current?.(canvas)
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
    if (fixedW && fixedH) comp.current?.resize(fixedW, fixedH)
  }, [output, fixedW, fixedH])

  useEffect(() => {
    comp.current?.setScene(scene)
  }, [scene])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ display: 'block', width: '100%', height: '100%', objectFit: resolution ? 'contain' : undefined }}
    />
  )
}
