import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/common/Button'
import { SavedClip } from '@/components/clips/SavedClip'
import clips from '@/components/clips/clips.module.css'
import { startLiveCapture, type LiveCapture } from '@/components/clips/liveCapture'
import type { ClipAspect } from '@/components/clips/render'
import { Segmented } from '@/components/rack/Segmented'
import type { SongDeck } from '@/audio/live/songDeck'
import { toast } from '@/state/toasts'
import { useViewPrefs } from '@/state/viewPrefs'
import { getClipAudio } from './page'
import styles from './visuals.module.css'

/** THE DROP: the song cued this many bars before its drop, filmed for this many bars in all. */
const DROP_LEAD_BARS = 4
const DROP_BARS = 12
/** Without a beat grid: the drop's length in seconds. */
const DROP_FALLBACK_S = 20

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/**
 * EXPORT → REC LIVE: films the stage as it plays (S1's live capture), with the active AUDIO SOURCE's sound
 * (getClipAudio: the masked output or the live input, never the dry mic), then saved like SAVE CLIP. On TRACK,
 * THE DROP cues the song a few bars before its drop, plays it and stops by itself after the drop (with the CAMERA
 * base, that's you filmed through the drop).
 */
export function LiveRecord({
  stage,
  audioReady,
  deck,
}: {
  stage: () => HTMLCanvasElement | null
  audioReady: boolean
  /** The TRACK deck, for THE DROP; null on the other sources. */
  deck: SongDeck | null
}) {
  const [range, setRange] = useState<'free' | 'drop'>('free')
  const timer = useRef<number | null>(null)
  const watermark = useViewPrefs((v) => v.clipWatermark)
  const [aspect, setAspect] = useState<ClipAspect>('16:9')
  const [t0, setT0] = useState<number | null>(null)
  const [now, setNow] = useState(0)
  const [clip, setClip] = useState<{ blob: Blob; name: string; seconds: number } | null>(null)
  const cap = useRef<LiveCapture | null>(null)

  useEffect(
    () => () => {
      cap.current?.cancel()
      if (timer.current != null) window.clearTimeout(timer.current)
    },
    [],
  )
  const dropMode = range === 'drop' && deck?.song != null
  useEffect(() => {
    if (t0 == null) return
    const t = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(t)
  }, [t0])
  // The source went away mid-take (audio stopped, another source): keep what was filmed.
  useEffect(() => {
    if (!audioReady && cap.current) void stop()
    // stop() only reads refs and setters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioReady])

  const start = () => {
    const canvas = stage()
    const sound = getClipAudio()
    if (!canvas || !sound) return
    try {
      if (dropMode && deck) {
        deck.stop()
        deck.cueDrop(DROP_LEAD_BARS)
        deck.play()
        const seconds = deck.grid ? DROP_BARS * deck.grid.barS : DROP_FALLBACK_S
        timer.current = window.setTimeout(() => void stop(), seconds * 1000)
      }
      cap.current = startLiveCapture(canvas, sound, { aspect, watermark })
      setClip(null)
      setT0(Date.now())
      setNow(Date.now())
    } catch (e) {
      toast.error('NOT RECORDING', { detail: (e as Error).message })
    }
  }
  const stop = async () => {
    if (timer.current != null) window.clearTimeout(timer.current)
    timer.current = null
    const c = cap.current
    cap.current = null
    setT0(null)
    if (!c) return
    try {
      const out = await c.stop()
      setClip({ blob: out.blob, name: out.name, seconds: out.seconds })
    } catch (e) {
      toast.error('CLIP NOT SAVED', { detail: (e as Error).message })
    }
  }
  const cancel = () => {
    if (timer.current != null) window.clearTimeout(timer.current)
    timer.current = null
    cap.current?.cancel()
    cap.current = null
    setT0(null)
  }

  const recording = t0 != null
  return (
    <section className={`${clips.saveClip} ${styles.divided}`} aria-label="Record live" data-testid="visuals-live-rec">
      <h3 className={clips.heading}>REC LIVE</h3>
      {deck?.song && (
        <Segmented<'free' | 'drop'>
          label="Live range"
          hideLabel
          size="sm"
          value={range}
          disabled={recording}
          options={[
            { value: 'free', label: 'FREE', title: 'Record until you stop' },
            {
              value: 'drop',
              label: 'THE DROP',
              title: `Plays the song from ${DROP_LEAD_BARS} bars before its drop and stops after ${DROP_BARS} bars`,
            },
          ]}
          onChange={setRange}
        />
      )}
      <Segmented<ClipAspect>
        label="Live format"
        hideLabel
        size="sm"
        value={aspect}
        disabled={recording}
        options={[
          { value: '9:16', label: '9:16', title: 'Reels, TikTok, Shorts' },
          { value: '16:9', label: '16:9', title: 'YouTube, projectors' },
          { value: '1:1', label: '1:1', title: 'Square posts' },
        ]}
        onChange={setAspect}
      />
      <div className={clips.actions}>
        {recording ? (
          <>
            <Button size="sm" variant="danger" onClick={() => void stop()}>
              ■ STOP · {clock((now - t0) / 1000)}
            </Button>
            <Button size="sm" variant="ghost" onClick={cancel}>
              CANCEL
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={!audioReady}
            onClick={start}
            title={audioReady ? 'Film the stage as it plays, with the sound' : 'Start the audio source first (GO LIVE, START AUDIO or LISTEN)'}
          >
            {dropMode ? '● REC THE DROP' : '● REC'}
          </Button>
        )}
      </div>
      {clip && !recording && (
        <>
          <SavedClip blob={clip.blob} name={clip.name} />
          <p className={styles.kicker}>{clock(clip.seconds)}</p>
        </>
      )}
    </section>
  )
}
