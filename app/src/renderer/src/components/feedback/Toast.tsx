import { useEffect, useRef } from 'react'
import { bridge } from '@/env'
import { useToasts } from '@/state/toasts'
import { animate } from '@/visuals/motion'
import styles from './feedback.module.css'

/** Bottom-right toast: title in the display face, detail below; export toasts carry a draggable file. */
export function Toast() {
  const items = useToasts((s) => s.items)
  const dismiss = useToasts((s) => s.dismiss)
  const t = items[items.length - 1]
  const ref = useRef<HTMLDivElement>(null)
  const b = bridge()
  useEffect(() => {
    if (!t) return
    animate(
      ref.current,
      [
        { opacity: 0, transform: 'translateY(14px)', clipPath: 'inset(0 0 100% 0)' },
        { opacity: 1, offset: 0.5 },
        { opacity: 0.4, offset: 0.6 },
        { opacity: 1, transform: 'none', clipPath: 'inset(0 0 0 0)' },
      ],
      { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' },
    )
  }, [t?.id])
  if (!t) return null
  return (
    <div ref={ref} className={styles.toast} data-tone={t.tone} role={t.tone === 'error' ? 'alert' : 'status'} aria-live="polite">
      <div className={styles.toastHead}>
        <span className={styles.toastTitle}>{t.message}</span>
        <button type="button" className={styles.toastClose} aria-label="Dismiss" onClick={() => dismiss(t.id)}>
          ×
        </button>
      </div>
      {t.detail && <span className={styles.toastBody}>{t.detail}</span>}
      {t.dragPath && b && (
        <div
          className={styles.toastDrag}
          draggable
          onDragStart={(e) => {
            e.preventDefault()
            b.startDrag(t.dragPath!)
          }}
        >
          ⠿ DRAG THE FILE OUT
        </div>
      )}
      {t.actions && t.actions.length > 0 && (
        <div className={styles.toastActions}>
          {t.actions.map((a) => (
            <button key={a.label} type="button" onClick={a.run}>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
