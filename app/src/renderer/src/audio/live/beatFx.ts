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
 *   HORNS      HALFTIME    the whole track at half time
 *   POINT DOWN SUB DROP    the bass an octave down, the rest dipping like a brake
 *   POINT UP   BUILD ROLL  a roll speeding up to 1/32 under a rising filter; letting go slams the drop back in
 *   (Edit shapes' others, any shape:)
 *              ECHO OUT    the song thrown into a dotted-1/8 echo, its dry dipping under it (DEPTH how far)
 *              STUTTER     a beat repeat on the grid, BEAT its length (1/4, 1/8, 1/16)
 *              LOOP 1 BAR  the last 4 beats looped (the frame's slip loop, quiet: no lock, no break)
 *              FILTER SWEEP a high-pass rising over one bar from the press; DEPTH how far
 * setBeatFxShapes() maps the shapes (Edit shapes); beatFxPads.hold / release are the Beat FX pads under the mouse (with
 * the hands: the deeper wins).
 *
 * soundMap's driver calls beatFxDrive once a stage frame (STRINGS_SOUND.drive); beatFx() / beatFxNow() are what's
 * firing, for S3's visuals and S4's cheat sheet (read them per frame).
 */
import { shapeActions, useShapeMap } from '@/components/camera/shapeMap'
import { cameraSignals } from '@/components/camera/smartCamera'
import { fingerCuts } from '@/components/strings/beatFx'
import { currentSongFx, CUTS, type SongFxParams } from './songFx'

/** 'growl' no longer fires (no shape since 2.0); it stays in the type until the sheet (S4's StringsPanel) drops its row. */
export type BeatFxId = 'tearout' | 'riddim' | 'wobble' | 'growl' | 'halftime' | 'subdrop' | 'buildroll' | 'echoout' | 'stutter' | 'loopbar' | 'sweep' | 'glass'
/** REMIX's actions, as Edit shapes and the Beat FX pads name them. */
export const REMIX_ACTIONS: readonly { id: BeatFxId | 'off'; label: string }[] = [
  { id: 'tearout', label: 'TEAROUT' }, { id: 'riddim', label: 'RIDDIM CHOPS' }, { id: 'wobble', label: 'WOBBLE' }, { id: 'halftime', label: 'HALFTIME' },
  { id: 'subdrop', label: 'SUB DROP' }, { id: 'buildroll', label: 'BUILD ROLL' }, { id: 'echoout', label: 'ECHO OUT' }, { id: 'stutter', label: 'STUTTER' },
  { id: 'loopbar', label: 'LOOP 1 BAR' }, { id: 'sweep', label: 'FILTER SWEEP' }, { id: 'off', label: 'OFF' },
]
type FxShape = 'fist' | 'peace' | 'pinch' | 'horns' | 'point_up' | 'point_down' // the open playing pose fires nothing (2.0)

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
  /** S1's FRAME (frameGestures): formed holds through a corner's tap and the turn over, where the raw L drops. */
  frame?: { formed?: boolean }
}

export const SHAPE_FX: Readonly<Record<FxShape, BeatFxId | 'off'>> = {
  fist: 'tearout', peace: 'riddim', pinch: 'wobble', horns: 'halftime', point_down: 'subdrop', point_up: 'buildroll',
}
let shapeFx: Record<FxShape, BeatFxId | 'off'> = { ...SHAPE_FX }
/** Edit shapes: what each shape fires (unnamed shapes keep theirs as made). */
export const setBeatFxShapes = (map: Partial<Record<FxShape, BeatFxId | 'off'>>): void => void (shapeFx = { ...SHAPE_FX, ...map })
// Edit shapes (S1's shapeMap, remembered across launches): REMIX's map, kept in step
const followShapeMap = () => setBeatFxShapes(shapeActions('remix'))
followShapeMap()
useShapeMap.subscribe(followShapeMap)
const pads = new Map<BeatFxId, { depth: number; since: number }>()
/** The Beat FX pads under the mouse: an action on (depth 0-1, as a hand's height; 1/8 its beat) until released. */
export const beatFxPads = {
  hold(action: BeatFxId, depth = 0.7): void {
    pads.set(action, { depth: clamp01(depth), since: pads.get(action)?.since ?? performance.now() })
  },
  release(action: BeatFxId): void {
    pads.delete(action)
  },
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

/** The FX S3's visuals draw (the Edit-shapes ones sound without a visual of their own yet). */
type VisualFx = Exclude<BeatFxId, 'echoout' | 'stutter' | 'loopbar' | 'sweep'>
type VisualSlot = BeatFxSlot & { fx: VisualFx }
const NO_VISUAL = new Set<BeatFxId>(['echoout', 'stutter', 'loopbar', 'sweep'])
const visual = (s: BeatFxSlot | null): VisualSlot | null => (s && !NO_VISUAL.has(s.fx) ? (s as VisualSlot) : null)

/** What each hand fires now (null: nothing), as S3's visuals draw it. */
export const beatFx = (): { left: VisualSlot | null; right: VisualSlot | null } => ({ left: visual(state.left), right: visual(state.right) })

const padSlots = (): BeatFxSlot[] => [...pads].map(([fx, p]) => ({ fx, depth: p.depth, beat: 0.5, label: '1/8', since: p.since }))
/** Every action on now (the hands' and the pads'): the pads light from these. */
export const beatFxActive = (): Set<BeatFxId> => new Set([state.left, state.right, ...padSlots()].filter((x): x is BeatFxSlot => x !== null).map((x) => x.fx))

/** The FX fired most recently (of the hands' and the pads'), or fx null. */
export function beatFxNow(): { fx: BeatFxId | null; depth: number; beat: number; label: string } {
  const s = [state.left, state.right, ...padSlots()].filter((x): x is BeatFxSlot => x !== null).sort((a, b) => b.since - a.since)[0]
  return s ? { fx: s.fx, depth: s.depth, beat: s.beat, label: s.label } : { fx: null, depth: 0, beat: 0, label: '' }
}

/** The FX the hands ask for now (STRINGS' drive: soundMap merges it over the map's), and beatFx() updated. */
export function beatFxDrive(_dtS: number, nowMs: number, signals: StringSignals | null = cameraSignals() as unknown as StringSignals): Partial<SongFxParams> {
  const s = signals && nowMs - s0(signals.at) < STALE_MS ? signals : null
  const hands = s?.fxShapes ?? null
  const two = Boolean(hands?.left && hands?.right)
  const frame = Boolean(s?.frame?.formed ?? s?.shapes?.frame?.held) // formed: not dropping mid-flip
  const next: typeof state = { left: null, right: null }
  for (const side of ['left', 'right'] as const) {
    const h = hands?.[side] ?? null
    const mapped = h?.shape ? shapeFx[h.shape] : null
    const fx: BeatFxId | null = frame ? 'glass' : mapped && mapped !== 'off' ? mapped : null
    if (!fx) continue
    const slot = beatSlot(two ? (s?.tension ?? 0) : (h?.x ?? 0.5))
    const prev = state[side]
    next[side] = { fx, depth: clamp01(h?.height), beat: slot.beat, label: slot.label, since: prev?.fx === fx ? prev.since : nowMs }
  }
  state = next
  const out: Partial<SongFxParams> = { iso: 1 } // FINGER FILTERS ready while STRINGS shows (all open: the song)
  const max = (k: keyof SongFxParams, v: number) => (out[k] = Math.max(out[k] ?? 0, v))
  const bpm = currentSongFx()?.bpm ?? 120
  for (const slot of [next.left, next.right, ...padSlots()]) {
    if (!slot) continue
    const d = Math.min(1, slot.depth * (currentSongFx()?.fxDepth ?? 1)) // the Board's FX depth
    switch (slot.fx) {
      case 'tearout': max('tear', 0.6 + 0.4 * d); break
      case 'riddim': max('gate', 0.85 + 0.15 * d); out.gateRate = 1 / slot.beat; break
      case 'wobble': out.wobble = 1; max('wobbleDepth', 0.4 + 0.6 * d); out.wobbleRate = 1 / slot.beat; break
      case 'halftime': out.halftime = 1; break
      case 'subdrop': out.subdrop = 1; break
      case 'buildroll': out.buildroll = 1; break
      case 'echoout': max('echo', 1); out.echoBeats = 0.75; max('echoOut', 0.5 + 0.45 * d); break
      case 'stutter': out.stutter = 1; out.stutterDiv = slot.beat >= 1 ? 4 : slot.beat >= 0.5 ? 8 : 16; break
      case 'loopbar': out.loopBar = 1; break
      case 'sweep': { // a high-pass up over one bar from the press
        const bar = Math.min(1, ((nowMs - slot.since) / 1000) * (bpm / 60) / 4)
        max('filter', (0.2 + 0.8 * bar) * (0.55 + 0.45 * d))
        max('resonance', 0.45)
        break
      }
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
