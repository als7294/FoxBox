import { useEffect } from 'react'
import type { RemixTake } from '@/api/remix'
import { TwoStep } from '@/components/common/TwoStep'
import { isTextTarget } from '@/lib/shortcuts'
import css from './page.module.css'
import { remix as actions, useRemix } from './store'
import { ReasonChips, ResetRatings, TakeRating } from './TakeRating'
import { ratingOf, takeFeedback, useTakeFeedback, type RatedTake } from './takeFeedback'
import { isEdited, seedForKey } from './takes'

const NONE: RemixTake[] = []
const SLOTS = ['TAKE 1', 'TAKE 2', 'TAKE 3', 'TAKE 4', 'TAKE 5', 'TAKE 6']
/** −7.8 (a real minus, one decimal, as on STUDIO's cartridge). */
const db = (x: number) => x.toFixed(1).replace('-', '−')

/** The current take (or the one being switched to) and its number, from the store. */
function useCurrentTake() {
  const takes = useRemix((s) => s.remix?.takes ?? NONE)
  const seed = useRemix((s) => s.switching ?? s.remix?.seed)
  const i = Math.max(
    0,
    takes.findIndex((t) => t.seed === seed),
  )
  return { takes, seed, cur: takes[i], n: i + 1 }
}

/**
 * The loaded remix's takes (about 6; six dashed slots until the first BUILD). Click switches, ⇧-click marks two for
 * COMPARE (A/B). The current take's ▲ ▼ ☆ ✕ sit at the strip's end. Keys: R rolls, 1–6 switch, + and − rate.
 */
export function TakesStrip() {
  const { takes, seed, cur, n } = useCurrentTake()
  const busy = useRemix((s) => /^(BUILDING|PREPARING)/.test(s.progress?.label ?? ''))
  const ab = useRemix((s) => s.ab)
  const remixId = useRemix((s) => s.remix?.id ?? '')

  // Capture phase, so the app's own 1–7 (presets) and R don't fire on this page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTextTarget(e.target)) return
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        if (!e.repeat) void actions.roll()
      } else if (/^[1-6]$/.test(e.key)) {
        e.preventDefault()
        const s = seedForKey(useRemix.getState().remix?.takes ?? NONE, e.key)
        if (s != null) select(s)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <section className={css.takes} aria-label="Takes">
      {takes.length
        ? takes.map((t, i) => (
            <TakeCard
              key={t.seed}
              take={t}
              remixId={remixId}
              n={i + 1}
              current={t.seed === seed}
              preparing={busy && t.seed === seed}
              ab={t.seed === ab.A ? 'A' : t.seed === ab.B ? 'B' : null}
            />
          ))
        : SLOTS.map((l) => (
            <span key={l} className={css.slot} aria-hidden="true">
              {l}
            </span>
          ))}
      {cur && <RateButtons take={cur} label={cur.name || `TAKE ${n}`} rated={{ id: remixId, seed: cur.seed, style: cur.style }} />}
    </section>
  )
}

/** Another take: its reasons row closes (the design's switchTake). */
const select = (seed: number) => {
  takeFeedback.closeWhy()
  void actions.selectTake(seed)
}

export function TakeCard(p: { take: RemixTake; remixId: string; n: number; current: boolean; preparing: boolean; ab: 'A' | 'B' | null }) {
  const { take: t, n } = p
  const rating = useTakeFeedback((s) => ratingOf(s, { id: p.remixId, seed: t.seed }, t.rating))
  const name = t.name || `TAKE ${n}`
  // v0.15.3: the loudness job runs after PREPARE; until it's done, a quiet "…".
  const lufs = t.short_term_max_lufs != null ? ` · ${db(t.short_term_max_lufs)} LUFS` : ' · LUFS …'
  const peak = t.true_peak_db != null ? ` · ${db(t.true_peak_db)} dBTP` : ''
  const style = t.style.toUpperCase()
  const edited = isEdited(t) ? ' · EDITED' : ''
  return (
    <div
      className={css.take}
      role="button"
      tabIndex={0}
      aria-pressed={p.current}
      aria-keyshortcuts={n <= 6 ? String(n) : undefined}
      aria-label={`${name}, seed ${t.seed}, ${style}${rating > 0 ? ', rated up' : rating < 0 ? ', rated down' : ''}${t.starred ? ', kept' : ''}${p.ab ? `, compare ${p.ab}` : ''}`}
      title={`⇧-click to compare two takes · ${name} · SEED ${t.seed} · ${style}${edited}${lufs}${peak}`}
      data-rated={rating > 0 ? 'up' : undefined}
      data-state={p.preparing ? 'preparing' : undefined}
      onClick={(e) => (e.shiftKey ? actions.markAb(t.seed) : select(t.seed))}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        e.stopPropagation() // Space here picks the take, not play
        if (e.shiftKey) actions.markAb(t.seed)
        else select(t.seed)
      }}
    >
      <span className={css.takeLed} aria-hidden="true" />
      <span className={css.takeHead}>
        <b>{name}</b>
        {rating !== 0 && <span data-rate={rating > 0 ? 'up' : 'down'}>{rating > 0 ? '▲' : '▼'}</span>}
        {t.starred && <span className={css.takeStar}>★</span>}
        <span className={css.flex} />
        {p.ab && <span className={css.takeAb}>{p.ab}</span>}
      </span>
      <span className={css.takeStyle}>
        {style}
        <span className={css.wide}> · #{t.seed}</span>
      </span>
      {p.preparing && (
        <>
          <span className={css.shimmer} aria-hidden="true" />
          <span className={css.takePrep}>PREPARING</span>
        </>
      )}
    </div>
  )
}

/** The current take's ▲ ▼ (+ / −), ☆ KEEP and ✕ DELETE (two clicks), at the end of the strip. */
function RateButtons({ take, label, rated }: { take: RemixTake; label: string; rated: RatedTake }) {
  return (
    <div className={css.rate}>
      <TakeRating take={rated} label={label} rating={take.rating} current />
      <button
        type="button"
        className={css.keepBtn}
        data-on={take.starred || undefined}
        aria-pressed={take.starred}
        aria-label="Keep this take"
        title="Keep (starred takes are never dropped)"
        onClick={() => actions.starTake(take.seed)}
      >
        {take.starred ? '★' : '☆'}
      </button>
      <TwoStep
        className={css.delBtn}
        label="✕"
        armedLabel="DELETE?"
        aria={`Delete ${label}`}
        title="Delete take (two clicks)"
        onConfirm={() => actions.deleteTake(take.seed)}
      />
    </div>
  )
}

/**
 * WHY? (28px, under the top row): once the current take is rated, the nine reasons, RESET for its style (two steps, once
 * there are ratings) and DONE. It closes on DONE or another take.
 */
export function WhyRow() {
  const { cur } = useCurrentTake()
  const remixId = useRemix((s) => s.remix?.id ?? '')
  const rating = useTakeFeedback((s) => (cur ? ratingOf(s, { id: remixId, seed: cur.seed }, cur.rating) : 0))
  const open = useTakeFeedback((s) => s.why)
  if (!cur || !open || rating === 0) return null
  return (
    <div className={css.why}>
      <span className={css.whyLabel} data-rate={rating > 0 ? 'up' : 'down'}>
        {rating > 0 ? '▲ WHY?' : '▼ WHY?'}
      </span>
      <ReasonChips take={{ id: remixId, seed: cur.seed, style: cur.style }} rating={cur.rating} />
      <ResetRatings style={cur.style} />
      <button type="button" className={css.whyDone} onClick={() => takeFeedback.closeWhy()}>
        DONE
      </button>
    </div>
  )
}
