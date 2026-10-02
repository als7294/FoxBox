/**
 * STRINGS' beat FX (1.5.5, "DJM FX in the air", for bass remixes): a hand shape holds a bass move, and the strings
 * perform it. S1 reads the shapes, S2 turns them into the sound and `beatFx()` (each hand's FX, its DEPTH from the
 * hand's height, its BEAT from the hands' spread); this is the picture's side: each slot's eased amount, its phase on
 * the beat grid, BUILD ROLL's build and its SNAP on release, and the HUD's line. beatFxPass.ts draws it.
 *   TEAROUT    the strings fray, jagged and crushed
 *   RIDDIM     they gate in the chop pattern (by segment: the light stays about the same, no strobe)
 *   WOBBLE     they wobble at the LFO's rate, DEPTH the amplitude
 *   GROWL      they morph through vowel mouths
 *   HALFTIME   everything at half speed, heavier and thicker
 *   SUB DROP   they sag and drop
 *   BUILD ROLL they tighten and vibrate faster and faster; let go and they SNAP (the drop)
 *   GLASS      the finger frame (glass.ts): drawn there, skipped here
 */
import type { AudioFrame } from '@/visuals/live/registry'

export type BeatFxId = 'tearout' | 'riddim' | 'wobble' | 'growl' | 'halftime' | 'subdrop' | 'buildroll' | 'glass'

/** One hand's FX, as S2's beatFx() gives it. */
export interface BeatFxSlot {
  fx: BeatFxId
  /** 0-1: the hand's height. */
  depth: number
  /** The FX's period in beats (quarter notes), from the hands' spread: 1/4 1, 1/8 0.5, 1/8T 1/3, 1/16 0.25, 1/16T 1/6. */
  beat: number
  /** The BEAT as the HUD shows it, S2's exact string: '1/4', '1/8', '1/8T', '1/16', '1/16T'. */
  label: string
  /** performance.now() when it began. */
  since: number
}
export interface BeatFxHands {
  left: BeatFxSlot | null
  right: BeatFxSlot | null
}

export const FX_LABEL: Record<BeatFxId, string> = {
  tearout: 'TEAROUT', riddim: 'RIDDIM', wobble: 'WOBBLE', growl: 'GROWL', halftime: 'HALFTIME', subdrop: 'SUB DROP',
  buildroll: 'BUILD ROLL', glass: 'GLASS',
}
/** The shader's mode per FX (0: none). */
export const FX_MODE: Record<BeatFxId, number> = { tearout: 1, riddim: 2, wobble: 3, growl: 4, halftime: 5, subdrop: 6, buildroll: 7, glass: 0 }

const NONE: BeatFxHands = { left: null, right: null }
let source: () => BeatFxHands = () => NONE
/** S2's beatFx() (@/audio/live/beatFx, the same shape) in: StringsStage reads through this; the web mock's scripted FX
 *  stand in for it. */
export const setBeatFxSource = (f: () => BeatFxHands): void => void (source = f)
export const readBeatFx = (): BeatFxHands => source()

export const IN_MS = 120 // an FX easing in
export const OUT_MS = 220 // and out (no pops)
export const SNAP_MS = 450 // BUILD ROLL's snap, decaying
const BUILD_BEATS = 8 // BUILD ROLL at full tension after this many beats

/** Where `beats` (a period in beats) is on the grid now, 0-1: the beat's phase, or the bar's for longer periods. */
export function gridPhase(a: Pick<AudioFrame, 'beatPhase' | 'barPhase'>, beats: number): number {
  if (!(beats > 0)) return 0
  const pos = beats <= 1 ? a.beatPhase : (a.barPhase ?? a.beatPhase / 4) * 4
  const p = (pos / beats) % 1
  return p < 0 ? p + 1 : p
}

/** The step count within the beat or bar (RIDDIM's pattern, TEAROUT's jitter: they change on the grid, not per frame). */
export function gridStep(a: Pick<AudioFrame, 'beatPhase' | 'barPhase'>, beats: number): number {
  if (!(beats > 0)) return 0
  const pos = beats <= 1 ? a.beatPhase : (a.barPhase ?? a.beatPhase / 4) * 4
  return Math.floor(pos / beats + 1e-6)
}

/** One slot as the pass draws it. */
export interface FxDraw {
  mode: number
  /** 0-1: eased in and out, times DEPTH. */
  amount: number
  phase: number
  step: number
  /** BUILD ROLL: 0-1 through its build. */
  build: number
}
export interface FxFrame {
  slots: [FxDraw, FxDraw]
  /** BUILD ROLL's snap, 1 at release decaying to 0. */
  snap: number
  /** HALFTIME's hold on time: the strings' dt is scaled by this (1 … 0.5). */
  speed: number
  /** Anything to draw (else the strings go through as they are). */
  active: boolean
  /** The HUD: each held FX (left, right). */
  hud: { label: string; beat: string; depth: number; step: number }[]
}

