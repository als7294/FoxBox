import { useEffect, useMemo, useState } from 'react'
import { isTextTarget } from '@/lib/shortcuts'
import { bridge } from '@/env'
import { engineView, isEngineUsable, useEngine } from '@/state/engine'
import { useSong } from '@/state/song'
import { NO_REMIX, originalRemix } from './arrangement'
import { ContextPanel } from './ContextPanel'
import css from './page.module.css'
import { ProgressStrip } from './ProgressStrip'
import { RemixAllQueue } from './RemixAllQueue'
import { RemixExport } from './RemixExport'
import { RemixPlaylist, RemixTimeline } from './RemixTimeline'
import { RemixTransport } from './RemixTransport'
import { MatchBadge, RemixEmpty, SourceSlot, useTrackDrop } from './Sources'
import { remix as actions, useRemix, useSongs, useSoundLibrary, type RemixState } from './store'
import { TakesStrip, WhyRow } from './TakesStrip'
import { TasteReadout } from './TakeRating'

/**
 * The REMIX page (app/design/remix, HARDWARE): the top row (BUILD, ROLL, takes), the WHY? row once a take is rated, then
 * the body: sources, timeline, EXPORT drawer and transport in the centre, the context panel (recipes on top) on the right.
 */
export function RemixPage() {
  const s = useRemix()
  const songs = useSongs().data
  useSoundLibrary() // warm the library (patch names on clips)
  const songA = songs?.find((x) => x.id === s.slotA)
  const songB = songs?.find((x) => x.id === s.slotB)
  const mashup = s.recipe === 'mashup'
  // Stable per song and recipe: a new object would rebuild the playlist (and stop it). While A still reads (no drops or
  // tempo yet) DECK A shows it instead.
  const readingA = songA?.analysis_state === 'queued' || songA?.analysis_state === 'running'
  const original = useMemo(() => (songA && !readingA ? originalRemix(songA, s.recipe) : null), [songA, readingA, s.recipe])
  const shown = s.remix ?? original
  // Tracks dropped anywhere on the page: A first, then B (MASHUP); two at once fill both.
  const drop = useTrackDrop()
  const blocked = useBlocked()

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
        <BuildButton />
        <RollButton />
        <TakesStrip />
      </div>
      <WhyRow />
      <EngineOffline />
      <div className={css.body} data-min={s.panelMin || undefined}>
        <div className={css.col}>
          {shown && (
            <div className={css.sources}>
              <SourceSlot slot="A" songId={s.slotA} />
              {mashup && <MatchBadge songA={songA} songB={songB} match={s.match} />}
              {mashup && <SourceSlot slot="B" songId={s.slotB} />}
            </div>
          )}
          {shown ? (
            // Before a BUILD the timeline and transport show (and play) the ORIGINAL, read-only.
            <RemixPlaylist remix={shown}>
              <RemixTimeline remix={shown} plan={s.remix ? undefined : s.recipe} />
              <RemixAllQueue />
              {s.remix && s.exportOpen && <RemixExport key={s.remix.id} remix={s.remix} />}
              <RemixTransport remix={shown} songA={songA} note={blocked ?? undefined} />
            </RemixPlaylist>
          ) : (
            // No track yet (or A's still loading or reading): DECK A, and the whole transport, disabled.
            <RemixPlaylist remix={NO_REMIX}>
              <RemixEmpty />
              <RemixAllQueue />
              <RemixTransport remix={NO_REMIX} songA={undefined} idle="ADD TRACK A TO BUILD" />
            </RemixPlaylist>
          )}
        </div>
        <ContextPanel songA={songA} remix={s.remix} />
      </div>
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

/**
 * The one ember primary (⌘↩): BUILD, or BUILDING with its 12 LEDs filling as the job runs. Armed (it pulses, a light
 * runs along the LEDs) until the first take; dark ember while blocked.
 */
export function BuildButton() {
  const blocked = useBlocked()
  const progress = useRemix((s) => s.progress)
  const hasTake = useRemix((s) => Boolean(s.remix?.takes.length))
  const building = /^BUILDING/.test(progress?.label ?? '')
  const armed = !blocked && !hasTake && !progress
  return (
    <button
      type="button"
      className={css.build}
      data-state={building ? 'building' : blocked ? 'blocked' : armed ? 'armed' : undefined}
      aria-keyshortcuts="Meta+Enter"
      onClick={() => void actions.build()}
      disabled={Boolean(blocked || progress)}
      title={blocked ?? 'BUILD (⌘ Enter)'}
    >
      <span className={css.buildLabel}>{building ? 'BUILDING' : 'BUILD'}</span>
      <span className={css.buildLeds} aria-hidden="true">
        <ProgressStrip value={building ? progress!.value : hasTake ? 1 : 0} />
        {armed && <span className={css.ledRun} />}
      </span>
    </button>
  )
}

/** Another take of the same recipe with a new seed (R). The ⟳ turns once per roll; the readout says where ROLL leans. */
export function RollButton() {
  const blocked = useBlocked()
  const progress = useRemix((s) => s.progress)
  const hasTake = useRemix((s) => Boolean(s.remix?.takes.length))
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
      disabled={Boolean(blocked || progress || !hasTake)}
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
