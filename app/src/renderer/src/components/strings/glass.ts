/**
 * STRINGS' FRAME (2.0, the user: "frames should feel cooler and more important", then "frames should show the last 4
 * beat loop with different effects and pinching while in a frame should change the frame style"): make S1's FRAME
 * with your hands (an L each) and a pane forms exactly in it, its four corners, size and tilt, with a little depth.
 * Outside the frame nothing changes (the live camera); inside it plays back the camera's LAST 4 BEATS, looping on the
 * beat, through the frame's style (the design's six: ECHO TRAIL, PRISM, HALFTONE, KALEIDO, DATAMOSH, THERMAL, the next
 * with each new frame; a pinch while framed restyles it, S1's frame.cycles). Turned over, each has its flip side (S2's
 * sounds pair the same way). Its name pill sits on the edge, the "4 beats · pinch to change" hint under it.
 *   The entrance (the design's §8): a lit edge draws itself round the frame (FRAME_TIMING.edgeMs), closes with one soft
 *   flash; the style blooms in from bloomDelayMs (bloomMs). Letting go: it shatters, the shards falling out of frame
 *   (shatterMs: chat's glass fracture).
 *   REMIX: the pane follows the hands while they hold the frame (the song's grid is the beat).
 *   PLAY: FREEZE's frame: it locks where the hands framed it and stays while frozen (the tempo from the plucks).
 * Reduced motion: the plain pane over a still of the lock moment, a short fade in and out, no flash, shards or wipes.
 *
 * This is the logic (pure, tested): when it's on (REMIX: S1's FRAME_HOLD_MS to make the frame, EXIT_HOLD_MS to lose
 * it, so it never flickers), its timeline, its style, the loop's window on the beat, and where the pane sits.
 * glassPass.ts draws it and keeps the camera's last seconds. Points are 0-1 of the picture (y down).
 */
import type { Pt } from '@/components/camera/camMath'
import { liveFrameTokens } from './stringTokens'

/** The world through the pane; 'plain' (no world) with reduced motion only. */
export type GlassType =
  | 'echo' | 'prism' | 'halftone' | 'kaleido' | 'datamosh' | 'thermal'
  | 'slitscan' | 'xray' | 'scanlines' | 'mirror' | 'liquid' | 'ice'
  | 'plain'
/** The front styles, in the order new frames and pinches step through them (the design's). */
export const GLASS_TYPES: readonly GlassType[] = ['echo', 'prism', 'halftone', 'kaleido', 'datamosh', 'thermal']
/** Each front style's flip side (the frame turned over): a clearly contrasting partner. S2's sounds pair the same way. */
export const FLIP_SIDE: Record<string, GlassType> = { echo: 'slitscan', prism: 'xray', halftone: 'scanlines', kaleido: 'mirror', datamosh: 'liquid', thermal: 'ice' }
export const GLASS_LABEL: Record<GlassType, string> = {
  echo: 'ECHO TRAIL', prism: 'PRISM', halftone: 'HALFTONE', kaleido: 'KALEIDO', datamosh: 'DATAMOSH', thermal: 'THERMAL',
  slitscan: 'SLIT-SCAN', xray: 'X-RAY', scanlines: 'SCANLINES', mirror: 'MIRROR', liquid: 'LIQUID', ice: 'ICE', plain: '',
}
/** The sound each style plays (S2's), on its name pill. */
export const GLASS_EFFECT: Record<GlassType, string> = {
  echo: 'Echo', prism: 'Shimmer', halftone: 'Bitcrush', kaleido: 'Chorus', datamosh: 'Glitch', thermal: 'Warm drive',
  slitscan: 'Smear', xray: 'Cold crush', scanlines: 'Line gate', mirror: 'Tape wow', liquid: 'Flanger', ice: 'Air', plain: '',
}
/** The card-flip as the frame turns over (or back). */
export const FLIP_MS = 140

