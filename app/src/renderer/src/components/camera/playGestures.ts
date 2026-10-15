/**
 * FoxBox 2.0's PLAY, the air instrument (no song): the gestures S2's instrument plays.
 * - PLUCK: folding a finger clearly past its own resting curl plucks (a C-shaped hand, half curled like holding a
 *   ball, is the playing pose: its rest is learned per finger as the hand settles), one event per fold (it re-arms
 *   back near its rest), its velocity from how fast it folded; coming back RELEASES it (the note held while it stays
 *   folded). Raw curls (fxShapes' fingerCurls, 3D: any way the hand faces), so a pluck waits on no smoothing. Nothing
 *   plucks while a FRAME is formed or being made (either hand an L's thumb and index, two more folded), and a hand's two or more at
 *   once wait PLUCK.CHORD_WAIT_MS for that (each L folds three fingers, often before it reads); three or more at once
 *   are a shape going in (a fist, a thumbs-up), silent. Nor while the hands overlap (one in front of the other), and
 *   a rise waits one result to be sure (a single result's jump isn't a fold).
 * - Each hand's height (normalised, steady) and the spread between them: S2 picks the note from either.
 * - FLOW: the right hand's height is the pitch, the spread between the hands opens the filter, a shake is vibrato, the
 *   tilt slides; a closed right fist (or no right hand) mutes. The left hand's height is there for the octave, and its
 *   shapes count. Left-handed (playPrefs), the hands swap. Pluck sensitivity (playPrefs) scales FIRE and EARLY.
 * - PLAY's shapes: FxShape's set (FIST, PINCH, PEACE, HORNS, POINT UP / DOWN; an open hand is the playing pose, never
 *   a shape), each with a depth (that hand's height). S2 gives them their sounds. None while a FRAME is being made.
 * - TWIST: each wrist's roll (the knuckle line's thumb end toward the camera or away, in 3D) from the hand's own
 *   resting roll (palms to the camera, or edge-on pointing in: either rests at 0), a pitch bend.
 * - FRAME: both hands an L, the frame held (HandShapes.frame, as REMIX's GLASS).
 * - progress: how many times each GUIDE step's move has been done (it ticks a step when its count goes up).
 *
 * Hands here are the PERFORMER's own: FoxBox's camera picture isn't mirrored, so their right hand is the picture's left
 * slot (HandShapes, FxSignals and cameraSignals' fingers are the picture's).
 */
import { follow, FRAME_HOLD_MS, isLPose, type HandShape, type HandShapes, type Pt } from './camMath'
import { fingerCurls, type FxShape, type FxSignals } from './fxShapes'
import { PLUCK_SCALE, usePlayPrefs, WOBBLE_MS } from './playPrefs'

export type PlayHand = 'left' | 'right'
export type PlayShape = FxShape

export interface PluckEvent {
  hand: PlayHand
  /** 0 the thumb … 4 the pinky. */
  finger: 0 | 1 | 2 | 3 | 4
  /** 0.1 a slow fold … 1 a fold in PLUCK.FAST_MS or less. */
  velocity: number
  /** That hand's height (PlaySignals.height): 0 low … 1 high. */
  height: number
  /** performance.now() when it fired. */
  t: number
  /** A ReleaseEvent follows (always: the finger coming back, or its hand lost): hold the note until then. */
  held: true
  /** How many of this hand's fingers plucked on this same result (1 or 2: three or more at once are a shape going in,
   *  silent). */
  together: number
}

export interface ReleaseEvent {
  hand: PlayHand
  finger: 0 | 1 | 2 | 3 | 4
  /** performance.now() when it straightened (or its hand was lost). */
  t: number
}

/** One hands result's events. */
export interface PlayEvents {
  plucks: PluckEvent[]
  releases: ReleaseEvent[]
}

export interface FlowSignal {
  /** The right hand's height (PlaySignals.height), 0-1 (its last while it's away); the left's, left-handed. */
  pitch: number
  /** The hands apart (PlaySignals.spread). */
  spread: number
  /** A 3-7 Hz tremble, 0-1 (fxShapes' shake). */
  shake: number
  /** -1 … 1: +1 the right hand 45° above the left (fxShapes' tilt: the picture's left slot is the right hand); the
   *  left above the right, left-handed. */
  tilt: number
  /** The right hand's four fingers folded (at once, from the curls), or no right hand; the left's, left-handed. */
  mute: boolean
  /** The left hand's height (PlaySignals.height), 0-1 (0.5 without it); the right's, left-handed. */
  octave: number
  /** The hand whose shapes count in FLOW: the left (the right, left-handed; the pitch is the other's); one-handed, the
   *  one hand. */
  shapeHand: PlayHand
  /** One-handed (playPrefs): the playing hand does it all, and the gap below opens the filter in place of the spread. */
  oneHanded: boolean
  /** The playing hand's thumb-index gap, 0 closed … 1 wide open (smoothed); 0 without one. */
  gap: number
}

