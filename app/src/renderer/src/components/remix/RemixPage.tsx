import { useEffect, useState } from 'react'
import { isTextTarget } from '@/lib/shortcuts'
import { bridge } from '@/env'
import { engineView, isEngineUsable, useEngine } from '@/state/engine'
import { useSong } from '@/state/song'
import { ContextPanel } from './ContextPanel'
import css from './page.module.css'
import { ProgressStrip } from './ProgressStrip'
import { RemixAllQueue } from './RemixAllQueue'
import { RemixExport } from './RemixExport'
import { RemixPlaylist, RemixTimeline } from './RemixTimeline'
import { RemixTransport, StatusDisplay } from './RemixTransport'
import { MatchBadge, RECIPES, RemixEmpty, SourceSlot, useTrackDrop } from './Sources'
import { remix as actions, useRemix, useSongs, useSoundLibrary, type RemixState } from './store'
import { TakeRatingRow, TakesStrip } from './TakesStrip'
import { TasteReadout } from './TakeRating'

/**
 * The REMIX page (app/design/remix, HARDWARE): the top row (recipe, BUILD, ROLL, takes), the take's rating line, then the
 * body: sources, timeline, EXPORT drawer and transport in the centre, the context panel on the right.
 */
export function RemixPage() {
  const s = useRemix()
  const songs = useSongs().data
  useSoundLibrary() // warm the library (patch names on clips)
  const songA = songs?.find((x) => x.id === s.slotA)
  const songB = songs?.find((x) => x.id === s.slotB)
  const mashup = s.recipe === 'mashup'
  // Tracks dropped anywhere on the page: A first, then B (MASHUP); two at once fill both.
  const drop = useTrackDrop()

  // First visit: slot A starts on the Studio's song, when there is one.
  useEffect(() => {
    const current = useSong.getState().song
    if (!useRemix.getState().slotA && current) actions.setSlot('A', current.id)
  }, [])
  // ⌘↩ builds here (the app's ⌘↩ is the Studio's final render, and does nothing on other pages).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter' || e.repeat || isTextTarget(e.target)) return
      e.preventDefault()
      const st = useRemix.getState()
      if (!st.progress && !blockedFor(st, isEngineUsable(useEngine.getState().status))) void actions.build()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // Takes live on the engine's Remix: a recipe and pair that has one comes back with its takes.
  useEffect(() => void actions.resume().catch(() => undefined), [s.slotA, s.slotB, s.recipe])

  return (
    <div className={css.page} data-drag={drop.over || undefined} {...drop.dropProps}>
      {/* No title on screen (the rail names the page); screen readers still get one. */}
      <h1 className="sr-only">REMIX</h1>
      <div className={css.top}>
        <div className={css.recipeCol}>
          <RecipeStrip />
          <BuildStatus />
        </div>
        <BuildButton />
        <RollButton />
        <TakesStrip />
      </div>
      <TakeRatingRow />
      <EngineOffline />
      <div className={css.body}>
        <div className={css.col}>
          {s.slotA || s.remix ? (
            <div className={css.sources}>
              <SourceSlot slot="A" songId={s.slotA} />
              {mashup && <MatchBadge songA={songA} songB={songB} match={s.match} />}
              {mashup && <SourceSlot slot="B" songId={s.slotB} />}
            </div>
          ) : (
            <RemixEmpty />
          )}
          {s.remix ? (
            <RemixPlaylist remix={s.remix}>
              <RemixTimeline remix={s.remix} />
              <RemixAllQueue />
              {s.exportOpen && <RemixExport key={s.remix.id} remix={s.remix} />}
              <RemixTransport remix={s.remix} songA={songA} />
            </RemixPlaylist>
          ) : (
            <>
              {s.slotA && <div className={css.waiting}>{s.progress ? s.progress.label : 'PICK A RECIPE AND PRESS BUILD'}</div>}
              <RemixAllQueue />
              <IdleTransport />
            </>
          )}
        </div>
        <ContextPanel songA={songA} remix={s.remix} />
      </div>
    </div>
  )
}

export function RecipeStrip() {
  const recipe = useRemix((s) => s.recipe)
  return (
    <div className={css.segmented} role="radiogroup" aria-label="Recipe">
      {RECIPES.map((r) => (
        <button key={r.id} type="button" role="radio" aria-checked={recipe === r.id} title={r.line} onClick={() => actions.setRecipe(r.id)}>
          <span className={css.wide}>{r.label}</span>
          <span className={css.compact}>{r.short}</span>
        </button>
      ))}
    </div>
  )
}

