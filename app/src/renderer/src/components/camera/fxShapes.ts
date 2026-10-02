/**
 * STRINGS' BEAT FX hands (1.5.5, the user's "DJM FX in the air"): each hand's shape, held, its height and across, and the
 * spread between the hands, for S2's beat FX (beatFx) and S3's visuals. A shape is the Gesture Recognizer's sign where
 * it's sure (it already runs on every hand: Closed_Fist, Open_Palm, Pointing_Up, Thumb_Down, Victory, ILoveYou) and
 * rules on the 21 landmarks for what it doesn't know (a pinch, the horns, pointing down) or misses.
 *
 * Held with hysteresis: a shape counts once it's been seen HOLD_MS (a passing one never fires an FX), and lets go HOLD_MS
 * after it's gone (a dropped frame never cuts one). FRAME stays HandShapes.frame (S3's glass).
 *
 * And the strings the two hands hold (SPEC v1.1): TENSION (how far apart, in palm widths: near or far the same), TILT (the line between
 * them, ±45° full) and SHAKE (a 3-7 Hz tremble: each palm's raw track high-passed over half a second, above the
 * tracker's own jitter, and only once it crosses its own line faster than a pump to the beat does: a reach, a sway or a
 * fist pumped at 180 BPM isn't shake).
 *
 * FINGER FILTERS: each finger's curl (its joints' bends added up, in 3D), and STRINGS MODE (both hands open, no FX
 * shape held but the open palm) when a folding finger cuts its string's band rather than making a shape.
 */
import { follow, palm, WRIST, type HandShape, type HandShapes, type Pt } from './camMath'

export type FxShape = 'fist' | 'peace' | 'pinch' | 'open_palm' | 'horns' | 'point_up' | 'point_down'

export interface FxHand {
  /** Held (in after HOLD_MS of the same shape, out HOLD_MS after it's gone); null: the hand's seen, no FX shape. */
  shape: FxShape | null
  /** 0 the picture's bottom … 1 its top (the palm's centre), smoothed. */
  height: number
  /** 0 the picture's left … 1 its right, as shown (unmirrored), smoothed. */
  x: number
  /** performance.now() when this shape became held (0 when none). */
  since: number
}

export interface FxSignals {
  /** null: no hands. left / right: HandShapes' stable slots (the picture's left and right). */
  hands: { left: FxHand | null; right: FxHand | null } | null
  /** 0 palms together … 1 wide apart (SPREAD_FULL of the picture's width), smoothed; 0 with fewer than two hands. */
  spread: number
  /** The strings' stretch: 0 palms together (slack) … 1 at TENSION_FULL palm widths apart (taut), smoothed; 0 with
   *  fewer than two hands. */
  tension: number
  /** The strings' angle (left palm to right), -1 … 1 at ±45°, clockwise on screen positive, smoothed; 0 with fewer than
   *  two hands. Raw: S2's sound has the dead zone and the glide. */
  tilt: number
  /** A 3-7 Hz tremble of either hand, 0 still … 1 shaking, above the tracker's jitter (from the raw points). */
  shake: number
  /** Each hand's fingers [thumb, index, middle, ring, pinky], 0 straight (a relaxed finger too) … 1 folded, smoothed a
   *  frame; null: no hands. */
  fingers: { left: number[] | null; right: number[] | null } | null
  /** Both hands up with STRINGS_UP fingers or more each and no FX shape held but OPEN_PALM: a fold cuts a band. */
  stringsMode: boolean
}

