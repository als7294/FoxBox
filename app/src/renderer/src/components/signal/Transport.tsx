import { useRef } from 'react'
import { player } from '@/audio/playerInstance'
import { useStudio } from '@/state/studio'
import { f2 } from '@/visuals/canvas'
import { useFrame } from '@/visuals/frame'
import { signalGeom } from '@/visuals/signal'
import { ABToggle } from './ABToggle'
import styles from './signal.module.css'

/** Play from the top / stop (Space). Stopping returns to the start, as on a sampler. */
export function togglePlay(): void {
  if (player.isPlaying) player.stop()
  else void player.play()
}

/** Position, PLAY/STOP (Space), A/B (\) and loop (L). */
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
    </>
  )
}