const OFF: FxDraw = { mode: 0, amount: 0, phase: 0, step: 0, build: 0 }

/** Each hand's FX over time: `update` each drawn frame with S2's FX and the audio frame. */
export function createBeatFx(opts: { reduced?: boolean } = {}) {
  const reduced = opts.reduced === true
  const sides = [0, 1].map(() => ({ fade: 0, last: null as BeatFxSlot | null, building: null as BeatFxSlot | null }))
  let snapAt = -Infinity
  let prev: number | null = null
  return {
    update(now: number, fx: BeatFxHands, a: Pick<AudioFrame, 'beatPhase' | 'barPhase' | 'bpm'>): FxFrame {
      const dt = prev === null ? 0 : Math.max(0, now - prev)
      prev = now
      const hud: FxFrame['hud'] = []
      let speed = 1
      const slots = ([fx.left, fx.right] as const).map((slot, i): FxDraw => {
        const s = sides[i]!
        const live = slot && slot.fx !== 'glass' ? slot : null
        // BUILD ROLL let go (not just eased in): SNAP, once
        if (s.building && (!live || live.fx !== 'buildroll' || live.since !== s.building.since) && s.fade > 0.5 && !reduced) snapAt = now
        s.building = live?.fx === 'buildroll' ? live : null
        if (live && (!s.last || live.fx !== s.last.fx)) s.fade = s.last ? 0 : s.fade // a new FX on this hand eases in
        if (live) s.last = live
        s.fade = Math.min(1, Math.max(0, s.fade + (live ? dt / IN_MS : -dt / OUT_MS)))
        if (s.fade === 0 && !live) s.last = null
        const shown = live ?? s.last
        if (!shown || s.fade === 0) return OFF
        const amount = s.fade * Math.min(1, Math.max(0, shown.depth))
        if (live) hud.push({ label: FX_LABEL[live.fx], beat: live.label, depth: live.depth, step: gridStep(a, live.beat) })
        if (shown.fx === 'halftime') speed = Math.min(speed, 1 - 0.5 * amount)
        const beatMs = 60000 / Math.max(1, a.bpm || 120)
        return {
          mode: reduced ? 0 : FX_MODE[shown.fx],
          amount,
          phase: gridPhase(a, shown.beat),
          step: gridStep(a, shown.beat),
          build: Math.min(1, Math.max(0, (now - shown.since) / (BUILD_BEATS * beatMs))),
        }
      }) as [FxDraw, FxDraw]
      const snap = now - snapAt < SNAP_MS ? 1 - (now - snapAt) / SNAP_MS : 0
      // Reduced motion: no moves, only a held dim with the FX (a simple fade): mode 0 with an amount.
      return { slots, snap, speed, active: slots.some((s) => s.amount > 0) || snap > 0, hud }
    },
  }
}

/** The HUD's line for one FX: "WOBBLE · 1/8T · ▮▮▮▯▯ 61%". */
export function hudLine(h: { label: string; beat: string; depth: number }): string {
  const bars = Math.round(Math.min(1, Math.max(0, h.depth)) * 5)
  return `${h.label} · ${h.beat} · ${'▮'.repeat(bars)}${'▯'.repeat(5 - bars)} ${Math.round(h.depth * 100)}%`
}

/** How the two hands hold the strings (S1's cameraSignals: tension, tilt, shake; spec v1.1). */
export interface StringFeel {
  /** 0 slack (palms together) … 1 taut (1.6 shoulder widths apart). */
  tension: number
  /** -1 … 1: left palm to right palm, ±45° full, clockwise (the right hand lower) positive. */
  tilt: number
  /** 0-1: a 3-7 Hz tremble. */
  shake: number
}

/** The feel from S1's signals while both hands are seen (else null: the strings as they are). S1's fields are read
 *  as optional: before they land (or from a tracker without them) the strings stay as they are. */
export function stringFeel(signals: object, bothHands: boolean): StringFeel | null {
  const s = signals as { tension?: unknown; tilt?: unknown; shake?: unknown }
  if (!bothHands || typeof s.tension !== 'number') return null
  const n = (v: unknown, lo: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(lo, v)) : 0)
  return { tension: n(s.tension, 0), tilt: n(s.tilt, -1), shake: n(s.shake, 0) }
}