export const HOLD_MS = 150
const LOST_MS = 300 // a hand unseen this long is gone (shorter: a dropped frame, it keeps its shape)
const SPREAD_FULL = 0.7
const TAU_MS = 60 // the height, across, spread, tension and tilt's smoothing (about one hand result)
// Palm widths (wrist to the middle knuckle) apart: taut (arms well out, ~1.6 shoulder widths). Not the pose's
// shoulders: it sees some on a frame of hands alone, and it runs one frame in four.
const TENSION_FULL = 7
const SHAKE_WINDOW_MS = 1000 // the track kept, for its frequency (crossingHz)
const TREMBLE_MS = 500 // the high-pass's window (tremble)
const SHAKE_HZ = 3 // the frequency gate: shut at a pump to the beat (180 BPM) and under, open from SHAKE_HZ + 0.8
// The tracker's jitter on still hands, in frame heights RMS: MediaPipe's still test images on the fake camera read
// 0.003 at most (p99 0.0027, ~15 results a second); twice that and more for a real camera's noise in a dim booth.
const SHAKE_FLOOR = 0.008
const SHAKE_FULL = 0.3 // palm widths RMS above the floor: full shake (a 5 Hz shake 0.3 palm widths wide reads ~0.8)
// FINGER FILTERS' curls (calibrated on MediaPipe's gesture images: the world landmarks of open, folded and tucked).
const BEND_RELAXED = 75 // degrees, a finger's joints' bends added up: an open hand's read 25-68 (0 at this or less)
const BEND_FOLDED = 165 // a fold's (1): a finger held down by the thumb 160-170, a fist's 230-270
const THUMB_OUT = 1.3 // the thumb's tip from the pinky's knuckle, in knuckle lines (5 to 17): out 1.8-2.1 (0) …
const THUMB_IN = 0.9 // … tucked 0.67-0.9 (1)
const CURL_MS = 30 // the curls' smoothing: about a frame
const STRINGS_UP = 3 // fingers up (curl under a half) on each hand for STRINGS MODE
const CHAINS = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]] as const
const TIPS = [4, 8, 12, 16, 20] as const
const KNUCKLES = [2, 5, 9, 13, 17] as const

/** Which fingers are out, thumb first (square-pixel points): a finger's tip well past its knuckle from the wrist; the
 *  thumb's tip well off the index knuckle (fingersUp's rules, per finger). 2D: one pointed at the camera reads folded. */
export function fingersOut(q: readonly Pt[]): boolean[] {
  const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
  return TIPS.map((t, i) =>
    i === 0 ? d(q[4]!, q[5]!) > 0.6 * palm(q) : d(q[t]!, q[WRIST]!) > 1.45 * d(q[KNUCKLES[i]!]!, q[WRIST]!),
  )
}

/** This result's shape, before the hold: the recognizer where it's sure, else the rules. `aspect`: the frame's width
 *  over its height (the points are 0-1 of it). */
export function rawShape(h: HandShape, aspect: number): FxShape | null {
  const q = h.points.map((p) => ({ x: p.x * aspect, y: p.y }))
  const [thumb, index, middle, ring, pinky] = fingersOut(q)
  const p = palm(q) || 1e-6
  const g = h.gesture
  if (g === 'fist') return 'fist' // the recognizer's surest sign (a fist's thumb sits on the index: it'd read as a pinch)
  // A pinch: thumb on index tip, the index not curled into the palm (that's a fist).
  const indexReach = Math.hypot(q[8]!.x - q[0]!.x, q[8]!.y - q[0]!.y) / (Math.hypot(q[5]!.x - q[0]!.x, q[5]!.y - q[0]!.y) || 1e-6)
  if (h.pinched && indexReach > 1.15) return 'pinch'
  if (g === 'love') return 'horns'
  if (g === 'victory') return 'peace'
  if (g === 'thumbs-down') return 'point_down'
  if (g === 'open') return 'open_palm'
  if (g === 'thumbs-up') return null // no FX: a fist with the thumb up isn't a FIST
  // The rules: what the recognizer doesn't know or missed.
  const down = (tip: number, base: number) => q[tip]!.y > q[base]!.y + 0.3 * p // y down: the tip well under its base
  if (index && pinky && !middle && !ring) return 'horns' // 🤘 (the thumb in) and ILoveYou (out)
  if (index && middle && !ring && !pinky) return 'peace'
  if (index && !middle && !ring && !pinky) return down(8, 5) ? 'point_down' : q[8]!.y < q[5]!.y - 0.3 * p ? 'point_up' : null
  if (g === 'point') return 'point_up'
  if (thumb && !index && !middle && !ring && !pinky && down(4, 2)) return 'point_down' // a thumb down
  if (thumb && !index && !middle && !ring && !pinky && q[4]!.y < q[2]!.y - 0.3 * p) return null // a thumb up
  if (!index && !middle && !ring && !pinky) return 'fist'
  if (index && middle && ring && pinky) return 'open_palm'
  return null
}

/** Each finger's curl, thumb first, 0 straight (or relaxed) … 1 folded: a finger's joints' bends added up (the
 *  knuckle's against the line from the wrist); the thumb's tip tucked toward the pinky's knuckle. The world landmarks
 *  (3D) where the tracker gives them, so a hand facing any way reads the same; else the picture's points. */
