import type { ReactNode } from 'react'
import type { BarsChoice, BarsSetting, FitReport } from '@/api/types'
import { f2 } from '@/visuals/canvas'
import styles from './signal.module.css'

export interface FitIndicatorProps {
  /** The last render's fit, or null before the first render. */
  fit: FitReport | null
  bpm: number
  /** The render's bar count, or the Studio setting (possibly AUTO) before the first render. */
  bars: number | BarsSetting | null
  /** The Studio's BARS setting (what was asked for; an 'extended' render grew past it). */
  requested?: BarsSetting | null
  onBars(bars: BarsChoice | null): void
  /** A control at the end of the footer (the Studio puts END there). */
  end?: ReactNode
}

interface View {
  status: FitReport['status'] | 'none'
  icon: string
  state: string
  delta: string
  verdict: string
  chips: { label: string; bars: BarsChoice | null }[]
}

function view(fit: FitReport | null, bars: number | null, requested: BarsSetting | null): View {
  // (bars is the render's resolved count here: AUTO only exists before a render)
  if (!fit) return { status: 'none', icon: '◇', state: 'WAITING', delta: '', verdict: 'Render to measure the speech against the bars.', chips: [] }
  const diff = fit.speech_s - fit.available_s
  const delta = fit.status === 'free' ? '' : `${diff >= 0 ? '+' : '−'}${f2(Math.abs(diff))} s`
  const suggested = (fit.suggested_bars ?? null) as BarsChoice | null
  const chips = suggested && suggested !== bars ? [{ label: `GO ${suggested} BARS`, bars: suggested }] : []
  switch (fit.status) {
    case 'free':
      return { status: 'free', icon: '◇', state: 'FREE', delta, verdict: 'Grid follows the speech length', chips: [] }
    case 'fits': {
      const air = fit.available_s > 0 && fit.speech_s / fit.available_s < 0.9
      return air
        ? { status: 'fits', icon: '▼', state: 'SHORT', delta, verdict: fit.message || `${f2(-diff)} s of air`, chips }
        : { status: 'fits', icon: '✓', state: 'LOCKED', delta, verdict: fit.message || `Sits on ${bars} bars`, chips: [] }
    }
    case 'stretched':
      return {
        status: 'stretched',
        icon: '▲',
        state: `STRETCHED ${f2(fit.stretch_ratio ?? 1)}×`,
        delta,
        verdict: fit.message,
        chips,
      }
    case 'extended': {
      // v0.4: the phrase and its tail didn't fit the requested bars, so the render grew instead of cutting speech.
      const asked = typeof requested === 'number' && requested !== bars ? `${requested} → ` : ''
      return {
        status: 'extended',
        icon: '⇥',
        state: `EXTENDED ${asked}${bars} BARS`,
        delta: '',
        verdict: fit.message || `Grew to ${bars} bars so nothing is cut`,
        chips: bars && bars !== requested ? [{ label: `KEEP ${bars} BARS`, bars: bars as BarsChoice }] : [],
      }
    }
    case 'overflow': // legacy (engines before v0.4 could cut speech)
      return {
        status: 'overflow',
        icon: '!',
        state: 'OVERFLOW',
        delta,
        verdict: fit.message || `Overflows by ${f2(diff)} s`,
        chips: chips.length ? chips : [{ label: 'FREE LENGTH', bars: null }],
      }
  }
}

/** FIT: speech vs the file's bars ("SPEECH 7.20s → 4 BARS @ 140 = 6.86s"), a fill bar, and one-click fixes. */
export function FitIndicator({ fit, bpm, bars: setting, requested = null, onBars, end }: FitIndicatorProps) {
  const auto = setting === 'auto'
  const bars = auto ? null : setting
  const v = view(fit, bars, requested)
  const target = bars ? (bars * 240) / bpm : (fit?.available_s ?? 0)
  const speech = fit?.speech_s ?? 0
  // v0.4: the room kept after the last word for its release and the FX tail (reverb, delay, echoes).
  const tail = Math.max(0, fit?.reserved_tail_s ?? 0)
  // The bar is the time the phrase can use (speech room + its tail): the speech as placed, then the tail ringing.
  const room = fit ? fit.available_s + tail : 0
  const placed = speech * (fit?.stretch_ratio || 1)
  const ratio = fit && fit.available_s > 0 ? speech / fit.available_s : 0
  const fill = room > 0 ? Math.min(placed / room, 1) : 0
  const tailFill = room > 0 ? Math.min(tail / room, 1 - fill) : 0
  const over = fit?.status === 'overflow' ? Math.min(Math.max(0, ratio - 1) * 4, 1) : 0
  const line = fit
    ? `SPEECH ${f2(speech)}s${tail > 0 ? ` + ${f2(tail)}s TAIL` : ''} → ${bars ? `${bars} BARS` : 'FREE'} @ ${Math.round(bpm)} = ${f2(fit.total_s || fit.available_s)}s`
    : auto
      ? `AUTO BARS @ ${Math.round(bpm)}: THE COUNT THAT FITS`
      : `${bars ? `${bars} BARS` : 'FREE'} @ ${Math.round(bpm)} = ${f2(target)}s`
  return (
    <div className={styles.fit} data-status={v.status} role="status" aria-live="polite" aria-label="Fit">
      <div className={styles.fitTop}>
        <span className={styles.kicker}>FIT</span>
        <span className={styles.fitState}>
          <span aria-hidden="true">{v.icon} </span>
          {v.state} {v.delta}
        </span>
        <span className={styles.flex} />
        <span className={styles.fitLine} title={line}>
          {line}
        </span>
      </div>
      <div className={styles.fitBar} aria-hidden="true">
        <div className={styles.fitBox} />
        {bars && bars > 1 && Array.from({ length: bars - 1 }, (_, i) => <span key={i} className={styles.fitTick} style={{ left: `${((i + 1) / bars) * 80}%` }} />)}
        <div className={styles.fitFill} style={{ transform: `scaleX(${fill})` }} />
        {tailFill > 0 && <div className={styles.fitTail} style={{ left: `${fill * 80}%`, width: `${tailFill * 80}%` }} title={`${f2(tail)} s kept for the tail`} />}
        <div className={styles.fitOver} style={{ transform: `scaleX(${over})` }} />
        <div className={styles.fitEnd} />
      </div>
      <div className={styles.fitFoot}>
        {v.chips.length > 0 ? (
          <>
            <span className={styles.kicker}>FIX</span>
            {v.chips.map((c) => (
              <button key={c.label} type="button" className={styles.chip} onClick={() => onBars(c.bars)}>
                {c.label}
              </button>
            ))}
          </>
        ) : (
          <span className={styles.verdict} title={v.verdict}>
            {v.verdict}
          </span>
        )}
        {end && (
          <>
            <span className={styles.flex} />
            {end}
          </>
        )}
      </div>
    </div>
  )
}
