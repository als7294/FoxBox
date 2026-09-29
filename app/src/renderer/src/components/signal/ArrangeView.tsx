import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { ChopMode, ChopSlot } from '@/api/types'
import { Segmented } from '@/components/rack/Segmented'
import { scheduleRender } from '@/state/renderController'
import { isStale, studio, useStudio } from '@/state/studio'
import { geometry } from '@/visuals/draw'
import { renderWords } from '@/visuals/signal'
import { fitView } from './FitIndicator'
import { SnapEndPicker } from './SnapEndPicker'
import styles from './signal.module.css'

const MODES: { value: Exclude<ChopMode, 'custom'>; label: string }[] = [
  { value: 'off', label: 'NATURAL' },
  { value: 'beat', label: 'BEAT' },
  { value: '2beats', label: '2 BEATS' },
  { value: 'bar', label: 'BAR' },
]

/**
 * ARRANGE (v0.8 chop): the line as word blocks on the render's bar/beat grid, like a mini sequencer. The modes put
 * every word on the grid (natural phrasing, each beat, every 2 beats, each bar); dragging a word (or ←/→ on it) pins
 * it to a beat, which switches to custom placement. The blocks show where the engine actually put each word (its
 * word timings), so a slot the engine had to move shows where it landed.
 */
export function ArrangeView() {
  const render = useStudio((s) => s.render)
  const chop = useStudio((s) => s.chop)
  const bars = useStudio((s) => s.bars)
  const stale = useStudio(isStale)
  const lane = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ index: number; beat: number; from: number; x: number } | null>(null)

  const g = geometry(render?.duration_s ?? 0, render?.bpm ?? 140, render ? (render.bars ?? null) : bars === 'auto' ? 4 : bars)
  const beatS = g.barDur / 4
  const beats = Math.max(4, Math.round(g.target / beatS))
  const words = renderWords(render)
  const fit = fitView(render?.fit ?? null, render?.bars ?? null, bars)

  /** Every word's beat as it stands (the engine's landing when chopped, else its natural start). */
  const beatOf = (i: number): number => {
    const landed = render?.chop?.find((c) => c.index === i)
    return landed ? landed.beat : Math.round(words[i]!.t0 / beatS)
  }
  /** The placements with word `index` on `beat`: later words it would run into are pushed along, so order holds. */
  const slotsWith = (index: number, beat: number): ChopSlot[] => {
    let prev = -1
    return words.map((_, i) => {
      const b = i === index ? beat : i > index ? Math.max(beatOf(i), prev + 1) : beatOf(i)
      prev = b
      return { index: i, beat: b }
    })
  }
  const place = (index: number, beat: number) => {
    studio.setChopSlots(slotsWith(index, Math.max(0, Math.min(beats - 1, beat))))
    scheduleRender(0)
  }
  // A drag moves the word by as many beats as the pointer travels (not to wherever the pointer is on the lane).
  const onDown = (block: HTMLElement, pointerId: number, x: number, index: number) => {
    block.setPointerCapture(pointerId)
    setDrag({ index, beat: beatOf(index), from: beatOf(index), x })
  }
  /**
   * The lane picks the word nearest the pointer (inside its block, or within 12 px of it), not the topmost block: short
   * words get room to grab without a hit pad covering their neighbours (UX #6).
   */
  const onLaneDown = (e: PointerEvent<HTMLDivElement>) => {
    let best: { el: HTMLElement; i: number; d: number; c: number } | null = null
    for (const el of e.currentTarget.querySelectorAll<HTMLElement>('[data-word]')) {
      const r = el.getBoundingClientRect()
      const d = e.clientX < r.left ? r.left - e.clientX : e.clientX > r.right ? e.clientX - r.right : 0
      const c = Math.abs(e.clientX - (r.left + r.right) / 2)
      if (d <= 12 && (!best || d < best.d || (d === best.d && c < best.c))) best = { el, i: Number(el.dataset.word), d, c }
    }
    if (!best) return
    e.stopPropagation()
    best.el.focus({ preventScroll: true })
    onDown(best.el, e.pointerId, e.clientX, best.i)
  }
  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag || !lane.current) return
    const perBeat = lane.current.getBoundingClientRect().width / beats
    setDrag({ ...drag, beat: Math.max(0, Math.min(beats - 1, drag.from + Math.round((e.clientX - drag.x) / perBeat))) })
  }
  const onUp = (index: number) => {
    if (drag && drag.beat !== drag.from) place(index, drag.beat)
    setDrag(null)
  }
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!d) return
    e.preventDefault()
    place(index, beatOf(index) + d * (e.shiftKey ? 4 : 1))
  }

  return (
    <div className={styles.arrange} data-testid="arrange">
      <div className={styles.arrangeHead}>
        <span className={styles.kicker}>ARRANGE</span>
        <span className={styles.arrangeModes}>
          <Segmented
            label="Arrange"
            hideLabel
            size="sm"
            value={chop === 'custom' ? ('custom' as never) : chop}
            options={MODES}
            onChange={(mode) => {
              studio.setChop(mode)
              scheduleRender(0)
            }}
          />
        </span>
        {chop === 'custom' && <span className={styles.arrangeCustom}>CUSTOM</span>}
        <div className={styles.flex} />
        <span className={styles.fitChip} data-status={fit.status} title={fit.verdict} data-testid="fit-chip" role="status" aria-label="Fit">
          {fit.icon} <span className={styles.fitLong}>{fit.state}</span>
          <span className={styles.fitShort} aria-hidden="true">
            {fit.short}
          </span>
          {render && (
            <span className="sr-only">
              {' '}
              · {render.bars ? `${render.bars} BAR${render.bars === 1 ? '' : 'S'} @ ${Math.round(render.bpm)}` : 'FREE'} · {fit.verdict}
            </span>
          )}
        </span>
        <SnapEndPicker />
      </div>
      <div
        ref={lane}
        className={styles.lane}
        data-stale={stale || undefined}
        style={{ ['--beats' as string]: beats }}
        onPointerDownCapture={onLaneDown}
      >
        {Array.from({ length: beats }, (_, b) => (
          <span key={b} className={styles.laneBeat} data-bar={b % 4 === 0 || undefined} style={{ left: `${(b / beats) * 100}%` }}>
            {b % 4 === 0 ? b / 4 + 1 : ''}
          </span>
        ))}
        {words.length === 0 && <span className={styles.laneEmpty}>Render a line to arrange its words on the beat.</span>}
        {words.map((w, i) => {
          const at = drag?.index === i ? drag.beat * beatS : w.t0
          // Close words don't overlap: a block ends 1 px before the next word starts (never below 6 px); its start is
          // always the word's real time.
          const next = words.reduce((m, o, j) => (j !== i && o.t0 > at && o.t0 < m ? o.t0 : m), Number.POSITIVE_INFINITY)
          const span = Math.min(w.t1 - w.t0, next - at)
          return (
            <button
              key={i}
              type="button"
              className={styles.block}
              data-throw={w.th || undefined}
              data-drag={drag?.index === i || undefined}
              data-word={i}
              style={{ left: `${(at / g.target) * 100}%`, width: `max(6px, calc(${(span / g.target) * 100}% - 1px))` }}
              title={`${w.w} · beat ${Math.round(w.t0 / beatS) + 1} · drag or ←/→ to move`}
              aria-label={`${w.w}, beat ${Math.round(w.t0 / beatS) + 1}`}
              onPointerMove={onMove}
              onPointerUp={() => onUp(i)}
              onKeyDown={(e) => onKey(e, i)}
            >
              <span className={styles.blockLabel}>{w.w.toUpperCase()}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