export interface PlaySignals {
  flow: FlowSignal
  /** Each hand's held shape (null: none) and its depth (the hand's height); null: the hand isn't seen. */
  shapes: Record<PlayHand, { shape: PlayShape | null; depth: number } | null>
  /** Each wrist's roll, -1 … 1: +1 its thumb rolled TWIST_FULL toward the camera, -1 away; 0 within TWIST_DEAD of
   *  square to the camera, or unseen. Smoothed a frame. */
  twist: Record<PlayHand, number>
  /** Both hands an L making a frame, held. */
  frame: boolean
  progress: PlayProgress
  /** Each finger still folded since its pluck, thumb first (until its release). */
  held: Record<PlayHand, boolean[]>
  /** Each hand's height, 0 low … 1 high (its palm between HEIGHT_LOW and HEIGHT_HIGH of the picture), smoothed and
   *  steady (a re-found hand's first result doesn't move it); null: the hand's gone. */
  height: Record<PlayHand, number | null>
  /** The hands apart, 0 palms together … 1 at SPREAD_PALMS palm widths (near or far the same), smoothed; held while a
   *  hand is missing (no jump when it's re-found). */
  spread: number
  /** One-handed: the playing hand (the performer's) and its slot in the picture (cameraSignals().stage[slot]); null
   *  otherwise, or with no hand seen. */
  one: { hand: PlayHand; slot: 'left' | 'right' } | null
}

/** The GUIDE's "you did it": how many times each move has been done since the camera started (only ever goes up). */
export interface PlayProgress {
  /** Both hands up. */
  hands: number
  pluck: number
  /** A wrist rolled past half a bend. */
  twist: number
  /** A shake past SHAKE_DONE. */
  shake: number
  /** A hand raised or lowered into another third of the picture (the octave). */
  octave: number
  /** A PINCH held. */
  pinch: number
  /** A frame made (held). */
  frame: number
  /** FLOW's pitch (the right hand's height) moved PITCH_DONE. */
  pitch: number
}

/** PLUCK's feel, in one place (the user judges it by hand). Curls 0 straight … 1 a fist's fold, each against the
 *  finger's own RESTING curl (its C). A finger re-arms (and releases) back within ARM of its rest; it plucks on the
 *  result its curl is seen RISING past FIRE over its rest (or past EARLY while folding at EARLY_SPEED or faster: a quick
 *  fold sounds a result sooner) from the result just before. One pluck per fold however it wavers (it must re-arm
 *  first); a curl that's simply there after the hand was missing or a stall (REFOUND_MS) never plucks: the tracker
 *  re-finding a moving hand misreads open fingers as folded, and the misread holds a few results. */
export const PLUCK = {
  /** Two or more of a hand's fingers at once wait this long, dropped if a frame shows on its way meanwhile. */
  CHORD_WAIT_MS: 120,
  /** This many or more of a hand's fingers folding at once (within CHORD_WAIT_MS) are a shape going in (a fist, a
   *  thumbs-up, an L): silent. */
  SHAPE_FOLD: 3,
  /** A shape gone in, that hand's later folds this long after are its stragglers (a fist's fourth finger a result
   *  behind the rest, fast at 30 a second): silent too. */
  SHAPE_QUIET_MS: 250,
  /** A frame on its way: an L's thumb and index, and two of the other three curled this far (a C's rest about 0-0.35). */
  L_FOLDED: 0.5,
  /** A finger's bends (degrees, added up) for a whole fold: a fist's (fxShapes' curls are full at 165°, a C's would be
   *  most of the way there). */
  BEND_FOLDED: 240,
  ARM: 0.15,
  FIRE: 0.45,
  EARLY: 0.3,
  /** FIRE no higher than this (a tight C still plucks on a fist). */
  FIRE_CAP: 0.9,
  /** Curl per second: a whole fold in about 280 ms. */
  EARLY_SPEED: 3.5,
  /** A fold from rest to a fist this quick: velocity 1. */
  FAST_MS: 100,
  /** Every pluck sounds. */
  MIN_VELOCITY: 0.1,
  /** A pluck is a fold: its rise at this speed at least (curl a second). A held fist's index creeping past FIRE as
   *  its rest catches up is no pluck (N04's thumbs-up, a velocity of 0.1). */
  MIN_SPEED: 1.5,
  /** No result for this long and the hand moved REFOUND_MOVE palm widths meanwhile: the next is a stall's catch-up on a
   *  moving hand (the tracker misreads it), not a rise seen, as after the hand was missing. A hand folding in place
   *  through a slow result plucks as ever. */
  REFOUND_MS: 120,
  REFOUND_MOVE: 0.25,
  /** A finger's resting curl follows it down this quickly (opening is a new rest at once), up this slowly (a fold
   *  isn't a rest; a hand settling into its C is); frozen while it's held. */
  REST_DOWN_MS: 60,
  REST_UP_MS: 3000,
  /** Results in a row back within ARM to re-arm (and release), and that long at least: one fold misread as fold, dip,
   *  fold (a 70 ms dip at 30 a second) isn't two plucks; a finger resting folded isn't re-armed by one misread result. */
  ARM_RESULTS: 2,
  ARM_MS: 80,
  /** The hand moving this fast (palm lengths a second; a playing hand under 0.5): no plucks (a blurred hand's curls jump
   *  for a result or two: N05). */
  MOVE_MAX: 3,
  /** Results in a row past FIRE for each finger to pluck, thumb first: a curl jumps for single results (a hand moving
   *  fast, a C's thumb seen side-on), so a rise waits for the next result (at 30 a second, 33 ms). */
  CONFIRM: [2, 2, 2, 2, 2],
  /** The hands overlapping (one passing in front of the other: the hidden one's curls are guesses), and this long
   *  after: no plucks. */
  CROSS_MS: 200,
  CROSS_SHARE: 0.3,
  /** The fingers that pluck, thumb first. Not the thumb: on a hand seen side-on (the C) its curl misreads for results at
   *  a time, both ways it's measured at once, and any finger plays its hand's note. */
  PLUCKS: [false, true, true, true, true],
  /** A finger resting folded past this (a pose's held-down fingers) doesn't pluck: no clear fold left to make, and its
   *  ARM and FIRE are too close for the tracker's noise. */
  REST_MAX: 0.5,
}

