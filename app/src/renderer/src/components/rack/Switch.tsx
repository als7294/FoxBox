import { useId } from 'react'
import styles from './rack.module.css'

export interface SwitchProps {
  label: string
  checked: boolean
  onChange(checked: boolean): void
  disabled?: boolean
  /** Visually hide the label (still announced). */
  hideLabel?: boolean
  /** sm: module bypass (34×18) · md: param (40×20) · lg: settings row (40×22). */
  size?: 'sm' | 'md' | 'lg'
  /** Label on the left, switch on the right, the whole row clickable (SETTINGS). */
  row?: boolean
}

/** On/off pill (role="switch"). The knob's position carries the state, not only its colour. */
export function Switch(p: SwitchProps) {
  const id = useId()
  if (p.row) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={p.checked}
        disabled={p.disabled}
        className={styles.switch}
        data-row
        onClick={() => p.onChange(!p.checked)}
      >
        <span className={p.hideLabel ? 'sr-only' : styles.switchLabel}>{p.label}</span>
        <span className={styles.switchBtn} data-size={p.size ?? 'lg'} data-on={p.checked || undefined} aria-hidden="true" />
      </button>
    )
  }
  return (
    <span className={styles.switch}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={p.checked}
        aria-label={p.label}
        disabled={p.disabled}
        className={styles.switchBtn}
        data-size={p.size ?? 'md'}
        onClick={() => p.onChange(!p.checked)}
      />
      {!p.hideLabel && (
        <label htmlFor={id} className={styles.segLabel}>
          {p.label}
        </label>
      )}
    </span>
  )
}
