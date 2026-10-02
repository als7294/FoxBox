import { useEffect, useMemo, useRef, useState } from 'react'
import { audioUrl } from '@/api/client'
import { Button } from '@/components/common/Button'
import { SavedClip } from './SavedClip'
import { Segmented } from '@/components/rack/Segmented'
import { Switch } from '@/components/rack/Switch'
import { barAt, barTime, clampLand, lastBar, planClip, songGrid, useSong, voiceEndOf } from '@/state/song'
import { useStudio } from '@/state/studio'
import { useViewPrefs } from '@/state/viewPrefs'
import { useVisuals } from '@/state/visuals'
import { useSceneText } from '@/visuals/live/sceneText'
import { loadFeatures, type Features } from './features'
import { renderClip, type ClipAspect, type ClipDrop, type RenderedClip } from './render'
import styles from './clips.module.css'

type Range = 'drop' | 'song' | 'bars'
type Status =
  | { kind: 'idle' }
  | { kind: 'rendering'; progress: number }
  | { kind: 'done'; clip: RenderedClip; url: string; aspect: ClipAspect }
  | { kind: 'error'; message: string }

const dbGain = (db: number) => 10 ** (db / 20)
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/**
 * SAVE CLIP (EXPORT panel): a promo video of the song with the VISUALS scene as the picture, rendered offline and
 * faster than real time. The stretch is the drop's clip (the Studio's drop landing where it's placed, over the song:
 * CLIP THE DROP), the whole song, or a range of bars, in the stage's format (its ASPECT), watermark optional. With
 * the song's stems split, each visual layer follows its own stem.
 */
/**
 * `confirm` (1.5.2, VISUALS): asked before a render starts, with the render to run once it's answered (VISUALS asks
 * while a face would show in the clip).
 */