/** The frame lost this long before the glass goes (the tracker's dropouts; S1's hold covers the making). */
export const EXIT_HOLD_MS = 150
/** Reduced motion's fade in, and its cut out (a fade this short). */
export const CALM_MS = 150
export const CALM_OUT_MS = 60
/** REMIX: a shatter this close before a beat lands on it (never later than this). */
export const BEAT_SNAP_MS = 60
/** The soft flash as the edge closes; never more than 3 a second. */
export const FLASH_MS = 250
const FLASH_GAP_MS = 334

/** The FRAME's timeline (ms), from the `--frame-*` tokens. */
export interface FrameTiming {
  edgeMs: number
  bloomMs: number
  /** The bloom starts this far into the edge's draw. */
  bloomDelayMs: number
  shatterMs: number
}
export const FRAME_TIMING: FrameTiming = { edgeMs: 450, bloomMs: 700, bloomDelayMs: 350, shatterMs: 140 }
const frameTokens = liveFrameTokens()
/** The timeline as the page's tokens have it now (S2: the frame sounds land on it). */
export function frameTiming(now = typeof performance !== 'undefined' ? performance.now() : 0): FrameTiming {
  const t = frameTokens(now)
  return { edgeMs: t.edgeMs, bloomMs: t.bloomMs, bloomDelayMs: t.bloomDelayMs, shatterMs: t.fracture.ms }
}

/** The frame's four corners, 0-1 of the picture (y down), clockwise from the top-left (S1's cameraSignals().frame). */
export type FrameCorners = [Pt, Pt, Pt, Pt]

/** The pane in the picture: its centre (0-1, y down), half its width and height along its own axes (in picture
 *  heights) and its tilt (radians, clockwise on screen; within ±π/4). */
export interface GlassQuad {
  x: number
  y: number
  hw: number
  hh: number
  tilt: number
}

/** For S2's glass sound (glassSignal, read once a stage frame). `on` is already debounced (S1's hold to make the frame,
 *  EXIT_HOLD_MS to lose it). */
export interface GlassSignal {
  on: boolean
  type: GlassType
  /** 0 (a tiny frame) … 1 (as big as it gets): its diagonal over the picture's width, 0.08 … 0.7. */
  size: number
  /** -1 … 1: its rotation, ±45° full (clockwise positive). */
  tilt: number
  /** Its centre, 0-1 of the picture. */
  x: number
  y: number
  /** performance.now() when the last pane formed (its edge starts drawing), 0 if never. */
  onAt: number
  /** performance.now() when the last CRACK began (letting go), 0 if never. */
  crackAt: number
  /** The frame turned over: `type` is the flip side's, and the loop runs backwards. */
  flipped: boolean
}

/** The camera's past the frame loops: `length` ms ending on the beat at `end` (performance.now ms), so the loop at
 *  time t shows the moment loopTime(loop, t). */
export interface LoopWindow {
  start: number
  end: number
  length: number
  /** The beats in it (4, or fewer while the ring holds less). */
  beats: number
}

/** A pane as glassPass draws it. */
export interface PaneFrame {
  type: GlassType
  /** The style it's restyling from, and how far the new one has wiped over it, 0-1 (1: done). */
  prev: GlassType
  restyle: number
  /** The last beats it loops, or null (the live camera: no history yet). */
  loop: LoopWindow | null
  /** Turned over (the flip side, the loop backwards); the card-flip so far (0-1, 1: done) and the style it flips from. */
  flipped: boolean
  flip: number
  flipFrom: GlassType
  corners: FrameCorners | null
  /** The pane's own opacity: 1 while it shows, easing out at the very end. */
  mix: number
  /** How much of the lit edge has drawn itself round the frame, 0-1 (clockwise from the top-left). */
  edge: number
  /** The world (the frost) bloomed in, 0-1. */
  bloom: number
  /** The soft flash as the edge closes, 0-1. */
  flash: number
  /** GLASS: how far the shards have fallen, 0-1, once let go; -1 while it's held, or with no crack. */
  crack: number
  /** Seconds since the pane formed (DATAMOSH's melt, ICE's shimmer, the pills' pop). */
  age: number
  /** Where the loop is (its sweep, beat pulse and the hint's dots), or null with no loop. */
  clock: LoopClock | null
}