/** FINGER FILTERS (S1's top-level `fingers`: per hand [thumb, index, middle, ring, pinky] curls, 0 straight … 1 folded,
 *  deadbanded, no hysteresis; `stringsMode`: true while both hands play the strings): each string's cut 0-1, its
 *  finger's curl on either hand (the string runs between both fingertips: either folding cuts it; S2's sound agrees),
 *  in STRINGS' order. Undefined outside strings mode (an FX shape folds fingers too: those strings come back quietly)
 *  or before S1's fields land. */
export function fingerCuts(signals: object): number[] | undefined {
  const s = signals as { fingers?: unknown; stringsMode?: unknown }
  if (s.stringsMode !== true) return undefined
  const f = s.fingers as { left?: unknown; right?: unknown } | null | undefined
  if (!f || typeof f !== 'object') return undefined
  const n = (h: unknown, i: number) => {
    const v = Array.isArray(h) ? (h[i] as unknown) : undefined
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
  }
  return [0, 1, 2, 3, 4].map((i) => Math.max(n(f.left, i), n(f.right, i)))
}

/** `?strings-hands=1`: the ring finger folds away every 9 s for 2 s (its string snaps, then comes back with a pluck). */
export const synthCuts = (t: number): number[] => [0, 0, 0, t % 9 > 5 && t % 9 < 7 ? 1 : 0, 0]

export const TENSION_DEADBAND = 0.06 // the droop moves only past this much change in tension (hand-distance noise doesn't bob it)
export const TILT_DEADBAND = 0.15 // the slide's glow only past this tilt
export const SHAKE_FLOOR = 0.45 // a tremble only past this shake (S1: still hands 0, a deliberate shake ~0.8)

/** The feel as the strings show it (the user: "way too bouncy"): tension held (a static droop, moving only past
 *  TENSION_DEADBAND, then eased), tilt and shake only past their thresholds. Call it each frame with S1's raw feel. */
export function createFeelFilter() {
  let shown: StringFeel | null = null
  let last: number | null = null
  return (now: number, raw: StringFeel | null): StringFeel | null => {
    const dt = last === null ? 16 : Math.min(100, Math.max(0, now - last))
    last = now
    if (!raw) return (shown = null)
    const prev = shown ?? { tension: raw.tension, tilt: 0, shake: 0 }
    const ease = (from: number, to: number, ms: number) => from + (to - from) * Math.min(1, dt / ms)
    const tension = Math.abs(raw.tension - prev.tension) > TENSION_DEADBAND ? ease(prev.tension, raw.tension, 250) : prev.tension
    const tilt = ease(prev.tilt, Math.abs(raw.tilt) < TILT_DEADBAND ? 0 : raw.tilt, 150)
    const shake = Math.min(1, Math.max(0, (raw.shake - SHAKE_FLOOR) / (1 - SHAKE_FLOOR)))
    return (shown = { tension, tilt, shake })
  }
}

/** `?strings-hands=1`: the scripted hands' feel (they drift apart and together, tilt a little, now and then shake). */
export const synthFeel = (t: number): StringFeel => ({
  tension: 0.5 + 0.45 * Math.sin(t * 0.5),
  tilt: 0.5 * Math.sin(t * 0.37),
  shake: t % 9 > 7.5 ? 0.8 : 0,
})

// ------------------------------------------------------------------------------- the web mock's scripted FX (dev)

const DEMO: [BeatFxId, number, string][] = [
  ['wobble', 1 / 3, '1/8T'], ['riddim', 0.25, '1/16'], ['growl', 1, '1/4'], ['tearout', 0.5, '1/8'],
  ['subdrop', 1, '1/4'], ['halftime', 0.5, '1/8'], ['buildroll', 1 / 6, '1/16T'],
]
/** `?strings-hands=1`: an FX on the left hand every 4 s (3 s held, the next one each time), and every other one a second
 *  on the right; none while the scripted hands make the GLASS frame. `now` is performance.now(). */
export function synthBeatFx(t: number, now: number): BeatFxHands {
  if (t % 14 >= 8 && t % 14 < 11.5) return NONE // the glass's turn
  const k = Math.floor(t / 4)
  if (t % 4 >= 3) return NONE
  const since = now - (t % 4) * 1000
  const slot = (j: number, depth: number): BeatFxSlot => {
    const [fx, beat, label] = DEMO[j % DEMO.length]!
    return { fx, depth, beat, label, since }
  }
  const depth = 0.45 + 0.4 * Math.sin(t * 0.8) ** 2
  return { left: slot(k, depth), right: k % 2 ? slot(k + 3, 0.5) : null }
}
