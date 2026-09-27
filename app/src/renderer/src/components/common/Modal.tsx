import { useEffect, useRef, type ReactNode } from 'react'
import styles from './common.module.css'

export interface ModalProps {
  title: string
  open: boolean
  onClose(): void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}

/** Native <dialog> (focus trap, Esc to close, inert background). */
export function Modal({ title, open, onClose, children, footer, wide }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className={styles.modal}
      data-wide={wide || undefined}
      aria-labelledby="modal-title"
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      {open && (
        <>
          <header className={styles.modalHeader}>
            <h2 id="modal-title">{title}</h2>
            <button type="button" className={styles.iconButton} aria-label="Close" onClick={onClose}>
              ×
            </button>
          </header>
          <div className={styles.modalBody}>{children}</div>
          {footer && <footer className={styles.modalFooter}>{footer}</footer>}
        </>
      )}
    </dialog>
  )
}
