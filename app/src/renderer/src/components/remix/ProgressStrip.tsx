import css from './leds.module.css'

/** The HARDWARE progress strip: `n` LEDs lit up to `value` (0–1), amber while running and ok-green when done. */
export function ProgressStrip({ value, n = 12, done = false, label }: { value: number; n?: number; done?: boolean; label?: string }) {
  const lit = done ? n : Math.round(Math.min(Math.max(value, 0), 1) * n)
  return (
    <span
      className={css.strip}
      data-done={done || undefined}
      role={label ? 'progressbar' : undefined}
      aria-label={label}
      aria-valuenow={label ? Math.round(value * 100) : undefined}
      aria-valuemin={label ? 0 : undefined}
      aria-valuemax={label ? 100 : undefined}
      aria-hidden={label ? undefined : true}
    >
      {Array.from({ length: n }, (_, i) => (
        <span key={i} data-lit={i < lit || undefined} />
      ))}
    </span>
  )
}
