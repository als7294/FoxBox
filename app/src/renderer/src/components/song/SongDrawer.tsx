import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { formatClock } from '@/audio/grid'
import { audioContext } from '@/audio/player'
import { Knob } from '@/components/rack/Knob'
import { Switch } from '@/components/rack/Switch'
import { scheduleRender } from '@/state/renderController'
import {
  barAt,
  barTime,
  beatDropFromPeaks,
  lastBar,
  songGrid,
  songKey,
  songPlacement,
  songs,
  songShape,
  useSong,
  type SongGrid,
} from '@/state/song'
import { studio, useStudio } from '@/state/studio'
import { toast } from '@/state/toasts'
import { previewHq, previewLocal, previewSpan, type Preview } from './preview'
import { KeyChip, useSongFile } from './SongStrip'
import styles from './song.module.css'

const NUDGE_S = 0.01
const SHAPE_BUCKETS = 600

/** The SONG drawer (over SIGNAL, RACK and OUTPUT, like the rack): grid fixes, the drop on the song, levels, preview. */
export function SongDrawer() {
  const song = useSong((s) => s.song)
  const buffer = useSong((s) => s.buffer)
  const beatDrop = useSong((s) => s.beatDrop)
  const placement = useSong((s) => s.placement)
  const busy = useSong((s) => s.busy)
  const error = useSong((s) => s.error)
  const render = useStudio((s) => s.render)
  const file = useSongFile()
  const grid = songGrid(song)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(false)
  const [hq, setHq] = useState(false)

  useEffect(() => () => preview?.stop(), [preview])
  const stop = () => {
    preview?.stop()
    setPreview(null)
  }

  const togglePreview = async () => {
    if (preview) return stop()
    const s = useSong.getState()
    const r = useStudio.getState().render
    const g = songGrid(s.song)
    const placed = songPlacement(s)
    if (!s.song || !g || !r || !placed) return
    setLoading(true)
    try {
      const p = hq ? await previewHq({ grid: g, placement: placed, render: r }) : await previewLocal({ song: s.song, buffer: s.buffer, grid: g, placement: s.placement, render: r })
      setPreview(p)
      void p.ended.then(() => setPreview((cur) => (cur === p ? null : cur)))
    } catch (err) {
      toast.error('PREVIEW FAILED', { detail: (err as Error).message })
    } finally {
      setLoading(false)
    }
  }

  const useTempoAndKey = () => {
    if (!grid) return
    studio.setBpm(grid.bpm)
    const key = songKey(song)
    if (key) studio.setKey(key)
    scheduleRender()
  }

  const detectedBpm = song?.analysis?.bpm ?? null
  const downbeat = grid?.downbeatS ?? song?.analysis?.downbeat_s ?? 0
  const nudge = (dir: number, big: boolean) => {
    if (!song) return
    const next = Math.max(0, Math.round((downbeat + dir * (big ? 10 : 1) * NUDGE_S) * 1000) / 1000)
    void songs.patch({ downbeat_override_s: next })
  }

  return (
    <div id="song-drawer" role="region" aria-label="Song" className={styles.drawer} onKeyDown={(e) => e.key === 'Escape' && songs.setOpen(false)} {...file.dropProps} data-over={file.over || undefined}>
      <div className={styles.drawerHead}>
        <span className={styles.drawerTitle}>SONG</span>
        <span className={styles.drawerName} title={song?.name}>
          {song?.name ?? (busy ? '' : 'NO SONG')}
        </span>
        {song && (
          <span className={styles.drawerMeta}>
            {formatClock(song.duration_s).replace(/\.\d+$/, '')} · {(song.sample_rate / 1000).toFixed(1)} kHz · {song.channels === 1 ? 'MONO' : 'STEREO'}
          </span>
        )}
        <span className={styles.flex} />
        <button type="button" className={styles.headBtn} onClick={file.choose} disabled={Boolean(busy)}>
          {song ? 'REPLACE' : '♪ IMPORT SONG'}
        </button>
        {song && (
          <button
            type="button"
            className={styles.headBtn}
            onClick={() => {
              stop()
              songs.clear()
            }}
          >
            REMOVE
          </button>
        )}
        <button type="button" className={styles.headBtn} aria-label="Close the song" onClick={() => songs.setOpen(false)}>
          CLOSE ↓
        </button>
      </div>

      <div className={styles.drawerBody}>
        {(busy || error || (song && !grid)) && (
          <p className={styles.note} data-error={error ? true : undefined} role="status">
            {busy ?? (error ? `▲ ${error}` : song?.analysis_state === 'error' ? 'Analysis failed: set the BPM below (bar 1 starts at 0 s).' : 'ANALYSING… tempo, key and bar 1.')}
          </p>
        )}

        {song && (
          <div className={styles.gridRow}>
            <BpmField value={grid?.bpm ?? null} detected={detectedBpm} overridden={song.bpm_override != null} />
            <div className={styles.field}>
              <span className={styles.fieldLabel}>BAR 1</span>
              <div className={styles.nudge}>
                <button type="button" aria-label="Bar 1 earlier" title="10 ms earlier (Shift: 100 ms)" disabled={!grid} onClick={(e) => nudge(-1, e.shiftKey)}>
                  ◀
                </button>
                <span className={styles.nudgeValue}>{grid ? `${downbeat.toFixed(3)} s` : '—'}</span>
                <button type="button" aria-label="Bar 1 later" title="10 ms later (Shift: 100 ms)" disabled={!grid} onClick={(e) => nudge(1, e.shiftKey)}>
                  ▶
                </button>
              </div>
              {song.downbeat_override_s != null && song.analysis && (
                <button type="button" className={styles.linkBtn} onClick={() => void songs.patch({ downbeat_override_s: null })}>
                  RESET
                </button>
              )}
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>KEY</span>
              <KeyChip />
            </div>
            <span className={styles.flex} />
            <button type="button" className={styles.useBtn} disabled={!grid} onClick={useTempoAndKey} title="Set the Studio's BPM and key from the song, and re-render">
              USE SONG TEMPO &amp; KEY
            </button>
          </div>
        )}

        {song && grid && (
          <>
            <Lane grid={grid} dropS={render?.duration_s ?? null} beatDrop={beatDrop} shapeFrom={buffer} preview={preview} />
            <div className={styles.placeRow}>
              <div className={styles.placeBig} aria-live="polite">
                <span className={styles.fieldLabel}>{placement.auto ? 'AUTO · ON THE BEAT DROP' : 'PLACED BY HAND'}</span>
                <span className={styles.bigBar}>DROP AT BAR {placement.atBar}</span>
                <button type="button" className={styles.linkBtn} disabled={placement.auto} onClick={() => songs.autoPlace()}>
                  AUTO
                </button>
              </div>
              <div className={styles.knobs}>
                <Knob label="DUCK" value={placement.duckDb} min={-24} max={0} step={0.5} unit="dB" defaultValue={-6}
                  description="Song level under the drop" onChange={(duckDb) => songs.setPlacement({ duckDb })} />
                <Knob label="SONG" value={placement.songGainDb} min={-24} max={6} step={0.5} unit="dB" defaultValue={0}
                  onChange={(songGainDb) => songs.setPlacement({ songGainDb })} />
                <Knob label="DROP" value={placement.dropGainDb} min={-24} max={6} step={0.5} unit="dB" defaultValue={0}
                  onChange={(dropGainDb) => songs.setPlacement({ dropGainDb })} />
              </div>
              <div className={styles.previewBox}>
                <button
                  type="button"
                  className={styles.previewBtn}
                  data-on={preview ? true : undefined}
                  disabled={!render || loading}
                  title={render ? 'Song + drop, from 4 bars before the drop' : 'Render a drop first'}
                  onClick={() => void togglePreview()}
                >
                  {loading ? (hq ? 'MIXING…' : 'LOADING…') : preview ? '■ STOP' : '▶ PREVIEW'}
                </button>
                <Switch label="HQ" checked={hq} onChange={setHq} size="sm" />
              </div>
            </div>
            {!render && <p className={styles.note}>Render a drop to hear it on the song.</p>}
          </>
        )}
      </div>
      {file.input}
    </div>
  )
}

