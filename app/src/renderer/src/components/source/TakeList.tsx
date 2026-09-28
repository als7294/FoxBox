import { useEffect, useRef, useState } from 'react'
import { routeToOutput } from '@/audio/player'
import type { RecordedTake } from '@/state/studio'
import styles from './source.module.css'

export interface TakeListProps {
  takes: readonly RecordedTake[]
  activeId: string | null
  onUse(id: string): void
  onRetry(id: string): void
}

/** SVG path of a take's envelope (the design's wpath): mirrored bars around the centre line. */
function wavePath(shape: readonly number[] | undefined): string {
  const w = shape?.length ? shape : [0]
  const n = Math.max(2, w.length)
  const f = (v: number) => v.toFixed(1)
  const top = w.map((v, i) => `${f((i / (n - 1)) * 100)},${f(10 - Math.max(0.4, v * 9))}`)
  const bot = w.map((v, i) => `${f((i / (n - 1)) * 100)},${f(10 + Math.max(0.4, v * 8))}`).reverse()
  return `M0,10 L${top.join(' L')} L${bot.join(' L')} Z`
}

/** Recorded takes: listen, USE one as the source (re-send when an upload failed). */
export function TakeList({ takes, activeId, onUse, onRetry }: TakeListProps) {
  const [playing, setPlaying] = useState<string | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  useEffect(() => () => audio.current?.pause(), [])
  const listen = (t: RecordedTake) => {
    audio.current?.pause()
    if (playing === t.id) {
      setPlaying(null)
      return
    }
    const url = URL.createObjectURL(t.wav)
    const el = new Audio(url)
    routeToOutput(el)
    audio.current = el
    el.onended = el.onpause = () => {
      setPlaying((p) => (p === t.id ? null : p))
      URL.revokeObjectURL(url)
    }
    void el.play()
    setPlaying(t.id)
  }
  if (takes.length === 0) return <div className={styles.noTakes}>No takes yet. Every take is cut bar-exact at the session tempo.</div>
  return (
    <ol className={styles.takes} aria-label="Takes">
      {takes.map((t) => {
        const active = t.id === activeId
        const status = t.status === 'uploading' ? 'SENDING…' : t.status === 'error' ? 'RETRY' : active ? '✓ IN USE' : 'USE'
        return (
          <li key={t.id} className={styles.take} data-take={t.id} data-active={active || undefined} data-status={t.status}>
            <button
              type="button"
              className={styles.takePlay}
              aria-label={`${playing === t.id ? 'Stop' : 'Play'} ${t.name}`}
              onClick={() => listen(t)}
            >
              {playing === t.id ? '■' : '▶'}
            </button>
            <span className={styles.takeName}>{t.name}</span>
            <svg className={styles.takeWave} viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">
              <path d={wavePath(t.shape)} />
            </svg>
            <span className={styles.takeDur}>{t.durationS.toFixed(2)}s</span>
            <button
              type="button"
              className={styles.use}
              aria-pressed={active && t.status !== 'error'}
              data-status={t.status}
              disabled={t.status === 'uploading'}
              title={t.status === 'error' ? (t.error ?? 'Upload failed') : undefined}
              aria-label={t.status === 'error' ? `Retry sending ${t.name}` : `Use ${t.name}`}
              onClick={() => (t.status === 'error' ? onRetry(t.id) : onUse(t.id))}
            >
              {status}
            </button>
          </li>
        )
      })}
    </ol>
  )
}