export function fingerCurls(h: HandShape, aspect: number): number[] {
  const q = h.world ?? h.points.map((p) => ({ x: p.x * aspect, y: p.y, z: 0 }))
  const v = (a: number, b: number) => [q[b]!.x - q[a]!.x, q[b]!.y - q[a]!.y, q[b]!.z - q[a]!.z]
  const angle = (u: number[], w: number[]) =>
    Math.acos(Math.max(-1, Math.min(1, (u[0]! * w[0]! + u[1]! * w[1]! + u[2]! * w[2]!) / (Math.hypot(...u) * Math.hypot(...w) || 1))))
  const unit = (x: number) => Math.max(0, Math.min(1, x))
  const reach = Math.hypot(...v(4, 17)) / (Math.hypot(...v(5, 17)) || 1e-6)
  return [
    unit((THUMB_OUT - reach) / (THUMB_OUT - THUMB_IN)),
    ...CHAINS.map(([a, b, c, d]) => {
      const bend = ((angle(v(WRIST, a), v(a, b)) + angle(v(a, b), v(b, c)) + angle(v(b, c), v(c, d))) * 180) / Math.PI
      return unit((bend - BEND_RELAXED) / (BEND_FOLDED - BEND_RELAXED))
    }),
  ]
}

interface Slot {
  /** The fingers' curls, smoothed. */
  curl: number[]
  /** The palm's raw track (frame heights), SHAKE_WINDOW_MS of it. */
  track: { t: number; x: number; y: number }[]
  held: FxShape | null
  since: number
  cand: FxShape | null
  candSince: number
  seen: number
  height: number
  x: number
}

const centre = (h: HandShape): Pt =>
  [0, 5, 9, 13, 17].reduce((a, i) => ({ x: a.x + h.points[i]!.x / 5, y: a.y + h.points[i]!.y / 5 }), { x: 0, y: 0 })

/** The hands' FX signals, stepped on each new hands result (HandShapes). */
export class FxShapes {
  private slots: Record<'left' | 'right', Slot | null> = { left: null, right: null }
  private spread = 0
  private tension = 0
  private tilt = 0
  private shake = 0
  private at = -1

  /** One new hands result: `aspect` the frame's width over its height. */
  step(shapes: HandShapes, now: number, aspect: number): FxSignals {
    const dt = this.at < 0 ? 0 : Math.max(0, now - this.at)
    this.at = now
    let wobble = 0
    for (const side of ['left', 'right'] as const) {
      const h = shapes[side]
      let s = this.slots[side]
      if (!h) {
        if (s && now - s.seen > LOST_MS) this.slots[side] = null
        else if (s) this.hold(s, null, now)
        continue
      }
      const c = centre(h)
      const curl = fingerCurls(h, aspect)
      // A new hand's curls start straight: its first result (straight off the palm detector) reads fingers half bent.
      const fresh = !s
      if (!s) s = this.slots[side] = { curl: [0, 0, 0, 0, 0], track: [], held: null, since: 0, cand: null, candSince: now, seen: now, height: 1 - c.y, x: c.x }
      s.seen = now
      s.height = follow(s.height, 1 - c.y, dt, TAU_MS, TAU_MS)
      s.x = follow(s.x, c.x, dt, TAU_MS, TAU_MS)
      if (!fresh) s.curl = s.curl.map((v, f) => follow(v, curl[f]!, dt, CURL_MS, CURL_MS))
      this.hold(s, rawShape(h, aspect), now)
      s.track.push({ t: now, x: c.x * aspect, y: c.y })
      while (s.track.length && now - s.track[0]!.t > SHAKE_WINDOW_MS) s.track.shift()
      const size = palm(h.points.map((p) => ({ x: p.x * aspect, y: p.y }))) || 1e-6
      const gate = Math.max(0, Math.min(1, (crossingHz(s.track) - SHAKE_HZ) / 0.8))
      const recent = s.track.filter((p) => now - p.t <= TREMBLE_MS)
      wobble = Math.max(wobble, (Math.max(0, tremble(recent) - SHAKE_FLOOR) * gate) / (SHAKE_FULL * size))
    }
    const { left, right } = shapes
    const both = left && right ? [centre(left), centre(right)] : null
    const gap = both ? Math.hypot((both[1]!.x - both[0]!.x) * aspect, both[1]!.y - both[0]!.y) : 0
    this.spread = follow(this.spread, Math.min(1, gap / (SPREAD_FULL * aspect)), dt, TAU_MS, TAU_MS)
    // The bigger palm: a hand turned edge-on reads small.
    const size = both ? Math.max(...[left!, right!].map((h) => palm(h.points.map((p) => ({ x: p.x * aspect, y: p.y }))))) : 1
    this.tension = follow(this.tension, both ? Math.min(1, gap / (TENSION_FULL * Math.max(size, 1e-6))) : 0, dt, TAU_MS, TAU_MS)
    const angle = both ? Math.atan2(both[1]!.y - both[0]!.y, (both[1]!.x - both[0]!.x) * aspect) : 0 // y down: clockwise +
    this.tilt = follow(this.tilt, both ? Math.max(-1, Math.min(1, angle / (Math.PI / 4))) : 0, dt, TAU_MS, TAU_MS)
    this.shake = follow(this.shake, Math.min(1, wobble), dt, 60, 250) // in fast, out slower (no flicker)
    return this.signals()
  }

