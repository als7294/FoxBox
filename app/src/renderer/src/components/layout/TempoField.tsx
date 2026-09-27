import { useEffect, useRef, useState } from 'react'
import { scheduleRender } from '@/state/renderController'
import { studio, useStudio } from '@/state/studio'
import { onBeat } from '@/visuals/studioFrame'
import styles from './layout.module.css'

/** BPM (60–200) with four beat LEDs (lit on playback beats and taps) and TAP tempo. */
export function TempoField() {
  const bpm = useStudio((s) => s.bpm)
  const [text, setText] = useState(String(bpm))
  const [focused, setFocused] = useState(false)
  const leds = useRef<HTMLDivElement>(null)
  const taps = useRef<number[]>([])

  useEffect(() => {
    if (!focused) setText(String(Math.round(bpm * 10) / 10))
  }, [bpm, focused])

  const light = (i: number) => {
    const el = leds.current
    if (!el) return
    ;[...el.children].forEach((c, j) => c.setAttribute('data-on', j === i ? (j === 0 ? 'down' : 'beat') : 'off'))
  }
  useEffect(() => onBeat(light), [])

  const commit = (v: number) => {
    const next = Math.round(Math.min(200, Math.max(60, v)))
    if (next !== bpm) {
      studio.setBpm(next)
      scheduleRender(300)
    }
    setText(String(next))
  }

  const tap = () => {
    const now = performance.now()
    taps.current = [...taps.current.filter((t) => now - t < 2200), now]
    light((taps.current.length - 1) % 4)
    if (taps.current.length >= 3) {
      const iv: number[] = []
      for (let i = 1; i < taps.current.length; i++) iv.push(taps.current[i]! - taps.current[i - 1]!)
      const b = Math.round(60000 / (iv.reduce((a, c) => a + c, 0) / iv.length))
      if (b >= 60 && b <= 200) {
        studio.setBpm(b)
        setText(String(b))
        scheduleRender(900)
      }
    }
  }

  return (
    <div className={styles.tempo}>
      <span className={styles.boxLabel}>BPM</span>
      <input
        className={styles.bpmInput}
        aria-label="Tempo in BPM"
        value={text}
        inputMode="decimal"
        onFocus={() => setFocused(true)}
        onChange={(e) => setText(e.target.value.replace(/[^0-9.]/g, '').slice(0, 5))}
        onBlur={() => {
          setFocused(false)
          commit(parseFloat(text) || bpm)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            commit(bpm + (e.key === 'ArrowUp' ? 1 : -1))
          }
        }}
      />
      <div ref={leds} className={styles.leds} aria-hidden="true">
        <span data-on="off" />
        <span data-on="off" />
        <span data-on="off" />
        <span data-on="off" />
      </div>
      <button type="button" className={styles.tap} onClick={tap}>
        TAP
      </button>
    </div>
  )
}
