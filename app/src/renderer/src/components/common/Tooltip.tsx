import { useId, useState, type ReactElement, type ReactNode } from 'react'
import styles from './common.module.css'

/** Hover/focus tooltip. The trigger gets aria-describedby, so the text is announced too. */
export function Tooltip({ content, children }: { content: ReactNode; children: (describedBy: string) => ReactElement }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  return (
    <span
      className={styles.tooltipWrap}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children(id)}
      <span id={id} role="tooltip" className={styles.tooltip} hidden={!open}>
        {content}
      </span>
    </span>
  )
}