/** PLAY's PINCH: the thumb's tip closing on the index's well under the hand's own resting gap (a C rests with them
 *  close, holding a ball): under GAP_RATIO of it and GAP_MAX palm lengths, in 3D. */
const PINCH = { GAP_RATIO: 0.4, GAP_MAX: 0.15, OPEN: 1.6, HOLD_MS: 150, REST_UP_MS: 300, REST_DOWN_MS: 3000 }
/** PLAY's shapes are meant: held this long (fxShapes holds 150 ms) with no pluck on that hand for QUIET_MS, and the
 *  hand out of its C (DEPARTED fingers folded PAST over their own rest). A hand playing from its C passes through
 *  PEACE, FIST and the rest as its fingers fold, and a resting C (its ring and pinky curled more) can look like PEACE
 *  to the picture's rules; neither is a shape. */
const SHAPE = { HOLD_MS: 250, QUIET_MS: 300, DEPARTED: 2, PAST: 0.35 }
const MUTE = 0.7 // the right hand's four fingers all folded past this: a fist (also PLAY's FIST: a C never is)
const HEIGHT_LOW = 0.15 // the picture's height a palm's at, low …
const HEIGHT_HIGH = 0.85 // … and high
const SPREAD_PALMS = 8 // palm widths apart: spread 1
const STEADY_MS = 80 // height and spread's smoothing
const LOST_MS = 300 // a hand unseen this long is gone (fxShapes' too): a dropped frame keeps it armed
const TWIST_DEAD = 15 // degrees of roll that read 0 (a resting hand is rarely square to the camera)
const TWIST_FULL = 60 // degrees: full bend
const TWIST_MS = 40 // its smoothing
const TWIST_REST_MS = 4000 // the hand's resting roll follows it this slowly (a twist held a second barely moves it) …
const TWIST_SETTLE_MS = 400 // … but quickly in the hand's first second (it settles into its pose)
const SHAKE_DONE = 0.4 // progress: a shake counts past this, again once it's under SHAKE_DONE / 3
const PITCH_DONE = 0.2 // progress: the right hand's height moved this far

/** The performer's hand → the picture's slot. */
export const SLOT = { right: 'left', left: 'right' } as const
/** One-handed's default reach (the palm's height up the picture) without a calibration: around chest height, no note
 *  above the shoulder; two-handed uses HEIGHT_LOW / HEIGHT_HIGH. */
const RAW_MS = 500 // captureReach's window
const ONE_LOW = 0.15
const ONE_HIGH = 0.62
/** The thumb-index gap (palm lengths) read as FLOW's filter: closed at GAP_SHUT, wide open at GAP_OPEN. */
const GAP_SHUT = 0.25
const GAP_OPEN = 1.4

/** One-handed (playPrefs): the hand that plays, the performer's: with both in view Left-handed picks (the right, or the
 *  left), else the one seen; null when one-handed is off or no hand is seen. */
export function playingHand(shapes: HandShapes): PlayHand | null {
  const { oneHanded, leftHanded } = usePlayPrefs.getState()
  if (!oneHanded) return null
  const [r, l] = [!!shapes[SLOT.right], !!shapes[SLOT.left]]
  return r && l ? (leftHanded ? 'left' : 'right') : r ? 'right' : l ? 'left' : null
}