/** Why BUILD / ROLL can't run yet (the design's blocked reasons), or null. */
function blockedFor(s: RemixState, engineUp: boolean): string | null {
  if (!s.slotA) return 'ADD TRACK A TO BUILD'
  if (s.recipe === 'mashup' && !s.slotB) return 'LINE UP TRACK B IN MASH RADAR'
  if (s.recipe === 'mashup' && Math.abs(s.match?.shift_st ?? 0) > 4) return 'FIX THE KEY FIRST'
  if (!engineUp) return 'WAITING FOR THE ENGINE'
  return null
}
function useBlocked() {
  const engineUp = useEngine((e) => isEngineUsable(e.status))
  return useRemix((s) => blockedFor(s, engineUp))
}

/** Under the recipe: the reason BUILD is blocked (amber), else the current take in one line. */
function BuildStatus() {
  const blocked = useBlocked()
  const take = useRemix((s) => s.remix?.takes.find((t) => t.seed === (s.switching ?? s.remix?.seed)))
  return (
    <span className={css.buildWhy} role="status" data-warn={blocked ? '' : undefined}>
      {blocked ?? (take ? `${take.name || 'TAKE'} · ${take.style.toUpperCase()} · #${take.seed}` : '')}
    </span>
  )
}

/** The one ember primary (⌘↩): BUILD, or BUILDING with its 12 LEDs filling as the job runs. */
export function BuildButton() {
  const blocked = useBlocked()
  const progress = useRemix((s) => s.progress)
  const hasTake = useRemix((s) => Boolean(s.remix?.takes.length))
  const building = /^BUILDING/.test(progress?.label ?? '')
  return (
    <button
      type="button"
      className={css.build}
      aria-keyshortcuts="Meta+Enter"
      onClick={() => void actions.build()}
      disabled={Boolean(blocked || progress)}
      title={blocked ?? undefined}
    >
      <span className={css.buildLabel}>{building ? 'BUILDING' : 'BUILD'}</span>
      <ProgressStrip value={building ? progress!.value : hasTake ? 1 : 0} />
    </button>
  )
}

/** Another take of the same recipe with a new seed (R). The ⟳ turns once per roll; the readout says where ROLL leans. */
export function RollButton() {
  const blocked = useBlocked()
  const progress = useRemix((s) => s.progress)
  const [turns, setTurns] = useState(0)
  return (
    <button
      type="button"
      className={css.roll}
      aria-keyshortcuts="R"
      onClick={() => {
        setTurns((n) => n + 1)
        void actions.roll()
      }}
      disabled={Boolean(blocked || progress)}
      title={blocked ?? 'Another take of the same recipe, new seed (R)'}
    >
      <span className={css.rollLabel}>
        <span aria-hidden="true" style={{ transform: `rotate(${turns * 360}deg)` }}>
          ⟳
        </span>
        ROLL
      </span>
      <TasteReadout />
    </button>
  )
}

/** The engine is down: an inline strip (no modal). The draft still plays; BUILD, ROLL and EXPORT wait. */
function EngineOffline() {
  const view = useEngine((e) => engineView(e.status))
  if (view !== 'offline' && view !== 'error') return null
  return (
    <div className={css.offline} role="alert">
      <span className={css.offlineGlyph} aria-hidden="true">
        !
      </span>
      <span className={css.offlineText}>
        <b>ENGINE {view === 'error' ? 'ERROR' : 'OFFLINE'}</b>The draft is safe and still plays. BUILD, ROLL and EXPORT wait for the engine.
      </span>
      {bridge() && (
        <button type="button" className={css.offlineBtn} onClick={() => void bridge()!.restartEngine()}>
          RESTART ENGINE
        </button>
      )}
    </div>
  )
}

/** The transport before there's a remix: the same bar, idle, so notifications have their one place. */
function IdleTransport() {
  const recipe = useRemix((s) => s.recipe)
  return (
    <div className={css.transport} role="toolbar" aria-label="Remix transport">
      <button type="button" className={css.play} disabled>
        ▶ PLAY
      </button>
      <button type="button" className={css.loop} disabled>
        ⟲ LOOP
      </button>
      <span className={css.clock}>
        <b>0:00.0</b>
        <span>BAR 1.1</span>
      </span>
      <StatusDisplay idle={recipe ? 'PRESS BUILD' : ''} />
    </div>
  )
}
