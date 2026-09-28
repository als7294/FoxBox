import { useEffect, useRef, useState } from 'react'
import { bridge } from '@/env'
import { onOutputMessage } from './output'
import { CompositeStage } from './CompositeStage'
import type { Scene } from './compositor'
import { silentFrame, type AudioFrame } from './registry'

/**
 * The output window (index.html?window=output): the VISUALS scene, full screen, nothing else. It draws the scene
 * itself from the frames the VISUALS page sends; Esc closes it.
 */
export function OutputWindow() {
  const [scene, setScene] = useState<Scene | null>(null)
  const latest = useRef<AudioFrame | null>(null)
  useEffect(
    () =>
      onOutputMessage((m) => {
        // 1.3's single style is a scene of one effect over nothing.
        if (m.type === 'scene') setScene(m.scene)
        else if (m.type === 'style')
          setScene({ base: { kind: 'none' }, effects: [{ id: 's', styleId: m.styleId, opacity: 1, blend: 'normal', reactTo: 'mix', enabled: true }], paletteId: m.paletteId })
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
      {scene && <CompositeStage scene={scene} output="window" source={() => latest.current ?? silentFrame(performance.now() / 1000)} />}
    </div>
  )
}