  /** The hold: a new shape (or none) takes over once it's been there HOLD_MS. */
  private hold(s: Slot, raw: FxShape | null, now: number): void {
    if (raw === s.held) {
      s.cand = raw
      s.candSince = now
      return
    }
    if (raw !== s.cand) {
      s.cand = raw
      s.candSince = now
    }
    if (now - s.candSince >= HOLD_MS) {
      s.held = raw
      s.since = raw ? now : 0
    }
  }

  signals(): FxSignals {
    const out = (s: Slot | null): FxHand | null => (s ? { shape: s.held, height: s.height, x: s.x, since: s.since } : null)
    const { left, right } = this.slots
    const strings = (s: Slot | null) => !!s && s.curl.filter((c) => c < 0.5).length >= STRINGS_UP && (!s.held || s.held === 'open_palm')
    return {
      hands: left || right ? { left: out(left), right: out(right) } : null,
      spread: this.spread,
      tension: this.tension,
      tilt: this.tilt,
      shake: this.shake,
      fingers: left || right ? { left: left?.curl.slice() ?? null, right: right?.curl.slice() ?? null } : null,
      stringsMode: strings(left) && strings(right),
    }
  }
}

/** RMS of each point's distance from the chord of its neighbours: a high-pass that keeps a 3-7 Hz tremble at ~15
 *  results a second (5 Hz: ×1.5) and drops a steady move or a slow sway (1 Hz: ×0.09). Under two triples: 0. */
export function tremble(track: readonly { t: number; x: number; y: number }[]): number {
  let sum = 0
  for (let i = 1; i + 1 < track.length; i++) {
    const [a, b, c] = [track[i - 1]!, track[i]!, track[i + 1]!]
    const f = (b.t - a.t) / (c.t - a.t || 1)
    sum += (b.x - a.x - (c.x - a.x) * f) ** 2 + (b.y - a.y - (c.y - a.y) * f) ** 2
  }
  return track.length >= 4 ? Math.sqrt(sum / (track.length - 2)) : 0
}

/** A track's dominant frequency (Hz): the crossings of the line fitted through it, along its main axis, counted with a
 *  Schmitt trigger at half the jitter floor (jitter doesn't cross), over SHAKE_WINDOW_MS (a short track reads low). */
export function crossingHz(track: readonly { t: number; x: number; y: number }[]): number {
  const n = track.length
  if (n < 4) return 0
  const mt = track.reduce((a, p) => a + p.t, 0) / n
  const st = track.reduce((a, p) => a + (p.t - mt) ** 2, 0) || 1e-9
  const off = (['x', 'y'] as const).map((k) => {
    const m = track.reduce((a, p) => a + p[k], 0) / n
    const slope = track.reduce((a, p) => a + (p.t - mt) * (p[k] - m), 0) / st
    return track.map((p) => p[k] - (m + slope * (p.t - mt)))
  })
  const size = (v: number[]) => v.reduce((a, x) => a + Math.abs(x), 0)
  const axis = size(off[0]!) >= size(off[1]!) ? off[0]! : off[1]!
  let side = 0
  let crossings = 0
  for (const v of axis) {
    const now = v > SHAKE_FLOOR / 2 ? 1 : v < -SHAKE_FLOOR / 2 ? -1 : 0
    if (now && side && now !== side) crossings++
    if (now) side = now
  }
  return crossings / 2 / (SHAKE_WINDOW_MS / 1000)
}
