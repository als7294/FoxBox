/**
 * A style on a full-size canvas, for React: resolves `styleId` from whichever family has it (again whenever the
 * families change), applies the palette and runs the frame loop from `source`. The wrapper div is React's; the canvas
 * inside it is the stage's (it swaps in a fresh one per instance), so React never reconciles a node it didn't make.
 */
import { useEffect, useRef, type CSSProperties } from 'react'
import { paletteById } from './palettes'
import { findStyle, onFamiliesChange, type AudioFrame } from './registry'
import { StyleStage } from './stage'

export interface VisualStageProps {
  styleId: string
  paletteId: string
  source: () => AudioFrame
  output?: 'stage' | 'window' | 'clip'
  /** The canvas being drawn on (it changes with the style or palette), or null on unmount. */
  onCanvas?(c: HTMLCanvasElement | null): void
  className?: string
}

const HOST: CSSProperties = { position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: '#000' }
const CANVAS = 'position:absolute;inset:0;width:100%;height:100%;display:block'

export function VisualStage({ styleId, paletteId, source, output = 'stage', onCanvas, className }: VisualStageProps) {
  const host = useRef<HTMLDivElement>(null)
  const stage = useRef<StyleStage | null>(null)
  const onCanvasRef = useRef(onCanvas)
  onCanvasRef.current = onCanvas
  // The latest props, for the stage the mount effect creates.
  const props = useRef({ paletteId, source })
  props.current = { paletteId, source }

  useEffect(() => {
    const el = host.current
    if (!el) return
    const canvas = document.createElement('canvas')
    canvas.style.cssText = CANVAS
    canvas.setAttribute('aria-hidden', 'true')
    el.appendChild(canvas)
    const s = new StyleStage(canvas, { output, onCanvas: (c) => onCanvasRef.current?.(c) })
    stage.current = s
    void s.setPalette(paletteById(props.current.paletteId))
    s.start(props.current.source)
    onCanvasRef.current?.(canvas)
    return () => {
      stage.current = null
      s.dispose()
      s.canvas.remove()
    }
  }, [output])

  useEffect(() => {
    void stage.current?.setPalette(paletteById(paletteId))
  }, [paletteId, output])

  useEffect(() => {
    stage.current?.start(source)
  }, [source, output])

  useEffect(() => {
    let alive = true
    let current: unknown = undefined
    const resolve = async () => {
      const style = await findStyle(styleId)
      // A family re-registering hands back the same object for an unchanged style: keep the running instance.
      if (!alive || style === current) return
      current = style
      await stage.current?.setStyle(style)
    }
    void resolve()
    const off = onFamiliesChange(() => void resolve())
    return () => {
      alive = false
      off()
    }
  }, [styleId, output])

  return <div ref={host} className={className} style={HOST} />
}
