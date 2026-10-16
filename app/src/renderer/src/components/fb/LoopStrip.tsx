// 2.1 LOOP's strip (docs/STRINGS_UX.md, "The loop strip"): the loop's 2 bars as note blocks above the dock, the
// playing one lit. A mouse over it opens it into an editor: drag a block (pitch, time) or its right edge (length),
// click an empty spot (an 8th), double-click a block (gone), ⌘Z / ⇧⌘Z, Reset to preset; Tab to a block, ↑↓ ←→ ⇧←→
// Delete. Every edit goes through S2's rules (playActions.editLoop: in key, on the grid, no clashes) and lands on the
// next pass, an outline till then. S2's playFeed.loop (each frame while LOOP plays) sweeps the playhead and sets S3's
// tints (--bright, --register, --space); before it's there, the playhead sits on the playing note.
import type { LoopNote } from '@/audio/play/loopRules'
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { currentInstrument, playActions, usePlay } from '@/components/play/playStore'
import { playFeed } from '@/components/strings/playFeed'
import { t } from '@/i18n'
import s from './loopStrip.module.css'

const STEPS = 32 // 16ths, 2 bars
const HINT_KEY = 'foxbox-loop-strip-hint'

// Undo / redo: the notes before each edit, while the app runs
const undo: LoopNote[][] = []
const redo: LoopNote[][] = []
const latest = (): LoopNote[] => usePlay.getState().loopPending ?? usePlay.getState().loopNotes
function commit(next: LoopNote[]): void {
  undo.push(latest())
  redo.length = 0
  playActions.editLoop(next)
}
function travel(from: LoopNote[][], to: LoopNote[][]): void {
  const back = from.pop()
  if (!back) return
  to.push(latest())
  playActions.editLoop(back)
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const key = (n: LoopNote) => `${n.start}:${n.length}:${n.midi}`
/** The row nearest a note's pitch (rows: the scale's notes in range, low to high). */
const rowOf = (rows: number[], midi: number): number =>
  rows.reduce((best, m, i) => (Math.abs(m - midi) < Math.abs(rows[best]! - midi) ? i : best), 0)

type Drag = { i: number; mode: 'move' | 'size'; x: number; y: number; from: LoopNote; note: LoopNote }

export function LoopStrip() {
  const notes = usePlay((x) => x.loopNotes)
  const pending = usePlay((x) => x.loopPending)
  const loop = usePlay((x) => x.loop)
  const ladder = usePlay((x) => x.ladder)
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState(false)
  const [drag, setDrag] = useState<Drag | null>(null)
  const grid = useRef<HTMLDivElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLSpanElement>(null)
  // S2's loop each frame: S3's tints on the strip, the playhead's sweep over the 2 bars (no React render per frame)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const l = playFeed.loop
      const el = strip.current
      if (!l || !el) return
      el.style.setProperty('--bright', String(l.brightness))
      el.style.setProperty('--register', String(l.register))
      el.style.setProperty('--space', String(l.space))
      if (head.current && l.bars) head.current.style.left = `${(((l.bar ?? 0) + l.phase) / l.bars) * 100}%`
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  const rows = currentInstrument()?.loopRows() ?? ladder.map((n) => n.midi)
  const editing = pending ?? notes // what the next edit starts from: what will land
  const playing = [...notes].sort((a, b) => a.start - b.start)[loop.step] ?? null
  const sounding = new Set(notes.map(key)) // a pending note that already plays isn't outlined: only what changes

  useEffect(() => {
    if (!open || hint) return
    try {
      if (localStorage.getItem(HINT_KEY)) return
      localStorage.setItem(HINT_KEY, '1')
    } catch {
      return
    }
    setHint(true)
    const t = setTimeout(() => setHint(false), 4000)
    return () => clearTimeout(t)
  }, [open, hint])

  const cell = () => {
    const r = grid.current!.getBoundingClientRect()
    return { r, col: r.width / STEPS, row: r.height / Math.max(1, rows.length) }
  }
  const place = (n: LoopNote) => {
    const r = rowOf(rows, n.midi)
    return {
      left: `${(n.start / STEPS) * 100}%`,
      width: `${(n.length / STEPS) * 100}%`,
      top: `${((rows.length - 1 - r) / Math.max(1, rows.length)) * 100}%`,
      height: `${100 / Math.max(1, rows.length)}%`,
    }
  }
  const moved = (d: Drag, e: PointerEvent): LoopNote => {
    const { col, row } = cell()
    const dc = Math.round((e.clientX - d.x) / col)
    const dr = Math.round((d.y - e.clientY) / row)
    if (d.mode === 'size') return { ...d.from, length: clamp(d.from.length + dc, 1, STEPS - d.from.start) }
    const r = clamp(rowOf(rows, d.from.midi) + dr, 0, rows.length - 1)
    return { ...d.from, start: clamp(d.from.start + dc, 0, STEPS - d.from.length), midi: rows[r] ?? d.from.midi }
  }
  const replace = (i: number, n: LoopNote | null) => editing.flatMap((x, j) => (j !== i ? [x] : n ? [n] : []))

  const onBlockKey = (i: number, e: KeyboardEvent) => {
    const n = editing[i]!
    const r = rowOf(rows, n.midi)
    let next: LoopNote | null | undefined
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown')
      next = { ...n, midi: rows[clamp(r + (e.key === 'ArrowUp' ? 1 : -1), 0, rows.length - 1)]! }
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.shiftKey)
      next = { ...n, length: clamp(n.length + (e.key === 'ArrowRight' ? 1 : -1), 1, STEPS - n.start) }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      next = { ...n, start: clamp(n.start + (e.key === 'ArrowRight' ? 1 : -1), 0, STEPS - n.length) }
    else if (e.key === 'Delete' || e.key === 'Backspace') next = null
    else return
    e.preventDefault()
    e.stopPropagation()
    commit(replace(i, next))
  }
  const onKey = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault()
      e.stopPropagation()
      if (e.shiftKey) travel(redo, undo)
      else travel(undo, redo)
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      ;(document.activeElement as HTMLElement | null)?.blur()
      setOpen(false)
    }
  }

  return (
    <div
      ref={strip}
      className={s.strip}
      data-open={open || undefined}
      data-dropped={loop.dropped || undefined}
      role="group"
      aria-label={t('loop.strip.label', 'Loop notes')}
      onPointerEnter={(e) => e.pointerType === 'mouse' && setOpen(true)}
      onPointerLeave={() => !drag && setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOpen(false)}
      onKeyDown={onKey}
    >
      <div
        ref={grid}
        className={s.grid}
        onClick={(e) => {
          if (!open || e.target !== e.currentTarget) return
          const { r, col, row } = cell()
          const start = clamp(Math.floor((e.clientX - r.left) / col), 0, STEPS - 2)
          const at = clamp(rows.length - 1 - Math.floor((e.clientY - r.top) / row), 0, rows.length - 1)
          if (rows[at] != null) commit([...editing, { start, length: 2, midi: rows[at]! }])
        }}
      >
        {open &&
          rows.map((m, i) => (
            <span
              key={m}
              className={s.rowLine}
              style={{ top: `${((rows.length - 1 - i) / rows.length) * 100}%`, height: `${100 / rows.length}%` }}
            />
          ))}
        {open &&
          Array.from({ length: STEPS + 1 }, (_, i) => (
            <span key={i} className={s.colLine} data-beat={i % 4 === 0 || undefined} style={{ left: `${(i / STEPS) * 100}%` }} />
          ))}
        {notes.map((n, i) => (
          <span
            key={`p${i}`}
            className={s.note}
            data-lit={(n === playing && !loop.dropped) || undefined}
            style={place(n)}
            aria-hidden="true"
          />
        ))}
        {(pending ?? notes).map((n, i) => {
          const shown = drag?.i === i ? drag.note : n
          return (
            <button
              key={`e${i}`}
              type="button"
              className={s.edit}
              data-pending={(pending != null && drag?.i !== i && !sounding.has(key(n))) || undefined}
              data-dragging={drag?.i === i || undefined}
              tabIndex={0}
              aria-label={t('loop.strip.note', 'Note {n}', { n: i + 1 })}
              style={place(shown)}
              onPointerDown={(e) => {
                if (!open) return
                e.stopPropagation()
                e.currentTarget.setPointerCapture(e.pointerId)
                const box = e.currentTarget.getBoundingClientRect()
                setDrag({ i, mode: box.right - e.clientX < 10 ? 'size' : 'move', x: e.clientX, y: e.clientY, from: n, note: n })
              }}
              onPointerMove={(e) => drag?.i === i && setDrag({ ...drag, note: moved(drag, e) })}
              onPointerUp={() => {
                if (drag?.i !== i) return
                const d = drag
                setDrag(null)
                if (JSON.stringify(d.note) !== JSON.stringify(d.from)) commit(replace(i, d.note))
              }}
              onDoubleClick={() => open && commit(replace(i, null))}
              onKeyDown={(e) => onBlockKey(i, e)}
            />
          )
        })}
        {playing && (
          <span
            ref={head}
            className={s.playhead}
            style={playFeed.loop?.bars ? undefined : { left: `${(playing.start / STEPS) * 100}%` }}
            aria-hidden="true"
          />
        )}
      </div>
      {open && (
        <div className={s.bar}>
          {hint && <span className={s.hint}>{t('loop.strip.hint', 'Drag the notes. Whatever you do stays in key.')}</span>}
          <button
            type="button"
            className={s.reset}
            onClick={() => {
              undo.length = 0
              redo.length = 0
              playActions.resetLoop()
            }}
          >
            {t('loop.strip.reset', 'Reset to preset')}
          </button>
        </div>
      )}
    </div>
  )
}
