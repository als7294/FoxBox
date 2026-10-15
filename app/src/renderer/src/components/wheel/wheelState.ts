/**
 * REMIX's library wheel, its state (no rendering: libraryWheel.ts draws it). The right index finger is a knob: its
 * angle (S1's, ~140-280°) turns the ring with a gain (a 140° sweep is a page of 40 tracks), held near either end it
 * keeps scrolling; the selection snaps to whole tracks. The left hand's grab pulls the selected card out: at full pull
 * the preview plays, opened again it stops; S1's hold-to-load progress reaching 1 loads it. The mouse and keys drive
 * the same state.
 */
export const SLOTS = 72 // live cards around the ring (the design's Ring)
export const PAGE_TRACKS = 40
export const PAGE_DEG = 140
export const EDGE_RATE = 24 // tracks a second while the finger is held at an end
const PREVIEW_AT = 0.95 // the grab that plays the preview…
const PREVIEW_OFF = 0.3 // …and the one that stops it
const TYPE_MS = 1000

export interface WheelEvents {
  select?: (index: number) => void
  preview?: (index: number | null) => void
  load?: (index: number) => void
}

export function createWheelState(events: WheelEvents = {}) {
  let n = 0
  let raw = 0 // the turned position, tracks (unsnapped)
  let anchor: { deg: number; raw: number } | null = null
  let edge = 0
  let grab = 0
  let previewing: number | null = null
  let loading = false
  let typed = ''
  let typedAt = -Infinity
  let last = -1
  const wrap = (i: number) => (n ? ((Math.round(i) % n) + n) % n : 0)
  const changed = () => {
    const s = wrap(raw)
    if (n && s !== last) {
      last = s
      events.select?.(s)
      if (previewing !== null && previewing !== s) stopPreview() // the preview is the pulled card's
    }
  }
  const stopPreview = () => {
    if (previewing === null) return
    previewing = null
    events.preview?.(null)
  }
  return {
    /** The track count (a new list keeps the position, clamped). */
    setCount(count: number) {
      n = Math.max(0, Math.floor(count))
      if (n && (raw < 0 || raw >= n)) raw = wrap(raw)
      last = -1
      changed()
    },
    /** S1's dial: the finger's angle (null: no finger), `edge` -1 / 1 while it's held at an end. */
    setDial(deg: number | null, atEdge = 0) {
      edge = deg === null ? 0 : Math.sign(atEdge)
      if (deg === null || !Number.isFinite(deg)) return void (anchor = null)
      if (!anchor) anchor = { deg, raw }
      raw = anchor.raw + ((deg - anchor.deg) * PAGE_TRACKS) / PAGE_DEG
      changed()
    },
    /** Edge scrolling: call each frame. */
    tick(dtS: number) {
      if (!edge || !anchor) return
      anchor.raw += edge * EDGE_RATE * dtS
      raw += edge * EDGE_RATE * dtS
      changed()
    },
    /** The mouse wheel or the arrow keys: `by` tracks. */
    nudge(by: number) {
      raw = Math.round(raw) + by
      if (anchor) anchor.raw += by
      changed()
    },
    select(index: number) {
      if (anchor) anchor.raw += index - Math.round(raw)
      raw = index
      changed()
    },
    /** S1's grab, 0 open … 1 closed: the full pull previews the selected track, opening stops it. */
    setGrab(x: number) {
      grab = Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0))
      if (grab >= PREVIEW_AT && previewing === null && n) {
        previewing = wrap(raw)
        events.preview?.(previewing)
      } else if (grab < PREVIEW_OFF) stopPreview()
    },
    /** A click's preview (on its own, without a grab), off again on a second click. */
    togglePreview() {
      if (previewing !== null) return stopPreview()
      if (!n) return
      previewing = wrap(raw)
      events.preview?.(previewing)
    },
    /** S1's hold-to-load, 0-1: reaching 1 loads the selected track (once a hold). */
    setLoadProgress(p: number) {
      if (p >= 1 && !loading && n) {
        loading = true
        events.load?.(wrap(raw))
      } else if (p < 1) loading = false
    },
    load() {
      if (n) events.load?.(wrap(raw))
    },
    /** Type-ahead: the first title starting with what was typed in the last second. */
    type(ch: string, titles: readonly string[], nowMs: number) {
      typed = nowMs - typedAt < TYPE_MS ? typed + ch.toLowerCase() : ch.toLowerCase()
      typedAt = nowMs
      const i = titles.findIndex((t) => t.toLowerCase().startsWith(typed))
      if (i >= 0) this.select(i)
    },
    /** The snapped position the ring eases to, and the selected track. */
    get target() { return Math.round(raw) },
    get selected() { return wrap(raw) },
    get grab() { return grab },
    get previewing() { return previewing },
    get count() { return n },
  }
}
export type WheelState = ReturnType<typeof createWheelState>
