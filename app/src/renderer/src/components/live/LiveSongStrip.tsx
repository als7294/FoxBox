import { useEffect, useRef, useState } from 'react'
import type { SongDeck } from '@/audio/live'
import { Button } from '@/components/common/Button'
import { useSongFile } from '@/components/song/SongStrip'
import { scheduleRender } from '@/state/renderController'
import { beatDropFromPeaks, songGrid, songKey, useSong } from '@/state/song'
import { studio } from '@/state/studio'
import styles from './live.module.css'

/**
 * LIVE's SONG deck strip: the Studio's song (one song across the app), its shape with the drop marked and a playhead,
 * BPM · KEY, and PLAY / CUE DROP / level / DUCK for S2's deck; USE TEMPO & KEY puts the session on the song's grid,
 * so the FX pads land on its bars.
 */
export function LiveSongStrip({
  deck,
  level,
  duck,
  onLevel,
  onDuck,
}: {
  deck: SongDeck | null
  level: number
  duck: boolean
  onLevel(db: number): void
  onDuck(on: boolean): void
}) {
  const { song, beatDrop, busy } = useSong()
  const grid = songGrid(song)
  const key = songKey(song)
  const canvas = useRef<HTMLCanvasElement>(null)
  const file = useSongFile({ open: false })
  const drop = deck?.dropAtS ?? beatDrop ?? (song ? beatDropFromPeaks(song.peaks) : null)
  // PLAY waits for the next bar: `pending` shows it's coming until the deck is actually playing.
  const [pending, setPending] = useState(false)
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!deck) return setPending(false)
    const t = window.setInterval(() => {
      if (deck.isPlaying) setPending(false)
      setTick((n) => n + 1)
    }, 250)
    return () => window.clearInterval(t)
  }, [deck])
  const playing = Boolean(deck?.isPlaying) || pending

  // The song's shape, the drop and (while the deck plays) the playhead.
  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const c = canvas.current
      const ctx = c?.getContext('2d')
      if (!c || !ctx || !song) return
      const dpr = window.devicePixelRatio || 1
      const w = Math.round(c.clientWidth * dpr)
      const h = Math.round(c.clientHeight * dpr)
      if (c.width !== w || c.height !== h) {
        c.width = w
        c.height = h
      }
      const css = getComputedStyle(c)
      ctx.clearRect(0, 0, w, h)
      const max = song.peaks.max
      const n = max.length
      ctx.fillStyle = css.getPropertyValue('--vb-dim') || '#8d8a82'
      for (let x = 0; x < w; x += 2 * dpr) {
        const v = Math.abs(max[Math.floor((x / w) * n)] ?? 0)
        const bh = Math.max(dpr, v * h * 0.9)
        ctx.fillRect(x, (h - bh) / 2, dpr, bh)
      }
      const dur = song.duration_s || 1
      if (drop != null) {
        ctx.fillStyle = css.getPropertyValue('--vb-amber') || '#ffb23e'
        ctx.fillRect(Math.round((drop / dur) * w), 0, 2 * dpr, h)
      }
      if (deck?.isPlaying) {
        ctx.fillStyle = css.getPropertyValue('--vb-accent') || '#ff4b2b'
        ctx.fillRect(Math.round((deck.positionS() / dur) * w), 0, 2 * dpr, h)
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [song, drop, deck])

  const useTempoAndKey = () => {
    if (!grid) return
    studio.setBpm(grid.bpm)
    if (key) studio.setKey(key)
    scheduleRender()
  }

  if (!song) {
    return (
      <section className={styles.songStrip} data-empty aria-label="Song" data-over={file.over || undefined} {...file.dropProps}>
        <span className={styles.cardTitle}>SONG</span>
        <span className={styles.songEmpty} data-error={file.error ? true : undefined}>
          {file.error ?? busy ?? 'Attach a track (or drop one here): the visuals and pads follow it.'}
        </span>
        <Button size="sm" onClick={file.choose} disabled={Boolean(busy)}>
          ♪ PICK A SONG
        </Button>
        {file.input}
      </section>
    )
  }
  const noDeck = !deck
  return (
    <section className={styles.songStrip} aria-label="Song" data-over={file.over || undefined} {...file.dropProps}>
      <div className={styles.songInfo}>
        <span className={styles.songName} title={song.name}>
          ♪ {song.name}
        </span>
        <span className={styles.songMeta}>
          {grid ? `${Math.round(grid.bpm)} BPM` : 'READING…'} · {key ?? 'KEY —'}
        </span>
      </div>
      <canvas ref={canvas} className={styles.songWave} aria-hidden="true" />
      <div className={styles.songControls}>
        <Button
          size="sm"
          variant={playing ? 'danger' : 'secondary'}
          disabled={noDeck}
          onClick={() => {
            if (!deck) return
            if (playing) {
              deck.stop()
              setPending(false)
            } else {
              deck.startQuantized()
              setPending(true)
            }
          }}
          title="Starts on the next bar"
        >
          {playing ? '■ STOP' : '▶ PLAY'}
        </Button>
        <Button
          size="sm"
          disabled={noDeck || drop == null}
          onClick={() => deck?.cueDrop()}
          title="Jump to just before the drop, on the bar"
        >
          CUE DROP
        </Button>
        <label className={styles.songLevel}>
          <span>LVL</span>
          <input
            type="range"
            min={-24}
            max={6}
            step={0.5}
            value={level}
            disabled={noDeck}
            onChange={(e) => onLevel(Number(e.target.value))}
            aria-label="Song level"
          />
        </label>
        <Button
          size="sm"
          variant={duck ? 'amber' : 'secondary'}
          disabled={noDeck}
          onClick={() => onDuck(!duck)}
          title="Duck the song while you talk"
        >
          DUCK
        </Button>
        <Button size="sm" disabled={!grid} onClick={useTempoAndKey} title="Set the session's BPM and key to the song's">
          USE TEMPO & KEY
        </Button>
        <button type="button" className={styles.songSwap} onClick={file.choose} title="Pick another song (or drop one here)">
          ⇄
        </button>
      </div>
      {file.error && (
        <span className={styles.songEmpty} data-error>
          {file.error}
        </span>
      )}
      {file.input}
    </section>
  )
}
