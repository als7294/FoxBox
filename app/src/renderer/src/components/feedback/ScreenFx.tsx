import { useRef } from 'react'
import { useUi } from '@/state/ui'
import { drawWipe } from '@/visuals/draw'
import { useFrame } from '@/visuals/frame'
import { theme } from '@/visuals/theme'
import styles from './feedback.module.css'

/** The screen-change wipe ("ROUTING → VAULT"): covers the view, switches screens at the midpoint, uncovers. */
export function ScreenFx() {
  const cv = useRef<HTMLCanvasElement>(null)
  const drawn = useRef(false)
  useFrame((now) => {
    const wipe = useUi.getState().wipe
    if (!wipe) {
      if (drawn.current && cv.current) {
        cv.current.getContext('2d')?.clearRect(0, 0, cv.current.width, cv.current.height)
        drawn.current = false
      }
      return
    }
    drawn.current = true
    const p = drawWipe(cv.current, theme(), wipe, now)
    if (p >= 0.5 && !wipe.switched) useUi.setState({ screen: wipe.to, wipe: { ...wipe, switched: true } })
    if (p >= 1) useUi.setState({ wipe: null })
  })
  return <canvas ref={cv} className={styles.fx} aria-hidden="true" />
}
