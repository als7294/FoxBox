import { useRef, type KeyboardEvent } from 'react'
import styles from './rack.module.css'

export interface SegmentedOption<T extends string | number> {
  value: T
  label: string
  title?: string
}

export interface SegmentedProps<T extends string | number> {
  label: string
  value: T | null
  options: readonly SegmentedOption<T>[]
  onChange(value: T): void
  disabled?: boolean
  hideLabel?: boolean
  /** sm: rack params (26px) · md: settings (36px). */
  size?: 'sm' | 'md'
}

/** Radio group rendered as joined buttons (selected = ink fill). Arrow keys move the selection. */
export function Segmented<T extends string | number>(p: SegmentedProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const index = p.options.findIndex((o) => o.value === p.value)
  const onKeyDown = (e: KeyboardEvent) => {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!delta || p.disabled) return
    e.preventDefault()
    e.stopPropagation()
    const next = (Math.max(index, 0) + delta + p.options.length) % p.options.length
    const option = p.options[next]
    if (option) {
      p.onChange(option.value)
      refs.current[next]?.focus()
    }
  }
  return (
    <div className={styles.segWrap} data-size={p.size ?? 'md'}>
      {!p.hideLabel && (
        <span className={styles.segLabel} aria-hidden="true">
          {p.label}
        </span>
      )}
      <div role="radiogroup" aria-label={p.label} className={styles.seg} onKeyDown={onKeyDown}>
        {p.options.map((o, i) => {
          const selected = o.value === p.value
          return (
            <button
              key={String(o.value)}
              ref={(el) => {
                refs.current[i] = el
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected || (index < 0 && i === 0) ? 0 : -1}
              disabled={p.disabled}
              title={o.title ?? o.label}
              className={styles.segBtn}
              onClick={() => p.onChange(o.value)}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
