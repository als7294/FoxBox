import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { formatClock } from '@/audio/grid'
import { audioContext } from '@/audio/player'
import { scheduleRender } from '@/state/renderController'
import {
  barAt,
  barTime,
  beatDropFromPeaks,
  lastBar,
  songGrid,
  songKey,
  songs,
  songShape,
  useSong,
  type Placement,
  type SongGrid,
} from '@/state/song'
import { studio, useStudio } from '@/state/studio'
import { toast } from '@/state/toasts'
import { previewLocal, previewSpan, type Preview } from './preview'
import { KeyChip, useSongFile } from './SongStrip'
import styles from './songPanel.module.css'

const SHAPE_BUCKETS = 240

type LevelKey = 'duckDb' | 'songGainDb' | 'dropGainDb'
const LEVELS: { field: LevelKey; label: string; min: number; max: number; def: number; what: string }[] = [
  { field: 'duckDb', label: 'DUCK', min: -24, max: 0, def: -6, what: 'Song level under the drop' },
  { field: 'songGainDb', label: 'SONG', min: -24, max: 6, def: 0, what: 'Song level' },
  { field: 'dropGainDb', label: 'DROP', min: -24, max: 6, def: 0, what: 'Drop level' },
]

/** −6, −6.5, 0, +3: dB the way the strip prints it. */
const fmtDb = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '') + String(Math.abs(Math.round(v * 10) / 10))

/** Under this width the long labels shorten: USE TEMPO & KEY, BAR, ▶ PREVIEW. */
const NARROW_PX = 600