export interface GlassFrame extends PaneFrame {
  quad: GlassQuad | null
  /** The glass kind changed this frame (the page's chip). */
  changed: boolean
}

const OFF: GlassSignal = { on: false, type: GLASS_TYPES[0]!, size: 0, tilt: 0, x: 0.5, y: 0.5, onAt: 0, crackAt: 0, flipped: false }
let latest: GlassSignal = OFF
/** The glass as it is now (S2: the glass sound); off while STRINGS isn't drawing. */
export const glassSignal = (): GlassSignal => latest
export const clearGlassSignal = (): void => void (latest = OFF)

const MIN_HALF = 0.03 // a pane never thinner than this (picture heights)

/**
 * The pane from the two L hands (MediaPipe's 21 each, 0-1 of the picture): its tilt is where the four fingers of the
 * frame (both thumbs, both index fingers) point, folded to the nearest axis; its edges are the four fingertips' extent
 * along that tilt. `aspect`: the picture's width over height. (The fallback until S1's own frame quad is there.)
 */
export function fitGlass(left: readonly Pt[], right: readonly Pt[], aspect: number): GlassQuad {
  const sq = (p: Pt) => ({ x: p.x * aspect, y: p.y })
  const fingers: [number, number][] = [[2, 4], [5, 8]]
  let s = 0
  let c = 0
  for (const h of [left, right]) {
    for (const [a, b] of fingers) {
      const p = sq(h[a]!)
      const q = sq(h[b]!)
      const ang = Math.atan2(q.y - p.y, q.x - p.x)
      s += Math.sin(4 * ang)
      c += Math.cos(4 * ang)
    }
  }
  const tilt = Math.atan2(s, c) / 4
  const tips = [left[4]!, left[8]!, right[4]!, right[8]!].map(sq)
  const mid = tips.reduce((m, p) => ({ x: m.x + p.x / 4, y: m.y + p.y / 4 }), { x: 0, y: 0 })
  const cos = Math.cos(tilt)
  const sin = Math.sin(tilt)
  const local = tips.map((p) => ({ x: (p.x - mid.x) * cos + (p.y - mid.y) * sin, y: -(p.x - mid.x) * sin + (p.y - mid.y) * cos }))
  const x0 = Math.min(...local.map((p) => p.x))
  const x1 = Math.max(...local.map((p) => p.x))
  const y0 = Math.min(...local.map((p) => p.y))
  const y1 = Math.max(...local.map((p) => p.y))
  const lx = (x0 + x1) / 2
  const ly = (y0 + y1) / 2
  return {
    x: (mid.x + lx * cos - ly * sin) / aspect,
    y: mid.y + lx * sin + ly * cos,
    hw: Math.max(MIN_HALF, (x1 - x0) / 2),
    hh: Math.max(MIN_HALF, (y1 - y0) / 2),
    tilt,
  }
}

/** A GlassQuad's corners, clockwise from the top-left. */
export function rectCorners(q: GlassQuad, aspect: number): FrameCorners {
  const c = Math.cos(q.tilt)
  const s = Math.sin(q.tilt)
  const at = (lx: number, ly: number): Pt => ({ x: (q.x * aspect + lx * c - ly * s) / aspect, y: q.y + lx * s + ly * c })
  return [at(-q.hw, -q.hh), at(q.hw, -q.hh), at(q.hw, q.hh), at(-q.hw, q.hh)]
}

/** A frame's centre, half sizes (its edges' mean lengths) and tilt (its top edge's), for the sound. */
export function quadOf(c: FrameCorners, aspect: number): GlassQuad {
  const len = (a: Pt, b: Pt) => Math.hypot((b.x - a.x) * aspect, b.y - a.y)
  const [p0, p1, p2, p3] = c
  return {
    x: (p0.x + p1.x + p2.x + p3.x) / 4,
    y: (p0.y + p1.y + p2.y + p3.y) / 4,
    hw: Math.max(MIN_HALF, (len(p0, p1) + len(p3, p2)) / 4),
    hh: Math.max(MIN_HALF, (len(p0, p3) + len(p1, p2)) / 4),
    tilt: Math.atan2(p1.y - p0.y, (p1.x - p0.x) * aspect),
  }
}

