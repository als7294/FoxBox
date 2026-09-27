import { useId } from 'react'
import { formatValue } from '@/lib/scale'
import { useDragValue } from '@/lib/useDragValue'
import styles from './rack.module.css'

export interface KnobProps {
  label: string
  value: number
  min: number
  max: number
  defaultValue: number
  step?: number | null
  unit?: string | null
  scale?: 'lin' | 'log'
  disabled?: boolean
  description?: string | null
  /** Macro driving this param (e.g. "DEPTH"): the knob is locked and shows the macro's name. */
  controlledBy?: string | null
  onChange(value: number): void
  onCommit?(value: number): void
  format?(value: number): string
}

const ARC = 70.69 // 3/4 of the r=15 circle

/** Rack param knob (44px). ARIA slider: arrows (Shift fine), Page, Home/End; drag vertically; double-click resets. */
export function Knob(p: KnobProps) {
  const id = useId()
  const fmt = p.format ?? ((v: number) => formatValue(v, p.unit, p.step))
  const { position, handlers } = useDragValue({
    value: p.value,
    defaultValue: p.defaultValue,
    min: p.min,
    max: p.max,
    step: p.step ?? null,
    scale: p.scale ?? 'lin',
    onChange: p.onChange,
    ...(p.onCommit ? { onCommit: p.onCommit } : {}),
    ...(p.disabled ? { disabled: true } : {}),
  })
  const text = fmt(p.value)
  return (
    <div className={styles.knob} data-disabled={p.disabled || undefined}>
      <div className={styles.paramHead}>
        <span className={styles.paramLabel}>
          {p.label}
        </span>
        <span className={styles.paramValue}>
          {text}
        </span>
      </div>
      <div className={styles.paramRow}>
        <div
          role="slider"
          tabIndex={p.disabled ? -1 : 0}
          aria-label={p.label}
          aria-valuemin={p.min}
          aria-valuemax={p.max}
          aria-valuenow={Number(p.value.toFixed(4))}
          aria-valuetext={text}
          aria-disabled={p.disabled || undefined}
          aria-describedby={p.description ? `${id}-d` : undefined}
          className={styles.knobDial}
          title={p.description ?? undefined}
          {...handlers}
        >
          <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
            <circle cx="22" cy="22" r="15" className={styles.kTrack} strokeDasharray={`${ARC} 200`} transform="rotate(135 22 22)" />
            <circle cx="22" cy="22" r="15" className={styles.kValue} strokeDasharray={`${(ARC * position).toFixed(2)} 200`} transform="rotate(135 22 22)" />
            <circle cx="22" cy="22" r="10" className={styles.kCap} />
            <g style={{ transform: `rotate(${(-135 + 270 * position).toFixed(1)}deg)`, transformOrigin: '22px 22px' }}>
              <rect x="21" y="13" width="2" height="6" className={styles.kMark} />
            </g>
          </svg>
        </div>
        {p.controlledBy && (
          <span className={styles.macroTag} title={`Set by the ${p.controlledBy} macro`}>
            {'◆ '}
            <span>{p.controlledBy}</span>
          </span>
        )}
      </div>
      {p.description && (
        <span id={`${id}-d`} className="sr-only">
          {p.description}
        </span>
      )}
    </div>
  )
}
