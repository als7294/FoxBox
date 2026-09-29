import { useEffect, useState } from 'react'
import type { RemixTake } from '@/api/remix'
import { isTextTarget } from '@/lib/shortcuts'
import css from './page.module.css'
import { remix as actions, useRemix } from './store'
import { ReasonChips, ResetRatings, TakeRating } from './TakeRating'
import { ratingOf, useTakeFeedback } from './takeFeedback'
import { isEdited, seedForKey } from './takes'

const NONE: RemixTake[] = []
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

/** The loaded remix's takes (Remix.takes, about 6). Keys: R rolls, 1–6 switch. */
export function TakesStrip() {
  const { takes, seed } = useCurrentTake()
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
        if (s != null) void actions.selectTake(s)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <section className={css.takes} aria-label="Takes">
      {takes.length ? (
        takes.map((t, i) => (
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
      ) : (
        <span className={css.takesHint}>TAKES · every BUILD and ROLL lands here. Keys 1–6 switch, + and − rate.</span>
      )}
    </section>
  )
}

export function TakeCard(p: { take: RemixTake; remixId: string; n: number; current: boolean; preparing: boolean; ab: 'A' | 'B' | null }) {
  const { take: t, n } = p
  const rating = useTakeFeedback((s) => ratingOf(s, { id: p.remixId, seed: t.seed }, t.rating))
  const name = t.name || `TAKE ${n}`
  const lufs = t.short_term_max_lufs != null ? ` · ${db(t.short_term_max_lufs)} LUFS` : ''
  const peak = t.true_peak_db != null ? ` · ${db(t.true_peak_db)} dBTP` : ''
  const style = t.style.toUpperCase() + (isEdited(t) ? ' · EDITED' : '')
  const select = () => void actions.selectTake(t.seed)
  return (
    <div
      className={css.take}
      role="button"
      tabIndex={0}
      aria-pressed={p.current}
      aria-keyshortcuts={n <= 6 ? String(n) : undefined}
      aria-label={`${name}, seed ${t.seed}, ${style}${rating > 0 ? ', rated up' : rating < 0 ? ', rated down' : ''}${t.starred ? ', kept' : ''}`}
      title={`${name} · SEED ${t.seed} · ${style}${lufs}${peak}`}
      data-rated={rating > 0 ? 'up' : undefined}
      data-state={p.preparing ? 'preparing' : undefined}
      onClick={select}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        e.stopPropagation() // Space here picks the take, not play
        select()
      }}
    >
      <span className={css.takeLed} aria-hidden="true" />
      <span className={css.takeHead}>
        <b>{name}</b>
        {rating !== 0 && <span data-rate={rating > 0 ? 'up' : 'down'}>{rating > 0 ? '▲' : '▼'}</span>}
        {t.starred && <span className={css.takeStar}>★</span>}
        <span className={css.flex} />
        {p.ab && <span className={css.takeAb}>{p.ab}</span>}
        {n <= 6 && (
          <span className={css.takeKey} aria-hidden="true">
            {n}
          </span>
        )}
      </span>
      <span className={css.takeStyle}>{style}</span>
      <span className={css.takeMeta}>
        #{t.seed}
        {lufs}
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

/**
 * The current take's one line: its name, ▲ UP ▼ DOWN (+ / −), the reasons once rated, KEEP, A/B (marks it for
 * COMPARE), REBUILD when edited, RESET for its style, then DELETE… apart. All two-step where destructive.
 */
export function TakeRatingRow() {
  const { cur, n } = useCurrentTake()
  const remixId = useRemix((s) => s.remix?.id ?? '')
  const marked = useRemix((s) => cur != null && (s.ab.A === cur.seed || s.ab.B === cur.seed))
  if (!cur) return null
  const rated = { id: remixId, seed: cur.seed, style: cur.style }
  const label = cur.name || `TAKE ${n}`
  return (
    <div className={css.rateRow}>
      <input
        key={`${cur.seed}:${cur.name ?? ''}`}
        className={css.takeName}
        defaultValue={cur.name ?? ''}
        placeholder={`TAKE ${n}`}
        maxLength={200}
        aria-label={`Name of take ${n}`}
        onBlur={(e) => {
          const name = e.currentTarget.value.trim()
          if (name !== (cur.name ?? '')) actions.renameTake(cur.seed, name)
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <TakeRating take={rated} label={label} rating={cur.rating} current />
      <ReasonChips take={rated} rating={cur.rating} />
      <button
        type="button"
        className={css.btn}
        data-tone={cur.starred ? 'amber' : undefined}
        aria-pressed={cur.starred}
        onClick={() => actions.starTake(cur.seed)}
      >
        {cur.starred ? '★ KEPT' : '☆ KEEP'}
      </button>
      <button
        type="button"
        className={css.abBtn}
        aria-pressed={marked}
        title="Mark two takes to compare them in the transport"
        onClick={() => actions.markAb(cur.seed)}
      >
        {marked ? 'A/B ✓' : 'A/B'}
      </button>
      {isEdited(cur) && <RebuildButton />}
      <ResetRatings style={cur.style} />
      <span className={css.spacer} />
      <TwoStep
        className={css.danger}
        label="DELETE…"
        armedLabel="CONFIRM DELETE"
        aria={`Delete ${label}`}
        onConfirm={() => actions.deleteTake(cur.seed)}
      />
    </div>
  )
}

/** A destructive button: the first click arms it, the second does it; blur or a few seconds disarm it. */
function TwoStep(p: { className?: string; label: string; armedLabel: string; aria: string; title?: string; onConfirm(): void }) {
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

/** REBUILD: throws the current take's edits away and rebuilds it fresh from its choices. */
function RebuildButton() {
  return (
    <TwoStep
      className={css.btn}
      label="REBUILD"
      armedLabel="REBUILD? EDITS GO"
      aria="Rebuild this take"
      title="Discard this take's edits and rebuild it from its recorded choices"
      onConfirm={() => void actions.rebuild()}
    />
  )
}
