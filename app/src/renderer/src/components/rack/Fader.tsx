import { formatValue } from '@/lib/scale'
import { useDragValue } from '@/lib/useDragValue'
import styles from './rack.module.css'

export interface FaderProps {
  label: string
  value: number
  min: number
  max: number
  defaultValue: number
  step?: number | null
  unit?: string | null
  scale?: 'lin' | 'log'
  disabled?: boolean
  controlledBy?: string | null
  onChange(value: number): void
  onCommit?(value: number): void
}

/** Horizontal rack fader: press to jump, drag 1:1 (Shift fine), same keys as Knob. */
export function Fader(p: FaderProps) {
  const { position, handlers } = useDragValue({
    value: p.value,
    defaultValue: p.defaultValue,
    min: p.min,
    max: p.max,
    step: p.step ?? null,
    scale: p.scale ?? 'lin',
    orientation: 'horizontal',
    absolute: true,
    onChange: p.onChange,
    ...(p.onCommit ? { onCommit: p.onCommit } : {}),
    ...(p.disabled ? { disabled: true } : {}),
  })
  const text = formatValue(p.value, p.unit, p.step)
  return (
    <div className={styles.fader} data-disabled={p.disabled || undefined}>
      <div className={styles.paramHead}>
        <span className={styles.paramLabel}>
          {p.label}
          {p.controlledBy && <span className={styles.macroTag}> ◆ {p.controlledBy}</span>}
        </span>
        <span className={styles.paramValue}>
          {text}
        </span>
      </div>
      <div
        role="slider"
        tabIndex={p.disabled ? -1 : 0}
        aria-label={p.label}
        aria-orientation="horizontal"
        aria-valuemin={p.min}
        aria-valuemax={p.max}
        aria-valuenow={Number(p.value.toFixed(4))}
        aria-valuetext={text}
        aria-disabled={p.disabled || undefined}
        className={styles.faderTrack}
        {...handlers}
      >
        <div className={styles.faderFill} style={{ width: `${position * 100}%` }} />
        <div className={styles.faderThumb} style={{ left: `${position * 100}%` }} />
      </div>
    </div>
  )
}
