import { useRef } from 'react'
import { drawLevel } from '@/visuals/draw'
import { useFrame } from '@/visuals/frame'
import { vis } from '@/visuals/state'
import { theme } from '@/visuals/theme'
import styles from './source.module.css'

/** The history holds dB-mapped levels (−48 dBFS → 0, 0 dBFS → 1); the meter wants linear amplitude. */
const linear = (m: number) => (m <= 0 ? 0 : Math.pow(10, (m * 48 - 48) / 20))

/** 48-segment input meter with peak hold, −48…0 dBFS. */
export function InputMeter() {
  const cv = useRef<HTMLCanvasElement>(null)
  useFrame(() => {
    drawLevel(cv.current, { th: theme(), lvl: linear(vis.inLvl), pk: linear(vis.inPk) })
    const el = cv.current
    if (el) el.setAttribute('aria-valuenow', String(Math.round(vis.inLvl * 48 - 48)))
  })
  return (
    <>
      <canvas
        ref={cv}
        className={styles.level}
        role="meter"
        aria-label="Input level meter"
        aria-valuemin={-48}
        aria-valuemax={0}
        aria-valuenow={-48}
      />
      <div className={styles.scale} aria-hidden="true">
        <span style={{ left: 0 }}>−48</span>
        <span style={{ left: '50%' }}>−24</span>
        <span style={{ left: '75%' }}>−12</span>
        <span style={{ left: '87.5%' }}>−6</span>
        <span style={{ right: 0 }}>0</span>
      </div>
    </>
  )
}