/** TYPE mode: pressing the panel's buttons and sliders leaves the caret in the script (only its own fields take focus). */
const keepFocus = (e: MouseEvent) => {
  if (!(e.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) e.preventDefault()
}

/**
 * SONG (the right half of the strip under SIGNAL): IMPORT SONG (or drop a file on it), then the song on a mini waveform
 * with the drop's bar marked (drag it; it snaps to bars), BPM · KEY and USE SONG TEMPO & KEY, DROP AT BAR, the DUCK · SONG
 * · DROP levels and PREVIEW OVER SONG. Two rows, 96 px; everything is the song store's (state/song.ts).
 */
export function SongPanel() {
  const song = useSong((s) => s.song)
  const busy = useSong((s) => s.busy)
  const error = useSong((s) => s.error)
  const placement = useSong((s) => s.placement)
  const render = useStudio((s) => s.render)
  const file = useSongFile({ open: false })
  const grid = songGrid(song)
  const last = grid && song ? lastBar(grid, song.duration_s) : 1
  const analysing = Boolean(song && !grid && (song.analysis_state === 'queued' || song.analysis_state === 'running'))
  const preview = usePreview()
  const size = useNarrow()
  const ready = Boolean(song && grid && !busy)

  const useTempoAndKey = () => {
    if (!grid) return
    studio.setBpm(grid.bpm)
    const key = songKey(song)
    if (key) studio.setKey(key)
    scheduleRender()
  }

  if (!song && !busy) {
    return (
      <section
        ref={size.ref}
        className={styles.panel}
        aria-label="Song"
        data-empty
        data-over={file.over || undefined}
        onMouseDown={keepFocus}
        {...file.dropProps}
      >
        <span className={styles.kicker}>SONG</span>
        <div className={styles.row}>
          <button type="button" className={styles.importBtn} onClick={file.choose}>
            ♪ IMPORT SONG
          </button>
          <span className={styles.hint} data-error={error ? true : undefined} title={error ?? undefined}>
            {error ? `▲ ${error}` : 'or drop a track here to hear the drop over it'}
          </span>
        </div>
        {file.input}
      </section>
    )
  }

  const status = busy ?? (analysing ? 'ANALYSING…' : error ? `▲ ${error}` : null)
  return (
    <section
      ref={size.ref}
      className={styles.panel}
      aria-label="Song"
      data-narrow={size.narrow || undefined}
      data-over={file.over || undefined}
      onMouseDown={keepFocus}
      {...file.dropProps}
    >
      <div className={styles.row}>
        <span className={styles.kicker}>SONG</span>
        <Clip
          grid={busy ? null : grid}
          placement={placement}
          dropS={render?.duration_s ?? null}
          status={status}
          error={Boolean(error) && !busy && !analysing}
          preview={preview.current}
        />
        {song && !busy && (
          <>
            {analysing ? null : <BpmChip bpm={grid?.bpm ?? null} detected={song.analysis?.bpm ?? null} />}
            <span className={styles.keySlot}>
              <KeyChip up />
            </span>
            <button
              type="button"
              className={styles.btn}
              disabled={!grid}
              onClick={useTempoAndKey}
              title="Set the Studio's BPM and key from the song, and re-render"
            >
              <span>
                USE <span className={styles.wide}>SONG </span>TEMPO &amp; KEY
              </span>
            </button>
          </>
        )}
        <button
          type="button"
          className={styles.remove}
          aria-label="Remove the song"
          title="Remove the song"
          onClick={() => {
            preview.stop()
            songs.clear()
          }}
        >
          ×
        </button>
      </div>

      <div className={styles.row}>
        <span className={styles.kicker}>
          <span className={styles.wide}>DROP AT </span>BAR
        </span>
        <div className={styles.stepper}>
          <button
            type="button"
            aria-label="Drop a bar earlier"
            title="A bar earlier (Shift: 4)"
            disabled={!ready || placement.atBar <= 1}
            onClick={(e) => songs.setPlacement({ atBar: placement.atBar - (e.shiftKey ? 4 : 1) })}
          >
            ‹
          </button>
          <span className={styles.stepValue} aria-label="Drop at bar" aria-live="polite">
            {ready ? placement.atBar : '—'}
          </span>
          <button
            type="button"
            aria-label="Drop a bar later"
            title="A bar later (Shift: 4)"
            disabled={!ready || placement.atBar >= last}
            onClick={(e) => songs.setPlacement({ atBar: placement.atBar + (e.shiftKey ? 4 : 1) })}
          >
            ›
          </button>
        </div>
        {ready && placement.auto ? (
          <span className={styles.autoTag} title="On the song's first big beat drop; follows the render">
            AUTO
          </span>
        ) : (
          <button type="button" className={styles.btn} disabled={!ready} onClick={() => songs.autoPlace()} title="Back on the beat drop">
            AUTO
          </button>
        )}
        <span className={styles.sep} aria-hidden="true" />
        {LEVELS.map((l) => (
          <Level key={l.field} {...l} value={placement[l.field]} disabled={!ready} onChange={(v) => songs.setPlacement({ [l.field]: v })} />
        ))}
        <span className={styles.flex} />
        <button
          type="button"
          className={styles.previewBtn}
          data-on={preview.current ? true : undefined}
          disabled={!ready || !render || preview.loading}
          title={render ? 'The song with the drop, from 4 bars before it' : 'Render a drop first'}
          aria-label={preview.current ? 'Stop the preview' : 'Preview over the song'}
          onClick={() => void preview.toggle()}
        >
          {preview.loading ? (
            'LOADING…'
          ) : preview.current ? (
            '■ STOP'
          ) : (
            <span>
              ▶ PREVIEW<span className={styles.wide}> OVER SONG</span>
            </span>
          )}
        </button>
      </div>
      {file.input}
    </section>
  )
}

/** Whether the panel is under NARROW_PX (a ResizeObserver; container queries would put the key picker in a stacking context). */
function useNarrow() {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setNarrow((e?.contentRect.width ?? NARROW_PX) < NARROW_PX))
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return { ref: setEl, narrow }
}

/** PREVIEW OVER SONG: the drawer's local preview (preview.ts), stopped on unmount and when the song goes. */
function usePreview() {
  const song = useSong((s) => s.song)
  const [current, setCurrent] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => () => current?.stop(), [current])
  useEffect(() => {
    if (!song) setCurrent(null)
  }, [song])
  const stop = () => setCurrent(null)
  const toggle = async () => {
    if (current) return stop()
    const s = useSong.getState()
    const r = useStudio.getState().render
    const g = songGrid(s.song)
    if (!s.song || !g || !r) return
    setLoading(true)
    try {
      const p = await previewLocal({ song: s.song, buffer: s.buffer, grid: g, placement: s.placement, render: r })
      setCurrent(p)
      void p.ended.then(() => setCurrent((cur) => (cur === p ? null : cur)))
    } catch (err) {
      toast.error('PREVIEW FAILED', { detail: (err as Error).message })
    } finally {
      setLoading(false)
    }
  }
  return { current, loading, stop, toggle }
}