/** ONE-HANDED (2.0.1): the frame one L makes. Its corner is the L's (`at`: S1's cameraSignals().frame.corner, the
 *  stage's 0-1) and the pane opens toward the picture's centre, the far corner mirrored through it: at least `min` of
 *  the picture each way, `margin` inside its edges. */
export const ONE_L = { min: 0.4, margin: 0.04 }
export function oneLCorners(at: Pt): FrameCorners {
  const span = (v: number) => {
    const a = Math.min(1 - ONE_L.margin, Math.max(ONE_L.margin, v))
    const b = Math.abs(1 - 2 * a) >= ONE_L.min ? 1 - a : a + (a <= 0.5 ? ONE_L.min : -ONE_L.min)
    return [Math.min(a, b), Math.max(a, b)] as const
  }
  const [x0, x1] = span(at.x)
  const [y0, y1] = span(at.y)
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
}

/** FREEZE with no frame to lock onto (a hand unseen): a pane in the middle of the picture. */
export const CENTRE_CORNERS: FrameCorners = [{ x: 0.22, y: 0.2 }, { x: 0.78, y: 0.2 }, { x: 0.78, y: 0.8 }, { x: 0.22, y: 0.8 }]

/** The fallback keys (STRINGS_UX: F frame · P next style; S4 wires them). F: a pane at CENTRE_CORNERS while on (SAUCE:
 *  with inst.frame's latch; REMIX: held till F again). P: the next style, as a pinch (S1's cycles) would; the sound
 *  follows through glassSignal(). */
export const keyFrame = { on: false, cycles: 0 }
export const setKeyFrame = (on: boolean): void => void (keyFrame.on = on)
export const nextGlassStyle = (): void => void keyFrame.cycles++

const ease = (t: number) => t * t * (3 - 2 * t)
const easeOut = (t: number) => 1 - (1 - t) ** 3 // the design's cubic-bezier(.2, .8, .2, 1), near enough
const clamp01 = (t: number) => Math.min(1, Math.max(0, t))
const SMOOTH = 0.6 // the pane following the hands, each frame (S1's quad is smoothed already; the fallback isn't)

function follow(was: FrameCorners | null, to: FrameCorners): FrameCorners {
  if (!was) return to.map((p) => ({ ...p })) as FrameCorners
  return was.map((p, i) => ({ x: p.x + (to[i]!.x - p.x) * SMOOTH, y: p.y + (to[i]!.y - p.y) * SMOOTH })) as FrameCorners
}

/** The one soft flash as the edge closes, at most one every FLASH_GAP_MS. */
function flasher() {
  let last = -Infinity
  return {
    at(t: number): number {
      if (t - last < FLASH_GAP_MS) return -Infinity
      last = t
      return t
    },
  }
}
const flashAt = (now: number, at: number) => {
  const x = (now - at) / FLASH_MS
  return x < 0 || x >= 1 ? 0 : (1 - x) * (1 - x)
}

/** The beat now: tempo and how far through the current beat (0-1). REMIX: the song's (AudioFrame); PLAY: S2's tempo
 *  from the plucks. */
export interface Beat {
  bpm: number
  phase: number
}

/** The ring's reach (glassPass keeps the camera's last ~4.3 s): 4 beats down to 60 BPM. */
export const LOOP_MAX_MS = 4200
export const RESTYLE_MS = 180
export const LOOP_BEATS = 4

/** At a lock at `now`: the last LOOP_BEATS whole beats before the latest beat boundary at or before now - `settleMs`
 *  (PLAY: 250, as S2's audio, so the folds that made the frame stay out of it), halved while they're longer than the
 *  ring reaches, and no further back than the ring's `oldest` frame. No beat: 120 BPM from the lock. */
