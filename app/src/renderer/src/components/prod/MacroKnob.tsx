// PROD's MacroKnob (1.5.2): the 64px knob, its 72px mod ring (the live modulated value from knobLive, in the REACTS TO
// colour, drawn from its own rAF straight into the SVG) and the ReactsTo chip. MiniKnob is the collapsed strip's 30px one.
import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { knobLive, REACTS, type ReactId } from '@/touchdesigner/knobs'
import { reducedMotion } from '@/visuals/motion'
import shared from './prod.module.css'
import s from './play.module.css'

// The knob body's #17171a: --vb-knob is now the 64px size (visuals-td tokens), so it can't be the colour here.
const BODY = '#17171a'
const TRACK = 'M 12.91 51.09 A 27 27 0 1 1 51.09 51.09'

/** The 270° arc from 7:30 for value v (0–1), around (c, c) at radius r; '' at 0. */
export function arc(v: number, c = 32, r = 27): string {
  if (v <= 0.004) return ''
  const a0 = 0.75 * Math.PI
  const p = (a: number) => `${(c + r * Math.cos(a)).toFixed(2)} ${(c + r * Math.sin(a)).toFixed(2)}`
  return `M ${p(a0)} A ${r} ${r} 0 ${v > 2 / 3 ? 1 : 0} 1 ${p(a0 + v * 1.5 * Math.PI)}`
}

export const reactOf = (id: ReactId) => REACTS.find((r) => r.id === id)!

interface Props {
  index: number
  label: string
  value: number
  react: ReactId
  open: boolean
  onChange(v: number): void
  onReset(): void
  onReacts(): void
}

const STEP: Record<string, number> = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05 }

export function MacroKnob({ index, label, value, react, open, onChange, onReset, onReacts }: Props) {
  const ring = useRef<SVGPathElement>(null)
  const live = useRef({ index, react, value })
  live.current = { index, react, value }
  const drag = useRef<{ y: number; v: number } | null>(null)

  // The ring: every frame (4 a second under reduced motion), only touching the DOM when it changed.
  useEffect(() => {
    let raf = 0
    let last = -Infinity
    let d0 = ''
    let o0 = ''
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick)
      if (reducedMotion() && t - last < 250) return
      last = t
      const el = ring.current
      if (!el) return
      const { index, react, value } = live.current
      const env = knobLive.env?.[react] ?? 0
      // Before PROD's feed has run, the knob's own value.
      const d = react === 'off' ? '' : arc(knobLive.env ? (knobLive.values[index] ?? value) : value, 36, 34)
      const o = (0.35 + 0.65 * env).toFixed(2)
      if (d !== d0) el.setAttribute('d', (d0 = d))
      if (o !== o0) el.setAttribute('stroke-opacity', (o0 = o))
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.focus()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { y: e.clientY, v: value }
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) onChange(drag.current.v + (drag.current.y - e.clientY) / 160)
  }
  const up = () => {
    drag.current = null
  }
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = STEP[e.key]
    if (d === undefined) return
    e.preventDefault()
    onChange(value + d)
  }

  const r = reactOf(react)
  const off = react === 'off'
  const pct = Math.round(value * 100)
  const a = ((135 + value * 270) * Math.PI) / 180
  return (
    <div className={`${shared.well} ${s.cell}`} data-open={open}>
      <div
        className={s.knob}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${pct}%`}
        title="Drag up/down · arrows · double-click resets"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
        onDoubleClick={onReset}
      >
        <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="32" r="21" fill={BODY} stroke="rgba(0,0,0,.75)" strokeWidth="1" />
          <circle cx="32" cy="31" r="20" fill="none" stroke="rgba(255,255,255,.06)" strokeWidth="1" />
          <path d={TRACK} fill="none" stroke="rgba(233,229,218,.1)" strokeWidth="3" strokeLinecap="round" />
          <path d={arc(value)} fill="none" stroke="var(--vb-ink)" strokeWidth="3" strokeLinecap="round" />
          <line
            x1="32"
            y1="32"
            x2={(32 + 16 * Math.cos(a)).toFixed(2)}
            y2={(32 + 16 * Math.sin(a)).toFixed(2)}
            stroke="var(--vb-ink)"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </svg>
        <svg className={s.ring} width="72" height="72" viewBox="0 0 72 72" aria-hidden="true">
          <path ref={ring} fill="none" style={{ stroke: r.color }} strokeWidth="3" strokeLinecap="round" />
        </svg>
      </div>
      <span className={s.label}>{label}</span>
      <span className={s.pct}>{pct}</span>
      <button
        type="button"
        className={s.chip}
        data-off={off}
        aria-expanded={open}
        aria-label={`${label} reacts to ${r.label}`}
        onClick={onReacts}
      >
        {off ? <span aria-hidden="true">○</span> : <span className={s.dot} style={{ background: r.color }} aria-hidden="true" />}
        {r.label}
        <span className={s.caret} aria-hidden="true">
          ▾
        </span>
      </button>
    </div>
  )
}

/** The collapsed strip's knob: value arc plus a reacts-to dot. */
export function MiniKnob({ value, react, title }: { value: number; react: ReactId; title: string }) {
  return (
    <span className={s.mini} title={title}>
      <svg width="30" height="30" viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r="20" fill={BODY} />
        <path d={TRACK} fill="none" stroke="rgba(233,229,218,.12)" strokeWidth="6" strokeLinecap="round" />
        <path d={arc(value)} fill="none" stroke="var(--vb-ink)" strokeWidth="6" strokeLinecap="round" />
      </svg>
      <span className={s.miniDot} style={{ background: reactOf(react).color }} />
    </span>
  )
}