/**
 * The song as a mini waveform with its name, the drop as an amber marker at its bar (drag it, or click a spot; it snaps
 * to bars; ← → on it), the beat drop ticked, and while previewing the span it plays and a playhead.
 */
function Clip(p: { grid: SongGrid | null; placement: Placement; dropS: number | null; status: string | null; error: boolean; preview: Preview | null }) {
  const { grid, placement, dropS, status, error, preview } = p
  const song = useSong((s) => s.song)
  const buffer = useSong((s) => s.buffer)
  const beatDrop = useSong((s) => s.beatDrop)
  const lane = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLDivElement>(null)
  const grab = useRef<number | null>(null)
  const dur = song?.duration_s || buffer?.duration || 1
  const last = grid ? lastBar(grid, dur) : 1
  const shape = useMemo(() => {
    if (buffer) return Array.from(songShape(buffer, 0, buffer.duration, SHAPE_BUCKETS))
    const max = song?.peaks.max ?? []
    const min = song?.peaks.min ?? []
    const per = Math.max(1, max.length / SHAPE_BUCKETS)
    const out: number[] = []
    for (let k = 0; k * per < max.length; k++) {
      let top = 0
      const end = Math.min(max.length, Math.floor((k + 1) * per))
      for (let i = Math.floor(k * per); i < end; i++) top = Math.max(top, (max[i]! - (min[i] ?? -max[i]!)) / 2)
      out.push(top)
    }
    return out
  }, [buffer, song?.peaks])
  const hit = useMemo(() => beatDrop ?? (song ? beatDropFromPeaks(song.peaks) : null), [beatDrop, song])
  const pct = (s: number) => `${(Math.max(0, Math.min(dur, s)) / dur) * 100}%`
  const dropAt = grid ? barTime(grid, placement.atBar) : 0
  const dropLen = dropS ?? grid?.barS ?? 0
  const span = grid && preview ? previewSpan(grid, placement, dur, dropLen) : null

  // The preview's playhead, on the song's timeline.
  useEffect(() => {
    const el = head.current
    if (!el || !preview) return
    const ac = audioContext()
    let raf = 0
    const tick = () => {
      el.style.left = pct(preview.from + Math.max(0, ac.currentTime - preview.at))
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
    if (!grid || e.button !== 0) return
    const t = timeAt(e)
    grab.current = t >= dropAt && t <= dropAt + dropLen ? t - dropAt : 0
    e.currentTarget.setPointerCapture(e.pointerId)
    songs.setPlacement({ atBar: barAt(grid, t - grab.current) })
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!grid || grab.current == null) return
    const bar = barAt(grid, timeAt(e) - grab.current)
    if (bar !== useSong.getState().placement.atBar) songs.setPlacement({ atBar: bar })
  }
  const onKey = (e: KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1, PageDown: -8, PageUp: 8 }[e.key]
    const to = e.key === 'Home' ? 1 : e.key === 'End' ? last : step != null ? placement.atBar + step * (e.shiftKey ? 4 : 1) : null
    if (to == null) return
    e.preventDefault()
    e.stopPropagation()
    songs.setPlacement({ atBar: to })
  }

  return (
    <div
      ref={lane}
      className={styles.clip}
      data-live={grid ? true : undefined}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={() => (grab.current = null)}
      onPointerCancel={() => (grab.current = null)}
    >
      {span && <div className={styles.span} style={{ left: pct(span.from), width: pct(span.to - span.from) }} aria-hidden="true" />}
      {shape.length > 0 && (
        <svg className={styles.wave} viewBox={`0 0 ${shape.length} 100`} preserveAspectRatio="none" aria-hidden="true">
          <path
            className={styles.wavePath}
            d={shape.map((v, i) => `M${i + 0.5} ${(50 - v * 44).toFixed(1)}V${(50 + v * 44).toFixed(1)}`).join('')}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      {grid && hit != null && <div className={styles.hit} style={{ left: pct(hit) }} title={`The song's beat drop (${formatClock(hit)})`} />}
      <span className={styles.name} title={song?.name}>
        {song?.name ?? ''}
      </span>
      {status && (
        <span className={styles.status} data-error={error || undefined} title={status}>
          {status}
        </span>
      )}
      {grid && (
        <div
          role="slider"
          tabIndex={0}
          aria-label="Drop position"
          aria-valuemin={1}
          aria-valuemax={last}
          aria-valuenow={placement.atBar}
          aria-valuetext={`Drop at bar ${placement.atBar}`}
          title={`Drop at bar ${placement.atBar}: drag it onto a bar (or ← →)`}
          className={styles.marker}
          style={{ left: pct(dropAt), width: `max(3px, ${pct(dropLen)})` }}
          onKeyDown={onKey}
        />
      )}
      {preview && <div ref={head} className={styles.playhead} aria-hidden="true" />}
    </div>
  )
}

/** BPM: the song's tempo as a chip; click it to type another (bpm_override; the detected tempo clears it). */
function BpmChip({ bpm, detected }: { bpm: number | null; detected: number | null }) {
  const shown = bpm != null ? String(Math.round(bpm * 100) / 100) : ''
  const [draft, setDraft] = useState<string | null>(null)
  const done = () => {
    studio.setTyping(false)
    setDraft(null)
  }
  const commit = () => {
    const n = Number(draft)
    done()
    if (!draft?.trim() || !Number.isFinite(n) || n < 40 || n > 250 || String(n) === shown) return
    void songs.patch({ bpm_override: detected != null && Math.abs(n - detected) < 0.005 ? null : n })
  }
  if (draft != null) {
    return (
      <input
        className={styles.bpmInput}
        aria-label="Song BPM"
        type="number"
        inputMode="decimal"
        step={0.01}
        min={40}
        max={250}
        autoFocus
        value={draft}
        placeholder="BPM"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => {
          studio.setTyping(true)
          e.currentTarget.select()
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') done()
        }}
      />
    )
  }
  return (
    <button
      type="button"
      className={styles.chip}
      data-unset={bpm == null || undefined}
      title={bpm != null ? `The song's tempo${detected != null && Math.abs(bpm - detected) >= 0.005 ? ` (yours; detected ${Math.round(detected * 100) / 100})` : ''}. Click to change it.` : 'No tempo yet. Click to set it (bar 1 at 0 s).'}
      onClick={() => setDraft(shown)}
    >
      {bpm != null ? `${Math.round(bpm * 10) / 10} BPM` : 'SET BPM'}
    </button>
  )
}

/** A level in dB as a small horizontal slider: drag sideways (Shift: fine), ← → (Shift: 3 dB), double-click resets. */
function Level({ label, min, max, def, what, value, disabled, onChange }: (typeof LEVELS)[number] & { value: number; disabled: boolean; onChange(v: number): void }) {
  const drag = useRef<{ x: number; v: number } | null>(null)
  const set = (v: number) => {
    const next = Math.max(min, Math.min(max, Math.round(v * 2) / 2))
    if (next !== value) onChange(next)
  }
  const onKey = (e: KeyboardEvent) => {
    const step = { ArrowLeft: -0.5, ArrowDown: -0.5, ArrowRight: 0.5, ArrowUp: 0.5 }[e.key]
    const to = e.key === 'Home' ? min : e.key === 'End' ? max : e.key === 'Delete' || e.key === 'Backspace' ? def : step != null ? value + step * (e.shiftKey ? 6 : 1) : null
    if (to == null) return
    e.preventDefault()
    e.stopPropagation()
    set(to)
  }
  const zero = ((0 - min) / (max - min)) * 100
  const at = ((value - min) / (max - min)) * 100
  return (
    <div
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={`${label} level`}
      aria-disabled={disabled || undefined}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${fmtDb(value)} dB`}
      className={styles.level}
      title={`${what}: ${fmtDb(value)} dB. Drag sideways or ← →; double-click resets to ${fmtDb(def)} dB.`}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { x: e.clientX, v: value }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (d) set(d.v + ((e.clientX - d.x) / 4) * (e.shiftKey ? 0.25 : 1)) // 4 px a dB
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={() => !disabled && set(def)}
      onKeyDown={disabled ? undefined : onKey}
    >
      <span className={styles.levelK}>{label}</span>
      <span className={styles.levelV}>{fmtDb(value)}</span>
      <span className={styles.levelTrack} aria-hidden="true">
        <span className={styles.levelFill} style={{ left: `${Math.min(zero, at)}%`, width: `${Math.abs(at - zero)}%` }} />
        <span className={styles.levelZero} style={{ left: `${zero}%` }} />
      </span>
    </div>
  )
}
