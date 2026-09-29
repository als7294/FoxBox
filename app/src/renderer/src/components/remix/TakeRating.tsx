import { useEffect, useState } from 'react'
import { isTextTarget } from '@/lib/shortcuts'
import {
  leaning,
  ratingOf,
  ratingsIn,
  TAKE_TAGS,
  tagLabel,
  tagsOf,
  takeFeedback,
  useTakeFeedback,
  type RatedTake,
  type Rating,
  type TakeTag,
} from './takeFeedback'
import styles from './takeRating.module.css'

/**
 * TakeRating: ▲ / ▼ on a take. `rating` is the take's own (RemixTake.rating). A click toggles; on the current
 * take + and − rate it from the keyboard (not with ⌘, which zooms). Inline only.
 */
export function TakeRating({
  take,
  label,
  rating: shown = 0,
  current = false,
}: {
  take: RatedTake
  label: string
  rating?: Rating
  current?: boolean
}) {
  const rating = useTakeFeedback((s) => ratingOf(s, take, shown))
  useEffect(() => {
    if (!current) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTextTarget(e.target)) return
      const r = e.key === '+' || e.key === '=' ? 1 : e.key === '-' || e.key === '−' ? -1 : 0
      if (!r) return
      e.preventDefault()
      takeFeedback.rate(take, r, false, shown)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, take, shown])
  return (
    <div className={styles.rating} role="group" aria-label={`Rate ${label}`}>
      <button
        type="button"
        className={styles.btn}
        data-on={rating === 1 ? 'up' : undefined}
        aria-pressed={rating === 1}
        aria-label="Rate up"
        aria-keyshortcuts={current ? '+' : undefined}
        title={current ? 'Rate up (+): ROLL leans toward takes like this' : 'Rate up: ROLL leans toward takes like this'}
        onClick={() => takeFeedback.rate(take, 1, true, shown)}
      >
        ▲
      </button>
      <button
        type="button"
        className={styles.btn}
        data-on={rating === -1 ? 'down' : undefined}
        aria-pressed={rating === -1}
        aria-label="Rate down"
        aria-keyshortcuts={current ? '-' : undefined}
        title={current ? 'Rate down (−): ROLL leans away from takes like this' : 'Rate down: ROLL leans away from takes like this'}
        onClick={() => takeFeedback.rate(take, -1, true, shown)}
      >
        ▼
      </button>
    </div>
  )
}

/** One reason, one click (on, off). */
export function ReasonChip({ tag, on, i, onToggle }: { tag: TakeTag; on: boolean; i: number; onToggle(): void }) {
  return (
    <button
      type="button"
      className={styles.chip}
      style={{ animationDelay: `${i * 25}ms` }}
      data-on={on || undefined}
      aria-pressed={on}
      onClick={onToggle}
    >
      {tagLabel(tag)}
    </button>
  )
}

/** The nine reasons for the current take once it's rated (they scroll sideways); a hint until then. */
export function ReasonChips({ take, rating: shown = 0 }: { take: RatedTake; rating?: Rating }) {
  const rating = useTakeFeedback((s) => ratingOf(s, take, shown))
  const tags = useTakeFeedback((s) => tagsOf(s, take))
  return (
    <div className={styles.chips} role="group" aria-label="Why (optional)">
      {rating === 0 ? (
        <span className={styles.hint}>+ or − rates this take · then say why</span>
      ) : (
        TAKE_TAGS.map((t, i) => (
          <ReasonChip key={t} tag={t} i={i} on={tags.includes(t)} onToggle={() => takeFeedback.toggleReason(take, t, shown)} />
        ))
      )}
    </div>
  )
}

/** TasteReadout, under ROLL: "LEANS TEAROUT" once ratings lean somewhere, else the key; the tooltip has the count. */
export function TasteReadout() {
  const lean = useTakeFeedback(leaning)
  // GET /api/remix-prefs when the readout shows (the counts can change from other windows or the engine).
  useEffect(() => void takeFeedback.refreshPrefs(), [])
  const name = lean?.style.toUpperCase()
  return (
    <span
      className={styles.taste}
      data-on={lean ? '' : undefined}
      role="status"
      title={
        lean
          ? `ROLL leans on ${lean.ratings} rating${lean.ratings === 1 ? '' : 's'} · ${name}`
          : 'Rate takes + / − and ROLL leans toward them'
      }
    >
      {lean ? `LEANS ${name}` : 'KEY R'}
    </span>
  )
}

/** RESET: forget the ratings in this style, in two steps (the first arms it for a few seconds). Only once there are some. */
export function ResetRatings({ style }: { style: string }) {
  const n = useTakeFeedback((s) => ratingsIn(s, style))
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const id = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(id)
  }, [armed])
  if (!n) return null
  const name = style.toUpperCase()
  return (
    <button
      type="button"
      className={styles.reset}
      data-armed={armed || undefined}
      title={`Forget the ${n} ${name} rating${n === 1 ? '' : 's'}`}
      onClick={() => {
        if (!armed) return setArmed(true)
        setArmed(false)
        takeFeedback.resetStyle(style)
      }}
    >
      {armed ? 'CLEAR?' : 'RESET'}
    </button>
  )
}
