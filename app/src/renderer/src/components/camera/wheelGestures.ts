/**
 * REMIX's library wheel (2.0, docs/LIBRARY_WHEEL.md): its gestures.
 * - SHAKA 🤙 (thumb and pinky out, the other three folded), held SHAKA_MS: opens the wheel, and closes it again. Not
 *   one of REMIX's shapes (fxShapes: an ILoveYou needs its index up) nor a FRAME's L.
 * - DIAL: the right index finger's angle, as the performer sees it in a mirror (270° pointing up, 180° across the body,
 *   360° outward), like the reference's knob; smoothed; `edge` held near an end of its range (keep scrolling).
 * - GRAB: the left hand's closure (0 open … 1 a fist), and a full grab held LOAD_MS loads the card (`loads` counts).
 * While the wheel is open, cameraSignals' REMIX shapes and finger filters read null (smartCamera).
 *
 * Hands are the PERFORMER's own: the camera picture isn't mirrored, so their right hand is the picture's left slot.
 * Left-handed (playPrefs), the left index dials (the same angles, mirrored) and the right hand grabs.
 */
import { follow, type HandShapes } from './camMath'
import { fingerCurls } from './fxShapes'
import { usePlayPrefs } from './playPrefs'

export interface WheelSignals {
  /** The wheel is open: a held shaka toggles it, and so does setWheelOpen (Esc, the mouse, a load). */
  open: boolean
  /** The shaka held so far, 0 … 1 at the toggle (a fill ring); 0 without one. */
  shaka: number
  /** The right index finger's angle in degrees (90 … 450: 270 up, 180 across the body, 360 outward), smoothed; null
   *  while it isn't pointing (or the right hand isn't seen). */
  dial: number | null
  /** The dial held near an end of its range: -1 the low end, 1 the high end, 0 between (with hysteresis). */
  edge: -1 | 0 | 1
  /** The left hand's closure, 0 open … 1 a fist (its four fingers' curls), smoothed; 0 when it isn't seen. */
  grab: number
  /** A full grab held toward a load, 0 … 1 (a fill ring). */
  load: number
  /** Loads so far (one per full grab held LOAD_MS; it must open past REGRAB before another). */
  loads: number
}

/** The wheel's feel, in one place. */
export const WHEEL = {
  /** Curls: a finger counts out under OUT and folded over IN. */
  OUT: 0.35,
  IN: 0.6,
  SHAKA_MS: 500,
  /** A shaka gone this long ends its hold (a toggle needs a new one). */
  SHAKA_GONE_MS: 200,
  /** The index pointing: its curl under this. */
  POINTING: 0.4,
  /** The dial's edges (degrees): its comfortable sweep is about 140-280 with a finger held up resting near 255-280
   *  (the reference), so the edges sit past it: well across the body, or out past upright. Back out by EDGE_BACK. */
  EDGE_LOW: 150,
  EDGE_HIGH: 290,
  EDGE_BACK: 6,
  /** A full grab, and how open it must get before the next. */
  FULL: 0.85,
  REGRAB: 0.5,
  LOAD_MS: 800,
  /** The dial's and grab's smoothing. */
  SMOOTH_MS: 60,
}

let open = false
/** Esc, the mouse, or a load closing it (or a click opening it): the gestures follow. */
export const setWheelOpen = (o: boolean): void => void (open = o)

export const NO_WHEEL: WheelSignals = { open: false, shaka: 0, dial: null, edge: 0, grab: 0, load: 0, loads: 0 }

/** A shaka on these curls (thumb first): thumb and pinky out, index, middle and ring folded. */
export const isShaka = (c: readonly number[]): boolean =>
  c[0]! < WHEEL.OUT && c[4]! < WHEEL.OUT && c[1]! > WHEEL.IN && c[2]! > WHEEL.IN && c[3]! > WHEEL.IN

export class WheelGestures {
  private shakaSince = -1
  private shakaSeen = -1
  private toggled = false
  private dial: number | null = null
  private edge: -1 | 0 | 1 = 0
  private grab = 0
  private held = 0
  private loads = 0
  private armed = true
  private at = -1
  private last: WheelSignals = NO_WHEEL

  /** One new hands result (`aspect`: the frame's width over its height). */
  step(shapes: HandShapes, now: number, aspect: number): WheelSignals {
    const dt = this.at < 0 ? 0 : Math.max(0, now - this.at)
    this.at = now
    const lefty = usePlayPrefs.getState().leftHanded
    const right = lefty ? shapes.right : shapes.left // the dialling hand: the performer's right (left, left-handed)
    const left = lefty ? shapes.left : shapes.right // the grabbing hand
    const rc = right ? fingerCurls(right, aspect) : null
    const lc = left ? fingerCurls(left, aspect) : null

    // SHAKA, either hand: held SHAKA_MS toggles once; gone SHAKA_GONE_MS ends the hold.
    if ((rc && isShaka(rc)) || (lc && isShaka(lc))) {
      if (this.shakaSince < 0) this.shakaSince = now
      this.shakaSeen = now
      if (!this.toggled && now - this.shakaSince >= WHEEL.SHAKA_MS) {
        open = !open
        this.toggled = true
      }
    } else if (this.shakaSince >= 0 && now - this.shakaSeen > WHEEL.SHAKA_GONE_MS) {
      this.shakaSince = -1
      this.toggled = false
    }
    const shaka = this.shakaSince < 0 || this.toggled ? 0 : Math.min(1, (now - this.shakaSince) / WHEEL.SHAKA_MS)

    // DIAL: the right index (knuckle to tip), as in a mirror (x flipped; a left index's is already), y down: 270 up.
    if (right && rc && rc[1]! < WHEEL.POINTING) {
      const p = right.points
      const deg = (Math.atan2(p[8]!.y - p[5]!.y, (lefty ? 1 : -1) * (p[8]!.x - p[5]!.x) * aspect) * 180) / Math.PI
      const angle = deg < 90 ? deg + 360 : deg
      this.dial = this.dial == null ? angle : follow(this.dial, angle, dt, WHEEL.SMOOTH_MS, WHEEL.SMOOTH_MS)
      const d = this.dial
      if (this.edge === 0) this.edge = d <= WHEEL.EDGE_LOW ? -1 : d >= WHEEL.EDGE_HIGH ? 1 : 0
      else if ((this.edge === -1 && d > WHEEL.EDGE_LOW + WHEEL.EDGE_BACK) || (this.edge === 1 && d < WHEEL.EDGE_HIGH - WHEEL.EDGE_BACK)) this.edge = 0
    } else {
      this.dial = null
      this.edge = 0
    }

    // GRAB: the left hand's four fingers; a full grab held LOAD_MS loads once.
    const closure = lc ? (lc[1]! + lc[2]! + lc[3]! + lc[4]!) / 4 : 0
    this.grab = follow(this.grab, closure, dt, WHEEL.SMOOTH_MS, WHEEL.SMOOTH_MS)
    if (this.grab >= WHEEL.FULL) this.held += dt
    else this.held = 0
    if (this.grab < WHEEL.REGRAB) this.armed = true
    if (this.armed && this.held >= WHEEL.LOAD_MS) {
      this.loads++
      this.armed = false
    }
    const load = this.armed ? Math.min(1, this.held / WHEEL.LOAD_MS) : 0

    this.last = { open, shaka, dial: this.dial, edge: this.edge, grab: this.grab, load, loads: this.loads }
    return this.last
  }

  signals(): WheelSignals {
    return { ...this.last, open }
  }
}