export function SaveClip({ confirm }: { confirm?(render: () => void): void }) {
  const { song, buffer, beatDrop, placement } = useSong()
  const render = useStudio((s) => s.render)
  const bpm = useStudio((s) => s.bpm)
  const scene = useVisuals((s) => s.scene)
  const aspect = useVisuals((s) => s.aspect)
  // The stage's words for TEXT layers (lyrics or the drop script): the stage never saves them into the scene.
  const text = useSceneText()
  const watermark = useViewPrefs((v) => v.clipWatermark)
  const setWatermark = useViewPrefs((v) => v.setClipWatermark)
  const grid = songGrid(song)
  const [range, setRange] = useState<Range>('drop')
  const [withDrop, setWithDrop] = useState(true)
  const [bars, setBars] = useState<[number, number] | null>(null)
  const [drop, setDrop] = useState<{ buffer: AudioBuffer; voiceEnd: number } | null>(null)
  const [features, setFeatures] = useState<Features | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const abort = useRef<AbortController | null>(null)

  // The Studio's drop, decoded, whenever there's a new render.
  useEffect(() => {
    setDrop(null)
    if (!render) return
    let alive = true
    const ac = new OfflineAudioContext(1, 1, 48_000)
    void fetch(audioUrl(render.audio_id))
      .then((r) => r.arrayBuffer())
      .then((bytes) => ac.decodeAudioData(bytes))
      .then((b) => {
        if (!alive) return
        const channels = Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c))
        setDrop({ buffer: b, voiceEnd: voiceEndOf(channels, b.sampleRate) })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [render])

  // The stems' features, asked for whenever the song or its stems state changes (a song without stems is a 404: the
  // clip follows the mix). RENDER asks again, so stems split since are never missed.
  const stemsState = song?.stems_state
  useEffect(() => {
    setFeatures(null)
    if (!song) return
    let alive = true
    void loadFeatures(song.id).then((f) => alive && setFeatures(f))
    return () => {
      alive = false
    }
  }, [song?.id, stemsState])

  // Bars: from the song's grid, around the beat drop by default.
  const maxBar = grid && buffer ? lastBar(grid, buffer.duration) : 1
  useEffect(() => {
    if (!grid || !buffer) return setBars(null)
    const around = beatDrop != null ? barAt(grid, beatDrop) : 1
    const a = Math.max(1, around - 8)
    setBars([a, Math.min(maxBar, a + 15)])
  }, [song?.id, grid?.bpm, grid?.downbeatS, beatDrop != null, maxBar])

  // Where the drop sits in the song (s): where the Studio placed it; without bars, its last word on the beat drop.
  const dropAt = useMemo(() => {
    if (!drop || !buffer) return null
    const land = grid
      ? clampLand(barTime(grid, placement.atBar) + drop.voiceEnd, buffer.duration, drop.voiceEnd)
      : clampLand(beatDrop ?? drop.voiceEnd, buffer.duration, drop.voiceEnd)
    return land - drop.voiceEnd
  }, [drop, buffer, grid, placement.atBar, beatDrop])

  const stretch = useMemo(() => {
    if (!buffer) return null
    if (range === 'drop') {
      if (!drop || dropAt == null) return null
      const plan = planClip({ duration: drop.buffer.duration, voiceEnd: drop.voiceEnd }, buffer.duration, dropAt + drop.voiceEnd)
      return { from: plan.songFrom, length: plan.length }
    }
    if (range === 'bars' && grid && bars) {
      const from = Math.max(0, barTime(grid, bars[0]))
      const to = Math.min(buffer.duration, barTime(grid, bars[1] + 1))
      return to > from ? { from, length: to - from } : null
    }
    return { from: 0, length: buffer.duration }
  }, [buffer, range, drop, dropAt, grid, bars])

  const dropIn = range === 'drop' || withDrop
  const busy = status.kind === 'rendering'
  const url = status.kind === 'done' ? status.url : null
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url])
  useEffect(() => () => abort.current?.abort(), [])

  const start = async () => {
    if (!buffer || !stretch) return
    const ctl = new AbortController()
    abort.current = ctl
    const format = aspect
    setStatus({ kind: 'rendering', progress: 0 })
    const stems = features ?? (await loadFeatures(song!.id))
    if (stems && !features) setFeatures(stems)
    const clipDrop: ClipDrop | null = dropIn && drop && dropAt != null ? { buffer: drop.buffer, at: dropAt, voiceEnd: drop.voiceEnd } : null
    try {
      const clip = await renderClip({
        scene: { ...scene, text },
        aspect: format,
        song: buffer,
        grid,
        beatDrop,
        features: stems,
        drop: clipDrop,
        ...stretch,
        levels: { drop: dbGain(placement.dropGainDb), song: dbGain(placement.songGainDb), duck: dbGain(placement.duckDb) },
        bpm,
        watermark,
        signal: ctl.signal,
        onProgress: (progress) => setStatus({ kind: 'rendering', progress }),
      })
      setStatus({ kind: 'done', clip, url: URL.createObjectURL(clip.blob), aspect: format })
    } catch (e) {
      setStatus(ctl.signal.aborted ? { kind: 'idle' } : { kind: 'error', message: (e as Error).message || 'The clip failed.' })
    } finally {
      if (abort.current === ctl) abort.current = null
    }
  }

  if (!song || !buffer) {
    return (
      <section className={styles.saveClip} aria-label="Save clip">
        <h3 className={styles.heading}>SAVE CLIP</h3>
        <p className={styles.hint}>Pick or drop a song (AUDIO SOURCE → TRACK): the clip is the song with your visuals, and the drop over it.</p>
      </section>
    )
  }
  const bar = (i: 0 | 1, v: number) =>
    setBars((b) => {
      if (!b) return b
      const n = Math.min(maxBar, Math.max(1, Math.round(v) || 1))
      return i === 0 ? [n, Math.max(n, b[1])] : [Math.min(b[0], n), n]
    })
  return (
    <section className={styles.saveClip} aria-label="Save clip">
      <h3 className={styles.heading}>
        SAVE CLIP
        <span
          className={styles.stems}
          data-on={features ? true : undefined}
          title={features ? 'Each visual layer follows its stem' : 'Split the stems in VISUALS for per-stem motion'}
        >
          {features ? 'STEMS' : 'MIX'}
        </span>
      </h3>
      <Segmented<Range>
        label="Stretch"
        hideLabel
        size="sm"
        value={range}
        disabled={busy}
        options={[
          { value: 'drop', label: 'THE DROP', title: 'Your drop landing where it’s placed, over the song' },
          { value: 'song', label: 'WHOLE SONG' },
          ...(grid ? [{ value: 'bars' as const, label: 'BARS' }] : []),
        ]}
        onChange={setRange}
      />
      {range === 'bars' && bars && (
        <div className={styles.bars}>
          <label>
            FROM
            <input type="number" min={1} max={maxBar} value={bars[0]} disabled={busy} onChange={(e) => bar(0, Number(e.target.value))} />
          </label>
          <label>
            TO
            <input type="number" min={1} max={maxBar} value={bars[1]} disabled={busy} onChange={(e) => bar(1, Number(e.target.value))} />
          </label>
        </div>
      )}
      <div className={styles.switches}>
        {range !== 'drop' && (
          <Switch row size="sm" label="WITH THE DROP" checked={withDrop && Boolean(drop)} disabled={busy || !drop} onChange={setWithDrop} />
        )}
        <Switch row size="sm" label="WATERMARK" checked={watermark} disabled={busy} onChange={setWatermark} />
      </div>
      {range === 'drop' && !drop && <p className={styles.hint}>Render the drop in the Studio first.</p>}
      <div className={styles.actions}>
        {busy ? (
          <>
            <div
              className={styles.progress}
              role="progressbar"
              aria-valuenow={Math.round(status.progress * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span style={{ transform: `scaleX(${status.progress})` }} />
            </div>
            <Button size="sm" variant="danger" onClick={() => abort.current?.abort()}>
              CANCEL
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ink"
            disabled={!stretch}
            onClick={() => (confirm ? confirm(() => void start()) : void start())}
            title={`In the stage's format (${aspect}); renders faster than real time, the app stays usable`}
          >
            ● RENDER {stretch ? clock(stretch.length) : ''}
          </Button>
        )}
      </div>
      {status.kind === 'done' && !busy && (
        <>
          <SavedClip blob={status.clip.blob} name={status.clip.name} />
          <video className={styles.preview} data-aspect={status.aspect} src={status.url} controls playsInline />
          <p className={styles.hint}>
            Rendered in {status.clip.seconds.toFixed(1)} s · {status.clip.speed.toFixed(1)}× real time
          </p>
        </>
      )}
      {status.kind === 'error' && <p className={styles.error}>{status.message}</p>}
    </section>
  )
}