/** BPM: the song's tempo; typing a different one sets bpm_override (the detected tempo clears it). */
function BpmField({ value, detected, overridden }: { value: number | null; detected: number | null; overridden: boolean }) {
  const shown = value != null ? String(Math.round(value * 100) / 100) : ''
  const [draft, setDraft] = useState(shown)
  useEffect(() => setDraft(shown), [shown])
  const commit = () => {
    const n = Number(draft)
    if (!draft.trim() || !Number.isFinite(n) || n < 40 || n > 250) return setDraft(shown)
    if (String(n) === shown) return
    void songs.patch({ bpm_override: detected != null && Math.abs(n - detected) < 0.005 ? null : n })
  }
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>BPM</span>
      <input
        className={styles.bpmInput}
        type="number"
        inputMode="decimal"
        step={0.01}
        min={40}
        max={250}
        value={draft}
        placeholder="—"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => studio.setTyping(true)}
        onBlur={() => {
          studio.setTyping(false)
          commit()
        }}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {overridden && detected != null && <span className={styles.detected}>detected: {Math.round(detected * 100) / 100}</span>}
    </label>
  )
}

/**
 * The song's waveform (loudness when decoded here, else the engine's peaks) on its bar ruler, the drop as a block that
 * snaps to bars (drag it, click a bar, or arrows / Page keys), the beat drop marked, and the preview's playhead.
 */