export function loopWindow(now: number, beat: Beat | null, oldest = -Infinity, maxMs = LOOP_MAX_MS, settleMs = 0): LoopWindow {
  const bpm = beat && beat.bpm > 0 && Number.isFinite(beat.bpm) ? beat.bpm : 120
  const beatMs = 60000 / bpm
  const phase = ((((beat ? Math.min(1, Math.max(0, beat.phase)) : 0) - settleMs / beatMs) % 1) + 1) % 1
  const end = now - settleMs - phase * beatMs
  let beats = LOOP_BEATS
  while (beats > 1 && beats * beatMs > maxMs) beats /= 2
  while (beats > 1 && end - beats * beatMs < oldest) beats /= 2 // only so much history yet
  const length = Math.max(1, Math.min(beats * beatMs, end - oldest)) // under a beat of history: what there is
  return { start: end - length, end, length, beats: length < beats * beatMs ? Math.max(1, Math.round(length / beatMs)) : beats }
}

/** The moment the loop shows at `now`: from the loop's start, as far in as `now` is past its (beat-aligned) end; or,
 *  `reversed` (the flip side), as far back from its end. */
export function loopTime(loop: LoopWindow, now: number, reversed = false): number {
  const x = (now - loop.end) % loop.length
  const into = x < 0 ? x + loop.length : x
  return reversed ? loop.start + loop.length - into : loop.start + into
}

/** Where a loop is at a moment: `progress` 0-1 through what it shows (backwards on the flip side, as the sweep runs),
 *  and which of its `beats` that is (the hint's dots). */
export interface LoopClock {
  progress: number
  beat: number
  beats: number
}

export function loopClock(loop: LoopWindow, now: number, reversed = false): LoopClock {
  const progress = Math.min(1, Math.max(0, (loopTime(loop, now, reversed) - loop.start) / loop.length))
  return { progress, beat: Math.min(loop.beats - 1, Math.floor(progress * loop.beats)), beats: loop.beats }
}

export interface FrameInput {
  beat?: Beat | null
  /** S1's frame.cycle count: a change while the pane shows restyles it. */
  cycles?: number
  /** The ring's oldest frame (performance.now ms). */
  oldest?: number
  /** S1's frame turned over (upside down) now: the flip side while it is. */
  turned?: boolean
}

/**
 * The FRAME over time: `update` each drawn frame with whether it's on (REMIX: S1's FRAME held; PLAY: frozen), the
 * frame's corners, and the beat and S1's pinch count. `follow`: the pane follows the hands (REMIX) or locks where it
 * formed (PLAY, which also needs no hold: `exitHoldMs` 0).
 */
