import { useRef } from 'react'
import { useStudio } from '@/state/studio'
import { drawGrid } from '@/visuals/draw'
import { useFrame } from '@/visuals/frame'
import { overflowEnd, playhead, signalGeom } from '@/visuals/signal'
import { theme } from '@/visuals/theme'
import styles from './signal.module.css'

/** The bar grid under the waveform: numbered bars, beat ticks (the current beat lit), loop shade, overflow hatch, END. */
export function BarGrid() {
  const cv = useRef<HTMLCanvasElement>(null)
  useFrame(() => {
    drawGrid(cv.current, {
      th: theme(),
      g: signalGeom(),
      loop: useStudio.getState().loop,
      playT: playhead(),
      overflowTo: overflowEnd(),
    })
  })
  return <canvas ref={cv} className={styles.waveCanvas} aria-hidden="true" />
}
