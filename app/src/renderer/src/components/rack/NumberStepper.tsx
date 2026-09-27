import { formatValue, quantize } from '@/lib/scale'
import { useDragValue } from '@/lib/useDragValue'
import styles from './rack.module.css'

export interface NumberStepperProps {
  label: string
  value: number
  min: number
  max: number
  defaultValue: number
  step?: number | null
  unit?: string | null
  disabled?: boolean
  onChange(value: number): void
  onCommit?(value: number): void
}

/** The design's "− value +" number param. The value is a spinbutton: arrows, drag, wheel. */
export function NumberStepper(p: NumberStepperProps) {
  const step = p.step ?? 1
  const range = { min: p.min, max: p.max, step }
  const { handlers } = useDragValue({
    value: p.value,
    defaultValue: p.defaultValue,
    ...range,
    travel: 140,
    onChange: p.onChange,
    ...(p.onCommit ? { onCommit: p.onCommit } : {}),
    ...(p.disabled ? { disabled: true } : {}),
  })
  const text = formatValue(p.value, p.unit, step)
  const bump = (dir: 1 | -1) => {
    const v = quantize(p.value + dir * step, range)
    if (v === p.value) return
    p.onChange(v)
    p.onCommit?.(v)
  }
  return (
    <div className={styles.fader}>
      <div className={styles.paramHead}>
        <span className={styles.paramLabel}>
          {p.label}
        </span>
      </div>
      <div className={styles.stepper}>
        <button type="button" className={styles.stepBtn} aria-label={`Decrease ${p.label}`} tabIndex={-1} disabled={p.disabled || p.value <= p.min} onClick={() => bump(-1)}>
          −
        </button>
        <span
          role="spinbutton"
          tabIndex={p.disabled ? -1 : 0}
          aria-label={p.label}
          aria-valuemin={p.min}
          aria-valuemax={p.max}
          aria-valuenow={p.value}
          aria-valuetext={text}
          aria-disabled={p.disabled || undefined}
          className={styles.stepValue}
          {...handlers}
        >
          {text}
        </span>
        <button type="button" className={styles.stepBtn} aria-label={`Increase ${p.label}`} tabIndex={-1} disabled={p.disabled || p.value >= p.max} onClick={() => bump(1)}>
          +
        </button>
      </div>
    </div>
  )
}