export function createGlass(opts: { reduced?: boolean; aspect?: number; timing?: () => FrameTiming; follow?: boolean; exitHoldMs?: number; settleMs?: number } = {}) {
  const reduced = opts.reduced === true
  const aspect = opts.aspect ?? 16 / 9
  const timing = opts.timing ?? (() => FRAME_TIMING)
  const follows = opts.follow ?? true
  const exitHold = opts.exitHoldMs ?? EXIT_HOLD_MS
  const flashes = flasher()
  let on = false
  let heldAt = -Infinity
  let index = -1 // GLASS_TYPES' index; the first frame is ECHO TRAIL
  let prev = 0
  let restyleAt = -Infinity
  let cyclesSeen: number | undefined
  let onAt = 0
  let offAt = -Infinity
  let flashFrom = -Infinity
  let crackAt = -Infinity
  let cracked = 0 // the signal's crackAt
  let corners: FrameCorners | null = null
  let loop: LoopWindow | null = null
  let flipped = false
  let flipAt = -Infinity
  let flipFrom: GlassType = GLASS_TYPES[0]!
  const styleOf = (i: number, over: boolean): GlassType => (over ? FLIP_SIDE[GLASS_TYPES[i]!]! : GLASS_TYPES[i]!)
  return {
    update(now: number, held: boolean, frame: FrameCorners | null, input: FrameInput = {}): GlassFrame {
      const t = timing()
      const holding = held && (frame !== null || !follows)
      if (holding) heldAt = now
      const want = holding || now - heldAt < exitHold
      let changed = false
      if (want && !on) {
        on = true
        index = (index + 1) % GLASS_TYPES.length
        prev = index
        restyleAt = -Infinity
        flipped = false
        flipAt = -Infinity
        onAt = now
        offAt = crackAt = -Infinity
        flashFrom = reduced ? -Infinity : flashes.at(now + t.edgeMs)
        changed = true
        corners = null
        const w = loopWindow(now, input.beat ?? null, input.oldest ?? -Infinity, LOOP_MAX_MS, opts.settleMs ?? 0)
        loop = reduced ? { start: w.end - 1, end: w.end, length: 1, beats: 1 } : w // reduced: a still of the lock moment
      } else if (!want && on) {
        on = false
        offAt = now
        // a hard snap: on the beat if one is due within BEAT_SNAP_MS (REMIX), else now
        const toBeat = follows && input.beat && input.beat.bpm > 0 ? (1 - Math.min(1, Math.max(0, input.beat.phase))) * (60000 / input.beat.bpm) : Infinity
        if (!reduced) crackAt = cracked = now + (toBeat <= BEAT_SNAP_MS ? toBeat : 0)
      }
      if (on && input.cycles !== undefined && cyclesSeen !== undefined && input.cycles !== cyclesSeen && now - onAt > 0) {
        prev = index
        index = (index + 1) % GLASS_TYPES.length // on whichever side is showing
        restyleAt = now
        changed = true
      }
      if (on && input.turned !== undefined && input.turned !== flipped && now - onAt > 0) { // turned over, or back
        flipFrom = styleOf(index, flipped)
        flipped = input.turned
        flipAt = now
        restyleAt = -Infinity
        changed = true
      }
      cyclesSeen = input.cycles
      if (on && follows && frame) corners = follow(corners, frame)
      else if (on && !corners) corners = (frame ?? CENTRE_CORNERS).map((p) => ({ ...p })) as FrameCorners // PLAY: where it locked
      const since = now - onAt
      let mix = 1
      let edge = reduced ? 1 : ease(clamp01(since / Math.max(1, t.edgeMs))) // the design: in and out
      let bloom = reduced ? 1 : easeOut(clamp01((since - t.bloomDelayMs) / Math.max(1, t.bloomMs)))
      let crack = -1
      if (reduced) mix = on ? clamp01(since / CALM_MS) : 1 - clamp01((now - offAt) / CALM_OUT_MS)
      else if (!on && crackAt > -Infinity && now >= crackAt) {
        crack = clamp01((now - crackAt) / t.shatterMs) // the snap, then the shards flung out
        mix = crack >= 1 ? 0 : 1 // and gone: no fade, the live picture back at once
        edge = 0
      }
      if (!on && (mix <= 0 || !corners)) {
        corners = null
        loop = null
        mix = edge = bloom = 0
        crack = -1
      }
      const type: GlassType = reduced ? 'plain' : styleOf(Math.max(0, index), flipped)
      const restyle = reduced ? 1 : ease(clamp01((now - restyleAt) / RESTYLE_MS))
      const quad = corners ? quadOf(corners, aspect) : null
      const size = quad ? clamp01((Math.hypot(2 * quad.hw, 2 * quad.hh) / aspect - 0.08) / 0.62) : 0
      latest = quad && on
        ? { on: true, type, size, tilt: Math.max(-1, Math.min(1, quad.tilt / (Math.PI / 4))), x: quad.x, y: quad.y, onAt, crackAt: cracked, flipped }
        : { ...OFF, type, onAt, crackAt: cracked, flipped }
      return {
        type, prev: reduced ? 'plain' : styleOf(prev, flipped), restyle, loop, corners, mix, edge, bloom,
        flipped, flip: reduced ? 1 : clamp01((now - flipAt) / FLIP_MS), flipFrom: reduced ? 'plain' : flipFrom,
        flash: flashAt(now, flashFrom), crack, age: since / 1000, quad, changed,
        clock: loop && !reduced ? loopClock(loop, now, flipped) : null,
      }
    },
  }
}
