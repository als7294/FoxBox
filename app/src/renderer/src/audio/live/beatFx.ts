/**
 * STRINGS' BEAT FX in the air (the spec v1.1, the user's bass remixes): each hand's shape, held, fires one bass-remix FX
 * (slip: letting go comes back in time; two hands, two layered); its height is the DEPTH, the strings' TENSION (S1's,
 * hand to hand: taut is faster) its BEAT (one hand: its x); with nothing held, a slack string is dark and a taut one
 * open. The strings' TILT slides the bass like a played 808 (snapping to minor-pentatonic steps up to ±24 semitones past
 * a ±4° dead zone, a ~35 ms glide), their SHAKE is its vibrato (past dancing's tremble). FRAME is GLASS (its sound is
 * the glass world's, in the sound map). Every FX engages on the next 16th with a pad hit, at full depth (the worklets).
 * FINGER FILTERS: in strings mode (S1's, both hands open) each folded finger cuts its band of the isolator, thumb SUB to
 * pinky HIGH, by S3's fingerCuts (the max of the two hands' curl: picture and sound agree); an FX shape reopens them.
 *
 *   FIST       TEAROUT     the bass driven and crushed; DEPTH the drive
 *   PEACE      RIDDIM      the bass chopped on the grid, BEAT the pattern (1/8T in the middle); DEPTH how hard
 *   PINCH      WOBBLE      the bass's LFO filter at BEAT (1/4 to 1/16T); DEPTH its depth and resonance
 *   OPEN PALM  GROWL       the bass talking: the height sweeps o, a, i
 *   HORNS      HALFTIME    the whole track at half time
 *   POINT DOWN SUB DROP    the bass an octave down, the rest dipping like a brake
 *   POINT UP   BUILD ROLL  a roll speeding up to 1/32 under a rising filter; letting go slams the drop back in
 *
 * soundMap's driver calls beatFxDrive once a stage frame (STRINGS_SOUND.drive); beatFx() / beatFxNow() are what's
 * firing, for S3's visuals and S4's cheat sheet (read them per frame).
 */
import { cameraSignals } from '@/components/camera/smartCamera'
import { fingerCuts } from '@/components/strings/beatFx'
import { CUTS, type SongFxParams } from './songFx'

export type BeatFxId = 'tearout' | 'riddim' | 'wobble' | 'growl' | 'halftime' | 'subdrop' | 'buildroll' | 'glass'
type FxShape = 'fist' | 'peace' | 'pinch' | 'open_palm' | 'horns' | 'point_up' | 'point_down'

export interface BeatFxSlot {
  fx: BeatFxId
  /** 0-1: the hand's height. */
  depth: number
  /** The FX's period in beats (quarter notes): 1/4 = 1, 1/8 = 0.5, 1/8T = 1/3, 1/16 = 0.25, 1/16T = 1/6. */
  beat: number
  /** As the HUD shows it: '1/4' … '1/16T'. */
  label: string
  /** performance.now() when this FX began. */
  since: number
}

/** S1's signals, as much as the FX read (structurally: they're S1's to type). */
interface FxHand {
  shape: FxShape | null
  height: number
  x: number
}
interface StringSignals {
  at?: number
  fxShapes?: { left: FxHand | null; right: FxHand | null } | null
  tension?: number
  tilt?: number
  shake?: number
  shapes?: { frame?: { held?: boolean } }
}

const SHAPE_FX: Record<FxShape, BeatFxId> = {
  fist: 'tearout', peace: 'riddim', pinch: 'wobble', open_palm: 'growl', horns: 'halftime', point_down: 'subdrop', point_up: 'buildroll',
}
/** BEAT's five steps, slack (or left) to taut (or right). */
export const BEAT_SLOTS = [
  { label: '1/4', beat: 1 },
  { label: '1/8', beat: 1 / 2 },
  { label: '1/8T', beat: 1 / 3 },
  { label: '1/16', beat: 1 / 4 },
  { label: '1/16T', beat: 1 / 6 },
] as const
const STALE_MS = 500
const DEAD_DEG = 4
const SLIDE_MAX = 24
const SLIDE_STEPS = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24] // minor pentatonic, two octaves

const clamp01 = (v: number | undefined) => Math.min(1, Math.max(0, Number.isFinite(v) ? (v as number) : 0))
export const beatSlot = (v: number) => BEAT_SLOTS[Math.round(clamp01(v) * 4)]!

