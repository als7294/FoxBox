import { useEffect, useRef, useState, type DragEvent } from 'react'
import { useSongFile } from '@/components/song/SongStrip'
import { useLiveAudio } from '@/state/liveAudio'
import { useLiveDeck } from '@/state/liveDeck'
import { useSong } from '@/state/song'
import { useStrings } from '@/components/strings/stringsStore'
import { knobLive } from '@/touchdesigner/knobs'
import { useOutputOwner } from '@/visuals/live/output'
import { clock, playTestBeat, playTrack, request, stopOutput, stopRecording, useOutputOpen, useProdRec, useStringsFaceVisible } from './prodActions'
import { SectionTimeline } from './SectionTimeline'
import styles from './strip.module.css'

const METERS = [
  ['K', 'kick'],
  ['S', 'snare'],
  ['B', 'bass'],
  ['D', 'drop'],
] as const
/**
 * LOAD TRACK on STRINGS (1.5.5, the user: not only in VISUALS): a song file (picked, or dropped on the music block)
 * straight to the TRACK deck; VISUALS goes to TRACK once it's in (not before: a cancelled pick changes nothing mid-set).
 */
export function useLoadTrack() {
  const file = useSongFile({ open: false, hold: () => Boolean(useLiveDeck.getState().deck?.isPlaying) })
  const asked = useRef(false)
  const song = useSong((s) => s.song)
  useEffect(() => {
    if (!song || !asked.current) return
    asked.current = false
    useLiveAudio.getState().setSource('track')
  }, [song])
  return {
    ...file,
    choose: () => {
      asked.current = true
      file.choose()
    },
    dropProps: {
      ...file.dropProps,
      onDrop: (e: DragEvent) => {
        asked.current = true
        file.dropProps.onDrop(e)
      },
    },
  }
}


/** The music block's canvases: the section map with its playhead, and the four 8-LED meters, in one rAF. */
function useStripCanvases(meters: React.RefObject<(HTMLCanvasElement | null)[]>) {
  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0
    let last = 0
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      if (document.hidden || now - last < (reduced ? 250 : 33)) return
      last = now
      meters.current.forEach((c, i) => {
        const g = c?.getContext('2d')
        if (!c || !g) return
        const w = (c.width = c.clientWidth * devicePixelRatio)
        const h = (c.height = c.clientHeight * devicePixelRatio)
        const v = knobLive.env?.[METERS[i]![1]] ?? 0
        const lit = Math.round(Math.min(1, v) * 8)
        const lw = w / 8
        for (let k = 0; k < 8; k++) {
          g.fillStyle = k < lit ? (k >= 6 ? '#ff4b2b' : k >= 4 ? '#ffb23e' : '#7fd08a') : 'rgba(233,229,218,.08)'
          g.fillRect(k * lw, 0, lw - devicePixelRatio, h)
        }
      })
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [meters])
}

/**
 * PROD's bottom strip (70px): the music block (▶/❚❚, the track, its section and what's next, the section map, the
 * K/S/B/D meters), then RECORD A CLIP and SEND TO OUTPUT (1.5.2-1.5.4, TouchDesigner: SEND TO VISUALS too). Each commit asks first while the face is
 * visible (prodActions); stopping the output takes two steps.
 */
export function ProdStrip() {
  const song = useSong((s) => s.song)
  const busy = useSong((s) => s.busy)
  const load = useLoadTrack()
  const deck = useLiveDeck((d) => d.deck)
  const face = useStringsFaceVisible()
  // The camera's state in words: ▲ visible / ● hidden / ○ none (blocked or off: no face in the picture at all)
  const camOn = useStrings((t) => t.camera === 'asking' || t.camera === 'opening' || t.camera === 'live')
  const faceTone = !camOn ? 'none' : face ? 'visible' : 'hidden'
  const faceWord = !camOn ? '○ NO CAMERA' : face ? '▲ FACE VISIBLE' : '● FACE HIDDEN'
  const rec = useProdRec()
  const owned = useOutputOwner((o) => o.owner === 'prod')
  const open = useOutputOpen((o) => o.open)
  const onOutput = owned && open
  const [stopAsk, setStopAsk] = useState(false)
  const [, tick] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 250)
    return () => window.clearInterval(t)
  }, [])
  useEffect(() => {
    if (!stopAsk) return
    const t = window.setTimeout(() => setStopAsk(false), 3000)
    return () => window.clearTimeout(t)
  }, [stopAsk])
  const meters = useRef<(HTMLCanvasElement | null)[]>([])
  useStripCanvases(meters)

  const playing = Boolean(deck?.isPlaying)
  const testing = !song && Boolean(deck) // STRINGS' TEST BEAT
  const play = () => (playing ? deck?.stop() : testing ? playTestBeat() : !song ? load.choose() : playTrack())
  const bpm = song?.bpm_override ?? song?.analysis?.bpm
  const key = song?.key_override ?? song?.analysis?.key

  return (
    <footer className={styles.strip}>
      <div className={styles.music} aria-label="Music" data-over={load.over || undefined} {...load.dropProps}>
        {load.input}
        <button type="button" className={styles.play} aria-label={playing ? 'Pause the track' : 'Play the track'} onClick={play}>
          {playing ? '❚❚' : '▶'}
        </button>
        <div className={styles.track}>
          <span className={styles.title}>{song?.name ?? (testing ? 'TEST BEAT' : 'NO TRACK')}</span>
          <span className={styles.meta}>
            {busy ??
              load.error ??
              (song ? ['TRACK', bpm ? `${Math.round(bpm)} BPM` : null, key].filter(Boolean).join(' · ') : testing ? '120 BPM · stretch the strings' : 'Drop a song here, or LOAD')}
          </span>
        </div>
        <button
          type="button"
          className={styles.load}
          disabled={playing || Boolean(busy)}
          title={playing ? 'Stop the track to change it' : 'Pick a song file: WAV, AIFF, FLAC, MP3 or M4A'}
          onClick={load.choose}
        >
          {song ? 'CHANGE…' : 'LOAD TRACK…'}
        </button>
        <SectionTimeline />
        <div className={styles.meters} aria-label="What the music is doing">
          {METERS.map(([label], i) => (
            <div key={label} className={styles.meter}>
              <span className={styles.meterLabel}>{label}</span>
              <canvas ref={(c) => void (meters.current[i] = c)} className={styles.meterCanvas} aria-hidden="true" />
            </div>
          ))}
        </div>
      </div>

      <button
        type="button"
        className={styles.rec}
        data-on={rec.t0 != null || undefined}
        onClick={() => (rec.t0 != null ? void stopRecording() : request('rec'))}
      >
        <span className={styles.big}>
          <span className={styles.recDot} aria-hidden="true" />
          {rec.t0 != null ? `STOP · ${clock((performance.now() - rec.t0) / 1000)}` : 'RECORD A CLIP'}
        </span>
        <span className={styles.sub} data-face={faceTone}>
          {camOn ? faceWord : '○ NO CAMERA IN CLIP'}
        </span>
      </button>

      <button
        type="button"
        className={styles.out}
        data-face={faceTone}
        data-live={onOutput || undefined}
        onClick={() => {
          if (!onOutput) return request('out')
          if (!stopAsk) return setStopAsk(true)
          setStopAsk(false)
          stopOutput()
        }}
      >
        <span className={styles.big}>{onOutput ? (stopAsk ? 'STOP OUTPUT?' : '● ON OUTPUT') : 'SEND TO OUTPUT'}</span>
        <span className={styles.sub}>{onOutput ? `${faceWord} · CLICK TO STOP` : faceWord}</span>
      </button>
    </footer>
  )
}
