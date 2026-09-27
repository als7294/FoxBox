import { useId, useState } from 'react'
import type { MacroSpec } from '@/api/types'
import type { MacroTargetView } from '@/lib/macros'
import { formatValue, toPosition } from '@/lib/scale'
import { useDragValue } from '@/lib/useDragValue'
import styles from './rack.module.css'

export interface MacroKnobProps {
  spec: MacroSpec
  value: number
  /** The preset's own position (double-click returns here). */
  presetValue: number
  targets: MacroTargetView[]
  onChange(value: number): void
  onCommit(value: number): void
  /** Double-click: return to the preset's value (tweened by the caller). */
  onReset(value: number): void
}

const MAIN = 207.35 // 3/4 of the r=44 ring
const RING = [254.47, 278.03, 301.59] // 3/4 of the r=54/59/64 map rings

/**
 * One of the four hero knobs. The outer amber rings are the params this macro drives in the current preset
 * (from its macro_map), each filled to where that param now sits in its own range; the rows below list them.
 */
export function MacroKnob({ spec, value, presetValue, targets, onChange, onCommit, onReset }: MacroKnobProps) {
  const [focused, setFocused] = useState(false)
  const id = useId()
  const { active, handlers } = useDragValue({
    value,
    defaultValue: presetValue,
    min: 0,
    max: 1,
    step: null,
    onChange,
    onCommit,
  })
  const pct = String(Math.round(value * 100)).padStart(2, '0')
  const rings = targets.slice(0, 3).map((t) => {
    const p = t.param
    return p ? toPosition(t.value, { min: p.min ?? 0, max: p.max ?? 1, scale: p.scale ?? 'lin' }) : value
  })
  const label = (t: MacroTargetView) => (t.param?.label ?? t.target.param).toUpperCase()
  const dupes = new Set(targets.map(label).filter((l, i, all) => all.indexOf(l) !== i))
  return (
    <div className={styles.macro} data-macro={spec.id}>
      <span className={styles.macroLabel} aria-hidden="true">
        {spec.label}
      </span>
      <div
        role="slider"
        tabIndex={0}
        aria-label={spec.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value * 100)}
        aria-valuetext={`${spec.label} ${Math.round(value * 100)} percent`}
        aria-describedby={spec.description ? `${id}-d` : undefined}
        className={styles.macroDial}
        {...handlers}
        onDoubleClick={() => onReset(presetValue)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        <svg viewBox="0 0 150 150" aria-hidden="true">
          {rings.map((am, i) => (
            <g key={i}>
              <circle cx="75" cy="75" r={54 + i * 5} className={styles.ringTrack} strokeDasharray={`${RING[i]} 600`} transform="rotate(135 75 75)" />
              <circle
                cx="75"
                cy="75"
                r={54 + i * 5}
                className={styles.ringMap}
                strokeOpacity={Math.max(0.15, 0.35 - i * 0.08 + am * 0.5)}
                strokeDasharray={`${(RING[i]! * am).toFixed(2)} 600`}
                transform="rotate(135 75 75)"
              />
            </g>
          ))}
          <circle cx="75" cy="75" r="44" className={styles.macroTrack} strokeDasharray={`${MAIN} 600`} transform="rotate(135 75 75)" />
          <circle cx="75" cy="75" r="44" className={styles.macroValue} strokeDasharray={`${(MAIN * value).toFixed(2)} 600`} transform="rotate(135 75 75)" />
          <circle cx="75" cy="75" r="44" className={styles.macroTicks} strokeDasharray="1.4 3.6" transform="rotate(135 75 75)" />
          <rect x="74" y="24" width="2" height="6" className={styles.macroMark} opacity=".6" />
          <circle cx="75" cy="75" r="33" className={styles.macroCap} />
          <g style={{ transform: `rotate(${(-135 + 270 * value).toFixed(1)}deg)`, transformOrigin: '75px 75px' }}>
            <rect x="74" y="45" width="2" height="11" className={styles.macroMark} />
          </g>
        </svg>
        <div className={styles.macroPct} aria-hidden="true">
          {pct}
        </div>
        {(active || focused) && (
          <div className={styles.macroTip} role="tooltip">
            {spec.label} {pct} · SHIFT FINE · DBL-CLICK = PRESET
          </div>
        )}
      </div>
      {spec.description && (
        <span id={`${id}-d`} className="sr-only">
          {spec.description}
        </span>
      )}
      <ul className={styles.macroMaps} aria-label={`${spec.label} drives`} title={targets.map((t) => `${t.module?.label ?? t.target.module} ${label(t)}`).join(' · ')}>
        {targets.length === 0 && (
          <li>
            <span>NO MAPPED PARAMS</span>
            <span />
          </li>
        )}
        {targets.slice(0, 3).map((t) => (
          <li key={`${t.target.module}.${t.target.param}`}>
            <span>{dupes.has(label(t)) ? `${(t.module?.label ?? t.target.module).slice(0, 4)} ${label(t)}` : label(t)}</span>
            <span>{formatValue(t.value, t.param?.unit, t.param?.step)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
