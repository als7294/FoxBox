import { useEffect, useRef, useState } from 'react'
import { bridge } from '@/env'
import { onOutputMessage } from './output'
import { silentFrame, type AudioFrame } from './registry'
import { VisualStage } from './VisualStage'

/**
 * The output window (index.html?window=output): the LIVE page's style, full screen, nothing else. It draws the style
 * itself from the frames the LIVE page sends; Esc closes it.
 */
export function OutputWindow() {
  const [style, setStyle] = useState<{ styleId: string; paletteId: string } | null>(null)
  const latest = useRef<AudioFrame | null>(null)
  useEffect(
    () =>
      onOutputMessage((m) => {
        if (m.type === 'style') setStyle({ styleId: m.styleId, paletteId: m.paletteId })
        else latest.current = m.frame
      }),
    [],
  )
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && void bridge()?.visuals.close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', cursor: 'none' }} data-testid="visuals-output">
      {style && (
        <VisualStage
          styleId={style.styleId}
          paletteId={style.paletteId}
          output="window"
          source={() => latest.current ?? silentFrame(performance.now() / 1000)}
          className="output-canvas"
        />
      )}
    </div>
  )
}
