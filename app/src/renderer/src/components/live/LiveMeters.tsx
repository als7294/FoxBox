import { useEffect, useRef } from 'react'
import type { LiveBus } from '@/audio/live'
import styles from './live.module.css'

const CLIP = 0.989 // about -0.1 dBFS
const HOLD_MS = 1500

/** IN (the mic, before the mask) and OUT (the masked output) peak meters, with clip lights that hold 1.5 s. */
export function LiveMeters({ bus }: { bus: LiveBus | null }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([])
  const leds = useRef<(HTMLSpanElement | null)[]>([])
  useEffect(() => {
    let raf = 0
    const buf = new Float32Array(2048)
    const clipped = [0, 0]
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const now = performance.now()
      ;[bus?.input, bus?.analyser].forEach((node, i) => {
        let peak = 0
        if (node) {
          node.getFloatTimeDomainData(buf)
          for (let k = 0; k < buf.length; k++) peak = Math.max(peak, Math.abs(buf[k]!))
        }
        if (peak >= CLIP) clipped[i] = now
        const db = peak > 0 ? 20 * Math.log10(peak) : -90
        const bar = bars.current[i]
        if (bar) bar.style.transform = `scaleX(${Math.max(0, Math.min(1, (db + 60) / 60))})`
        const led = leds.current[i]
        if (led) led.dataset.on = now - clipped[i]! < HOLD_MS ? 'true' : 'false'
      })
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [bus])
  return (
    <div className={styles.meters} aria-hidden="true">
      {['IN', 'OUT'].map((label, i) => (
        <div key={label} className={styles.meter}>
          <span>{label}</span>
          <span className={styles.meterTrack}>
            <span className={styles.meterBar} ref={(el) => void (bars.current[i] = el)} />
          </span>
          <span className={styles.clip} ref={(el) => void (leds.current[i] = el)} title="Clip" />
        </div>
      ))}
    </div>
  )
}