export const NO_PLAY: PlaySignals = {
  flow: { pitch: 0, spread: 0, shake: 0, tilt: 0, mute: true, octave: 0.5, shapeHand: 'left', oneHanded: false, gap: 0 },
  shapes: { left: null, right: null },
  twist: { left: 0, right: 0 },
  frame: false,
  progress: { hands: 0, pluck: 0, twist: 0, shake: 0, octave: 0, pinch: 0, frame: 0, pitch: 0 },
  held: { left: [false, false, false, false, false], right: [false, false, false, false, false] },
  height: { left: null, right: null },
  spread: 0,
  one: null,
}

/** One hand over the other: their boxes (their points' extents) sharing a third of the smaller (fingertips meeting
 *  don't). */
function overlap(a: readonly Pt[], b: readonly Pt[]): boolean {
  const box = (p: readonly Pt[]) => [Math.min(...p.map((q) => q.x)), Math.min(...p.map((q) => q.y)), Math.max(...p.map((q) => q.x)), Math.max(...p.map((q) => q.y))]
  const [ax0, ay0, ax1, ay1] = box(a) as [number, number, number, number]
  const [bx0, by0, bx1, by1] = box(b) as [number, number, number, number]
  const shared = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0)) * Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0))
  return shared > PLUCK.CROSS_SHARE * Math.min((ax1 - ax0) * (ay1 - ay0), (bx1 - bx0) * (by1 - by0))
}

/** A wrist's roll in degrees, -180 … 180, about the hand's own long axis (wrist to the middle knuckle): the knuckle
 *  line (the pinky's 17 to the index's 5) against the picture's plane, + as its thumb end turns toward the camera (in
 *  the world landmarks, 3D; smaller z is nearer). 0: a hand of this one's build square to the camera; its mirror twin
 *  (the other hand) reads about 180 there and turns the other way. Null without world landmarks. */
export function wristRoll(h: HandShape): number | null {
  const w = h.world
  if (!w) return null
  const v = (a: number, b: number) => [w[b]!.x - w[a]!.x, w[b]!.y - w[a]!.y, w[b]!.z - w[a]!.z]
  const a = v(0, 9)
  const l = v(17, 5)
  // The knuckle line off the hand's long axis (a bent wrist doesn't read as a roll), against the picture's line square
  // to that axis (the axis crossed with the view: a x z).
  const al = (a[0]! * l[0]! + a[1]! * l[1]! + a[2]! * l[2]!) / (a[0]! ** 2 + a[1]! ** 2 + a[2]! ** 2 || 1e-9)
  const p = l.map((x, i) => x - al * a[i]!)
  return (Math.atan2(-p[2]!, (p[0]! * a[1]! - p[1]! * a[0]!) / (Math.hypot(a[0]!, a[1]!) || 1e-9)) * 180) / Math.PI
}

const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180

interface Hand {
  /** One-handed: its thumb-index gap, 0 shut … 1 open (smoothed); its heights up the picture lately (captureReach);
   *  its last named shape and when (Wobble tolerance keeps it through a short misread). */
  gapN: number
  raws: { t: number; v: number }[]
  lastShape: PlayShape | null
  lastShapeAt: number
  /** A rise seen, waiting on CONFIRM (the curl it rose from, and its speed). */
  pending: ({ was: number; speed: number } | null)[]
  /** The thumb-index gap (3D, in palm lengths) at rest, and PLAY's pinch (with its candidate's since). */
  gapRest: number | null
  pinched: boolean
  pinchSince: number
  armed: boolean[]
  /** Results in a row each finger's been back within ARM, and since when. */
  back: number[]
  backAt: number[]
  /** Plucked and still folded. */
  held: boolean[]
  /** PLUCK's curls (deeper than fxShapes'), and each finger's resting curl (null until the hand's second result). */
  curl: number[]
  rest: number[] | null
  /** Its height (0-1, steady), and where it is for the spread (square-pixel centre, palm width). */
  height: number
  centre: { x: number; y: number }
  palm: number
  at: number
  /** First seen. */
  born: number
  twist: number
  /** Its resting roll (degrees), followed slowly. */
  roll: number | null
  /** Missing from a result since it was last seen. */
  missed: boolean
  /** This result's a steady one (not just re-found or after a stall). */
  steady: boolean
  /** Its last pluck (performance.now()). */
  plucked: number
  /** When its last shape went in (SHAPE_FOLD's silence). */
  shapeAt: number
  /** The thumb on the index now, unheld (a quick tap: the FRAME's cycle while PLAY's loop is latched). */
  tapping: boolean
}

