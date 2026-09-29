import { useEffect, useState, type ReactNode } from 'react'

/** A destructive button: the first click arms it, the second does it; blur or a few seconds disarm it. */
export function TwoStep(p: { className?: string; label: ReactNode; armedLabel: string; aria: string; title?: string; onConfirm(): void }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const id = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(id)
  }, [armed])
  return (
    <button
      type="button"
      className={p.className}
      data-armed={armed || undefined}
      aria-label={armed ? `Confirm: ${p.aria.toLowerCase()}` : p.aria}
      title={p.title}
      onClick={() => (armed ? (setArmed(false), p.onConfirm()) : setArmed(true))}
      onBlur={() => setArmed(false)}
    >
      {armed ? p.armedLabel : p.label}
    </button>
  )
}
