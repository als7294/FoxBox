import { useEffect, useRef } from 'react'
import { bridge } from '@/env'
import { useFb } from '@/components/fb/fbStore'
import { UpdateBanner } from '@/components/updates/UpdateBanner'
import { useToasts } from '@/state/toasts'
import { animate } from '@/visuals/motion'
import styles from './feedback.module.css'

/** Under the notch (below the island when it's open, and REMIX's Beat FX badge when it's up): the update, the toast. */
export function NotchStack() {
  const top = (useFb((f) => f.island) ? 184 : 52) + (useFb((f) => f.badge) ? 54 : 0)
  return (
    <div className={styles.notch} style={{ top: `calc(${top}px + var(--island-drop, 0px))` }}>
      <UpdateBanner />
      <Toast />
    </div>
  )
}

/** The toast, a glass pill (2.6 s); detail below; export toasts carry a draggable file. */
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
        { opacity: 0, transform: 'translateY(-8px)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' },
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
          ⠿ Drag the file out
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