export class PlayGestures {
  private hands: Record<PlayHand, Hand | null> = { left: null, right: null }
  /** One-handed: the playing hand, kept while it's briefly unseen. */
  private one: PlayHand | null = null
  /** A hand's plucks of two or more fingers at once (and any after them meanwhile), held CHORD_WAIT_MS: an L's thumb
   *  and index showing by then, they were a frame being made (its folds often come before either L reads: its thumb
   *  lags), not a chord. */
  private waiting: Record<PlayHand, PluckEvent[]> = { left: [], right: [] }
  private crossed = -1e9 // the hands last seen overlapping
  private last: PlaySignals = NO_PLAY
  private done = { ...NO_PLAY.progress }
  /** What's on now, for the counts' rising edges; the octave third each hand is in; FLOW's pitch at its last count. */
  private on = { hands: false, twist: false, shake: false, pinch: false, frame: false }
  private third: Record<PlayHand, number | null> = { left: null, right: null }
  private pitchFrom: number | null = null
  private spread = 0
  private spreadAt = 0

  /** A count goes up as `now` turns true (`off`: what turns it false again, default !now). */
  private edge(k: keyof PlayGestures['on'], now: boolean, off = !now): void {
    if (now && !this.on[k]) this.done[k]++
    if (now) this.on[k] = true
    else if (off) this.on[k] = false
  }

