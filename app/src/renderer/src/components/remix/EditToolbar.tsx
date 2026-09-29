import { usePlaybackAnimation } from '@waveform-playlist/browser'
import { Fragment, useEffect } from 'react'
import { isTextTarget } from '@/lib/shortcuts'
import { remixBeats, secToBeat } from './arrangement'
import { SNAPS } from './edit'
import { histKey, remix as actions, useRemix } from './store'
import css from './timeline.module.css'

/** Zoom levels, × the fit. */
export const ZOOMS = [1, 2, 4, 8, 16]
/** One zoom step in (1) or out (−1), or FIT (0). The timeline keeps the playhead where it was in the view. */
export const zoomStep = (d: -1 | 0 | 1) => useRemix.setState((s) => ({ zoom: d === 0 ? 1 : (ZOOMS[ZOOMS.indexOf(s.zoom) + d] ?? s.zoom) }))

/** The timeline head's tools: undo / redo, snap, FOLLOW and zoom, and the edit keys. Inside the playlist provider. */
export function EditToolbar() {
  const h = useRemix((s) => (s.remix ? s.history[histKey(s.remix)] : undefined))
  const follow = useRemix((s) => s.follow)
  useEditKeys()
  return (
    <div className={css.tools} role="toolbar" aria-label="Edit">
      <button
        type="button"
        className={`${css.btn} ${css.glyph}`}
        onClick={actions.undo}
        disabled={!h?.past.length}
        aria-label="Undo"
        aria-keyshortcuts="Meta+Z"
        title="Undo (⌘Z)"
      >
        ↶
      </button>
      <button
        type="button"
        className={`${css.btn} ${css.glyph}`}
        onClick={actions.redo}
        disabled={!h?.future.length}
        aria-label="Redo"
        aria-keyshortcuts="Shift+Meta+Z"
        title="Redo (⇧⌘Z)"
      >
        ↷
      </button>
      <SnapControl />
      <button
        type="button"
        className={`${css.btn} ${css.follow}`}
        aria-pressed={follow}
        title="Keep the playhead in view while zoomed"
        onClick={() => useRemix.setState({ follow: !follow })}
      >
        FOLLOW
      </button>
      <ZoomControl />
    </div>
  )
}

const KEYS: [string, string][] = [
  ['Play / stop', 'SPACE'],
  ['BUILD', '⌘↩'],
  ['ROLL a new take', 'R'],
  ['Rate the take', '+ / −'],
  ['Jump to a take', '1 – 6'],
  ['Undo / redo', '⌘Z / ⇧⌘Z'],
  ['Multi-select', '⇧-CLICK · DRAG'],
  ['Copy / paste', '⌘C / ⌘V'],
  ['Duplicate', '⌘D'],
  ['Split at the playhead', 'S'],
  ['Delete', '⌫'],
  ['Move a section', '← →'],
  ['Loop', 'L'],
  ['Zoom', '⌘+ / ⌘− · ⌘-SCROLL'],
  ['Fit', '⌘0'],
  ['Close', 'ESC'],
]

/** The REMIX keys, a panel over the timeline's corner (not a dialog): ? toggles it, Esc closes it. */
export function ShortcutsOverlay() {
  const open = useRemix((s) => s.keysOpen)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTextTarget(e.target)) return
      if (e.key === '?') {
        e.preventDefault()
        useRemix.setState((s) => ({ keysOpen: !s.keysOpen }))
      } else if (e.key === 'Escape' && useRemix.getState().keysOpen) {
        e.preventDefault()
        useRemix.setState({ keysOpen: false })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  if (!open) return null
  return (
    <section className={css.keys} aria-label="REMIX keys">
      <header>
        KEYS
        <button type="button" className={css.esc} onClick={() => useRemix.setState({ keysOpen: false })} aria-label="Close the REMIX keys">
          ✕
        </button>
      </header>
      <dl>
        {KEYS.map(([what, keys]) => (
          <Fragment key={what}>
            <dt>{what}</dt>
            <dd>
              <kbd>{keys}</kbd>
            </dd>
          </Fragment>
        ))}
      </dl>
    </section>
  )
}

/** The grid moves, splits and the loop drag snap to. */
export function SnapControl() {
  const snap = useRemix((s) => s.snap)
  return (
    <div className={css.snap} role="radiogroup" aria-label="Snap">
      <span aria-hidden="true">SNAP</span>
      {SNAPS.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={snap === o.id} onClick={() => useRemix.setState({ snap: o.id })}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** − `FIT · 144` + (zoomed: `4× · 36 BARS`); the middle is FIT. */
export function ZoomControl() {
  const zoom = useRemix((s) => s.zoom)
  const bars = useRemix((s) => (s.remix ? Math.round(remixBeats(s.remix) / s.remix.beats_per_bar) : 0))
  return (
    <div className={css.zoom} role="group" aria-label="Zoom">
      <button type="button" onClick={() => zoomStep(-1)} disabled={zoom === 1} aria-label="Zoom out" aria-keyshortcuts="Meta+-">
        −
      </button>
      <button type="button" onClick={() => zoomStep(0)} aria-keyshortcuts="Meta+0" title="Fit the whole remix (⌘0)">
        {zoom === 1 ? `FIT · ${bars}` : `${zoom}× · ${Math.round(bars / zoom)} BARS`}
      </button>
      <button type="button" onClick={() => zoomStep(1)} disabled={zoom === ZOOMS.at(-1)} aria-label="Zoom in" aria-keyshortcuts="Meta+=">
        +
      </button>
    </div>
  )
}

/**
 * The REMIX edit keys, in the capture phase (like TakesStrip's R and 1–6), never while typing. The playhead is in
 * the playlist's ref (moved every frame while playing, and on every seek).
 */
function useEditKeys() {
  const { visualTimeRef } = usePlaybackAnimation()
  const playhead = () => secToBeat(visualTimeRef.current ?? 0, useRemix.getState().remix?.bpm ?? 120)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || isTextTarget(e.target)) return
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      const picked = actions.hasSelection()
      let run: (() => void) | null = null
      if (mod && key === 'z') run = e.shiftKey ? actions.redo : actions.undo
      else if (mod && (key === '=' || key === '+')) run = () => zoomStep(1)
      else if (mod && (key === '-' || key === '_')) run = () => zoomStep(-1)
      else if (mod && key === '0') run = () => zoomStep(0)
      else if (mod && key === 'c' && picked) run = actions.copy
      else if (mod && key === 'v' && actions.hasClipboard()) run = () => actions.paste(playhead())
      else if (mod && key === 'd' && picked) run = actions.duplicate
      else if (!mod && (e.key === 'Backspace' || e.key === 'Delete') && picked) run = actions.remove
      else if (!mod && key === 's') run = () => actions.split(playhead())
      else if (!mod && e.key === 'Escape' && picked) run = () => useRemix.setState({ clips: [], section: null })
      if (!run) return
      e.preventDefault()
      run()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
}
