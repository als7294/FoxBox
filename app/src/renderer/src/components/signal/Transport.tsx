import { useRef } from 'react'
import { DEFAULT_CLICK_VOLUME } from '@/audio/metronome'
import { player } from '@/audio/playerInstance'
import { useDragValue } from '@/lib/useDragValue'
import { toggleMetronome, useMetronome } from '@/state/metronome'
import { useStudio } from '@/state/studio'
import { f2 } from '@/visuals/canvas'
import { useFrame } from '@/visuals/frame'
import { reducedMotion } from '@/visuals/motion'
import { signalGeom } from '@/visuals/signal'
import { vis } from '@/visuals/state'
import { ABToggle } from './ABToggle'
import styles from './signal.module.css'

/** Play from the top / stop (Space). Stopping returns to the start, as on a sampler. */
export function togglePlay(): void {
  if (player.isPlaying) player.stop()
  else void player.play()
}

/**
 * CLICK (M): the preview metronome, a click on every beat of the render's grid with the downbeat accented, and its
 * level. Preview only: never rendered or exported. The LED flashes with the beat while playing (red on the downbeat).
 */
function MetronomeControl() {
  const on = useMetronome((s) => s.on)
  const volume = useMetronome((s) => s.volume)
  const setVolume = useMetronome((s) => s.setVolume)
  const led = useRef<HTMLElement>(null)
  useFrame(() => {
    const el = led.current
    if (!el) return
    const beating = on && player.isPlaying && vis.lastBeat >= 0
    const down = beating && vis.lastBeat % 4 === 0 ? 'true' : 'false'
    if (el.dataset.down !== down) el.dataset.down = down
    const opacity = beating && !reducedMotion() ? (0.3 + 0.7 * vis.beatPulse).toFixed(2) : '1'
    if (el.style.opacity !== opacity) el.style.opacity = opacity
  })
  const { position, handlers } = useDragValue({
    value: volume,
    defaultValue: DEFAULT_CLICK_VOLUME,
    min: 0,
    max: 1,
    orientation: 'horizontal',
    absolute: true,
    onChange: setVolume,
  })
  const pct = `${Math.round(volume * 100)}%`
  return (
    <div className={styles.metro} role="group" aria-label="Metronome" data-on={on || undefined}>
      <button
        type="button"
        className={styles.metroToggle}
        aria-pressed={on}
        aria-keyshortcuts="M"
        title="Metronome (M): a click on every beat, the downbeat accented. Preview only, never exported."
        onClick={toggleMetronome}
      >
        <i ref={led} className={styles.metroLed} aria-hidden="true" />
        CLICK
      </button>
      <div
        role="slider"
        tabIndex={0}
        aria-label="Click volume"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(volume * 100)}
        aria-valuetext={pct}
        title={`Click volume ${pct} · double-click resets`}
        className={styles.metroVol}
        {...handlers}
      >
        <div className={styles.metroFill} style={{ width: `${position * 100}%` }} />
        <div className={styles.metroThumb} style={{ left: `${position * 100}%` }} />
      </div>
    </div>
  )
}

/** Position, PLAY/STOP (Space), A/B (\), loop (L) and the metronome (M). */
export function Transport({ duration }: { duration: number }) {
  const playing = useStudio((s) => s.playing)
  const side = useStudio((s) => s.side)
  const loop = useStudio((s) => s.loop)
  const time = useRef<HTMLSpanElement>(null)
  useFrame(() => {
    const el = time.current
    if (!el) return
    const text = `${f2(player.currentTime).padStart(5, '0')} / ${f2(signalGeom().target)}`
    if (el.textContent !== text) el.textContent = text
  })
  const disabled = duration <= 0
  return (
    <>
      <span ref={time} className={styles.time} aria-label="Position">
        00.00 / 0.00
      </span>
      <button
        type="button"
        className={styles.play}
        aria-pressed={playing}
        aria-label={playing ? 'Stop' : 'Play'}
        aria-keyshortcuts="Space"
        disabled={disabled}
        onClick={togglePlay}
      >
        {playing ? '■ STOP' : '▶ PLAY'}
      </button>
      <ABToggle side={side} disabled={disabled} onSide={(s) => player.setSide(s)} />
      <button
        type="button"
        className={styles.loop}
        aria-pressed={loop}
        aria-keyshortcuts="L"
        disabled={disabled}
        onClick={() => player.setLoop(!loop)}
      >
        ⟲ LOOP
      </button>
      <MetronomeControl />
    </>
  )
}