/** The strings' tilt (−1..1, ±45°) as the bass's slide: 0 within ±4°, then to ±24 semitones at 45°, snapped to the
 *  nearest minor-pentatonic step; `prev` (last time's) holds until the tilt is half a semitone past the midpoint. */
export function slideSemis(tilt: number, prev = 0): number {
  const deg = Math.max(-45, Math.min(45, Number.isFinite(tilt) ? tilt * 45 : 0))
  const a = (Math.max(0, Math.abs(deg) - DEAD_DEG) * SLIDE_MAX) / (45 - DEAD_DEG)
  const cont = Math.sign(deg) * a
  const near = Math.sign(deg) * SLIDE_STEPS.reduce((b, st) => (Math.abs(st - a) < Math.abs(b - a) ? st : b))
  return Math.abs(cont - prev) < Math.abs(cont - near) + 0.5 ? prev : near
}

let state: { left: BeatFxSlot | null; right: BeatFxSlot | null } = { left: null, right: null }
let slide = 0

/** What each hand fires now (null: nothing). */
export const beatFx = (): { left: BeatFxSlot | null; right: BeatFxSlot | null } => state

/** The FX fired most recently (of the two hands), or fx null. */
export function beatFxNow(): { fx: BeatFxId | null; depth: number; beat: number; label: string } {
  const s = [state.left, state.right].filter((x): x is BeatFxSlot => x !== null).sort((a, b) => b.since - a.since)[0]
  return s ? { fx: s.fx, depth: s.depth, beat: s.beat, label: s.label } : { fx: null, depth: 0, beat: 0, label: '' }
}

/** The FX the hands ask for now (STRINGS' drive: soundMap merges it over the map's), and beatFx() updated. */
export function beatFxDrive(_dtS: number, nowMs: number, signals: StringSignals | null = cameraSignals() as unknown as StringSignals): Partial<SongFxParams> {
  const s = signals && nowMs - s0(signals.at) < STALE_MS ? signals : null
  const hands = s?.fxShapes ?? null
  const two = Boolean(hands?.left && hands?.right)
  const frame = Boolean(s?.shapes?.frame?.held)
  const next: typeof state = { left: null, right: null }
  for (const side of ['left', 'right'] as const) {
    const h = hands?.[side] ?? null
    const fx: BeatFxId | null = frame ? 'glass' : h?.shape ? SHAPE_FX[h.shape] : null
    if (!fx) continue
    const slot = beatSlot(two ? (s?.tension ?? 0) : (h?.x ?? 0.5))
    const prev = state[side]
    next[side] = { fx, depth: clamp01(h?.height), beat: slot.beat, label: slot.label, since: prev?.fx === fx ? prev.since : nowMs }
  }
  state = next
  const out: Partial<SongFxParams> = { iso: 1 } // FINGER FILTERS ready while STRINGS shows (all open: the song)
  const max = (k: keyof SongFxParams, v: number) => (out[k] = Math.max(out[k] ?? 0, v))
  for (const slot of [next.left, next.right]) {
    if (!slot) continue
    const d = slot.depth
    switch (slot.fx) {
      case 'tearout': max('tear', 0.6 + 0.4 * d); break
      case 'riddim': max('gate', 0.85 + 0.15 * d); out.gateRate = 1 / slot.beat; break
      case 'wobble': out.wobble = 1; max('wobbleDepth', 0.4 + 0.6 * d); out.wobbleRate = 1 / slot.beat; break
      case 'growl': out.growl = 1; out.vowel = d; break
      case 'halftime': out.halftime = 1; break
      case 'subdrop': out.subdrop = 1; break
      case 'buildroll': out.buildroll = 1; break
      case 'glass': break // the glass's sound is the world's: the sound map's
    }
  }
  if (s) {
    // with nothing held, the strings' tension filters the song: slack dark (a build), taut wide open
    if (two && !next.left && !next.right) out.filter = -0.8 * (1 - clamp01(s.tension))
    out.bassSemi = slide = two ? slideSemis(s.tilt ?? 0, slide) : 0
    out.vibrato = clamp01((clamp01(s.shake) - 0.25) / 0.55) // S1: dancing reads ~0.15 (none), a deliberate shake ~0.8 (full)
  }
  // FINGER FILTERS: strings mode only, and an FX shape takes over (every band back open)
  const cuts = s && !next.left && !next.right ? fingerCuts(s) : undefined
  CUTS.forEach((k, i) => (out[k] = cuts?.[i] ?? 0))
  return out
}

const s0 = (at: number | undefined) => (Number.isFinite(at) ? (at as number) : -Infinity)