function Lane({ grid, dropS, beatDrop, shapeFrom, preview }: { grid: SongGrid; dropS: number | null; beatDrop: number | null; shapeFrom: AudioBuffer | null; preview: Preview | null }) {
  const song = useSong((s) => s.song)!
  const placement = useSong((s) => s.placement)
  const lane = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLDivElement>(null)
  const grab = useRef<number | null>(null)
  const dur = song.duration_s
  const last = lastBar(grid, dur)
  const shape = useMemo(() => {
    if (shapeFrom) return Array.from(songShape(shapeFrom, 0, shapeFrom.duration, SHAPE_BUCKETS))
    const { min, max } = song.peaks
    return max.map((v, i) => (v - (min[i] ?? -v)) / 2)
  }, [shapeFrom, song.peaks])
  const hit = useMemo(() => beatDrop ?? beatDropFromPeaks(song.peaks), [beatDrop, song.peaks])
  const pct = (s: number) => `${(Math.max(0, Math.min(dur, s)) / dur) * 100}%`
  const dropAt = barTime(grid, placement.atBar)
  const dropLen = dropS ?? grid.barS
  const span = previewSpan(grid, placement, dur, dropLen)
  const labelEvery = last > 160 ? 16 : last > 64 ? 8 : 4
  const bars = useMemo(() => Array.from({ length: last }, (_, i) => i + 1), [last])

  // The preview's playhead, on the song's timeline.
  useEffect(() => {
    const el = head.current
    if (!el || !preview) return
    const ac = audioContext()
    let raf = 0
    const tick = () => {
      const t = preview.from + Math.max(0, ac.currentTime - preview.at)
      el.style.left = pct(t)
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [preview])

  const timeAt = (e: PointerEvent) => {
    const r = lane.current!.getBoundingClientRect()
    return ((e.clientX - r.left) / Math.max(1, r.width)) * dur
  }
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const t = timeAt(e)
    const onBlock = t >= dropAt && t <= dropAt + dropLen
    grab.current = onBlock ? t - dropAt : 0
    e.currentTarget.setPointerCapture(e.pointerId)
    songs.setPlacement({ atBar: barAt(grid, t - grab.current) })
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (grab.current == null) return
    const bar = barAt(grid, timeAt(e) - grab.current)
    if (bar !== useSong.getState().placement.atBar) songs.setPlacement({ atBar: bar })
  }
  const onKey = (e: KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1, PageDown: -8, PageUp: 8 }[e.key]
    const to = e.key === 'Home' ? 1 : e.key === 'End' ? last : step != null ? placement.atBar + step * (e.shiftKey ? 4 : 1) : null
    if (to == null) return
    e.preventDefault()
    songs.setPlacement({ atBar: to })
  }

  return (
    <div className={styles.laneWrap}>
      <div className={styles.ruler} aria-hidden="true">
        {bars
          .filter((b) => (b - 1) % labelEvery === 0)
          .map((b) => (
            <span key={b} style={{ left: pct(barTime(grid, b)) }}>
              {b}
            </span>
          ))}
      </div>
      <div
        ref={lane}
        className={styles.lane}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => (grab.current = null)}
        onPointerCancel={() => (grab.current = null)}
      >
        <div className={styles.span} style={{ left: pct(span.from), width: pct(span.to - span.from) }} aria-hidden="true" />
        <svg className={styles.wave} viewBox={`0 0 ${shape.length} 100`} preserveAspectRatio="none" aria-hidden="true">
          {bars.map((b) => {
            const x = ((barTime(grid, b) / dur) * shape.length).toFixed(2)
            return <line key={b} x1={x} x2={x} y1={0} y2={100} className={(b - 1) % labelEvery === 0 ? styles.barMajor : styles.barLine} vectorEffect="non-scaling-stroke" />
          })}
          <path
            className={styles.wavePath}
            d={shape.map((v, i) => `M${i + 0.5} ${(50 - v * 46).toFixed(1)}V${(50 + v * 46).toFixed(1)}`).join('')}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {hit != null && <div className={styles.hit} style={{ left: pct(hit) }} title={`The song's first big beat drop (${formatClock(hit)})`} />}
        <div
          role="slider"
          tabIndex={0}
          aria-label="Drop position"
          aria-valuemin={1}
          aria-valuemax={last}
          aria-valuenow={placement.atBar}
          aria-valuetext={`Drop at bar ${placement.atBar}`}
          className={styles.block}
          data-empty={dropS == null || undefined}
          style={{ left: pct(dropAt), width: `max(8px, ${pct(dropLen)})` }}
          onKeyDown={onKey}
        >
          <span>DROP · {placement.atBar}</span>
        </div>
        {preview && <div ref={head} className={styles.playhead} aria-hidden="true" />}
      </div>
      <p className={styles.legend}>
        DRAG THE DROP ONTO A BAR (OR ← → ON IT) · <b>▼</b> THE SONG&apos;S FIRST BIG BEAT DROP · SHADED: WHAT PREVIEW PLAYS
      </p>
    </div>
  )
}
