import type { Side } from '@/audio/player'
import styles from './signal.module.css'

/** Dry/wet A/B (\ key). Both sides play in lockstep; switching is instant. */
export function ABToggle({ side, onSide, disabled }: { side: Side; onSide(side: Side): void; disabled?: boolean }) {
  return (
    <div role="group" aria-label="A/B" aria-keyshortcuts="\" className={styles.ab} title="A/B dry · wet (\)">
      <button type="button" aria-pressed={side === 'dry'} disabled={disabled} onClick={() => onSide('dry')}>
        A DRY
      </button>
      <button type="button" aria-pressed={side === 'wet'} disabled={disabled} onClick={() => onSide('wet')}>
        B WET
      </button>
    </div>
  )
}