  /** One new hands result (after fxShapes' step on it): the plucks and releases it fired. `aspect`: the frame's width
   *  over its height. `frame` (frameGestures): formed or PLAY's loop latched, a pinch is the frame's (a style cycle),
   *  neither WOBBLE nor a pluck of the closing index; formed or being made (an L's thumb and index), nothing plucks. */
  step(shapes: HandShapes, fx: FxSignals, now: number, aspect: number, frame = { formed: false, latched: false }): PlayEvents {
    const framed = frame.formed || frame.latched
    const { leftHanded, sensitivity, oneHanded, wobble, reach } = usePlayPrefs.getState()
    const scale = PLUCK_SCALE[sensitivity]
    const one = playingHand(shapes)
    if (one) this.one = one
    else if (!oneHanded) this.one = null
    // A frame formed, or on its way (either hand's thumb and index in an L with two of its other three folded: the
    // other hand's L often reads a result later): nothing plucks (making the Ls folds three fingers each; held, turned
    // or wobbling, they move). A C turned toward the camera has an L's thumb and index, its other fingers out.
    const making = (h: HandShape | null) =>
      !!h && isLPose(h, aspect) && fingerCurls(h, aspect, PLUCK.BEND_FOLDED).slice(2).filter((c) => c >= PLUCK.L_FOLDED).length >= 2
    if (shapes.left && shapes.right && overlap(shapes.left.points, shapes.right.points)) this.crossed = now
    const still = frame.formed || making(shapes.left) || making(shapes.right) || now - this.crossed < PLUCK.CROSS_MS
    const plucks: PluckEvent[] = []
    const releases: ReleaseEvent[] = []
    const release = (hand: PlayHand, s: Hand, f: number) => {
      s.held[f] = false
      const w = this.waiting[hand]
      const i = w.findIndex((p) => p.finger === f)
      if (i >= 0) w.splice(i, 1) // back before it sounded: neither
      else releases.push({ hand, finger: f as ReleaseEvent['finger'], t: now })
    }
    for (const hand of ['left', 'right'] as const) {
      // One-handed: the other hand is ignored (no strings, no shapes); its notes end.
      if (oneHanded && one && hand !== one) {
        const ig = this.hands[hand]
        if (ig) ig.held.forEach((on, f) => on && release(hand, ig, f))
        this.hands[hand] = null
        this.waiting[hand] = []
        continue
      }
      const h = shapes[SLOT[hand]]
      const s = this.hands[hand]
      if (!h) {
        if (s && now - s.at > LOST_MS) {
          s.held.forEach((on, f) => on && release(hand, s, f)) // its notes end with it
          this.hands[hand] = null
        } else if (s) s.missed = true
        continue
      }
      const curl = fingerCurls(h, aspect, PLUCK.BEND_FOLDED)
      const q = h.points.map((p) => ({ x: p.x * aspect, y: p.y }))
      const centre = [0, 5, 9, 13, 17].reduce((a, i) => ({ x: a.x + q[i]!.x / 5, y: a.y + q[i]!.y / 5 }), { x: 0, y: 0 })
      const palm = Math.hypot(q[9]!.x - q[0]!.x, q[9]!.y - q[0]!.y)
      // Its height: the palm up the picture over the reach (one-handed: the calibrated one, or ONE_LOW-ONE_HIGH).
      const [lo, hi] = oneHanded ? (reach ? [reach.low, reach.high] : [ONE_LOW, ONE_HIGH]) : [HEIGHT_LOW, HEIGHT_HIGH]
      const height = Math.min(1, Math.max(0, (1 - centre.y - lo) / (hi - lo)))
      // A new hand's first result arms nothing and rests nothing (straight off the palm detector it reads half bent):
      // a hand that comes up already folded never plucks.
      if (!s) {
        const off = [false, false, false, false, false]
        this.hands[hand] = { pending: [null, null, null, null, null], gapRest: null, pinched: false, pinchSince: -1, armed: off.slice(), back: [0, 0, 0, 0, 0], backAt: [0, 0, 0, 0, 0], held: off.slice(), curl, rest: null, height, centre, palm, at: now, born: now, twist: 0, roll: null, missed: false, steady: false, plucked: -1e9, shapeAt: -1e9, tapping: false, gapN: 0, raws: [], lastShape: null, lastShapeAt: -1e9 }
        continue
      }
      const dt = Math.max(1, now - s.at)
      const moved = Math.hypot(centre.x - s.centre.x, centre.y - s.centre.y) / Math.max(s.palm, 1e-6)
      const fast = (moved / Math.max(1, now - s.at)) * 1000 >= PLUCK.MOVE_MAX
      const refound = s.missed || (dt > PLUCK.REFOUND_MS && moved > PLUCK.REFOUND_MOVE)
      s.missed = false
      s.steady = !refound
      // Where it is: steady (a re-found hand's first result, often misplaced, doesn't move it).
      if (!refound) {
        s.height = follow(s.height, height, dt, STEADY_MS, STEADY_MS)
        s.centre = centre
        s.palm = palm
        s.raws = [...s.raws.filter((r) => now - r.t < RAW_MS), { t: now, v: 1 - centre.y }]
      }
      // PINCH: the gap well under its own rest (up at once, down slowly, frozen while pinched), held PINCH.HOLD_MS.
      const w = h.world ?? h.points.map((p) => ({ x: p.x * aspect, y: p.y, z: 0 }))
      const gap = Math.hypot(w[4]!.x - w[8]!.x, w[4]!.y - w[8]!.y, w[4]!.z - w[8]!.z) / (Math.hypot(w[0]!.x - w[9]!.x, w[0]!.y - w[9]!.y, w[0]!.z - w[9]!.z) || 1e-6)
      if (!refound) {
        if (s.gapRest == null) s.gapRest = gap
        else if (!s.pinched) s.gapRest = follow(s.gapRest, gap, dt, PINCH.REST_UP_MS, PINCH.REST_DOWN_MS)
        s.gapN = follow(s.gapN, Math.min(1, Math.max(0, (gap - GAP_SHUT) / (GAP_OPEN - GAP_SHUT))), dt, STEADY_MS, STEADY_MS)
        const shut = Math.min(PINCH.GAP_RATIO * s.gapRest, PINCH.GAP_MAX)
        s.tapping = gap < Math.min(0.5 * s.gapRest, 0.2)
        const flip = s.pinched ? gap > shut * PINCH.OPEN : gap < shut
        if (!flip) s.pinchSince = -1
        else if (s.pinchSince < 0) s.pinchSince = now
        else if (now - s.pinchSince >= PINCH.HOLD_MS) {
          s.pinched = !s.pinched
          s.pinchSince = -1
        }
      }
      const roll = wristRoll(h) ?? 0
      const settle = now - s.born < 1000 ? TWIST_SETTLE_MS : TWIST_REST_MS
      s.roll = s.roll == null ? roll : wrap(s.roll + wrap(roll - s.roll) * (1 - Math.exp(-dt / settle)))
      // The left hand is the right's mirror twin: the same roll of the thumb toward the camera turns the other way.
      const off = (hand === 'right' ? 1 : -1) * wrap(roll - s.roll)
      const bend = Math.sign(off) * Math.min(1, Math.max(0, (Math.abs(off) - TWIST_DEAD) / (TWIST_FULL - TWIST_DEAD)))
      s.twist = follow(s.twist, bend, dt, TWIST_MS, TWIST_MS)
      // Framed: the index closing on the thumb (its gap halved from its rest) is a pinch on its way, not a pluck.
      const closing = s.gapRest != null && gap < 0.6 * s.gapRest
      // Each finger's rest: down at once, up slowly, frozen while it's held (refound results don't count).
      const rest = (s.rest ??= curl.slice())
      if (!refound) curl.forEach((c, f) => !s.held[f] && (rest[f] = follow(rest[f]!, c, dt, PLUCK.REST_UP_MS, PLUCK.REST_DOWN_MS)))
      const fired = plucks.length
      curl.forEach((c, f) => {
        const was = s.curl[f]!
        const speed = (c - was) / dt // curl per ms
        const fire = Math.min(rest[f]! + PLUCK.FIRE * scale, PLUCK.FIRE_CAP)
        const early = Math.min(rest[f]! + PLUCK.EARLY * scale, fire - 0.05)
        const arm = Math.min(rest[f]! + PLUCK.ARM, fire - 0.2)
        const rose = !refound && was < fire && speed * 1000 >= PLUCK.MIN_SPEED && (c >= fire || (c >= early && speed * 1000 >= PLUCK.EARLY_SPEED))
        s.back[f] = c <= arm ? s.back[f]! + 1 : 0
        if (s.back[f] === 1) s.backAt[f] = now
        // A rise waits CONFIRM results (the thumb two): still up on the next, it plucks; down again, it was a misread.
        const wait = s.pending[f]
        const confirmed = wait && !refound && c >= Math.min(early, fire) ? wait : null
        if (wait && !confirmed) s.pending[f] = null
        if (s.back[f]! >= PLUCK.ARM_RESULTS && now - s.backAt[f]! >= PLUCK.ARM_MS) {
          s.armed[f] = true
          s.pending[f] = null
          if (s.held[f]) release(hand, s, f) // back to its rest: the note's let go
        } else if (!PLUCK.PLUCKS[f] || rest[f]! > PLUCK.REST_MAX || still || fast || now - s.shapeAt < PLUCK.SHAPE_QUIET_MS || (framed && f === 1 && closing)) {
          // a thumb, a finger resting folded, a frame formed or being made, or the index closing on the thumb while
          // framed (a cycle): never plucks
        } else if (s.armed[f] && rose && PLUCK.CONFIRM[f]! > 1 && !wait) {
          s.pending[f] = { was, speed }
        } else if (s.armed[f] && (confirmed || (rose && PLUCK.CONFIRM[f]! <= 1))) {
          const from = confirmed ?? { was, speed }
          s.pending[f] = null
          s.armed[f] = false
          s.held[f] = true
          plucks.push({
            hand,
            finger: f as PluckEvent['finger'],
            // From rest to a full fold in FAST_MS: 1 (a C has less far to go than an open hand).
            velocity: Math.max(PLUCK.MIN_VELOCITY, Math.min(1, (from.speed * PLUCK.FAST_MS) / Math.max(0.3, 1 - rest[f]!))),
            height: s.height,
            t: now,
            held: true,
            together: 0,
          })
        }
      })
      const mine = plucks.slice(fired)
      mine.forEach((p) => (p.together = mine.length))
      // Two or more at once, or one with another finger's rise still being confirmed (an L's folds, a result apart at
      // 30 a second), wait as a chord.
      const others = mine.length === 1 && s.pending.some((p, f) => !!p && f !== mine[0]!.finger)
      if (mine.length > 1 || others || this.waiting[hand].length) this.waiting[hand].push(...plucks.splice(fired))
      if (mine.length) s.plucked = now
      s.curl = curl
      s.at = now
    }
    for (const hand of ['left', 'right'] as const) {
      const w = this.waiting[hand]
      const s = this.hands[hand]
      if (still || w.length >= PLUCK.SHAPE_FOLD) {
        w.forEach((p) => s && (s.held[p.finger] = false)) // never sounded
        if (s && w.length >= PLUCK.SHAPE_FOLD) s.shapeAt = now
      } else if (w.length && now - w[0]!.t >= PLUCK.CHORD_WAIT_MS) plucks.push(...w)
      else continue
      this.waiting[hand] = []
    }
    const right = fx.hands?.[SLOT.right] ?? null
    const left = fx.hands?.[SLOT.left] ?? null
    const isFist = (s: Hand | null) => !!s && s.curl.slice(1).every((c) => c >= MUTE)
    // FLOW's hands: the lead's height the pitch (its fist mutes), the other's the octave and its shapes.
    const [lead, other]: PlayHand[] = oneHanded ? [this.one ?? 'right', this.one ?? 'right'] : leftHanded ? ['left', 'right'] : ['right', 'left']
    const leadFx = fx.hands?.[SLOT[lead!]] ?? null
    const fist = isFist(this.hands[lead!])
    // The spread: both hands seen and settled this result, else held (no jump as one's re-found).
    const [r, l] = [this.hands.right, this.hands.left]
    if (r && l && r.at === now && l.at === now && r.steady && l.steady) {
      const gap = Math.hypot(r.centre.x - l.centre.x, r.centre.y - l.centre.y) / (SPREAD_PALMS * Math.max(r.palm, l.palm, 1e-6))
      this.spread = follow(this.spread, Math.min(1, gap), Math.max(1, now - this.spreadAt), STEADY_MS, STEADY_MS)
      this.spreadAt = now
    }
    this.done.pluck += plucks.length
    this.edge('hands', !!left && !!right)
    const twists = [this.hands.left?.twist ?? 0, this.hands.right?.twist ?? 0].map(Math.abs)
    this.edge('twist', Math.max(...twists) >= 0.5, Math.max(...twists) < 0.25)
    this.edge('shake', fx.shake >= SHAKE_DONE, fx.shake < SHAKE_DONE / 3)
    this.edge('pinch', !!this.hands.left?.pinched || !!this.hands.right?.pinched)
    this.edge('frame', shapes.frame.held)
    for (const [hand, s] of [['left', left], ['right', right]] as const) {
      // Its third of the picture, with a margin: a hand resting on a line doesn't count.
      const was = this.third[hand]
      const h = s?.height
      if (h == null) continue
      const t = Math.min(2, Math.floor(h * 3))
      if (was == null) this.third[hand] = t
      else if (t !== was && Math.abs(h - (Math.max(t, was) / 3)) > 0.05) {
        this.third[hand] = t
        this.done.octave++
      }
    }
    if (leadFx) {
      if (this.pitchFrom == null) this.pitchFrom = leadFx.height
      else if (Math.abs(leadFx.height - this.pitchFrom) >= PITCH_DONE) {
        this.done.pitch++
        this.pitchFrom = leadFx.height
      }
    }
    // A frame being made (two Ls, held or not yet): its Ls aren't shapes.
    const framing = now - shapes.frame.seen <= FRAME_HOLD_MS
    // PLAY's FIST is all four fingers folded (its own curls), its PINCH the gap shut well under its rest (PINCH): a C
    // (half curled, the thumb near the index) that the recognizer or the picture calls a fist or a pinch is neither.
    const shape = (s: NonNullable<FxSignals['hands']>['left'], hand: PlayHand) => {
      if (!s || (oneHanded && one && hand !== one)) return null
      const mine = this.hands[hand]
      const quiet = !mine || now - mine.plucked >= SHAPE.QUIET_MS
      const departed = !!mine && mine.curl.slice(1).filter((c, i) => c >= (mine.rest?.[i + 1] ?? 0) + SHAPE.PAST).length >= SHAPE.DEPARTED
      const meant = quiet && departed && s.since > 0 && now - s.since >= SHAPE.HOLD_MS
      const named: PlayShape | null = mine?.pinched ? (quiet && !framed ? 'pinch' : null) : !meant || s.shape === 'pinch' || (s.shape === 'fist' && !isFist(mine)) ? null : s.shape
      // One-handed (a hold toggles it): the shape kept through a misread shorter than Wobble tolerance, or while the
      // raw read is the same shape coming back (its own hold restarting).
      let kept = named
      if (oneHanded && mine) {
        if (named) [mine.lastShape, mine.lastShapeAt] = [named, now]
        else if (mine.lastShape && (s.shape === mine.lastShape || now - mine.lastShapeAt < WOBBLE_MS[wobble])) {
          kept = mine.lastShape
          if (s.shape === mine.lastShape) mine.lastShapeAt = now
        } else mine.lastShape = null
      }
      return { shape: framing ? null : kept, depth: s.height }
    }
    this.last = {
      flow: {
        pitch: this.hands[lead!]?.height ?? this.last.flow.pitch,
        spread: this.spread,
        shake: fx.shake,
        tilt: oneHanded ? 0 : leftHanded ? -fx.tilt : fx.tilt, // up: the lead hand the higher
        mute: !leadFx || fist,
        octave: oneHanded ? 0.5 : (this.hands[other!]?.height ?? 0.5),
        shapeHand: other!,
        oneHanded,
        gap: this.hands[lead!]?.gapN ?? 0,
      },
      shapes: { left: shape(left, 'left'), right: shape(right, 'right') },
      twist: { left: this.hands.left?.twist ?? 0, right: this.hands.right?.twist ?? 0 },
      frame: shapes.frame.held,
      progress: { ...this.done },
      held: { left: this.hands.left?.held.slice() ?? NO_PLAY.held.left, right: this.hands.right?.held.slice() ?? NO_PLAY.held.right },
      height: { left: this.hands.left?.height ?? null, right: this.hands.right?.height ?? null },
      spread: this.spread,
      one: one ? { hand: one, slot: SLOT[one] } : null,
    }
    return { plucks, releases }
  }

  signals(): PlaySignals {
    return this.last
  }

  /** One-handed's reach calibration: the playing hand's height up the picture over the last RAW_MS (0 low … 1 high),
   *  null without one. */
  reachNow(): number | null {
    const raws = (this.one && this.hands[this.one]?.raws) || []
    return raws.length ? raws.reduce((a, r) => a + r.v, 0) / raws.length : null
  }

  /** A quick pinch (the thumb on the index, unheld) on each performer hand now: frameGestures' cycles while PLAY's loop
   *  is latched. */
  taps(): Record<PlayHand, boolean> {
    return { left: !!this.hands.left?.tapping, right: !!this.hands.right?.tapping }
  }
}
