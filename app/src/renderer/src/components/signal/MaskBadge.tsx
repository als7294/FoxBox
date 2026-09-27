import { useId, useState } from 'react'
import type { MaskStrength } from '@/api/types'
import styles from './signal.module.css'

const LABEL: Record<MaskStrength['level'], string> = {
  synthetic: 'SYNTHETIC',
  weak: 'WEAK',
  medium: 'MEDIUM',
  strong: 'STRONG',
}
const INDEX: Record<MaskStrength['level'], number> = { synthetic: 0, weak: 1, medium: 2, strong: 3 }

/** MASK STRENGTH with the engine's reasons on hover/focus. An estimate: never claims forensic-grade protection. */
export function MaskBadge({ mask, analysing }: { mask: MaskStrength | null; analysing: boolean }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const level = analysing ? 'ANALYZING' : mask ? LABEL[mask.level] : '—'
  const idx = mask && !analysing ? INDEX[mask.level] : -1
  const reasons = mask?.reasons.length ? mask.reasons : ['Render to measure the mask.']
  return (
    <div
      className={styles.mask}
      tabIndex={0}
      role="group"
      aria-label={`Mask strength ${level}`}
      aria-describedby={id}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span className={styles.kicker}>MASK STRENGTH</span>
      <span className={styles.maskLevel}>{level}</span>
      <div className={styles.segs} data-level={mask?.level} aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} data-on={(idx > 0 && i <= idx) || undefined} />
        ))}
      </div>
      {analysing && <span className={styles.pending}>WAVE READY · MASK WARMING UP</span>}
      <div id={id} role="tooltip" className={styles.tip} hidden={!open}>
        <span className={styles.tipTitle}>WHY {level}</span>
        {reasons.map((r) => (
          <span key={r} className={styles.tipLine}>
            — {r}
          </span>
        ))}
        <span className={styles.tipNote}>An estimate from the engine, not a forensic guarantee.</span>
      </div>
    </div>
  )
}
